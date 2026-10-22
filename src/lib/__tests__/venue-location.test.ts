/**
 * Venue location, the part that touches the database: looking a weekly
 * game's venue up, linking it, recording the outcome, the query cache,
 * the per-club daily cap, the organiser's Change and Yes.
 *
 * The db module is an in-memory fake (vitest cannot load the generated
 * Prisma client) and `fetch` is a stub handed in: no database and no
 * network. The real-database behaviour (the cap under real concurrency
 * included) is in e2e/helpers/venue-lib-tests.ts and the two
 * venue-location specs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface ActivityRow {
  id: string;
  orgId: string;
  venue: string;
  venueId: string | null;
  venueConfidence: string | null;
  venueMatchSource: string | null;
  venueLookupStatus: string | null;
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
  orgs: new Map<string, { language: string; ownerPhone: string | null; name: string; homeVenueId?: string | null }>(),
  venues: [] as Record<string, unknown>[],
  queries: new Map<string, { key: string; venueId: string; confidence: string }>(),
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
  const db = {
    $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    $executeRaw: async () => 1,
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
      // The lookup code must never read another club's activity to find a place.
      findFirst: async () => {
        throw new Error("the lookup read a place off an Activity row");
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) => [...world.activities.values()].filter((a) => matches(a, where)),
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
      deleteMany: async ({
        where,
      }: {
        where: { id?: string; placeId: null; source: string; activities: { none: object }; createdAt?: { lt: Date } };
      }) => {
        const doomed = world.venues.filter(
          (v) =>
            (where.id === undefined || v.id === where.id) &&
            (where.createdAt === undefined || (v.createdAt instanceof Date && v.createdAt < where.createdAt.lt)) &&
            v.placeId === where.placeId &&
            v.source === where.source &&
            ![...world.activities.values()].some((a) => a.venueId === v.id),
        );
        for (const v of doomed) world.venues.splice(world.venues.indexOf(v), 1);
        return { count: doomed.length };
      },
    },
    venueQuery: {
      findUnique: async ({ where }: { where: { key: string } }) => world.queries.get(where.key) ?? null,
      upsert: async ({ where, create }: { where: { key: string }; create: { key: string; venueId: string; confidence: string } }) => {
        if (!world.queries.has(where.key)) world.queries.set(where.key, create);
        return world.queries.get(where.key);
      },
    },
    // The club's home venue (partner discovery, P1, 2026-10-22).
    organisation: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const org = world.orgs.get(where.id);
        if (!org) return null;
        return {
          id: where.id,
          language: org.language,
          homeVenueId: org.homeVenueId ?? null,
          memberships: org.ownerPhone ? [{ user: { phoneNumber: org.ownerPhone } }] : [],
        };
      },
      updateMany: async ({ where, data }: { where: { id: string }; data: { homeVenueId: string } }) => {
        const org = world.orgs.get(where.id);
        if (!org) return { count: 0 };
        org.homeVenueId = data.homeVenueId;
        return { count: 1 };
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
    },
  };
  return { db };
});

import {
  changeActivityVenue,
  changeActivityVenueToPick,
  confirmActivityVenue,
  dropOrphanPin,
  markVenueLookupPending,
  resolveActivityVenue,
  resolveActivityVenuePick,
  setClubHomeVenueToPick,
  sweepOrphanPins,
} from "../venue-location";
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
    venueLookupStatus: null,
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
  world.queries.clear();
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
  it("links the place, with how sure the match is, where it came from and the outcome", async () => {
    const f = google();
    const got = await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(f) });
    expect(got).toEqual({ status: "found", confidence: "high" });
    expect(f).toHaveBeenCalledTimes(1);
    expect(venues()).toMatchObject([
      {
        placeId: "PID_SHOREDITCH",
        name: "Powerleague Shoreditch",
        formattedAddress: "Braithwaite St, London E1 6GJ, UK",
        lat: 51.5229,
        lng: -0.0757,
        source: "google",
      },
    ]);
    expect(activity("act-a")).toMatchObject({
      venueId: venues()[0].id,
      venueConfidence: "high",
      venueMatchSource: "text",
      venueLookupStatus: "found",
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

  it("Google answered and found nothing: recorded as 'none', the only state that says 'not found'", async () => {
    const got = await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(google({ status: "ZERO_RESULTS" })) });
    expect(got).toEqual({ status: "not-found" });
    expect(activity("act-a")).toMatchObject({ venueId: null, venueLookupStatus: "none", venueResolvedAt: NOW });
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
    ["a quota answer", async () => json({ status: "OVER_QUERY_LIMIT" })],
  ])("%s: never throws, links nothing, and is recorded as 'failed', not as 'not found'", async (_name, respond) => {
    const got = await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(vi.fn(respond)) });
    expect(got).toEqual({ status: "error" });
    expect(activity("act-a")).toMatchObject({ venueId: null, venueLookupStatus: "failed", venueResolvedAt: NOW });
  });

  it("a failed lookup can be tried again, and then links", async () => {
    await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(vi.fn(async () => json({}, 500))) });
    const got = await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(google()) });
    expect(got).toEqual({ status: "found", confidence: "high" });
    expect(activity("act-a")).toMatchObject({ venueLookupStatus: "found" });
  });

  it("with no key set nothing is fetched, nothing counts against the cap, and it is 'failed', not 'not found'", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "");
    const f = google();
    expect(await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(f) })).toEqual({ status: "off" });
    expect(f).not.toHaveBeenCalled();
    expect(world.lookups).toHaveLength(0);
    expect(activity("act-a")).toMatchObject({ venueId: null, venueLookupStatus: "failed" });
  });

  it("a placeholder venue is not looked up, and stays 'never looked up'", async () => {
    game("act-a", "org-a", "TBD", { venueLookupStatus: "pending" });
    const f = google();
    expect(await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(f) })).toEqual({ status: "skipped" });
    expect(f).not.toHaveBeenCalled();
    expect(activity("act-a").venueLookupStatus).toBeNull();
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

  it("the venue changed to OTHER words while Google was answering: the old answer is not attached, nor its outcome", async () => {
    game("act-a", "org-a", "Powerleague Shoreditch", { venueLookupStatus: "pending" });
    const f = vi.fn(async () => {
      activity("act-a").venue = "Goals North Cheam";
      return json(place());
    });
    const got = await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(f) });
    expect(got).toEqual({ status: "stale" });
    expect(activity("act-a")).toMatchObject({ venue: "Goals North Cheam", venueId: null, venueLookupStatus: "pending" });
  });

  it("only the punctuation or case changed while Google was answering: it is the same venue, and the answer lands", async () => {
    const f = vi.fn(async () => {
      activity("act-a").venue = "powerleague,  SHOREDITCH!!";
      return json(place());
    });
    const got = await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(f) });
    expect(got).toEqual({ status: "found", confidence: "high" });
    expect(activity("act-a")).toMatchObject({ venue: "powerleague,  SHOREDITCH!!", venueLookupStatus: "found" });
    expect(activity("act-a").venueId).not.toBeNull();
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

describe("a scheduled lookup is recorded as pending", () => {
  it("one activity", async () => {
    await markVenueLookupPending({ activityId: "act-a" }, NOW);
    expect(activity("act-a")).toMatchObject({ venueLookupStatus: "pending", venueResolvedAt: NOW });
  });

  it("every unlinked, never looked up game of a club, and no other club's", async () => {
    club("org-b");
    game("act-b", "org-b", "Elsewhere Arena");
    game("act-a2", "org-a", "Goals", { venueId: "venue-x", venueLookupStatus: "found" });
    await markVenueLookupPending({ orgId: "org-a" }, NOW);
    expect(activity("act-a").venueLookupStatus).toBe("pending");
    expect(activity("act-a2").venueLookupStatus).toBe("found");
    expect(activity("act-b").venueLookupStatus).toBeNull();
  });
});

describe("the query cache: one Google call per distinct venue", () => {
  it("a second club typing the same words in the same country reuses Google's answer: no second call", async () => {
    const f = google();
    await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(f) });
    expect([...world.queries.values()]).toEqual([
      { key: "GB|powerleague shoreditch", venueId: activity("act-a").venueId, confidence: "high" },
    ]);
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
  });

  it("a reuse counts against the club's cap exactly like a call, so the cap tells nobody what others typed", async () => {
    const f = google();
    await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(f) });
    club("org-b");
    game("act-b", "org-b", "Powerleague Shoreditch");
    await resolveActivityVenue("act-b", { now: NOW, fetchImpl: asFetch(f) });
    expect(world.lookups.filter((l) => l.orgId === "org-b").map((l) => l.kind)).toEqual(["reuse"]);
  });

  it("a low confidence answer is reused as LOW, never as high", async () => {
    game("act-a", "org-a", "Powerleague");
    const f = google();
    await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(f) });
    club("org-b");
    game("act-b", "org-b", "powerleague");
    expect(await resolveActivityVenue("act-b", { now: NOW, fetchImpl: asFetch(f) })).toEqual({ status: "found", confidence: "low" });
    expect(f).toHaveBeenCalledTimes(1);
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

  it("ANOTHER CLUB'S ACTIVITY ROW IS NEVER A SOURCE: a row dressed up as a high confidence text match is ignored", async () => {
    // Club B's activity carries whatever a hostile client could wish to have
    // written: a private pin, labelled as a confident text match.
    club("org-b");
    world.venues.push({ id: "venue-pin", placeId: null, name: "x", formattedAddress: null, lat: 1, lng: 1, source: "map-link" });
    game("act-b", "org-b", "Powerleague Shoreditch", {
      venueId: "venue-pin",
      venueConfidence: "high",
      venueMatchSource: "text",
      venueLookupStatus: "found",
    });
    const f = google();
    await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(f) });
    expect(f, "Google is asked").toHaveBeenCalledTimes(1);
    expect(activity("act-a").venueId).not.toBe("venue-pin");
    expect(venues().find((v) => v.id === activity("act-a").venueId)?.placeId).toBe("PID_SHOREDITCH");
  });

  it("a pasted pin, a pasted place id and a place named in a pasted link never enter the cache", async () => {
    const f = vi.fn(async (url: string) =>
      url.startsWith("https://maps.app.goo.gl/")
        ? new Response(null, { status: 302, headers: { location: "https://www.google.com/maps/place/Our+Own+Pitch/data=!4m2" } })
        : json(place()),
    );
    await changeActivityVenue("act-a", "user-a", "https://maps.google.com/?q=51.5229,-0.0757", { now: NOW, fetchImpl: asFetch(f) });
    await changeActivityVenue("act-a", "user-a", "https://www.google.com/maps/search/?api=1&query=x&query_place_id=ChIJN1t_tDeuEmsRUsoyG83frY4", {
      now: NOW,
      fetchImpl: asFetch(f),
    });
    await changeActivityVenue("act-a", "user-a", "https://maps.app.goo.gl/AbCdEf", { now: NOW, fetchImpl: asFetch(f) });
    expect(activity("act-a").venueId).not.toBeNull();
    expect(world.queries.size).toBe(0);
  });

  it("the cache only ever points at a place Google named", async () => {
    await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(google()) });
    await changeActivityVenue("act-a", "user-a", "12 Whiston Road, London", {
      now: NOW,
      fetchImpl: asFetch(google(place({ place_id: "PID_WHISTON", types: ["premise"] }))),
    });
    for (const q of world.queries.values()) {
      expect(venues().find((v) => v.id === q.venueId)).toMatchObject({ source: "google", placeId: expect.stringMatching(/^PID_/) });
    }
    expect(world.queries.size).toBe(2);
  });
});

describe("the per-club daily cap", () => {
  const fill = (orgId: string, n: number, at: Date) => {
    for (let i = 0; i < n; i++) world.lookups.push({ id: `old-${orgId}-${i}-${at.getTime()}`, orgId, kind: "geocode", createdAt: at });
  };

  it("after the cap nothing more is sent to Google today, and it is recorded as 'capped', not 'not found'", async () => {
    fill("org-a", VENUE_LOOKUPS_PER_CLUB_PER_DAY, new Date("2026-10-12T08:00:00Z"));
    const f = google();
    expect(await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(f) })).toEqual({ status: "capped" });
    expect(f).not.toHaveBeenCalled();
    expect(activity("act-a")).toMatchObject({ venueId: null, venueLookupStatus: "capped" });
    expect(world.lookups, "a refused attempt leaves no row behind").toHaveLength(VENUE_LOOKUPS_PER_CLUB_PER_DAY);
  });

  it("a cached answer is refused after the cap too", async () => {
    world.venues.push({ id: "venue-g", placeId: "PID_SHOREDITCH", name: "x", formattedAddress: "a", lat: 1, lng: 1, source: "google" });
    world.queries.set("GB|powerleague shoreditch", { key: "GB|powerleague shoreditch", venueId: "venue-g", confidence: "high" });
    fill("org-a", VENUE_LOOKUPS_PER_CLUB_PER_DAY, new Date("2026-10-12T08:00:00Z"));
    expect(await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(google()) })).toEqual({ status: "capped" });
    expect(activity("act-a").venueId).toBeNull();
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
      venueLookupStatus: "found",
      venueConfirmedAt: null,
    });
  });

  it("an address that is not found leaves the place that was there", async () => {
    game("act-a", "org-a", "Powerleague Shoreditch", { venueId: "venue-old", venueConfidence: "low", venueMatchSource: "text", venueLookupStatus: "found" });
    const got = await changeActivityVenue("act-a", "user-a", "nowhere at all", {
      now: NOW,
      fetchImpl: asFetch(google({ status: "ZERO_RESULTS" })),
    });
    expect(got).toEqual({ status: "not-found" });
    expect(activity("act-a")).toMatchObject({ venueId: "venue-old", venueConfidence: "low", venueLookupStatus: "found" });
  });

  it("Google failing is 'could not check' for the organiser to retry, and nothing changes", async () => {
    const got = await changeActivityVenue("act-a", "user-a", "12 Whiston Road", { now: NOW, fetchImpl: asFetch(vi.fn(async () => json({}, 500))) });
    expect(got).toEqual({ status: "error" });
    expect(activity("act-a")).toMatchObject({ venueId: null, venueLookupStatus: null });
  });
});

describe("Change: a pasted map link", () => {
  const PIN = "https://www.google.com/maps/place/Our+Pitch/@51.52,-0.07,17z/data=!3d51.5229437!4d-0.0757291";

  it("coordinates in the link: no request at all, and the organiser's own pin counts as confirmed", async () => {
    const f = google();
    const got = await changeActivityVenue("act-a", "user-a", PIN, { now: NOW, fetchImpl: asFetch(f) });
    expect(got).toEqual({ status: "found" });
    expect(f).not.toHaveBeenCalled();
    expect(venues()).toMatchObject([
      { placeId: null, name: "Our Pitch", formattedAddress: null, lat: 51.5229437, lng: -0.0757291, source: "map-link" },
    ]);
    expect(activity("act-a")).toMatchObject({
      venueMatchSource: "link",
      venueConfidence: "high",
      venueLookupStatus: "found",
      venueConfirmedAt: NOW,
      venueConfirmedById: "user-a",
    });
  });

  it("replacing a pin deletes the pin it replaces: private pin rows do not pile up", async () => {
    await changeActivityVenue("act-a", "user-a", PIN, { now: NOW, fetchImpl: asFetch(google()) });
    const first = activity("act-a").venueId;
    await changeActivityVenue("act-a", "user-a", "https://maps.google.com/?q=51.6,-0.2", { now: NOW, fetchImpl: asFetch(google()) });
    expect(venues().map((v) => v.id)).toEqual([activity("act-a").venueId]);
    expect(activity("act-a").venueId).not.toBe(first);
    // And replacing the pin with a Google place deletes the pin, never the place.
    await changeActivityVenue("act-a", "user-a", "12 Whiston Road, London", { now: NOW, fetchImpl: asFetch(google()) });
    expect(venues()).toMatchObject([{ source: "google", placeId: "PID_SHOREDITCH" }]);
    await changeActivityVenue("act-a", "user-a", PIN, { now: NOW, fetchImpl: asFetch(google()) });
    expect(venues().map((v) => v.source).sort()).toEqual(["google", "map-link"]);
  });

  it("dropOrphanPin removes only a private pin that nothing links: never a Google place, never a pin in use", async () => {
    world.venues.push(
      { id: "g", placeId: "PID", name: "x", formattedAddress: "a", lat: 1, lng: 1, source: "google" },
      { id: "used", placeId: null, name: "x", formattedAddress: null, lat: 1, lng: 1, source: "map-link" },
      { id: "orphan", placeId: null, name: "x", formattedAddress: null, lat: 1, lng: 1, source: "map-link" },
    );
    game("act-a", "org-a", "Powerleague Shoreditch", { venueId: "used" });
    for (const id of ["g", "used", "orphan", null]) await dropOrphanPin(id);
    expect(venues().map((v) => v.id)).toEqual(["g", "used"]);
  });

  it("the sweep removes abandoned pins older than a minute: never a fresh one, a linked one or a Google place", async () => {
    const old = new Date(NOW.getTime() - 5 * 60_000);
    const fresh = new Date(NOW.getTime() - 5_000);
    world.venues.push(
      { id: "g", placeId: "PID", name: "x", formattedAddress: "a", lat: 1, lng: 1, source: "google", createdAt: old },
      { id: "used", placeId: null, name: "x", formattedAddress: null, lat: 1, lng: 1, source: "map-link", createdAt: old },
      { id: "abandoned", placeId: null, name: "x", formattedAddress: null, lat: 1, lng: 1, source: "map-link", createdAt: old },
      { id: "mid-save", placeId: null, name: "x", formattedAddress: null, lat: 1, lng: 1, source: "map-link", createdAt: fresh },
    );
    game("act-a", "org-a", "Powerleague Shoreditch", { venueId: "used" });
    await sweepOrphanPins(NOW);
    expect(venues().map((v) => v.id)).toEqual(["g", "used", "mid-save"]);
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

  it.each([
    ["off the allow-list (the metadata address)", "http://169.254.169.254/latest/", "left-allow-list"],
    ["a consent page instead of the map", "https://consent.google.com/m?continue=https://www.google.com/maps/@51.5,-0.1,17z", "left-allow-list"],
  ])("a short link that redirects %s: 'can't read that link', the target is never fetched, and the reason is logged", async (_n, location, reason) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const f = vi.fn(async () => new Response(null, { status: 302, headers: { location } }));
    const got = await changeActivityVenue("act-a", "user-a", "https://maps.app.goo.gl/AbCdEf", { now: NOW, fetchImpl: asFetch(f) });
    expect(got).toEqual({ status: "unsupported", reason: "link" });
    expect(f).toHaveBeenCalledTimes(1);
    expect(activity("act-a").venueId).toBeNull();
    expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toContain(`[geocode] activity=act-a short-link=refused reason=${reason}`);
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

// ── A place PICKED from the suggestions under the venue box (2026-10-13) ──

const PICK_TOKEN = "3f2c1d7e-8a4b-4c1d-9e2f-0a1b2c3d4e5f";
const PICK = { placeId: "ChIJ_croydon_0001", sessionToken: PICK_TOKEN };
const DETAILS = {
  id: "ChIJ_croydon_0001",
  displayName: { text: "Powerleague Croydon", languageCode: "en" },
  formattedAddress: "Purley Way, Croydon CR0 4RQ, UK",
  location: { latitude: 51.3562, longitude: -0.1167 },
};

/** "Google": Place Details on places.googleapis.com, Geocoding on maps.googleapis.com. */
function googleBoth(opts: { details?: () => Response | Promise<Response>; geocode?: unknown } = {}) {
  return vi.fn(async (...args: [string, RequestInit?]) => {
    const host = new URL(args[0]).hostname;
    if (host === "places.googleapis.com") return opts.details ? opts.details() : json(DETAILS);
    return json(opts.geocode ?? place());
  });
}
const hosts = (f: ReturnType<typeof googleBoth>) => f.mock.calls.map((c) => new URL(c[0]).hostname);

describe("a place picked from the suggestions", () => {
  beforeEach(() => {
    game("act-a", "org-a", "Powerleague Croydon");
  });

  it("the SERVER asks Google for the place and links it: high confidence, picked by the organiser, confirmed by them", async () => {
    const f = googleBoth();
    const got = await resolveActivityVenuePick("act-a", "user-a", PICK, { now: NOW, fetchImpl: asFetch(f) });
    expect(got).toEqual({ status: "found", confidence: "high" });
    expect(hosts(f)).toEqual(["places.googleapis.com"]);
    expect(venues()).toMatchObject([
      {
        placeId: "ChIJ_croydon_0001",
        name: "Powerleague Croydon",
        formattedAddress: "Purley Way, Croydon CR0 4RQ, UK",
        lat: 51.3562,
        lng: -0.1167,
        source: "google",
      },
    ]);
    expect(activity("act-a")).toMatchObject({
      venue: "Powerleague Croydon",
      venueId: venues()[0].id,
      venueConfidence: "high",
      venueMatchSource: "pick",
      venueLookupStatus: "found",
      venueResolvedAt: NOW,
      venueConfirmedAt: NOW,
      venueConfirmedById: "user-a",
    });
  });

  it("Place Details is asked with the SAME session token the suggestions used, and in the club's language", async () => {
    club("org-a", { language: "tr" });
    const f = googleBoth();
    await resolveActivityVenuePick("act-a", "user-a", PICK, { now: NOW, fetchImpl: asFetch(f) });
    const u = new URL(f.mock.calls[0][0]);
    expect(u.pathname).toBe("/v1/places/ChIJ_croydon_0001");
    expect(Object.fromEntries(u.searchParams)).toEqual({ sessionToken: PICK_TOKEN, languageCode: "tr" });
    expect(new Headers(f.mock.calls[0][1]?.headers).get("x-goog-fieldmask")).toBe("id,displayName,formattedAddress,location");
    expect(f.mock.calls[0][0]).not.toMatch(/Secret|447700900001|org-a|act-a|user-a|test-key/);
  });

  it("NOTHING ABOUT THE PLACE COMES FROM THE BROWSER: extra fields on the pick are never read", async () => {
    const hostile = { ...PICK, lat: 1, lng: 2, formattedAddress: "Attacker Lane", name: "Evil", confidence: "high" };
    await resolveActivityVenuePick("act-a", "user-a", hostile as never, { now: NOW, fetchImpl: asFetch(googleBoth()) });
    expect(venues()).toHaveLength(1);
    expect(venues()[0]).toMatchObject({ name: "Powerleague Croydon", formattedAddress: "Purley Way, Croydon CR0 4RQ, UK", lat: 51.3562, lng: -0.1167 });
  });

  it("a pick answers no query: nothing goes into the shared query cache", async () => {
    await resolveActivityVenuePick("act-a", "user-a", PICK, { now: NOW, fetchImpl: asFetch(googleBoth()) });
    expect(world.queries.size).toBe(0);
  });

  it("counts as one of the club's lookups for the day", async () => {
    await resolveActivityVenuePick("act-a", "user-a", PICK, { now: NOW, fetchImpl: asFetch(googleBoth()) });
    expect(world.lookups.map((l) => [l.orgId, l.kind])).toEqual([["org-a", "place-details"]]);
  });

  it.each([
    ["Google does not know the place id (404)", () => json({ error: { code: 404, status: "NOT_FOUND" } }, 404)],
    ["Places API is not enabled (403)", () => json({ error: { code: 403, status: "PERMISSION_DENIED" } }, 403)],
    ["Google is down (500)", () => json({}, 500)],
    ["the answer has no position", () => json({ id: "ChIJ_croydon_0001", displayName: { text: "X" } })],
    [
      "the network fails",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("%s: FALLS BACK to the ordinary lookup of the venue text, and the save is not failed", async (_label, details) => {
    const f = googleBoth({ details });
    const got = await resolveActivityVenuePick("act-a", "user-a", PICK, { now: NOW, fetchImpl: asFetch(f) });
    expect(hosts(f)).toEqual(["places.googleapis.com", "maps.googleapis.com"]);
    expect(new URL(f.mock.calls[1][0]).searchParams.get("address")).toBe("Powerleague Croydon");
    // Exactly what a venue typed with no pick gets: a text match, unconfirmed.
    expect(got).toEqual({ status: "found", confidence: "high" });
    expect(activity("act-a")).toMatchObject({
      venueConfidence: "high",
      venueMatchSource: "text",
      venueLookupStatus: "found",
      venueConfirmedAt: null,
      venueConfirmedById: null,
    });
    expect(venues()[0].placeId).toBe("PID_SHOREDITCH");
  });

  it("an unusable place id never reaches Google as a place: the venue text is looked up instead", async () => {
    const f = googleBoth();
    await resolveActivityVenuePick("act-a", "user-a", { placeId: "../../etc", sessionToken: PICK_TOKEN }, { now: NOW, fetchImpl: asFetch(f) });
    expect(hosts(f)).toEqual(["maps.googleapis.com"]);
    expect(activity("act-a").venueMatchSource).toBe("text");
  });

  it("with the club's daily lookups used up, nothing is sent and it is recorded as capped", async () => {
    for (let i = 0; i < VENUE_LOOKUPS_PER_CLUB_PER_DAY; i++) world.lookups.push({ id: `l${i}`, orgId: "org-a", kind: "geocode", createdAt: NOW });
    const f = googleBoth();
    const got = await resolveActivityVenuePick("act-a", "user-a", PICK, { now: NOW, fetchImpl: asFetch(f) });
    expect(got).toEqual({ status: "capped" });
    expect(f).not.toHaveBeenCalled();
    expect(activity("act-a")).toMatchObject({ venueId: null, venueLookupStatus: "capped" });
  });

  it("the venue words changed while Google was answering: the stale place is not linked", async () => {
    const f = googleBoth({
      details: () => {
        activity("act-a").venue = "School cage";
        return json(DETAILS);
      },
    });
    const got = await resolveActivityVenuePick("act-a", "user-a", PICK, { now: NOW, fetchImpl: asFetch(f) });
    expect(got).toEqual({ status: "stale" });
    expect(activity("act-a")).toMatchObject({ venue: "School cage", venueId: null, venueConfirmedById: null });
  });

  it("two clubs picking the same place share one place row, and each keeps its own confirmation", async () => {
    club("org-b", { ownerPhone: "+447700900002" });
    game("act-b", "org-b", "PL Croydon");
    await resolveActivityVenuePick("act-a", "user-a", PICK, { now: NOW, fetchImpl: asFetch(googleBoth()) });
    await resolveActivityVenuePick("act-b", "user-b", PICK, { now: NOW, fetchImpl: asFetch(googleBoth()) });
    expect(venues()).toHaveLength(1);
    expect(activity("act-a").venueConfirmedById).toBe("user-a");
    expect(activity("act-b").venueConfirmedById).toBe("user-b");
  });

  it("a game that does not exist is skipped", async () => {
    const f = googleBoth();
    expect(await resolveActivityVenuePick("nope", "user-a", PICK, { now: NOW, fetchImpl: asFetch(f) })).toEqual({ status: "skipped" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("Change: a place picked from the suggestions", () => {
  it("links the picked place over whatever was there, confirmed; the venue text is not touched", async () => {
    await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(google()) });
    const f = googleBoth();
    const got = await changeActivityVenueToPick("act-a", "user-a", PICK, { now: NOW, fetchImpl: asFetch(f) });
    expect(got).toEqual({ status: "found" });
    expect(hosts(f)).toEqual(["places.googleapis.com"]);
    expect(activity("act-a")).toMatchObject({
      venue: "Powerleague Shoreditch",
      venueConfidence: "high",
      venueMatchSource: "pick",
      venueLookupStatus: "found",
      venueConfirmedAt: NOW,
      venueConfirmedById: "user-a",
    });
    expect(venues().find((v) => v.id === activity("act-a").venueId)).toMatchObject({ placeId: "ChIJ_croydon_0001", lat: 51.3562 });
  });

  it.each([
    ["a place id Google does not know", () => json({ error: {} }, 404)],
    ["Google failing", () => json({}, 500)],
  ])("%s is 'unresolved' (the caller then looks the typed words up) and the place that was there stays", async (_label, details) => {
    await resolveActivityVenue("act-a", { now: NOW, fetchImpl: asFetch(google()) });
    const before = { ...activity("act-a") };
    const got = await changeActivityVenueToPick("act-a", "user-a", PICK, { now: NOW, fetchImpl: asFetch(googleBoth({ details })) });
    expect(got).toEqual({ status: "unresolved" });
    expect(activity("act-a")).toEqual(before);
  });

  it("is under the club's daily cap", async () => {
    for (let i = 0; i < VENUE_LOOKUPS_PER_CLUB_PER_DAY; i++) world.lookups.push({ id: `l${i}`, orgId: "org-a", kind: "geocode", createdAt: NOW });
    const f = googleBoth();
    expect(await changeActivityVenueToPick("act-a", "user-a", PICK, { now: NOW, fetchImpl: asFetch(f) })).toEqual({ status: "capped" });
    expect(f).not.toHaveBeenCalled();
  });
});

// ── The club's home venue (partner discovery, slice P1, 2026-10-22) ──────
// Set ONLY from a place picked from the suggestions, so it is always a
// geocoded Venue: no postcode or town is ever looked up as text.

describe("the club's home venue, from a picked place", () => {
  it("the SERVER asks Google for the place, stores it and makes it the club's home venue", async () => {
    const f = googleBoth();
    const got = await setClubHomeVenueToPick("org-a", "user-a", PICK, { now: NOW, fetchImpl: asFetch(f) });
    expect(got).toEqual({ status: "found", venueId: venues()[0].id });
    expect(hosts(f)).toEqual(["places.googleapis.com"]);
    expect(venues()[0]).toMatchObject({ placeId: "ChIJ_croydon_0001", name: "Powerleague Croydon", lat: 51.3562, lng: -0.1167 });
    expect(world.orgs.get("org-a")!.homeVenueId).toBe(venues()[0].id);
    // Charged to the club's daily lookups like any other, with no game.
    expect(world.lookups).toMatchObject([{ orgId: "org-a", kind: "place-details", activityId: null }]);
  });

  it("Google not resolving the place: nothing is set, and NO text lookup is made", async () => {
    const f = googleBoth({ details: () => json({ error: {} }, 404) });
    expect(await setClubHomeVenueToPick("org-a", "user-a", PICK, { now: NOW, fetchImpl: asFetch(f) })).toEqual({ status: "unresolved" });
    expect(hosts(f)).toEqual(["places.googleapis.com"]);
    expect(world.orgs.get("org-a")!.homeVenueId ?? null).toBeNull();
  });

  it("an unusable place id never reaches Google", async () => {
    const f = googleBoth();
    const bad = { placeId: "not a place id!", sessionToken: null };
    expect(await setClubHomeVenueToPick("org-a", "user-a", bad, { now: NOW, fetchImpl: asFetch(f) })).toEqual({ status: "unresolved" });
    expect(f).not.toHaveBeenCalled();
  });

  it("with the club's daily lookups used up, nothing is sent", async () => {
    for (let i = 0; i < VENUE_LOOKUPS_PER_CLUB_PER_DAY; i++) world.lookups.push({ id: `l${i}`, orgId: "org-a", kind: "geocode", createdAt: NOW });
    const f = googleBoth();
    expect(await setClubHomeVenueToPick("org-a", "user-a", PICK, { now: NOW, fetchImpl: asFetch(f) })).toEqual({ status: "capped" });
    expect(f).not.toHaveBeenCalled();
  });

  it("a club that does not exist is unresolved, with nothing sent", async () => {
    const f = googleBoth();
    expect(await setClubHomeVenueToPick("nope", "user-a", PICK, { now: NOW, fetchImpl: asFetch(f) })).toEqual({ status: "unresolved" });
    expect(f).not.toHaveBeenCalled();
  });
});
