import type { Venue } from "@/generated/prisma/client";
import { db } from "@/lib/db";

/**
 * Call the Google Geocoding API for a free-text query and return the top
 * match's place id, formatted address, and coordinates. Returns null when
 * the API responds with a non-OK status or no results. The `key` must be a
 * valid Google Maps API key — callers are responsible for the absence case.
 */
export async function geocodeAddress(
  query: string,
  key: string,
): Promise<{ placeId: string; formattedAddress: string; lat: number; lng: number } | null> {
  const url =
    "https://maps.googleapis.com/maps/api/geocode/json" +
    `?address=${encodeURIComponent(query)}&key=${key}`;

  const res = await fetch(url);
  const data = await res.json();

  if (data?.status !== "OK" || !Array.isArray(data.results) || data.results.length === 0) {
    console.debug(`[geocode] no result for query (status=${data?.status ?? "unknown"})`);
    return null;
  }

  const top = data.results[0];
  return {
    placeId: top.place_id,
    formattedAddress: top.formatted_address,
    lat: top.geometry.location.lat,
    lng: top.geometry.location.lng,
  };
}

/**
 * Resolve a venue name (optionally with an address) to a global, deduped
 * {@link Venue} row, geocoding via Google and upserting on Google Place ID.
 *
 * Graceful by design: if GOOGLE_MAPS_API_KEY is unset/empty, or the query
 * yields no geocode result, returns null and never throws — so callers can
 * treat venue resolution as best-effort enrichment.
 */
export async function resolveVenue(input: { name: string; address?: string }): Promise<Venue | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    console.debug("[geocode] GOOGLE_MAPS_API_KEY not set; skipping venue resolution");
    return null;
  }

  const query = input.address ? `${input.name}, ${input.address}` : input.name;
  const geo = await geocodeAddress(query, key);
  if (!geo) return null;

  return db.venue.upsert({
    where: { placeId: geo.placeId },
    update: {},
    create: {
      placeId: geo.placeId,
      name: input.name,
      formattedAddress: geo.formattedAddress,
      lat: geo.lat,
      lng: geo.lng,
      source: "google",
    },
  });
}
