/**
 * REGRESSION: two `messages.create` sites shipped `max_tokens: 64000`,
 * which the Anthropic SDK REFUSES before any network call.
 *
 * The SDK computes, for every NON-streaming request:
 *     expectedTimeout = 60 * 60 * max_tokens / 128_000   (seconds)
 *     if (expectedTimeout > 600) throw AnthropicError(
 *       "Streaming is required for operations that may take longer than 10 minutes")
 * (node_modules/@anthropic-ai/sdk/src/client.ts → _calculateNonstreamingTimeout)
 *
 * So 64000 → 1800s → ALWAYS throws. Both sites were wrapped in
 * try/catch, so they degraded silently and had never once succeeded:
 *   - composeChaseText  → every scheduled chase used the static fallback
 *   - the dropped-verdict re-prompt → never recovered a single verdict
 *
 * The fake SDK below reproduces the SDK's guard EXACTLY, so these tests
 * fail the way production did — not merely on an assertion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** The SDK's own hard limit: 60*60*N/128000 > 600 throws. */
const SDK_NONSTREAMING_LIMIT = (600 * 128_000) / 3_600; // 21_333.33

type CreateArgs = { max_tokens: number; system: unknown; messages: unknown };
const captured: CreateArgs[] = [];

/** A canned response. A bare string is an ordinary `end_turn` reply;
 *  the object form models a reply the model ran out of room to finish. */
type Canned = string | { text: string; stop_reason: string };
let RESPONSES: Canned[] = [];
let callIndex = 0;

const create = vi.fn(async (args: CreateArgs) => {
  captured.push(args);
  // Mirror the real SDK's pre-flight refusal.
  if ((60 * 60 * args.max_tokens) / 128_000 > 600) {
    throw new Error(
      "Streaming is required for operations that may take longer than 10 minutes.",
    );
  }
  const canned = RESPONSES[Math.min(callIndex++, RESPONSES.length - 1)] ?? "";
  const { text, stop_reason } =
    typeof canned === "string" ? { text: canned, stop_reason: "end_turn" } : canned;
  return {
    content: [{ type: "text", text }],
    stop_reason,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
});

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create };
    constructor(_opts: unknown) {}
  }
  return { default: FakeAnthropic };
});

const KICKOFF = new Date("2026-09-01T20:30:00.000Z");
// A live club well past its first four weeks, so the daily AI cap
// (lib/ai-budget.ts) allows the composer's call; the usage table's
// statements below always grant.
const ORG = {
  id: "org-1",
  name: "Sutton Football Club",
  teamLabels: null,
  whatsappBotEnabled: true,
  whatsappGroupId: "g1",
  createdAt: new Date("2026-04-01T00:00:00Z"),
  aiDailyCapUsd: null,
  aiWindowStartAt: null,
  // Approved by the migration default, like every club that predates self-join.
  approvalStatus: "approved",
  approvedAt: null,
};
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
  attendances: ["Elvin", "Mustafa"].map((name, i) => ({
    status: "CONFIRMED",
    user: { id: `u${i}`, name, phoneNumber: "+447700900000" },
  })),
};

vi.mock("@/lib/db", () => ({
  db: {
    organisation: { findFirst: async () => ORG, findUnique: async () => ORG },
    $queryRaw: async () => [{ ok: 1 }],
    $executeRaw: async () => 1,
    match: { findFirst: async () => MATCH },
    activity: { findMany: async () => [] },
    benchSlotOffer: { findMany: async () => [] },
    // `null` short-circuits loadPlayerSeasonStats, so the scoped DM
    // context builds with no stats block — irrelevant to truncation.
    user: { findMany: async () => [], findUnique: async () => null },
  },
}));
vi.mock("@/lib/org-features", () => ({
  getOrgFeatures: async () => ({ attendance: true, statsQa: false }),
}));
vi.mock("@/lib/match-history", () => ({
  loadRecentHistory: async () => [],
  formatRecentHistoryBlock: () => "",
}));

import { composeChaseText } from "@/lib/message-analyzer";
import { answerScopedQuestion } from "@/lib/dm-qa";

beforeEach(() => {
  captured.length = 0;
  callIndex = 0;
  create.mockClear();
  process.env.ANTHROPIC_API_KEY = "sk-test";
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

describe("composeChaseText max_tokens", () => {
  it("issues a request the SDK actually accepts", async () => {
    RESPONSES = ["Need 10 more for Tuesday."];
    const out = await composeChaseText({ groupId: "g1", kind: "daily-in-list" });

    expect(create).toHaveBeenCalledTimes(1);
    expect(
      captured[0].max_tokens,
      `composeChaseText sent max_tokens=${captured[0]?.max_tokens}; the SDK ` +
        `refuses anything above ${SDK_NONSTREAMING_LIMIT} on a non-streaming call`,
    ).toBeLessThanOrEqual(SDK_NONSTREAMING_LIMIT);

    // The real symptom: the composed text must actually come back.
    expect(out).toBe("Need 10 more for Tuesday.");
  });
});

/**
 * ── THE DROPPED-VERDICT RE-PROMPT DIED WITH `analyzeBatch` (step 8) ──
 *
 * The case that stood here asserted a retry the SDK would accept, after
 * the site shipped at `max_tokens: 64000` and had therefore NEVER once
 * succeeded since May. Both the re-prompt and the batch it re-prompted
 * are gone.
 *
 * The regression it protected against is not gone, and it is not on
 * trust: `pipeline/llm.ts` clamps EVERY pipeline call to
 * `PIPELINE_MAX_TOKENS_CEILING` (4,096) at the call site rather than
 * trusting the caller, and `pipeline/__tests__/max-tokens-derivation.test.ts`
 * asserts that constant against `MAX_TOKENS_CEILING` here. A new stage
 * cannot reintroduce the 64,000 bug by passing its own number, which is
 * a stronger guarantee than a test per call site.
 *
 * The coverage it gave for the OTHER half — that a dropped id never
 * becomes a silent no-op (§3.2 S1, the 2026-05-25 Ibrahim + Baki
 * incident) — moved to `assertCoverage` in the pipeline and to
 * `lib/__tests__/operator-note.test.ts`, which asserts that an id with
 * no route at all is reported to a human rather than dropped.
 */

/**
 * TRUNCATION — the failure mode the max_tokens fix newly made reachable.
 *
 * While these sites shipped max_tokens: 64000 the call ALWAYS threw, so
 * a truncated response was structurally impossible. Now that the caps
 * are sane the model can actually hit them, and `stop_reason` becomes
 * load-bearing: it is the ONLY signal that the returned text is a
 * sentence cut off mid-word.
 *
 * Sites that JSON.parse their output are protected for free (truncated
 * JSON never parses, so they fail closed). Sites that hand the model's
 * raw text to a human are not — those are the two below, and both have
 * an existing fallback that is strictly better than partial text.
 */
describe("truncated responses never reach a human", () => {
  it("composeChaseText returns null so the scheduler sends static copy", async () => {
    RESPONSES = [
      {
        text: "*Playing Tuesday:*\n1. Elvin\n2. Mustafa\n3. Idr",
        stop_reason: "max_tokens",
      },
    ];

    const out = await composeChaseText({ groupId: "g1", kind: "daily-in-list" });

    expect(
      out,
      "a chase truncated mid-word is worse than the plain static copy — " +
        "composeChaseText must return null so composeOrFallback falls back",
    ).toBeNull();
  });

  it("composeChaseText still returns a complete response", async () => {
    // Guard against over-correcting into "never return anything".
    RESPONSES = [{ text: "Need 10 more for Tuesday.", stop_reason: "end_turn" }];
    const out = await composeChaseText({ groupId: "g1", kind: "daily-in-list" });
    expect(out).toBe("Need 10 more for Tuesday.");
  });

  it("answerScopedQuestion does not DM a half-finished sentence", async () => {
    RESPONSES = [
      {
        text: "Your next match is Tuesday at 8:30pm at Sim Ar",
        stop_reason: "max_tokens",
      },
    ];

    const out = await answerScopedQuestion({
      userId: "u0",
      orgId: "org-1",
      question: "when is my next match?",
    });

    expect(out?.answer ?? "").not.toContain("Sim Ar");
    expect(
      out?.answer ?? "",
      "a truncated DM must degrade to the existing apology, not partial text",
    ).toMatch(/couldn't work that one out/i);
  });

  it("answerScopedQuestion still returns a complete answer", async () => {
    RESPONSES = [{ text: "Tuesday, 8:30pm at Sim Arena.", stop_reason: "end_turn" }];
    const out = await answerScopedQuestion({
      userId: "u0",
      orgId: "org-1",
      question: "when is my next match?",
    });
    expect(out?.answer).toBe("Tuesday, 8:30pm at Sim Arena.");
  });
});
