/**
 * COUNTING A CLUB'S RECORD, OVER THE WHOLE OF IT OR A PERIOD (2026-09-23).
 *
 * Pure counting for the appearances and Man of the Match tables. The
 * rows come from `match-history.ts`, which owns the queries; these turn
 * dated rows into a ranked table. Two callers, one rule:
 *
 *   - `loadRecentHistory`'s attendance leaderboard (the prompt's recent
 *     history block and the DM Q&A), over the whole record;
 *   - `loadClubRecordTables`, the group's stats answer, over the whole
 *     record or cut to the period a question asked for.
 *
 * So "who has played the most" cannot get two different answers from
 * the same club on the same day.
 *
 * The three-month inactivity rule (`ranked-table-activity.ts`) is the
 * caller's `isRanked`: it REMOVES rows and touches no number. Nothing
 * here is capped; the group's cap of ten is the renderer's.
 */

export interface DatedAppearance {
  userId: string;
  date: Date;
}

export interface DatedMomWin {
  userId: string;
  name: string;
  date: Date;
}

const inPeriod = (date: Date, since: Date | null) => since === null || date.getTime() >= since.getTime();

/** PURE. CONFIRMED appearances per player, most first, a name breaking a tie. */
export function countAppearances(
  rows: DatedAppearance[],
  opts: { since: Date | null; isRanked: (userId: string) => boolean; nameOf: (userId: string) => string },
): Array<{ userId: string; name: string; matches: number }> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!inPeriod(r.date, opts.since)) continue;
    counts.set(r.userId, (counts.get(r.userId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([userId]) => opts.isRanked(userId))
    .map(([userId, matches]) => ({ userId, name: opts.nameOf(userId), matches }))
    .sort((a, b) => b.matches - a.matches || a.name.localeCompare(b.name));
}

/** PURE. Man of the Match wins per player (a shared award is a win for
 *  each), most first, a name breaking a tie. */
export function countMomWins(
  wins: DatedMomWin[],
  opts: { since: Date | null; isRanked: (userId: string) => boolean },
): Array<{ userId: string; name: string; wins: number }> {
  const byPlayer = new Map<string, { name: string; wins: number }>();
  for (const w of wins) {
    if (!inPeriod(w.date, opts.since)) continue;
    const cur = byPlayer.get(w.userId) ?? { name: w.name, wins: 0 };
    cur.wins += 1;
    byPlayer.set(w.userId, cur);
  }
  return [...byPlayer.entries()]
    .filter(([userId]) => opts.isRanked(userId))
    .map(([userId, v]) => ({ userId, name: v.name, wins: v.wins }))
    .sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name));
}

/** PURE. The earliest date, or null when there is none. */
export function earliestDate(dates: Date[]): Date | null {
  let min: Date | null = null;
  for (const d of dates) if (!min || d.getTime() < min.getTime()) min = d;
  return min;
}
