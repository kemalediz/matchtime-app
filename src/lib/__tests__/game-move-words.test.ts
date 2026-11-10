/**
 * The WhatsApp door for moving a game (Kemal, 2026-11-10): the club's games
 * to come, read for the model, and the checked reading carried out through
 * the one kickoff mover (`activity-kickoff-move.ts`), with the reply the
 * organiser reads. The mover is mocked at its module boundary; what is under
 * test is which call is made and what is said.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  match: { findMany: vi.fn() },
  activity: { findMany: vi.fn() },
}));
vi.mock("../db", () => ({ db: dbMock }));
const mover = vi.hoisted(() => ({ moveOneGame: vi.fn(), changeActivityKickoff: vi.fn(), NOT_PLAYED_STATUSES: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] }));
vi.mock("../activity-kickoff-move", () => mover);

import { applyMoveGameWords, loadGamesToCome } from "../game-move-words";
import { londonDateTimeToUtc } from "../london-time";

const at = (date: string, time: string) => londonDateTimeToUtc(date, time);
const NOW = at("2026-11-10", "10:00");
const MON = { id: "m-mon", date: at("2026-11-16", "20:30"), activityId: "vets", activityName: "Monday Vets" };
const THU = { id: "m-thu", date: at("2026-11-19", "19:00"), activityId: "sevens", activityName: "Thursday 7s" };
const MON2 = { id: "m-mon2", date: at("2026-11-23", "20:30"), activityId: "vets", activityName: "Monday Vets" };
const words = (w: Partial<{ game: number | null; newDay: number | null; newTime: string | null; everyWeek: boolean }>) => ({ game: null, newDay: null, newTime: null, everyWeek: false, ...w });

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.activity.findMany.mockResolvedValue([{ id: "vets", name: "Monday Vets" }]);
});

describe("loadGamesToCome", () => {
  it("the club's next games still to be played, soonest first, at most six", async () => {
    dbMock.match.findMany.mockResolvedValue([{ id: "m-mon", date: MON.date, activity: { id: "vets", name: "Monday Vets" } }]);
    expect(await loadGamesToCome("club", NOW)).toEqual([MON]);
    expect(dbMock.match.findMany).toHaveBeenCalledWith({
      where: { activity: { orgId: "club" }, status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] }, isHistorical: false, date: { gt: NOW } },
      select: { id: true, date: true, activity: { select: { id: true, name: true } } },
      orderBy: { date: "asc" },
      take: 6,
    });
  });
});

describe("applyMoveGameWords: one game", () => {
  it("moves the game the model picked, and says so in the club's language", async () => {
    mover.moveOneGame.mockResolvedValue({ moved: true, matchId: "m-mon", from: MON.date, to: at("2026-11-16", "20:15") });
    const r = await applyMoveGameWords({ orgId: "club", words: words({ game: 1, newTime: "20:15" }), games: [MON, MON2], lang: "en", now: NOW });
    expect(mover.moveOneGame).toHaveBeenCalledWith({ matchId: "m-mon", orgId: "club", toDayOfWeek: null, toTime: "20:15", now: NOW });
    expect(r).toEqual({ outcome: "game-move-moved", replyText: "✅ Done: the game on Mon 16 Nov is now at 20:15 (it was 20:30).\nI haven't posted anything in the players' group." });
  });

  it("a new day names both days (Turkish)", async () => {
    mover.moveOneGame.mockResolvedValue({ moved: true, matchId: "m-mon", from: MON.date, to: at("2026-11-18", "20:30") });
    const r = await applyMoveGameWords({ orgId: "club", words: words({ game: 1, newDay: 3 }), games: [MON], lang: "tr", now: NOW });
    expect(mover.moveOneGame).toHaveBeenCalledWith(expect.objectContaining({ toDayOfWeek: 3, toTime: "20:30" }));
    expect(r.replyText).toBe("✅ Tamam: 16 Kasım Pazartesi maçı taşındı, artık 18 Kasım Çarşamba, saat 20:30.\nOyuncu grubuna bir şey yazmadım.");
  });

  it("a game that stays says why, and nothing more", async () => {
    mover.moveOneGame.mockResolvedValue({ moved: false, matchId: "m-mon", reason: "started", from: MON.date });
    const r = await applyMoveGameWords({ orgId: "club", words: words({ game: 1, newTime: "20:15" }), games: [MON], lang: "en", now: NOW });
    expect(r).toEqual({ outcome: "game-move-stayed-started", replyText: "The game on Mon 16 Nov has already kicked off, so I've left it as it is." });
  });

  it("several games and none named: one question naming each, nothing moved", async () => {
    dbMock.activity.findMany.mockResolvedValue([{ id: "vets", name: "Monday Vets" }, { id: "sevens", name: "Thursday 7s" }]);
    const r = await applyMoveGameWords({ orgId: "club", words: words({ newTime: "20:15" }), games: [MON, THU], lang: "en", now: NOW });
    expect(mover.moveOneGame).not.toHaveBeenCalled();
    expect(r).toEqual({
      outcome: "game-move-which",
      replyText: "Which game shall I move to 20:15: Mon 16 Nov 20:30 (Monday Vets) or Thu 19 Nov 19:00 (Thursday 7s)? Tag me again and name the day, for example *@Match Time move Monday's game to 20:15*.",
    });
  });

  it("one weekly game: the question names the dates only", async () => {
    const r = await applyMoveGameWords({ orgId: "club", words: words({ newDay: 3, newTime: "20:15" }), games: [MON, MON2], lang: "en", now: NOW });
    expect(r.replyText).toBe("Which game shall I move to Wednesday 20:15: Mon 16 Nov 20:30 or Mon 23 Nov 20:30? Tag me again and name the day, for example *@Match Time move Monday's game to 20:15*.");
  });

  it("no new day and no time: asks what to, nothing moved", async () => {
    const r = await applyMoveGameWords({ orgId: "club", words: words({ game: 1 }), games: [MON], lang: "en", now: NOW });
    expect(r.outcome).toBe("game-move-say-what");
    expect(mover.moveOneGame).not.toHaveBeenCalled();
  });

  it("no games coming", async () => {
    const r = await applyMoveGameWords({ orgId: "club", words: words({ game: 1, newTime: "20:15" }), games: [], lang: "en", now: NOW });
    expect(r).toEqual({ outcome: "game-move-no-games", replyText: "There's no game coming up to move." });
  });
});

describe("applyMoveGameWords: the weekly game, from now on", () => {
  it("changes the activity through the one save, and lists what moved and what stayed", async () => {
    mover.changeActivityKickoff.mockResolvedValue({
      ok: true,
      activityName: "Monday Vets",
      before: { dayOfWeek: 1, time: "20:30" },
      after: { dayOfWeek: 1, time: "20:15" },
      moved: [{ matchId: "m-mon2", from: MON2.date, to: at("2026-11-23", "20:15") }],
      stayed: [{ matchId: "m-mon", reason: "set-by-hand", at: MON.date }],
    });
    const r = await applyMoveGameWords({ orgId: "club", words: words({ newTime: "20:15", everyWeek: true }), games: [MON, MON2], lang: "en", now: NOW });
    expect(mover.changeActivityKickoff).toHaveBeenCalledWith({ activityId: "vets", orgId: "club", time: "20:15", now: NOW });
    expect(r).toEqual({
      outcome: "game-move-weekly-moved",
      replyText:
        "✅ Done: *Monday Vets* kicks off at 20:15 every Monday from now on.\nMoved: Mon 23 Nov.\nLeft as they were: Mon 16 Nov (set to its own time by hand).\nI haven't posted anything in the players' group.",
    });
  });

  it("a new day, in Turkish", async () => {
    mover.changeActivityKickoff.mockResolvedValue({ ok: true, activityName: "Pazartesi Maçı", before: { dayOfWeek: 1, time: "20:30" }, after: { dayOfWeek: 2, time: "20:30" }, moved: [], stayed: [] });
    const r = await applyMoveGameWords({ orgId: "club", words: words({ newDay: 2, everyWeek: true }), games: [], lang: "tr", now: NOW });
    expect(mover.changeActivityKickoff).toHaveBeenCalledWith({ activityId: "vets", orgId: "club", dayOfWeek: 2, now: NOW });
    expect(r.replyText).toBe("✅ Tamam: *Pazartesi Maçı* bundan sonra her Salı saat 20:30.\nOyuncu grubuna bir şey yazmadım.");
  });

  it("already that day and time", async () => {
    mover.changeActivityKickoff.mockResolvedValue({ ok: false, reason: "unchanged", activityName: "Monday Vets", kickoff: { dayOfWeek: 1, time: "20:15" } });
    const r = await applyMoveGameWords({ orgId: "club", words: words({ newTime: "20:15", everyWeek: true }), games: [], lang: "en", now: NOW });
    expect(r).toEqual({ outcome: "game-move-weekly-unchanged", replyText: "*Monday Vets* already kicks off at 20:15 every Monday." });
  });

  it("two weekly games and none named: asks which, nothing changed", async () => {
    dbMock.activity.findMany.mockResolvedValue([{ id: "vets", name: "Monday Vets" }, { id: "sevens", name: "Thursday 7s" }]);
    const r = await applyMoveGameWords({ orgId: "club", words: words({ newTime: "20:15", everyWeek: true }), games: [MON, THU], lang: "en", now: NOW });
    expect(mover.changeActivityKickoff).not.toHaveBeenCalled();
    expect(r).toEqual({ outcome: "game-move-which-weekly", replyText: "Which weekly game moves to 20:15 from now on: *Monday Vets* or *Thursday 7s*? Tag me again and name it." });
  });

  it("reads only the club's active weekly games", async () => {
    await applyMoveGameWords({ orgId: "club", words: words({ newTime: "20:15", everyWeek: true }), games: [], lang: "en", now: NOW });
    expect(dbMock.activity.findMany).toHaveBeenCalledWith({ where: { orgId: "club", isActive: true }, select: { id: true, name: true }, orderBy: { createdAt: "asc" } });
  });
});
