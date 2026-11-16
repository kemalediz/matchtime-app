/**
 * EDIT OR DELETE A MESSAGE, AND THE PI FORGETS IT TOO (2026-11-15, round 3).
 *
 * A group message waits up to ten minutes in the Pi's batch, and the last
 * fifteen lines ride along with every analyze POST as recent chat. So:
 *
 *   - a delete (by the author, or a group admin; nobody else) or an edit
 *     (by the author only; an edit is a purge, never a replacement) takes
 *     the message out of the batch and the recent chat, and the quote out
 *     of every reply to it, waiting or still to come. A quote is stripped
 *     only when the change came from the QUOTED message's author (matched
 *     by the quote's participant id) or an admin: a forged delete changes
 *     nothing;
 *   - a late copy (a replay, a requeue, a restart that read the record
 *     back) is held to the record;
 *   - a delete that lands while the batch is being analysed stops only the
 *     REACTION on that message: the reply (which may carry the batch's
 *     squad post for everyone) still goes out, and nothing is released;
 *   - an HQ forward is held to the record too (`adjustForServer`).
 *
 * This file drives the old whatsapp-web.js driver for the batch itself;
 * `smart-analysis.baileys-change.test.ts` drives the Baileys driver.
 * Simulated numbers, made-up people.
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
const { enqueueForAnalysis, recordHistory, applyMessageChangeLocally, replacePendingWithEdit, restoreMessageChanges, adjustForServer, isDeletedLocally, isRevokedLocally, whenFlushIdle, _test_flushNow, _test_reset } = sa;

const GROUP = "120363000000009300@g.us";
const SAM = "447700900123";
const SAM_LID = "158055467598020@lid";
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
function message(bare: string, body: string, phone = SAM, name = "Sam", quote?: { id: string; text: string; participant?: string }) {
  seq += 1;
  const m = {
    from: GROUP,
    author: `${phone}@c.us`,
    body,
    timestamp: 1_763_200_000 + seq,
    id: { _serialized: `false_${GROUP}_${bare}_${phone}@c.us` },
    mentionedIds: [],
    _data: {
      body,
      notifyName: name,
      ...(quote ? { quotedStanzaID: quote.id, ...(quote.participant ? { quotedParticipant: quote.participant } : {}), quotedMsg: { body: quote.text } } : {}),
    },
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

type Posted = { messages: Array<{ body: string; waMessageId: string; quotedBody?: string; quotedMessageId?: string; quotedAuthorJid?: string; mentions?: string[]; mentionNames?: unknown[]; botMentioned?: boolean }>; history: Array<Record<string, unknown>> };
const posted = (call = 0) => postAnalyzeFull.mock.calls[call][0] as Posted;

const SECRET = "my door code is 4321";
const by = (who: string, byAdmin = false) => ({ senderJids: [who.includes("@") ? who : `${who}@c.us`], senderPhone: who.includes("@") ? null : who, byAdmin });
const del = (messageId: string, who = by(SAM)): LocalMessageChange => ({ kind: "revoke", groupId: GROUP, messageId, ...who });
const edit = (messageId: string, who = by(SAM)): LocalMessageChange => ({ kind: "edit", groupId: GROUP, messageId, ...who, byAdmin: false });

beforeEach(() => {
  postAnalyzeFull.mockReset();
  postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });
  releaseInstruction.mockClear();
  ackInstruction.mockClear();
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

  it("a late copy (a replay) is not let back in, nor after a restart that read the record back", async () => {
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

  it("the recent chat never carries the Pi's id field to the server", async () => {
    await arrive(message("ALIMSG000006", "see you at 8", ALI, "Ali"));
    await _test_flushNow(GROUP);
    expect(Object.keys(posted().history[0]).sort()).toEqual(["authorName", "body", "timestamp"]);
  });
});

describe("a quote of a deleted message: stripped only when the quoted message's author or an admin deleted it", () => {
  it("by its author, matched by the quote's participant id: a reply waiting in the batch keeps its id and loses the words", async () => {
    await arrive(message("SAMMSG000004", SECRET));
    await arrive(message("ALIMSG000004", "@Match Time is that right?", ALI, "Ali", { id: "SAMMSG000004", text: SECRET, participant: `${SAM}@c.us` }));
    expect(applyMessageChangeLocally(del("SAMMSG000004"))).toMatchObject({ buffered: 1, quotes: 1 });
    await _test_flushNow(GROUP);
    expect(posted().messages[0]).toMatchObject({ quotedMessageId: "SAMMSG000004", quotedAuthorJid: `${SAM}@c.us` });
    expect(posted().messages[0].quotedBody).toBeUndefined();
    expect(JSON.stringify(postAnalyzeFull.mock.calls)).not.toContain("4321");
  });

  it("by its author known only by LID (no phone anywhere): a reply arriving AFTER the delete loses the words too", async () => {
    applyMessageChangeLocally(del("SAMMSG000005", by(SAM_LID)));
    await arrive(message("ALIMSG000005", "@Match Time what?", ALI, "Ali", { id: "SAMMSG000005", text: SECRET, participant: SAM_LID }));
    await _test_flushNow(GROUP);
    expect(posted().messages[0].quotedBody).toBeUndefined();
  });

  it("a FORGED delete (neither the author nor an admin) changes nothing: the message and every quote of it stay", async () => {
    await arrive(message("SAMMSG000010", SECRET));
    await arrive(message("ALIMSG000010", "@Match Time right?", ALI, "Ali", { id: "SAMMSG000010", text: SECRET, participant: `${SAM}@c.us` }));
    expect(applyMessageChangeLocally(del("SAMMSG000010", by(ALI)))).toEqual({ buffered: 0, history: 0, quotes: 0 });
    await _test_flushNow(GROUP);
    expect(posted().messages.map((m) => m.body)).toEqual([SECRET, "@Match Time right?"]);
    expect(posted().messages[1].quotedBody).toBe(SECRET);
  });

  it("a quote whose author is unknown: kept for a non-admin's delete, stripped for an admin's", async () => {
    applyMessageChangeLocally(del("SAMMSG000011", by(ALI)));
    applyMessageChangeLocally(del("SAMMSG000012", by(ADMIN, true)));
    await arrive(message("PETEMSG00011", "@Match Time a?", ALI, "Ali", { id: "SAMMSG000011", text: "kept words" }));
    await arrive(message("PETEMSG00012", "@Match Time b?", ALI, "Ali", { id: "SAMMSG000012", text: SECRET }));
    await _test_flushNow(GROUP);
    expect(posted().messages.map((m) => m.quotedBody)).toEqual(["kept words", undefined]);
  });
});

describe("an author's edit of a message STILL WAITING in the batch replaces it (round 4)", () => {
  const read = (text: string, extra: Record<string, unknown> = {}) => ({ text, botMentioned: false, ...extra });

  it("'Inn' fixed to 'In': the batch and the recent chat carry 'In', read once; the original words never leave the Pi", async () => {
    await arrive(message("SAMMSG000020", "Inn"));
    expect(replacePendingWithEdit(edit("SAMMSG000020"), read("In"))).toBe(true);
    await _test_flushNow(GROUP);
    expect(postAnalyzeFull).toHaveBeenCalledTimes(1);
    expect(posted().messages.map((m) => m.body)).toEqual(["In"]);
    expect(posted().history.map((h) => h.body)).toEqual(["In"]);
    expect(JSON.stringify(postAnalyzeFull.mock.calls)).not.toContain("Inn");
  });

  it("the mentions, names and tag are the edited content's", async () => {
    await arrive(message("SAMMSG000021", "out"));
    replacePendingWithEdit(edit("SAMMSG000021"), read("@Match Time out, ask @447700900456", { botMentioned: true, mentions: [BOT_WID, `${ALI}@c.us`], mentionNames: [{ jid: `${ALI}@c.us`, name: "Ali" }] }));
    await _test_flushNow(GROUP);
    expect(posted().messages[0]).toMatchObject({ body: "@Match Time out, ask @447700900456", botMentioned: true, mentions: [BOT_WID, `${ALI}@c.us`], mentionNames: [{ jid: `${ALI}@c.us`, name: "Ali" }] });
  });

  it("a later copy of the original (a replay) carries the edited content too, and is never shown with the original words", async () => {
    await arrive(message("SAMMSG000022", "Inn"));
    replacePendingWithEdit(edit("SAMMSG000022"), read("In"));
    await arrive(message("SAMMSG000022", "Inn")); // the replay
    await _test_flushNow(GROUP);
    expect(JSON.stringify(postAnalyzeFull.mock.calls)).not.toContain("Inn");
  });

  it("by anyone else, a group admin included: nothing replaced, nothing purged", async () => {
    await arrive(message("SAMMSG000023", SECRET));
    expect(replacePendingWithEdit(edit("SAMMSG000023", by(ALI)), read("I owe everyone £50"))).toBe(false);
    expect(applyMessageChangeLocally(edit("SAMMSG000023", by(ADMIN, true)))).toEqual({ buffered: 0, history: 0, quotes: 0 });
    await _test_flushNow(GROUP);
    expect(posted().messages.map((m) => m.body)).toEqual([SECRET]);
  });

  it("nothing waiting (already sent): no replacement; the edit is then a purge of every later copy", async () => {
    expect(replacePendingWithEdit(edit("SAMMSG000024"), read("In"))).toBe(false);
    applyMessageChangeLocally(edit("SAMMSG000024"));
    await arrive(message("SAMMSG000024", SECRET));
    await _test_flushNow(GROUP);
    expect(postAnalyzeFull).not.toHaveBeenCalled();
  });

  it("an edit during a flush that then fails is a purge: the requeued batch has lost it", async () => {
    await arrive(message("SAMMSG000025", SECRET));
    await arrive(message("ALIMSG000025", "see you at 8", ALI, "Ali"));
    let fail!: (e: Error) => void;
    postAnalyzeFull.mockImplementationOnce(() => new Promise((_r, rej) => (fail = rej)));
    const running = _test_flushNow(GROUP);
    await vi.waitFor(() => expect(postAnalyzeFull).toHaveBeenCalledTimes(1));
    expect(replacePendingWithEdit(edit("SAMMSG000025"), read("new"))).toBe(false); // in flight, not waiting
    applyMessageChangeLocally(edit("SAMMSG000025"));
    fail(new Error("504"));
    await running;
    await _test_flushNow(GROUP);
    expect(posted(1).messages.map((m) => m.body)).toEqual(["see you at 8"]);
  });

  it("an edit, then a delete, or the other way round: gone either way", async () => {
    applyMessageChangeLocally(del("SAMMSG000026"));
    applyMessageChangeLocally(edit("SAMMSG000026"));
    applyMessageChangeLocally(edit("SAMMSG000027"));
    applyMessageChangeLocally(del("SAMMSG000027"));
    await arrive(message("SAMMSG000026", SECRET));
    await arrive(message("SAMMSG000027", SECRET));
    await _test_flushNow(GROUP);
    expect(postAnalyzeFull).not.toHaveBeenCalled();
  });
});

describe("a quote whose author the reply does not name", () => {
  it("is tied to its author through the Pi's own copies (their ids carry the participant): the author's delete strips it, a forged one does not", async () => {
    await arrive(message("SAMMSG000028", SECRET));
    await arrive(message("ALIMSG000028", "@Match Time right?", ALI, "Ali", { id: "SAMMSG000028", text: SECRET }));
    applyMessageChangeLocally(del("SAMMSG000028", by(ALI))); // forged
    await _test_flushNow(GROUP);
    expect(posted(0).messages.find((m) => m.quotedMessageId)?.quotedBody).toBe(SECRET);
  });

  it("the author's own delete strips it", async () => {
    recordHistory(GROUP, { authorName: "Sam", body: SECRET, timestamp: new Date(1_763_200_000_000).toISOString() }, `false_${GROUP}_SAMMSG000029_${SAM}@c.us`);
    applyMessageChangeLocally(del("SAMMSG000029"));
    await arrive(message("ALIMSG000029", "@Match Time right?", ALI, "Ali", { id: "SAMMSG000029", text: SECRET }));
    await _test_flushNow(GROUP);
    expect(posted().messages[0].quotedBody).toBeUndefined();
  });
});

describe("a delete while the batch is being analysed (the reviewers' case)", () => {
  it("Ali IN, Sam IN, Sam deletes: no reaction on Sam's message, but the reply carrying the squad post still goes out, and nothing is released", async () => {
    const react = vi.spyOn(driver, "sendReaction").mockResolvedValue({ ok: true } as never);
    const send = vi.spyOn(driver, "sendText").mockResolvedValue({ id: { _serialized: "sent" } } as never);
    try {
      await arrive(message("ALIMSG000030", "in", ALI, "Ali"));
      await arrive(message("SAMMSG000030", "in", SAM, "Sam"));
      let answer!: (v: unknown) => void;
      postAnalyzeFull.mockImplementationOnce(() => new Promise((r) => (answer = r)));
      const running = _test_flushNow(GROUP);
      await vi.waitFor(() => expect(postAnalyzeFull).toHaveBeenCalledTimes(1));
      const [aliId, samId] = posted().messages.map((m) => m.waMessageId);
      applyMessageChangeLocally(del("SAMMSG000030"));
      const SQUAD = "📋 Playing (2/14): Ali, Sam";
      answer({
        results: [
          { waMessageId: aliId, handledBy: "engine", intent: "in", react: "✅", reply: null },
          // The batch's squad post rides on the last message that speaks: Sam's.
          { waMessageId: samId, handledBy: "engine", intent: "in", react: "✅", reply: SQUAD, replyKey: "greply:org:1" },
        ],
        nextKickoffMs: null,
      });
      await running;
      expect(react.mock.calls.map((c) => c[0])).toEqual([expect.stringContaining("ALIMSG000030")]);
      expect(send).toHaveBeenCalledWith(GROUP, SQUAD);
      expect(releaseInstruction).not.toHaveBeenCalled();
      expect(ackInstruction).toHaveBeenCalledWith(expect.objectContaining({ key: "greply:org:1" }));
      expect(isDeletedLocally(GROUP, samId, SAM)).toBe(true);
      expect(isDeletedLocally(GROUP, aliId, ALI)).toBe(false);
    } finally {
      react.mockRestore();
      send.mockRestore();
    }
  });
});

describe("an EDIT while the batch is being analysed keeps the tick", () => {
  it("Sam's IN is recorded and edited mid-analysis: the ✅ still lands (only a DELETE takes the reaction away)", async () => {
    const react = vi.spyOn(driver, "sendReaction").mockResolvedValue({ ok: true } as never);
    try {
      await arrive(message("SAMMSG000031", "in", SAM, "Sam"));
      let answer!: (v: unknown) => void;
      postAnalyzeFull.mockImplementationOnce(() => new Promise((r) => (answer = r)));
      const running = _test_flushNow(GROUP);
      await vi.waitFor(() => expect(postAnalyzeFull).toHaveBeenCalledTimes(1));
      const [samId] = posted().messages.map((m) => m.waMessageId);
      applyMessageChangeLocally(edit("SAMMSG000031"));
      answer({ results: [{ waMessageId: samId, handledBy: "engine", intent: "in", react: "✅", reply: null }], nextKickoffMs: null });
      await running;
      expect(react).toHaveBeenCalledTimes(1);
      expect(isDeletedLocally(GROUP, samId, SAM)).toBe(true);
      expect(isRevokedLocally(GROUP, samId, SAM)).toBe(false);
    } finally {
      react.mockRestore();
    }
  });
});

describe("an admin-group (HQ) forward is held to the record (adjustForServer)", () => {
  const hq = (over: Record<string, unknown> = {}) => ({
    groupId: GROUP,
    messageId: `false_${GROUP}_SAMHQ0000001_${SAM}@c.us`,
    text: SECRET,
    botMentioned: false,
    senderPhone: SAM,
    // Fixed: two calls must build the same forward.
    timestamp: "2026-11-15T18:00:00.000Z",
    ...over,
  });

  it("a deleted or author-edited message is not forwarded; another's edit changes nothing", () => {
    expect(adjustForServer(hq())).toEqual(hq());
    applyMessageChangeLocally(edit("SAMHQ0000001", by(ALI)));
    expect(adjustForServer(hq())).toEqual(hq());
    applyMessageChangeLocally(edit("SAMHQ0000001"));
    expect(adjustForServer(hq())).toBeNull();
  });

  it("a forward quoting a deleted message goes without the quoted words, when its author deleted it", () => {
    applyMessageChangeLocally(del("SAMHQ0000002"));
    const out = adjustForServer(hq({ messageId: `false_${GROUP}_ALIHQ0000002_${ALI}@c.us`, senderPhone: ALI, text: "@Match Time right?", quotedMessageId: "SAMHQ0000002", quotedText: SECRET, quotedAuthorJid: `${SAM}@c.us` }));
    expect(out).toMatchObject({ quotedMessageId: "SAMHQ0000002" });
    expect(out?.quotedText).toBeUndefined();
  });
});

describe("whenFlushIdle", () => {
  it("resolves at once when nothing is running", async () => {
    await expect(whenFlushIdle(GROUP, { pollMs: 5, timeoutMs: 50 })).resolves.toBe(true);
  });

  it("waits for the running flush of that group to end", async () => {
    await arrive(message("SAMMSG000040", "in"));
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
    await arrive(message("SAMMSG000041", "in"));
    postAnalyzeFull.mockImplementationOnce(() => new Promise(() => {}));
    void _test_flushNow(GROUP);
    await vi.waitFor(() => expect(postAnalyzeFull).toHaveBeenCalledTimes(1));
    await expect(whenFlushIdle(GROUP, { pollMs: 5, timeoutMs: 40 })).resolves.toBe(false);
  });
});
