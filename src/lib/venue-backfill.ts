/**
 * THE VENUE BACKFILL'S PLAN (2026-10-12), used by
 * scripts/backfill-venue-locations.ts.
 *
 * Given every weekly game that has no place linked, decide what WOULD be
 * linked: one Google call per distinct venue text and country (two clubs
 * at "Goals North Cheam" cost one call), and only a HIGH confidence match
 * is marked "link". A low confidence match, a venue that is not found and
 * a failed call are reported and left alone, for the organiser's confirm
 * line on /admin/activities.
 *
 * Pure apart from the `lookup` it is handed: no database here. The same
 * rules as a live save (venue-location-rules.ts), so the backfill and the
 * app can never disagree about what "high" means.
 */
import type { GeocodeHit, GeocodeOutcome } from "./geocode";
import {
  buildGeocodeQuery,
  classifyConfidence,
  clubCountry,
  isPlaceholderVenue,
  venueQueryKey,
  type VenueConfidence,
} from "./venue-location-rules";

export interface BackfillRow {
  activityId: string;
  orgId: string;
  /** The venue text exactly as the organiser typed it. */
  venue: string;
  /** The club's first OWNER's phone: the country hint. */
  ownerPhone: string | null;
  language: string | null;
}

export interface BackfillLine {
  activityId: string;
  orgId: string;
  venue: string;
  key: string;
  /** "link": high confidence, written with --apply. Everything else is left alone. */
  outcome: "link" | "low-confidence" | "not-found" | "error" | "placeholder";
  confidence: VenueConfidence | null;
  address: string | null;
  hit: GeocodeHit | null;
}

export interface BackfillPlan {
  lines: BackfillLine[];
  googleCalls: number;
  /** No key configured: nothing could be looked up. */
  off: boolean;
}

export async function planVenueBackfill(
  rows: BackfillRow[],
  lookup: (query: { address: string; region?: string }) => Promise<GeocodeOutcome>,
): Promise<BackfillPlan> {
  const answers = new Map<string, GeocodeOutcome>();
  const lines: BackfillLine[] = [];
  let googleCalls = 0;

  for (const row of rows) {
    const country = clubCountry({ ownerPhone: row.ownerPhone, language: row.language });
    const key = venueQueryKey(row.venue, country);
    const base = { activityId: row.activityId, orgId: row.orgId, venue: row.venue, key };

    if (isPlaceholderVenue(row.venue)) {
      lines.push({ ...base, outcome: "placeholder", confidence: null, address: null, hit: null });
      continue;
    }

    let got = answers.get(key);
    if (!got) {
      googleCalls += 1;
      got = await lookup(buildGeocodeQuery(row.venue, country));
      if (got.status === "off") return { lines, googleCalls, off: true };
      answers.set(key, got);
    }

    if (got.status !== "ok") {
      lines.push({ ...base, outcome: got.status === "none" ? "not-found" : "error", confidence: null, address: null, hit: null });
      continue;
    }
    const confidence = classifyConfidence({ query: row.venue, hit: got.hit, expectedCountry: country });
    lines.push({
      ...base,
      outcome: confidence === "high" ? "link" : "low-confidence",
      confidence,
      address: got.hit.formattedAddress || null,
      hit: got.hit,
    });
  }

  return { lines, googleCalls, off: false };
}
