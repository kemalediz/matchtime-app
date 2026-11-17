/**
 * READ-ONLY. What a club calls its two sides (2026-11-17, `score-sides.ts`).
 *
 * One `SentNotification` row per match the names were learned on (kind
 * `SCORE_SIDE_NAMES_KIND`, its `text` the JSON). A match's own row wins;
 * otherwise the club's newest row, the names it used last. One indexed
 * read (`kind`), bounded, and null for every club that has never been
 * asked: no names is the common case and costs nothing else.
 *
 * No new table: the names ride on the same kind of row the score
 * question already uses (`score-ask.ts`), cascade with their match, and
 * need no migration.
 */
import { db } from "../db";
import { SCORE_SIDE_NAMES_KIND, hasSideNames, parseSideNames, type SideNames } from "./score-sides";

export async function loadSideNames(orgId: string, matchId: string | null): Promise<SideNames | null> {
  const rows = await db.sentNotification.findMany({
    where: { kind: SCORE_SIDE_NAMES_KIND, match: { activity: { orgId } } },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { matchId: true, text: true },
  });
  const own = matchId ? rows.find((r) => r.matchId === matchId) : undefined;
  const names = parseSideNames((own ?? rows[0])?.text ?? null);
  return hasSideNames(names) ? names : null;
}
