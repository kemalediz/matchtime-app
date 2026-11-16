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

async function replace(
  moveTeamSlot: () => Promise<void>,
  cancelAttendance: () => Promise<unknown> = async () => ({ status: "DROPPED" as const }),
  registerAttendance: () => Promise<unknown> = async () => ({ status: "CONFIRMED" as const, position: 2, slot: 2, confirmedCount: 2, maxPlayers: 2 }),
  lang: "en" | "tr" = "en",
) {
  const deps = {
    model,
    loadState: async () => ({ ...STATE, features: { ...STATE.features, language: lang } }),
    openBenchPromptUserIds: async () => [],
    claimGuestNameAsk: async () => true,
    registerAttendance,
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
  it("the move landed: the post is the sheet, a written team sheet", async () => {
    const { out } = await replace(async () => {});
    expect(out.reply).toMatch(/^🔁 \*Pete is out\*\. \*Dan\* takes his place and his spot in \*Red\*\.\n\n⚽ \*Teams for tonight\*/);
    expect(out.deterministicTeamPost).toBe(true);
    expect(out.teamSheetWritten).toBe(true);
  });

  // Rows 13a and 13b (#604, review rounds 4-5): the post must never show a
  // sheet the database rejected. Only what landed is said, by name.
  const throws = async () => {
    throw new Error("db said no");
  };

  it("13a: the move threw, Pete's OUT and Dan's IN landed: 'Pete is out. Dan is in.', no sheet, not a team post", async () => {
    const { out, degradations } = await replace(throws);
    expect(out.reply).toBe("🔁 *Pete is out*. *Dan* is in.");
    expect(out.deterministicTeamPost).toBe(false);
    expect(out.teamSheetWritten).toBe(false);
    expect(degradations.join(" ")).toMatch(/did not move/);
  });

  it("13b: the move threw and Pete's OUT did not land: only Dan's IN is said", async () => {
    const { out } = await replace(throws, async () => {
      throw new Error("cancel failed");
    });
    expect(out.reply ?? "").toContain("🔁 *Dan* is in.");
    expect(out.reply ?? "").not.toMatch(/Pete is out|takes his place|Teams for/);
    expect(out.deterministicTeamPost).toBe(false);
  });

  it("in Turkish", async () => {
    const { out } = await replace(throws, undefined, undefined, "tr");
    expect(out.reply).toBe("🔁 *Pete* yok. *Dan* kadroda.");
  });
});
