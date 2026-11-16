/**
 * A DELETED MESSAGE LEAVES THE PI'S OWN COPIES TOO (2026-11-15).
 *
 * A group message waits up to ten minutes in the Pi's batch before the
 * server stores it, and the last fifteen lines ride along with every
 * analyze POST as recent chat. A message deleted in that window would
 * still have been posted, stored and shown to the model. So a delete takes
 * it out of the batch and the recent chat, an edit puts the new words
 * there instead, and a late copy (a replay, a requeue) of a deleted
 * message is not let back in. Nothing here posts anything but the batch
 * the timer would have posted anyway. Simulated numbers, made-up people.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InboundMessage } from "./driver.js";
import { makeWwebjsDriver, type WwebjsClientLike } from "./drivers/wwebjs.js";

const postAnalyzeFull = vi.fn();
vi.mock("./api.js", () => ({
  postAnalyzeFull: (...args: unknown[]) => postAnalyzeFull(...args),
}));

const { enqueueForAnalysis, recordHistory, applyMessageChangeLocally, whenFlushIdle, _test_flushNow, _test_reset } = await import(
  "./smart-analysis.js"
);

const GROUP = "120363000000009300@g.us";
const SAM = "447700900123";
const ALI = "447700900456";
const BOT_WID = "447700900999@c.us";

const driver = makeWwebjsDriver({
  info: { wid: { _serialized: BOT_WID } },
  getContactById: async () => ({ pushname: "", isMe: false }),
  getChatById: async () => ({ sendMessage: vi.fn(async () => ({})) }),
  sendMessage: vi.fn(async () => ({ id: { _serialized: "sent" } })),
} as unknown as WwebjsClientLike);

let seq = 0;
function message(bare: string, body: string, phone = SAM, name = "Sam") {
  seq += 1;
  const m = {
    from: GROUP,
    author: `${phone}@c.us`,
    body,
    timestamp: 1_763_200_000 + seq,
    id: { _serialized: `false_${GROUP}_${bare}_${phone}@c.us` },
    mentionedIds: [],
    _data: { body, notifyName: name },
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

const posted = (call = 0) => postAnalyzeFull.mock.calls[call][0] as { messages: Array<{ body: string; waMessageId: string }>; history: Array<Record<string, unknown>> };

const SECRET = "my door code is 4321";
const del = (messageId: string) => ({ kind: "revoke" as const, groupId: GROUP, messageId, senderJids: [`${SAM}@c.us`], senderPhone: SAM });
const edit = (messageId: string, text: string, phone = SAM) => ({ kind: "edit" as const, groupId: GROUP, messageId, text, senderJids: [`${phone}@c.us`], senderPhone: phone });

beforeEach(() => {
  postAnalyzeFull.mockReset();
  postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });
  _test_reset();
});

describe("a delete while the message waits in the batch", () => {
  it("the batch and the recent chat lose it; the other lines are untouched", async () => {
    await arrive(message("SAMMSG000001", SECRET));
    await arrive(message("ALIMSG000001", "see you at 8", ALI, "Ali"));
    expect(applyMessageChangeLocally(del("SAMMSG000001"))).toEqual({ buffered: 1, history: 1 });
    await _test_flushNow(GROUP);
    expect(posted().messages.map((m) => m.body)).toEqual(["see you at 8"]);
    expect(posted().history.map((h) => h.body)).toEqual(["see you at 8"]);
    expect(JSON.stringify(postAnalyzeFull.mock.calls)).not.toContain("4321");
  });

  it("the recent chat never carries the Pi's id field to the server", async () => {
    await arrive(message("ALIMSG000002", "see you at 8", ALI, "Ali"));
    await _test_flushNow(GROUP);
    expect(Object.keys(posted().history[0]).sort()).toEqual(["authorName", "body", "timestamp"]);
  });

  it("a late copy of the deleted message (a replay after a reconnect) is not let back in", async () => {
    applyMessageChangeLocally(del("SAMMSG000003"));
    await arrive(message("SAMMSG000003", SECRET));
    await arrive(message("ALIMSG000003", "see you at 8", ALI, "Ali"));
    await _test_flushNow(GROUP);
    expect(JSON.stringify(postAnalyzeFull.mock.calls)).not.toContain("4321");
    expect(posted().messages).toHaveLength(1);
  });

  it("a delete during a flush that then fails: the requeued batch has lost it", async () => {
    await arrive(message("SAMMSG000004", SECRET));
    await arrive(message("ALIMSG000004", "see you at 8", ALI, "Ali"));
    let fail!: (e: Error) => void;
    postAnalyzeFull.mockImplementationOnce(() => new Promise((_r, rej) => (fail = rej)));
    const running = _test_flushNow(GROUP);
    await vi.waitFor(() => expect(postAnalyzeFull).toHaveBeenCalledTimes(1));
    applyMessageChangeLocally(del("SAMMSG000004"));
    fail(new Error("504"));
    await running;
    await _test_flushNow(GROUP);
    expect(posted(1).messages.map((m) => m.body)).toEqual(["see you at 8"]);
    expect(JSON.stringify(posted(1))).not.toContain("4321");
  });
});

describe("an edit while the message waits in the batch", () => {
  it("by its author: the batch and the recent chat carry the new words, read once", async () => {
    await arrive(message("SAMMSG000010", SECRET));
    expect(applyMessageChangeLocally(edit("SAMMSG000010", "running 10 mins late"))).toEqual({ buffered: 1, history: 1 });
    await _test_flushNow(GROUP);
    expect(postAnalyzeFull).toHaveBeenCalledTimes(1);
    expect(posted().messages.map((m) => m.body)).toEqual(["running 10 mins late"]);
    expect(posted().history.map((h) => h.body)).toEqual(["running 10 mins late"]);
  });

  it("by someone else: never their words, and the original goes", async () => {
    await arrive(message("SAMMSG000011", SECRET));
    applyMessageChangeLocally(edit("SAMMSG000011", "I owe everyone £50", ALI));
    await _test_flushNow(GROUP);
    expect(postAnalyzeFull).not.toHaveBeenCalled();
    expect(JSON.stringify(postAnalyzeFull.mock.calls)).not.toContain("£50");
  });

  it("a late copy of an edited message carries the edited words", async () => {
    applyMessageChangeLocally(edit("SAMMSG000012", "running 10 mins late"));
    await arrive(message("SAMMSG000012", SECRET));
    await _test_flushNow(GROUP);
    expect(posted().messages.map((m) => m.body)).toEqual(["running 10 mins late"]);
    expect(JSON.stringify(posted())).not.toContain("4321");
  });

  it("a change to a message the Pi no longer holds changes nothing here", async () => {
    expect(applyMessageChangeLocally(del("NOTHELD00001"))).toEqual({ buffered: 0, history: 0 });
  });
});

describe("whenFlushIdle", () => {
  it("resolves at once when nothing is running", async () => {
    await expect(whenFlushIdle(GROUP, { pollMs: 5, timeoutMs: 50 })).resolves.toBe(true);
  });

  it("waits for the running flush of that group to end", async () => {
    await arrive(message("SAMMSG000020", "in"));
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
    await arrive(message("SAMMSG000021", "in"));
    postAnalyzeFull.mockImplementationOnce(() => new Promise(() => {}));
    void _test_flushNow(GROUP);
    await vi.waitFor(() => expect(postAnalyzeFull).toHaveBeenCalledTimes(1));
    await expect(whenFlushIdle(GROUP, { pollMs: 5, timeoutMs: 40 })).resolves.toBe(false);
  });
});
