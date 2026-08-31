/**
 * The shadow window-analyzer is OFF unless someone turns it on.
 *
 * It has fired on every batch since 2026-05-29 — a second, entirely
 * uncached Sonnet call (~$0.014/batch, ~30% of the analyzer bill) whose
 * only purpose was to gather a week of comparison data for a decision
 * that was never taken. It never writes attendance.
 *
 * It is NOT deleted: the redesign's migration plan (MDs/analyzer-
 * redesign-2026-08-31.md §10) reuses it to compare the new pipeline
 * against the old on live traffic. It is simply switched off by default
 * so it costs nothing until that day.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoisted so the vi.mock factories (which run before module init) can
// reach them.
const { calls, create, windowVerdictCreate } = vi.hoisted(() => {
  const calls: string[] = [];
  const create = vi.fn(async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          windowSummary: "nothing happened",
          stateChanges: [],
          reactions: [],
          groupReply: null,
        }),
      },
    ],
    usage: { input_tokens: 100, output_tokens: 50 },
  }));
  const windowVerdictCreate = vi.fn(async () => {
    calls.push("windowVerdict.create");
    return {};
  });
  return { calls, create, windowVerdictCreate };
});

// ── Anthropic seam — must never be constructed while the flag is off ──
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create };
    constructor(_opts: unknown) {}
  }
  return { default: FakeAnthropic };
});

// ── DB seam — every call is counted so "no work at all" is provable ──
vi.mock("@/lib/db", () => {
  const track =
    <T>(name: string, value: T) =>
    async () => {
      calls.push(name);
      return value;
    };
  return {
    db: {
      windowVerdict: {
        findUnique: track("windowVerdict.findUnique", null),
        aggregate: track("windowVerdict.aggregate", { _sum: { costUsd: 0 } }),
        create: windowVerdictCreate,
      },
      match: { findFirst: track("match.findFirst", null) },
      organisation: { findUnique: track("organisation.findUnique", { teamLabels: null }) },
      membership: { findMany: track("membership.findMany", []) },
      benchSlotOffer: { findMany: track("benchSlotOffer.findMany", []) },
    },
  };
});

import { runShadowAnalysis, isShadowAnalysisEnabled } from "@/lib/window-analyzer";

const BATCH = {
  orgId: "org-1",
  groupId: "g1",
  messages: [
    {
      waMessageId: "wa-1",
      body: "I'm in",
      authorName: "Elvin",
      authorPhone: "+447700900001",
      timestamp: new Date("2026-08-31T11:59:00.000Z"),
    },
  ],
  history: [],
  currentVerdictIds: ["wa-1"],
};

beforeEach(() => {
  calls.length = 0;
  create.mockClear();
  windowVerdictCreate.mockClear();
  delete process.env.SHADOW_ANALYZER_ENABLED;
  process.env.ANTHROPIC_API_KEY = "sk-test";
});
afterEach(() => {
  delete process.env.SHADOW_ANALYZER_ENABLED;
});

describe("isShadowAnalysisEnabled", () => {
  it("is false when the env var is unset — that is the whole point", () => {
    expect(isShadowAnalysisEnabled()).toBe(false);
  });

  it("is false for every off-ish value", () => {
    for (const v of ["", " ", "0", "false", "FALSE", "no", "off", "nope"]) {
      process.env.SHADOW_ANALYZER_ENABLED = v;
      expect(isShadowAnalysisEnabled(), `"${v}" must not enable it`).toBe(false);
    }
  });

  it("is true only for an explicit on value", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) {
      process.env.SHADOW_ANALYZER_ENABLED = v;
      expect(isShadowAnalysisEnabled(), `"${v}" must enable it`).toBe(true);
    }
  });
});

describe("runShadowAnalysis", () => {
  // FIRST — the "log once" latch is module-level, so this test has to
  // be the one that trips it.
  it("says so once, not on every batch", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runShadowAnalysis(BATCH as never);
    await runShadowAnalysis(BATCH as never);
    await runShadowAnalysis(BATCH as never);
    const skips = log.mock.calls.filter((c) => String(c[0]).includes("[shadow]"));
    log.mockRestore();
    expect(skips).toHaveLength(1);
    expect(String(skips[0][0])).toContain("SHADOW_ANALYZER_ENABLED");
  });

  it("does nothing at all when the flag is unset — no DB, no Claude", async () => {
    await runShadowAnalysis(BATCH as never);
    expect(calls).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("does nothing when the flag is explicitly false", async () => {
    process.env.SHADOW_ANALYZER_ENABLED = "false";
    await runShadowAnalysis(BATCH as never);
    expect(calls).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("runs the full comparison when explicitly enabled", async () => {
    process.env.SHADOW_ANALYZER_ENABLED = "1";
    await runShadowAnalysis(BATCH as never);
    expect(create).toHaveBeenCalledTimes(1);
    expect(windowVerdictCreate).toHaveBeenCalledTimes(1);
    expect(calls).toContain("windowVerdict.findUnique");
  });
});
