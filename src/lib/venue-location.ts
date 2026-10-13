/**
 * VENUE LOCATION, the part that touches the database (2026-10-12).
 *
 * Three things happen to a weekly game's place:
 *
 *   resolveActivityVenue   after a game is created or its venue text is
 *                          edited (and on the organiser's "Try again"):
 *                          look the text up, link the place, and RECORD
 *                          what the lookup came to. Run AFTER the save has
 *                          answered (see venue-location-schedule.ts), so
 *                          it can neither slow nor fail the save.
 *   changeActivityVenue    the organiser's "Change": a fuller address or
 *                          a pasted map link.
 *   confirmActivityVenue   the organiser's "Yes".
 *
 * WHAT IS STORED WHERE.
 *   `Venue`       a place, shared by every club that plays there (unique
 *                 on Google's place id), or one club's private pin.
 *   `VenueQuery`  what Google answered for a query (country plus
 *                 normalised words). Written only by `storeGoogleMatch`.
 *   `Activity`    everything that is one club's business: how sure the
 *                 match was, where the link came from, what the last
 *                 lookup came to, and who confirmed it.
 *
 * NO CLUB'S LOOKUP EVER READS ANOTHER CLUB'S ACTIVITY. The only shared
 * read is `VenueQuery`, which holds nothing but Google's own answers and
 * no club id. So nothing a club does to its own rows (a pasted pin, a
 * pasted link) can become the answer another club gets.
 *
 * COST. At most one Google call per save, and none when the query is
 * already in `VenueQuery`. Each club is capped at
 * `VENUE_LOOKUPS_PER_CLUB_PER_DAY` lookups per London day, and a cached
 * answer counts exactly like a call: the cap says nothing about what
 * other clubs have typed.
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
import { geocode, geocodingConfigured } from "./geocode";
import { expandShortLink, parseMapInput, type MapInput } from "./map-link";
import { placeDetails, placesConfigured, type PlaceDetails } from "./places";
import { storeGoogleMatch, upsertGooglePlace, type VenueStoreClient } from "./venue-store";
import { suggestLanguage, validPlaceId, type VenuePick } from "./venue-suggest-rules";
import {
  VENUE_LOOKUPS_PER_CLUB_PER_DAY,
  buildGeocodeQuery,
  classifyConfidence,
  clubCountry,
  isPlaceholderVenue,
  normaliseVenueText,
  venueQueryKey,
  type VenueConfidence,
  type VenueLookupStatus,
  type VenueMatchSource,
} from "./venue-location-rules";

export interface VenueLookupOptions {
  now?: Date;
  /** Tests hand a stub in; otherwise the test seam's `outboundFetch()`. */
  fetchImpl?: typeof fetch;
}

/** The shared client, as the two calls venue-store.ts makes. */
const store = db as unknown as VenueStoreClient;

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

/** Lookup kinds, as stored in `VenueLookup.kind`. */
type LookupKind = "geocode" | "reuse" | "short-link" | "pin" | "place-details";

/**
 * Count one lookup against the club's London day, or refuse it.
 *
 * Exactly `VENUE_LOOKUPS_PER_CLUB_PER_DAY` are allowed however many
 * requests arrive at once: the count and the insert run in one
 * transaction behind a transaction-scoped advisory lock keyed on the
 * club, so two requests for one club take turns. The lock ends with the
 * transaction (nothing is left on the session, so it is safe through a
 * transaction pooler) and touches no table row anybody else writes.
 */
async function claimLookup(orgId: string, activityId: string, kind: LookupKind, now: Date): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`venue-lookup:${orgId}`}))`;
    const used = await tx.venueLookup.count({ where: { orgId, createdAt: { gte: londonMidnight(now) } } });
    if (used >= VENUE_LOOKUPS_PER_CLUB_PER_DAY) return false;
    await tx.venueLookup.create({ data: { orgId, activityId, kind, createdAt: now }, select: { id: true } });
    return true;
  });
}

/**
 * Delete a club's private pin once nothing links it. A pin row belongs
 * to the one activity whose organiser pasted it; when that activity gets
 * another place, or new venue words, the old pin is nobody's. Only a
 * `map-link` row with no place id and no activity is ever deleted: never
 * a Google place. Never throws.
 */
export async function dropOrphanPin(venueId: string | null | undefined): Promise<void> {
  if (!venueId) return;
  try {
    await db.venue.deleteMany({ where: { id: venueId, placeId: null, source: "map-link", activities: { none: {} } } });
  } catch (err) {
    console.error(`[geocode] orphan pin cleanup failed (${(err as Error)?.name ?? "error"})`);
  }
}

/** A pin this old with no activity is not mid-save: it is abandoned. */
const ORPHAN_PIN_AGE_MS = 60_000;

/**
 * Delete every private pin that nothing links and that is older than a
 * minute. `dropOrphanPin` handles the usual case (the pin an activity
 * just stopped using); this catches what a race or a failed save left
 * behind. The age keeps it away from a pin that was created a moment ago
 * and is about to be linked. Runs whenever a place is linked by "Change".
 */
export async function sweepOrphanPins(now: Date): Promise<void> {
  try {
    await db.venue.deleteMany({
      where: {
        placeId: null,
        source: "map-link",
        activities: { none: {} },
        createdAt: { lt: new Date(now.getTime() - ORPHAN_PIN_AGE_MS) },
      },
    });
  } catch (err) {
    console.error(`[geocode] orphan pin sweep failed (${(err as Error)?.name ?? "error"})`);
  }
}

type TextLookup =
  | { status: "found"; venueId: string; confidence: VenueConfidence }
  | { status: "none" | "capped" | "error" | "off" };

/**
 * Words to a place. Google's earlier answer for the same query is reused
 * (as it was judged then: a low confidence answer stays low); otherwise
 * Google is asked once and its answer stored. Either way the club's cap
 * is charged one lookup first.
 */
async function lookupText(a: LoadedActivity, text: string, now: Date, fetchImpl: typeof fetch | undefined): Promise<TextLookup> {
  const country = countryOf(a);
  const key = venueQueryKey(text, country);

  const known = await db.venueQuery.findUnique({ where: { key }, select: { venueId: true, confidence: true } });
  if (!known && !geocodingConfigured()) return { status: "off" };
  if (!(await claimLookup(a.orgId, a.id, known ? "reuse" : "geocode", now))) return { status: "capped" };
  if (known) return { status: "found", venueId: known.venueId, confidence: known.confidence === "high" ? "high" : "low" };

  const got = await geocode(buildGeocodeQuery(text, country), { fetchImpl });
  if (got.status === "none") return { status: "none" };
  if (got.status !== "ok") return { status: got.status === "off" ? "off" : "error" };

  const confidence = classifyConfidence({ query: text, hit: got.hit, expectedCountry: country });
  const stored = await storeGoogleMatch(store, { key, hit: got.hit, name: text, confidence });
  return { status: "found", ...stored };
}

// ── A scheduled lookup ──────────────────────────────────────────────────

/**
 * Record that a lookup has been scheduled, so the page can say "looking"
 * because one IS under way and not because something else was saved.
 * One activity, or every game of a club that was never looked up.
 */
export async function markVenueLookupPending(target: { activityId: string } | { orgId: string }, now: Date = new Date()): Promise<void> {
  const data = { venueLookupStatus: "pending" satisfies VenueLookupStatus, venueResolvedAt: now };
  if ("activityId" in target) {
    await db.activity.updateMany({ where: { id: target.activityId, venueId: null }, data });
  } else {
    await db.activity.updateMany({ where: { orgId: target.orgId, venueId: null, venueLookupStatus: null }, data });
  }
}

/**
 * Write a lookup's result onto the activity, but only if it is still the
 * same venue and still has no place. "The same venue" is judged on the
 * NORMALISED words, not the raw text: an organiser who re-saves with a
 * comma moved while Google is answering has not changed the venue, and
 * the answer must land. New words mean the answer is stale and nothing
 * is written (the save that changed them scheduled its own lookup).
 */
async function writeIfSameVenue(activityId: string, lookedUp: string, data: Record<string, unknown>): Promise<boolean> {
  const wanted = normaliseVenueText(lookedUp);
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await db.activity.findUnique({ where: { id: activityId }, select: { venue: true, venueId: true } });
    if (!current || current.venueId || normaliseVenueText(current.venue) !== wanted) return false;
    const { count } = await db.activity.updateMany({ where: { id: activityId, venue: current.venue, venueId: null }, data });
    if (count > 0) return true;
  }
  return false;
}

export type ResolveResult =
  | { status: "found"; confidence: VenueConfidence }
  | { status: "not-found" | "skipped" | "capped" | "error" | "off" | "stale" };

/**
 * Look an activity's venue text up, link the place, and record what the
 * lookup came to. Only for an activity with NO place linked: an edit of
 * the text clears the link in the same write before this runs.
 */
export async function resolveActivityVenue(activityId: string, opts: VenueLookupOptions = {}): Promise<ResolveResult> {
  const now = opts.now ?? new Date();
  const a = await loadActivity(activityId);
  if (!a || a.venueId) return { status: "skipped" };
  const text = a.venue;

  if (isPlaceholderVenue(text)) {
    // "TBD" is not a place: it stays "never looked up".
    await writeIfSameVenue(a.id, text, { venueLookupStatus: null, venueResolvedAt: null });
    console.debug(`[geocode] activity=${a.id} outcome=placeholder`);
    return { status: "skipped" };
  }

  const got = await lookupText(a, text, now, opts.fetchImpl);

  if (got.status === "found") {
    const written = await writeIfSameVenue(a.id, text, {
      venueId: got.venueId,
      venueConfidence: got.confidence,
      venueMatchSource: "text" satisfies VenueMatchSource,
      venueLookupStatus: "found" satisfies VenueLookupStatus,
      venueResolvedAt: now,
      venueConfirmedAt: null,
      venueConfirmedById: null,
    });
    if (!written) {
      console.debug(`[geocode] activity=${a.id} outcome=stale`);
      return { status: "stale" };
    }
    console.debug(`[geocode] activity=${a.id} outcome=found confidence=${got.confidence}`);
    return { status: "found", confidence: got.confidence };
  }

  // What is recorded, so the page never says "not found" for a lookup
  // that was not made: only Google answering with nothing is "none".
  const recorded: VenueLookupStatus = got.status === "none" ? "none" : got.status === "capped" ? "capped" : "failed";
  const written = await writeIfSameVenue(a.id, text, { venueLookupStatus: recorded, venueResolvedAt: now });
  console.debug(`[geocode] activity=${a.id} outcome=${written ? got.status : "stale"}`);
  if (!written) return { status: "stale" };
  return { status: got.status === "none" ? "not-found" : got.status };
}

/** `resolveActivityVenue` for a caller that must never see an exception. */
export async function resolveActivityVenueSafe(activityId: string, opts: VenueLookupOptions = {}): Promise<ResolveResult> {
  try {
    return await resolveActivityVenue(activityId, opts);
  } catch (err) {
    console.error(`[geocode] activity=${activityId} outcome=failed (${(err as Error)?.name ?? "error"})`);
    try {
      await db.activity.updateMany({
        where: { id: activityId, venueId: null, venueLookupStatus: "pending" },
        data: { venueLookupStatus: "failed", venueResolvedAt: opts.now ?? new Date() },
      });
    } catch {
      // The page turns a pending lookup that never reported into "failed" on its own.
    }
    return { status: "error" };
  }
}

/** Every weekly game of a club with a lookup scheduled and not yet made. */
export async function resolvePendingVenuesForOrg(orgId: string, opts: VenueLookupOptions = {}): Promise<void> {
  const rows = await db.activity.findMany({
    where: { orgId, venueId: null, venueLookupStatus: "pending" },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: VENUE_LOOKUPS_PER_CLUB_PER_DAY,
  });
  for (const row of rows) await resolveActivityVenueSafe(row.id, opts);
}

// ── The organiser's "Change" ────────────────────────────────────────────

export type ChangeResult =
  | { status: "found" }
  /** "error": Google could not be asked just now. */
  | { status: "not-found" | "capped" | "error" }
  /** "what3words": recognised and not readable. "link": any other link we cannot read. */
  | { status: "unsupported"; reason: "what3words" | "link" };

async function link(
  a: LoadedActivity,
  data: {
    venueId: string;
    confidence: VenueConfidence;
    source: VenueMatchSource;
    /** The organiser picked this exact place: that is a confirmation. */
    confirmedBy: string | null;
  },
  now: Date,
): Promise<void> {
  await db.activity.update({
    where: { id: a.id },
    data: {
      venueId: data.venueId,
      venueConfidence: data.confidence,
      venueMatchSource: data.source,
      venueLookupStatus: "found" satisfies VenueLookupStatus,
      venueResolvedAt: now,
      venueConfirmedAt: data.confirmedBy ? now : null,
      venueConfirmedById: data.confirmedBy,
    },
  });
  // The place this one replaced, if it was this club's private pin.
  if (a.venueId && a.venueId !== data.venueId) await dropOrphanPin(a.venueId);
  await sweepOrphanPins(now);
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
    if (!expanded.ok) {
      // A reason code and no URL: enough to see, in the logs, that a real
      // short link came back as something this code refuses (for example a
      // consent page instead of the map). The organiser is told to paste
      // another link or type the address.
      console.warn(`[geocode] activity=${a.id} short-link=refused reason=${expanded.reason}`);
      return { status: "unsupported", reason: "link" };
    }
    console.debug(`[geocode] activity=${a.id} short-link=ok kind=${expanded.target.kind}`);
    input = expanded.target;
  }

  switch (input.kind) {
    case "unsupported":
      if (input.reason !== "empty") console.debug(`[geocode] activity=${a.id} link=refused reason=${input.reason}`);
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
      await link(a, { venueId: venue.id, confidence: "high", source: "link", confirmedBy: userId }, now);
      console.debug(`[geocode] activity=${a.id} outcome=found source=link confidence=high`);
      return { status: "found" };
    }

    case "placeId": {
      if (!geocodingConfigured()) return { status: "error" };
      if (!(await claimLookup(a.orgId, a.id, "geocode", now))) return { status: "capped" };
      const got = await geocode({ placeId: input.placeId }, { fetchImpl: opts.fetchImpl });
      if (got.status === "none") return { status: "not-found" };
      if (got.status !== "ok") return { status: "error" };
      // The shared place only: a place id the organiser pasted answers no
      // query, so nothing goes into VenueQuery.
      const venueId = await upsertGooglePlace(store, got.hit, a.venue);
      await link(a, { venueId, confidence: "high", source: "link", confirmedBy: userId }, now);
      console.debug(`[geocode] activity=${a.id} outcome=found source=link confidence=high`);
      return { status: "found" };
    }

    case "address": {
      const got = await lookupText(a, input.text, now, opts.fetchImpl);
      if (got.status === "none") return { status: "not-found" };
      if (got.status === "capped") return { status: "capped" };
      if (got.status !== "found") return { status: "error" };
      await link(a, { venueId: got.venueId, confidence: got.confidence, source: "address", confirmedBy: null }, now);
      console.debug(`[geocode] activity=${a.id} outcome=found source=address confidence=${got.confidence}`);
      return { status: "found" };
    }

    case "text": {
      // A place NAMED in a pasted link. The words came from a URL the
      // organiser supplied, so the answer is theirs alone: Google is
      // asked, but nothing is read from or written to VenueQuery.
      if (!geocodingConfigured()) return { status: "error" };
      if (!(await claimLookup(a.orgId, a.id, "geocode", now))) return { status: "capped" };
      const country = countryOf(a);
      const got = await geocode(buildGeocodeQuery(input.text, country), { fetchImpl: opts.fetchImpl });
      if (got.status === "none") return { status: "not-found" };
      if (got.status !== "ok") return { status: "error" };
      const confidence = classifyConfidence({ query: input.text, hit: got.hit, expectedCountry: country });
      const venueId = await upsertGooglePlace(store, got.hit, input.text);
      await link(a, { venueId, confidence, source: "link", confirmedBy: null }, now);
      console.debug(`[geocode] activity=${a.id} outcome=found source=link confidence=${confidence}`);
      return { status: "found" };
    }
  }
}

// ── A place picked from the suggestions under the venue box ─────────────

/**
 * THE SERVER FINDS OUT WHAT A PICKED PLACE IS (2026-10-13). A browser
 * hands over a place id and nothing else about the place; this asks
 * Google's Place Details for it (with the suggestions' session token, so
 * the exchange is billed as one session) and upserts the shared place
 * from GOOGLE'S answer. Charged to the club's daily cap like any lookup.
 *
 * A pick answers no query, so nothing is written to `VenueQuery`.
 */
type PickedPlace =
  | { status: "found"; venueId: string }
  /** The club's daily lookups are used up: nothing was sent. */
  | { status: "capped" }
  /** No key, an unknown place id, or Google failing: the caller falls
   *  back to looking the venue text up. */
  | { status: "unresolved" };

async function lookupPick(a: LoadedActivity, pick: VenuePick, now: Date, fetchImpl: typeof fetch | undefined): Promise<PickedPlace> {
  // Nothing is counted, or sent, for an id that is not one.
  if (!placesConfigured() || !validPlaceId(pick.placeId)) return { status: "unresolved" };
  if (!(await claimLookup(a.orgId, a.id, "place-details", now))) return { status: "capped" };
  const got = await placeDetails(
    { placeId: pick.placeId, sessionToken: pick.sessionToken ?? null, languageCode: suggestLanguage(a.org.language) },
    { fetchImpl },
  );
  if (got.status !== "ok") {
    // A reason code only: never the place id.
    console.debug(`[geocode] activity=${a.id} pick=unresolved reason=${got.status === "error" ? got.code : got.status}`);
    return { status: "unresolved" };
  }
  const place: PlaceDetails = got.place;
  return { status: "found", venueId: await upsertGooglePlace(store, place, place.name || a.venue) };
}

/**
 * After a save that carried a pick (a new club, a new weekly game, or an
 * edit of the venue): link the picked place. HIGH confidence, source
 * "pick", and CONFIRMED by the organiser, because choosing this exact
 * place from a list is the confirmation (the same reasoning as a pasted
 * pin). Run AFTER the save has answered, like every other lookup.
 *
 * IT NEVER FAILS THE SAVE AND NEVER LEAVES THE VENUE UNLOOKED. If Google
 * does not resolve the place id (unknown, refused, slow, down, no key),
 * the venue TEXT is looked up exactly as if nothing had been picked
 * (`resolveActivityVenue`): a text match, unconfirmed.
 *
 * Like `resolveActivityVenue` it only writes to an activity with no
 * place linked and the same venue words as when it started.
 */
export async function resolveActivityVenuePick(
  activityId: string,
  userId: string,
  pick: VenuePick,
  opts: VenueLookupOptions = {},
): Promise<ResolveResult> {
  const now = opts.now ?? new Date();
  const a = await loadActivity(activityId);
  if (!a || a.venueId) return { status: "skipped" };

  const got = await lookupPick(a, pick, now, opts.fetchImpl);

  if (got.status === "capped") {
    const written = await writeIfSameVenue(a.id, a.venue, { venueLookupStatus: "capped" satisfies VenueLookupStatus, venueResolvedAt: now });
    console.debug(`[geocode] activity=${a.id} outcome=${written ? "capped" : "stale"} source=pick`);
    return { status: written ? "capped" : "stale" };
  }
  if (got.status === "unresolved") return resolveActivityVenue(activityId, opts);

  const written = await writeIfSameVenue(a.id, a.venue, {
    venueId: got.venueId,
    venueConfidence: "high" satisfies VenueConfidence,
    venueMatchSource: "pick" satisfies VenueMatchSource,
    venueLookupStatus: "found" satisfies VenueLookupStatus,
    venueResolvedAt: now,
    venueConfirmedAt: now,
    venueConfirmedById: userId,
  });
  console.debug(`[geocode] activity=${a.id} outcome=${written ? "found" : "stale"} source=pick confidence=high`);
  return written ? { status: "found", confidence: "high" } : { status: "stale" };
}

/** `resolveActivityVenuePick` for a caller that must never see an exception. */
export async function resolveActivityVenuePickSafe(
  activityId: string,
  userId: string,
  pick: VenuePick,
  opts: VenueLookupOptions = {},
): Promise<ResolveResult> {
  try {
    return await resolveActivityVenuePick(activityId, userId, pick, opts);
  } catch (err) {
    console.error(`[geocode] activity=${activityId} outcome=failed source=pick (${(err as Error)?.name ?? "error"})`);
    // Whatever broke, the venue text still gets its ordinary lookup.
    return resolveActivityVenueSafe(activityId, opts);
  }
}

/**
 * The organiser's "Change", with a place picked from the suggestions in
 * its box. Links the picked place over whatever was linked, confirmed.
 * The venue TEXT is never changed here.
 *
 * "unresolved": Google did not resolve the place id. Nothing was changed,
 * and the caller looks the typed words up instead (`changeActivityVenue`).
 */
export async function changeActivityVenueToPick(
  activityId: string,
  userId: string,
  pick: VenuePick,
  opts: VenueLookupOptions = {},
): Promise<{ status: "found" | "capped" | "unresolved" }> {
  const now = opts.now ?? new Date();
  const a = await loadActivity(activityId);
  if (!a) return { status: "unresolved" };
  const got = await lookupPick(a, pick, now, opts.fetchImpl);
  if (got.status !== "found") return { status: got.status };
  await link(a, { venueId: got.venueId, confidence: "high", source: "pick", confirmedBy: userId }, now);
  console.debug(`[geocode] activity=${a.id} outcome=found source=pick confidence=high`);
  return { status: "found" };
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
