/**
 * The DM pacer: the ONE shared slot every DM takes (club DMs and platform
 * DMs alike), its persisted warning, and the per-tick gate that may wait a
 * few seconds for the slot instead of releasing the DM.
 *
 * Clock, sleep, random source and the warning file are all injected.
 */
import { describe, it, expect } from "vitest";
import { createDmPacer, createTickGate, type DmPacer } from "./dm-pacer.js";
import { DEFAULT_DM_PACING, WARNING_COOL_DOWN_MS, type DmPacingConfig } from "./dm-pacing.js";
import type { JsonIO } from "./baileys/json-file.js";

const NOW = Date.parse("2026-10-24T12:00:00Z");
const FAST: DmPacingConfig = { gapMs: 10_000, jitterMs: 3_000, numberStartedAtMs: Date.parse("2026-04-01") };

function memoryFile(initial: unknown = null): JsonIO & { saved: unknown[] } {
  let value = initial;
  const saved: unknown[] = [];
  return {
    saved,
    load: () => (value === null ? null : JSON.parse(JSON.stringify(value))),
    save: (v) => {
      value = v;
      saved.push(v);
    },
  };
}

function rig(config: DmPacingConfig, file = memoryFile(), random = () => 0.5) {
  let clock = NOW;
  const logs: string[] = [];
  const pacer = createDmPacer({
    config,
    now: () => clock,
    random,
    store: file,
    log: (l) => logs.push(l),
    error: (l) => logs.push(l),
  });
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    clock += ms;
  };
  return {
    pacer,
    file,
    logs,
    sleeps,
    advance: (ms: number) => (clock += ms),
    now: () => clock,
    gate: (budgetMs = 25_000) => createTickGate(pacer, { sleep, budgetMs, log: (l) => logs.push(l) }),
  };
}

describe("the shared pacer", () => {
  it("default config: one DM, then held for 60 s", () => {
    const t = rig(DEFAULT_DM_PACING);
    expect(t.pacer.waitMs()).toBe(0);
    t.pacer.take("a");
    expect(t.pacer.waitMs()).toBe(60_000);
    t.advance(60_000);
    expect(t.pacer.waitMs()).toBe(0);
  });

  it("a warning is saved at once (synchronously, before a fatal close exits) and logged", () => {
    const t = rig(FAST);
    t.pacer.noteWarning({ source: "baileys:close", detail: "status 403" });
    expect(t.file.saved).toHaveLength(1);
    expect(t.logs.join("\n")).toMatch(/warning.*baileys:close.*60 s/i);
    expect(t.pacer.status().reason).toBe("warning");
  });

  it("a warning survives a restart: a new pacer on the same file starts at 60 s", () => {
    const file = memoryFile();
    const a = rig(FAST, file);
    a.pacer.noteWarning({ source: "baileys:ack-463", detail: "x" });
    const b = rig(FAST, file);
    expect(b.pacer.status()).toMatchObject({ gapMs: 60_000, reason: "warning" });
    b.pacer.take("a");
    expect(b.pacer.waitMs()).toBe(60_000);
  });

  it("an old warning on disk (past the cool-down) does not slow a restarted bot", () => {
    const file = memoryFile({
      lastWarningAtIso: new Date(NOW - WARNING_COOL_DOWN_MS - 1).toISOString(),
      source: "x",
      detail: "",
    });
    expect(rig(FAST, file).pacer.status()).toMatchObject({ gapMs: 10_000, reason: "configured" });
  });

  it("a file that cannot be written does not stop the warning taking effect in memory", () => {
    const broken: JsonIO = {
      load: () => null,
      save: () => {
        throw new Error("EROFS");
      },
    };
    const t = rig(FAST, broken as never);
    t.pacer.noteWarning({ source: "s", detail: "" });
    expect(t.pacer.status().reason).toBe("warning");
    expect(t.logs.join("\n")).toContain("EROFS");
  });

  it("no store at all (tests, wwebjs without a path) still paces", () => {
    const p: DmPacer = createDmPacer({ config: FAST, now: () => NOW, random: () => 0.5, store: null, log: () => {} });
    p.noteWarning({ source: "s", detail: "" });
    expect(p.status().reason).toBe("warning");
  });
});

describe("the tick gate", () => {
  it("fast gap: a burst inside one tick goes ~10 s apart until the budget is spent, then is held for the rest of the tick", async () => {
    const t = rig(FAST);
    const gate = t.gate(25_000);
    const sentAt: number[] = [];
    const results: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      const ok = await gate.acquire(`dm ${i}`);
      results.push(ok);
      if (ok) sentAt.push(t.now() - NOW);
    }
    expect(results).toEqual([true, true, true, false, false, false]);
    expect(sentAt).toEqual([0, 10_000, 20_000]);
    expect(t.sleeps).toEqual([10_000, 10_000]);
  });

  it("the slot is reserved BEFORE acquire resolves: two acquires never share a gap", async () => {
    const t = rig(FAST);
    const gate = t.gate(25_000);
    await gate.acquire("a");
    expect(t.pacer.waitMs()).toBe(10_000);
  });

  it("default 60 s: one DM per tick and NO in-tick waiting at all", async () => {
    const t = rig(DEFAULT_DM_PACING);
    const gate = t.gate(25_000);
    expect(await gate.acquire("a")).toBe(true);
    expect(await gate.acquire("b")).toBe(false);
    expect(t.sleeps).toEqual([]);
    t.advance(50_000);
    expect(await t.gate().acquire("c")).toBe(false); // 10 s left, but the safe gap never waits
    expect(t.sleeps).toEqual([]);
  });

  it("a warning that arrives during an in-tick wait stops the wait from sending: the DM is held", async () => {
    let pacer!: DmPacer;
    let clock = NOW;
    pacer = createDmPacer({ config: FAST, now: () => clock, random: () => 0.5, store: null, log: () => {} });
    const gate = createTickGate(pacer, {
      budgetMs: 25_000,
      log: () => {},
      sleep: async (ms) => {
        clock += ms / 2;
        pacer.noteWarning({ source: "baileys:reachout-timelock", detail: "active" });
        clock += ms / 2;
      },
    });
    expect(await gate.acquire("a")).toBe(true);
    expect(await gate.acquire("b")).toBe(false);
  });

  it("a zero budget never waits", async () => {
    const t = rig(FAST);
    const gate = t.gate(0);
    expect(await gate.acquire("a")).toBe(true);
    expect(await gate.acquire("b")).toBe(false);
    expect(t.sleeps).toEqual([]);
  });

  it("the jitter is honoured: every awaited gap lies in [7 s, 13 s]", async () => {
    let i = 0;
    const randoms = [0, 0.999, 0.25, 0.75, 0.1];
    const t = rig(FAST, memoryFile(), () => randoms[i++ % randoms.length]);
    const gate = t.gate(60_000);
    for (let n = 0; n < 5; n++) await gate.acquire(`dm ${n}`);
    for (const s of t.sleeps) {
      expect(s).toBeGreaterThanOrEqual(7_000);
      expect(s).toBeLessThanOrEqual(13_000);
    }
    expect(t.sleeps.length).toBeGreaterThan(0);
  });
});
