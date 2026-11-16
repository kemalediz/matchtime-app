/**
 * A DELETED MESSAGE LEAVES THE PI'S OWN COPIES TOO (2026-11-15, round 2).
 *
 * A group message waits up to ten minutes in the Pi's batch, and the last
 * fifteen lines ride along with every analyze POST as recent chat. So:
 *
 *   - a delete (by the author, or a group admin; nobody else) takes the
 *     message out of the batch and the recent chat, and the quote out of
 *     every reply to it, waiting or still to come;
 *   - an edit by its author puts the new words, mentions and tag there; an
 *     edit by anyone else changes nothing;
 *   - a late copy (a replay, a requeue, a restart that read the record
 *     back) is held to the record;
 *   - a delete that lands while the batch is being analysed stops the react
 *     and the reply aimed at it, and the reply's claim is released;
 *   - an HQ forward is held to the record too (`adjustForServer`).
 *
 * This file drives the old whatsapp-web.js driver for the batch itself;
 * `smart-analysis.baileys-change.test.ts` drives the same through the
 * Baileys driver. Simulated numbers, made-up people.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InboundMessage } from "./driver.js";
import { makeWwebjsDriver, type WwebjsClientLike } from "./drivers/wwebjs.js";
import type { LocalMessageChange } from "./message-change.js";

const postAnalyzeFull = vi.fn();
const releaseInstruction = vi.fn(async () => {});
const ackInstruction = vi.fn(async () => {});
vi.mock("./api.js", () => ({
  postAnalyzeFull: (...args: unknown[]) => postAnalyzeFull(...args),
  releaseInstruction: (...args: unknown[]) => releaseInstruction(...(args as [])),
  ackInstruction: (...args: unknown[]) => ackInstruction(...(args as [])),
}));

const sa = await import("./smart-analysis.js");
const { enqueueForAnalysis, recordHistory, applyMessageChangeLocally, restoreMessageChanges, adjustForServer, isDeletedLocally, whenFlushIdle, _test_flushNow, _test_reset } = sa;

const GROUP = "120363000000009300@g.us";
const SAM = "447700900123";
const ALI = "447700900456";
const ADMIN = "447700900124";
const BOT_WID = "447700900999@c.us";

const driver = makeWwebjsDriver({
  info: { wid: { _serialized: BOT_WID } },
  getContactById: async () => ({ pushname: "", isMe: false }),
  getChatById: async () => ({ sendMessage: vi.fn(async () => ({})) }),
  sendMessage: vi.fn(async () => ({ id: { _serialized: "sent" } })),
} as unknown as WwebjsClientLike);

let seq = 0;
function message(bare: string, body: string, phone = SAM, name = "Sam", quote?: { id: string; text: string; phone: string }) {
  seq += 1;
  const m = {
    from: GROUP,
    author: `${phone}@c.us`,
    body,
    timestamp: 1_763_200_000 + seq,
    id: { _serialized: `false_${GROUP}_${bare}_${phone}@c.us` },
    mentionedIds: [],
    _data: { body, notifyName: name, ...(quote ? { quotedStanzaID: quote.id, quotedParticipant: `${quote.phone}@c.us`, quotedMsg: { body: quote.text } } : {}) },
    getContact: async () => ({ pushname: name, isMe: false }),
  };
  return m as unknown as InboundMessage;
}

/** As index.ts does: recent chat first, then the batch. */
async function arrive(m: InboundMessage) {
  const raw = m as unknown as { _data: { notifyName: string }; body: string; timestamp: number; id: { _serialized: string } };
  recordHistory(GROUP, { authorName: raw._data.notifyName, body: raw.body, timestamp: new Date(raw.timestamp * 1000).toISOString() }, raw.id._serialized);
  await enqueueForAnalysis(driver, m);
}

type Posted = { messages: Array<{ body: string; waMessageId: string; quotedBody?: string; quotedMessageId?: string; mentions?: string[]; mentionNames?: unknown[]; botMentioned?: boolean }>; history: Array<Record<string, unknown>> };
const posted = (call = 0) => postAnalyzeFull.mock.calls[call][0] as Posted;

const SECRET = "my door code is 4321";
const by = (phone: string, byAdmin = false) => ({ senderJids: [`${phone}@c.us`], senderPhone: phone, byAdmin });
const del = (messageId: string, who = by(SAM)): LocalMessageChange => ({ kind: "revoke", groupId: GROUP, messageId, ...who });
const edit = (messageId: string, text: string, phone = SAM, extra: Partial<LocalMessageChange> = {}): LocalMessageChange => ({ kind: "edit", groupId: GROUP, messageId, text, ...by(phone), ...extra });

beforeEach(() => {
  postAnalyzeFull.mockReset();
  postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });
  releaseInstruction.mockClear();
  _test_reset();
});

describe("a delete while the message waits in the batch", () => {
  it("by its author: the batch and the recent chat lose it; the other lines are untouched", async () => {
    await arrive(message("SAMMSG000001", SECRET));
    await arrive(message("ALIMSG000001", "see you at 8", ALI, "Ali"));
    expect(applyMessageChangeLocally(del("SAMMSG000001"))).toEqual({ buffered: 1, history: 1, quotes: 0 });
    await _test_flushNow(GROUP);
    expect(posted().messages.map((m) => m.body)).toEqual(["see you at 8"]);
    expect(posted().history.map((h) => h.body)).toEqual(["see you at 8"]);
    expect(JSON.stringify(postAnalyzeFull.mock.calls)).not.toContain("4321");
  });

  it("by a group admin: the same, for somebody else's message", async () => {
    await arrive(message("SAMMSG000002", SECRET));
    expect(applyMessageChangeLocally(del("SAMMSG000002", by(ADMIN, true)))).toMatchObject({ buffered: 1, history: 1 });
    await _test_flushNow(GROUP);
    expect(postAnalyzeFull).not.toHaveBeenCalled();
  });

  it("by anyone else: nothing changes", async () => {
    await arrive(message("SAMMSG000003", SECRET));
    expect(applyMessageChangeLocally(del("SAMMSG000003", by(ALI)))).toEqual({ buffered: 0, history: 0, quotes: 0 });
    await _test_flushNow(GROUP);
    expect(posted().messages.map((m) => m.body)).toEqual([SECRET]);
  });

  it("a reply waiting in the batch that QUOTES it keeps its id but loses the quoted words", async () => {
    await arrive(message("SAMMSG000004", SECRET));
    await arrive(message("ALIMSG000004", "@Match Time is that right?", ALI, "Ali", { id: "SAMMSG000004", text: SECRET, phone: SAM }));
    expect(applyMessageChangeLocally(del("SAMMSG000004"))).toMatchObject({ buffered: 1, quotes: 1 });
    await _test_flushNow(GROUP);
    expect(posted().messages).toHaveLength(1);
    expect(posted().messages[0]).toMatchObject({ quotedMessageId: "SAMMSG000004" });
    expect(posted().messages[0].quotedBody).toBeUndefined();
    expect(JSON.stringify(postAnalyzeFull.mock.calls)).not.toContain("4321");
  });

  it("a reply arriving AFTER the delete, quoting it, loses the quoted words too", async () => {
    applyMessageChangeLocally(del("SAMMSG000005"));
    await arrive(message("ALIMSG000005", "@Match Time what?", ALI, "Ali", { id: "SAMMSG000005", text: SECRET, phone: SAM }));
    await _test_flushNow(GROUP);
    expect(posted().messages[0].quotedBody).toBeUndefined();
    expect(JSON.stringify(postAnalyzeFull.mock.calls)).not.toContain("4321");
  });

  it("the recent chat never carries the Pi's id field to the server", async () => {
    await arrive(message("ALIMSG000006", "see you at 8", ALI, "Ali"));
    await _test_flushNow(GROUP);
    expect(Object.keys(posted().history[0]).sort()).toEqual(["authorName", "body", "timestamp"]);
  });

  it("a late copy of the deleted message (a replay) is not let back in, nor after a restart that read the record back", async () => {
    applyMessageChangeLocally(del("SAMMSG000007"));
    await arrive(message("SAMMSG000007", SECRET));
    _test_reset(); // the process restarts
    restoreMessageChanges([del("SAMMSG000008")]);
    await arrive(message("SAMMSG000008", SECRET));
    await arrive(message("ALIMSG000008", "see you at 8", ALI, "Ali"));
    await _test_flushNow(GROUP);
    expect(JSON.stringify(postAnalyzeFull.mock.calls)).not.toContain("4321");
    expect(posted().messages).toHaveLength(1);
  });

  it("a delete during a flush that then fails: the requeued batch has lost it", async () => {
    await arrive(message("SAMMSG000009", SECRET));
    await arrive(message("ALIMSG000009", "see you at 8", ALI, "Ali"));
    let fail!: (e: Error) => void;
    postAnalyzeFull.mockImplementationOnce(() => new Promise((_r, rej) => (fail = rej)));
    const running = _test_flushNow(GROUP);
    await vi.waitFor(() => expect(postAnalyzeFull).toHaveBeenCalledTimes(1));
    applyMessageChangeLocally(del("SAMMSG000009"));
    fail(new Error("504"));
    await running;
    await _test_flushNow(GROUP);
    expect(posted(1).messages.map((m) => m.body)).toEqual(["see you at 8"]);
  });
});

describe("a delete while the batch is being analysed", () => {
  it("MatchTime neither reacts nor replies to the deleted message, releases the reply's claim, and still answers the others", async () => {
    const react = vi.spyOn(driver, "sendReaction").mockResolvedValue({ ok: true } as never);
    const send = vi.spyOn(driver, "sendText").mockResolvedValue({ id: { _serialized: "sent" } } as never);
    try {
      await arrive(message("SAMMSG000010", SECRET));
      await arrive(message("ALIMSG000010", "in", ALI, "Ali"));
      let answer!: (v: unknown) => void;
      postAnalyzeFull.mockImplementationOnce(() => new Promise((r) => (answer = r)));
      const running = _test_flushNow(GROUP);
      await vi.waitFor(() => expect(postAnalyzeFull).toHaveBeenCalledTimes(1));
      const [samId, aliId] = posted().messages.map((m) => m.waMessageId);
      applyMessageChangeLocally(del("SAMMSG000010"));
      answer({
        results: [
          { waMessageId: samId, handledBy: "engine", intent: "question", react: "👍", reply: "About that door code...", replyKey: "greply:org:1" },
          { waMessageId: aliId, handledBy: "engine", intent: "in", react: "✅", reply: null },
        ],
        nextKickoffMs: null,
      });
      await running;
      expect(react.mock.calls.map((c) => c[1])).toEqual(["✅"]);
      expect(send).not.toHaveBeenCalled();
      expect(releaseInstruction).toHaveBeenCalledWith("greply:org:1");
      expect(isDeletedLocally(GROUP, samId, SAM)).toBe(true);
      expect(isDeletedLocally(GROUP, aliId, ALI)).toBe(false);
    } finally {
      react.mockRestore();
      send.mockRestore();
    }
  });
});

describe("an edit while the message waits in the batch", () => {
  it("by its author: the new words, mentions, names and tag, read once", async () => {
    await arrive(message("SAMMSG000020", SECRET));
    const change = edit("SAMMSG000020", "@Match Time ask @447700900456", SAM, {
      mentions: [BOT_WID, `${ALI}@c.us`],
      mentionNames: [{ jid: `${ALI}@c.us`, name: "Ali", phone: ALI }],
      botMentioned: true,
    });
    expect(applyMessageChangeLocally(change)).toEqual({ buffered: 1, history: 1, quotes: 0 });
    await _test_flushNow(GROUP);
    expect(postAnalyzeFull).toHaveBeenCalledTimes(1);
    expect(posted().messages[0]).toMatchObject({
      body: "@Match Time ask @447700900456",
      mentions: [BOT_WID, `${ALI}@c.us`],
      mentionNames: [{ jid: `${ALI}@c.us`, name: "Ali", phone: ALI }],
      botMentioned: true,
    });
    expect(posted().history.map((h) => h.body)).toEqual(["@Match Time ask @447700900456"]);
  });

  it("a reply quoting the edited message carries the new words", async () => {
    await arrive(message("SAMMSG000021", SECRET));
    await arrive(message("ALIMSG000021", "@Match Time right?", ALI, "Ali", { id: "SAMMSG000021", text: SECRET, phone: SAM }));
    expect(applyMessageChangeLocally(edit("SAMMSG000021", "running late"))).toMatchObject({ quotes: 1 });
    await _test_flushNow(GROUP);
    expect(posted().messages.find((m) => m.quotedMessageId)?.quotedBody).toBe("running late");
    expect(JSON.stringify(posted())).not.toContain("4321");
  });

  it("an edit that left no text (a caption removed) clears it", async () => {
    await arrive(message("SAMMSG000022", SECRET));
    applyMessageChangeLocally(edit("SAMMSG000022", ""));
    await _test_flushNow(GROUP);
    expect(posted().messages[0].body).toBe("");
    expect(posted().history.map((h) => h.body)).toEqual([""]);
  });

  it("by anyone else: ignored. The message is not dropped and nothing changes", async () => {
    await arrive(message("SAMMSG000023", SECRET));
    expect(applyMessageChangeLocally(edit("SAMMSG000023", "I owe everyone £50", ALI))).toEqual({ buffered: 0, history: 0, quotes: 0 });
    await _test_flushNow(GROUP);
    expect(posted().messages.map((m) => m.body)).toEqual([SECRET]);
    expect(JSON.stringify(posted())).not.toContain("£50");
  });

  it("an edit after its delete puts nothing back", async () => {
    applyMessageChangeLocally(del("SAMMSG000024"));
    applyMessageChangeLocally(edit("SAMMSG000024", "my door code is 4321, sorry"));
    await arrive(message("SAMMSG000024", SECRET));
    await _test_flushNow(GROUP);
    expect(postAnalyzeFull).not.toHaveBeenCalled();
  });
});

describe("an admin-group (HQ) forward is held to the record (adjustForServer)", () => {
  const hq = (over: Record<string, unknown> = {}) => ({
    groupId: GROUP,
    messageId: `false_${GROUP}_SAMHQ0000001_${SAM}@c.us`,
    text: SECRET,
    botMentioned: false,
    senderPhone: SAM,
    timestamp: new Date().toISOString(),
    ...over,
  });

  it("a deleted message is not forwarded; an edited one goes with its new words", () => {
    expect(adjustForServer(hq())).toEqual(hq());
    applyMessageChangeLocally(del("SAMHQ0000001"));
    expect(adjustForServer(hq())).toBeNull();
    _test_reset();
    applyMessageChangeLocally(edit("SAMHQ0000001", "running late", SAM, { mentions: [`${ALI}@c.us`], botMentioned: false }));
    expect(adjustForServer(hq())).toMatchObject({ text: "running late", mentions: [`${ALI}@c.us`] });
  });

  it("a forward quoting a deleted message goes without the quoted words", () => {
    applyMessageChangeLocally(del("SAMHQ0000002"));
    const out = adjustForServer(hq({ messageId: `false_${GROUP}_ALIHQ0000002_${ALI}@c.us`, senderPhone: ALI, text: "@Match Time right?", quotedMessageId: "SAMHQ0000002", quotedText: SECRET, quotedAuthorPhone: SAM }));
    expect(out).toMatchObject({ quotedMessageId: "SAMHQ0000002" });
    expect(out?.quotedText).toBeUndefined();
  });
});

describe("whenFlushIdle", () => {
  it("resolves at once when nothing is running", async () => {
    await expect(whenFlushIdle(GROUP, { pollMs: 5, timeoutMs: 50 })).resolves.toBe(true);
  });

  it("waits for the running flush of that group to end", async () => {
    await arrive(message("SAMMSG000030", "in"));
    let release!: () => void;
    postAnalyzeFull.mockImplementationOnce(() => new Promise((r) => (release = () => r({ results: [], nextKickoffMs: null }))));
    const running = _test_flushNow(GROUP);
    await vi.waitFor(() => expect(postAnalyzeFull).toHaveBeenCalledTimes(1));
    let idle = false;
    const waiting = whenFlushIdle(GROUP, { pollMs: 5, timeoutMs: 5000 }).then((v) => (idle = v));
    await new Promise((r) => setTimeout(r, 30));
    expect(idle).toBe(false);
    release();
    await running;
    await waiting;
    expect(idle).toBe(true);
  });

  it("gives up after its timeout, saying so", async () => {
    await arrive(message("SAMMSG000031", "in"));
    postAnalyzeFull.mockImplementationOnce(() => new Promise(() => {}));
    void _test_flushNow(GROUP);
    await vi.waitFor(() => expect(postAnalyzeFull).toHaveBeenCalledTimes(1));
    await expect(whenFlushIdle(GROUP, { pollMs: 5, timeoutMs: 40 })).resolves.toBe(false);
  });
});
