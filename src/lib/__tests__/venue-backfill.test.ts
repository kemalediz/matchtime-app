/**
 * The venue backfill's plan (scripts/backfill-venue-locations.ts): one
 * Google call per distinct venue text and country, and only a HIGH
 * confidence match is ever linked. Plus a source guard on the script:
 * dry run by default, no session SET, no raw SQL.
 *
 * Google is a stub function here. No database and no network.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import type { GeocodeOutcome } from "../geocode";
import { planVenueBackfill, type BackfillRow } from "../venue-backfill";

const row = (over: Partial<BackfillRow> & { activityId: string }): BackfillRow => ({
  orgId: "org-a",
  venue: "Powerleague Shoreditch",
  ownerPhone: "+447700900001",
  language: "en",
  ...over,
});

const found = (over: Partial<Extract<GeocodeOutcome, { status: "ok" }>["hit"]> = {}): GeocodeOutcome => ({
  status: "ok",
  hit: {
    placeId: "PID",
    formattedAddress: "Braithwaite St, London E1 6GJ, UK",
    lat: 51.52,
    lng: -0.07,
    types: ["establishment"],
    partialMatch: false,
    locationType: "GEOMETRIC_CENTER",
    countryCode: "GB",
    ...over,
  },
});

describe("the backfill plan", () => {
  it("makes one Google call per distinct venue text and country", async () => {
    const lookup = vi.fn(async () => found());
    const plan = await planVenueBackfill(
      [
        row({ activityId: "a1" }),
        row({ activityId: "a2", orgId: "org-b", venue: "powerleague  SHOREDITCH." }),
        row({ activityId: "a3", orgId: "org-c", venue: "Powerleague Shoreditch", ownerPhone: "+905321234567" }),
      ],
      lookup,
    );
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(plan.googleCalls).toBe(2);
    expect(lookup.mock.calls.map((c) => (c as unknown as [unknown])[0])).toEqual([
      { address: "Powerleague Shoreditch", region: "uk" },
      { address: "Powerleague Shoreditch", region: "tr" },
    ]);
    expect(plan.lines.map((l) => [l.activityId, l.outcome])).toEqual([
      ["a1", "link"],
      ["a2", "link"],
      // Found in the UK for a club whose organiser has a Turkish number: not sure.
      ["a3", "low-confidence"],
    ]);
  });

  it("only a high confidence match is to be linked; the rest are left for the organiser", async () => {
    const answers: Record<string, GeocodeOutcome> = {
      "Powerleague Shoreditch": found(),
      Powerleague: found({ placeId: "PID2" }),
      "the park": found({ placeId: "PID3", types: ["locality"], locationType: "APPROXIMATE" }),
      "Nowhere Arena": { status: "none" },
      "Broken Lane": { status: "error", code: "timeout" },
    };
    const lookup = vi.fn(async (q: { address: string }) => answers[q.address]);
    const plan = await planVenueBackfill(
      [
        row({ activityId: "a1" }),
        row({ activityId: "a2", venue: "Powerleague" }),
        row({ activityId: "a3", venue: "the park" }),
        row({ activityId: "a4", venue: "Nowhere Arena" }),
        row({ activityId: "a5", venue: "Broken Lane" }),
        row({ activityId: "a6", venue: "TBD" }),
      ],
      lookup,
    );
    expect(plan.lines.map((l) => [l.activityId, l.outcome, l.confidence])).toEqual([
      ["a1", "link", "high"],
      ["a2", "low-confidence", "low"],
      ["a3", "low-confidence", "low"],
      ["a4", "not-found", null],
      ["a5", "error", null],
      ["a6", "placeholder", null],
    ]);
    expect(plan.lines.filter((l) => l.outcome === "link").map((l) => l.activityId)).toEqual(["a1"]);
    expect(plan.lines[0]).toMatchObject({
      orgId: "org-a",
      venue: "Powerleague Shoreditch",
      address: "Braithwaite St, London E1 6GJ, UK",
      key: "GB|powerleague shoreditch",
    });
    // A placeholder is never sent to Google.
    expect(lookup).toHaveBeenCalledTimes(5);
  });

  it("Google being off stops the run at the first call", async () => {
    const lookup = vi.fn(async (): Promise<GeocodeOutcome> => ({ status: "off" }));
    const plan = await planVenueBackfill([row({ activityId: "a1" }), row({ activityId: "a2", venue: "Goals North Cheam" })], lookup);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(plan.off).toBe(true);
  });
});

describe("the backfill script", () => {
  const src = readFileSync(path.resolve(__dirname, "..", "..", "..", "scripts", "backfill-venue-locations.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("writes only behind --apply", () => {
    expect(src).toMatch(/process\.argv\.includes\("--apply"\)/);
    const firstWrite = src.search(/\.(upsert|updateMany|update|create|delete|deleteMany|createMany)\s*\(/);
    expect(firstWrite).toBeGreaterThan(0);
    expect(src.slice(0, firstWrite)).toMatch(/if \(!apply\)[\s\S]*return;/);
  });

  it("has no session SET, raw SQL or transaction (safe through the production pooler)", () => {
    expect(
      src.match(/\$(executeRaw|executeRawUnsafe|queryRaw|queryRawUnsafe|transaction)\b|\bSET\s+(LOCAL\s+|SESSION\s+)?[a-z_]+\s*(=|TO)\b|\bBEGIN\b/i)?.[0] ?? null,
    ).toBeNull();
  });

  it("reads DIRECT_URL first, then the app's DATABASE_URL", () => {
    expect(src).toMatch(/process\.env\.DIRECT_URL\s*\|\|\s*process\.env\.DATABASE_URL/);
  });
});
