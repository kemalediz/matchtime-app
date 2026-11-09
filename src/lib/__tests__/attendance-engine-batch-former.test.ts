/**
 * A FORMER MEMBER NAMED BACK IN, through the attendance batch (review of
 * #574, round 3, B5): who-is-who is shown him marked (former); sure of him
 * in an IN claim, the batch restores his membership and the engine
 * registers HIM, not a new person of his name.
 */
import { describe, expect, it } from "vitest";
import { runAttendanceEngineBatch, type EngineBatchDeps, type EngineBatchMessage } from "../attendance-engine-batch";
import type { SquadState } from "../pipeline/types";
import type { PipelineModel } from "../pipeline/llm";
import type { PersonPick, PersonPicker, WhoRequest } from "../pipeline/who-is-who";

const OLDHAM = { userId: "u-oldham", name: "Oldham Jones", isAdmin: false, hasPhone: true };

function state(): SquadState {
  return {
    matchId: "match-1",
    maxPlayers: 4,
    kickoffLabel: "Tue 20:00",
    venue: "The Pitch",
    rows: [],
    roster: [{ userId: "u-pete", name: "Pete Power", isAdmin: false, hasPhone: true }],
    formerMembers: [OLDHAM],
    openOffers: [],
    teams: [],
    teamLabels: ["Red", "Yellow"],
    completedMatch: null,
    payments: null,
    ratingProgress: null,
    lastBotPost: null,
    features: { attendance: true, paymentTracking: false, statsQa: false, reminders: false, language: "en" },
    smallerFormats: [],
    guestAskedUserIds: [],
  };
}

const facts = (polarity: "in" | "out") => ({
  claims: [
    {
      subject: "other",
      personRef: "Oldham",
      personNamed: true,
      personKind: "named",
      polarity,
      contingent: false,
      conditionOn: "none",
      tense: "present",
      reported: false,
      confidence: 0.95,
    },
  ],
  affirmation: "none",
  sideRequests: [],
});

function model(body: Record<string, unknown>): PipelineModel {
  return {
    name: "fake",
    async complete() {
      return {
        text: JSON.stringify(body),
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
        ms: 1,
      };
    },
  };
}

const msgBy = (senderIsAdmin: boolean): EngineBatchMessage => ({
  waMessageId: "wa-1",
  body: "@Match Time Oldham's back tonight, put him in",
  authorName: "Pete Power",
  senderUserId: "u-pete",
  senderName: "Pete Power",
  senderIsAdmin,
  tagged: true,
  route: "other_att",
  gated: false,
});

async function run(polarity: "in" | "out", organiser = true) {
  const registered: string[] = [];
  const provisioned: string[] = [];
  const restored: string[] = [];
  const asked: WhoRequest[] = [];
  const identify: PersonPicker = async (req) => {
    asked.push(req);
    const picks = new Map<string, Map<string, PersonPick>>();
    for (const m of req.messages) picks.set(m.id, new Map(m.refs.map((r) => [r, { kind: "member", userId: OLDHAM.userId } as PersonPick])));
    return { picks, usage: null, degradations: [] };
  };
  const deps = {
    model: model(facts(polarity)),
    identify,
    loadState: async () => state(),
    openBenchPromptUserIds: async () => [],
    claimGuestNameAsk: async () => true,
    restoreMember: async (_org: string, userId: string) => {
      restored.push(userId);
    },
    async registerAttendance(userId: string) {
      registered.push(userId);
      return { status: "CONFIRMED" as const, position: 1, slot: 1, confirmedCount: 1, maxPlayers: 4 };
    },
    async cancelAttendance() {
      return { status: "DROPPED" as const };
    },
    async resolveOrProvision(name: string) {
      provisioned.push(name);
      return { userId: `new:${name}` };
    },
  } as unknown as EngineBatchDeps;
  await runAttendanceEngineBatch({
    orgId: "org-1",
    now: new Date("2026-09-03T12:00:00Z"),
    messages: [msgBy(organiser)],
    history: [],
    expectedMatchId: "match-1",
    enabled: true,
    deps,
  });
  return { registered, provisioned, restored, asked };
}

describe("a former member named back in (by an organiser)", () => {
  it("is shown to who-is-who marked former, restored, and registered as himself", async () => {
    const r = await run("in");
    expect(r.asked[0].roster.find((m) => m.userId === OLDHAM.userId)).toMatchObject({ former: true });
    expect(r.restored).toEqual([OLDHAM.userId]);
    expect(r.registered).toEqual([OLDHAM.userId]);
    expect(r.provisioned).toEqual([]);
  });

  it("named in by a player who is no organiser: not brought back, nor registered as himself", async () => {
    const r = await run("in", false);
    expect(r.restored).toEqual([]);
    expect(r.registered).not.toContain(OLDHAM.userId);
  });

  it("named OUT, he is not brought back", async () => {
    const r = await run("out");
    expect(r.restored).toEqual([]);
    expect(r.registered).toEqual([]);
  });
});
