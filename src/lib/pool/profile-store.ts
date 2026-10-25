/**
 * Writing a pool profile's fields (slice L2): the ONE place that turns the
 * validated fields (`profile-fields.ts`) into rows, shared by the /play
 * sign-up, the manage page's edit and a member's join.
 *
 * AREA (`PoolArea`, rules.ts): a postcode district, placed once at its
 * centre point: from another profile that already has the same district
 * (no lookup at all), else one Google Geocoding call (`geocode.ts`, reused;
 * it never throws and sends the district and the region only). A district
 * Google cannot place as a UK postcode area, matched whole
 * (`acceptDistrictGeocode`), is refused, so a profile's centre point is
 * never a guess. Chosen pitches were retired on 2026-10-25: nothing here
 * reads or writes `PoolProfile.venueIds` any more.
 */
import { db } from "../db";
import { geocode } from "../geocode";
import type { PoolFields } from "./profile-fields";
import { acceptDistrictGeocode } from "./rules";

export type AreaResult = { ok: true; areaDistrict: string; areaLat: number; areaLng: number } | { ok: false; reason: "area-not-found" };

/** Where he plays from, ready to store. `current`: the profile's stored
 *  area, so an unchanged district costs no lookup. */
export async function resolveArea(
  fields: Pick<PoolFields, "areaDistrict">,
  current?: { areaDistrict: string | null; areaLat: number | null; areaLng: number | null } | null,
): Promise<AreaResult> {
  const district = fields.areaDistrict;
  if (current?.areaDistrict === district && current.areaLat !== null && current.areaLng !== null) {
    return { ok: true, areaDistrict: district, areaLat: current.areaLat, areaLng: current.areaLng };
  }
  const known = await db.poolProfile.findFirst({
    where: { areaDistrict: district, areaLat: { not: null }, areaLng: { not: null } },
    select: { areaLat: true, areaLng: true },
  });
  if (known?.areaLat != null && known.areaLng != null) {
    return { ok: true, areaDistrict: district, areaLat: known.areaLat, areaLng: known.areaLng };
  }
  const out = await geocode({ address: `${district}, UK`, region: "gb" });
  if (out.status !== "ok" || !acceptDistrictGeocode(out.hit)) return { ok: false, reason: "area-not-found" };
  return { ok: true, areaDistrict: district, areaLat: out.hit.lat, areaLng: out.hit.lng };
}

/** The `PoolSport` rows for a profile's sports. */
export function sportRows(fields: Pick<PoolFields, "sports">) {
  return fields.sports.map((s) => ({ sport: s.sport, otherName: s.otherName, level: s.level, levelText: s.levelText, formats: s.formats }));
}

/** The `PoolAvailability` rows for a profile's days and hours. */
export function availabilityRows(fields: Pick<PoolFields, "availability">) {
  return fields.availability.map((a) => ({ day: a.day, fromMin: a.fromMin, toMin: a.toMin }));
}
