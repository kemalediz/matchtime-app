/**
 * `loadLastMom` reads the club's later matches for the scheduler's
 * next-fixture stop (review 2026-11-15), so a match whose announcement was
 * given up on is decided. The database is stubbed: no reads, no writes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  organisation: { findUnique: vi.fn() },
  match: { findMany: vi.fn() },
  moMVote: { findMany: vi.fn() },
  sentNotification: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
}));
vi.mock("../../db", () => ({ db }));

import { loadLastMom } from "../load-stats";

const NOW = new Date("2026-11-15T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ACT = { orgId: "org-1", venue: "Goals Sutton", dayOfWeek: 2 };
const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY);

const voted = (id: string, daysAgo: number, ratingWindowHours = 72) => ({
  id,
  date: at(daysAgo),
  redScore: 5,
  yellowScore: 3,
  teamLabels: null,
  activityId: "act-tue",
  activity: { ...ACT, ratingWindowHours, sport: { teamLabels: null } },
});
/** A's rating window (hours): 72 has closed by now (4 days on), 120 has not. */
let aWindow = 72;

/** One row per voter (who voted is never selected): the player voted for,
 *  and when the row was recorded. */
const rows = (matchId: string, playerId: string, n: number, recorded: Date) =>
  Array.from({ length: n }, () => ({ matchId, playerId, createdAt: recorded }));
const VOTES = [...rows("B", "u-sait", 4, at(0.5)), ...rows("A", "u-habib", 3, at(3)), ...rows("C", "u-mojib", 5, at(13))];

beforeEach(() => {
  vi.clearAllMocks();
  aWindow = 72;
  db.organisation.findUnique.mockResolvedValue({ teamLabels: null, language: "en", momChosenBy: "players" });
  db.match.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) => {
    if ("momVotes" in args.where) return [voted("B", 1), voted("A", 4, aWindow), voted("C", 14)];
    return [
      { id: "B", date: at(1), status: "COMPLETED", activityId: "act-tue", activity: ACT },
      { id: "A", date: at(4), status: "COMPLETED", activityId: "act-tue", activity: ACT },
    ];
  });
  db.moMVote.findMany.mockResolvedValue(VOTES);
  // C's result was posted 9 days after it was played.
  db.sentNotification.findMany.mockResolvedValue([{ key: "C:mom-announcement", createdAt: at(9) }]);
  db.user.findMany.mockResolvedValue([
    { id: "u-sait", name: "Sait" },
    { id: "u-habib", name: "Habib" },
    { id: "u-mojib", name: "Mojib" },
  ]);
});

describe("loadLastMom", () => {
  it("a match superseded by its next fixture, its vote window over, is the last MoM; the open vote is named by date only", async () => {
    const f = await loadLastMom("org-1", NOW);
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Habib"]);
    expect(f.last!.date.getTime()).toBe(at(4).getTime());
    expect(f.openVoteDate!.getTime()).toBe(at(1).getTime());
  });

  it("its vote window (the activity's ratingWindowHours) still open: not told; the announced one is", async () => {
    aWindow = 120;
    const f = await loadLastMom("org-1", NOW);
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Mojib"]);
    expect(f.last!.date.getTime()).toBe(at(14).getTime());
  });

  // Round 2 of the review of #605: votes recorded after C's announcement
  // (its window was still open) do not change what is told about it.
  it("an announced match is told as announced: votes recorded after the post are not counted", async () => {
    aWindow = 120;
    db.moMVote.findMany.mockResolvedValue([...VOTES, ...rows("C", "u-habib", 6, at(8.5))]);
    const f = await loadLastMom("org-1", NOW);
    expect(f.last!.date.getTime()).toBe(at(14).getTime());
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Mojib"]);
    expect(f.last!.tally.map((t) => `${t.name} ${t.votes}`)).toEqual(["Mojib 5"]);
    expect(f.last!.totalVotes).toBe(5);
  });

  it("reads the votes one row each, never who voted", async () => {
    await loadLastMom("org-1", NOW);
    const select = db.moMVote.findMany.mock.calls[0][0].select;
    expect(select).toEqual({ matchId: true, playerId: true, createdAt: true });
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
