/**
 * THE CANCELLED MATCH A SQUAD ANSWER LEADS WITH, IF ANY (FNF, 2026-10-23).
 *
 * FNF's Friday 23 Oct game was cancelled on the 22nd. The selector
 * (`registration-match-select.ts`) rightly skips CANCELLED, so on the
 * morning of the 23rd "What's the list" in HQ got the 30 Oct squad, 18/18
 * (the rolling squad had seeded it), with nothing to say which match it
 * was. Everyone read it as that night's. The squad post now names its
 * match, and this decides when it also says "this week's game is off".
 *
 * THE WINDOW. A CANCELLED match C is mentioned when all hold:
 *   1. there is a match being shown (no squad post, nothing to lead into);
 *   2. C kicked off no more than 48 hours ago (`CANCELLED_NOTICE_AFTER_MS`),
 *      or is still to come. So the day it was cancelled, the night itself
 *      and the morning after; never a cancellation from weeks ago;
 *   3. C is at least 12 hours before the shown match
 *      (`SAME_FIXTURE_MS`). A cancelled copy of the SAME night, which a
 *      format switch can leave behind, is not a cancelled week;
 *   4. no other match of the club that is not cancelled (played, or in
 *      flight) falls between 12 hours before C and the shown match. That
 *      is "after the last played match": a game played since means C is
 *      not this week's, and a played copy of C's own night means the
 *      night went ahead.
 * Among several, the latest is named.
 *
 * Pure: rows in, one row or null out. `load-state.ts` feeds it the rows it
 * already loads; the analyze route's squad pass feeds it its own.
 */
export const CANCELLED_NOTICE_AFTER_MS = 48 * 60 * 60 * 1000;
export const SAME_FIXTURE_MS = 12 * 60 * 60 * 1000;

export function cancelledMatchToMention<T extends { id: string; date: Date; status: string }>(
  matches: readonly T[],
  shown: { id: string; date: Date } | null,
  now: Date,
): T | null {
  if (!shown) return null;
  const floor = now.getTime() - CANCELLED_NOTICE_AFTER_MS;
  const ceiling = shown.date.getTime() - SAME_FIXTURE_MS;
  const cancelled = matches
    .filter((m) => m.status === "CANCELLED" && m.date.getTime() >= floor && m.date.getTime() <= ceiling)
    .sort((a, b) => b.date.getTime() - a.date.getTime());
  const latest = cancelled[0];
  if (!latest) return null;
  const from = latest.date.getTime() - SAME_FIXTURE_MS;
  const wentAhead = matches.some(
    (m) =>
      m.id !== shown.id &&
      m.status !== "CANCELLED" &&
      m.date.getTime() >= from &&
      m.date.getTime() < shown.date.getTime(),
  );
  return wentAhead ? null : latest;
}
