/**
 * The whatsapp-web.js driver is a PASS-THROUGH, and this file says what
 * it passes through to.
 *
 * Phase 2 of `MDs/baileys-migration-plan-2026-09-21.md` is a pure
 * refactor: the bot must do exactly what it did before, or the eventual
 * Baileys swap is not a decision, it is a gamble. The strongest evidence
 * of that is the 465 tests that already existed. They drive the real
 * enqueue → flush → react pipeline against booby-trapped fake clients,
 * and they now run THROUGH this driver with their assertions unchanged.
 *
 * What is left for this file is the handful of things only the driver
 * does: the JID suffix it adds, the two lookups it lets throw on purpose,
 * the event names it subscribes to, and the ordering inside
 * `fetchRecentGroupMessages`.
 *
 * No test here opens a socket or constructs a real `Client`. See
 * `src/baileys/main.source.test.ts` for why that rule is absolute.
 */
import { describe, it, expect, vi } from "vitest";
import { makeWwebjsDriver, type WwebjsClientLike } from "./wwebjs.js";

const GID = "447525334985-1607872139@g.us";
const PN = "447525334985@c.us";
const LID = "88813579246810@lid";

const wrap = (c: unknown) => makeWwebjsDriver(c as unknown as WwebjsClientLike);

function sendingClient() {
  const sendMessage = vi.fn(async () => ({ id: { _serialized: "sent-1" } }));
  return { client: { sendMessage }, sendMessage };
}

// ─── Addressing ──────────────────────────────────────────────────────
describe("the driver owns the JID suffix, so nothing above it does", () => {
  it("DMs a bare phone at @c.us", async () => {
    const { client, sendMessage } = sendingClient();
    await wrap(client).sendDirectText("447700900123", "hello");
    expect(sendMessage).toHaveBeenCalledWith("447700900123@c.us", "hello");
  });

  it("turns mention phones into @c.us ids", async () => {
    const { client, sendMessage } = sendingClient();
    await wrap(client).sendTextWithMentions(GID, "@447700900123 you're on", ["447700900123"]);
    expect(sendMessage).toHaveBeenCalledWith(GID, "@447700900123 you're on", {
      mentions: ["447700900123@c.us"],
    });
  });

  it("sends NO options object when there are no mentions", async () => {
    // `{ mentions: [] }` is not the same request as no options at all, and
    // the scheduler has always branched rather than pass an empty array.
    const { client, sendMessage } = sendingClient();
    await wrap(client).sendTextWithMentions(GID, "squad is up", []);
    expect(sendMessage).toHaveBeenCalledWith(GID, "squad is up");
    expect(sendMessage.mock.calls[0]).toHaveLength(2);
  });

  it("returns the library's send result verbatim, undefined included", async () => {
    // send-result.ts exists because a broken build resolves to undefined
    // and the scheduler acks anyway. The driver must not paper over it.
    const client = { sendMessage: vi.fn(async () => undefined) };
    await expect(wrap(client).sendText(GID, "hi")).resolves.toBeUndefined();
  });
});

// ─── The throws that are part of the contract ────────────────────────
describe("the lookups whose failure IS the degraded-capability signal", () => {
  it("listGroups lets the library's error out (group-enumeration)", async () => {
    const client = {
      getChats: vi.fn(async () => {
        throw new Error("r");
      }),
    };
    await expect(wrap(client).listGroups()).rejects.toThrow("r");
  });

  it("listGroups returns only groups, as id and name", async () => {
    const client = {
      getChats: vi.fn(async () => [
        { isGroup: true, id: { _serialized: GID }, name: "Sutton FC" },
        { isGroup: false, id: { _serialized: PN }, name: "Kemal" },
      ]),
    };
    await expect(wrap(client).listGroups()).resolves.toEqual([{ id: GID, name: "Sutton FC" }]);
  });

  it("groupParticipants lets the library's error out (participant-sync)", async () => {
    const client = {
      getChatById: vi.fn(async () => {
        throw new Error("r");
      }),
    };
    await expect(wrap(client).groupParticipants(GID)).rejects.toThrow("r");
  });

  it("groupParticipants reports an empty roster as empty, inventing nothing", async () => {
    // A chat that resolves with no participants is the QUIET version of
    // the same breakage; the caller records participant-sync for it.
    const client = { getChatById: vi.fn(async () => ({ id: { _serialized: GID } })) };
    await expect(wrap(client).groupParticipants(GID)).resolves.toEqual([]);
  });

  it("groupParticipants hands back the member JIDs", async () => {
    const client = {
      getChatById: vi.fn(async () => ({
        participants: [{ id: { _serialized: PN } }, { id: { _serialized: LID } }],
      })),
    };
    await expect(wrap(client).groupParticipants(GID)).resolves.toEqual([PN, LID]);
  });

  it("selfId does NOT swallow a throwing client.info", async () => {
    // Three call sites branch on this throw. A total version would change
    // all three without anyone noticing.
    const client = {
      get info(): never {
        throw new Error("r");
      },
    };
    expect(() => wrap(client).selfId()).toThrow("r");
  });

  it("selfId is the phone JID when the client is healthy", () => {
    expect(wrap({ info: { wid: { _serialized: PN } } }).selfId()).toBe(PN);
  });
});

// ─── Self ids (moved from bot-added.ts) ──────────────────────────────
describe("selfIds", () => {
  it("collects the phone JID from client.info and the LID from the page", async () => {
    const client = {
      info: { wid: { _serialized: PN } },
      pupPage: { evaluate: vi.fn(async () => ({ pn: PN, lid: LID })) },
    };
    expect(await wrap(client).selfIds()).toEqual([PN, LID]);
  });

  it("survives a throwing info getter and a throwing page (the broken build)", async () => {
    const client = {
      get info(): never {
        throw new Error("r");
      },
      pupPage: {
        evaluate: vi.fn(async () => {
          throw new Error("r");
        }),
      },
    };
    expect(await wrap(client).selfIds()).toEqual([]);
  });

  it("caches a non-empty answer", async () => {
    const evaluate = vi.fn(async () => ({ pn: null, lid: LID }));
    const driver = wrap({ info: { wid: { _serialized: PN } }, pupPage: { evaluate } });
    await driver.selfIds();
    await driver.selfIds();
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("the cache is per driver, so two drivers do not share an identity", async () => {
    const a = wrap({ info: { wid: { _serialized: PN } } });
    const b = wrap({ info: { wid: { _serialized: "447700900999@c.us" } } });
    expect(await a.selfIds()).toEqual([PN]);
    expect(await b.selfIds()).toEqual(["447700900999@c.us"]);
  });
});

// ─── Events ──────────────────────────────────────────────────────────
describe("the event names the bot subscribes to", () => {
  function recordingClient() {
    const handlers = new Map<string, (...a: unknown[]) => void>();
    return {
      client: { on: (e: string, h: (...a: unknown[]) => void) => void handlers.set(e, h) },
      handlers,
    };
  }

  it("maps every callback onto the whatsapp-web.js event that feeds it", () => {
    const { client, handlers } = recordingClient();
    const d = wrap(client);
    d.onOpen(() => undefined);
    d.onClose(() => undefined);
    d.onMessage(() => undefined);
    d.onReaction(() => undefined);
    d.onPollVote(() => undefined);
    d.onGroupJoin(() => undefined);
    d.onGroupLeave(() => undefined);
    expect([...handlers.keys()].sort()).toEqual(
      [
        "disconnected",
        "group_join",
        "group_leave",
        "message",
        "message_reaction",
        "ready",
        "vote_update",
      ].sort(),
    );
  });

  it("hands the reaction payload over RAW", () => {
    // Every field on it is read through safePath/safeRead by the handler,
    // because on the broken build `msgId` is a throwing getter and
    // noticing that is what records reaction-forwarding degraded.
    const { client, handlers } = recordingClient();
    const seen: unknown[] = [];
    wrap(client).onReaction((r) => void seen.push(r));
    const payload = { msgId: { _serialized: "x" }, senderId: PN, reaction: "👍" };
    handlers.get("message_reaction")!(payload);
    expect(seen[0]).toBe(payload);
  });

  it("passes the disconnect reason through", () => {
    const { client, handlers } = recordingClient();
    const seen: string[] = [];
    wrap(client).onClose((r) => void seen.push(r));
    handlers.get("disconnected")!("NAVIGATION");
    expect(seen).toEqual(["NAVIGATION"]);
  });
});

// ─── Lifecycle ───────────────────────────────────────────────────────
describe("lifecycle", () => {
  it("start initialises and close destroys", async () => {
    const initialize = vi.fn(async () => undefined);
    const destroy = vi.fn(async () => undefined);
    const logout = vi.fn(async () => undefined);
    const d = wrap({ initialize, destroy, logout });
    await d.start();
    await d.close();
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    // logout() unlinks the device. Confusing the two turns every deploy
    // into a re-pair.
    expect(logout).not.toHaveBeenCalled();
  });
});

// ─── The catch-up read ───────────────────────────────────────────────
describe("fetchRecentGroupMessages keeps the bare-Chat-handle trick", () => {
  it("falls back to getChatById.fetchMessages when the bare handle cannot be built", async () => {
    // There is no real `Chat` export to construct here (the module is
    // mocked away in the recovery tests), so this exercises the fallback
    // leg and its warning line.
    const fetchMessages = vi.fn(async () => [{ timestamp: 1, fromMe: false }]);
    const client = { getChatById: vi.fn(async () => ({ fetchMessages })) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const out = await wrap(client).fetchRecentGroupMessages(GID, 50);
      expect(out).toEqual([{ timestamp: 1, fromMe: false }]);
    } finally {
      warn.mockRestore();
    }
  });

  it("falls back again to the cached lastMessage when fetchMessages throws", async () => {
    const lastMessage = { timestamp: 7, fromMe: false };
    const client = {
      getChatById: vi.fn(async () => ({
        lastMessage,
        fetchMessages: async () => {
          throw new Error("waitForChatLoading");
        },
      })),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(wrap(client).fetchRecentGroupMessages(GID, 50)).resolves.toEqual([lastMessage]);
    } finally {
      warn.mockRestore();
    }
  });
});

// ─── The env-gated DM replay ─────────────────────────────────────────
describe("listDmChats", () => {
  it("returns the non-group chats with their last message left raw", async () => {
    const lastMessage = { body: "yes", fromMe: false };
    const client = {
      getChats: vi.fn(async () => [
        { isGroup: true, id: { _serialized: GID }, name: "Sutton FC" },
        { isGroup: false, id: { _serialized: PN }, name: "Kemal", lastMessage },
      ]),
    };
    const out = await wrap(client).listDmChats();
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(PN);
    expect(out[0].name).toBe("Kemal");
    expect(out[0].lastMessage).toBe(lastMessage);
  });
});

// ─── Message-scoped calls ────────────────────────────────────────────
describe("the calls that hang off one message", () => {
  it("replyTo goes through the message's own reply", async () => {
    const reply = vi.fn(async () => undefined);
    await wrap({}).replyTo({ reply } as never, "type a word or two");
    expect(reply).toHaveBeenCalledWith("type a word or two");
  });

  it("contactOf goes through the message's own getContact", async () => {
    const contact = { number: "447700900123" };
    const getContact = vi.fn(async () => contact);
    await expect(wrap({}).contactOf({ getContact } as never)).resolves.toBe(contact);
  });

  it("getContact goes through the client's lookup", async () => {
    const contact = { pushname: "Erdal" };
    const getContactById = vi.fn(async () => contact);
    await expect(wrap({ getContactById }).getContact(LID)).resolves.toBe(contact);
    expect(getContactById).toHaveBeenCalledWith(LID);
  });
});
