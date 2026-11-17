/**
 * READ-ONLY. What a club calls its two sides (2026-11-17, `score-sides.ts`).
 *
 * One `SentNotification` row per match the names were learned on (kind
 * `SCORE_SIDE_NAMES_KIND`, its `text` the JSON). One indexed read
 * (`kind`), bounded, and empty for every club that has never been asked.
 *
 *   own      THIS match's row: the names that place a name in a report.
 *   earlier  the club's newest row for ANOTHER match: a hint in the
 *            question only ("Last time it was Red").
 *
 * REVIEW OF #620 (blocking): this used to fall back from `own` to the
 * club's newest row and place names with it. The side that wears the bibs
 * changes from week to week, so last week's "bibs is Red" recorded this
 * week's result the wrong way round without asking. An earlier game's
 * names are never returned as `own`.
 *
 * No new table: the names ride on the same kind of row the score
 * question already uses (`score-ask.ts`), cascade with their match, and
 * need no migration.
 */
import { db } from "../db";
import { SCORE_SIDE_NAMES_KIND, hasSideNames, parseSideNames, type SideNames } from "./score-sides";

export async function loadSideNames(
  orgId: string,
  matchId: string | null,
): Promise<{ own: SideNames | null; earlier: SideNames | null }> {
  const rows = await db.sentNotification.findMany({
    where: { kind: SCORE_SIDE_NAMES_KIND, match: { activity: { orgId } } },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { matchId: true, text: true },
  });
  const read = (text: string | null | undefined) => {
    const n = parseSideNames(text ?? null);
    return hasSideNames(n) ? n : null;
  };
  const own = matchId ? rows.find((r) => r.matchId === matchId) : undefined;
  const earlier = rows.find((r) => r.matchId !== matchId && hasSideNames(parseSideNames(r.text ?? null)));
  return { own: read(own?.text), earlier: read(earlier?.text) };
}
