/**
 * The Baileys driver's outbound half, against a fake socket.
 *
 * No test here opens a socket (see `src/baileys/main.source.test.ts` for
 * the incident behind that rule). The fake's `sendMessage` builds its
 * return value with Baileys' OWN `generateWAMessage`, so the keys it hands
 * back have exactly the shape a real send returns, including the thing
 * that matters most: a group message we send comes back with NO
 * `participant` on its key.
 *
 * The ids are read back through the real `send-result.ts`, the function
 * the scheduler uses, so these tests prove the scheduler will ack with the
 * right `waMessageId` and not merely that the driver returned something.
 */
import { describe, it, expect, vi } from "vitest";
import { generateWAMessage, proto, type WAMessage } from "baileys";
import type { WaDriver } from "../driver.js";
import { waMessageIdFrom, isMissingSendResult } from "../send-result.js";
import { BaileysDriverUnsupportedError, makeBaileysDriver } from "./baileys.js";

const GROUP = "120363000000000000@g.us";
const ME_PN = "447700900001:12@s.whatsapp.net";
const ME_LID = "158055467598020:12@lid";

function fakeSocket(overrides: { user?: { id?: string; lid?: string } | null } = {}) {
  const sendMessage = vi.fn(async (jid: string, content: unknown, options?: unknown) => {
    // Baileys' generator MUTATES the content it is given (it adds
    // `toAnnouncementGroup` to a poll and `senderTimestampMs` to a
    // reaction). Generate from a copy so the recorded call shows what the
    // driver actually passed. The driver builds a fresh object per send,
    // so the mutation cannot leak between sends in production either.
    return generateWAMessage(jid, structuredClone(content) as never, {
      ...(options as object),
      userJid: ME_PN,
      upload: async () => {
        throw new Error("no test may upload media");
      },
      getUrlInfo: async () => {
        throw new Error("a link preview was requested: the Pi would have fetched our URL");
      },
    } as never);
  });
  return {
    user: "user" in overrides ? overrides.user : { id: ME_PN, lid: ME_LID },
    sendMessage,
    end: vi.fn(),
    logout: vi.fn(),
  };
}

function driverWith(sock: ReturnType<typeof fakeSocket> | null, extra: object = {}) {
  return makeBaileysDriver({ getSocket: () => sock as never, ...extra });
}

describe("identity", () => {
  it("is named baileys", () => {
    expect(driverWith(fakeSocket()).name).toBe("baileys");
  });
});

describe("sendText", () => {
  it("sends one text with link previews off, to the group as given", async () => {
    const sock = fakeSocket();
    await driverWith(sock).sendText(GROUP, "Teams are out https://matchtime.app/m/1");
    expect(sock.sendMessage).toHaveBeenCalledTimes(1);
    const [jid, content] = sock.sendMessage.mock.calls[0];
    expect(jid).toBe(GROUP);
    expect(content).toEqual({ text: "Teams are out https://matchtime.app/m/1", linkPreview: null });
  });

  it("resolves to something the scheduler reads the whatsapp-web.js-format id out of", async () => {
    const sock = fakeSocket();
    const result = await driverWith(sock).sendText(GROUP, "hi");
    const sent = (await sock.sendMessage.mock.results[0].value) as WAMessage;
    // Baileys' own sent key: no participant, even in a group.
    expect(sent.key.participant).toBeFalsy();
    // ...but the id we store carries OUR JID as participant, exactly as
    // whatsapp-web.js wrote it, so a reaction to this post will join.
    expect(waMessageIdFrom(result)).toBe(
      `true_${GROUP}_${sent.key.id}_447700900001@c.us`,
    );
  });

  it("uses our LID as the participant when the group is LID-addressed", async () => {
    const sock = fakeSocket();
    const driver = driverWith(sock, { groupAddressingMode: () => "lid" });
    const result = await driver.sendText(GROUP, "hi");
    const sent = (await sock.sendMessage.mock.results[0].value) as WAMessage;
    expect(waMessageIdFrom(result)).toBe(`true_${GROUP}_${sent.key.id}_158055467598020@lid`);
  });

  it("falls back to the phone form when the LID is asked for but unknown", async () => {
    const sock = fakeSocket({ user: { id: ME_PN } });
    const driver = driverWith(sock, { groupAddressingMode: () => "lid" });
    const result = await driver.sendText(GROUP, "hi");
    expect(waMessageIdFrom(result)).toMatch(/_447700900001@c\.us$/);
  });

  it("translates a whatsapp-web.js person JID to the Baileys form before sending", async () => {
    const sock = fakeSocket();
    await driverWith(sock).sendText("447700900123@c.us", "hi");
    expect(sock.sendMessage.mock.calls[0][0]).toBe("447700900123@s.whatsapp.net");
  });

  it("resolves undefined when Baileys does, so the CRITICAL missing-result line still fires", async () => {
    const sock = fakeSocket();
    sock.sendMessage.mockResolvedValueOnce(undefined as never);
    const result = await driverWith(sock).sendText(GROUP, "hi");
    expect(isMissingSendResult(result)).toBe(true);
  });

  it("throws when there is no socket, rather than pretending it sent", async () => {
    // A resolved promise here would ack an instruction that never went
    // out. The scheduler already treats a throw as a failed send.
    await expect(driverWith(null).sendText(GROUP, "hi")).rejects.toThrow(/not connected/);
  });

  it("lets a failed send throw, as the whatsapp-web.js driver does", async () => {
    const sock = fakeSocket();
    sock.sendMessage.mockRejectedValueOnce(new Error("Connection Closed"));
    await expect(driverWith(sock).sendText(GROUP, "hi")).rejects.toThrow("Connection Closed");
  });
});

describe("sendTextWithMentions", () => {
  it("puts the mentioned phones on the message as Baileys person JIDs", async () => {
    const sock = fakeSocket();
    await driverWith(sock).sendTextWithMentions(GROUP, "@447700900123 you're in", [
      "447700900123",
    ]);
    expect(sock.sendMessage.mock.calls[0][1]).toEqual({
      text: "@447700900123 you're in",
      linkPreview: null,
      mentions: ["447700900123@s.whatsapp.net"],
    });
    const sent = (await sock.sendMessage.mock.results[0].value) as WAMessage;
    expect(sent.message?.extendedTextMessage?.contextInfo?.mentionedJid).toEqual([
      "447700900123@s.whatsapp.net",
    ]);
  });

  it("sends a plain text, with no mentions field, when the list is empty", async () => {
    const sock = fakeSocket();
    await driverWith(sock).sendTextWithMentions(GROUP, "roster", []);
    expect(sock.sendMessage.mock.calls[0][1]).toEqual({ text: "roster", linkPreview: null });
  });

  it("returns a readable id like any other send", async () => {
    const sock = fakeSocket();
    const result = await driverWith(sock).sendTextWithMentions(GROUP, "@4477 hi", ["4477"]);
    expect(waMessageIdFrom(result)).toMatch(new RegExp(`^true_${GROUP}_`));
  });
});

describe("sendDirectText", () => {
  it("DMs the phone at its Baileys JID and returns the whatsapp-web.js-format DM id", async () => {
    const sock = fakeSocket();
    const result = await driverWith(sock).sendDirectText("447700900123", "Rate the match");
    expect(sock.sendMessage.mock.calls[0][0]).toBe("447700900123@s.whatsapp.net");
    expect(sock.sendMessage.mock.calls[0][1]).toEqual({ text: "Rate the match", linkPreview: null });
    const sent = (await sock.sendMessage.mock.results[0].value) as WAMessage;
    // A DM never had a participant under whatsapp-web.js either.
    expect(waMessageIdFrom(result)).toBe(`true_447700900123@c.us_${sent.key.id}`);
  });

  it("refuses a phone with no digits in it rather than DMing '@s.whatsapp.net'", async () => {
    const sock = fakeSocket();
    await expect(driverWith(sock).sendDirectText("", "hi")).rejects.toThrow(/phone/);
    expect(sock.sendMessage).not.toHaveBeenCalled();
  });
});

describe("sendPoll", () => {
  it("sends the poll with the whatsapp-web.js selectable-count mapping", async () => {
    const sock = fakeSocket();
    await driverWith(sock).sendPoll(GROUP, "Man of the match?", ["Sam", "Alex"], false);
    expect(sock.sendMessage.mock.calls[0][1]).toEqual({
      poll: { name: "Man of the match?", values: ["Sam", "Alex"], selectableCount: 1 },
    });
  });

  it("keeps the poll retrievable through getMessage long after ordinary sends", async () => {
    // Votes on it are decrypted with its messageSecret (Phase 4), and they
    // trickle in for a day and a half after kickoff.
    const sock = fakeSocket();
    const driver = driverWith(sock);
    const result = await driver.sendPoll(GROUP, "MoM?", ["A", "B"], false);
    for (let i = 0; i < 600; i++) await driver.sendText(GROUP, `msg ${i}`);
    const pollKey = ((await sock.sendMessage.mock.results[0].value) as WAMessage).key;
    const stored = await driver.getMessage(pollKey);
    expect(stored?.pollCreationMessageV3?.name).toBe("MoM?");
    expect(stored?.messageContextInfo?.messageSecret?.length).toBe(32);
    expect(waMessageIdFrom(result)).toBeTruthy();
  });
});

describe("getMessage (§2.12)", () => {
  it("returns what we sent, so a recipient's retry can be re-encrypted", async () => {
    const sock = fakeSocket();
    const driver = driverWith(sock);
    await driver.sendText(GROUP, "hello");
    const key = ((await sock.sendMessage.mock.results[0].value) as WAMessage).key;
    const stored = await driver.getMessage(key);
    expect(stored?.extendedTextMessage?.text ?? stored?.conversation).toBe("hello");
  });

  it("returns undefined for a message we never sent", async () => {
    expect(await driverWith(fakeSocket()).getMessage({ id: "nope" })).toBeUndefined();
  });
});

describe("sendReaction (never throws)", () => {
  it("reacts to a pre-cutover group message from the stored whatsapp-web.js id", async () => {
    const sock = fakeSocket();
    const outcome = await driverWith(sock).sendReaction(
      "false_120363000@g.us_3EB0ABC_447700900123@c.us",
      "👍",
    );
    expect(outcome).toEqual({ ok: true });
    expect(sock.sendMessage).toHaveBeenCalledTimes(1);
    const [jid, content] = sock.sendMessage.mock.calls[0];
    expect(jid).toBe("120363000@g.us");
    expect(content).toEqual({
      react: {
        text: "👍",
        key: {
          remoteJid: "120363000@g.us",
          fromMe: false,
          id: "3EB0ABC",
          participant: "447700900123@s.whatsapp.net",
        },
      },
    });
    const sent = (await sock.sendMessage.mock.results[0].value) as WAMessage;
    expect(sent.message?.reactionMessage?.key).toEqual(
      proto.MessageKey.fromObject({
        remoteJid: "120363000@g.us",
        fromMe: false,
        id: "3EB0ABC",
        participant: "447700900123@s.whatsapp.net",
      }),
    );
  });

  it("reacts to a LID-addressed member's message with the LID participant intact", async () => {
    const sock = fakeSocket();
    await driverWith(sock).sendReaction("false_120363000@g.us_3EB0ABC_99@lid", "✅");
    const content = sock.sendMessage.mock.calls[0][1] as { react: { key: { participant: string } } };
    expect(content.react.key.participant).toBe("99@lid");
  });

  it("reacts to a DM in the DM", async () => {
    const sock = fakeSocket();
    await driverWith(sock).sendReaction("false_447700900123@c.us_3A11", "👍");
    expect(sock.sendMessage.mock.calls[0][0]).toBe("447700900123@s.whatsapp.net");
  });

  it("names an id it cannot read, and sends nothing", async () => {
    const sock = fakeSocket();
    expect(await driverWith(sock).sendReaction("synthetic:abcd", "👍")).toEqual({
      ok: false,
      reason: "unparseable-id",
      detail: expect.any(String),
    });
    expect(sock.sendMessage).not.toHaveBeenCalled();
  });

  it("names a missing socket", async () => {
    expect(await driverWith(null).sendReaction("false_447700900123@c.us_3A11", "👍")).toEqual({
      ok: false,
      reason: "not-connected",
    });
  });

  it("names a send that threw, and does not throw itself", async () => {
    const sock = fakeSocket();
    sock.sendMessage.mockRejectedValueOnce(new Error("Connection Closed"));
    expect(await driverWith(sock).sendReaction("false_447700900123@c.us_3A11", "👍")).toEqual({
      ok: false,
      reason: "send-threw",
      detail: "Connection Closed",
    });
  });

  it("survives a getSocket that throws", async () => {
    const driver = makeBaileysDriver({
      getSocket: () => {
        throw new Error("boom");
      },
    });
    const outcome = await driver.sendReaction("false_447700900123@c.us_3A11", "👍");
    expect(outcome.ok).toBe(false);
  });
});

describe("replyTo", () => {
  const inbound = {
    key: {
      remoteJid: "120363000@g.us",
      fromMe: false,
      id: "3EB0IN",
      participant: "447700900123@s.whatsapp.net",
    },
    message: proto.Message.fromObject({ conversation: "voice note sorry" }),
    messageTimestamp: 1758100000,
  } as unknown as WAMessage;

  it("replies in the message's own chat, quoting the whole message, previews off", async () => {
    const sock = fakeSocket();
    await expect(driverWith(sock).replyTo(inbound as never, "Type it please")).resolves.toBeUndefined();
    const [jid, content, options] = sock.sendMessage.mock.calls[0];
    expect(jid).toBe("120363000@g.us");
    expect(content).toEqual({ text: "Type it please", linkPreview: null });
    expect((options as { quoted: unknown }).quoted).toBe(inbound);
    const sent = (await sock.sendMessage.mock.results[0].value) as WAMessage;
    expect(sent.message?.extendedTextMessage?.contextInfo?.stanzaId).toBe("3EB0IN");
  });

  it("refuses a message it cannot place, loudly", async () => {
    const sock = fakeSocket();
    await expect(driverWith(sock).replyTo({} as never, "hi")).rejects.toThrow(/replyTo/);
    expect(sock.sendMessage).not.toHaveBeenCalled();
  });
});

describe("close", () => {
  it("ends the socket and never logs out (logout unlinks the device)", async () => {
    const sock = fakeSocket();
    await driverWith(sock).close();
    expect(sock.end).toHaveBeenCalledWith(undefined);
    expect(sock.logout).not.toHaveBeenCalled();
  });

  it("is a no-op with no socket", async () => {
    await expect(driverWith(null).close()).resolves.toBeUndefined();
  });
});

describe("members this driver refuses, by name", () => {
  it("sendTextViaChat refuses rather than sending the same message down the same path twice", async () => {
    // The group reply calls this only after sendText has THROWN. Under
    // whatsapp-web.js that was a different code path; under Baileys it
    // would be the same one, so a second attempt can only fail the same
    // way or, if the first send got out before it threw, post the reply
    // twice. See the driver's header.
    const sock = fakeSocket();
    const err = await driverWith(sock)
      .sendTextViaChat(GROUP, "hi")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BaileysDriverUnsupportedError);
    expect((err as BaileysDriverUnsupportedError).member).toBe("sendTextViaChat");
    expect(sock.sendMessage).not.toHaveBeenCalled();
  });

  it("listDmChats fails visibly, so BOT_RECOVER_DM_REPLIES=1 cannot quietly recover nothing", async () => {
    const err = await driverWith(fakeSocket())
      .listDmChats()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BaileysDriverUnsupportedError);
    expect((err as BaileysDriverUnsupportedError).member).toBe("listDmChats");
    expect((err as BaileysDriverUnsupportedError).kind).toBe("no-baileys-equivalent");
    expect((err as Error).message).toMatch(/BOT_RECOVER_DM_REPLIES/);
  });

  // Everything still not built after Phase 4: only the restart replay,
  // which waits on Phase 5's offline-replay measurement. Groups, rosters,
  // joins, leaves and poll votes moved out of this list in Phase 4 and are
  // tested in `baileys.groups.test.ts`. What is left must fail by name and
  // must not send.
  const NOT_YET: Array<[keyof WaDriver, (d: WaDriver) => unknown]> = [
    ["fetchRecentGroupMessages", (d) => d.fetchRecentGroupMessages(GROUP, 10)],
  ];

  it("no longer refuses the Phase 4 members as not built: they are built", async () => {
    // With no connection and a Phase 3 socket they still cannot work, and
    // they must still THROW (the degraded contract), but not by claiming
    // to be unbuilt, which would send an operator looking for a phase that
    // has already landed.
    const phase4: Array<[keyof WaDriver, (d: WaDriver) => unknown]> = [
      ["onPollVote", (d) => d.onPollVote(() => {})],
      ["onGroupJoin", (d) => d.onGroupJoin(() => {})],
      ["onGroupLeave", (d) => d.onGroupLeave(() => {})],
      ["listGroups", (d) => d.listGroups()],
      ["groupParticipants", (d) => d.groupParticipants(GROUP)],
    ];
    for (const [member, call] of phase4) {
      const sock = fakeSocket();
      let err: unknown;
      try {
        await call(driverWith(sock));
      } catch (e) {
        err = e;
      }
      expect(err, member).toBeInstanceOf(Error);
      expect(err, member).not.toBeInstanceOf(BaileysDriverUnsupportedError);
      expect(sock.sendMessage).not.toHaveBeenCalled();
    }
  });

  for (const [member, call] of NOT_YET) {
    it(`${member} fails by name as not built yet`, async () => {
      const sock = fakeSocket();
      const driver = driverWith(sock);
      let err: unknown;
      try {
        await call(driver);
      } catch (e) {
        err = e;
      }
      expect(err, member).toBeInstanceOf(BaileysDriverUnsupportedError);
      expect((err as BaileysDriverUnsupportedError).member).toBe(member);
      expect((err as BaileysDriverUnsupportedError).kind).toBe("not-built-yet");
      expect((err as Error).message).toContain(member);
      expect(sock.sendMessage).not.toHaveBeenCalled();
    });
  }

  it("covers every member of the interface: nothing is silently missing", () => {
    const driver = driverWith(fakeSocket()) as unknown as Record<string, unknown>;
    const members = [
      "start", "close", "onOpen", "onClose", "selfId", "selfIdentities", "selfIds",
      "onMessage", "onReaction", "onPollVote", "onGroupJoin", "onGroupLeave",
      "sendText", "sendTextWithMentions", "sendDirectText", "sendPoll", "sendReaction",
      "replyTo", "sendTextViaChat", "listGroups", "groupParticipants", "groupSnapshot",
      "getContact", "contactOf", "fetchRecentGroupMessages", "listDmChats",
    ];
    for (const m of members) expect(typeof driver[m], m).toBe("function");
  });
});
