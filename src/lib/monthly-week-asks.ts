/**
 * POOL AND PARTNER ASKS IN A MONTHLY WEEK: THE ADAPTER (Vets MNF,
 * 2026-10-29). Thin I/O around `monthly-week-asks-rules.ts`. Read only.
 *
 * The one place the MatchTime pool and the partner-club asks learn that a
 * match is a week of a running month (`loadMonthlyWeek`). For every other
 * match each answer is exactly what it was before: one small read of the
 * match and its club, then the plain count.
 *
 *   askPlacesOpen      the places an ask may fill (pool rounds, partner
 *                      asks, the match page's picker, the round closing)
 *   guestPaygPence     the club's PAYG price in a monthly week, else null:
 *                      what a guest is told he pays
 *
 * Outside `src/lib/pool/` on purpose: the partner ask and the pool both
 * read it, and it reads no pool table.
 */
import { db } from "./db";
import { loadMonthlyWeek, type MonthlyWeek } from "./monthly-week";
import { monthlyPlacesOpen } from "./monthly-week-asks-rules";
import { normaliseSquadMode } from "./squad-month-rules";
import { openSquadMinimum, placesToFill } from "./open-squad";

/** The monthly week of this match, or null without reading the match's
 *  rows when its club is on "weekly". */
async function monthlyWeekOf(matchId: string): Promise<{ maxPlayers: number; openSquad: boolean; minimum: number; week: MonthlyWeek | null } | null> {
  const m = await db.match.findUnique({
    where: { id: matchId },
    select: {
      maxPlayers: true,
      activity: { select: { minPlayers: true, sport: { select: { playersPerTeam: true } }, org: { select: { squadMode: true, openSquad: true } } } },
    },
  });
  if (!m) return null;
  const openSquad = m.activity?.org?.openSquad === true;
  const minimum = openSquadMinimum({ minPlayers: m.activity?.minPlayers ?? null, playersPerTeam: m.activity?.sport?.playersPerTeam ?? m.maxPlayers / 2 });
  const base = { maxPlayers: m.maxPlayers, openSquad, minimum };
  if (normaliseSquadMode(m.activity?.org?.squadMode) !== "monthly") return { ...base, week: null };
  return { ...base, week: await loadMonthlyWeek(matchId) };
}

/** The match's places an ask may fill. A weekly club (or a match with no
 *  running month): its size less its CONFIRMED rows, as always. An OPEN
 *  SQUAD (2026-11-17, open-squad.ts) has no places: an ask fills only the
 *  players short of the game's minimum, so nothing is asked at or above it. */
export async function askPlacesOpen(matchId: string): Promise<number> {
  const found = await monthlyWeekOf(matchId);
  if (!found) return 0;
  if (found.week) return monthlyPlacesOpen({ ...found.week, openSquad: found.openSquad, minimum: found.minimum });
  const confirmed = await db.attendance.count({ where: { matchId, status: "CONFIRMED" } });
  return placesToFill({ openSquad: found.openSquad, confirmed, maxPlayers: found.maxPlayers, minimum: found.minimum });
}

/** The club's PAYG price (pence) when this match is a week of a running
 *  month and the club has set one; null otherwise. */
export async function guestPaygPence(matchId: string): Promise<number | null> {
  const found = await monthlyWeekOf(matchId);
  return found?.week?.paygPricePence ?? null;
}
