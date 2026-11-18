/**
 * EDIT OR DELETE A MESSAGE, AND THE PI FORGETS IT TOO (2026-11-15, round 3).
 *
 * A group message waits up to ten minutes in the Pi's batch, and the last
 * fifteen lines ride along with every analyze POST as recent chat. So:
 *
 *   - a delete (by the author, or a group admin; nobody else) takes the
 *     message out of the batch and the recent chat; a delete or an
 *     author's edit takes the quote out of every reply to it, waiting or
 *     still to come. A quote is stripped only when the change came from
 *     the QUOTED message's author (matched by the quote's participant id)
 *     or an admin: a forged delete changes nothing;
 *   - an edit NEVER holds, drops or replaces the message: it is analysed
 *     once, as the Pi has it (the server forgets the stored words);
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
const { enqueueForAnalysis, recordHistory, applyMessageChangeLocally, restoreMessageChanges, adjustForServer, isRevokedLocally, isChangedLocally, _test_flushNow, _test_reset } = sa;

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

  it("each recent-chat line carries its message id, so the server can leave a changed one out (its safety net)", async () => {
    await arrive(message("ALIMSG000006", "see you at 8", ALI, "Ali"));
    await _test_flushNow(GROUP);
    expect(Object.keys(posted().history[0]).sort()).toEqual(["authorName", "body", "timestamp", "waMessageId"]);
    expect(posted().history[0].waMessageId).toBe(`false_${GROUP}_ALIMSG000006_${ALI}@c.us`);
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

describe("an author's edit never changes what is analysed (the rule after six review rounds)", () => {
  const ID = (bare: string, phone = SAM) => `false_${GROUP}_${bare}_${phone}@c.us`;

  it("a typo edit while waiting: 'Inn' is analysed ONCE, with the content the Pi has; the edit is recorded (for the server's purge)", async () => {
    await arrive(message("SAMMSG000020", "Inn"));
    expect(applyMessageChangeLocally(edit("SAMMSG000020"))).toEqual({ buffered: 0, history: 0, quotes: 0 });
    await _test_flushNow(GROUP);
    await _test_flushNow(GROUP);
    expect(postAnalyzeFull).toHaveBeenCalledTimes(1);
    expect(posted().messages.map((m) => m.body)).toEqual(["Inn"]);
    // The line goes as the Pi has it, with its id: the server leaves it out.
    expect(posted().history).toEqual([expect.objectContaining({ body: "Inn", waMessageId: ID("SAMMSG000020") })]);
    expect(isChangedLocally(GROUP, ID("SAMMSG000020"), SAM)).toBe(true);
    expect(isRevokedLocally(GROUP, ID("SAMMSG000020"), SAM)).toBe(false);
  });

  it("an edit during a flush that FAILS: the requeued copy is the same message, analysed on the retry", async () => {
    await arrive(message("SAMMSG000022", "Inn"));
    let fail!: (e: Error) => void;
    postAnalyzeFull.mockImplementationOnce(() => new Promise((_r, rej) => (fail = rej)));
    const running = _test_flushNow(GROUP);
    await vi.waitFor(() => expect(postAnalyzeFull).toHaveBeenCalledTimes(1));
    applyMessageChangeLocally(edit("SAMMSG000022"));
    fail(new Error("504"));
    await running;
    await _test_flushNow(GROUP);
    expect(postAnalyzeFull).toHaveBeenCalledTimes(2);
    expect(posted(1).messages.map((m) => m.body)).toEqual(["Inn"]);
  });

  it("an edit BEFORE its original, or restored after a restart: the original is still queued as it came (never dropped, never held)", async () => {
    applyMessageChangeLocally(edit("SAMMSG000023"));
    await arrive(message("SAMMSG000023", "Inn"));
    _test_reset(); // the process restarts
    restoreMessageChanges([edit("SAMMSG000024")]);
    await arrive(message("SAMMSG000024", "In tonight"));
    await _test_flushNow(GROUP);
    expect(posted().messages.map((m) => m.body)).toEqual(["In tonight"]);
  });

  it("an edit never adds or takes away the tag, and never flushes", async () => {
    await arrive(message("SAMMSG000028", "what time is kickoff?"));
    applyMessageChangeLocally(edit("SAMMSG000028"));
    expect(postAnalyzeFull).not.toHaveBeenCalled();
    await _test_flushNow(GROUP);
    expect(posted().messages[0]).toMatchObject({ body: "what time is kickoff?" });
    expect(posted().messages[0].botMentioned).not.toBe(true);
  });

  it("a quote of a message edited with NO words (an older record) is stripped (its author made the change: the original words must go)", async () => {
    await arrive(message("SAMMSG000029", SECRET));
    await arrive(message("ALIMSG000029", "@Match Time right?", ALI, "Ali", { id: "SAMMSG000029", text: SECRET, participant: `${SAM}@c.us` }));
    expect(applyMessageChangeLocally(edit("SAMMSG000029"))).toEqual({ buffered: 0, history: 0, quotes: 1 });
    await _test_flushNow(GROUP);
    const reply = posted().messages.find((m) => m.quotedMessageId);
    expect(reply?.quotedMessageId).toBe("SAMMSG000029");
    expect(reply?.quotedBody).toBeUndefined();
  });

  it("round 14: a quote of a message its author EDITED carries the edited words in place of the original, waiting in the batch or still to come; the latest edit wins", async () => {
    await arrive(message("SAMMSG000031", "Need 1 more tonight"));
    await arrive(message("ALIMSG000031", "me", ALI, "Ali", { id: "SAMMSG000031", text: "Need 1 more tonight", participant: `${SAM}@c.us` }));
    expect(applyMessageChangeLocally({ ...edit("SAMMSG000031"), text: "Need 3 more tonight", editedAt: 1000 })).toMatchObject({ quotes: 1 });
    applyMessageChangeLocally({ ...edit("SAMMSG000031"), text: "Need 2 more tonight", editedAt: 2000 });
    await arrive(message("PETMSG000031", "and me", "447700900777", "Pete", { id: "SAMMSG000031", text: "Need 1 more tonight", participant: `${SAM}@c.us` }));
    await _test_flushNow(GROUP);
    const replies = posted().messages.filter((m) => m.quotedMessageId === "SAMMSG000031");
    expect(replies.map((m) => m.quotedBody)).toEqual(["Need 2 more tonight", "Need 2 more tonight"]);
    // The message itself is analysed once, as it arrived (an edit never changes what is analysed);
    // nothing else shows its original words.
    expect(posted().messages.map((m) => m.body)).toEqual(["Need 1 more tonight", "me", "and me"]);
    expect(JSON.stringify(posted().history)).not.toContain("Need 1 more");
  });

  it("round 14: the recent chat shows an edited line with its edited words; a deleted one is gone", async () => {
    recordHistory(GROUP, { authorName: "Sam", body: "Need 1 more tonight", timestamp: new Date(Date.now() - 60_000).toISOString() }, ID("SAMMSG000032"));
    recordHistory(GROUP, { authorName: "Sam", body: SECRET, timestamp: new Date(Date.now() - 50_000).toISOString() }, ID("SAMMSG000033"));
    applyMessageChangeLocally({ ...edit("SAMMSG000032"), text: "Need 2 more tonight" });
    applyMessageChangeLocally(del("SAMMSG000033"));
    await arrive(message("ALIMSG000032", "@Match Time who is in?", ALI, "Ali"));
    await _test_flushNow(GROUP);
    const lines = JSON.stringify(posted().history);
    expect(lines).toContain("Need 2 more tonight");
    expect(lines).not.toContain("Need 1 more");
    expect(lines).not.toContain("4321");
  });

  it("an edit by anyone else, a group admin included: no quote stripped, nothing recorded against the author", async () => {
    await arrive(message("SAMMSG000030", SECRET));
    await arrive(message("ALIMSG000030", "@Match Time right?", ALI, "Ali", { id: "SAMMSG000030", text: SECRET, participant: `${SAM}@c.us` }));
    applyMessageChangeLocally(edit("SAMMSG000030", by(ALI)));
    applyMessageChangeLocally({ ...edit("SAMMSG000030", by(ADMIN)), byAdmin: true });
    await _test_flushNow(GROUP);
    expect(posted().messages.map((m) => m.body)).toEqual([SECRET, "@Match Time right?"]);
    expect(posted().messages[1].quotedBody).toBe(SECRET);
    expect(isChangedLocally(GROUP, ID("SAMMSG000030"), SAM)).toBe(false);
  });

  it("an edit, then a delete, or the other way round: the DELETE takes it out either way", async () => {
    applyMessageChangeLocally(del("SAMMSG000031"));
    applyMessageChangeLocally(edit("SAMMSG000031"));
    applyMessageChangeLocally(edit("SAMMSG000032"));
    applyMessageChangeLocally(del("SAMMSG000032"));
    await arrive(message("SAMMSG000031", SECRET));
    await arrive(message("SAMMSG000032", SECRET));
    await _test_flushNow(GROUP);
    expect(postAnalyzeFull).not.toHaveBeenCalled();
  });

  it("a FORGED delete never borrows the author's edit: in either order the message stays, and so does its tick", async () => {
    applyMessageChangeLocally(edit("SAMMSG000033"));
    applyMessageChangeLocally(del("SAMMSG000033", by(ALI)));
    applyMessageChangeLocally(del("SAMMSG000034", by(ALI)));
    applyMessageChangeLocally(edit("SAMMSG000034"));
    for (const bare of ["SAMMSG000033", "SAMMSG000034"]) {
      expect(isRevokedLocally(GROUP, ID(bare), SAM)).toBe(false);
      expect(isRevokedLocally(GROUP, ID(bare), SAM)).toBe(false);
    }
    await arrive(message("SAMMSG000033", "In"));
    await arrive(message("SAMMSG000034", "In too"));
    await _test_flushNow(GROUP);
    expect(posted().messages.map((m) => m.body)).toEqual(["In", "In too"]);
  });
});

describe("the Pi's change record: its lifetime and its order", () => {
  it("outlives the replay buffer's two hours: a catch-up copy 90 minutes later is still left out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-15T18:00:00.000Z"));
      applyMessageChangeLocally(del("SAMMSG000056"));
      for (let i = 0; i < 1200; i++) applyMessageChangeLocally(del(`FILLER${String(i).padStart(6, "0")}`));
      vi.setSystemTime(new Date("2026-11-15T19:30:00.000Z"));
      await arrive(message("SAMMSG000056", SECRET));
    } finally {
      vi.useRealTimers();
    }
    await _test_flushNow(GROUP);
    expect(postAnalyzeFull).not.toHaveBeenCalled();
  });

  it("is pruned oldest-by-LATEST-change first: a message changed again is not what keeps a stale one alive", () => {
    const ID = (bare: string) => `false_${GROUP}_${bare}_${SAM}@c.us`;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-15T10:00:00.000Z"));
      applyMessageChangeLocally(del("SAMMSG000060"));
      vi.setSystemTime(new Date("2026-11-15T11:00:00.000Z"));
      applyMessageChangeLocally(del("SAMMSG000061"));
      vi.setSystemTime(new Date("2026-11-15T12:30:00.000Z"));
      applyMessageChangeLocally(edit("SAMMSG000060")); // changed again: now the newest
      vi.setSystemTime(new Date("2026-11-15T14:30:00.000Z"));
      applyMessageChangeLocally(del("SAMMSG000062"));
      // 061 is 3.5 hours old: gone. 060's latest change is 2 hours old: kept.
      expect(isRevokedLocally(GROUP, ID("SAMMSG000061"), SAM)).toBe(false);
      expect(isRevokedLocally(GROUP, ID("SAMMSG000060"), SAM)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
      expect(isRevokedLocally(GROUP, samId, SAM)).toBe(true);
      expect(isRevokedLocally(GROUP, aliId, ALI)).toBe(false);
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
      expect(isChangedLocally(GROUP, samId, SAM)).toBe(true);
      expect(isRevokedLocally(GROUP, samId, SAM)).toBe(false);
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

  it("a deleted message is not forwarded; an edited one (by its author or anyone) goes exactly as read", () => {
    expect(adjustForServer(hq())).toEqual(hq());
    applyMessageChangeLocally(edit("SAMHQ0000001", by(ALI)));
    expect(adjustForServer(hq())).toEqual(hq());
    applyMessageChangeLocally(edit("SAMHQ0000001"));
    expect(adjustForServer(hq())).toEqual(hq());
    applyMessageChangeLocally(del("SAMHQ0000001", by(ALI)));
    expect(adjustForServer(hq())).toEqual(hq());
    applyMessageChangeLocally(del("SAMHQ0000001"));
    expect(adjustForServer(hq())).toBeNull();
  });

  it("round 14: a forward quoting a message its author EDITED carries the edited words", () => {
    applyMessageChangeLocally({ ...edit("SAMHQ0000003"), text: "list, edited" });
    const out = adjustForServer(hq({ messageId: `false_${GROUP}_ALIHQ0000003_${ALI}@c.us`, senderPhone: ALI, text: "@Match Time make teams from the list above", quotedMessageId: "SAMHQ0000003", quotedText: "the old list", quotedAuthorJid: `${SAM}@c.us` }));
    expect(out).toMatchObject({ quotedMessageId: "SAMHQ0000003", quotedText: "list, edited" });
  });

  it("a forward quoting a deleted message goes without the quoted words, when its author deleted it", () => {
    applyMessageChangeLocally(del("SAMHQ0000002"));
    const out = adjustForServer(hq({ messageId: `false_${GROUP}_ALIHQ0000002_${ALI}@c.us`, senderPhone: ALI, text: "@Match Time right?", quotedMessageId: "SAMHQ0000002", quotedText: SECRET, quotedAuthorJid: `${SAM}@c.us` }));
    expect(out).toMatchObject({ quotedMessageId: "SAMHQ0000002" });
    expect(out?.quotedText).toBeUndefined();
  });
});

