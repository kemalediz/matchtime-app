/**
 * WHO IS IN THE TABLE — the inactivity rule for every leaderboard.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE QUESTION AND THE ANSWER
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Kemal asked what should happen to a player who stops turning up: does
 * his ranking decay, or does he come out of the table? He decided, on
 * 2026-09-15, verbatim:
 *
 *   "drop inactive players from the table after three months, leave the
 *    balancer alone."
 *
 * So: a player with no match in the last three months disappears from
 * the leaderboards, and reappears the moment they play again. Nothing
 * about team generation or the rating formula changes.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY REMOVAL AND NOT DECAY — keep this, because "just fade them out
 * instead" is the change somebody will propose
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   A LEADERBOARD IS A RECORD OF WHAT HAPPENED. Decaying a number
 *   invents a rating the player never earned. Nobody played the match
 *   that produced it. To the player it reads as a bug — "why did I
 *   drop, I didn't play?" — and he is right to think so.
 *
 *   REMOVAL IS SELF-EXPLANATORY AND REVERSIBLE. "You are not in the
 *   table because you have not played" is one sentence and it is true.
 *   One match back and the player is in the table again with his real
 *   number, because the number was never touched — there is nothing to
 *   restore, nothing to unwind, and no migration if the rule is ever
 *   withdrawn.
 *
 *   RUST IS ALREADY HANDLED, BETTER, SOMEWHERE ELSE. `rating-adjuster.ts`
 *   asks the model for a per-match delta and its prompt says outright:
 *   "Player hasn't played in weeks / mentioned rust → small negative
 *   delta". That is temporary, per match, evidence-backed and
 *   self-correcting. A permanent decay here would double-count it, and
 *   unlike the adjuster's delta it would never recover on its own.
 *
 * This module therefore contains no rating arithmetic of any kind, and
 * `balancer-untouched-by-inactivity.test.ts` asserts that team
 * generation and the rating modules never import it.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * PRECEDENT — a participation gate is not a new idea here
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `ELO_BOTTOM_MIN_MATCHES = 3` in `match-history.ts` already filters the
 * Elo bottom table on participation, so that one bad night does not put
 * a newcomer at the foot of the club. This is the same shape of rule
 * with time as the axis instead of count.
 */

/**
 * How long a player can go without a match before they come out of the
 * ranked tables.
 *
 * THREE MONTHS, AND THE NUMBER IS LOAD-BEARING. Kemal chose it against
 * the club's own calendar: Sutton breaks for the summer, and he set the
 * threshold at DOUBLE the break so a returning player cannot have been
 * deleted while the club itself was not playing. His words, 2026-09-15:
 * "we don't give 3 months break, we give 1.5 months of break, hence i
 * said look into last 3 months."
 *
 * VERIFIED AGAINST THE REAL FIXTURE LIST, NOT THE POLICY. Probed live on
 * 2026-09-15: Sutton FC's actual 2026 shutdown ran 14 Jul → 1 Sep, which
 * is 49 days. Simulating this rule week by week across the club's whole
 * history, the ranked table bottomed out at 28 of 41 players on the last
 * day of the break and never came close to emptying. Every player who
 * appeared in the final pre-break fixture stayed ranked throughout. The
 * thirteen who did fall out during the break had all already been absent
 * for more than three months BEFORE it started — the break did not cause
 * their removal, it only carried them over a line they were walking
 * towards anyway.
 *
 * SO: DO NOT MAKE THIS WINDOW BREAK-AWARE. An earlier draft anchored the
 * window to the club's most recent fixture instead of to today, on the
 * theory that a dormant club would otherwise empty its own table. With a
 * threshold at double the real break that cannot happen, and anchoring
 * to the last fixture costs a query, costs an explanation, and makes
 * "three months" mean something other than three months. If the club's
 * break ever grows past ~2 months, raise THIS NUMBER rather than
 * reintroducing that machinery.
 */
export const RANKED_TABLE_INACTIVE_AFTER_MONTHS = 3;

/**
 * Does a bench slot count as having played?
 *
 * NO. At MatchTime `BENCH` means "wanted in, squad was full" — it is a
 * waiting list, which `bench-offer-copy.ts` and `bench-confirmation.ts`
 * work through when somebody drops out. It is not "turned up and sat
 * out". A bench row is therefore evidence of intent, not of an
 * appearance, and every number in these tables is built from CONFIRMED
 * rows: the attendance leaderboard counts them, and the Elo floor's
 * matches-played counts them. If "played" meant something wider here
 * than it means one line further down the same file, the filter and the
 * figure beside it would disagree about the same player.
 *
 * The cost is named rather than hidden: a player who is repeatedly
 * benched and never gets on will age out of the table despite showing
 * up in the chat every week. That is the rarer case, and the honest
 * reading of a table of appearances.
 */
export const RANKED_TABLE_COUNTS_BENCH_AS_PLAYED = false;

/**
 * Does the ATTENDANCE leaderboard follow the same rule as the rest?
 *
 * YES, AND IT IS THE ONE THAT NEEDED ARGUING. It is a table about
 * turning up, so it is fair to say that removing somebody who stopped
 * turning up changes what it measures — their absence is precisely the
 * information it exists to show.
 *
 * Three things decide it the other way:
 *
 *   IT IS A TOP TEN, AND SLOTS ARE ZERO-SUM. An ex-player holding a
 *   top-10 slot on the strength of a spring he is no longer part of
 *   pushes a current regular off the bottom of the list. The table's
 *   job is to show the club who is turning up.
 *
 *   THE DENOMINATOR ALREADY PUNISHES ABSENCE, so nothing is lost. The
 *   percentage is out of the org's TOTAL completed matches (Kemal,
 *   2026-05-15), so an absent player's number falls on its own every
 *   week the club plays without him. Keeping him in the table adds no
 *   information that his own row was not already going to deliver.
 *
 *   ONE RULE IS EXPLAINABLE, FOUR RULES ARE NOT. If this table alone
 *   kept leavers, the same man is missing from three tables and present
 *   in the fourth, and "why is Ehtisham in one list and not the others"
 *   becomes a question nobody can answer in a sentence.
 *
 * Checked against live data 2026-09-15 before committing to it: at
 * Sutton FC the attendance top ten is identical with and without this
 * filter, because the regulars are the regulars. So it is consistency
 * bought at no cost today, which is the cheapest time to buy it.
 */
export const ATTENDANCE_TABLE_FOLLOWS_ACTIVITY_RULE = true;

/**
 * Does TEAM OF THE SEASON follow the rule?
 *
 * NO, AND THIS IS THE ONE DELIBERATE EXCEPTION.
 *
 * Team of the Season is not a table, it is an AWARD. The leaderboards
 * answer "where do I stand now" — a question about the present, which is
 * why a man who is no longer around does not belong in the answer. Team
 * of the Season answers "who was best this season", which is a question
 * about a closed period. A best XI that quietly drops half the players
 * who actually played the season is not the team of the season; it is
 * the team of whoever is still here, presented under the wrong name.
 *
 * The visible consequence, stated plainly so it is not mistaken for a
 * bug: a player can appear in Team of the Season and NOT in the squad
 * leaderboard directly above it. That is correct — he earned the award
 * and he is not currently ranked — and the surface says so.
 */
export const TEAM_OF_SEASON_FOLLOWS_ACTIVITY_RULE = false;

/**
 * Does a player still see THEMSELVES on their own stats page when they
 * have aged out?
 *
 * YES. `/profile/stats` advertises "how you stack up against the squad".
 * A player who comes back after four months, opens the one page in the
 * product that is about him, and finds himself absent from it has been
 * told — by a page with his own name at the top — that he does not
 * exist. That is hostile, and it is also the single most likely way
 * anyone discovers this rule at all.
 *
 * So the ranked table is the ranked table, and the viewer gets his own
 * row underneath it, unranked, labelled with when he last played and
 * what it takes to come back. He is NOT given a rank number: putting
 * him back in the ordering would be the decay problem again in a
 * different costume, inventing a position he has not earned.
 *
 * The exemption is for the VIEWER ON HIS OWN PAGE only. A group-chat
 * leaderboard has no viewer, and the admin dashboard's reader is an
 * operator rather than a subject — that surface solves the same problem
 * a different way, by listing the inactive players in full.
 */
export const VIEWER_IS_EXEMPT_ON_OWN_STATS_PAGE = true;

/**
 * The instant before which a last-appearance means "gone".
 *
 * Measured from NOW, deliberately — see
 * `RANKED_TABLE_INACTIVE_AFTER_MONTHS` for why this is not anchored to
 * the club's last fixture. Calendar months, not 90 days, so the rule
 * says what a human means by "three months" in every month length.
 */
export function rankedTableCutoff(now: Date = new Date()): Date {
  const cutoff = new Date(now.getTime());
  cutoff.setMonth(cutoff.getMonth() - RANKED_TABLE_INACTIVE_AFTER_MONTHS);
  return cutoff;
}

export interface RankedRoster {
  /** The instant a last-appearance must be at or after to stay ranked. */
  cutoff: Date;
  /** Is this player in the ranked tables? */
  isRanked(userId: string): boolean;
  /** When they last played, or null if never (or not in this org). */
  lastPlayed(userId: string): Date | null;
  /** Everyone the filter removed, longest-absent first. */
  hiddenUserIds: string[];
  hiddenCount: number;
}

/**
 * Turn a map of last-appearance dates into the ranked/not-ranked
 * decision, plus enough detail for a surface to say what it hid.
 *
 * A player at EXACTLY the cutoff instant stays in: "no match in the last
 * three months" means a match three months ago today still counts as
 * being in the last three months.
 *
 * Pure. The caller supplies the dates — `match-history.ts` already has
 * them in hand from the attendance query it was making anyway, and
 * `loadLastPlayedByUser` fetches them for the surfaces that do not.
 */
export function buildRankedRoster(
  lastPlayedByUser: Map<string, Date>,
  now: Date = new Date(),
): RankedRoster {
  const cutoff = rankedTableCutoff(now);
  const hidden = [...lastPlayedByUser.entries()]
    .filter(([, d]) => d < cutoff)
    .sort((a, b) => a[1].getTime() - b[1].getTime())
    .map(([id]) => id);
  const hiddenSet = new Set(hidden);
  return {
    cutoff,
    isRanked: (userId) => lastPlayedByUser.has(userId) && !hiddenSet.has(userId),
    lastPlayed: (userId) => lastPlayedByUser.get(userId) ?? null,
    hiddenUserIds: hidden,
    hiddenCount: hidden.length,
  };
}

/**
 * Build the last-appearance map for an org from the database.
 *
 * "Played" is a CONFIRMED attendance on a COMPLETED, non-historical
 * match — the same definition every figure in these tables already
 * uses:
 *
 *   CANCELLED matches are excluded because `status` must be COMPLETED.
 *   Nobody played a match that did not happen, and a club that calls
 *   off three weeks of fixtures must not have those weeks counted
 *   against the players who would have turned up.
 *
 *   A COMPLETED match with NO SCORE recorded still counts. The score is
 *   frequently never entered at amateur cadence, and a match that was
 *   played is a match that was played — the attendance leaderboard has
 *   always counted them and this filter must agree with it.
 *
 *   SYNTHETIC HISTORICAL matches (`isHistorical: true`) are excluded,
 *   which is not a choice so much as a fact: they are anchors for MoM
 *   votes backfilled from WhatsApp history and they carry no Attendance
 *   rows at all. The consequence is worth stating, because it is real —
 *   a player whose ONLY presence in the club's data is a backfilled MoM
 *   award has no appearance to qualify on and will not be ranked. Live
 *   check on 2026-09-15 found exactly one such player at Sutton FC
 *   ("Ali", one backfilled award, never played a tracked match), and
 *   dropping him is the right outcome: he is a pre-MatchTime name, not
 *   a member of the current squad.
 *
 * `db` is INJECTED rather than imported, so that the rule itself — the
 * constants above and `buildRankedRoster` — can be unit-tested without
 * a Prisma client being constructed to answer questions about dates.
 * The parameter is typed structurally and loosely for the same reason:
 * naming Prisma's generated client type here would re-create exactly
 * the coupling the injection exists to avoid.
 */
interface AttendanceReader {
  attendance: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany(args: any): Promise<any[]>;
  };
}

export async function loadLastPlayedByUser(
  db: AttendanceReader,
  orgId: string,
): Promise<Map<string, Date>> {
  const rows = (await db.attendance.findMany({
    where: {
      status: "CONFIRMED",
      match: { activity: { orgId }, status: "COMPLETED", isHistorical: false },
    },
    select: { userId: true, match: { select: { date: true } } },
  })) as Array<{ userId: string; match: { date: Date } | null }>;
  return lastPlayedFromRows(
    rows.map((r) => ({ userId: r.userId, date: r.match?.date })),
  );
}

/**
 * Reduce appearance rows to one date per player: their most recent.
 *
 * Rows without a usable date are SKIPPED rather than carried through.
 * They should not occur — every caller joins appearances to matches it
 * has already loaded — but an undefined that survives into the map
 * poisons the comparison in `buildRankedRoster` (`undefined < cutoff` is
 * false), which would quietly rank everybody and make the filter look
 * like it worked while doing nothing at all. That is precisely how a
 * mock in `recent-history-bound.test.ts` passed this filter before the
 * mock was corrected, so the failure mode is not hypothetical.
 */
export function lastPlayedFromRows(
  rows: Array<{ userId: string; date: Date | undefined }>,
): Map<string, Date> {
  const out = new Map<string, Date>();
  for (const r of rows) {
    if (!(r.date instanceof Date) || Number.isNaN(r.date.getTime())) continue;
    const cur = out.get(r.userId);
    if (!cur || r.date > cur) out.set(r.userId, r.date);
  }
  return out;
}

/** "7 Jul 2026" — the shared way every surface names a last appearance. */
export function formatLastPlayed(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(d);
}
