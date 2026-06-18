/**
 * Unit tests for resolveVenue in src/lib/geocode.ts.
 *
 * geocode.ts imports the Prisma client (via @/lib/db), which vitest's
 * transpiler cannot load (Prisma 7 generated ESM-TS). So the db module is
 * mocked — these tests are PURE: no real DB, no real network. fetch is
 * stubbed per-test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db", () => ({ db: { venue: { upsert: vi.fn() } } }));

import { resolveVenue } from "@/lib/geocode";
import { db } from "@/lib/db";

// Typed handle to the mocked upsert.
const upsert = db.venue.upsert as unknown as ReturnType<typeof vi.fn>;

const fakeGoogleResp = {
  status: "OK",
  results: [
    {
      place_id: "PID_123",
      formatted_address: "1 Pitch Rd, London",
      geometry: { location: { lat: 51.5, lng: -0.1 } },
    },
  ],
};

const fakeVenue = {
  id: "venue_1",
  placeId: "PID_123",
  name: "Powerleague",
  formattedAddress: "1 Pitch Rd, London",
  lat: 51.5,
  lng: -0.1,
  source: "google",
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("resolveVenue", () => {
  it("(a) returns null and does not touch the DB when the API key is unset", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "");
    const result = await resolveVenue({ name: "Powerleague", address: "London" });
    expect(result).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("(b) geocodes and upserts a venue when the key and a result are present", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: async () => fakeGoogleResp }),
    );
    upsert.mockResolvedValue(fakeVenue);

    const result = await resolveVenue({ name: "Powerleague", address: "London" });

    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where.placeId).toBe("PID_123");
    expect(arg.create).toMatchObject({
      placeId: "PID_123",
      lat: 51.5,
      lng: -0.1,
      source: "google",
    });
    expect(result).toEqual(fakeVenue);
  });

  it("(c) dedupes: two identical calls upsert on the same placeId with update:{} and return the same row", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: async () => fakeGoogleResp }),
    );
    upsert.mockResolvedValue(fakeVenue);

    const first = await resolveVenue({ name: "Powerleague", address: "London" });
    const second = await resolveVenue({ name: "Powerleague", address: "London" });

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[0][0].where.placeId).toBe("PID_123");
    expect(upsert.mock.calls[1][0].where.placeId).toBe("PID_123");
    expect(upsert.mock.calls[0][0].update).toEqual({});
    expect(upsert.mock.calls[1][0].update).toEqual({});
    expect(first?.id).toBe(second?.id);
  });
});
