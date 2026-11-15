/**
 * A DM QUESTION UNDER UNIFIED_ANSWERS (`unified-dm.ts`, `dm-qa.ts`
 * `answerScopedQuestionUnified`), the review fixes of #595 (2026-11-15):
 *
 *   - the daily AI cap: no DM reply at all, as the old DM answer did (the
 *     unified answer swallowed the cap and the apology went out);
 *   - the player pool switch: the DM's context reads the real switch, not an
 *     empty environment that always said "off";
 *   - the subject: a DM has no reading of who a question names, so its
 *     context never labels the asker as "the player the question is about",
 *     and the asker's own stats never say "they asked about themselves";
 *   - admin gating: who has no number on record and who has rated, for an
 *     admin only.
 *
 * Every read is stubbed; the context builder and the answer step are the
 * real code. Made-up people. No model call, $0.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  model: null as null | { name: string; complete: (req: unknown) => Promise<unknown> },
  loadHelpClubFacts: vi.fn(async (_orgId: string, _env: Record<string, string | undefined>) => ({
    pool: { open: false, platformOpen: false, clubFlag: false },
    partners: { active: 0 },
  })),
  loadRatingProgressSnapshot: vi.fn(async () => ({ ok: true, matchName: "Tuesday", matchWhen: "3 Nov", confirmed: 4, ratedCount: 2, momCount: 1, notRated: ["Cosmo Dale"], ratedNoMom: [] })),
  state: null as unknown,
}));

vi.mock("@/lib/db", () => ({
  db: { organisation: { findUnique: async () => ({ name: "Riverside Rovers", language: "en" }) } },
}));
vi.mock("@/lib/ai-budget", async () => ({
  withOrgAiBudget: async (_orgId: string, fn: () => Promise<unknown>) => fn(),
  isAiBudgetExceeded: (await import("../ai-budget-context")).isAiBudgetExceeded,
}));
vi.mock("@/lib/pipeline/llm", async (orig) => ({
  ...(await orig<typeof import("@/lib/pipeline/llm")>()),
  anthropicModel: () => h.model,
}));
vi.mock("@/lib/reply-context", async (orig) => ({
  ...(await orig<typeof import("@/lib/reply-context")>()),
  loadDmReplyContext: async () => ({ now: new Date("2026-11-15T12:00:00Z"), quoted: null, recent: [], earlier: null }),
}));
vi.mock("@/lib/pipeline/load-state", () => ({
  loadSquadState: async () => h.state,
  loadClubSnapshot: async () => ({ collectorName: null, feePerPlayer: 6, feeSplitTotal: false, teamsReady: "off" }),
  loadRatingProgressSnapshot: h.loadRatingProgressSnapshot,
}));
vi.mock("@/lib/pipeline/load-stats", () => ({
  loadStatsTables: async () => ({
    fullTableUrl: "https://matchtime.ai/profile/stats",
    ratings: [
      { userId: "u-bruno", name: "Bruno Carr", avg: 7.6, games: 6, rank: 1, delta: 0 },
      { userId: "u-alfie", name: "Alfie Brook", avg: 6.4, games: 5, rank: 2, delta: 0 },
    ],
    mom: [],
    elo: [],
    teamOfSeason: null,
    mrReliable: [],
    aliases: [],
    appearances: [],
    recordsStart: { matches: null, mom: null },
  }),
  loadStatsChemistry: async (_o: string, userId: string) => ({ userId, name: "Alfie Brook", bestByWinRate: null, bestByRating: null, nemesis: null }),
  loadStatsPeriod: async () => ({ appearances: [], ratings: [], mom: [] }),
}));
vi.mock("@/lib/pipeline/load-results", () => ({ loadRecentResults: async () => ({ since: null, more: false, rows: [] }) }));
vi.mock("@/lib/help-club-facts", () => ({ loadHelpClubFacts: h.loadHelpClubFacts }));
vi.mock("@/lib/my-payments", () => ({ loadMyPayments: async () => null }));
vi.mock("@/lib/org-features", () => ({ getOrgFeatures: async () => ({ squadMode: "weekly" }) }));
vi.mock("@/lib/player-stats", () => ({
  loadPlayerSeasonStats: async () => ({
    gamesPlayed: 5,
    totalOrgMatches: 6,
    attendanceRate: 83,
    avgRating: 6.4,
    fieldAvgSeason: 6.5,
    momCount: 0,
    record: { w: 3, d: 1, l: 1 },
    form: { last5Avg: 6.5, trend: "steady" },
    chemistry: { bestByWinRate: null },
    rivalry: { nemesis: null },
  }),
}));

import { answerScopedQuestion } from "../dm-qa";
import { loadUnifiedDmInput } from "../unified-dm";
import { buildDmQaApology } from "../dm-copy";
import { AiBudgetExceededError } from "../ai-budget-context";
import { noReplyContext } from "../reply-context";
import type { Member, SquadState } from "../pipeline/types";
import { world } from "../pipeline/__tests__/helpers";

const PEOPLE: Array<[string, string]> = [
  ["u-alfie", "Alfie Brook"],
  ["u-bruno", "Bruno Carr"],
  ["u-cosmo", "Cosmo Dale"],
  ["u-dario", "Dario Ewing"],
];

function squad(): SquadState {
  const base = world({ players: [] });
  const roster: Member[] = PEOPLE.map(([userId, name]) => ({ userId, name, isAdmin: userId === "u-dario", hasPhone: userId !== "u-cosmo" }));
  return {
    ...base,
    roster,
    rows: [
      { userId: "u-alfie", status: "CONFIRMED", position: 1 },
      { userId: "u-bruno", status: "CONFIRMED", position: 2 },
      { userId: "u-cosmo", status: "BENCH", position: 3 },
    ],
  };
}

const answering = (answer: string | Error) => {
  const calls: unknown[] = [];
  h.model = {
    name: "stub",
    async complete(req: unknown) {
      calls.push(req);
      if (answer instanceof Error) throw answer;
      return { text: JSON.stringify({ answer }), stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 1 };
    },
  };
  return calls;
};

const ask = (over: Partial<Parameters<typeof answerScopedQuestion>[0]> = {}) =>
  answerScopedQuestion({ userId: "u-alfie", orgId: "org-1", question: "when is the next game?", askerName: "Alfie Brook", unified: true, ...over });

beforeEach(() => {
  h.state = squad();
  h.loadHelpClubFacts.mockClear();
  h.loadRatingProgressSnapshot.mockClear();
  process.env.ANTHROPIC_API_KEY = "sk-test";
  delete process.env.MT_TEST_DM_QA_STUB;
});

describe("the daily AI cap", () => {
  it("at the cap there is no DM reply at all, as the old DM answer did", async () => {
    const calls = answering(new AiBudgetExceededError("org:org-1", "unified-answer"));
    expect(await ask()).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("UNCHANGED: a call that fails for another reason gets the DM's apology", async () => {
    answering(new Error("529 Overloaded"));
    expect((await ask())?.answer).toBe(buildDmQaApology("en"));
  });

  it("a grounded answer is sent", async () => {
    answering("Your next game is on the stats page.");
    expect((await ask())?.answer).toBe("Your next game is on the stats page.");
  });
});

describe("the player pool switch", () => {
  const ENV = { MT_TEST_POOL: "open" };

  it("the DM reads the switch the caller resolved, not an empty environment", async () => {
    answering("ok");
    await ask({ poolEnv: async () => ENV });
    expect(h.loadHelpClubFacts).toHaveBeenCalledWith("org-1", ENV);
  });

  it("loadUnifiedDmInput passes it on, and shows the pool as the facts say", async () => {
    h.loadHelpClubFacts.mockImplementationOnce(async () => ({ pool: { open: true, platformOpen: true, clubFlag: true }, partners: { active: 0 } }));
    const input = await loadUnifiedDmInput({
      orgId: "org-1",
      userId: "u-alfie",
      askerName: "Alfie Brook",
      askerIsAdmin: false,
      question: "can we get players from the pool?",
      lang: "en",
      replyContext: noReplyContext(),
      now: new Date("2026-11-15T12:00:00Z"),
      poolEnv: async () => ENV,
    });
    expect(h.loadHelpClubFacts).toHaveBeenCalledWith("org-1", ENV);
    expect(input.clubFacts?.pool.open).toBe(true);
  });

  it("no switch given: the pool reads as closed (the safe side), never a crash", async () => {
    answering("ok");
    await ask();
    expect(h.loadHelpClubFacts).toHaveBeenCalledWith("org-1", {});
  });
});

describe("the subject: a DM never presents the asker as the person asked about", () => {
  const context = async (question: string) => {
    process.env.MT_TEST_DM_QA_STUB = "1";
    const out = await ask({ question });
    return out!.answer;
  };

  it("'what is Bruno's rating?': no subject block naming the asker, and the asker's stats are only the asker's", async () => {
    const text = await context("what is Bruno's rating?");
    expect(text).not.toContain("THE PLAYER THE QUESTION IS ABOUT");
    expect(text).not.toMatch(/they asked about themselves/);
    expect(text).toContain("THE ASKER'S OWN STATS:");
    // Bruno's own rating is in the table, where the model reads it.
    expect(text).toContain("1. Bruno Carr: 7.6");
  });

  it("an unknown name ('what is Zed's rating?') gets the same context: nothing says it is the asker", async () => {
    const text = await context("what is Zed's rating?");
    expect(text).not.toContain("THE PLAYER THE QUESTION IS ABOUT");
    expect(text).not.toMatch(/they asked about themselves/);
  });

  it("'what is my rating?' still has the asker's own numbers", async () => {
    const text = await context("what is my rating?");
    expect(text).toContain("THE ASKER'S OWN STATS:");
    expect(text).toContain("- Average rating: 6.4");
  });
});

describe("admin gating", () => {
  const context = async (includePhoneFlags: boolean) => {
    process.env.MT_TEST_DM_QA_STUB = "1";
    return (await ask({ includePhoneFlags }))!.answer;
  };

  it("a player: no phone flags, and who has rated is never read", async () => {
    const text = await context(false);
    expect(text).not.toContain("NO PHONE NUMBER ON RECORD");
    expect(h.loadRatingProgressSnapshot).not.toHaveBeenCalled();
    expect(text).not.toContain("Not rated yet");
    expect(text).toContain("WHO IS ASKING: Alfie Brook, a member, in a private message to MatchTime");
  });

  it("an admin: who has no number on record, and who has rated by name", async () => {
    const text = await context(true);
    expect(text).toContain("NO PHONE NUMBER ON RECORD (squad and bench): Cosmo Dale");
    expect(h.loadRatingProgressSnapshot).toHaveBeenCalledTimes(1);
    expect(text).toContain("Not rated yet: Cosmo Dale");
  });

  it("never anyone else's payments", async () => {
    const text = await context(true);
    expect(text).toMatch(/PAYMENTS: only the asker's own payments are known here/);
  });
});
