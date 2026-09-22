/**
 * Phase 4 of the Baileys driver, end to end against a fake socket:
 * groups, participants, join and leave, polls, and the LID-to-phone bridge.
 *
 * HomeTenant's Baileys driver discards groups outright, so nothing here
 * has a production precedent. Two rules shape the tests:
 *
 *   - the THROW CONTRACT in `driver.ts`: `listGroups` and
 *     `groupParticipants` propagate failures, because `index.ts` turns the
 *     throw into `group-enumeration` / `participant-sync` degraded, the
 *     bot's only off-Pi health signal;
 *   - the bridge is judged by what `index.ts` does with the result: the
 *     participant sweep below is a copy of its loop, so a test that passes
 *     here posts phones, not LIDs, to the server.
 *
 * The LID store behind the fake socket is Baileys' REAL `LIDMappingStore`,
 * so a pair in the wrong form is skipped here exactly as it would be live.
 */
import { describe, it, expect } from "vitest";
import {
  aesEncryptGCM,
  hmacSign,
  proto,
  sha256,
  type GroupMetadata,
  type WAMessage,
} from "baileys";
import { randomBytes } from "node:crypto";
import type { GroupMembershipEvent, InboundPollVote } from "../driver.js";
import { isSelfAdd } from "../bot-added.js";
import { waMessageIdFrom } from "../send-result.js";
import { FakeSocket, manualScheduler } from "../baileys/fake-socket.js";
import { createBaileysConnection } from "../baileys/lifecycle.js";
import { createSessionLedger } from "../baileys/session-ledger.js";
import { createPollArchive, type PollArchiveIO } from "../baileys/poll-store.js";
import { GROUP_SWEEP_INTERVAL_MS } from "../baileys/groups.js";
import { phoneFromJid } from "../baileys/jid.js";
import { makeBaileysDriver } from "./baileys.js";

const GROUP = "120363000000000000@g.us";
const OTHER = "120363000000000999@g.us";
const ME_PN = "447700900001@s.whatsapp.net";
const ME_LID = "158000000000001@lid";

const tick = () => new Promise((r) => setImmediate(r));

function sutton(): GroupMetadata {
  return {
    id: GROUP,
    subject: "Sutton FC",
    addressingMode: "lid",
    owner: undefined,
    participants: [
      { id: ME_LID, phoneNumber: ME_PN, admin: null },
      { id: "158055467598020@lid", phoneNumber: "447700900123@s.whatsapp.net", admin: null },
      { id: "158055467598021@lid", phoneNumber: "447700900124@s.whatsapp.net", admin: "admin" },
      { id: "447700900555@s.whatsapp.net", lid: "158077777777777@lid", admin: null },
      { id: "158099999999999@lid", admin: null },
    ],
  } as GroupMetadata;
}

function memoryIO(): PollArchiveIO & { value: unknown } {
  const io = { value: null as unknown } as PollArchiveIO & { value: unknown };
  io.load = () => io.value;
  io.save = (v) => {
    io.value = JSON.parse(JSON.stringify(v));
  };
  return io;
}

function setup(opts: { pollIO?: PollArchiveIO; now?: () => number } = {}) {
  const sockets: FakeSocket[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const connection = createBaileysConnection<FakeSocket>({
    makeSocket: () => {
      const s = new FakeSocket();
      s.groups = { [GROUP]: sutton(), [OTHER]: { ...sutton(), id: OTHER, subject: "Erdal", addressingMode: "pn" } };
      sockets.push(s);
      return s;
    },
    pairPhone: "",
    ledger: createSessionLedger({ load: () => null, save: () => {} }),
    printQr: () => {},
    schedule: manualScheduler().schedule,
    exit: () => {},
    log: (l) => logs.push(l),
    error: (l) => errors.push(l),
  });
  const now = opts.now ?? (() => 1_000_000);
  const driver = makeBaileysDriver({
    connection: connection as never,
    pollArchive: createPollArchive({ io: opts.pollIO ?? memoryIO(), now }),
    now,
    log: (l) => logs.push(l),
    error: (l) => errors.push(l),
  });
  const sock = () => sockets[sockets.length - 1];
  return { driver, connection, sockets, sock, logs, errors };
}

async function started(opts?: Parameters<typeof setup>[0]) {
  const t = setup(opts);
  await t.driver.start();
  t.sock().open();
  await tick();
  return t;
}

/** `index.ts`'s participant sweep loop, verbatim in what it does with ids. */
async function indexSweep(driver: ReturnType<typeof setup>["driver"], groupId: string) {
  const participants = await driver.groupParticipants(groupId);
  const selfId = driver.selfId();
  const out: Array<{ phone?: string; lidId?: string; pushname?: string }> = [];
  for (const id of participants) {
    if (selfId && id === selfId) continue;
    let phone: string | undefined;
    let lidId: string | undefined;
    if (id.endsWith("@c.us")) {
      phone = id.replace("@c.us", "").replace(/^\+/, "");
    } else if (id.endsWith("@lid")) {
      lidId = id;
      const contact = (await driver.getContact(id)) as { number?: string };
      if (typeof contact.number === "string" && contact.number.length > 0) phone = contact.number;
    }
    const contact = (await driver.getContact(id)) as { pushname?: string; name?: string };
    out.push({ phone, lidId, pushname: contact.pushname || contact.name || undefined });
  }
  return out;
}

describe("listGroups", () => {
  it("lists every group from ONE groupFetchAllParticipating", async () => {
    const t = await started();
    expect(await t.driver.listGroups()).toEqual([
      { id: GROUP, name: "Sutton FC" },
      { id: OTHER, name: "Erdal" },
    ]);
    expect(t.sock().fetchAllCalls).toBe(1);
  });

  it("PROPAGATES a failure: that throw is what records group-enumeration degraded", async () => {
    const t = await started();
    t.sock().groupError = new Error("rate-overlimit");
    await expect(t.driver.listGroups()).rejects.toThrow(/rate-overlimit/);
  });

  it("throws when the socket is not open, rather than answering []", async () => {
    const t = setup();
    await t.driver.start();
    await expect(t.driver.listGroups()).rejects.toThrow(/not connected/);
  });
});

describe("groupParticipants and the LID-to-phone bridge", () => {
  it("returns PHONE-form ids for everyone WhatsApp gave a phone, so index.ts posts phones", async () => {
    const t = await started();
    expect(await t.driver.groupParticipants(GROUP)).toEqual([
      "447700900001@c.us",
      "447700900123@c.us",
      "447700900124@c.us",
      "447700900555@c.us",
      "158099999999999@lid",
    ]);
  });

  it("feeds index.ts's sweep: the bot skipped, four phones, one honest LID", async () => {
    const t = await started();
    const out = await indexSweep(t.driver, GROUP);
    expect(out.map((p) => p.phone ?? p.lidId)).toEqual([
      "447700900123",
      "447700900124",
      "447700900555",
      "158099999999999@lid",
    ]);
    // Never a phone guessed from LID digits.
    expect(JSON.stringify(out)).not.toContain('"phone":"158099999999999"');
  });

  it("seeds Baileys' OWN mapping store with every pair, in full wire JIDs", async () => {
    const t = await started();
    await t.driver.groupParticipants(GROUP);
    const pairs = t.sock().storedPairBatches.flat();
    expect(pairs).toEqual(
      expect.arrayContaining([
        { lid: "158055467598020@lid", pn: "447700900123@s.whatsapp.net" },
        { lid: "158077777777777@lid", pn: "447700900555@s.whatsapp.net" },
      ]),
    );
    // Proven against the REAL store: the local-only lookup now answers.
    // (It answers with a device suffix, `447...:0@s.whatsapp.net`, which
    // phoneFromJid strips; 3b's lookups already read it that way.)
    expect(phoneFromJid(await t.sock().realLidStore.getPNForLID("158055467598020@lid"))).toBe("447700900123");
    expect(await t.sock().realLidStore.getPNForLID("158099999999999@lid")).toBeNull();
  });

  it("closes the loop: a later message from a LID resolves to the phone the sweep learned", async () => {
    const t = await started();
    await t.driver.groupParticipants(GROUP);
    const seen: unknown[] = [];
    t.driver.onMessage((m) => void seen.push(m));
    t.sock().emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: GROUP, fromMe: false, id: "3EB0AAAA", participant: "158055467598020@lid" },
          message: proto.Message.fromObject({ conversation: "IN" }),
          messageTimestamp: Math.floor(Date.now() / 1000),
          pushName: "Sam",
        },
      ],
    });
    await tick();
    await tick();
    const contact = (await t.driver.contactOf(seen[0] as never)) as { number?: string };
    expect(contact.number).toBe("447700900123");
  });

  it("uses groupMetadata, not the participating listing, which may carry no phones", async () => {
    const t = await started();
    await t.driver.listGroups();
    await t.driver.groupParticipants(GROUP);
    expect(t.sock().metadataCalls).toEqual([GROUP]);
  });

  it("PROPAGATES a failure: that throw is what records participant-sync degraded", async () => {
    const t = await started();
    t.sock().groupError = new Error("forbidden");
    await expect(t.driver.groupParticipants(GROUP)).rejects.toThrow(/forbidden/);
  });

  it("still returns the roster when the mapping store write fails, and says so", async () => {
    const t = await started();
    t.sock().signalRepository.lidMapping.storeLIDPNMappings = async () => {
      throw new Error("keys locked");
    };
    expect(await t.driver.groupParticipants(GROUP)).toHaveLength(5);
    expect(t.errors.join("\n")).toMatch(/storeLIDPNMappings failed.*keys locked/);
  });
});

describe("sweep frequency: a reconnect does not re-read every roster", () => {
  it("serves a roster read in the last 15 minutes from the cache, across a reconnect", async () => {
    let t0 = 1_000_000;
    const t = await started({ now: () => t0 });
    await t.driver.groupParticipants(GROUP);
    await t.driver.listGroups();
    t.sock().open(); // a blip: the same socket re-opens, onOpen fires again
    await tick();
    await t.driver.groupParticipants(GROUP);
    await t.driver.listGroups();
    expect(t.sock().metadataCalls).toEqual([GROUP]);
    expect(t.sock().fetchAllCalls).toBe(1);
    expect(t.logs.join("\n")).toMatch(/served from cache/);

    t0 += GROUP_SWEEP_INTERVAL_MS;
    await t.driver.groupParticipants(GROUP);
    await t.driver.listGroups();
    expect(t.sock().metadataCalls).toEqual([GROUP, GROUP]);
    expect(t.sock().fetchAllCalls).toBe(2);
  });

  it("keeps the cached roster exact from live joins and leaves", async () => {
    const t = await started();
    await t.driver.groupParticipants(GROUP);
    t.sock().emit("group-participants.update", {
      id: GROUP,
      author: "",
      action: "remove",
      participants: [{ id: "158055467598020@lid", phoneNumber: "447700900123@s.whatsapp.net" }],
    });
    await tick();
    await tick();
    expect(await t.driver.groupParticipants(GROUP)).not.toContain("447700900123@c.us");
    expect(t.sock().metadataCalls).toEqual([GROUP]);
  });
});

describe("cachedGroupMetadata, for Baileys' group sends", () => {
  it("answers from this connection's read, and not across a reconnect", async () => {
    const t = await started();
    await t.driver.groupParticipants(GROUP);
    expect((await t.driver.cachedGroupMetadata(GROUP))?.participants).toHaveLength(5);
    t.sock().open();
    await tick();
    expect(await t.driver.cachedGroupMetadata(GROUP)).toBeUndefined();
  });
});

describe("groupAddressingMode drives our own id on our group posts", () => {
  it("stamps our LID on a post in a LID-addressed group, and our phone in a phone-addressed one", async () => {
    const t = await started();
    await t.driver.listGroups();
    const lidPost = await t.driver.sendText(GROUP, "roster");
    const pnPost = await t.driver.sendText(OTHER, "roster");
    expect(waMessageIdFrom(lidPost)).toMatch(new RegExp(`^true_${GROUP}_[^_]+_${ME_LID}$`));
    expect(waMessageIdFrom(pnPost)).toMatch(new RegExp(`^true_${OTHER}_[^_]+_447700900001@c\\.us$`));
  });

  it("joins a reaction on that LID-group post to the id we stored", async () => {
    const t = await started();
    await t.driver.listGroups();
    const post = await t.driver.sendText(GROUP, "bench offer");
    const stored = waMessageIdFrom(post);
    const got: Array<{ msgId?: { _serialized: string } }> = [];
    t.driver.onReaction((r) => void got.push(r as never));
    const id = stored!.split("_")[2];
    t.sock().emit("messages.reaction", [
      {
        key: { remoteJid: GROUP, fromMe: true, id, participant: "158055467598020@lid" },
        reaction: { text: "👍", key: { remoteJid: GROUP, fromMe: false, id: "R1", participant: "158055467598020@lid" } },
      },
    ]);
    await tick();
    await tick();
    expect(got[0]?.msgId?._serialized).toBe(stored);
  });
});

describe("onGroupJoin / onGroupLeave", () => {
  it("hands up a human join with phone-form recipients, and a leave likewise", async () => {
    const t = await started();
    const joins: GroupMembershipEvent[] = [];
    const leaves: GroupMembershipEvent[] = [];
    t.driver.onGroupJoin((e) => void joins.push(e));
    t.driver.onGroupLeave((e) => void leaves.push(e));
    t.sock().emit("group-participants.update", {
      id: GROUP,
      author: "158055467598021@lid",
      authorPn: "447700900124@s.whatsapp.net",
      action: "add",
      participants: [{ id: "158012121212121@lid", phoneNumber: "447700900777@s.whatsapp.net" }],
    });
    t.sock().emit("group-participants.update", {
      id: GROUP,
      author: "",
      action: "remove",
      participants: [{ id: "447700900555@s.whatsapp.net" }],
    });
    await tick();
    await tick();
    expect(joins).toEqual([
      { chatId: GROUP, recipientIds: ["447700900777@c.us"], author: "447700900124@c.us" },
    ]);
    expect(leaves).toEqual([{ chatId: GROUP, recipientIds: ["447700900555@c.us"] }]);
  });

  it("stores the joiner's LID-to-phone pair as it arrives", async () => {
    const t = await started();
    t.driver.onGroupJoin(() => {});
    t.sock().emit("group-participants.update", {
      id: GROUP,
      author: "",
      action: "add",
      participants: [{ id: "158012121212121@lid", phoneNumber: "447700900777@s.whatsapp.net" }],
    });
    await tick();
    await tick();
    expect(phoneFromJid(await t.sock().realLidStore.getPNForLID("158012121212121@lid"))).toBe("447700900777");
  });

  it("detects the bot being added, under its LID, with bot-added.ts's own check", async () => {
    const t = await started();
    const joins: GroupMembershipEvent[] = [];
    t.driver.onGroupJoin((e) => void joins.push(e));
    t.sock().emit("group-participants.update", {
      id: OTHER,
      author: "158055467598020@lid",
      action: "add",
      participants: [{ id: ME_LID }],
    });
    await tick();
    await tick();
    expect(isSelfAdd(joins[0]?.recipientIds ?? [], await t.driver.selfIds())).toBe(true);
  });

  it("turns groups.upsert (a group created with the bot in it) into one self-add", async () => {
    const t = await started();
    const joins: GroupMembershipEvent[] = [];
    t.driver.onGroupJoin((e) => void joins.push(e));
    const created = { ...sutton(), id: "120363000000000777@g.us", author: "158055467598020@lid", authorPn: "447700900123@s.whatsapp.net" };
    t.sock().emit("groups.upsert", [created]);
    // Baileys may also report the add; one self-add is enough.
    t.sock().emit("group-participants.update", {
      id: created.id,
      author: "158055467598020@lid",
      action: "add",
      participants: [{ id: ME_LID, phoneNumber: ME_PN }],
    });
    await tick();
    await tick();
    expect(joins).toHaveLength(1);
    expect(joins[0]).toMatchObject({ chatId: created.id, author: "447700900123@c.us" });
    expect(isSelfAdd(joins[0].recipientIds ?? [], await t.driver.selfIds())).toBe(true);
  });

  it("ignores promotions and demotions", async () => {
    const t = await started();
    let n = 0;
    t.driver.onGroupJoin(() => void n++);
    t.driver.onGroupLeave(() => void n++);
    t.sock().emit("group-participants.update", { id: GROUP, author: "", action: "promote", participants: [{ id: ME_LID }] });
    await tick();
    expect(n).toBe(0);
  });
});

describe("groupSnapshot", () => {
  it("reads subject and members from groupMetadata, skipping the bot", async () => {
    const t = await started();
    const snap = await t.driver.groupSnapshot(GROUP, await t.driver.selfIds());
    expect(snap.source).toBe("groupMetadata");
    expect(snap.subject).toBe("Sutton FC");
    expect(snap.participants.map((p) => p.phone ?? p.lidId)).toEqual([
      "447700900123",
      "447700900124",
      "447700900555",
      "158099999999999@lid",
    ]);
  });

  it("is total: a failed read comes back as notes, not a throw", async () => {
    const t = await started();
    t.sock().groupError = new Error("forbidden");
    const snap = await t.driver.groupSnapshot(GROUP, []);
    expect(snap).toMatchObject({ source: "none", participants: [] });
    expect(snap.notes.join()).toMatch(/forbidden/);
  });
});

// ── Polls ───────────────────────────────────────────────────────────────

function vote(opts: {
  pollId: string;
  secret: Uint8Array;
  creator: string;
  voter: string;
  options: string[];
}): { encPayload: Uint8Array; encIv: Uint8Array } {
  const sign = Buffer.concat([
    Buffer.from(opts.pollId),
    Buffer.from(opts.creator),
    Buffer.from(opts.voter),
    Buffer.from("Poll Vote"),
    new Uint8Array([1]),
  ]);
  const key = hmacSign(sign, hmacSign(opts.secret, new Uint8Array(32), "sha256"), "sha256");
  const iv = randomBytes(12);
  const plain = proto.Message.PollVoteMessage.encode({
    selectedOptions: opts.options.map((o) => sha256(Buffer.from(o))),
  }).finish();
  return { encPayload: aesEncryptGCM(plain, key, iv, Buffer.from(`${opts.pollId}\u0000${opts.voter}`)), encIv: iv };
}

function voteUpsert(pollId: string, enc: ReturnType<typeof vote>, id = "3EB0VOTE0001"): WAMessage {
  return {
    key: {
      remoteJid: GROUP,
      fromMe: false,
      id,
      participant: "158055467598020@lid",
      participantAlt: "447700900123@s.whatsapp.net",
    },
    message: proto.Message.fromObject({
      pollUpdateMessage: {
        pollCreationMessageKey: { remoteJid: GROUP, fromMe: true, id: pollId, participant: "158055467598020@lid" },
        vote: enc,
        senderTimestampMs: 1758100000000,
      },
    }),
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: "Sam",
  } as WAMessage;
}

async function sendMomPoll(driver: ReturnType<typeof setup>["driver"]) {
  const sent = (await driver.sendPoll(GROUP, "Man of the Match?", ["Sam", "Alex"], false)) as {
    key: { id: string };
    message: { message: proto.IMessage };
  };
  return {
    storedId: waMessageIdFrom(sent)!,
    pollId: sent.key.id,
    secret: sent.message.message.messageContextInfo!.messageSecret as Uint8Array,
  };
}

describe("onPollVote", () => {
  it("decrypts a vote on our poll and hands it up in the shape index.ts reads", async () => {
    const t = await started();
    await t.driver.listGroups();
    const votes: InboundPollVote[] = [];
    t.driver.onPollVote((v) => void votes.push(v));
    const poll = await sendMomPoll(t.driver);
    t.sock().emit("messages.upsert", {
      type: "notify",
      messages: [voteUpsert(poll.pollId, vote({ ...poll, creator: ME_PN, voter: "447700900123@s.whatsapp.net", options: ["Alex"] }))],
    });
    await tick();
    await tick();
    expect(votes).toEqual([
      {
        parentMessage: { id: { _serialized: poll.storedId } },
        voter: "447700900123@c.us",
        selectedOptions: [{ name: "Alex", localId: 1 }],
      },
    ]);
    // A vote is not a chat message: it never reaches the analyzer.
    expect(t.driver.stats().pollVotesForwarded).toBe(1);
  });

  it("still decrypts after a RESTART, from the poll archive on disk", async () => {
    const io = memoryIO();
    const first = await started({ pollIO: io });
    await first.driver.listGroups();
    const poll = await sendMomPoll(first.driver);

    const second = await started({ pollIO: io });
    await second.driver.listGroups();
    const votes: InboundPollVote[] = [];
    second.driver.onPollVote((v) => void votes.push(v));
    second.sock().emit("messages.upsert", {
      type: "notify",
      messages: [voteUpsert(poll.pollId, vote({ ...poll, creator: ME_LID, voter: "158055467598020@lid", options: ["Sam"] }))],
    });
    await tick();
    await tick();
    expect(votes[0]?.parentMessage?.id?._serialized).toBe(poll.storedId);
    expect(votes[0]?.selectedOptions).toEqual([{ name: "Sam", localId: 0 }]);
    // And getMessage can hand it back for a retry receipt.
    expect((await second.driver.getMessage({ id: poll.pollId }))?.messageContextInfo?.messageSecret).toBeTruthy();
  });

  it("logs a CRITICAL line and counts a vote on a poll it cannot decrypt", async () => {
    const t = await started();
    const votes: InboundPollVote[] = [];
    t.driver.onPollVote((v) => void votes.push(v));
    t.sock().emit("messages.upsert", {
      type: "notify",
      messages: [
        voteUpsert(
          "3EB0WWEBJSPOLL",
          vote({ pollId: "3EB0WWEBJSPOLL", secret: randomBytes(32), creator: ME_PN, voter: "447700900123@s.whatsapp.net", options: ["Sam"] }),
        ),
      ],
    });
    await tick();
    await tick();
    expect(votes).toEqual([]);
    expect(t.driver.stats().pollVotesUndecryptable).toBe(1);
    expect(t.errors.join("\n")).toMatch(/CRITICAL: \[baileys\]\[poll\].*3EB0WWEBJSPOLL/);
  });

  it("hands a vote up once, however many times Baileys delivers it", async () => {
    const t = await started();
    await t.driver.listGroups();
    const votes: InboundPollVote[] = [];
    t.driver.onPollVote((v) => void votes.push(v));
    const poll = await sendMomPoll(t.driver);
    const m = voteUpsert(poll.pollId, vote({ ...poll, creator: ME_PN, voter: "447700900123@s.whatsapp.net", options: ["Alex"] }));
    t.sock().emit("messages.upsert", { type: "notify", messages: [m] });
    t.sock().emit("messages.upsert", { type: "notify", messages: [structuredClone(m)] });
    await tick();
    await tick();
    expect(votes).toHaveLength(1);
  });
});
