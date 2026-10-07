/**
 * The per-group store of history shared at a join: the gate (only a group
 * we were just added to), the bounds, and how long a reader waits.
 */
import { describe, it, expect } from "vitest";
import {
  JOIN_HISTORY_MAX_WAIT_MS,
  JOIN_HISTORY_QUIET_AFTER_JOIN_MS,
  JOIN_HISTORY_WINDOW_MS,
  MAX_BUNDLE_ATTEMPTS,
  createJoinHistory,
} from "./join-history.js";

const GROUP = "120363000000000000@g.us";
const ESTABLISHED = "120363111111111111@g.us";

/** A clock and cancellable timers that only move when the test says so. */
function harness(opts: { maxGroups?: number } = {}) {
  let clock = 1_000_000;
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  const store = createJoinHistory<string[]>({ now: () => clock, maxGroups: opts.maxGroups });
  const schedule = (fn: () => void, ms: number) => {
    const t = { at: clock + ms, fn, cancelled: false };
    timers.push(t);
    return {
      cancel: () => {
        t.cancelled = true;
      },
    };
  };
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return {
    store,
    schedule,
    /** Timers neither fired nor cancelled. */
    pending: () => timers.filter((t) => !t.cancelled).length,
    /** Move the clock, firing every timer that is due, in order. */
    async advance(ms: number) {
      const target = clock + ms;
      for (;;) {
        await settle();
        const due = timers.filter((t) => !t.cancelled && t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.cancelled = true;
        clock = Math.max(clock, due.at);
        due.fn();
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
    expect(h.store.opened(GROUP)).toBe(false); // the same join, seen twice
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

  it("reads one bundle per join: a second is refused while reading, once captured, and once read", () => {
    const { store } = harness();
    store.opened(GROUP);
    expect(store.begin(GROUP)).toBe(true);
    expect(store.begin(GROUP)).toBe(false);
    store.resolve(GROUP, ["a"]);
    expect(store.begin(GROUP)).toBe(false);
    expect(store.peek(GROUP)).toEqual(["a"]); // looking does not forget
    expect(store.take(GROUP)).toEqual(["a"]);
    expect(store.take(GROUP)).toBeNull(); // cleared when read
    expect(store.begin(GROUP)).toBe(false);
  });

  it("gives a failed read no second attempt", () => {
    const { store } = harness();
    expect(MAX_BUNDLE_ATTEMPTS).toBe(1);
    store.opened(GROUP);
    expect(store.begin(GROUP)).toBe(true);
    store.fail(GROUP);
    expect(store.begin(GROUP)).toBe(false);
  });
});

describe("a re-add (M1)", () => {
  it("add, read, remove, re-add inside the window: the second join gets its own history, at once", async () => {
    const h = harness();
    h.store.opened(GROUP);
    h.store.begin(GROUP);
    h.store.resolve(GROUP, ["first"]);
    expect(await h.store.wait(GROUP, { schedule: h.schedule })).toBe("captured");
    expect(h.store.take(GROUP)).toEqual(["first"]);

    await h.advance(2 * 60 * 1000);
    h.store.closed(GROUP); // we were removed
    expect(h.store.joined(GROUP)).toBe(false);

    await h.advance(60 * 1000);
    expect(h.store.opened(GROUP)).toBe(true); // a fresh join notice
    expect(h.store.begin(GROUP)).toBe(true);
    h.store.resolve(GROUP, ["second"]);
    expect(await h.store.wait(GROUP, { schedule: h.schedule })).toBe("captured");
    expect(h.store.take(GROUP)).toEqual(["second"]);
  });

  it("opens afresh over an entry already read, even if the removal was never seen", () => {
    const { store } = harness();
    store.opened(GROUP);
    store.begin(GROUP);
    store.resolve(GROUP, ["first"]);
    store.take(GROUP);
    expect(store.opened(GROUP)).toBe(true);
    expect(store.begin(GROUP)).toBe(true);
  });

  it("a removal wakes anyone waiting, with nothing", async () => {
    const h = harness();
    h.store.opened(GROUP);
    h.store.announce(GROUP);
    let out: string | null = null;
    void h.store.wait(GROUP, { schedule: h.schedule }).then((r) => (out = r));
    await h.settle();
    h.store.closed(GROUP);
    await h.settle();
    expect(out).toBe("none");
    expect(h.pending()).toBe(0);
  });
});

describe("how long a reader waits", () => {
  it("answers at once when the history is already there", async () => {
    const h = harness();
    h.store.opened(GROUP);
    h.store.begin(GROUP);
    h.store.resolve(GROUP, ["a"]);
    await expect(h.store.wait(GROUP, { schedule: h.schedule })).resolves.toBe("captured");
    expect(h.pending()).toBe(0);
  });

  it("answers at once for a group that was never opened", async () => {
    const h = harness();
    await expect(h.store.wait(ESTABLISHED, { schedule: h.schedule })).resolves.toBe("none");
  });

  it("with no sign of history, gives up 10 s after the JOIN, however late the reader asked", async () => {
    const h = harness();
    h.store.opened(GROUP);
    // The bot-added flow reads the roster first: say that took 3 s.
    await h.advance(3000);
    let out: string | null = null;
    void h.store.wait(GROUP, { schedule: h.schedule }).then((r) => (out = r));
    await h.advance(JOIN_HISTORY_QUIET_AFTER_JOIN_MS - 3000 - 1);
    expect(out).toBeNull();
    await h.advance(1);
    expect(out).toBe("none");
    expect(JOIN_HISTORY_QUIET_AFTER_JOIN_MS).toBe(10_000);
  });

  it("does not wait at all when the join was more than 10 s ago and nothing was seen", async () => {
    const h = harness();
    h.store.opened(GROUP);
    await h.advance(JOIN_HISTORY_QUIET_AFTER_JOIN_MS);
    await expect(h.store.wait(GROUP, { schedule: h.schedule })).resolves.toBe("none");
    expect(h.pending()).toBe(0);
  });

  it("waits the full time once a notice or bundle was seen, and no longer", async () => {
    const h = harness();
    h.store.opened(GROUP);
    h.store.announce(GROUP);
    h.store.begin(GROUP);
    let out: string | null = null;
    void h.store.wait(GROUP, { schedule: h.schedule }).then((r) => (out = r));
    await h.advance(JOIN_HISTORY_MAX_WAIT_MS - 1);
    expect(out).toBeNull();
    await h.advance(1);
    expect(out).toBe("timeout");
    expect(JOIN_HISTORY_MAX_WAIT_MS).toBe(25_000);
  });

  it("extends the wait when the announcement comes during the quiet wait", async () => {
    const h = harness();
    h.store.opened(GROUP);
    let out: string | null = null;
    void h.store.wait(GROUP, { schedule: h.schedule }).then((r) => (out = r));
    await h.advance(3000);
    h.store.announce(GROUP);
    h.store.begin(GROUP);
    await h.advance(JOIN_HISTORY_QUIET_AFTER_JOIN_MS);
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
    void h.store.wait(GROUP, { schedule: h.schedule }).then((r) => (out = r));
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
    void h.store.wait(GROUP, { schedule: h.schedule }).then((r) => (out = r));
    await h.advance(JOIN_HISTORY_MAX_WAIT_MS);
    expect(out).toBe("timeout");
  });

  it("cancels its timer and drops its waiter when it resolves (L6)", async () => {
    const h = harness();
    h.store.opened(GROUP);
    h.store.announce(GROUP);
    h.store.begin(GROUP);
    const waiting = h.store.wait(GROUP, { schedule: h.schedule });
    await h.settle();
    expect(h.pending()).toBe(1);
    expect(h.store.waiting(GROUP)).toBe(1);
    h.store.resolve(GROUP, ["a"]);
    expect(await waiting).toBe("captured");
    expect(h.pending()).toBe(0);
    expect(h.store.waiting(GROUP)).toBe(0);
  });

  it("drops its waiter when the timer is what ends it", async () => {
    const h = harness();
    h.store.opened(GROUP);
    const waiting = h.store.wait(GROUP, { schedule: h.schedule });
    await h.advance(JOIN_HISTORY_QUIET_AFTER_JOIN_MS);
    expect(await waiting).toBe("none");
    expect(h.store.waiting(GROUP)).toBe(0);
    expect(h.pending()).toBe(0);
  });
});

describe("a bundle that lands after the reader gave up (M2)", () => {
  it("is still read and kept: giving up empty-handed does not mark the join as read", async () => {
    const h = harness();
    h.store.opened(GROUP);
    const waiting = h.store.wait(GROUP, { schedule: h.schedule });
    await h.advance(JOIN_HISTORY_QUIET_AFTER_JOIN_MS);
    expect(await waiting).toBe("none");
    expect(h.store.take(GROUP)).toBeNull(); // nothing to take, and it must not close the door
    expect(h.store.gaveUp(GROUP)).toBe(true);

    expect(h.store.begin(GROUP)).toBe(true);
    h.store.resolve(GROUP, ["late"]);
    // Whoever asks again inside the window gets it at once.
    expect(await h.store.wait(GROUP, { schedule: h.schedule })).toBe("captured");
    expect(h.store.take(GROUP)).toEqual(["late"]);
  });
});
