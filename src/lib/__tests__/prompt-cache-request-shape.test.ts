/**
 * What actually goes on the wire: the cache breakpoints.
 *
 * `prompt-cache-stability.test.ts` pins the builder. This one pins the
 * WIRING — the two `messages.create` sites that mark a content block
 * `cache_control` must never put a clock-derived value inside it, and
 * must still hand the model that value in an uncached block.
 *
 * Both sites had the same defect (analyzer-redesign-2026-08-31.md §8.1
 * only names `analyzeBatch`; `composeChaseText` caches the very same
 * `matchContext` string and was busting its cache on every scheduled
 * chase too).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Anthropic SDK capture seam ────────────────────────────────────
type CreateArgs = {
  system: Array<{ type: string; text: string; cache_control?: unknown }>;
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; text: string; cache_control?: unknown }>;
  }>;
};
const captured: CreateArgs[] = [];
const create = vi.fn(async (args: CreateArgs) => {
  captured.push(args);
  return {
    content: [{ type: "text", text: RESPONSE_TEXT }],
    usage: { input_tokens: 10, output_tokens: 10 },
  };
});
let RESPONSE_TEXT = "";

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create };
    constructor(_opts: unknown) {}
  }
  return { default: FakeAnthropic };
});

// ── DB seam ───────────────────────────────────────────────────────
const KICKOFF = new Date("2026-09-01T20:30:00.000Z");
const ORG = { id: "org-1", name: "Sutton Football Club", teamLabels: null };
const MATCH = {
  id: "m1",
  date: KICKOFF,
  status: "UPCOMING",
  maxPlayers: 14,
  activity: {
    name: "Tuesday 7-a-side",
    venue: "Sim Arena",
    sport: { name: "Football 7-a-side", playersPerTeam: 7, teamLabels: null },
  },
  attendances: ["Elvin", "Mustafa", "Idris", "Sait"].map((name, i) => ({
    status: "CONFIRMED",
    user: { id: `u${i}`, name, phoneNumber: "+447700900000" },
  })),
};

vi.mock("@/lib/db", () => ({
  db: {
    organisation: { findFirst: async () => ORG, findUnique: async () => ORG },
    match: { findFirst: async () => MATCH },
    activity: { findMany: async () => [] },
    benchSlotOffer: { findMany: async () => [] },
    user: { findMany: async () => [] },
  },
}));
vi.mock("@/lib/org-features", () => ({
  getOrgFeatures: async () => ({ attendance: true, statsQa: false }),
}));

import { analyzeBatch, composeChaseText } from "@/lib/message-analyzer";

/** Every content block that carries a cache_control marker. */
function cachedTexts(args: CreateArgs): string[] {
  const out: string[] = [];
  for (const s of args.system) if (s.cache_control) out.push(s.text);
  for (const m of args.messages) {
    if (typeof m.content === "string") continue;
    for (const c of m.content) if (c.cache_control) out.push(c.text);
  }
  return out;
}

/** Cached blocks in the USER message — i.e. the per-org context. The
 *  system prompt is also cached but is a compile-time constant, and it
 *  legitimately quotes "proximity=" / "Use roster header:" as
 *  instructions, so it is excluded from the volatility check. */
function cachedUserTexts(args: CreateArgs): string[] {
  const out: string[] = [];
  for (const m of args.messages) {
    if (typeof m.content === "string") continue;
    for (const c of m.content) if (c.cache_control) out.push(c.text);
  }
  return out;
}

/** Every content block WITHOUT a cache_control marker. */
function freshTexts(args: CreateArgs): string[] {
  const out: string[] = [];
  for (const s of args.system) if (!s.cache_control) out.push(s.text);
  for (const m of args.messages) {
    if (typeof m.content === "string") out.push(m.content);
    else for (const c of m.content) if (!c.cache_control) out.push(c.text);
  }
  return out;
}

/** A well-formed batch response, so no re-prompt retry fires. */
const VERDICTS = JSON.stringify({
  verdicts: [
    { waMessageId: "wa-1", intent: "in", confidence: 0.9, reasoning: "in", reply: null, react: "✅" },
  ],
});

const VOLATILE = ["until kickoff", "since kickoff", "proximity=", "Use roster header:"];

beforeEach(() => {
  captured.length = 0;
  create.mockClear();
  process.env.ANTHROPIC_API_KEY = "sk-test";
  delete process.env.MT_TEST_LLM_STUB_FILE;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("analyzeBatch cache breakpoints", () => {
  const batch = {
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
  };

  it("puts no clock-derived value in any cached block", async () => {
    RESPONSE_TEXT = VERDICTS;
    await analyzeBatch(batch as never);
    expect(create).toHaveBeenCalledTimes(1);
    const cached = cachedUserTexts(captured[0]).join("\n");
    for (const v of VOLATILE) expect(cached, `cached block must not contain "${v}"`).not.toContain(v);
  });

  it("still hands the model the countdown, proximity and roster header", async () => {
    RESPONSE_TEXT = VERDICTS;
    await analyzeBatch(batch as never);
    const fresh = freshTexts(captured[0]).join("\n");
    expect(fresh).toMatch(/\d+\.\dh until kickoff/);
    expect(fresh).toContain("proximity=");
    expect(fresh).toContain("Use roster header:");
  });

  it("sends a byte-identical cached prefix 20 minutes later", async () => {
    RESPONSE_TEXT = VERDICTS;
    await analyzeBatch(batch as never);
    vi.setSystemTime(new Date("2026-08-31T12:20:00.000Z"));
    await analyzeBatch(batch as never);
    expect(cachedTexts(captured[1])).toEqual(cachedTexts(captured[0]));
  });
});

describe("composeChaseText cache breakpoints", () => {
  it("puts no clock-derived value in any cached block", async () => {
    RESPONSE_TEXT = "Need 10 more for Tuesday.";
    await composeChaseText({ groupId: "g1", kind: "daily-in-list" });
    expect(create).toHaveBeenCalledTimes(1);
    const cached = cachedUserTexts(captured[0]).join("\n");
    for (const v of VOLATILE) expect(cached, `cached block must not contain "${v}"`).not.toContain(v);
  });

  it("still hands the model the countdown, proximity and roster header", async () => {
    RESPONSE_TEXT = "Need 10 more for Tuesday.";
    await composeChaseText({ groupId: "g1", kind: "daily-in-list" });
    const fresh = freshTexts(captured[0]).join("\n");
    expect(fresh).toMatch(/\d+\.\dh until kickoff/);
    expect(fresh).toContain("proximity=");
    expect(fresh).toContain("Use roster header:");
  });

  it("sends a byte-identical cached prefix 20 minutes later", async () => {
    RESPONSE_TEXT = "Need 10 more for Tuesday.";
    await composeChaseText({ groupId: "g1", kind: "daily-in-list" });
    vi.setSystemTime(new Date("2026-08-31T12:20:00.000Z"));
    await composeChaseText({ groupId: "g1", kind: "daily-in-list" });
    expect(cachedTexts(captured[1])).toEqual(cachedTexts(captured[0]));
  });
});
