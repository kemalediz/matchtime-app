/**
 * DM pacing through the real scheduler tick (slice L5a, 24 Oct 2026).
 *
 * With the gap at ~10 s a 30 s tick may WAIT for the shared slot (inside a
 * bounded budget) instead of releasing every DM after the first, so the bot
 * reaches about six DMs a minute. Club DMs and platform DMs still take ONE
 * slot; nothing ever goes inside the gap; what the tick cannot fit is
 * released, in order, exactly as before. At the 60 s default the tick is
 * the old one: one DM, the rest released, no waiting.
 *
 * A tiny in-memory server stands in for due-posts and platform-jobs:
 * handing out claims, re-queueing releases, recording sends.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WaDriver } from "./driver.js";
import { createDmPacer, _setDmPacerForTest, type DmPacer } from "./dm-pacer.js";
import { DEFAULT_DM_PACING, type DmPacingConfig } from "./dm-pacing.js";

type Item = { id: string; phone: string; state: "queued" | "claimed" | "done" };
const club: Item[] = [];
const platform: Item[] = [];
const sends: Array<{ phone: string; at: number }> = [];

const take = (list: Item[], limit = 50) => {
  const out = list.filter((i) => i.state === "queued").slice(0, limit);
  for (const i of out) i.state = "claimed";
  return out;
};

vi.mock("./api.js", () => ({
  getDuePosts: async () => ({
    instructions: take(club).map((i) => ({ kind: "dm", key: i.id, phone: i.phone, text: i.id })),
  }),
  ackInstruction: async ({ key }: { key: string }) => {
    const i = club.find((c) => c.id === key);
    if (i) i.state = "done";
  },
  releaseInstruction: async (key: string) => {
    const i = club.find((c) => c.id === key);
    if (i) i.state = "queued";
  },
  getPlatformJobs: async () => take(platform, 5).map((i) => ({ id: i.id, kind: "dm", phone: i.phone, text: i.id })),
  reportPlatformJob: async (r: { id: string; outcome: string }) => {
    const i = platform.find((p) => p.id === r.id);
    if (i) i.state = r.outcome === "release" ? "queued" : "done";
  },
}));

const { initScheduler, stopScheduler } = await import("./scheduler.js");

const T0 = Date.parse("2026-10-24T12:00:00Z");
const FAST: DmPacingConfig = { gapMs: 10_000, jitterMs: 3_000, numberStartedAtMs: Date.parse("2026-04-01") };
const ORGS = [{ groupId: "120363000000000001@g.us", orgName: "FNF" }];

function driver(sendMs = 0): WaDriver {
  return {
    name: "fake",
    sendDirectText: async (phone: string) => {
      sends.push({ phone, at: Date.now() - T0 });
      if (sendMs) await new Promise((r) => setTimeout(r, sendMs));
      return { id: { _serialized: `wa-${phone}` } };
    },
    sendTextWithMentions: async () => ({ id: { _serialized: "g" } }),
  } as unknown as WaDriver;
}

let pacer: DmPacer;
function usePacer(config: DmPacingConfig, random = () => 0.5) {
  pacer = createDmPacer({ config, now: () => Date.now(), random, store: null, log: () => {} });
  _setDmPacerForTest(pacer);
}

function queue(list: Item[], prefix: string, n: number) {
  for (let i = 1; i <= n; i++) list.push({ id: `${prefix}${i}`, phone: `44770090${prefix === "pj" ? "1" : "2"}00${i}`, state: "queued" });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  club.length = 0;
  platform.length = 0;
  sends.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  stopScheduler();
  _setDmPacerForTest(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const gaps = () => sends.slice(1).map((s, i) => s.at - sends[i].at);

describe("10 s gap: about six DMs a minute through one shared slot", () => {
  it("a burst of 8 (3 platform + 5 club) goes out 10 s apart; the first 30 s tick sends 3 and releases the rest", async () => {
    usePacer(FAST);
    queue(platform, "pj", 3);
    queue(club, "c", 5);
    initScheduler(driver(), ORGS);

    await vi.advanceTimersByTimeAsync(29_000);
    expect(sends.map((s) => s.at)).toEqual([0, 10_000, 20_000]);
    // Platform first, and all five club DMs were handed back.
    expect(platform.every((p) => p.state === "done")).toBe(true);
    expect(club.every((c) => c.state === "queued")).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sends).toHaveLength(8);
    expect(gaps().every((g) => g === 10_000)).toBe(true);
    // Server order kept: platform, then the club in list order.
    expect(sends.map((s) => s.phone)).toEqual([
      "447700901001", "447700901002", "447700901003",
      "447700902001", "447700902002", "447700902003", "447700902004", "447700902005",
    ]);
  });

  it("never two DMs inside the spread's floor, whatever the random source draws", async () => {
    let i = 0;
    const draws = [0, 0.99, 0.3, 0.01, 0.7, 0, 0.5, 0.2, 0.9];
    usePacer(FAST, () => draws[i++ % draws.length]);
    queue(platform, "pj", 2);
    queue(club, "c", 6);
    initScheduler(driver(), ORGS);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(sends).toHaveLength(8);
    for (const g of gaps()) {
      expect(g).toBeGreaterThanOrEqual(7_000);
      expect(g).toBeLessThanOrEqual(13_000 + 30_000); // a wait never crosses a held tick by more than one poll
    }
  });

  it("the slot is reserved before the awaited send: a slow send does not let the next DM in early", async () => {
    usePacer(FAST);
    queue(club, "c", 3);
    initScheduler(driver(4_000), ORGS);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sends).toHaveLength(3);
    for (const g of gaps()) expect(g).toBeGreaterThanOrEqual(10_000);
  });

  it("a stop (disconnect, SIGTERM) during an in-tick wait releases the DM instead of sending it", async () => {
    usePacer(FAST);
    queue(club, "c", 3);
    initScheduler(driver(), ORGS);
    await vi.advanceTimersByTimeAsync(5_000); // c1 sent, waiting for c2's slot
    expect(sends).toHaveLength(1);
    stopScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(sends).toHaveLength(1);
    expect(club.map((c) => c.state)).toEqual(["done", "queued", "queued"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sends).toHaveLength(1); // stopped: no interval, no late send
  });

  it("a warning drops the very next tick back to one a minute, with no in-tick waiting", async () => {
    usePacer(FAST);
    queue(club, "c", 6);
    initScheduler(driver(), ORGS);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(sends).toHaveLength(3);

    pacer.noteWarning({ source: "baileys:reachout-timelock", detail: "active" });
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 1_000);
    const after = sends.slice(3);
    expect(after.length).toBeGreaterThanOrEqual(2);
    for (let k = 3; k < sends.length; k++) expect(sends[k].at - sends[k - 1].at).toBeGreaterThanOrEqual(60_000);
  });
});

describe("60 s default: today's behaviour, unchanged", () => {
  it("one DM per minute across club and platform; the rest released every tick; no waiting", async () => {
    usePacer(DEFAULT_DM_PACING);
    queue(platform, "pj", 1);
    queue(club, "c", 3);
    initScheduler(driver(), ORGS);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sends.map((s) => s.at)).toEqual([0]);
    expect(club.every((c) => c.state === "queued")).toBe(true);

    await vi.advanceTimersByTimeAsync(30_000); // the 30 s tick: still inside the minute
    expect(sends).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(sends).toHaveLength(4);
    expect(gaps()).toEqual([60_000, 60_000, 60_000]);
  });
});
