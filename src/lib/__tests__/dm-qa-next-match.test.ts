/**
 * THE DM ANSWER DESCRIBES THE CLUB'S NEXT MATCH (club summary, slice B4, D7).
 *
 * Before B4 the DM answer took the earliest live match of the club, with no
 * date floor: a match left live from last week (the completion cron missed
 * it) was described to the model as "UPCOMING MATCH", while an IN by DM or in
 * the group was refused for it (`selectRegistrationMatch` blocks while it is
 * in flight). It now reads the one rule (`next-match.ts`): the same match an
 * IN lands on, so in that edge it says no match is scheduled, as the IN does.
 *
 * Drives `answerScopedQuestion` in its stub mode, which returns the CONTEXT
 * the model would be shown.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  matches: [] as Array<Record<string, unknown>>,
}));

const live = (r: Record<string, unknown>) => ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"].includes(String(r.status));
const byDate = (a: Record<string, unknown>, b: Record<string, unknown>) => (a.date as Date).getTime() - (b.date as Date).getTime();

vi.mock("@/lib/db", () => ({
  db: {
    organisation: {
      findUnique: async () => ({ id: "org-1", name: "Sutton FC", language: "en", featureStatsQa: true }),
    },
    // The pre-B4 read: the earliest live match, no date floor.
    match: {
      findFirst: async () => [...h.matches].filter(live).sort(byDate)[0] ?? null,
      findMany: async ({ where }: { where: { isHistorical?: boolean; status?: { in: string[] } } }) =>
        [...h.matches].filter((m) => (!where.status || where.status.in.includes(String(m.status))) && (where.isHistorical !== false || !m.isHistorical)).sort(byDate),
      findUnique: async () => null,
    },
    attendance: { findMany: async () => [] },
    user: { findMany: async () => [], findUnique: async () => null },
    sentNotification: { findMany: async () => [] },
    botJob: { findMany: async () => [] },
  },
}));
vi.mock("@/lib/player-stats", () => ({ loadPlayerSeasonStats: async () => null }));
vi.mock("@/lib/match-history", () => ({ loadRecentHistory: async () => null, formatRecentHistoryBlock: () => "" }));
vi.mock("@/lib/my-payments", () => ({ loadMyPayments: async () => null }));
vi.mock("@/lib/reply-context", async (orig) => ({
  ...(await orig<typeof import("@/lib/reply-context")>()),
  loadDmReplyContext: async () => ({ now: new Date(), quoted: null, recent: [], earlier: null }),
}));

import { answerScopedQuestion } from "../dm-qa";

function match(id: string, date: string, status = "UPCOMING") {
  return {
    id,
    date: new Date(date),
    status,
    isHistorical: false,
    maxPlayers: 14,
    feePerPlayer: null,
    activity: { name: "Tuesday 7-a-side", venue: "Goals North Cheam", feePerPlayer: 6, feeSplitTotal: false },
    attendances: [],
  };
}

async function contextAt(now: string): Promise<string> {
  vi.setSystemTime(new Date(now));
  const r = await answerScopedQuestion({ userId: "u-me", orgId: "org-1", question: "when is the next game?" });
  return r!.answer;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  delete process.env.ANTHROPIC_API_KEY;
  process.env.MT_TEST_DM_QA_STUB = "1";
});

describe("the DM answer's UPCOMING MATCH is the club's next match (B4)", () => {
  it("a normal week: this week's match", async () => {
    h.matches = [match("tue-10", "2026-11-10T21:30:00.000Z"), match("tue-17", "2026-11-17T21:30:00.000Z")];
    const ctx = await contextAt("2026-11-09T12:00:00.000Z");
    expect(ctx).toContain("UPCOMING MATCH:");
    expect(ctx).toContain("Tue 10 Nov");
    expect(ctx).not.toContain("Tue 17 Nov");
  });

  it("THE EDGE: a match left live from last week is not described as upcoming; no match is, as an IN would be refused", async () => {
    h.matches = [match("tue-3-stuck", "2026-11-03T21:30:00.000Z"), match("tue-10", "2026-11-10T21:30:00.000Z")];
    const ctx = await contextAt("2026-11-09T12:00:00.000Z");
    expect(ctx).not.toContain("Tue 3 Nov");
    expect(ctx).toContain("UPCOMING MATCH: none scheduled right now.");
  });

  it("today's match after kickoff, not yet completed, is still the next match until the cron completes it", async () => {
    h.matches = [match("tue-10", "2026-11-10T21:30:00.000Z"), match("tue-17", "2026-11-17T21:30:00.000Z")];
    const ctx = await contextAt("2026-11-10T22:45:00.000Z");
    expect(ctx).toContain("Tue 10 Nov");
  });

  it("a cancelled match is never the next match", async () => {
    h.matches = [match("tue-10", "2026-11-10T21:30:00.000Z", "CANCELLED"), match("tue-17", "2026-11-17T21:30:00.000Z")];
    const ctx = await contextAt("2026-11-09T12:00:00.000Z");
    expect(ctx).toContain("Tue 17 Nov");
  });
});
