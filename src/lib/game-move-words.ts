/**
 * A GAME'S DAY OR TIME CHANGED BY WHATSAPP (Kemal, 2026-11-10: every admin
 * feature also works by tagging MatchTime). "@Match Time move Monday's game
 * to 8:15", "@Match Time from now on we kick off at 8:15", "@Match Time
 * pazartesi maçını 20:15'e al".
 *
 * The admin extractor (the model) is shown the club's games to come
 * (`loadGamesToCome`, numbered by `gamesToComeLines`) and reads the message
 * into `move_game` facts. `game-move-rules.ts` checks them; this door then
 * carries them out through the ONE place a kickoff moves
 * (`activity-kickoff-move.ts`), the same code the activities page uses:
 *
 *   one game       `moveOneGame`: the game, its sign-up deadline, open
 *                  partner asks, a maybe's follow-up and open pool offers,
 *                  exactly as #577 moves each game of a weekly change;
 *   every week     `changeActivityKickoff`: the activity's day or time,
 *                  checked as the edit form checks it, and its games still
 *                  to be played with it (games started, set by hand, gone,
 *                  or pushed into another month stay where they are).
 *
 * QUIET, as the web change is: nothing is posted in the players' group and
 * nobody is DM'd. The reply goes to the organiser who asked, says what
 * moved and what stayed and why, and that the players' group was not told.
 * No confirmation step: like the club's other settings changed by a tag
 * (quiet hours, player numbers, a game's size), it is done at once.
 *
 * Organisers only, with a real tag: the callers check, as for every admin
 * action (`admin-group-understand.ts`, `admin-ops-engine-batch.ts`).
 */
import { db } from "./db";
import { changeActivityKickoff, moveOneGame, NOT_PLAYED_STATUSES } from "./activity-kickoff-move";
import { GAMES_TO_COME_MAX, planMoveGame, type GameToCome, type MoveGameWords } from "./game-move-rules";
import { gameMoveCopy } from "./i18n/game-move";
import { dayLabel, timeLabel, weekdayLabel } from "./i18n/dates";
import { normaliseLang } from "./i18n/lang";
import { londonDateTimeToUtc } from "./london-time";

export interface GameMoveReply {
  outcome: string;
  replyText: string;
}

/** The club's next games still to be played, soonest first: what the model
 *  is shown, and what its game number is checked against. */
export async function loadGamesToCome(orgId: string, now: Date): Promise<GameToCome[]> {
  const rows = await db.match.findMany({
    where: { activity: { orgId }, status: { in: [...NOT_PLAYED_STATUSES] }, isHistorical: false, date: { gt: now } },
    select: { id: true, date: true, activity: { select: { id: true, name: true } } },
    orderBy: { date: "asc" },
    take: GAMES_TO_COME_MAX,
  });
  return rows.map((r) => ({ id: r.id, date: r.date, activityId: r.activity.id, activityName: r.activity.name }));
}

/** A weekday's name in the club's language, 0 = Sunday: "Monday", "Pazartesi". */
function weekdayName(lang: string, dayOfWeek: number): string {
  // Monday 16 November 2026 plus the weekday's place in a Monday-first week.
  const day = 16 + ((dayOfWeek + 6) % 7);
  return weekdayLabel(lang, londonDateTimeToUtc(`2026-11-${day}`, "12:00"));
}

export async function applyMoveGameWords(p: {
  orgId: string;
  words: MoveGameWords;
  /** The games the model was shown, in the same order. */
  games: readonly GameToCome[];
  lang: string | null;
  now: Date;
}): Promise<GameMoveReply> {
  const lang = normaliseLang(p.lang);
  const c = gameMoveCopy(lang);
  const weekly = await db.activity.findMany({
    where: { orgId: p.orgId, isActive: true },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
  const plan = planMoveGame(p.words, p.games, weekly);
  const change = (toDayOfWeek: number | null, toTime: string | null) =>
    [toDayOfWeek !== null ? weekdayName(lang, toDayOfWeek) : "", toTime ?? ""].filter(Boolean).join(" ");
  const say = (outcome: string, replyText: string): GameMoveReply => {
    console.log(`[game-move-words] org=${p.orgId}: ${outcome}`);
    return { outcome, replyText };
  };

  switch (plan.kind) {
    case "say-what":
      return say("game-move-say-what", c.sayWhat);
    case "no-games":
      return say("game-move-no-games", c.noGames);
    case "which": {
      const named = new Set(plan.options.map((g) => g.activityId)).size > 1;
      const options = plan.options.map((g) => `${dayLabel(lang, g.date)} ${timeLabel(g.date)}${named ? ` (${g.activityName})` : ""}`);
      return say("game-move-which", c.which({ options, change: change(plan.toDayOfWeek, plan.toTime) }));
    }
    case "which-weekly":
      return say("game-move-which-weekly", c.whichWeekly({ options: plan.options.map((o) => o.name), change: change(plan.toDayOfWeek, plan.toTime) }));
    case "one": {
      const r = await moveOneGame({ matchId: plan.game.id, orgId: p.orgId, toDayOfWeek: plan.toDayOfWeek, toTime: plan.toTime, now: p.now });
      const from = r.from ?? plan.game.date;
      const day = dayLabel(lang, from);
      if (r.moved) {
        const sameDay = dayLabel(lang, r.to) === day;
        console.log(`[game-move-words] org=${p.orgId} match=${r.matchId} moved ${r.from.toISOString()} to ${r.to.toISOString()}`);
        return say("game-move-moved", c.movedOne({ day, toDay: sameDay ? null : dayLabel(lang, r.to), time: timeLabel(r.to), was: timeLabel(from) }));
      }
      return say(`game-move-stayed-${r.reason}`, c.stayedOne({ reason: r.reason, day, time: timeLabel(from), to: plan.toTime }));
    }
    case "every-week": {
      const r = await changeActivityKickoff({
        activityId: plan.activityId,
        orgId: p.orgId,
        ...(plan.dayOfWeek !== undefined ? { dayOfWeek: plan.dayOfWeek } : {}),
        ...(plan.time !== undefined ? { time: plan.time } : {}),
        now: p.now,
      });
      if (r.ok) {
        console.log(`[game-move-words] org=${p.orgId} activity=${plan.activityId} weekly ${r.moved.length} moved, ${r.stayed.length} stayed`);
        return say(
          "game-move-weekly-moved",
          c.movedWeekly({
            name: r.activityName,
            weekday: weekdayName(lang, r.after.dayOfWeek),
            time: r.after.time,
            moved: r.moved.map((m) => dayLabel(lang, m.to)),
            stayed: r.stayed.map((s) => ({ day: dayLabel(lang, s.at), reason: s.reason })),
          }),
        );
      }
      if (r.reason === "unchanged") {
        return say("game-move-weekly-unchanged", c.weeklyUnchanged({ name: r.activityName, weekday: weekdayName(lang, r.kickoff.dayOfWeek), time: r.kickoff.time }));
      }
      if (r.reason === "invalid") return say("game-move-invalid", c.invalid);
      return say("game-move-no-games", c.noGames);
    }
  }
}
