/**
 * THE CLUB SUMMARY'S FACTS OF A CLUB ROW THE CALLER HAS READ ANYWAY (club
 * summary, slice A3, MDs/club-summary-design-2026-11-04.md section 3.10).
 *
 * The admin group finds the club by its group, a DM finds the sender's
 * clubs through his memberships, and a web page has the club ride on its
 * own match or membership query (slice A4, section 3.11): either way the
 * club's row is read. Read
 * with `CLUB_ROW_SELECT` (the summary's read 1 and the switches), that row
 * gives `ClubRowFacts`, the summary's own facts of it, built by the
 * summary's derive functions, at no further read. The consumers there need
 * only these (switches, team names, payment switches, collector,
 * announcer); the whole summary would cost three to six reads more.
 *
 * FAIL-SOFT, as the summary's other readers: facts that cannot be built
 * are logged once and come back null, and every consumer then reads its
 * own facts as it did before the summary. Never throws.
 */
import { db } from "./db";
import { CLUB_ORG_SELECT } from "./club-summary/load";
import { clubRowFacts } from "./club-summary/derive";
import type { ClubRowFacts } from "./club-summary/types";
import { ORG_FEATURES_SELECT, orgFeaturesFromRow } from "./org-features";

/** The club row's columns the row facts are built from. */
export const CLUB_ROW_SELECT = { ...CLUB_ORG_SELECT, ...ORG_FEATURES_SELECT } as const;

export type ClubRow = Parameters<typeof clubRowFacts>[0] & Parameters<typeof orgFeaturesFromRow>[0];

function logUnreadable(where: string, orgId: string, err: unknown) {
  console.error(`[${where}] org ${orgId}: the club summary could not be read; this request reads each fact itself, as before:`, err);
}

/** The row facts, or null (logged once, under `where`). */
export function clubRowFactsOf(row: ClubRow, where: string): ClubRowFacts | null {
  try {
    return clubRowFacts(row, orgFeaturesFromRow(row));
  } catch (err) {
    logUnreadable(where, row.id, err);
    return null;
  }
}

/**
 * The row facts in one read, for a caller with no club row of its own (a
 * server action given only the club's id, slice A4): the facts, null for no
 * such club, or "unreadable" (logged once, under `where`), when the caller
 * makes its own read as before.
 */
export async function loadClubRowFacts(orgId: string, where: string): Promise<ClubRowFacts | null | "unreadable"> {
  try {
    const row = await db.organisation.findUnique({ where: { id: orgId }, select: CLUB_ROW_SELECT });
    return row ? clubRowFacts(row, orgFeaturesFromRow(row)) : null;
  } catch (err) {
    logUnreadable(where, orgId, err);
    return "unreadable";
  }
}
