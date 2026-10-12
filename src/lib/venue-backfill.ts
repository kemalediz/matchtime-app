/**
 * THE VENUE BACKFILL'S PLAN AND ARGUMENTS (2026-10-12), used by
 * scripts/backfill-venue-locations.ts.
 *
 * Given every weekly game that has no place linked, decide what WOULD be
 * linked: one Google call per distinct venue text and country (two clubs
 * at "Goals North Cheam" cost one call, and an answer already in
 * `VenueQuery` costs none).
 *
 *   link        a HIGH confidence match: linked as high
 *   link-low    a LOW confidence match: linked as low, so the organiser
 *               gets "We are not sure, is this the right place?" rather
 *               than "not found"
 *   not-found, error, placeholder: reported and left alone
 *
 * Nothing is ever confirmed by the backfill: only an organiser confirms.
 *
 * THE RUN STOPS, with what was done so far, when Google says there is no
 * more for now ("quota"), refuses the key ("denied"), is not configured
 * ("off"), or when `limit` Google calls have been made.
 *
 * Pure apart from the two functions it is handed: no database here. The
 * same rules as a live save (venue-location-rules.ts), so the backfill
 * and the app can never disagree about what "high" means.
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
  outcome: "link" | "link-low" | "not-found" | "error" | "placeholder";
  confidence: VenueConfidence | null;
  address: string | null;
  /** Google's answer, when this run asked. */
  hit: GeocodeHit | null;
  /** The place already on record for the query, when `VenueQuery` had it. */
  venueId: string | null;
}

export interface BackfillPlan {
  lines: BackfillLine[];
  googleCalls: number;
  /** Why the run ended early, or null when every activity was looked at. */
  stopped: "off" | "quota" | "denied" | "limit" | null;
}

export interface BackfillOptions {
  /** At most this many Google calls. */
  limit?: number | null;
  /** The answer on record for a query key (`VenueQuery`), if any. */
  cached?: (key: string) => Promise<{ venueId: string; confidence: VenueConfidence; address: string | null } | null>;
}

type Answer =
  | { from: "google"; outcome: GeocodeOutcome }
  | { from: "cache"; venueId: string; confidence: VenueConfidence; address: string | null };

export async function planVenueBackfill(
  rows: BackfillRow[],
  lookup: (query: { address: string; region?: string }) => Promise<GeocodeOutcome>,
  opts: BackfillOptions = {},
): Promise<BackfillPlan> {
  const answers = new Map<string, Answer>();
  const lines: BackfillLine[] = [];
  let googleCalls = 0;

  for (const row of rows) {
    const country = clubCountry({ ownerPhone: row.ownerPhone, language: row.language });
    const key = venueQueryKey(row.venue, country);
    const base = { activityId: row.activityId, orgId: row.orgId, venue: row.venue, key };
    const nothing = { confidence: null, address: null, hit: null, venueId: null };

    if (isPlaceholderVenue(row.venue)) {
      lines.push({ ...base, outcome: "placeholder", ...nothing });
      continue;
    }

    let answer = answers.get(key);
    if (!answer) {
      const known = opts.cached ? await opts.cached(key) : null;
      if (known) {
        answer = { from: "cache", ...known };
      } else {
        if (opts.limit != null && googleCalls >= opts.limit) return { lines, googleCalls, stopped: "limit" };
        googleCalls += 1;
        const outcome = await lookup(buildGeocodeQuery(row.venue, country));
        if (outcome.status === "off") return { lines, googleCalls, stopped: "off" };
        if (outcome.status === "error" && (outcome.code === "quota" || outcome.code === "denied")) {
          return { lines, googleCalls, stopped: outcome.code };
        }
        answer = { from: "google", outcome };
      }
      answers.set(key, answer);
    }

    if (answer.from === "cache") {
      lines.push({
        ...base,
        outcome: answer.confidence === "high" ? "link" : "link-low",
        confidence: answer.confidence,
        address: answer.address,
        hit: null,
        venueId: answer.venueId,
      });
      continue;
    }
    const got = answer.outcome;
    if (got.status !== "ok") {
      lines.push({ ...base, outcome: got.status === "none" ? "not-found" : "error", ...nothing });
      continue;
    }
    const confidence = classifyConfidence({ query: row.venue, hit: got.hit, expectedCountry: country });
    lines.push({
      ...base,
      outcome: confidence === "high" ? "link" : "link-low",
      confidence,
      address: got.hit.formattedAddress || null,
      hit: got.hit,
      venueId: null,
    });
  }

  return { lines, googleCalls, stopped: null };
}

// ── The script's arguments ──────────────────────────────────────────────

export type BackfillArgs =
  | { ok: true; apply: boolean; org: string | null; limit: number | null }
  | { ok: false; error: string };

export const BACKFILL_USAGE =
  "Usage: backfill-venue-locations.ts [--apply] [--org <club id or slug>] [--limit <max Google calls>]";

/**
 * Strict on purpose. `--org` with nothing after it used to mean "every
 * club", and with `--apply` that wrote across all of them: it is refused
 * now, as is any argument this does not know.
 */
export function parseBackfillArgs(argv: string[]): BackfillArgs {
  let apply = false;
  let org: string | null = null;
  let limit: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--org") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--") || !value.trim()) {
        return { ok: false, error: "--org needs a club id or slug. Leave --org out to run every club." };
      }
      org = value.trim();
    } else if (arg === "--limit") {
      const value = argv[++i];
      if (value === undefined || !/^[1-9]\d*$/.test(value)) {
        return { ok: false, error: "--limit needs a whole number above zero (the most Google calls to make)." };
      }
      limit = Number(value);
    } else {
      return { ok: false, error: `Unknown argument: ${arg}` };
    }
  }
  return { ok: true, apply, org, limit };
}
