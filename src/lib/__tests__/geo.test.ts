/**
 * Unit tests for the pure geo primitives in src/lib/geo.ts.
 *
 * distanceKm is a pure haversine; no DB, no network — safe to import
 * directly under vitest's transpiler.
 */
import { describe, it, expect } from "vitest";
import { distanceKm } from "@/lib/geo";

// London and Paris city centres.
const LONDON = { lat: 51.5074, lng: -0.1278 };
const PARIS = { lat: 48.8566, lng: 2.3522 };

describe("distanceKm", () => {
  it("computes London → Paris ≈ 343 km (±5 km)", () => {
    const d = distanceKm(LONDON.lat, LONDON.lng, PARIS.lat, PARIS.lng);
    expect(d).toBeGreaterThan(338);
    expect(d).toBeLessThan(348);
  });

  it("returns 0 for an identical point", () => {
    expect(distanceKm(LONDON.lat, LONDON.lng, LONDON.lat, LONDON.lng)).toBe(0);
  });

  it("is symmetric: d(a,b) === d(b,a)", () => {
    const ab = distanceKm(LONDON.lat, LONDON.lng, PARIS.lat, PARIS.lng);
    const ba = distanceKm(PARIS.lat, PARIS.lng, LONDON.lat, LONDON.lng);
    expect(ab).toBe(ba);
  });
});
