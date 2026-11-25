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

  it("a live Pi on a 10-minute tick never looks silent to the 45-minute alarm", () => {
    // Simulate a quiet day: unchanged heartbeats every tick, with some
    // jitter on each tick. Track the stored time and check its age at
    // every instant a reader could look, just before each tick.
    let last: Date | null = null;
    let writes = 0;
    let worstAge = 0;
    const start = NOW.getTime();
    for (let i = 0; i < 6 * 24; i++) {
      const jitter = (i % 3) * 20 * 1000; // up to 40 s late
      const at = new Date(start + i * TICK + jitter);
      if (last) worstAge = Math.max(worstAge, at.getTime() - last.getTime());
      if (heartbeatNeedsWrite(last ? stored({ lastHeartbeatAt: last }) : null, incoming(), at)) {
        last = at;
        writes += 1;
      }
    }
    expect(worstAge).toBeLessThan(HEARTBEAT_SILENT_MS - 10 * MINUTE);
    // Two writes an hour instead of six.
    expect(writes).toBeLessThanOrEqual(2 * 24 + 1);
  });

  it("the refresh window leaves at least one full tick of margin under the silence alarm", () => {
    expect(HEARTBEAT_REFRESH_MS + TICK).toBeLessThan(HEARTBEAT_SILENT_MS);
  });
});
