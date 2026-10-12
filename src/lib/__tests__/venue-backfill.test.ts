/**
 * The venue backfill (scripts/backfill-venue-locations.ts): its plan, its
 * arguments, and a source guard on the script.
 *
 *   - one Google call per distinct venue text and country;
 *   - a HIGH match is linked as high, a LOW one as low, and nothing is
 *     ever confirmed;
 *   - a quota or refused-key answer STOPS the run;
 *   - `--org` with no value is refused (it used to mean "every club");
 *   - dry run by default, no session SET, no raw SQL.
 *
 * Google is a stub function here. No database and no network.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import type { GeocodeOutcome } from "../geocode";
import { parseBackfillArgs, planVenueBackfill, type BackfillRow } from "../venue-backfill";

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
      ["a3", "link-low"],
    ]);
    expect(plan.stopped).toBeNull();
  });

  it("high is linked as high, low as low (for the organiser's question); the rest are left alone", async () => {
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
      ["a2", "link-low", "low"],
      ["a3", "link-low", "low"],
      ["a4", "not-found", null],
      ["a5", "error", null],
      ["a6", "placeholder", null],
    ]);
    expect(plan.lines[0]).toMatchObject({
      orgId: "org-a",
      venue: "Powerleague Shoreditch",
      address: "Braithwaite St, London E1 6GJ, UK",
      key: "GB|powerleague shoreditch",
    });
    // A placeholder is never sent to Google.
    expect(lookup).toHaveBeenCalledTimes(5);
  });

  it("an answer already in the query cache costs no call, and keeps the confidence it was stored with", async () => {
    const lookup = vi.fn(async () => found());
    const cached = vi.fn(async (key: string) =>
      key === "GB|powerleague" ? { venueId: "venue-1", confidence: "low" as const, address: "Somewhere, UK" } : null,
    );
    const plan = await planVenueBackfill([row({ activityId: "a1", venue: "Powerleague" }), row({ activityId: "a2" })], lookup, { cached });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(plan.lines[0]).toMatchObject({ outcome: "link-low", confidence: "low", venueId: "venue-1", address: "Somewhere, UK", hit: null });
    expect(plan.lines[1]).toMatchObject({ outcome: "link", venueId: null });
  });

  it.each([
    ["off", { status: "off" } as GeocodeOutcome],
    ["quota", { status: "error", code: "quota" } as GeocodeOutcome],
    ["denied", { status: "error", code: "denied" } as GeocodeOutcome],
  ])("Google answering '%s' stops the run: no further call, and what was done is kept", async (reason, answer) => {
    const lookup = vi.fn(async (q: { address: string }) => (q.address === "Powerleague Shoreditch" ? found() : answer));
    const plan = await planVenueBackfill(
      [row({ activityId: "a1" }), row({ activityId: "a2", venue: "Goals North Cheam" }), row({ activityId: "a3", venue: "Hackney Marshes" })],
      lookup,
    );
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(plan.stopped).toBe(reason);
    expect(plan.lines.map((l) => [l.activityId, l.outcome])).toEqual([["a1", "link"]]);
  });

  it("--limit N: at most N Google calls, then it stops", async () => {
    const lookup = vi.fn(async () => found());
    const plan = await planVenueBackfill(
      [row({ activityId: "a1" }), row({ activityId: "a2", venue: "Goals North Cheam" }), row({ activityId: "a3", venue: "Hackney Marshes" })],
      lookup,
      { limit: 2 },
    );
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(plan.stopped).toBe("limit");
    expect(plan.lines.map((l) => l.activityId)).toEqual(["a1", "a2"]);
  });
});

describe("the backfill's arguments", () => {
  it("no arguments: a dry run of every club", () => {
    expect(parseBackfillArgs([])).toEqual({ ok: true, apply: false, org: null, limit: null });
  });

  it("--apply, --org X and --limit N", () => {
    expect(parseBackfillArgs(["--apply", "--org", "sutton-fc", "--limit", "5"])).toEqual({ ok: true, apply: true, org: "sutton-fc", limit: 5 });
  });

  it.each([
    [["--org"]],
    [["--apply", "--org"]],
    [["--org", "--apply"]],
    [["--org", ""]],
    [["--org", "  "]],
  ])("--org with no value is REFUSED (%j): it must never mean every club", (argv) => {
    const got = parseBackfillArgs(argv);
    expect(got.ok).toBe(false);
    expect(got).toMatchObject({ error: expect.stringMatching(/--org needs a club id or slug/) });
  });

  it.each([[["--limit"]], [["--limit", "0"]], [["--limit", "-3"]], [["--limit", "abc"]], [["--limit", "1.5"]], [["--limit", "--apply"]]])(
    "--limit must be a whole number above zero (%j)",
    (argv) => {
      expect(parseBackfillArgs(argv)).toMatchObject({ ok: false, error: expect.stringMatching(/--limit/) });
    },
  );

  it("an argument it does not know is refused, not ignored", () => {
    expect(parseBackfillArgs(["--aply"])).toMatchObject({ ok: false, error: expect.stringMatching(/--aply/) });
    expect(parseBackfillArgs(["sutton-fc"])).toMatchObject({ ok: false });
  });
});

describe("the backfill script", () => {
  const src = readFileSync(path.resolve(__dirname, "..", "..", "..", "scripts", "backfill-venue-locations.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("parses its arguments with parseBackfillArgs and refuses before connecting", () => {
    const parse = src.indexOf("parseBackfillArgs(");
    expect(parse).toBeGreaterThan(0);
    expect(parse).toBeLessThan(src.indexOf("new PrismaClient("));
  });

  it("writes only behind --apply", () => {
    const firstWrite = src.search(/\b(storeGoogleMatch|\.(upsert|updateMany|update|create|delete|deleteMany|createMany))\s*\(/);
    expect(firstWrite).toBeGreaterThan(0);
    expect(src.slice(0, firstWrite)).toMatch(/if \(!args\.apply\)[\s\S]*return/);
  });

  it("never marks anything confirmed", () => {
    expect(src).not.toMatch(/venueConfirmed/);
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
