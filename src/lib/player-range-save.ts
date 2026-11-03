/**
 * THE ONE SAVE FOR A GAME'S FEWEST AND MOST PLAYERS (2026-11-03), used by the
 * activities page's server action (which checks the admin first) and by
 * WhatsApp (`player-range-words.ts`, organisers only, checked by the
 * callers). The check is `checkPlayerRange` (flex-format-rules.ts): even
 * numbers, the minimum up to the game's places, the maximum from them up.
 *
 * Only the side given is checked and written: `undefined` keeps what is
 * stored (so a minimum of 13 saved before minimums were even does not block
 * setting a maximum). The game's own places are stored as null.
 *
 * A NARROWING THAT WOULD LEAVE OUT A SWITCHED MATCH IS REFUSED (review of
 * #517): a match still to come that was switched to a size the new numbers
 * do not allow (8-a-side, then the maximum cleared) would be stranded.
 * Re-sizing it here would move players and DM them from a settings page;
 * so the organiser is told to switch it back first, and nothing is saved.
 */
import { db } from "./db";
import { checkPlayerRange, playerRange, sideAllowed, sidesInRange, PLAYERS_CEILING, type RangeError } from "./flex-format-rules";

export type PlayerRangeSave =
  | {
      ok: true;
      changed: boolean;
      /** As stored (null: the game's own places). */
      minPlayers: number | null;
      maxPlayers: number | null;
      /** As played: the totals and the players a side they allow. */
      min: number;
      max: number;
      sides: number[];
      places: number;
      perSide: number;
      activityName: string;
    }
  | { ok: false; error: RangeError | "not-found"; field: "min" | "max"; places: number; ceiling: number; activityName: string }
  | { ok: false; error: "switched-match"; field: "min" | "max"; places: number; ceiling: number; activityName: string; matchDate: Date; perSide: number; backTo: number };

export async function savePlayerRange(p: { activityId: string; min?: number | null; max?: number | null; now?: Date }): Promise<PlayerRangeSave> {
  const activity = await db.activity.findUnique({
    where: { id: p.activityId },
    select: { name: true, minPlayers: true, maxPlayers: true, sport: { select: { playersPerTeam: true } } },
  });
  if (!activity) return { ok: false, error: "not-found", field: "min", places: 0, ceiling: PLAYERS_CEILING, activityName: "" };
  const perSide = activity.sport.playersPerTeam;
  const places = perSide * 2;
  const checked = checkPlayerRange({ min: p.min === undefined ? null : p.min, max: p.max === undefined ? null : p.max, normal: places });
  if (!checked.ok) return { ok: false, error: checked.error, field: checked.field, places, ceiling: PLAYERS_CEILING, activityName: activity.name };
  const minPlayers = p.min === undefined ? (activity.minPlayers ?? null) : checked.min;
  const maxPlayers = p.max === undefined ? (activity.maxPlayers ?? null) : checked.max;
  const changed = minPlayers !== (activity.minPlayers ?? null) || maxPlayers !== (activity.maxPlayers ?? null);
  const r = playerRange({ minPlayers, maxPlayers, playersPerTeam: perSide });
  if (changed) {
    const switched = await db.match.findMany({
      where: { activityId: p.activityId, status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] }, date: { gt: p.now ?? new Date() }, isHistorical: false, maxPlayers: { not: places } },
      select: { date: true, maxPlayers: true },
      orderBy: { date: "asc" },
    });
    const stranded = switched.find((m) => m.maxPlayers % 2 === 0 && !sideAllowed(m.maxPlayers / 2, r));
    if (stranded) {
      return {
        ok: false,
        error: "switched-match",
        field: stranded.maxPlayers > r.max ? "max" : "min",
        places,
        ceiling: PLAYERS_CEILING,
        activityName: activity.name,
        matchDate: stranded.date,
        perSide: stranded.maxPlayers / 2,
        backTo: perSide,
      };
    }
    await db.activity.update({ where: { id: p.activityId }, data: { minPlayers, maxPlayers } });
  }
  return { ok: true, changed, minPlayers, maxPlayers, min: r.min, max: r.max, sides: sidesInRange(r), places, perSide, activityName: activity.name };
}
