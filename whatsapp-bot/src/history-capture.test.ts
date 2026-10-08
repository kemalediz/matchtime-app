/**
 * The bot-added flow's history capture: shared join history first, then
 * the live buffer exactly as before.
 */
import { describe, it, expect } from "vitest";
import type { JoinHistoryCapture, WaDriver } from "./driver.js";
import { createHistoryCollector } from "./history-capture.js";

const GROUP = "120363000000000000@g.us";
const SELF = ["447700900999@c.us", "999999999999999@lid"];

function live(id: number, over: Record<string, unknown> = {}) {
  return {
    fromMe: false,
    author: "447700900123@c.us",
    from: GROUP,
    body: `live ${id}`,
    timestamp: 1_760_000_000 + id,
    _data: { notifyName: "Sam" },
    ...over,
  };
}

function harness(opts: { joinHistory?: JoinHistoryCapture | Error | "absent"; buffer?: unknown[][] }) {
  const logs: string[] = [];
  const sleeps: number[] = [];
  const reads: number[] = [];
  const joinCalls: Array<[string, string[]]> = [];
  const buffer = opts.buffer ?? [[]];
  const driver: Partial<WaDriver> = {
    async fetchRecentGroupMessages(_gid, limit) {
      reads.push(limit);
      return (buffer[Math.min(reads.length - 1, buffer.length - 1)] ?? []) as never;
    },
  };
  if (opts.joinHistory !== "absent") {
    driver.joinHistory = async (gid, selfIds) => {
      joinCalls.push([gid, selfIds]);
      if (opts.joinHistory instanceof Error) throw opts.joinHistory;
      return opts.joinHistory ?? { outcome: "none", messages: [] };
    };
  }
  const collect = createHistoryCollector({
    driver: driver as WaDriver,
    log: (l) => logs.push(l),
    warn: (l) => logs.push(l),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { collect, logs, sleeps, reads, joinCalls };
}

const SHARED = [
  { author: "Alice", authorPhone: "447700900111", text: "who is in for Tuesday", timestamp: "2026-10-01T10:00:00.000Z" },
  { author: "Member 1", authorPhone: null, text: "me", timestamp: "2026-10-01T10:01:00.000Z" },
];

describe("with a driver that can read shared join history", () => {
  it("returns the shared history and never touches the live buffer", async () => {
    const h = harness({ joinHistory: { outcome: "captured", messages: SHARED } });
    expect(await h.collect(GROUP, SELF)).toEqual(SHARED);
    expect(h.joinCalls).toEqual([[GROUP, SELF]]);
    expect(h.reads).toEqual([]);
    expect(h.sleeps).toEqual([]);
    expect(h.logs).toEqual([`[bot-added] shared join history for ${GROUP}: captured, 2 message(s)`]);
  });

  it("caps the shared history at the newest 600", async () => {
    const many = Array.from({ length: 700 }, (_, i) => ({ ...SHARED[0], text: `m${i}` }));
    const h = harness({ joinHistory: { outcome: "captured", messages: many } });
    const out = await h.collect(GROUP, SELF);
    expect(out).toHaveLength(600);
    expect(out[0].text).toBe("m100");
    expect(out[599].text).toBe("m699");
  });

  it.each(["none", "failed", "timeout"] as const)(
    "falls back to ONE read of the live buffer when the outcome is %s (the waiting is already done)",
    async (outcome) => {
      const h = harness({ joinHistory: { outcome, messages: [] }, buffer: [[live(2), live(1)]] });
      const out = await h.collect(GROUP, SELF);
      expect(out.map((m) => m.text)).toEqual(["live 1", "live 2"]);
      expect(out[0]).toEqual({
        author: "Sam",
        authorPhone: "447700900123",
        text: "live 1",
        timestamp: new Date(1_760_000_001_000).toISOString(),
      });
      expect(h.reads).toEqual([600]);
      expect(h.sleeps).toEqual([]);
    },
  );

  it("returns nothing, without sleeping, when both are empty", async () => {
    const h = harness({ joinHistory: { outcome: "none", messages: [] } });
    expect(await h.collect(GROUP, SELF)).toEqual([]);
    expect(h.reads).toEqual([600]);
    expect(h.sleeps).toEqual([]);
  });

  it("an empty capture falls back too", async () => {
    const h = harness({ joinHistory: { outcome: "captured", messages: [] }, buffer: [[live(1)]] });
    expect((await h.collect(GROUP, SELF)).map((m) => m.text)).toEqual(["live 1"]);
  });

  it("survives a driver that throws, and falls back", async () => {
    const h = harness({ joinHistory: new Error("boom"), buffer: [[live(1)]] });
    expect((await h.collect(GROUP, SELF)).map((m) => m.text)).toEqual(["live 1"]);
    expect(h.logs.some((l) => l.includes("shared join history read failed: boom"))).toBe(true);
  });
});

describe("with a driver that cannot (whatsapp-web.js): exactly as before", () => {
  it("polls the live buffer three times, four seconds apart", async () => {
    const h = harness({ joinHistory: "absent" });
    expect(await h.collect(GROUP, SELF)).toEqual([]);
    expect(h.reads).toEqual([600, 600, 600]);
    expect(h.sleeps).toEqual([4000, 4000]);
    expect(h.logs.filter((l) => l.includes("history fetch attempt"))).toEqual([
      "[bot-added] history fetch attempt 1: got 0 msgs",
      "[bot-added] history fetch attempt 2: got 0 msgs",
      "[bot-added] history fetch attempt 3: got 0 msgs",
    ]);
  });

  it("stops polling once enough has arrived, and filters as before", async () => {
    const rows = [
      live(1),
      live(2, { fromMe: true }),
      live(3, { author: SELF[0] }),
      live(4, { body: "   " }),
      live(5, { _data: {} }),
      live(6, { author: "111111111111111@lid" }),
    ];
    const h = harness({ joinHistory: "absent", buffer: [[], rows] });
    const out = await h.collect(GROUP, SELF);
    expect(h.reads).toEqual([600, 600]);
    expect(h.sleeps).toEqual([4000]);
    expect(out.map((m) => [m.text, m.authorPhone])).toEqual([
      ["live 1", "447700900123"],
      ["live 6", null],
    ]);
  });
});
