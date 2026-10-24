/**
 * Partner discovery, slice P2: the nearby-clubs loader (2026-10-22).
 * `src/lib/club-discovery.ts`. Plan: MDs/partner-discovery-plan-2026-10-21.md,
 * sections 2.2 and 2.3.
 *
 *   - THE GUARD: the other clubs' select reads nothing a card must not
 *     show (no user, phone, group, link, fee, rating or match history),
 *     and what the loader returns carries no coordinates and nothing the
 *     database had beyond the card's fields, even when the database hands
 *     back more than was asked for;
 *   - one query for the candidates, bounded by a box on Venue.lat/lng,
 *     then the exact distance; nearest first, pages of 50;
 *   - a club that may not search gets its state, and no query is made;
 *   - hidden clubs and statuses come from the pure rules.
 *
 * Against a mocked database; the real-Postgres proof is
 * e2e/web/find-clubs.spec.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  organisation: { findUnique: vi.fn(), findMany: vi.fn() },
  clubBlock: { findMany: vi.fn() },
  clubPartnership: { findMany: vi.fn() },
  $queryRaw: vi.fn(),
}));
vi.mock("../db", () => ({ db: dbMock }));

import { NEARBY_CLUB_SELECT, loadNearbyClubs } from "../club-discovery";
import { KM_PER_MILE, NEARBY_PAGE_SIZE } from "../club-discovery-rules";

const NOW = new Date("2026-10-22T10:00:00Z");
const HOME = { lat: 51.36, lng: -0.17 };
const north = (miles: number) => ({ lat: HOME.lat + (miles * KM_PER_MILE) / 111.195, lng: HOME.lng });

const me = (over: Record<string, unknown> = {}) => ({
  id: "me",
  approvalStatus: "approved",
  whatsappGroupId: "120363000000000001@g.us",
  discoverable: true,
  homeVenue: null,
  activities: [{ isActive: true, dayOfWeek: 2, venueRef: { ...HOME } }],
  ...over,
});

let seq = 0;
/** A candidate row as the database would return it, PLUS fields that must
 *  never reach the browser (as if a careless select had asked for them). */
const other = (miles: number, over: Record<string, unknown> = {}) => {
  const id = `c${++seq}`;
  return {
    id,
    name: `Club ${id}`,
    homeVenue: null,
    activities: [
      {
        dayOfWeek: 4,
        time: "19:00",
        sport: { playersPerTeam: 7 },
        venueRef: { name: `Pitch ${id}`, formattedAddress: `Somewhere Rd, Sutton SM1 1AA, UK`, ...north(miles) },
        feePerPlayer: 9,
      },
    ],
    _count: { memberships: 12 },
    // Never to be passed on:
    whatsappGroupId: "120363999@g.us",
    inviteCode: "secret-invite",
    memberships: [{ user: { name: "Pat Player", phoneNumber: "+447700900003" }, matchRating: 7.5 }],
    ...over,
  };
};

beforeEach(() => {
  seq = 0;
  vi.clearAllMocks();
  dbMock.organisation.findUnique.mockResolvedValue(me());
  dbMock.organisation.findMany.mockResolvedValue([]);
  dbMock.clubBlock.findMany.mockResolvedValue([]);
  dbMock.clubPartnership.findMany.mockResolvedValue([]);
  dbMock.$queryRaw.mockResolvedValue([]);
});

/** Every key at every depth of a Prisma select. */
function keysDeep(o: unknown, path = ""): string[] {
  if (!o || typeof o !== "object") return [];
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => [`${path}${k}`, ...keysDeep(v, `${path}${k}.`)]);
}

describe("THE GUARD: what one club learns about another", () => {
  it("the other clubs' select reads only what a card needs", () => {
    const keys = keysDeep(NEARBY_CLUB_SELECT);
    const forbidden = [
      /user/i,
      /phone/i,
      /email/i,
      /whatsapp/i,
      /group/i,
      /invite/i,
      /link/i,
      /fee/i,
      /price/i,
      /rating/i,
      /score/i,
      /attendance/i,
      /matches/i,
      /stripe/i,
      /payment/i,
      /admin/i,
    ];
    for (const k of keys) for (const f of forbidden) expect(k, `select reads ${k}`).not.toMatch(f);
    // Memberships only as a COUNT, never as rows.
    expect(keys.filter((k) => k.startsWith("memberships"))).toEqual([]);
    expect(keys).toContain("_count.select.memberships.where.leftAt");
    expect(keys).toContain("_count.select.memberships.where.guestMatchId");
  });

  it("the cards carry the card's fields only: no coordinates, names, numbers, links, fees or ratings", async () => {
    dbMock.organisation.findMany.mockResolvedValue([other(0.8)]);
    dbMock.$queryRaw.mockResolvedValue([
      { orgId: "c1", matchId: "m1", userId: "u1" },
      { orgId: "c1", matchId: "m2", userId: "u1" },
    ]);
    const r = await loadNearbyClubs("me", { radiusMiles: 3, now: NOW });
    expect(r?.state).toBe("ok");
    if (r?.state !== "ok") return;
    expect(r.clubs).toHaveLength(1);
    const card = r.clubs[0];
    expect(Object.keys(card).sort()).toEqual(["games", "members", "miles", "name", "orgId", "regulars", "status", "town", "venueName"]);
    expect(Object.keys(card.games[0]).sort()).toEqual(["dow", "perSide", "time"]);
    const json = JSON.stringify(r);
    for (const leak of ["lat", "lng", "Pat Player", "+447700900003", "120363", "secret-invite", "feePerPlayer", "matchRating", "7.5", "u1"]) {
      expect(json, `leaks ${leak}`).not.toContain(leak);
    }
    expect(card).toEqual({
      orgId: "c1",
      name: "Club c1",
      venueName: "Pitch c1",
      town: "Sutton",
      miles: 0.8,
      games: [{ dow: 4, time: "19:00", perSide: 7 }],
      members: 12,
      regulars: 1,
      status: null,
    });
  });
});

describe("the query", () => {
  it("one candidate query, bounded by a box on the venues' lat and lng, listable clubs only, never ourselves", async () => {
    await loadNearbyClubs("me", { radiusMiles: 3, now: NOW });
    expect(dbMock.organisation.findMany).toHaveBeenCalledTimes(1);
    const where = dbMock.organisation.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: { not: "me" }, approvalStatus: "approved", whatsappGroupId: { not: null }, discoverable: true });
    const text = JSON.stringify(where);
    expect(text).toContain('"lat":{"gte"');
    expect(text).toContain('"lng":{"gte"');
    // Nothing about dormancy or billing.
    expect(text).not.toContain("dormantAt");
    expect(text).not.toContain("billing");
    expect(dbMock.organisation.findMany.mock.calls[0][0].select).toBe(NEARBY_CLUB_SELECT);
  });

  it("the radius is never above 10 miles, whatever the caller passes", async () => {
    dbMock.organisation.findMany.mockResolvedValue([other(9), other(11)]);
    const r = await loadNearbyClubs("me", { radiusMiles: 50 as never, now: NOW });
    expect(r?.state === "ok" && r.radiusMiles).toBe(3);
    expect(r?.state === "ok" && r.clubs.length).toBe(0);
  });

  it("the exact distance decides: the box's corners are not in range", async () => {
    // Inside the 3-mile box (north-east corner) but 3 * sqrt(2) miles away.
    const corner = other(0);
    const dLng = (2.9 * KM_PER_MILE) / (111.195 * Math.cos((HOME.lat * Math.PI) / 180));
    corner.activities[0].venueRef = { ...corner.activities[0].venueRef, lat: north(2.9).lat, lng: HOME.lng + dLng };
    dbMock.organisation.findMany.mockResolvedValue([corner, other(2.5)]);
    const r = await loadNearbyClubs("me", { radiusMiles: 3, now: NOW });
    expect(r?.state === "ok" && r.clubs.map((c) => c.orgId)).toEqual(["c2"]);
  });
});

describe("the list", () => {
  it("nearest first, by the nearest pair of venues", async () => {
    const two = other(2.5);
    two.activities.push({ ...two.activities[0], dayOfWeek: 6, venueRef: { ...two.activities[0].venueRef, ...north(0.5) } });
    dbMock.organisation.findMany.mockResolvedValue([other(1.5), two, other(0.9)]);
    const r = await loadNearbyClubs("me", { radiusMiles: 3, now: NOW });
    if (r?.state !== "ok") throw new Error("not ok");
    expect(r.clubs.map((c) => [c.orgId, c.miles])).toEqual([
      ["c1", 0.5], // its second venue is the nearer
      ["c3", 0.9],
      ["c2", 1.5],
    ]);
    // The venue shown is the nearest one.
    expect(r.clubs[0].games.map((g) => g.dow)).toEqual([4, 6]);
  });

  it("a club with no active game is measured from its home venue, and has no games", async () => {
    dbMock.organisation.findMany.mockResolvedValue([
      other(1, { activities: [], homeVenue: { name: "Home Ground", formattedAddress: "Cheam SM3 8AA, UK", ...north(1.2) } }),
    ]);
    const r = await loadNearbyClubs("me", { radiusMiles: 3, now: NOW });
    if (r?.state !== "ok") throw new Error("not ok");
    expect(r.clubs[0]).toMatchObject({ venueName: "Home Ground", town: "Cheam", miles: 1.2, games: [] });
  });

  it("we are measured from every active game, or our home venue", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(me({ activities: [], homeVenue: { ...north(20) } }));
    dbMock.organisation.findMany.mockResolvedValue([other(21), other(1)]);
    const r = await loadNearbyClubs("me", { radiusMiles: 3, now: NOW });
    if (r?.state !== "ok") throw new Error("not ok");
    expect(r.clubs.map((c) => [c.orgId, c.miles])).toEqual([["c1", 1]]);
    expect(r.canFilterSameDay).toBe(false);
  });

  it("the same-day filter: off by default; on, it keeps our days and clubs with no game", async () => {
    const tue = other(1, { activities: [{ ...other(1).activities[0], dayOfWeek: 2 }] });
    const thu = other(1.5);
    const none = other(2, { activities: [], homeVenue: { name: "H", formattedAddress: null, ...north(2) } });
    seq = 0;
    tue.id = "tue";
    thu.id = "thu";
    none.id = "none";
    dbMock.organisation.findMany.mockResolvedValue([tue, thu, none]);
    const off = await loadNearbyClubs("me", { radiusMiles: 3, now: NOW });
    expect(off?.state === "ok" && off.clubs.map((c) => c.orgId)).toEqual(["tue", "thu", "none"]);
    const on = await loadNearbyClubs("me", { radiusMiles: 3, sameDay: true, now: NOW });
    expect(on?.state === "ok" && on.clubs.map((c) => c.orgId)).toEqual(["tue", "none"]);
  });

  it("hidden: blocks, a recent decline; statuses: paired and pending", async () => {
    dbMock.organisation.findMany.mockResolvedValue([other(1), other(1.1), other(1.2), other(1.3), other(1.4)]);
    dbMock.clubBlock.findMany.mockResolvedValue([{ blockerOrgId: "c1", blockedOrgId: "me" }]);
    dbMock.clubPartnership.findMany.mockResolvedValue([
      { askerOrgId: "me", partnerOrgId: "c2", status: "ended", askerAcceptedAt: NOW, partnerAcceptedAt: null, endReason: "declined", endedByOrgId: "c2", endedAt: new Date(NOW.getTime() - 86400_000) },
      { askerOrgId: "me", partnerOrgId: "c3", status: "active", askerAcceptedAt: NOW, partnerAcceptedAt: NOW, endReason: null, endedByOrgId: null, endedAt: null },
      { askerOrgId: "me", partnerOrgId: "c4", status: "proposed", askerAcceptedAt: NOW, partnerAcceptedAt: null, endReason: null, endedByOrgId: null, endedAt: null },
    ]);
    const r = await loadNearbyClubs("me", { radiusMiles: 3, now: NOW });
    if (r?.state !== "ok") throw new Error("not ok");
    expect(r.clubs.map((c) => [c.orgId, c.status])).toEqual([
      ["c3", "paired"],
      ["c4", "pending"],
      ["c5", null],
    ]);
  });

  it("pages of 50", async () => {
    const many = Array.from({ length: 120 }, (_, i) => other(0.01 * (i + 1)));
    dbMock.organisation.findMany.mockResolvedValue(many);
    const p1 = await loadNearbyClubs("me", { radiusMiles: 3, now: NOW });
    const p3 = await loadNearbyClubs("me", { radiusMiles: 3, page: 3, now: NOW });
    expect(NEARBY_PAGE_SIZE).toBe(50);
    if (p1?.state !== "ok" || p3?.state !== "ok") throw new Error("not ok");
    expect(p1.total).toBe(120);
    expect(p1.pageCount).toBe(3);
    expect(p1.clubs).toHaveLength(50);
    expect(p1.clubs[0].orgId).toBe("c1");
    expect(p3.clubs).toHaveLength(20);
    expect(p3.clubs[0].orgId).toBe("c101");
    // Regular players are counted for the page's clubs only, in one query.
    expect(dbMock.$queryRaw).toHaveBeenCalledTimes(2);
    const ids = dbMock.$queryRaw.mock.calls[1].slice(1).find(Array.isArray) as string[];
    expect(ids).toEqual(p3.clubs.map((c) => c.orgId));
  });
});

describe("who may search", () => {
  it("a club that is not listable gets its state, and nothing is queried", async () => {
    for (const [over, state] of [
      [{ discoverable: false }, "not-discoverable"],
      [{ activities: [], homeVenue: null }, "no-venue"],
      [{ approvalStatus: "pending" }, "not-live"],
      [{ whatsappGroupId: null }, "not-live"],
    ] as const) {
      dbMock.organisation.findMany.mockClear();
      dbMock.organisation.findUnique.mockResolvedValue(me(over));
      const r = await loadNearbyClubs("me", { radiusMiles: 3, now: NOW });
      expect(r?.state).toBe(state);
      expect(dbMock.organisation.findMany).not.toHaveBeenCalled();
    }
  });
  it("a dormant or billing-paused club still searches", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(me({ dormantAt: NOW, billingStatus: "paused" }));
    const r = await loadNearbyClubs("me", { radiusMiles: 3, now: NOW });
    expect(r?.state).toBe("ok");
  });
  it("no such club: null", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(null);
    expect(await loadNearbyClubs("nope", { radiusMiles: 3, now: NOW })).toBeNull();
  });
});
