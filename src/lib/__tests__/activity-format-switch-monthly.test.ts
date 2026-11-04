/**
 * A MONTHLY CLUB'S GAME STAYS ON ITS GAME (club summary, slice B2, K8 a).
 *
 * The one month phase matches a game to its month by the game's Activity.
 * The older switch to ANOTHER of the club's games (`switchMatchToActivity`,
 * Sutton's 7-a-side to its 5-a-side) re-points `Match.activityId`, which
 * would take a month's game out of its month (no list, its regulars' INs
 * held, every post held). So for a monthly club it is refused with one
 * plain line, on the web and in WhatsApp; the size switch inside the game
 * (`format-resize.ts`, the Vets' 6, 7 or 8 a side) keeps the match on its
 * Activity and is untouched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  match: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  activity: { findFirst: vi.fn(), findMany: vi.fn() },
}));
vi.mock("../db", () => ({ db: dbMock }));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { MonthlyGameStaysError, switchMatchToActivity } from "@/lib/activity-format-switch";
import { applySwitchFormatWords } from "@/lib/format-switch-words";
import { flexFormatCopy } from "@/lib/i18n/flex-format";

const match = (squadMode: string, language = "en") => ({
  id: "m1",
  date: new Date("2026-11-09T20:30:00Z"),
  activityId: "a7",
  activity: { id: "a7", orgId: "org", name: "Vets 7s", time: "20:30", sport: { name: "Football 7-a-side", playersPerTeam: 7 }, org: { language, listAnnouncer: "matchtime", squadMode } },
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.activity.findFirst.mockResolvedValue(null);
});

describe("switchMatchToActivity", () => {
  it("a monthly club: refused with the plain line, nothing written", async () => {
    dbMock.match.findUnique.mockResolvedValue(match("monthly"));
    const err = await switchMatchToActivity({ matchId: "m1", newActivityId: "a5", actorUserId: "u" }).catch((e) => e);
    expect(err).toBeInstanceOf(MonthlyGameStaysError);
    expect(err.message).toBe(flexFormatCopy("en").monthlyKeepsGame({ activityName: "Vets 7s" }));
    expect(dbMock.activity.findFirst).not.toHaveBeenCalled();
    expect(dbMock.match.update).not.toHaveBeenCalled();
  });

  it("in Turkish for a Turkish club", async () => {
    dbMock.match.findUnique.mockResolvedValue(match("monthly", "tr"));
    const err = await switchMatchToActivity({ matchId: "m1", newActivityId: "a5", actorUserId: "u" }).catch((e) => e);
    expect(err.message).toBe(flexFormatCopy("tr").monthlyKeepsGame({ activityName: "Vets 7s" }));
  });

  it("REGRESSION GUARD: a weekly club goes on to the switch (here: the target is not found)", async () => {
    dbMock.match.findUnique.mockResolvedValue(match("weekly"));
    await expect(switchMatchToActivity({ matchId: "m1", newActivityId: "a5", actorUserId: "u" })).rejects.toThrow("Target activity not found");
    expect(dbMock.activity.findFirst).toHaveBeenCalled();
  });
});

describe("the WhatsApp door: '@Match Time switch to 5 a side' in a monthly club", () => {
  it("answers with the same line and changes nothing", async () => {
    dbMock.match.findMany.mockResolvedValue([{ id: "m1", date: new Date("2026-11-09T20:30:00Z"), status: "UPCOMING" }]);
    // The match's own game has one size; the club has a 5-a-side game too.
    dbMock.match.findUnique.mockImplementation(async (args: { select?: { activity?: unknown } }) =>
      args.select ? { activity: { id: "a7", orgId: "org", minPlayers: null, maxPlayers: null, sport: { name: "Football 7-a-side", playersPerTeam: 7 } } } : match("monthly"),
    );
    dbMock.activity.findMany.mockResolvedValue([{ id: "a5", name: "Vets 5s", sport: { name: "Football 5-a-side", playersPerTeam: 5 } }]);
    const r = await applySwitchFormatWords({ orgId: "org", perSide: 5, matchDay: null, actorUserId: "u", via: "hq", lang: "en", now: new Date("2026-11-04T12:00:00Z"), explicit: true });
    expect(r).toEqual({ outcome: "format-monthly-keeps-game", replyText: flexFormatCopy("en").monthlyKeepsGame({ activityName: "Vets 7s" }) });
    expect(dbMock.match.update).not.toHaveBeenCalled();
  });
});
