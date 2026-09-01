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
let RESPONSES: string[] = [];
let callIndex = 0;

const create = vi.fn(async (args: CreateArgs) => {
  captured.push(args);
  // Mirror the real SDK's pre-flight refusal.
  if ((60 * 60 * args.max_tokens) / 128_000 > 600) {
    throw new Error(
      "Streaming is required for operations that may take longer than 10 minutes.",
    );
  }
  const text = RESPONSES[Math.min(callIndex++, RESPONSES.length - 1)] ?? "";
  return {
    content: [{ type: "text", text }],
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
  attendances: ["Elvin", "Mustafa"].map((name, i) => ({
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

beforeEach(() => {
  captured.length = 0;
  callIndex = 0;
  create.mockClear();
  process.env.ANTHROPIC_API_KEY = "sk-test";
  delete process.env.MT_TEST_LLM_STUB_FILE;
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

describe("dropped-verdict re-prompt max_tokens", () => {
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
      {
        waMessageId: "wa-2",
        body: "me too",
        authorName: "Mustafa",
        authorPhone: "+447700900002",
        timestamp: new Date("2026-08-31T11:59:30.000Z"),
      },
    ],
    history: [],
  };

  it("issues a retry the SDK actually accepts, and recovers the verdict", async () => {
    // 1st call omits wa-2 → the re-prompt path fires. 2nd call supplies it.
    RESPONSES = [
      JSON.stringify({
        verdicts: [
          {
            waMessageId: "wa-1",
            intent: "in",
            confidence: 0.9,
            reasoning: "in",
            reply: null,
            react: "✅",
          },
        ],
      }),
      JSON.stringify({
        verdicts: [
          {
            waMessageId: "wa-2",
            intent: "in",
            confidence: 0.9,
            reasoning: "also in",
            reply: null,
            react: "✅",
          },
        ],
      }),
    ];

    const verdicts = await analyzeBatch(batch as never);

    expect(create, "the re-prompt must actually be attempted").toHaveBeenCalledTimes(2);
    expect(
      captured[1].max_tokens,
      `the re-prompt sent max_tokens=${captured[1]?.max_tokens}; the SDK ` +
        `refuses anything above ${SDK_NONSTREAMING_LIMIT} on a non-streaming call`,
    ).toBeLessThanOrEqual(SDK_NONSTREAMING_LIMIT);

    // A retry covers a SUBSET of the batch, so it never needs more room
    // than the main call.
    expect(captured[1].max_tokens).toBeLessThanOrEqual(captured[0].max_tokens);

    // The real symptom: the dropped verdict is recovered, no placeholder left.
    const wa2 = verdicts.find((v) => v.waMessageId === "wa-2");
    expect(wa2?.reasoning).not.toBe("Claude emitted no verdict for this id");
  });
});
