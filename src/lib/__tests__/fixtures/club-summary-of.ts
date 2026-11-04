/**
 * A CLUB SUMMARY FOR A TEST'S CLUB ROW (club summary, slice A1).
 *
 * The jobs moved onto the summary in A1 (the drop-out deadline summary, the
 * unpaid list, the Teams ready proposal) take the club's facts from it
 * instead of reading the club's row themselves. Their tests describe the
 * club by that row, as they always did; this builds the summary of it
 * through the real `buildClubSummary`. Columns the row does not name take
 * the value the old reader took for an absent column: the schema's default,
 * except the quiet hours, which `quietHoursOf` reads as ON (23:00 to 09:00)
 * when the columns are absent.
 */
import { buildClubSummary, type ActivityRow, type OrgRow } from "@/lib/club-summary/derive";
import type { ClubSummary } from "@/lib/club-summary/types";
import type { OrgFeatures } from "@/lib/org-features";
import { featuresFor, orgRow } from "@/lib/club-summary/__tests__/fixtures";

export function clubSummaryOf(
  row: Record<string, unknown> & { id: string },
  opts: { features?: Partial<OrgFeatures>; activities?: ActivityRow[]; now?: Date } = {},
): ClubSummary {
  const org = orgRow({
    name: "Club",
    ...(row as Partial<OrgRow> & { id: string }),
    quietHoursEnabled: (row.quietHoursEnabled as boolean | undefined) ?? true,
  });
  return buildClubSummary(
    {
      org,
      features: { ...featuresFor(org), ...opts.features },
      collectorName: null,
      collectionLive: false,
      activities: opts.activities ?? [],
      matches: [],
      lastPlayed: [],
      months: [],
      heldKeys: [],
      members: null,
    },
    opts.now ?? new Date(),
  );
}
