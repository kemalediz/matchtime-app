/**
 * Writing a pool profile's fields (slice L2): the ONE place that turns the
 * validated fields (`profile-fields.ts`) into rows, shared by the /play
 * sign-up and the manage page's edit.
 *
 * AREA. A postcode district is placed once at its centre point: from
 * another profile that already has the same district (no lookup at all),
 * else one Google Geocoding call (`geocode.ts`, reused; it never throws and
 * sends the district and the region only). A district Google cannot place
 * as a UK postcode area, matched whole (`acceptDistrictGeocode`), is refused, so the CHECK "a centre point or chosen pitches" can
 * never be met by a guess. Chosen pitches are MatchTime's own geocoded
 * venues (`Venue`), searched by name; no lookup, no cost.
 */
import { db } from "../db";
import { geocode } from "../geocode";
import type { PoolFields } from "./profile-fields";
import { POOL_SIGNUP, acceptDistrictGeocode } from "./rules";

export type AreaResult =
  | { ok: true; areaDistrict: string | null; areaLat: number | null; areaLng: number | null; venueIds: string[] }
  | { ok: false; reason: "area-not-found" | "venues-unknown" };

/** Where he plays from, ready to store. `current`: the profile's stored
 *  area, so an unchanged district costs no lookup. */
export async function resolveArea(
  fields: Pick<PoolFields, "areaDistrict" | "venueIds">,
  current?: { areaDistrict: string | null; areaLat: number | null; areaLng: number | null } | null,
): Promise<AreaResult> {
  if (fields.areaDistrict) {
    const district = fields.areaDistrict;
    if (current?.areaDistrict === district && current.areaLat !== null && current.areaLng !== null) {
      return { ok: true, areaDistrict: district, areaLat: current.areaLat, areaLng: current.areaLng, venueIds: [] };
    }
    const known = await db.poolProfile.findFirst({
      where: { areaDistrict: district, areaLat: { not: null }, areaLng: { not: null } },
      select: { areaLat: true, areaLng: true },
    });
    if (known?.areaLat != null && known.areaLng != null) {
      return { ok: true, areaDistrict: district, areaLat: known.areaLat, areaLng: known.areaLng, venueIds: [] };
    }
    const out = await geocode({ address: `${district}, UK`, region: "gb" });
    if (out.status !== "ok" || !acceptDistrictGeocode(out.hit)) return { ok: false, reason: "area-not-found" };
    return { ok: true, areaDistrict: district, areaLat: out.hit.lat, areaLng: out.hit.lng, venueIds: [] };
  }
  const venues = await db.venue.findMany({
    where: { id: { in: fields.venueIds }, lat: { not: null }, lng: { not: null } },
    select: { id: true },
  });
  const ids = fields.venueIds.filter((id) => venues.some((v) => v.id === id));
  if (ids.length === 0) return { ok: false, reason: "venues-unknown" };
  return { ok: true, areaDistrict: null, areaLat: null, areaLng: null, venueIds: ids };
}

/** The `PoolSport` rows for a profile's sports. */
export function sportRows(fields: Pick<PoolFields, "sports">) {
  return fields.sports.map((s) => ({ sport: s.sport, otherName: s.otherName, level: s.level, levelText: s.levelText, formats: s.formats }));
}

/** The `PoolAvailability` rows for a profile's days and hours. */
export function availabilityRows(fields: Pick<PoolFields, "availability">) {
  return fields.availability.map((a) => ({ day: a.day, fromMin: a.fromMin, toMin: a.toMin }));
}

export interface PoolVenueOption {
  id: string;
  name: string;
  address: string | null;
}

/** MatchTime's geocoded pitches whose name or address contains `q`. */
export async function searchPoolVenues(q: string): Promise<PoolVenueOption[]> {
  const term = q.trim().slice(0, 60);
  if (term.length < 3) return [];
  const rows = await db.venue.findMany({
    where: {
      lat: { not: null },
      lng: { not: null },
      OR: [{ name: { contains: term, mode: "insensitive" } }, { formattedAddress: { contains: term, mode: "insensitive" } }],
    },
    orderBy: { name: "asc" },
    take: POOL_SIGNUP.maxVenues,
    select: { id: true, name: true, formattedAddress: true },
  });
  return rows.map((r) => ({ id: r.id, name: r.name, address: r.formattedAddress }));
}

/** The chosen pitches, by id, in the order given. */
export async function loadPoolVenues(ids: readonly string[]): Promise<PoolVenueOption[]> {
  if (ids.length === 0) return [];
  const rows = await db.venue.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true, formattedAddress: true } });
  return ids.flatMap((id) => rows.filter((r) => r.id === id).map((r) => ({ id: r.id, name: r.name, address: r.formattedAddress })));
}
