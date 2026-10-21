/**
 * THE ONBOARDING READING (2026-10-21): the request it sends and what the
 * code does with the answer. No model is called: the pipeline model is a
 * stub that records the request and returns a canned body.
 *
 * The reading moved from a raw Sonnet 5 call to `pipeline/llm.ts` on
 * Haiku 5.5 (`ONBOARDING_ANALYZER_CALL = HAIKU_CALL`), with its prompt
 * rewritten: players the chat says nothing about are left out, and the
 * code fills them in with no suggestion (a null rating, which is the
 * club's "no opinion yet" state; the wizard's comment in
 * actions/onboarding.ts says the same).
 */
import { describe, it, expect } from "vitest";
import { HAIKU_CALL, type ModelRequest, type PipelineModel } from "../pipeline/llm";
import {
  analyzeForOnboarding,
  ONBOARDING_ANALYZER_CALL,
  ONBOARDING_ANALYZER_SYSTEM,
  onboardingUserTurn,
  type AnalyzeArgs,
} from "../onboarding-analyzer";

function stub(body: unknown): { model: PipelineModel; reqs: ModelRequest[] } {
  const reqs: ModelRequest[] = [];
  return {
    reqs,
    model: {
      name: "stub",
      async complete(req) {
        reqs.push(req);
        return {
          text: typeof body === "string" ? body : JSON.stringify(body),
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0,
          ms: 1,
        };
      },
    },
  };
}

const ARGS: AnalyzeArgs = {
  sportName: "Football 7-a-side",
  validPositions: ["GK", "DEF", "MID", "FWD"],
  candidateNames: ["Najib", "Talha", "Omar"],
  parsed: {
    authors: [],
    firstMessageAt: null,
    lastMessageAt: null,
    totalMessages: 2,
    recentMessages: [
      { timestamp: new Date("2026-06-04T19:00:00Z"), author: "Omar", body: "Najib saved us again,\nunreal in goal", system: false },
      { timestamp: new Date("2026-06-05T09:00:00Z"), author: "Talha", body: "Thursday 8pm Goals Sutton again", system: false },
    ],
  } as unknown as AnalyzeArgs["parsed"],
};

const ANSWER = {
  schedule: { dayOfWeek: 4, time: "20:00", venue: "Goals Sutton", confidence: 0.9 },
  paymentHolder: { name: null, evidence: null, confidence: 0 },
  players: [{ name: "Najib", position: "GK", seedRating: 8, evidence: "Najib saved us again, unreal in goal", confidence: 0.8 }],
};

describe("the onboarding reading's request", () => {
  it("runs on Haiku 5.5 through the pipeline, uncached, with a schema and room to think", async () => {
    const { model, reqs } = stub(ANSWER);
    await analyzeForOnboarding(ARGS, { model });
    expect(ONBOARDING_ANALYZER_CALL).toBe(HAIKU_CALL);
    expect(reqs).toHaveLength(1);
    const r = reqs[0];
    expect(r.model).toBe(HAIKU_CALL.model);
    expect(r.thinking).toEqual(HAIKU_CALL.thinking);
    // Once per club: a 1-hour cache write is 2x input and never read back.
    expect(r.cache).toBe(false);
    expect(r.schema).toBeTruthy();
    expect(r.maxTokens).toBeGreaterThanOrEqual(4_096);
    expect(r.label).toBe("onboarding-analyzer");
    expect(r.system).toBe(ONBOARDING_ANALYZER_SYSTEM);
  });

  it("puts the facts in the user turn: sport, positions, the players and the chat with its weekday", () => {
    const turn = onboardingUserTurn(ARGS);
    expect(turn).toContain("Football 7-a-side");
    expect(turn).toContain("GK, DEF, MID, FWD");
    expect(turn).toMatch(/Najib\n[^]*Talha\n[^]*Omar/);
    // A message on one line, its weekday beside its date.
    expect(turn).toContain("[Thu 2026-06-04 19:00] Omar: Najib saved us again, unreal in goal");
    // Nothing variable sits in the system prompt.
    expect(ONBOARDING_ANALYZER_SYSTEM).not.toContain("Goals Sutton again");
  });

  it("the prompt tells the model to leave silent players out and never to default a rating", () => {
    expect(ONBOARDING_ANALYZER_SYSTEM).not.toMatch(/Default to 6/i);
    expect(ONBOARDING_ANALYZER_SYSTEM).toMatch(/nobody else/);
    // English and Turkish examples side by side.
    expect(ONBOARDING_ANALYZER_SYSTEM).toMatch(/kale/);
    expect(ONBOARDING_ANALYZER_SYSTEM).not.toMatch(/[–—]/);
  });
});

describe("what the code does with the answer", () => {
  it("keeps the players the model named and fills the rest in with no suggestion", async () => {
    const { model } = stub(ANSWER);
    const out = await analyzeForOnboarding(ARGS, { model });
    expect(out).not.toBeNull();
    expect(out!.schedule).toEqual({ dayOfWeek: 4, time: "20:00", venue: "Goals Sutton", confidence: 0.9 });
    expect(out!.players.map((p) => p.name)).toEqual(["Najib", "Talha", "Omar"]);
    expect(out!.players[0]).toMatchObject({ position: "GK", seedRating: 8 });
    expect(out!.players[1]).toMatchObject({ position: null, seedRating: null, confidence: 0 });
  });

  it("reads the answer's own shape: a weekday by name, and \"\" or 0 for empty", async () => {
    const { model } = stub({
      schedule: { day: "Friday", time: "21:00", venue: "", confidence: 0.7 },
      paymentHolder: { name: "", evidence: "", confidence: 0 },
      players: [{ name: "Omar", position: "", seedRating: 0, evidence: "", confidence: 0.2 }],
    });
    const out = await analyzeForOnboarding(ARGS, { model });
    expect(out!.schedule).toEqual({ dayOfWeek: 5, time: "21:00", venue: null, confidence: 0.7 });
    expect(out!.paymentHolder).toEqual({ name: null, evidence: null, confidence: 0 });
    expect(out!.players.find((p) => p.name === "Omar")).toMatchObject({ position: null, seedRating: null });
  });

  it("sends the sport's positions as the only ones allowed", async () => {
    const { model, reqs } = stub(ANSWER);
    await analyzeForOnboarding(ARGS, { model });
    const pos = (reqs[0].schema as any).properties.players.items.properties.position;
    expect(pos.enum).toEqual(["GK", "DEF", "MID", "FWD", ""]);
  });

  it("drops a name not in the list, a position not in the sport, and a payment holder not in the list", async () => {
    const { model } = stub({
      schedule: { dayOfWeek: null, time: null, venue: null, confidence: 0 },
      paymentHolder: { name: "Elvin", evidence: "send to Elvin", confidence: 0.9 },
      players: [
        { name: "Stranger", position: "GK", seedRating: 7, evidence: "x", confidence: 0.9 },
        { name: "Talha", position: "Striker", seedRating: 8, evidence: "hat-trick", confidence: 0.9 },
      ],
    });
    const out = await analyzeForOnboarding(ARGS, { model });
    expect(out!.paymentHolder.name).toBeNull();
    expect(out!.players.find((p) => p.name === "Stranger")).toBeUndefined();
    expect(out!.players.find((p) => p.name === "Talha")).toMatchObject({ position: null, seedRating: 8 });
  });

  it("fails closed to null on a failed call or an unreadable body", async () => {
    expect(await analyzeForOnboarding(ARGS, { model: stub("not json").model })).toBeNull();
    const failing: PipelineModel = { name: "x", complete: async () => { throw new Error("529"); } };
    expect(await analyzeForOnboarding(ARGS, { model: failing })).toBeNull();
  });
});
