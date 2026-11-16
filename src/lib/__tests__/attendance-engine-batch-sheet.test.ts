/**
 * A REPLACEMENT'S TEAM SHEET IS A WRITTEN SHEET ONLY WHEN ITS SLOT MOVE
 * LANDED (review of #604, round 3, 2026-11-16).
 *
 * "Dan is replacing Pete" with the teams out composes the replacement post:
 * a lead and the whole sheet with Dan in Pete's place. The post is composed
 * from the engine's PROJECTION; the slot move runs afterwards. When the move
 * throws, the post declares a sheet the database did not accept, so the
 * route must not count it as the batch's written sheet (`teamSheetWritten`).
 * `deterministicTeamPost` is unchanged: the reply is still a composed sheet,
 * never recomposed as the squad post. Made-up people; no model call.
 */
import { describe, expect, it } from "vitest";
import { runAttendanceEngineBatch } from "../attendance-engine-batch";
import type { EngineBatchDeps } from "../attendance-engine-batch";
import type { SquadState } from "../pipeline/types";
import type { PipelineModel } from "../pipeline/llm";

const base = { contingent: false, conditionOn: "none", tense: "present", reported: false, confidence: 0.95 };
const REPLACING = {
  claims: [
    { ...base, subject: "other", personRef: "Dan", personNamed: true, polarity: "in", replaces: "Pete" },
    { ...base, subject: "other", personRef: "Pete", personNamed: true, polarity: "out" },
  ],
  affirmation: "none",
  sideRequests: [],
};
const model: PipelineModel = {
  name: "fake",
  async complete() {
    return { text: JSON.stringify(REPLACING), stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 1 };
  },
};
const STATE: SquadState = {
  matchId: "match-1",
  maxPlayers: 2,
  kickoffLabel: "Tue 20:00",
  venue: "The Pitch",
  rows: [
    { userId: "u-pete", status: "CONFIRMED", position: 1 },
    { userId: "u-alice", status: "CONFIRMED", position: 2 },
  ],
  roster: [
    { userId: "u-pete", name: "Pete Power", isAdmin: false, hasPhone: true },
    { userId: "u-alice", name: "Alice Admin", isAdmin: true, hasPhone: true },
    { userId: "u-dan", name: "Dan Drummer", isAdmin: false, hasPhone: true },
  ],
  openOffers: [],
  teams: [
    { userId: "u-pete", team: "RED" },
    { userId: "u-alice", team: "YELLOW" },
  ],
  teamLabels: ["Red", "Yellow"],
  completedMatch: null,
  payments: null,
  ratingProgress: null,
  lastBotPost: null,
  features: { attendance: true, paymentTracking: false, statsQa: false, reminders: false, language: "en" },
  smallerFormats: [],
  guestAskedUserIds: [],
};

async function replace(moveTeamSlot: () => Promise<void>, cancelAttendance: () => Promise<unknown> = async () => ({ status: "DROPPED" as const })) {
  const deps = {
    model,
    loadState: async () => STATE,
    openBenchPromptUserIds: async () => [],
    claimGuestNameAsk: async () => true,
    registerAttendance: async () => ({ status: "CONFIRMED" as const, position: 2, slot: 2, confirmedCount: 2, maxPlayers: 2 }),
    cancelAttendance,
    resolveOrProvision: async (n: string) => ({ userId: n }),
    moveTeamSlot,
  } as unknown as EngineBatchDeps;
  const r = await runAttendanceEngineBatch({
    orgId: "org-1",
    now: new Date("2026-09-03T12:00:00Z"),
    messages: [
      { waMessageId: "wa-1", body: "Dan is replacing Pete", authorName: "Alice Admin", senderUserId: "u-alice", senderName: "Alice Admin", senderIsAdmin: true, tagged: false, route: "other_att", gated: false },
    ],
    history: [],
    expectedMatchId: "match-1",
    enabled: true,
    deps,
  });
  return { out: r.outcomes.get("wa-1")!, degradations: r.degradations };
}

describe("the replacement post and its slot move", () => {
  it("the move landed: the post is a written team sheet, its lead and its sheet handed over apart", async () => {
    const { out } = await replace(async () => {});
    expect(out.reply).toMatch(/takes his place/);
    expect(out.deterministicTeamPost).toBe(true);
    expect(out.teamSheetWritten).toBe(true);
    // Round 4: the route can drop the sheet and keep the news.
    expect(out.sheetParts?.lead).toBe("🔁 *Pete is out*. *Dan* takes his place and his spot in *Red*.");
    expect(out.sheetParts?.sheet).toMatch(/^⚽ \*Teams for tonight\*/);
    expect(out.reply).toBe(`${out.sheetParts!.lead}\n\n${out.sheetParts!.sheet}`);
  });

  // Round 4 (rows 13a, 13b): the post must not show a sheet the database
  // rejected. Only what is still true is said.
  it("13a: the move threw, Pete's OUT landed: only 'Pete is out', no sheet, not a team post", async () => {
    const { out, degradations } = await replace(async () => {
      throw new Error("db said no");
    });
    expect(out.reply).toBe("🔁 *Pete is out*.");
    expect(out.deterministicTeamPost).toBe(false);
    expect(out.teamSheetWritten).toBe(false);
    expect(out.sheetParts).toBeUndefined();
    expect(degradations.join(" ")).toMatch(/did not move/);
  });

  it("13b: the move threw and Pete's OUT did not land either: nothing of the replacement is said", async () => {
    const { out } = await replace(
      async () => {
        throw new Error("db said no");
      },
      async () => {
        throw new Error("cancel failed");
      },
    );
    expect(out?.reply ?? "").not.toMatch(/is out|takes his place|Teams for/);
    expect(out?.deterministicTeamPost ?? false).toBe(false);
  });
});
