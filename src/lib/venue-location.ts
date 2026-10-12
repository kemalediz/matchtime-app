/**
 * VENUE LOCATION, the part that touches the database (2026-10-12).
 *
 * Three things happen to a weekly game's place:
 *
 *   resolveActivityVenue   after a game is created or its venue text is
 *                          edited: look the text up and link the place.
 *                          Run AFTER the save has answered (see
 *                          venue-location-schedule.ts), so it can neither
 *                          slow nor fail the save.
 *   changeActivityVenue    the organiser's "Change": a fuller address or
 *                          a pasted map link.
 *   confirmActivityVenue   the organiser's "Yes".
 *
 * WHAT IS STORED WHERE. A `Venue` row is a place, shared by every club
 * that plays there (unique on Google's place id). Everything that is one
 * club's business lives on its own `Activity`: how sure the match was for
 * the words it typed, where the link came from, and who confirmed it.
 *
 * COST. At most one Google call per save, and none when another activity
 * already asked the same question (same country, same normalised words):
 * the place and its confidence are reused. Each club is capped at
 * `VENUE_LOOKUPS_PER_CLUB_PER_DAY` outbound lookups per London day, so
 * the "Change" box cannot be used to burn the key.
 *
 * PRIVACY. Google is sent the venue text and the country, or a place id.
 * Never a club, group or person's name, never a phone. Logs carry ids,
 * the outcome and the confidence. Nothing here sends a message, and
 * nothing here is read by anybody outside the club.
 *
 * Every exported function returns an outcome and does not throw for
 * anything Google or a pasted link can do.
 */
import { db } from "./db";
import { londonMidnight } from "./club-connect-rules";
import { geocode, geocodingConfigured, type GeocodeHit } from "./geocode";
import { expandShortLink, parseMapInput, type MapInput } from "./map-link";
import {
  VENUE_LOOKUPS_PER_CLUB_PER_DAY,
  buildGeocodeQuery,
  classifyConfidence,
  clubCountry,
  isPlaceholderVenue,
  venueQueryKey,
  type VenueConfidence,
  type VenueMatchSource,
} from "./venue-location-rules";

export interface VenueLookupOptions {
  now?: Date;
  /** Tests hand a stub in; otherwise the test seam's `outboundFetch()`. */
  fetchImpl?: typeof fetch;
}

/** The columns an edit of the venue TEXT clears, so a stale place never
 *  stays attached to new words. Spread into the same write as the text. */
export const CLEARED_VENUE_LINK = {
  venueId: null,
  venueConfidence: null,
  venueMatchSource: null,
  venueQueryKey: null,
  venueResolvedAt: null,
  venueConfirmedAt: null,
  venueConfirmedById: null,
} as const;

/** Sources whose place answers the words in `venueQueryKey`. A place an
 *  organiser reached by pasting a link answers nothing but their own choice. */
const REUSABLE_SOURCES: VenueMatchSource[] = ["text", "address", "backfill"];

async function loadActivity(activityId: string) {
  return db.activity.findUnique({
    where: { id: activityId },
    select: {
      id: true,
      orgId: true,
      venue: true,
      venueId: true,
      org: {
        select: {
          language: true,
          // The organiser: the club's first OWNER still in it.
          memberships: {
            where: { role: "OWNER", leftAt: null },
            orderBy: { createdAt: "asc" },
            take: 1,
            select: { user: { select: { phoneNumber: true } } },
          },
        },
      },
    },
  });
}

type LoadedActivity = NonNullable<Awaited<ReturnType<typeof loadActivity>>>;

function countryOf(a: LoadedActivity): string | null {
  return clubCountry({ ownerPhone: a.org.memberships[0]?.user.phoneNumber ?? null, language: a.org.language });
}

/**
 * Count one outbound lookup against the club's day. The row is written
 * FIRST and then counted, so two requests at once can only both be
 * refused, never both allowed past the cap. A refused attempt removes
 * its own row.
 */
async function claimLookup(orgId: string, activityId: string, kind: string, now: Date): Promise<boolean> {
  const row = await db.venueLookup.create({ data: { orgId, activityId, kind, createdAt: now }, select: { id: true } });
  const used = await db.venueLookup.count({ where: { orgId, createdAt: { gte: londonMidnight(now) } } });
  if (used <= VENUE_LOOKUPS_PER_CLUB_PER_DAY) return true;
  await db.venueLookup.delete({ where: { id: row.id } }).catch(() => undefined);
  return false;
}

async function upsertGooglePlace(hit: GeocodeHit, name: string): Promise<string> {
  const venue = await db.venue.upsert({
    where: { placeId: hit.placeId },
    update: {},
    create: {
      placeId: hit.placeId,
      name,
      formattedAddress: hit.formattedAddress || null,
      lat: hit.lat,
      lng: hit.lng,
      source: "google",
    },
    select: { id: true },
  });
  return venue.id;
}

type TextLookup =
  | { status: "found"; venueId: string; confidence: VenueConfidence; key: string }
  | { status: "none"; key: string }
  | { status: "capped" | "error" | "off" };

/** Words to a place: reuse a place already found for them, else ask Google once. */
async function lookupText(
  a: LoadedActivity,
  text: string,
  now: Date,
  fetchImpl: typeof fetch | undefined,
): Promise<TextLookup> {
  const country = countryOf(a);
  const key = venueQueryKey(text, country);

  const known = await db.activity.findFirst({
    where: {
      venueQueryKey: key,
      venueId: { not: null },
      venueConfidence: { not: null },
      venueMatchSource: { in: REUSABLE_SOURCES },
    },
    select: { venueId: true, venueConfidence: true },
  });
  if (known?.venueId) {
    return { status: "found", venueId: known.venueId, confidence: known.venueConfidence === "high" ? "high" : "low", key };
  }

  if (!geocodingConfigured()) return { status: "off" };
  if (!(await claimLookup(a.orgId, a.id, "geocode", now))) return { status: "capped" };

  const got = await geocode(buildGeocodeQuery(text, country), { fetchImpl });
  if (got.status === "none") return { status: "none", key };
  if (got.status !== "ok") return { status: got.status === "off" ? "off" : "error" };

  const confidence = classifyConfidence({ query: text, hit: got.hit, expectedCountry: country });
  return { status: "found", venueId: await upsertGooglePlace(got.hit, text), confidence, key };
}

// ── After a save ────────────────────────────────────────────────────────

export type ResolveResult =
  | { status: "found"; confidence: VenueConfidence }
  | { status: "not-found" | "skipped" | "capped" | "error" | "off" | "stale" };

/**
 * Look an activity's venue text up and link the place. Only for an
 * activity with NO place linked: an edit of the text clears the link in
 * the same write (`CLEARED_VENUE_LINK`) before this runs.
 */
export async function resolveActivityVenue(activityId: string, opts: VenueLookupOptions = {}): Promise<ResolveResult> {
  const now = opts.now ?? new Date();
  const a = await loadActivity(activityId);
  if (!a || a.venueId) return { status: "skipped" };
  const text = a.venue;
  // Written only if the text is still the one that was looked up and
  // nothing was linked meanwhile (the organiser may have used "Change").
  const stillTheSame = { id: a.id, venue: text, venueId: null };

  if (isPlaceholderVenue(text)) {
    await db.activity.updateMany({ where: stillTheSame, data: { venueResolvedAt: now } });
    console.debug(`[geocode] activity=${a.id} outcome=placeholder`);
    return { status: "not-found" };
  }

  const got = await lookupText(a, text, now, opts.fetchImpl);

  if (got.status === "found") {
    const { count } = await db.activity.updateMany({
      where: stillTheSame,
      data: {
        venueId: got.venueId,
        venueConfidence: got.confidence,
        venueMatchSource: "text",
        venueQueryKey: got.key,
        venueResolvedAt: now,
        venueConfirmedAt: null,
        venueConfirmedById: null,
      },
    });
    if (count === 0) {
      console.debug(`[geocode] activity=${a.id} outcome=stale`);
      return { status: "stale" };
    }
    console.debug(`[geocode] activity=${a.id} outcome=found confidence=${got.confidence}`);
    return { status: "found", confidence: got.confidence };
  }

  if (got.status === "none") {
    await db.activity.updateMany({ where: stillTheSame, data: { venueResolvedAt: now, venueQueryKey: got.key } });
    console.debug(`[geocode] activity=${a.id} outcome=not-found`);
    return { status: "not-found" };
  }

  console.debug(`[geocode] activity=${a.id} outcome=${got.status}`);
  return { status: got.status };
}

/** `resolveActivityVenue` for a caller that must never see an exception. */
export async function resolveActivityVenueSafe(activityId: string, opts: VenueLookupOptions = {}): Promise<ResolveResult> {
  try {
    return await resolveActivityVenue(activityId, opts);
  } catch (err) {
    console.error(`[geocode] activity=${activityId} outcome=failed (${(err as Error)?.name ?? "error"})`);
    return { status: "error" };
  }
}

/** Every weekly game of a club that has never been looked up. */
export async function resolveUnresolvedVenuesForOrg(orgId: string, opts: VenueLookupOptions = {}): Promise<void> {
  const rows = await db.activity.findMany({
    where: { orgId, venueId: null, venueResolvedAt: null },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: VENUE_LOOKUPS_PER_CLUB_PER_DAY,
  });
  for (const row of rows) await resolveActivityVenueSafe(row.id, opts);
}

// ── The organiser's "Change" ────────────────────────────────────────────

export type ChangeResult =
  | { status: "found" }
  | { status: "not-found" | "capped" | "error" }
  /** "what3words": recognised and not readable. "link": any other link we cannot read. */
  | { status: "unsupported"; reason: "what3words" | "link" };

async function link(
  activityId: string,
  data: {
    venueId: string;
    confidence: VenueConfidence;
    source: VenueMatchSource;
    key: string | null;
    /** The organiser picked this exact place: that is a confirmation. */
    confirmedBy: string | null;
  },
  now: Date,
): Promise<void> {
  await db.activity.update({
    where: { id: activityId },
    data: {
      venueId: data.venueId,
      venueConfidence: data.confidence,
      venueMatchSource: data.source,
      venueQueryKey: data.key,
      venueResolvedAt: now,
      venueConfirmedAt: data.confirmedBy ? now : null,
      venueConfirmedById: data.confirmedBy,
    },
  });
}

/**
 * A fuller address or a pasted map link. The venue TEXT is never changed
 * here: the group keeps reading the organiser's own words.
 *
 * A place that is not found, a refused link and a failure all leave
 * whatever was linked before exactly as it was.
 */
export async function changeActivityVenue(
  activityId: string,
  userId: string,
  raw: string,
  opts: VenueLookupOptions = {},
): Promise<ChangeResult> {
  const now = opts.now ?? new Date();
  const a = await loadActivity(activityId);
  if (!a) return { status: "error" };

  let input: MapInput = parseMapInput(raw);

  if (input.kind === "short") {
    if (!(await claimLookup(a.orgId, a.id, "short-link", now))) return { status: "capped" };
    const expanded = await expandShortLink(input.url, { fetchImpl: opts.fetchImpl });
    console.debug(`[geocode] activity=${a.id} short-link=${expanded.ok ? "ok" : expanded.reason}`);
    if (!expanded.ok) return { status: "unsupported", reason: "link" };
    input = expanded.target;
  }

  switch (input.kind) {
    case "unsupported":
      return { status: "unsupported", reason: input.reason === "what3words" ? "what3words" : "link" };

    case "coords": {
      if (!(await claimLookup(a.orgId, a.id, "pin", now))) return { status: "capped" };
      const venue = await db.venue.create({
        data: {
          placeId: null,
          name: input.label ?? a.venue,
          formattedAddress: null,
          lat: input.lat,
          lng: input.lng,
          source: "map-link",
        },
        select: { id: true },
      });
      await link(a.id, { venueId: venue.id, confidence: "high", source: "link", key: null, confirmedBy: userId }, now);
      console.debug(`[geocode] activity=${a.id} outcome=found source=link confidence=high`);
      return { status: "found" };
    }

    case "placeId": {
      if (!geocodingConfigured()) return { status: "error" };
      if (!(await claimLookup(a.orgId, a.id, "geocode", now))) return { status: "capped" };
      const got = await geocode({ placeId: input.placeId }, { fetchImpl: opts.fetchImpl });
      if (got.status === "none") return { status: "not-found" };
      if (got.status !== "ok") return { status: "error" };
      const venueId = await upsertGooglePlace(got.hit, a.venue);
      await link(a.id, { venueId, confidence: "high", source: "link", key: null, confirmedBy: userId }, now);
      console.debug(`[geocode] activity=${a.id} outcome=found source=link confidence=high`);
      return { status: "found" };
    }

    case "address":
    case "text": {
      const source: VenueMatchSource = input.kind === "address" ? "address" : "link";
      const got = await lookupText(a, input.text, now, opts.fetchImpl);
      if (got.status === "none") return { status: "not-found" };
      if (got.status === "capped") return { status: "capped" };
      if (got.status !== "found") return { status: "error" };
      await link(
        a.id,
        { venueId: got.venueId, confidence: got.confidence, source, key: source === "address" ? got.key : null, confirmedBy: null },
        now,
      );
      console.debug(`[geocode] activity=${a.id} outcome=found source=${source} confidence=${got.confidence}`);
      return { status: "found" };
    }
  }
}

// ── The organiser's "Yes" ───────────────────────────────────────────────

/** Record the confirmation on the ACTIVITY. False when no place is linked. */
export async function confirmActivityVenue(activityId: string, userId: string, now: Date = new Date()): Promise<boolean> {
  const { count } = await db.activity.updateMany({
    where: { id: activityId, venueId: { not: null } },
    data: { venueConfirmedAt: now, venueConfirmedById: userId },
  });
  return count > 0;
}
