/**
 * `loadLastMom` reads the club's later matches for the scheduler's
 * next-fixture stop (review 2026-11-15), so a match whose announcement was
 * given up on is decided. The database is stubbed: no reads, no writes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  organisation: { findUnique: vi.fn() },
  match: { findMany: vi.fn() },
  moMVote: { groupBy: vi.fn() },
  sentNotification: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
}));
vi.mock("../../db", () => ({ db }));

import { loadLastMom } from "../load-stats";

const NOW = new Date("2026-11-15T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ACT = { orgId: "org-1", venue: "Goals Sutton", dayOfWeek: 2 };
const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY);

const voted = (id: string, daysAgo: number) => ({
  id,
  date: at(daysAgo),
  redScore: 5,
  yellowScore: 3,
  teamLabels: null,
  activityId: "act-tue",
  activity: { ...ACT, sport: { teamLabels: null } },
});

beforeEach(() => {
  vi.clearAllMocks();
  db.organisation.findUnique.mockResolvedValue({ teamLabels: null, language: "en", momChosenBy: "players" });
  db.match.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) => {
    if ("momVotes" in args.where) return [voted("B", 1), voted("A", 4), voted("C", 14)];
    return [
      { id: "B", date: at(1), status: "COMPLETED", activityId: "act-tue", activity: ACT },
      { id: "A", date: at(4), status: "COMPLETED", activityId: "act-tue", activity: ACT },
    ];
  });
  db.moMVote.groupBy.mockResolvedValue([
    { matchId: "B", playerId: "u-sait", _count: { playerId: 4 } },
    { matchId: "A", playerId: "u-habib", _count: { playerId: 3 } },
    { matchId: "C", playerId: "u-mojib", _count: { playerId: 5 } },
  ]);
  db.sentNotification.findMany.mockResolvedValue([{ key: "C:mom-announcement" }]);
  db.user.findMany.mockResolvedValue([
    { id: "u-sait", name: "Sait" },
    { id: "u-habib", name: "Habib" },
    { id: "u-mojib", name: "Mojib" },
  ]);
});

describe("loadLastMom", () => {
  it("a match superseded by its next fixture is the last MoM; the open vote is named by date only", async () => {
    const f = await loadLastMom("org-1", NOW);
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Habib"]);
    expect(f.last!.date.getTime()).toBe(at(4).getTime());
    expect(f.openVoteDate!.getTime()).toBe(at(1).getTime());
  });

  it("reads the later matches as the scheduler does: this club, not historical, not cancelled, kicked off", async () => {
    await loadLastMom("org-1", NOW);
    const fixtureCall = db.match.findMany.mock.calls.map((c) => c[0]).find((a) => !("momVotes" in a.where));
    expect(fixtureCall.where).toEqual({
      activity: { orgId: "org-1" },
      isHistorical: false,
      status: { not: "CANCELLED" },
      date: { gt: at(14), lte: NOW },
    });
  });
});
