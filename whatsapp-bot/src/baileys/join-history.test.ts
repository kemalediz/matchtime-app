/**
 * The per-group store of history shared at a join: the gate (only a group
 * we were just added to), the bounds, and how long a reader waits.
 */
import { describe, it, expect } from "vitest";
import {
  JOIN_HISTORY_MAX_WAIT_MS,
  JOIN_HISTORY_QUIET_WAIT_MS,
  JOIN_HISTORY_WINDOW_MS,
  createJoinHistory,
} from "./join-history.js";

const GROUP = "120363000000000000@g.us";
const ESTABLISHED = "120363111111111111@g.us";

/** A clock and a sleep that only moves when the test says so. */
function harness(opts: { maxGroups?: number } = {}) {
  let clock = 1_000_000;
  const sleepers: Array<{ at: number; wake: () => void }> = [];
  const store = createJoinHistory<string[]>({ now: () => clock, maxGroups: opts.maxGroups });
  const sleep = (ms: number) =>
    new Promise<void>((wake) => {
      sleepers.push({ at: clock + ms, wake });
    });
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return {
    store,
    sleep,
    now: () => clock,
    /** Move the clock, waking every sleeper that is due, in order. */
    async advance(ms: number) {
      const target = clock + ms;
      for (;;) {
        await settle();
        const due = sleepers.filter((s) => s.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        sleepers.splice(sleepers.indexOf(due), 1);
        clock = Math.max(clock, due.at);
        due.wake();
      }
      clock = target;
      await settle();
    },
    settle,
  };
}

describe("the gate", () => {
  it("is closed for a group we were not just added to", () => {
    const { store } = harness();
    expect(store.joined(ESTABLISHED)).toBe(false);
    store.announce(ESTABLISHED);
    expect(store.begin(ESTABLISHED)).toBe(false);
    store.resolve(ESTABLISHED, ["x"]);
    expect(store.take(ESTABLISHED)).toBeNull();
  });

  it("opens only for a group, and closes when the window passes", async () => {
    const h = harness();
    expect(h.store.opened("447700900123@s.whatsapp.net")).toBe(false);
    expect(h.store.opened(GROUP)).toBe(true);
    expect(h.store.opened(GROUP)).toBe(false); // already open
    expect(h.store.joined(GROUP)).toBe(true);
    await h.advance(JOIN_HISTORY_WINDOW_MS);
    expect(h.store.joined(GROUP)).toBe(false);
    expect(h.store.begin(GROUP)).toBe(false);
  });

  it("forgets what it held when the window passes", async () => {
    const h = harness();
    h.store.opened(GROUP);
    h.store.begin(GROUP);
    h.store.resolve(GROUP, ["a"]);
    await h.advance(JOIN_HISTORY_WINDOW_MS);
    expect(h.store.take(GROUP)).toBeNull();
    h.store.sweep();
    expect(h.store.size()).toBe(0);
  });

  it("is bounded: a flood of joins does not grow it", () => {
    const h = harness({ maxGroups: 2 });
    expect(h.store.opened("1@g.us")).toBe(true);
    expect(h.store.opened("2@g.us")).toBe(true);
    expect(h.store.opened("3@g.us")).toBe(false);
    expect(h.store.joined("3@g.us")).toBe(false);
    expect(h.store.size()).toBe(2);
  });

  it("reads one bundle per join: a second is refused once the first is captured or read", () => {
    const { store } = harness();
    store.opened(GROUP);
    expect(store.begin(GROUP)).toBe(true);
    expect(store.begin(GROUP)).toBe(false); // one at a time
    store.resolve(GROUP, ["a"]);
    expect(store.begin(GROUP)).toBe(false);
    expect(store.take(GROUP)).toEqual(["a"]);
    expect(store.take(GROUP)).toBeNull(); // cleared when read
    expect(store.begin(GROUP)).toBe(false);
  });

  it("allows one more attempt after a failure, then no more", () => {
    const { store } = harness();
    store.opened(GROUP);
    expect(store.begin(GROUP)).toBe(true);
    store.fail(GROUP);
    expect(store.begin(GROUP)).toBe(true);
    store.fail(GROUP);
    expect(store.begin(GROUP)).toBe(false);
  });
});

describe("how long a reader waits", () => {
  it("answers at once when the history is already there", async () => {
    const h = harness();
    h.store.opened(GROUP);
    h.store.begin(GROUP);
    h.store.resolve(GROUP, ["a"]);
    await expect(h.store.wait(GROUP, { sleep: h.sleep })).resolves.toBe("captured");
  });

  it("answers at once for a group that was never opened", async () => {
    const h = harness();
    await expect(h.store.wait(ESTABLISHED, { sleep: h.sleep })).resolves.toBe("none");
  });

  it("gives up after the quiet wait when nothing was announced (the switch was off)", async () => {
    const h = harness();
    h.store.opened(GROUP);
    let out: string | null = null;
    void h.store.wait(GROUP, { sleep: h.sleep }).then((r) => (out = r));
    await h.advance(JOIN_HISTORY_QUIET_WAIT_MS - 1);
    expect(out).toBeNull();
    await h.advance(1);
    expect(out).toBe("none");
    expect(JOIN_HISTORY_QUIET_WAIT_MS).toBeLessThanOrEqual(8000);
  });

  it("waits the full time once a notice or bundle was seen, and no longer", async () => {
    const h = harness();
    h.store.opened(GROUP);
    h.store.announce(GROUP);
    h.store.begin(GROUP);
    let out: string | null = null;
    void h.store.wait(GROUP, { sleep: h.sleep }).then((r) => (out = r));
    await h.advance(JOIN_HISTORY_QUIET_WAIT_MS + 1000);
    expect(out).toBeNull();
    await h.advance(JOIN_HISTORY_MAX_WAIT_MS - JOIN_HISTORY_QUIET_WAIT_MS - 1000);
    expect(out).toBe("timeout");
    expect(JOIN_HISTORY_MAX_WAIT_MS).toBe(25_000);
  });

  it("extends the wait when the announcement comes during the quiet wait", async () => {
    const h = harness();
    h.store.opened(GROUP);
    let out: string | null = null;
    void h.store.wait(GROUP, { sleep: h.sleep }).then((r) => (out = r));
    await h.advance(3000);
    h.store.announce(GROUP);
    h.store.begin(GROUP);
    await h.advance(JOIN_HISTORY_QUIET_WAIT_MS);
    expect(out).toBeNull();
    h.store.resolve(GROUP, ["a", "b"]);
    await h.settle();
    expect(out).toBe("captured");
    expect(h.store.take(GROUP)).toEqual(["a", "b"]);
  });

  it("stops waiting the moment the read fails", async () => {
    const h = harness();
    h.store.opened(GROUP);
    h.store.announce(GROUP);
    h.store.begin(GROUP);
    let out: string | null = null;
    void h.store.wait(GROUP, { sleep: h.sleep }).then((r) => (out = r));
    await h.advance(2000);
    h.store.fail(GROUP);
    await h.settle();
    expect(out).toBe("failed");
  });

  it("with only a notice and no bundle, times out at the full wait", async () => {
    const h = harness();
    h.store.opened(GROUP);
    h.store.announce(GROUP);
    let out: string | null = null;
    void h.store.wait(GROUP, { sleep: h.sleep }).then((r) => (out = r));
    await h.advance(JOIN_HISTORY_MAX_WAIT_MS);
    expect(out).toBe("timeout");
  });

  it("cannot spin on a sleep that returns without the clock moving", async () => {
    const h = harness();
    h.store.opened(GROUP);
    h.store.announce(GROUP);
    await expect(h.store.wait(GROUP, { sleep: async () => {} })).resolves.toBe("timeout");
  });
});
