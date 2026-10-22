/**
 * Partner discovery, slice P2: the pure rules of the nearby search
 * (2026-10-22). Plan: MDs/partner-discovery-plan-2026-10-21.md, sections
 * 2.1 to 2.4 and 9.
 *
 *   - radius presets 1, 3, 5 and 10 miles, default 3, nothing above 10;
 *   - the bounding box holds every point within the radius;
 *   - who is listed (approved, a players' group, "find us" on, a geocoded
 *     venue; dormant, billing-paused and trial clubs included) and who may
 *     search (a club that is itself listed);
 *   - measured from every active game's venue, or the home venue for a
 *     club with no game; the nearest pair, rounded to 0.1 mile;
 *   - the same-day filter never drops a club with no game;
 *   - blocks either way, a decline or an end by them in the last 30 days,
 *     and ourselves are hidden; a pairing or a pending request shows its
 *     status instead of a checkbox;
 *   - regular players: at least 2 of the club's last 8 games.
 */
import { describe, expect, it } from "vitest";
import { distanceKm } from "../geo";
import {
  CARD_KEYS,
  DEFAULT_RADIUS_MILES,
  KM_PER_MILE,
  LISTABLE_CLUB_WHERE,
  MAX_RADIUS_MILES,
  RADIUS_PRESETS_MILES,
  REPLY_COOLDOWN_MS,
  boundingBox,
  cardStatus,
  hiddenOrgIds,
  inRange,
  isListable,
  measuredFrom,
  nearestMiles,
  parsePage,
  parseRadiusMiles,
  parseSameDay,
  readSendResult,
  regularPlayers,
  roundMiles,
  sameDayKeeps,
  searcherState,
  townOf,
  type RelationRow,
} from "../club-discovery-rules";

const NOW = new Date("2026-10-22T10:00:00Z");
const DAY = 24 * 3600_000;
const HOME = { lat: 51.36, lng: -0.17 };
/** A point `miles` due north of HOME. */
const north = (miles: number) => ({ lat: HOME.lat + (miles * KM_PER_MILE) / 111.195, lng: HOME.lng });

describe("radius presets", () => {
  it("are 1, 3, 5 and 10 miles, default 3, never above 10", () => {
    expect([...RADIUS_PRESETS_MILES]).toEqual([1, 3, 5, 10]);
    expect(DEFAULT_RADIUS_MILES).toBe(3);
    expect(MAX_RADIUS_MILES).toBe(10);
    expect(Math.max(...RADIUS_PRESETS_MILES)).toBeLessThanOrEqual(MAX_RADIUS_MILES);
  });
  it("a preset is read from the URL; anything else is the default", () => {
    expect(parseRadiusMiles("1")).toBe(1);
    expect(parseRadiusMiles("5")).toBe(5);
    expect(parseRadiusMiles(10)).toBe(10);
    expect(parseRadiusMiles(undefined)).toBe(3);
    expect(parseRadiusMiles("")).toBe(3);
    expect(parseRadiusMiles("2")).toBe(3);
    expect(parseRadiusMiles("abc")).toBe(3);
    expect(parseRadiusMiles(["5", "10"])).toBe(3);
  });
  it("the 10-mile cap: nothing above 10 is ever searched", () => {
    expect(parseRadiusMiles("11")).toBe(3);
    expect(parseRadiusMiles("25")).toBe(3);
    expect(parseRadiusMiles("1000")).toBe(3);
    expect(parseRadiusMiles(Infinity)).toBe(3);
  });
  it("the page and the same-day switch", () => {
    expect(parsePage("2")).toBe(2);
    expect(parsePage("0")).toBe(1);
    expect(parsePage("-3")).toBe(1);
    expect(parsePage("1.5")).toBe(1);
    expect(parsePage(undefined)).toBe(1);
    expect(parseSameDay("1")).toBe(true);
    expect(parseSameDay("true")).toBe(true);
    expect(parseSameDay("0")).toBe(false);
    expect(parseSameDay(undefined)).toBe(false);
  });
});

describe("distance", () => {
  it("rounds to 0.1 mile", () => {
    expect(roundMiles(2.04)).toBe(2);
    expect(roundMiles(2.05)).toBe(2.1);
    expect(roundMiles(0.84)).toBe(0.8);
  });
  it("the nearest pair of venues, in miles, with distanceKm", () => {
    const ours = [HOME, north(20)];
    const theirs = [north(4.5), north(21)];
    const got = nearestMiles(ours, theirs);
    expect(got?.theirIndex).toBe(1);
    expect(got?.miles).toBeCloseTo(distanceKm(north(20).lat, north(20).lng, north(21).lat, north(21).lng) / KM_PER_MILE, 6);
    expect(got?.miles).toBeCloseTo(1, 1);
    expect(nearestMiles([], theirs)).toBeNull();
    expect(nearestMiles(ours, [])).toBeNull();
  });
  it("in range when the exact distance is at most the radius", () => {
    expect(inRange(3, 3)).toBe(true);
    expect(inRange(3.0001, 3)).toBe(false);
    expect(inRange(0.8, 1)).toBe(true);
  });
  it("the bounding box holds every point within the radius, and not much more", () => {
    for (const r of RADIUS_PRESETS_MILES) {
      const box = boundingBox(HOME, r);
      for (let bearing = 0; bearing < 360; bearing += 15) {
        // A point just inside the radius, at this bearing.
        const km = r * KM_PER_MILE * 0.999;
        const dLat = (km * Math.cos((bearing * Math.PI) / 180)) / 111.195;
        const dLng = (km * Math.sin((bearing * Math.PI) / 180)) / (111.195 * Math.cos((HOME.lat * Math.PI) / 180));
        const p = { lat: HOME.lat + dLat, lng: HOME.lng + dLng };
        expect(distanceKm(HOME.lat, HOME.lng, p.lat, p.lng) / KM_PER_MILE).toBeLessThanOrEqual(r);
        expect(p.lat).toBeGreaterThanOrEqual(box.minLat);
        expect(p.lat).toBeLessThanOrEqual(box.maxLat);
        expect(p.lng).toBeGreaterThanOrEqual(box.minLng);
        expect(p.lng).toBeLessThanOrEqual(box.maxLng);
      }
      // Twice the radius north is outside.
      expect(north(r * 2).lat).toBeGreaterThan(box.maxLat);
    }
  });
});

const GEO = { lat: 51.36, lng: -0.17 };
const NOGEO = { lat: null, lng: null };

describe("measured from", () => {
  it("each active game's geocoded venue", () => {
    const a = { ...GEO, name: "A" };
    const b = { lat: 51.4, lng: -0.2, name: "B" };
    expect(
      measuredFrom({
        homeVenue: { lat: 52, lng: 0, name: "H" },
        games: [
          { isActive: true, venue: a },
          { isActive: false, venue: { lat: 50, lng: 0, name: "Old" } },
          { isActive: true, venue: b },
        ],
      }).map((v) => v.name),
    ).toEqual(["A", "B"]);
  });
  it("the home venue for a club with no active game", () => {
    expect(measuredFrom({ homeVenue: { ...GEO, name: "H" }, games: [] }).map((v) => v.name)).toEqual(["H"]);
    expect(measuredFrom({ homeVenue: { ...GEO, name: "H" }, games: [{ isActive: false, venue: { ...GEO, name: "Old" } }] }).map((v) => v.name)).toEqual(["H"]);
  });
  it("the home venue while no active game's venue has a position", () => {
    expect(measuredFrom({ homeVenue: { ...GEO, name: "H" }, games: [{ isActive: true, venue: null }] }).map((v) => v.name)).toEqual(["H"]);
  });
  it("nothing without a geocoded venue", () => {
    expect(measuredFrom({ homeVenue: { ...NOGEO, name: "H" }, games: [{ isActive: true, venue: { ...NOGEO, name: "G" } }] })).toEqual([]);
    expect(measuredFrom({ homeVenue: null, games: [] })).toEqual([]);
  });
});

const club = (over: Partial<Parameters<typeof isListable>[0]> = {}): Parameters<typeof isListable>[0] => ({
  approved: true,
  hasPlayersGroup: true,
  discoverable: true,
  homeVenue: null,
  games: [{ isActive: true, venue: GEO }],
  ...over,
});

describe("who is listed", () => {
  it("approved, with a players' group, find-us on and a geocoded venue", () => {
    expect(isListable(club())).toBe(true);
  });
  it("find-us on by default (a missing value reads as on)", () => {
    expect(isListable(club({ discoverable: null }))).toBe(true);
    expect(isListable(club({ discoverable: undefined }))).toBe(true);
    expect(isListable(club({ discoverable: false }))).toBe(false);
  });
  it("not approved, or no players' group: not listed", () => {
    expect(isListable(club({ approved: false }))).toBe(false);
    expect(isListable(club({ hasPlayersGroup: false }))).toBe(false);
  });
  it("no geocoded venue: not listed", () => {
    expect(isListable(club({ games: [{ isActive: true, venue: NOGEO }] }))).toBe(false);
    expect(isListable(club({ games: [{ isActive: true, venue: null }] }))).toBe(false);
    expect(isListable(club({ games: [{ isActive: false, venue: GEO }] }))).toBe(false);
  });
  it("a home venue alone is enough: no game needed", () => {
    expect(isListable(club({ games: [], homeVenue: GEO }))).toBe(true);
  });
  it("dormant, billing-paused and trial clubs are NOT excluded (the rule does not read them)", () => {
    // The shape has no dormancy or billing field to read: a dormant,
    // paused or trial club with the four facts above is listed.
    const dormantPaused = { ...club(), dormantAt: new Date(), billingStatus: "paused" } as Parameters<typeof isListable>[0];
    expect(isListable(dormantPaused)).toBe(true);
    const trial = { ...club(), billingStatus: "trial" } as Parameters<typeof isListable>[0];
    expect(isListable(trial)).toBe(true);
  });
  it("the database filter says the same as the rule, and nothing about dormancy or billing", () => {
    expect(LISTABLE_CLUB_WHERE).toEqual({ approvalStatus: "approved", whatsappGroupId: { not: null }, discoverable: true });
    const keys = Object.keys(LISTABLE_CLUB_WHERE);
    expect(keys).not.toContain("dormantAt");
    expect(keys).not.toContain("billingStatus");
  });
});

describe("who may search", () => {
  it("a club that is itself listed", () => {
    expect(searcherState(club())).toBe("ok");
    expect(searcherState({ ...club(), dormantAt: new Date(), billingStatus: "paused" } as Parameters<typeof searcherState>[0])).toBe("ok");
  });
  it("find-us off: no search (D-3)", () => {
    expect(searcherState(club({ discoverable: false }))).toBe("not-discoverable");
  });
  it("no venue: the 'Confirm your venue' prompt", () => {
    expect(searcherState(club({ games: [], homeVenue: null }))).toBe("no-venue");
    expect(searcherState(club({ games: [{ isActive: true, venue: NOGEO }] }))).toBe("no-venue");
  });
  it("not approved, or no players' group: not live yet", () => {
    expect(searcherState(club({ approved: false }))).toBe("not-live");
    expect(searcherState(club({ hasPlayersGroup: false }))).toBe("not-live");
  });
});

describe("the same-day filter", () => {
  it("off: keeps everything", () => {
    expect(sameDayKeeps([2], [4], false)).toBe(true);
  });
  it("on: keeps a club that plays on one of our days", () => {
    expect(sameDayKeeps([2, 5], [5], true)).toBe(true);
    expect(sameDayKeeps([2], [4], true)).toBe(false);
  });
  it("on: a club with no game is never excluded", () => {
    expect(sameDayKeeps([2], [], true)).toBe(true);
  });
  it("on, while we have no game ourselves: it has nothing to compare, so it keeps everything", () => {
    expect(sameDayKeeps([], [4], true)).toBe(true);
  });
});

const ME = "me";
const row = (over: Partial<RelationRow>): RelationRow => ({
  askerOrgId: ME,
  partnerOrgId: "b",
  status: "proposed",
  askerAcceptedAt: NOW,
  partnerAcceptedAt: null,
  endReason: null,
  endedByOrgId: null,
  endedAt: null,
  ...over,
});

describe("hidden clubs", () => {
  it("ourselves", () => {
    expect(hiddenOrgIds({ selfOrgId: ME, blocks: [], partnerships: [], now: NOW }).has(ME)).toBe(true);
  });
  it("a club that blocked us, and a club we blocked", () => {
    const hidden = hiddenOrgIds({
      selfOrgId: ME,
      blocks: [
        { blockerOrgId: "b", blockedOrgId: ME },
        { blockerOrgId: ME, blockedOrgId: "c" },
        { blockerOrgId: "x", blockedOrgId: "y" },
      ],
      partnerships: [],
      now: NOW,
    });
    expect(hidden.has("b")).toBe(true);
    expect(hidden.has("c")).toBe(true);
    expect(hidden.has("x")).toBe(false);
  });
  it("a club that declined us, or ended with us, in the last 30 days", () => {
    expect(REPLY_COOLDOWN_MS).toBe(30 * DAY);
    const ended = (by: string, reason: string, daysAgo: number, over: Partial<RelationRow> = {}) =>
      row({ status: "ended", endReason: reason, endedByOrgId: by, endedAt: new Date(NOW.getTime() - daysAgo * DAY), ...over });
    const hidden = (r: RelationRow) => hiddenOrgIds({ selfOrgId: ME, blocks: [], partnerships: [r], now: NOW }).has("b");
    expect(hidden(ended("b", "declined", 5))).toBe(true);
    expect(hidden(ended("b", "declined", 29.9))).toBe(true);
    expect(hidden(ended("b", "declined", 30.1))).toBe(false);
    expect(hidden(ended("b", "ended", 3))).toBe(true);
    // They ended the pairing in which THEY ask US: still "ended with us".
    expect(hidden(ended("b", "ended", 3, { askerOrgId: "b", partnerOrgId: ME }))).toBe(true);
    // We ended it, we withdrew, it expired, or the platform ended it: no wait.
    expect(hidden(ended(ME, "ended", 3))).toBe(false);
    expect(hidden(ended(ME, "withdrawn", 3))).toBe(false);
    expect(hidden(ended("b", "expired", 3))).toBe(false);
    expect(hiddenOrgIds({ selfOrgId: ME, blocks: [], partnerships: [row({ status: "ended", endedAt: new Date(NOW.getTime() - DAY) })], now: NOW }).has("b")).toBe(false);
  });
});

describe("a pairing or a pending request shows its status instead of a checkbox", () => {
  const status = (r: RelationRow | null) => cardStatus(ME, "b", r ? [r] : []);
  it("no row, or an ended one: a checkbox", () => {
    expect(status(null)).toBeNull();
    expect(status(row({ status: "ended" }))).toBeNull();
  });
  it("our request, pending: 'pending'", () => {
    expect(status(row({ status: "proposed" }))).toBe("pending");
  });
  it("active: 'paired'; paused: 'paused'", () => {
    expect(status(row({ status: "active", partnerAcceptedAt: NOW }))).toBe("paired");
    expect(status(row({ status: "paused", partnerAcceptedAt: NOW }))).toBe("paused");
  });
  it("a pairing in which THEY ask US is the other direction: we may still request (D-1)", () => {
    expect(status(row({ askerOrgId: "b", partnerOrgId: ME, status: "active" }))).toBeNull();
  });
});

describe("town, from the formatted address", () => {
  it("the town part, without the postcode and the country", () => {
    expect(townOf("Purley Way, Croydon CR0 4RQ, UK")).toBe("Croydon");
    expect(townOf("Goals, Bridge Rd, Cheam, Sutton SM2 5AT, UK")).toBe("Sutton");
    expect(townOf("London SW1A 1AA, UK")).toBe("London");
    expect(townOf("Sutton, UK")).toBe("Sutton");
    expect(townOf("Caferağa, Moda Cd. No:1, 34710 Kadıköy/İstanbul, Türkiye")).toBe("Kadıköy/İstanbul");
  });
  it("nothing for no address", () => {
    expect(townOf(null)).toBeNull();
    expect(townOf("")).toBeNull();
    expect(townOf("UK")).toBeNull();
  });
});

describe("regular players: at least 2 of the club's last 8 games", () => {
  const members = new Set(["a", "b", "c", "d", "guest"].filter((u) => u !== "guest"));
  it("counts members who played 2 or more of the last 8", () => {
    const games = [{ userIds: ["a", "b"] }, { userIds: ["a", "c"] }, { userIds: ["b"] }, { userIds: ["d"] }];
    expect(regularPlayers(games, members)).toBe(2); // a and b
  });
  it("only the newest 8 games count", () => {
    const games = [...Array.from({ length: 8 }, () => ({ userIds: ["a"] })), { userIds: ["c"] }, { userIds: ["c"] }];
    expect(regularPlayers(games, members)).toBe(1);
  });
  it("a guest or a member who left is not a regular", () => {
    const games = [{ userIds: ["guest", "a"] }, { userIds: ["guest", "a"] }];
    expect(regularPlayers(games, members)).toBe(1);
  });
  it("one game twice by the same person counts once", () => {
    expect(regularPlayers([{ userIds: ["a", "a"] }], members)).toBe(0);
  });
  it("no games: none", () => {
    expect(regularPlayers([], members)).toBe(0);
  });
});

describe("the card", () => {
  it("has exactly the plan 2.3 fields: no names, numbers, links, fees, ratings, history or coordinates", () => {
    expect([...CARD_KEYS].sort()).toEqual(["games", "members", "miles", "name", "orgId", "regulars", "status", "town", "venueName"]);
  });
});

describe("the send result", () => {
  it("each club's outcome, and the 'nearest 20' flag", () => {
    const r = readSendResult({
      ok: true,
      results: [
        { orgId: "b", outcome: "sent" },
        { orgId: "c", outcome: "refused", reason: "cooldown" },
      ],
      capped: true,
    });
    expect(r).toEqual({ failed: false, capped: true, byOrg: { b: { outcome: "sent" }, c: { outcome: "refused", reason: "cooldown" } } });
  });
  it("not ok, or no results: failed", () => {
    expect(readSendResult({ ok: false, error: "not-built" }).failed).toBe(true);
    expect(readSendResult({ ok: true }).failed).toBe(true);
    expect(readSendResult(null).failed).toBe(true);
  });
});
