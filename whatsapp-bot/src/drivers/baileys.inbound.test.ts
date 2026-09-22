/**
 * The Baileys driver's startup, identity and inbound half (Phase 3b), end
 * to end against a fake socket.
 *
 * Everything here goes through the driver as `index.ts` and
 * `smart-analysis.ts` use it, and reads the results back with the bot's
 * own helpers (`wa-read.ts`, `message-id.ts`, `send-result.ts`,
 * `mentions.ts`, `bot-added.ts`). A test that only inspected the driver's
 * fields would prove the driver agrees with itself; these prove the bot
 * above the seam sees what it has always seen.
 *
 * No test opens a socket: `FakeSocket` stands in for `WASocket`.
 */
import { describe, it, expect } from "vitest";
import { proto, type WAMessage } from "baileys";
import type { InboundMessage } from "../driver.js";
import { readInboundHeadline, safePath, safeRead, asString } from "../wa-read.js";
import { resolveWaMessageId } from "../message-id.js";
import { waMessageIdFrom } from "../send-result.js";
import { rewriteMentions } from "../mentions.js";
import { isSelfAdd } from "../bot-added.js";
import { FakeSocket, manualScheduler } from "../baileys/fake-socket.js";
import { createBaileysConnection } from "../baileys/lifecycle.js";
import { createSessionLedger } from "../baileys/session-ledger.js";
import { makeBaileysDriver } from "./baileys.js";

const GROUP = "120363000000000000@g.us";
const PLAYER_PN = "447700900123@s.whatsapp.net";
const PLAYER_LID = "158055467598020@lid";
const BOT_PN_LEGACY = "447700900001@c.us";
const BOT_LID = "158000000000001@lid";

const tick = () => new Promise((r) => setImmediate(r));

function setup(opts: { groupAddressingMode?: (g: string) => "lid" | "pn" | undefined } = {}) {
  const sockets: FakeSocket[] = [];
  const scheduler = manualScheduler();
  const logs: string[] = [];
  const errors: string[] = [];
  const log = (l: string) => logs.push(l);
  const error = (l: string) => errors.push(l);
  const connection = createBaileysConnection<FakeSocket>({
    makeSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    pairPhone: "",
    ledger: createSessionLedger({ load: () => null, save: () => {} }),
    printQr: () => {},
    schedule: scheduler.schedule,
    exit: () => {},
    log,
    error,
  });
  const driver = makeBaileysDriver({
    connection: connection as never,
    groupAddressingMode: opts.groupAddressingMode,
    log,
    error,
  });
  const sock = () => sockets[sockets.length - 1];
  return { driver, connection, sockets, sock, scheduler, logs, errors };
}

async function started(opts?: Parameters<typeof setup>[0]) {
  const t = setup(opts);
  await t.driver.start();
  t.sock().open();
  return t;
}

function wa(
  message: Record<string, unknown>,
  key: Partial<proto.IMessageKey> = {},
  extra: Partial<WAMessage> = {},
): WAMessage {
  return {
    key: { remoteJid: GROUP, fromMe: false, id: "3EB0C0FFEE", participant: PLAYER_PN, ...key },
    message: proto.Message.fromObject(message),
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: "Sam",
    ...extra,
  } as WAMessage;
}

function collect(driver: ReturnType<typeof setup>["driver"]) {
  const got: InboundMessage[] = [];
  driver.onMessage((m) => {
    got.push(m);
  });
  return got;
}

// ── Lifecycle ────────────────────────────────────────────────────────

describe("lifecycle through the driver", () => {
  it("start() connects, onOpen fires on open, and sends work only while open", async () => {
    const t = setup();
    let opened = 0;
    t.driver.onOpen(() => {
      opened++;
    });
    await t.driver.start();
    await expect(t.driver.sendText(GROUP, "hi")).rejects.toThrow(/not connected/);
    t.sock().open();
    expect(opened).toBe(1);
    await expect(t.driver.sendText(GROUP, "hi")).resolves.toBeTruthy();
  });

  it("onClose hears every close, so index.ts stops its timers around a blip", async () => {
    const t = await started();
    const reasons: string[] = [];
    t.driver.onClose((r) => reasons.push(r));
    t.sock().closeWith(428);
    expect(reasons).toEqual([expect.stringMatching(/428/)]);
    await expect(t.driver.sendText(GROUP, "hi")).rejects.toThrow(/not connected/);
  });

  it("close() ends the socket and never logs out", async () => {
    const t = await started();
    await t.driver.close();
    expect(t.sock().ended).toEqual([undefined]);
    expect(t.sock().loggedOut).toBe(0);
  });

  it("refuses to start with no connection wired, loudly rather than as a deaf bot", async () => {
    const driver = makeBaileysDriver({ getSocket: () => null });
    await expect(driver.start()).rejects.toThrow(/no connection/);
    expect(() => driver.onOpen(() => {})).toThrow(/no connection/);
    expect(() => driver.onMessage(() => {})).toThrow(/no connection/);
  });
});

// ── Identity ─────────────────────────────────────────────────────────

describe("the three notions of self", () => {
  it("selfId is the phone JID in the @c.us spelling, device suffix stripped", async () => {
    const t = await started();
    // sock.user.id is "447700900001:12@s.whatsapp.net". Unstripped, every
    // comparison above the seam silently fails (plan §2.4).
    expect(t.driver.selfId()).toBe(BOT_PN_LEGACY);
  });

  it("selfId is undefined, not a throw, before there is any socket", () => {
    expect(setup().driver.selfId()).toBeUndefined();
  });

  it("selfIdentities lists every form, selfId first", async () => {
    const t = await started();
    const ids = t.driver.selfIdentities();
    expect(ids[0]).toBe(t.driver.selfId());
    expect(ids).toEqual([BOT_PN_LEGACY, BOT_LID]);
  });

  it("selfIds resolves both forms for self-add detection", async () => {
    const t = await started();
    expect(await t.driver.selfIds()).toEqual([BOT_PN_LEGACY, BOT_LID]);
  });

  it("selfIds does not cache a partial answer, so a LID that arrives later still counts", async () => {
    // A cached [phone] would make every self-add into a LID-addressed
    // group invisible for the life of the process.
    const t = setup();
    await t.driver.start();
    t.sock().user = { id: "447700900001:12@s.whatsapp.net" };
    t.sock().open();
    expect(await t.driver.selfIds()).toEqual([BOT_PN_LEGACY]);
    t.sock().user = { id: "447700900001:12@s.whatsapp.net", lid: "158000000000001:12@lid" };
    expect(await t.driver.selfIds()).toEqual([BOT_PN_LEGACY, BOT_LID]);
  });

  it("a mention of the bot counts as tagging it under EITHER addressing, via the real mention code", async () => {
    // The interaction contract hangs off this: an untagged "@MatchTime
    // help" is silence.
    const t = await started();
    for (const jid of [BOT_PN_LEGACY, BOT_LID]) {
      const contact = await t.driver.getContact(jid);
      const result = rewriteMentions({
        body: `@${jid.split("@")[0]} help`,
        contacts: [{ jid, isMe: safeRead(contact, "isMe") === true }],
        botIdentities: t.driver.selfIdentities(),
      });
      expect(result.botMentioned, jid).toBe(true);
      expect(result.body, jid).toBe("@Match Time help");
    }
  });

  it("a mention of a player does not count as tagging the bot", async () => {
    const t = await started();
    const contact = await t.driver.getContact(PLAYER_LID);
    const result = rewriteMentions({
      body: "@158055467598020 is in",
      contacts: [{ jid: PLAYER_LID, isMe: safeRead(contact, "isMe") === true }],
      botIdentities: t.driver.selfIdentities(),
    });
    expect(result.botMentioned).toBe(false);
  });

  it("selfIds matches a self-add under either addressing, via the real isSelfAdd", async () => {
    const t = await started();
    const self = await t.driver.selfIds();
    expect(isSelfAdd([BOT_LID], self)).toBe(true);
    expect(isSelfAdd([BOT_PN_LEGACY], self)).toBe(true);
    expect(isSelfAdd(["447700900123@c.us"], self)).toBe(false);
  });
});

// ── Inbound ──────────────────────────────────────────────────────────

describe("onMessage", () => {
  it("hands up a group text the bot reads exactly as before", async () => {
    const t = await started();
    const got = collect(t.driver);
    t.sock().emit("messages.upsert", { messages: [wa({ conversation: "in" })], type: "notify" });
    await tick();
    expect(got).toHaveLength(1);
    const head = readInboundHeadline(got[0]);
    expect(head).toMatchObject({ from: GROUP, fromMe: false, type: "chat", body: "in", notifyName: "Sam" });
    expect(resolveWaMessageId(got[0]).waMessageId).toBe(`false_${GROUP}_3EB0C0FFEE_447700900123@c.us`);
  });

  it("drops NOTHING on the upsert type: append is handed up too", async () => {
    // Whether an offline replay arrives as notify or append is the open
    // measurement (plan §2.15). HomeTenant drops append; we may not.
    const t = await started();
    const got = collect(t.driver);
    t.sock().emit("messages.upsert", { messages: [wa({ conversation: "in" }, { id: "A1" })], type: "append" });
    await tick();
    expect(got).toHaveLength(1);
  });

  it("logs the upsert type on every message, including skipped ones and duplicates", async () => {
    const t = await started();
    collect(t.driver);
    const text = wa({ conversation: "in" }, { id: "D1" });
    const reactionMsg = wa({ reactionMessage: { key: { remoteJid: GROUP, id: "X", fromMe: true }, text: "👍" } }, { id: "D2" });
    t.sock().emit("messages.upsert", { messages: [text, reactionMsg], type: "notify" });
    t.sock().emit("messages.upsert", { messages: [text], type: "append" });
    await tick();
    const lines = t.logs.filter((l) => l.startsWith("[baileys][msg]"));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/upsert=notify .*id=D1/);
    expect(lines[0]).toMatch(/age=\d+s/);
    expect(lines[1]).toMatch(/upsert=notify .*id=D2 .*skipped/);
    expect(lines[2]).toMatch(/upsert=append .*id=D1 .*duplicate/);
    expect(t.driver.stats()).toMatchObject({
      upserts: { notify: 2, append: 1 },
      delivered: 1,
      skipped: 1,
      duplicates: 1,
    });
  });

  it("hands up our own messages with fromMe set, as the contract says; index.ts skips them", async () => {
    const t = await started();
    const got = collect(t.driver);
    t.sock().emit("messages.upsert", {
      messages: [wa({ conversation: "Teams are out" }, { fromMe: true, participant: undefined, id: "OWN" })],
      type: "append",
    });
    await tick();
    expect(got).toHaveLength(1);
    expect(readInboundHeadline(got[0]).fromMe).toBe(true);
  });

  it("still filters status updates, broadcasts and newsletters", async () => {
    const t = await started();
    const got = collect(t.driver);
    t.sock().emit("messages.upsert", {
      messages: [
        wa({ conversation: "x" }, { remoteJid: "status@broadcast", id: "S1" }),
        wa({ conversation: "x" }, { remoteJid: "1234@newsletter", id: "S2" }),
      ],
      type: "notify",
    });
    await tick();
    expect(got).toHaveLength(0);
  });

  it("resolves a LID sender through the envelope's alt", async () => {
    const t = await started();
    const got = collect(t.driver);
    t.sock().emit("messages.upsert", {
      messages: [wa({ conversation: "in" }, { participant: PLAYER_LID, participantAlt: PLAYER_PN })],
      type: "notify",
    });
    await tick();
    expect(safeRead(got[0], "author")).toBe("447700900123@c.us");
  });

  it("resolves a LID sender through Baileys' local store, asked with the FULL LID JID", async () => {
    const t = await started();
    t.sock().storedPnForLid.set(PLAYER_LID, "447700900123:0@s.whatsapp.net");
    const got = collect(t.driver);
    t.sock().emit("messages.upsert", { messages: [wa({ conversation: "in" }, { participant: PLAYER_LID })], type: "notify" });
    await tick();
    expect(safeRead(got[0], "author")).toBe("447700900123@c.us");
    expect(t.sock().pnLookups).toEqual([PLAYER_LID]);
  });

  it("still hands up an unresolvable LID sender, logs it loudly and counts it", async () => {
    // Under whatsapp-web.js this sender reached the server with a name and
    // no phone; the same happens here, but it is no longer silent.
    const t = await started();
    const got = collect(t.driver);
    t.sock().emit("messages.upsert", { messages: [wa({ conversation: "in" }, { participant: PLAYER_LID })], type: "notify" });
    await tick();
    expect(got).toHaveLength(1);
    expect(safeRead(got[0], "author")).toBe(PLAYER_LID);
    expect(t.errors.join("\n")).toMatch(/sender UNRESOLVED/);
    expect(t.driver.stats().unresolvedSenders).toBe(1);
  });

  it("keeps a batch in order even when one sender needs a slower lookup", async () => {
    // The analyzer reasons over the buffer in arrival order; an offline
    // replay handed up out of order reads the evening backwards.
    const t = await started();
    const got = collect(t.driver);
    t.sock().emit("messages.upsert", {
      messages: [
        wa({ conversation: "first" }, { id: "O1", participant: PLAYER_LID }),
        wa({ conversation: "second" }, { id: "O2" }),
        wa({ conversation: "third" }, { id: "O3", participant: PLAYER_LID }),
      ],
      type: "append",
    });
    await tick();
    await tick();
    expect(got.map((m) => readInboundHeadline(m).body)).toEqual(["first", "second", "third"]);
  });

  it("keeps delivering when one handler throws", async () => {
    const t = await started();
    t.driver.onMessage(() => {
      throw new Error("handler bug");
    });
    const got = collect(t.driver);
    t.sock().emit("messages.upsert", { messages: [wa({ conversation: "in" })], type: "notify" });
    await tick();
    expect(got).toHaveLength(1);
  });

  it("replyTo quotes the raw WAMessage behind a handed-up view", async () => {
    const t = await started();
    const got = collect(t.driver);
    const raw = wa({ audioMessage: { ptt: true } }, { remoteJid: PLAYER_PN, participant: undefined, id: "VN1" });
    t.sock().emit("messages.upsert", { messages: [raw], type: "notify" });
    await tick();
    await t.driver.replyTo(got[0], "Type it please");
    const sent = t.sock().sent.at(-1)!;
    expect(sent.jid).toBe(PLAYER_PN);
    expect((sent.options as { quoted: unknown }).quoted).toBe(raw);
  });
});

// ── Contacts ─────────────────────────────────────────────────────────

describe("contactOf and getContact: harvested, never fetched", () => {
  it("contactOf gives the sender's phone and pushname off the message itself", async () => {
    const t = await started();
    const got = collect(t.driver);
    t.sock().emit("messages.upsert", {
      messages: [wa({ conversation: "yes" }, { remoteJid: PLAYER_LID, remoteJidAlt: PLAYER_PN, participant: undefined })],
      type: "notify",
    });
    await tick();
    const contact = await t.driver.contactOf(got[0]);
    // index.ts's DM path reads exactly these two, in this order.
    expect(safeRead(contact, "number")).toBe("447700900123");
    expect(safeRead(contact, "pushname")).toBe("Sam");
  });

  it("getContact knows a name it has seen on a message, under either addressing", async () => {
    const t = await started();
    t.sock().emit("messages.upsert", {
      messages: [wa({ conversation: "in" }, { participant: PLAYER_LID, participantAlt: PLAYER_PN })],
      type: "notify",
    });
    await tick();
    for (const jid of [PLAYER_LID, "447700900123@c.us"]) {
      const c = await t.driver.getContact(jid);
      expect(safeRead(c, "pushname"), jid).toBe("Sam");
      expect(safeRead(c, "number"), jid).toBe("447700900123");
    }
  });

  it("getContact knows a name from contacts.upsert", async () => {
    const t = await started();
    t.sock().emit("contacts.upsert", [{ id: PLAYER_LID, phoneNumber: PLAYER_PN, notify: "Sam", name: "Sam S" }]);
    const c = await t.driver.getContact(PLAYER_LID);
    expect({ pushname: safeRead(c, "pushname"), name: safeRead(c, "name"), number: safeRead(c, "number") }).toEqual({
      pushname: "Sam",
      name: "Sam S",
      number: "447700900123",
    });
  });

  it("for an UNKNOWN sender returns a record with no name and no number, and asks nobody", async () => {
    // The HomeTenant lesson: ~100 directory lookups got every linked device
    // unlinked. So an unknown name is simply unknown. Every caller already
    // reads `pushname || name` and falls back when both are missing.
    const t = await started();
    const c = await t.driver.getContact("447700900999@c.us");
    expect(c).toEqual({
      id: { _serialized: "447700900999@c.us" },
      number: "447700900999",
      pushname: undefined,
      name: undefined,
      verifiedName: undefined,
      shortName: undefined,
      isMe: false,
    });
    // A phone JID needs no lookup at all; nothing touched the store.
    expect(t.sock().pnLookups).toEqual([]);
  });

  it("for an unknown LID returns no number rather than reading one out of the LID's digits", async () => {
    const t = await started();
    const c = await t.driver.getContact(PLAYER_LID);
    expect(safeRead(c, "number")).toBeUndefined();
    // One LOCAL store read (no network path exists in Baileys), and no more.
    expect(t.sock().pnLookups).toEqual([PLAYER_LID]);
  });

  it("never throws, even with no socket at all", async () => {
    const t = setup();
    await expect(t.driver.getContact(PLAYER_LID)).resolves.toMatchObject({ isMe: false });
    await expect(t.driver.contactOf({})).resolves.toMatchObject({ isMe: false });
  });

  it("marks the bot's own contact isMe under either addressing", async () => {
    const t = await started();
    expect(safeRead(await t.driver.getContact(BOT_LID), "isMe")).toBe(true);
    expect(safeRead(await t.driver.getContact("447700900001@s.whatsapp.net"), "isMe")).toBe(true);
  });
});

// ── Reactions ────────────────────────────────────────────────────────

function asIndexSees(payload: unknown) {
  return {
    waMessageId: asString(safePath(payload, "msgId", "_serialized")),
    fromId: asString(safeRead(payload, "senderId")),
    emoji: asString(safeRead(payload, "reaction")),
  };
}

describe("onReaction: the id handed up is the id the database stored", () => {
  it("joins a recruit's 👍 in a LID-addressed DM to the invite the bot sent to their phone", async () => {
    const t = await started();
    const reactions: unknown[] = [];
    t.driver.onReaction((r) => {
      reactions.push(r);
    });
    // The invite, and the id the scheduler acks with (what the DB holds).
    const sent = await t.driver.sendDirectText("447700900123", "Fancy a game Tuesday?");
    const stored = waMessageIdFrom(sent);
    expect(stored).toMatch(/^true_447700900123@c\.us_/);
    const sentId = (sent as { key: { id: string } }).key.id;

    // The reply arrives on the LID. Baileys has the mapping stored.
    t.sock().storedPnForLid.set(PLAYER_LID, "447700900123:0@s.whatsapp.net");
    t.sock().emit("messages.reaction", [
      {
        key: { remoteJid: PLAYER_LID, fromMe: true, id: sentId },
        reaction: { text: "👍", key: { remoteJid: PLAYER_LID, fromMe: false, id: "R1" } },
      },
    ]);
    await tick();
    expect(asIndexSees(reactions[0])).toEqual({
      waMessageId: stored,
      fromId: "447700900123@c.us",
      emoji: "👍",
    });
  });

  it("when the LID cannot be mapped, hands up no id, logs CRITICAL and counts it", async () => {
    const t = await started();
    const reactions: unknown[] = [];
    t.driver.onReaction((r) => {
      reactions.push(r);
    });
    t.sock().emit("messages.reaction", [
      {
        key: { remoteJid: PLAYER_LID, fromMe: true, id: "3EB0INVITE" },
        reaction: { text: "👍", key: { remoteJid: PLAYER_LID, fromMe: false, id: "R2" } },
      },
    ]);
    await tick();
    // index.ts: emoji present, id missing, so it records reaction-forwarding
    // degraded and logs its own CRITICAL. That is the off-Pi signal.
    expect(asIndexSees(reactions[0]).waMessageId).toBe("");
    expect(asIndexSees(reactions[0]).emoji).toBe("👍");
    expect(t.errors.join("\n")).toMatch(/CRITICAL.*reaction.*158055467598020@lid/);
    expect(t.driver.stats().unresolvedReactionTargets).toBe(1);
  });

  it("joins a reaction on our own group post whatever our participant the reactor wrote", async () => {
    const t = await started();
    const reactions: unknown[] = [];
    t.driver.onReaction((r) => {
      reactions.push(r);
    });
    const sent = await t.driver.sendText(GROUP, "Bench spot open, react 👍");
    const stored = waMessageIdFrom(sent);
    const sentId = (sent as { key: { id: string } }).key.id;
    t.sock().emit("messages.reaction", [
      {
        key: { remoteJid: GROUP, fromMe: true, id: sentId, participant: BOT_LID },
        reaction: { text: "👍", key: { remoteJid: GROUP, fromMe: false, id: "R3", participant: PLAYER_LID, participantAlt: PLAYER_PN } },
      },
    ]);
    await tick();
    expect(asIndexSees(reactions[0])).toEqual({ waMessageId: stored, fromId: "447700900123@c.us", emoji: "👍" });
  });

  it("does not hand up the echo of our own reaction", async () => {
    const t = await started();
    const reactions: unknown[] = [];
    t.driver.onReaction((r) => {
      reactions.push(r);
    });
    t.sock().emit("messages.reaction", [
      {
        key: { remoteJid: GROUP, fromMe: false, id: "IN1", participant: PLAYER_PN },
        reaction: { text: "✅", key: { remoteJid: GROUP, fromMe: true, id: "R4" } },
      },
    ]);
    await tick();
    expect(reactions).toHaveLength(0);
    expect(t.driver.stats().ownReactionsIgnored).toBe(1);
  });
});
