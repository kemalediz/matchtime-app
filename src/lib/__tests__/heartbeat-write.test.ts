/**
 * Whether a heartbeat has to touch the database (Disk IO, 2026-11-25).
 *
 * Every write to Postgres inside a 2-minute window forces a whole 16 MB WAL
 * segment out (`archive_timeout = 120 s`), and the following checkpoint can
 * force a second. The Pi reports every 10 minutes for every club, so an
 * unchanged heartbeat used to cost six bursts an hour on its own.
 *
 * The rule: anything that a reader acts on is written the moment it changes.
 * Only the bare "still alive" timestamp is held back, and never long enough
 * for the 45-minute silence alarm to fire on a live Pi.
 */
import { describe, it, expect } from "vitest";
import {
  HEARTBEAT_REFRESH_MS,
  HEARTBEAT_SILENT_MS,
  heartbeatNeedsWrite,
  type HealthCounters,
  type StoredHeartbeat,
} from "../bot-health";

const MINUTE = 60 * 1000;
const NOW = new Date("2026-11-25T09:30:00.000Z");
const TICK = 10 * MINUTE; // the Pi's FLUSH_INTERVAL_MS

function counters(over: Partial<HealthCounters> = {}): HealthCounters {
  return {
    seen: 40,
    buffered: 36,
    synthetic: 0,
    reconstructed: 0,
    notGroup: 4,
    degradedEnrichment: 0,
    nameless: 0,
    reactFailures: 0,
    flushFailures: 0,
    droppedMessages: 0,
    ...over,
  };
}

const STARTED = new Date("2026-11-20T00:24:22.724Z");

function stored(over: Partial<StoredHeartbeat> = {}): StoredHeartbeat {
  return {
    waGroupId: "g@g.us",
    lastHeartbeatAt: new Date(NOW.getTime() - TICK),
    processStartedAt: STARTED,
    botVersion: null,
    degradedCapabilities: [],
    ...counters(),
    ...over,
  };
}

const incoming = (over: Partial<Parameters<typeof heartbeatNeedsWrite>[1]> = {}) => ({
  waGroupId: "g@g.us",
  processStartedAt: new Date(STARTED.getTime()),
  botVersion: null,
  counters: counters(),
  degradedCapabilities: [] as string[],
  ...over,
});

describe("heartbeatNeedsWrite", () => {
  it("skips an unchanged heartbeat whose stored time is still fresh", () => {
    expect(heartbeatNeedsWrite(stored(), incoming(), NOW)).toBe(false);
  });

  it("refreshes an unchanged heartbeat once the stored time reaches the refresh window", () => {
    const old = stored({ lastHeartbeatAt: new Date(NOW.getTime() - HEARTBEAT_REFRESH_MS) });
    expect(heartbeatNeedsWrite(old, incoming(), NOW)).toBe(true);
  });

  it("writes when there is no row, or the row has never had a heartbeat", () => {
    expect(heartbeatNeedsWrite(null, incoming(), NOW)).toBe(true);
    expect(heartbeatNeedsWrite(stored({ lastHeartbeatAt: null }), incoming(), NOW)).toBe(true);
  });

  it("writes at once when any counter moves", () => {
    expect(heartbeatNeedsWrite(stored(), incoming({ counters: counters({ seen: 41 }) }), NOW)).toBe(true);
    expect(
      heartbeatNeedsWrite(stored(), incoming({ counters: counters({ droppedMessages: 1 }) }), NOW),
    ).toBe(true);
  });

  it("writes at once when the process restarts, the version changes or the group id changes", () => {
    expect(
      heartbeatNeedsWrite(stored(), incoming({ processStartedAt: new Date("2026-11-25T09:00:00Z") }), NOW),
    ).toBe(true);
    expect(heartbeatNeedsWrite(stored(), incoming({ processStartedAt: null }), NOW)).toBe(true);
    expect(heartbeatNeedsWrite(stored(), incoming({ botVersion: "v2" }), NOW)).toBe(true);
    expect(heartbeatNeedsWrite(stored(), incoming({ waGroupId: "other@g.us" }), NOW)).toBe(true);
  });

  it("treats processStartedAt null on both sides as unchanged", () => {
    expect(
      heartbeatNeedsWrite(stored({ processStartedAt: null }), incoming({ processStartedAt: null }), NOW),
    ).toBe(false);
  });

  it("writes at once when a capability degrades or recovers", () => {
    expect(
      heartbeatNeedsWrite(stored(), incoming({ degradedCapabilities: ["participant-sync"] }), NOW),
    ).toBe(true);
    expect(
      heartbeatNeedsWrite(stored({ degradedCapabilities: ["participant-sync"] }), incoming(), NOW),
    ).toBe(true);
  });

  it("writes when the stored time is in the future (a clock jump must not freeze the row)", () => {
    const future = stored({ lastHeartbeatAt: new Date(NOW.getTime() + 5 * MINUTE) });
    expect(heartbeatNeedsWrite(future, incoming(), NOW)).toBe(true);
  });

  /** Run `ticks` heartbeat ticks (10 min apart, up to 40 s late) through
   *  the rule. `dropped(i)` says which POSTs never arrive. Returns the
   *  largest age of the stored time a reader could see just before any
   *  tick, and how many writes there were. */
  function simulate(ticks: number, dropped: (i: number) => boolean = () => false) {
    let last: Date | null = null;
    let writes = 0;
    let worstAge = 0;
    const start = NOW.getTime();
    for (let i = 0; i < ticks; i++) {
      const at = new Date(start + i * TICK + (i % 3) * 20 * 1000);
      if (last) worstAge = Math.max(worstAge, at.getTime() - last.getTime());
      if (dropped(i)) continue;
      if (heartbeatNeedsWrite(last ? stored({ lastHeartbeatAt: last }) : null, incoming(), at)) {
        last = at;
        writes += 1;
      }
    }
    return { worstAge, writes };
  }

  it("a live Pi on a 10-minute tick never looks silent, and writes three times an hour", () => {
    const { worstAge, writes } = simulate(6 * 24);
    expect(worstAge).toBeLessThanOrEqual(20 * MINUTE + 40 * 1000);
    expect(worstAge).toBeLessThan(HEARTBEAT_SILENT_MS);
    expect(writes).toBeLessThanOrEqual(3 * 24 + 1);
  });

  it("dropped POSTs, including a failed refresh tick plus one more, never raise a false pi-silent", () => {
    // Writes land on ticks 0, 2, 4, ... Drop the refresh tick 2 AND tick 3:
    // the next write is tick 4, about 40 minutes after the stored time.
    const both = simulate(12, (i) => i === 2 || i === 3);
    expect(both.worstAge).toBeGreaterThanOrEqual(40 * MINUTE);
    expect(both.worstAge).toBeLessThan(HEARTBEAT_SILENT_MS);
    // One dropped beat at any position.
    for (let d = 1; d < 24; d++) {
      expect(simulate(24, (i) => i === d).worstAge).toBeLessThan(HEARTBEAT_SILENT_MS);
    }
  });

  it("the refresh window rounded up to the next tick, plus two dropped ticks, stays under the alarm", () => {
    const writtenEvery = Math.ceil(HEARTBEAT_REFRESH_MS / TICK) * TICK;
    expect(writtenEvery + 2 * TICK).toBeLessThan(HEARTBEAT_SILENT_MS);
  });
});
