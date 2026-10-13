/**
 * THE ONE WRITER OF A GOOGLE ANSWER (2026-10-12, review of PR #241).
 *
 * `storeGoogleMatch` is called straight after Google answered a TEXT
 * lookup, by the app (venue-location.ts) and by the backfill script. It
 * upserts the shared `Venue` row on Google's place id and records, in
 * `VenueQuery`, that these words in this country mean that place, with
 * the confidence judged from Google's answer.
 *
 * `VenueQuery` is what lets a second club typing the same words skip the
 * Google call. It is deliberately NOT read off other clubs' `Activity`
 * rows: an activity row can be written by its own club's choices (a
 * pasted pin, a pasted link), a query row cannot. Nothing here takes a
 * value from a client: the key is computed from the words that were sent
 * to Google, and the place and confidence come from Google's answer.
 *
 * The first answer for a key is kept (`update: {}`): the mapping is
 * stable, and a later caller cannot move it.
 *
 * No database import: the caller hands its own client in, so the script
 * (its own connection) and the app (the shared one) use the same code.
 */
import type { GeocodeHit } from "./geocode";
import type { VenueConfidence } from "./venue-location-rules";

/**
 * The two calls this file makes, spelled out, so that the app's extended
 * Prisma client and the script's plain one both fit (their generated
 * types differ; what they do is the same).
 */
export interface VenuePlaceClient {
  venue: {
    upsert(args: {
      where: { placeId: string };
      update: Record<string, never>;
      create: { placeId: string; name: string; formattedAddress: string | null; lat: number; lng: number; source: string };
      select: { id: true };
    }): Promise<{ id: string }>;
  };
}
export interface VenueStoreClient extends VenuePlaceClient {
  venueQuery: {
    upsert(args: {
      where: { key: string };
      update: Record<string, never>;
      create: { key: string; venueId: string; confidence: string };
      select: { venueId: true; confidence: true };
    }): Promise<{ venueId: string; confidence: string }>;
  };
}

/** What a Google answer must carry to become a shared place: Geocoding's
 *  hit and Places' details (src/lib/places.ts) both do. */
export type GooglePlace = Pick<GeocodeHit, "placeId" | "formattedAddress" | "lat" | "lng">;

/** Upsert the shared place for a Google result. Returns its id. */
export async function upsertGooglePlace(client: VenuePlaceClient, hit: GooglePlace, name: string): Promise<string> {
  const venue = await client.venue.upsert({
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

/**
 * Record Google's answer for a text query. Returns the place and the
 * confidence that are now on record for the key, which are the first
 * ones ever stored for it.
 */
export async function storeGoogleMatch(
  client: VenueStoreClient,
  input: { key: string; hit: GeocodeHit; name: string; confidence: VenueConfidence },
): Promise<{ venueId: string; confidence: VenueConfidence }> {
  const venueId = await upsertGooglePlace(client, input.hit, input.name);
  const row = await client.venueQuery.upsert({
    where: { key: input.key },
    update: {},
    create: { key: input.key, venueId, confidence: input.confidence },
    select: { venueId: true, confidence: true },
  });
  return { venueId: row.venueId, confidence: row.confidence === "high" ? "high" : "low" };
}
