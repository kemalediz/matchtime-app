/**
 * Self-add detection and the bot-added flow, against a client whose
 * page calls throw the way the live build's do (2026-09-17).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "whatsapp-web.js";
import {
  handleGroupJoinForSelfAdd,
  isSelfAdd,
  normaliseRecipientIds,
  resolveSelfIds,
  _test_resetSelfIds,
  type BotAddedDeps,
} from "./bot-added.js";
import type { GroupSnapshot } from "./group-snapshot.js";

const asClient = (c: unknown) => c as unknown as Client;
const GID = "120363999999999999@g.us";
const PN = "447525334985@c.us";
const LID = "88813579246810@lid";

describe("normaliseRecipientIds: the page hands over strings or wid objects", () => {
  it("accepts both shapes and drops junk", () => {
    expect(normaliseRecipientIds([PN, { _serialized: LID }, null, 42, {}])).toEqual([PN, LID]);
  });
  it("non-arrays are empty", () => {
    expect(normaliseRecipientIds(undefined)).toEqual([]);
    expect(normaliseRecipientIds("447525334985@c.us")).toEqual([]);
  });
});

describe("isSelfAdd: the bot is matched by ANY of its ids", () => {
  it("matches the phone JID (a pn-addressed group)", () => {
    expect(isSelfAdd([PN], [PN, LID])).toBe(true);
  });
  it("matches the LID (a lid-addressed group, the default now)", () => {
    expect(isSelfAdd([LID], [PN, LID])).toBe(true);
  });
  it("the old comparison would have missed this: LID recipient, phone-only self id", () => {
    expect(isSelfAdd([LID], [PN])).toBe(false);
  });
  it("a human join is not a self add", () => {
    expect(isSelfAdd(["447700900001@c.us"], [PN, LID])).toBe(false);
  });
  it("no self ids known → never a self add (never post into a stranger's group)", () => {
    expect(isSelfAdd([PN], [])).toBe(false);
  });
});

describe("resolveSelfIds", () => {
  beforeEach(() => _test_resetSelfIds());

  it("collects the phone JID from client.info and the LID from the page", async () => {
    const client = {
      info: { wid: { _serialized: PN } },
      pupPage: { evaluate: vi.fn(async () => ({ pn: PN, lid: LID })) },
    };
    expect(await resolveSelfIds(asClient(client))).toEqual([PN, LID]);
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
    expect(await resolveSelfIds(asClient(client))).toEqual([]);
  });

  it("caches a non-empty answer", async () => {
    const evaluate = vi.fn(async () => ({ pn: null, lid: LID }));
    const client = { info: { wid: { _serialized: PN } }, pupPage: { evaluate } };
    await resolveSelfIds(asClient(client));
    await resolveSelfIds(asClient(client));
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
});

// ── The handler ────────────────────────────────────────────────────────

function snapshot(over: Partial<GroupSnapshot> = {}): GroupSnapshot {
  return {
    subject: "Cuma Halı Saha",
    participants: [{ phone: "447700900001", pushname: "Erdal" }],
    source: "page",
    notes: [],
    ...over,
  };
}

function deps(over: Partial<BotAddedDeps> = {}) {
  const monitored = new Set<string>();
  const onboarding = new Set<string>();
  const sendMessage = vi.fn(async () => ({}));
  const client = {
    sendMessage,
    getContactById: vi.fn(async () => {
      throw new Error("r");
    }),
  };
  const postBotAdded = vi.fn(async () => ({ introText: "👋 Merhaba", language: "tr" }));
  const d: BotAddedDeps = {
    client: asClient(client),
    isMonitoredGroup: (g) => monitored.has(g),
    addMonitoredGroup: (g) => void monitored.add(g),
    addOnboardingGroup: (g) => void onboarding.add(g),
    resolveSelfIds: async () => [PN, LID],
    readGroupSnapshot: async () => snapshot(),
    fetchHistory: async () => [{ author: "Erdal", authorPhone: "447700900001", text: "ben varım", timestamp: "2026-09-17T10:00:00.000Z" }],
    postBotAdded,
    log: () => undefined,
    error: () => undefined,
    ...over,
  };
  return { d, monitored, onboarding, sendMessage, postBotAdded };
}

describe("handleGroupJoinForSelfAdd", () => {
  it("a lid-addressed self add: snapshot + history reach the server, the intro is posted, the group is monitored and onboarding", async () => {
    const { d, monitored, onboarding, sendMessage, postBotAdded } = deps();
    const out = await handleGroupJoinForSelfAdd(d, { chatId: GID, recipientIds: [{ _serialized: LID }], author: "447700900001@c.us" });
    expect(out.kind).toBe("posted");
    expect(postBotAdded).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: GID,
        groupSubject: "Cuma Halı Saha",
        addedByPhone: "447700900001",
        participants: [{ phone: "447700900001", lidId: null, pushname: "Erdal" }],
        enrichmentHistory: [expect.objectContaining({ text: "ben varım" })],
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(GID, "👋 Merhaba");
    expect(monitored.has(GID)).toBe(true);
    expect(onboarding.has(GID)).toBe(true);
  });

  it("a human join in an unmonitored group is not a self add and touches nothing", async () => {
    const { d, postBotAdded } = deps();
    const out = await handleGroupJoinForSelfAdd(d, { chatId: GID, recipientIds: ["447700900002@c.us"] });
    expect(out.kind).toBe("not-self-add");
    expect(postBotAdded).not.toHaveBeenCalled();
  });

  it("a re-add to a monitored group (a live org) is left to the human-join path", async () => {
    const { d, postBotAdded } = deps();
    d.addMonitoredGroup(GID);
    const out = await handleGroupJoinForSelfAdd(d, { chatId: GID, recipientIds: [PN] });
    expect(out.kind).toBe("already-monitored");
    expect(postBotAdded).not.toHaveBeenCalled();
  });

  it("the server saying stay silent posts nothing and monitors nothing", async () => {
    const { d, monitored, sendMessage } = deps({
      postBotAdded: vi.fn(async () => ({ introText: null, ignored: "live-org" })),
    });
    const out = await handleGroupJoinForSelfAdd(d, { chatId: GID, recipientIds: [PN] });
    expect(out).toEqual({ kind: "silent", reason: "live-org" });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(monitored.has(GID)).toBe(false);
  });

  it("a snapshot and history that both fail still reach the server with a bare groupId", async () => {
    const { d, postBotAdded } = deps({
      readGroupSnapshot: async () => {
        throw new Error("r");
      },
      fetchHistory: async () => {
        throw new Error("r");
      },
    });
    const out = await handleGroupJoinForSelfAdd(d, { chatId: GID, recipientIds: [LID], author: "999@lid" });
    expect(out.kind).toBe("posted");
    expect(postBotAdded).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: GID, groupSubject: null, participants: [], enrichmentHistory: undefined }),
    );
  });

  it("a failed server call is silent, not a crash", async () => {
    const { d } = deps({
      postBotAdded: vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    });
    const out = await handleGroupJoinForSelfAdd(d, { chatId: GID, recipientIds: [PN] });
    expect(out).toEqual({ kind: "silent", reason: "server-call-failed" });
  });
});
