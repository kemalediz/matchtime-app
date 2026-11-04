/**
 * THE CLUB SUMMARY'S FACTS OF A CLUB ROW THE CALLER HAS READ ANYWAY (club
 * summary, slice A3, MDs/club-summary-design-2026-11-04.md section 3.10).
 *
 * The admin group finds the club by its group, and a DM finds the sender's
 * clubs through his memberships: either way the club's row is read. Read
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
import { CLUB_ORG_SELECT } from "./club-summary/load";
import { clubRowFacts } from "./club-summary/derive";
import type { ClubRowFacts } from "./club-summary/types";
import { ORG_FEATURES_SELECT, orgFeaturesFromRow } from "./org-features";

/** The club row's columns the row facts are built from. */
export const CLUB_ROW_SELECT = { ...CLUB_ORG_SELECT, ...ORG_FEATURES_SELECT } as const;

export type ClubRow = Parameters<typeof clubRowFacts>[0] & Parameters<typeof orgFeaturesFromRow>[0];

/** The row facts, or null (logged once, under `where`). */
export function clubRowFactsOf(row: ClubRow, where: string): ClubRowFacts | null {
  try {
    return clubRowFacts(row, orgFeaturesFromRow(row));
  } catch (err) {
    console.error(`[${where}] org ${row.id}: the club summary could not be read; this request reads each fact itself, as before:`, err);
    return null;
  }
}
