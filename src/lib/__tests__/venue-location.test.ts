/**
 * Venue location, the part that touches the database: looking a weekly
 * game's venue up, linking it, the dedupe, the per-club daily cap, the
 * organiser's Change and Yes.
 *
 * The db module is an in-memory fake (vitest cannot load the generated
 * Prisma client) and `fetch` is a stub handed in: no database and no
 * network. The real-database behaviour is in e2e/web/venue-location.spec.ts
 * and e2e/api/venue-location.spec.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface ActivityRow {
  id: string;
  orgId: string;
  venue: string;
  venueId: string | null;
  venueConfidence: string | null;
  venueMatchSource: string | null;
  venueQueryKey: string | null;
  venueResolvedAt: Date | null;
  venueConfirmedAt: Date | null;
  venueConfirmedById: string | null;
}
interface VenueRow {
  id: string;
  placeId: string | null;
  name: string;
  formattedAddress: string | null;
  lat: number | null;
  lng: number | null;
  source: string | null;
}

const world = vi.hoisted(() => ({
  activities: new Map<string, Record<string, unknown>>(),
  orgs: new Map<string, { language: string; ownerPhone: string | null; name: string }>(),
  venues: [] as Record<string, unknown>[],
  lookups: [] as { id: string; orgId: string; kind: string; createdAt: Date }[],
  seq: 0,
}));

vi.mock("@/lib/db", () => {
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) => {
      const got = row[k];
      if (v && typeof v === "object" && !(v instanceof Date)) {
        const c = v as { not?: unknown; in?: unknown[] };
        if ("not" in c) return got !== c.not;
        if ("in" in c) return (c.in ?? []).includes(got);
        return true;
      }
      return got === v;
    });
  return {
    db: {
      activity: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          const a = world.activities.get(where.id);
          if (!a) return null;
          const org = world.orgs.get(a.orgId as string)!;
          return {
            ...a,
            org: {
              language: org.language,
              memberships: org.ownerPhone ? [{ user: { phoneNumber: org.ownerPhone } }] : [],
            },
          };
        },
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          [...world.activities.values()].find((a) => matches(a, where)) ?? null,
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const rows = [...world.activities.values()].filter((a) => matches(a, where));
          rows.forEach((a) => Object.assign(a, data));
          return { count: rows.length };
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
          Object.assign(world.activities.get(where.id)!, data),
      },
      venue: {
        upsert: async ({ where, create }: { where: { placeId: string }; create: Record<string, unknown> }) => {
          const found = world.venues.find((v) => v.placeId === where.placeId);
          if (found) return found;
          const row = { id: `venue-${++world.seq}`, ...create };
          world.venues.push(row);
          return row;
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `venue-${++world.seq}`, ...data };
          world.venues.push(row);
          return row;
        },
      },
      venueLookup: {
        create: async ({ data }: { data: { orgId: string; kind: string; createdAt: Date } }) => {
          const row = { id: `lookup-${++world.seq}`, ...data };
          world.lookups.push(row);
          return row;
        },
        count: async ({ where }: { where: { orgId: string; createdAt: { gte: Date } } }) =>
          world.lookups.filter((l) => l.orgId === where.orgId && l.createdAt >= where.createdAt.gte).length,
        delete: async ({ where }: { where: { id: string } }) => {
          const i = world.lookups.findIndex((l) => l.id === where.id);
          if (i >= 0) world.lookups.splice(i, 1);
        },
      },
    },
  };
});

import { changeActivityVenue, confirmActivityVenue, resolveActivityVenue } from "../venue-location";
import { VENUE_LOOKUPS_PER_CLUB_PER_DAY } from "../venue-location-rules";

const NOW = new Date("2026-10-12T12:00:00Z");

const activity = (id: string) => world.activities.get(id) as unknown as ActivityRow;
const venues = () => world.venues as unknown as VenueRow[];

function club(orgId: string, over: Partial<{ language: string; ownerPhone: string | null; name: string }> = {}) {
  world.orgs.set(orgId, { language: "en", ownerPhone: "+447700900001", name: "Secret Club FC", ...over });
}
function game(id: string, orgId: string, venue: string, over: Partial<ActivityRow> = {}) {
  world.activities.set(id, {
    id,
    orgId,
    venue,
    venueId: null,
    venueConfidence: null,
    venueMatchSource: null,
    venueQueryKey: null,
    venueResolvedAt: null,
    venueConfirmedAt: null,
    venueConfirmedById: null,
    ...over,
  });
}

const place = (over: Record<string, unknown> = {}) => ({
  status: "OK",
  results: [
    {
      place_id: "PID_SHOREDITCH",
      formatted_address: "Braithwaite St, London E1 6GJ, UK",
      geometry: { location: { lat: 51.5229, lng: -0.0757 }, location_type: "GEOMETRIC_CENTER" },
      types: ["establishment", "point_of_interest"],
      address_components: [{ short_name: "GB", types: ["country"] }],
      ...over,
    },
  ],
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const google = (body: unknown = place()) => vi.fn(async (...args: [string, RequestInit?]) => (void args, json(body)));
const asFetch = (f: unknown) => f as typeof fetch;
const sent = (f: ReturnType<typeof google>, i = 0) => new URL(f.mock.calls[i][0]);

beforeEach(() => {
  world.activities.clear();
  world.orgs.clear();
  world.venues.length = 0;
  world.lookups.length = 0;
  world.seq = 0;
  vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");
  club("org-a");
  game("act-a", "org-a", "Powerleague Shoreditch");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("looking a weekly game's venue up", () => {
  it("links the place, with how sure the match is and where it came from", async () => {
    const f = google();
    const got = await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(f) });
    expect(got).toEqual({ status: "found", confidence: "high" });
    expect(f).toHaveBeenCalledTimes(1);
    expect(venues()).toEqual([
      {
        id: "venue-2",
        placeId: "PID_SHOREDITCH",
        name: "Powerleague Shoreditch",
        formattedAddress: "Braithwaite St, London E1 6GJ, UK",
        lat: 51.5229,
        lng: -0.0757,
        source: "google",
      },
    ]);
    expect(activity("act-a")).toMatchObject({
      venueId: "venue-2",
      venueConfidence: "high",
      venueMatchSource: "text",
      venueQueryKey: "GB|powerleague shoreditch",
      venueResolvedAt: NOW,
      venueConfirmedAt: null,
      venueConfirmedById: null,
    });
  });

  it("Google is sent the venue text and the country only: no club name, person or phone", async () => {
    const f = google();
    await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(f) });
    expect(Object.fromEntries(sent(f).searchParams)).toEqual({
      address: "Powerleague Shoreditch",
      region: "uk",
      key: "test-key",
    });
    expect(f.mock.calls[0][0]).not.toMatch(/Secret|447700900001|org-a|act-a/);
  });

  it("a low confidence match is linked as low, for the organiser to check", async () => {
    game("act-a", "org-a", "Powerleague");
    const got = await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(google()) });
    expect(got).toEqual({ status: "found", confidence: "low" });
    expect(activity("act-a").venueConfidence).toBe("low");
  });

  it("nothing found: no link, and the lookup is marked done", async () => {
    const got = await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(google({ status: "ZERO_RESULTS" })) });
    expect(got).toEqual({ status: "not-found" });
    expect(activity("act-a")).toMatchObject({ venueId: null, venueResolvedAt: NOW });
  });

  it.each([
    ["a 500 from Google", async () => json({}, 500)],
    [
      "a network failure",
      async () => {
        throw new TypeError("fetch failed");
      },
    ],
    ["a refused key", async () => json({ status: "REQUEST_DENIED" })],
  ])("%s: never throws, links nothing, and leaves the lookup to be tried again", async (_name, respond) => {
    const got = await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(vi.fn(respond)) });
    expect(got).toEqual({ status: "error" });
    expect(activity("act-a")).toMatchObject({ venueId: null, venueResolvedAt: null });
  });

  it("with no key set nothing is fetched and nothing counts against the cap", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "");
    const f = google();
    expect(await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(f) })).toEqual({ status: "off" });
    expect(f).not.toHaveBeenCalled();
    expect(world.lookups).toHaveLength(0);
  });

  it("a placeholder venue is not looked up", async () => {
    game("act-a", "org-a", "TBD");
    const f = google();
    expect(await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(f) })).toEqual({ status: "not-found" });
    expect(f).not.toHaveBeenCalled();
  });

  it("an activity that is already linked is left alone", async () => {
    game("act-a", "org-a", "Powerleague Shoreditch", { venueId: "venue-x", venueConfidence: "high" });
    const f = google();
    expect(await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(f) })).toEqual({ status: "skipped" });
    expect(f).not.toHaveBeenCalled();
  });

  it("an activity that does not exist is skipped", async () => {
    expect(await resolveActivityVenue("nope", { now: NOW, fetchImpl: asFetch(google()) })).toEqual({ status: "skipped" });
  });

  it("the venue text changed while Google was answering: the old answer is not attached to the new text", async () => {
    const f = vi.fn(async () => {
      activity("act-a").venue = "Goals North Cheam";
      return json(place());
    });
    const got = await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(f) });
    expect(got).toEqual({ status: "stale" });
    expect(activity("act-a")).toMatchObject({ venue: "Goals North Cheam", venueId: null, venueResolvedAt: null });
  });

  it("logs ids, the outcome and the confidence only", async () => {
    const lines: string[] = [];
    for (const m of ["debug", "log", "info", "warn", "error"] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    }
    await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(google()) });
    const all = lines.join("\n");
    expect(all).toMatch(/\[geocode\] activity=act-a outcome=found confidence=high/);
    expect(all).not.toMatch(/Powerleague|Shoreditch|Braithwaite|51\.52|test-key|Secret/i);
  });
});

describe("one Google call per distinct venue", () => {
  it("a second club typing the same words in the same country reuses the place: no second call", async () => {
    const f = google();
    await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(f) });
    club("org-b", { ownerPhone: "+447700900777" });
    game("act-b", "org-b", "  powerleague,  SHOREDITCH ");
    const got = await resolveActivityVenue("act-b", { now: NOW, fetchImpl: asFetch(f) });
    expect(got).toEqual({ status: "found", confidence: "high" });
    expect(f).toHaveBeenCalledTimes(1);
    expect(activity("act-b")).toMatchObject({
      venueId: activity("act-a").venueId,
      venueConfidence: "high",
      venueMatchSource: "text",
      venueConfirmedAt: null,
    });
    expect(world.lookups.filter((l) => l.orgId === "org-b")).toHaveLength(0);
  });

  it("the first club's confirmation is its own: it does not arrive with the reused place", async () => {
    const f = google();
    await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(f) });
    await confirmActivityVenue("act-a", "user-a", NOW);
    club("org-b");
    game("act-b", "org-b", "Powerleague Shoreditch");
    await resolveActivityVenue("act-b", { now: NOW, fetchImpl: asFetch(f) });
    expect(activity("act-b")).toMatchObject({ venueConfirmedAt: null, venueConfirmedById: null });
  });

  it("the same words in another country are another lookup", async () => {
    const f = google();
    await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(f) });
    club("org-tr", { ownerPhone: "+905321234567", language: "tr" });
    game("act-tr", "org-tr", "Powerleague Shoreditch");
    await resolveActivityVenue("act-tr", { now: NOW, fetchImpl: asFetch(f) });
    expect(f).toHaveBeenCalledTimes(2);
    expect(sent(f, 1).searchParams.get("region")).toBe("tr");
  });

  it("a place another club reached by pasting a map link is not handed to the same words", async () => {
    club("org-b");
    game("act-b", "org-b", "Powerleague Shoreditch", {
      venueId: "venue-pin",
      venueConfidence: "high",
      venueMatchSource: "link",
      venueQueryKey: null,
    });
    const f = google();
    await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(f) });
    expect(f).toHaveBeenCalledTimes(1);
    expect(activity("act-a").venueId).not.toBe("venue-pin");
  });
});

describe("the per-club daily cap", () => {
  const fill = (orgId: string, n: number, at: Date) => {
    for (let i = 0; i < n; i++) world.lookups.push({ id: `old-${orgId}-${i}-${at.getTime()}`, orgId, kind: "geocode", createdAt: at });
  };

  it("after the cap, nothing more is sent to Google today", async () => {
    fill("org-a", VENUE_LOOKUPS_PER_CLUB_PER_DAY, new Date("2026-10-12T08:00:00Z"));
    const f = google();
    expect(await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(f) })).toEqual({ status: "capped" });
    expect(f).not.toHaveBeenCalled();
    expect(activity("act-a")).toMatchObject({ venueId: null, venueResolvedAt: null });
    expect(world.lookups, "a refused attempt leaves no row behind").toHaveLength(VENUE_LOOKUPS_PER_CLUB_PER_DAY);
  });

  it("the last lookup under the cap goes through", async () => {
    fill("org-a", VENUE_LOOKUPS_PER_CLUB_PER_DAY - 1, new Date("2026-10-12T08:00:00Z"));
    const f = google();
    expect((await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(f) })).status).toBe("found");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("yesterday's lookups (London time) and another club's do not count", async () => {
    // 22:30 UTC on the 11th is 23:30 in London (summer time): yesterday.
    fill("org-a", VENUE_LOOKUPS_PER_CLUB_PER_DAY, new Date("2026-10-11T22:30:00Z"));
    fill("org-z", VENUE_LOOKUPS_PER_CLUB_PER_DAY, new Date("2026-10-12T08:00:00Z"));
    const f = google();
    expect((await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(f) })).status).toBe("found");
  });

  it("the Change box is under the same cap, pasted pins included", async () => {
    fill("org-a", VENUE_LOOKUPS_PER_CLUB_PER_DAY, new Date("2026-10-12T08:00:00Z"));
    const f = google();
    for (const input of ["12 Whiston Road, London", "https://maps.google.com/?q=51.5229,-0.0757", "https://maps.app.goo.gl/AbC"]) {
      expect(await changeActivityVenue("act-a", "user-a", input, { now: NOW, fetchImpl: asFetch(f) }), input).toEqual({
        status: "capped",
      });
    }
    expect(f).not.toHaveBeenCalled();
    expect(venues()).toHaveLength(0);
  });
});

describe("Change: a fuller address", () => {
  it("looks the address up and links it, unconfirmed; the venue text is not touched", async () => {
    const f = google(place({ place_id: "PID_WHISTON", formatted_address: "12 Whiston Rd, London E2 8BN, UK", types: ["premise"] }));
    const got = await changeActivityVenue("act-a", "user-a", "12 Whiston Road, London E2 8BN", { now: NOW, fetchImpl: asFetch(f) });
    expect(got).toEqual({ status: "found" });
    expect(sent(f).searchParams.get("address")).toBe("12 Whiston Road, London E2 8BN");
    expect(activity("act-a")).toMatchObject({
      venue: "Powerleague Shoreditch",
      venueMatchSource: "address",
      venueConfidence: "high",
      venueQueryKey: "GB|12 whiston road london e2 8bn",
      venueConfirmedAt: null,
    });
  });

  it("an address that is not found leaves the place that was there", async () => {
    game("act-a", "org-a", "Powerleague Shoreditch", { venueId: "venue-old", venueConfidence: "low", venueMatchSource: "text" });
    const got = await changeActivityVenue("act-a", "user-a", "nowhere at all", {
      now: NOW,
      fetchImpl: asFetch(google({ status: "ZERO_RESULTS" })),
    });
    expect(got).toEqual({ status: "not-found" });
    expect(activity("act-a")).toMatchObject({ venueId: "venue-old", venueConfidence: "low" });
  });

  it("Google failing is an error for the organiser to retry, and nothing changes", async () => {
    const got = await changeActivityVenue("act-a", "user-a", "12 Whiston Road", { now: NOW, fetchImpl: asFetch(vi.fn(async () => json({}, 500))) });
    expect(got).toEqual({ status: "error" });
    expect(activity("act-a").venueId).toBeNull();
  });
});

describe("Change: a pasted map link", () => {
  it("coordinates in the link: no request at all, and the organiser's own pin counts as confirmed", async () => {
    const f = google();
    const got = await changeActivityVenue(
      "act-a",
      "user-a",
      "https://www.google.com/maps/place/Our+Pitch/@51.52,-0.07,17z/data=!3d51.5229437!4d-0.0757291",
      { now: NOW, fetchImpl: asFetch(f) },
    );
    expect(got).toEqual({ status: "found" });
    expect(f).not.toHaveBeenCalled();
    expect(venues()).toMatchObject([
      { placeId: null, name: "Our Pitch", formattedAddress: null, lat: 51.5229437, lng: -0.0757291, source: "map-link" },
    ]);
    expect(activity("act-a")).toMatchObject({
      venueMatchSource: "link",
      venueConfidence: "high",
      venueQueryKey: null,
      venueConfirmedAt: NOW,
      venueConfirmedById: "user-a",
    });
  });

  it("a place id in the link: one Google call by place id, confirmed", async () => {
    const f = google();
    const got = await changeActivityVenue(
      "act-a",
      "user-a",
      "https://www.google.com/maps/search/?api=1&query=x&query_place_id=ChIJN1t_tDeuEmsRUsoyG83frY4",
      { now: NOW, fetchImpl: asFetch(f) },
    );
    expect(got).toEqual({ status: "found" });
    expect(Object.fromEntries(sent(f).searchParams)).toEqual({ place_id: "ChIJN1t_tDeuEmsRUsoyG83frY4", key: "test-key" });
    expect(activity("act-a")).toMatchObject({ venueMatchSource: "link", venueConfirmedById: "user-a" });
  });

  it("a short link: one request to the short host, then the place named in its target is looked up", async () => {
    const f = vi.fn(async (url: string) => {
      if (url.startsWith("https://maps.app.goo.gl/")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://www.google.com/maps/place/Powerleague+Shoreditch,+London/data=!4m2" },
        });
      }
      return json(place());
    });
    const got = await changeActivityVenue("act-a", "user-a", "https://maps.app.goo.gl/AbCdEf", { now: NOW, fetchImpl: asFetch(f) });
    expect(got).toEqual({ status: "found" });
    expect(f.mock.calls.map((c) => new URL(c[0]).hostname)).toEqual(["maps.app.goo.gl", "maps.googleapis.com"]);
    expect(new URL(f.mock.calls[1][0]).searchParams.get("address")).toBe("Powerleague Shoreditch, London");
    expect(activity("act-a")).toMatchObject({ venueMatchSource: "link", venueConfirmedAt: null });
    expect(world.lookups.map((l) => l.kind).sort()).toEqual(["geocode", "short-link"]);
  });

  it("a short link that redirects off the allow-list is refused, and the target is never fetched", async () => {
    const f = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/" } }));
    const got = await changeActivityVenue("act-a", "user-a", "https://maps.app.goo.gl/AbCdEf", { now: NOW, fetchImpl: asFetch(f) });
    expect(got).toEqual({ status: "unsupported", reason: "link" });
    expect(f).toHaveBeenCalledTimes(1);
    expect(activity("act-a").venueId).toBeNull();
  });

  it.each([
    ["https://what3words.com/filled.count.soap", "what3words"],
    ["https://evil.example/maps/@51.5,-0.1,17z", "link"],
    ["http://169.254.169.254/latest/meta-data/", "link"],
    ["https://maps.apple/p/AbC", "link"],
    ["   ", "link"],
  ])("%s is refused with no request", async (input, reason) => {
    const f = google();
    expect(await changeActivityVenue("act-a", "user-a", input, { now: NOW, fetchImpl: asFetch(f) })).toEqual({
      status: "unsupported",
      reason,
    });
    expect(f).not.toHaveBeenCalled();
    expect(world.lookups).toHaveLength(0);
  });
});

describe("Yes, this is the right place", () => {
  it("records who confirmed and when, on the activity and not on the shared place", async () => {
    await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(google()) });
    const before = JSON.stringify(venues());
    const later = new Date("2026-10-12T13:00:00Z");
    expect(await confirmActivityVenue("act-a", "user-a", later)).toBe(true);
    expect(activity("act-a")).toMatchObject({ venueConfirmedAt: later, venueConfirmedById: "user-a" });
    expect(JSON.stringify(venues())).toBe(before);
  });

  it("there is nothing to confirm when no place is linked", async () => {
    expect(await confirmActivityVenue("act-a", "user-a", NOW)).toBe(false);
    expect(activity("act-a").venueConfirmedAt).toBeNull();
  });
});
