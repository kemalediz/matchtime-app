/**
 * The bounded per-chat buffer the restart catch-up is served from.
 *
 * It runs on a Raspberry Pi that is never restarted for weeks, so the
 * tests that matter are the boring ones: it must not grow, per chat or in
 * the number of chats it is willing to remember.
 */
import { describe, it, expect } from "vitest";
import { createReplayBuffer } from "./replay.js";

const A = "120363000000000001@g.us";
const B = "120363000000000002@g.us";

function msg(n: number) {
  return { id: { _serialized: `m${n}` }, timestamp: 1_700_000_000 + n };
}

describe("createReplayBuffer", () => {
  it("hands back the newest first, which is the order the page used to", () => {
    const buf = createReplayBuffer();
    buf.remember(A, msg(1));
    buf.remember(A, msg(2));
    buf.remember(A, msg(3));
    expect(buf.recent(A, 10)).toEqual([msg(3), msg(2), msg(1)]);
  });

  it("honours the limit", () => {
    const buf = createReplayBuffer();
    for (let i = 1; i <= 5; i++) buf.remember(A, msg(i));
    expect(buf.recent(A, 2)).toEqual([msg(5), msg(4)]);
    expect(buf.recent(A, 0)).toEqual([]);
    expect(buf.recent(A, -1)).toEqual([]);
  });

  it("keeps chats apart", () => {
    const buf = createReplayBuffer();
    buf.remember(A, msg(1));
    buf.remember(B, msg(2));
    expect(buf.recent(A, 10)).toEqual([msg(1)]);
    expect(buf.recent(B, 10)).toEqual([msg(2)]);
    expect(buf.recent("120363000000000003@g.us", 10)).toEqual([]);
  });

  it("drops the oldest past the per-chat cap rather than growing", () => {
    const buf = createReplayBuffer({ perChat: 3 });
    for (let i = 1; i <= 6; i++) buf.remember(A, msg(i));
    expect(buf.count(A)).toBe(3);
    expect(buf.recent(A, 10)).toEqual([msg(6), msg(5), msg(4)]);
  });

  it("forgets the least recently used CHAT past the chat cap", () => {
    // A bot in many groups must not accumulate a buffer per group forever.
    const buf = createReplayBuffer({ perChat: 2, chats: 2 });
    buf.remember("g1@g.us", msg(1));
    buf.remember("g2@g.us", msg(2));
    buf.remember("g3@g.us", msg(3));
    expect(buf.chats()).toBe(2);
    expect(buf.recent("g1@g.us", 10)).toEqual([]);
    expect(buf.recent("g3@g.us", 10)).toEqual([msg(3)]);
  });

  it("counts what it has been given, in total, for the log line", () => {
    const buf = createReplayBuffer({ perChat: 2 });
    for (let i = 1; i <= 5; i++) buf.remember(A, msg(i));
    expect(buf.remembered()).toBe(5);
    expect(buf.count(A)).toBe(2);
  });

  it("ignores a missing chat id rather than opening a bucket called undefined", () => {
    const buf = createReplayBuffer();
    buf.remember("", msg(1));
    buf.remember(null as unknown as string, msg(2));
    expect(buf.chats()).toBe(0);
    expect(buf.remembered()).toBe(0);
  });
});
