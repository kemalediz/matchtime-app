/**
 * Who is offered a place (slice L4). Plain code, never the model: every
 * hard filter in the approved spec and plan 4.2, the ranking, and the
 * match-level gate. One fixture player who passes everything; each row of
 * the tables changes one thing and names the exclusion it must cause.
 */
import { describe, expect, it } from "vitest";
import { KM_PER_MILE } from "../../club-discovery-rules";
import { londonDateTimeToUtc } from "../../london-time";
import {
  candidateExclusion,
  distanceToVenue,
  matchGate,
  MATCH_EXCLUSION_ORDER,
  rankCandidates,
  selectCandidates,
  withinTravel,
  type PoolCandidateRow,
  type PoolMatchContext,
} from "../matching-rules";
import type { OfferLedgerEntry } from "../caps";

const VENUE = { lat: 51.3618, lng: -0.1945 };
/** A point `miles` due north of the venue (exact on a meridian). */
const north = (miles: number) => ({ lat: VENUE.lat + (miles * KM_PER_MILE) / ((6371 * Math.PI) / 180), lng: VENUE.lng });
const east = (miles: number) => {
  const kmPerDegLng = ((6371 * Math.PI) / 180) * Math.cos((VENUE.lat * Math.PI) / 180);
  return { lat: VENUE.lat, lng: VENUE.lng + (miles * KM_PER_MILE) / kmPerDegLng };
};

const KICKOFF = londonDateTimeToUtc("2026-10-27", "19:00"); // Tuesday
const NOW = londonDateTimeToUtc("2026-10-27", "10:00");

const ctx = (o: Partial<PoolMatchContext> = {}): PoolMatchContext => ({
  matchId: "m1",
  orgId: "club",
  kickoff: KICKOFF,
  durationMins: 60,
  matchStatus: "UPCOMING",
  isHistorical: false,
  venue: VENUE,
  sport: { sport: "football", format: 7 },
  levels: null,
  poolOpen: true,
  ...o,
});

const row = (o: Partial<PoolCandidateRow> = {}): PoolCandidateRow => ({
  userId: "u1",
  status: "active",
  consentAt: new Date("2026-10-01T00:00:00Z"),
  hasPhone: true,
  maxMiles: 3,
  area: north(1),
  chosenVenues: [],
  sports: [{ sport: "football", formats: [5, 7], level: null }],
  availability: [{ day: 2, fromMin: 18 * 60, toMin: 22 * 60 }],
  isClubMember: false,
  onThisMatch: false,
  blocked: false,
  alreadyOffered: false,
  busyGames: [],
  record: { played: 0, missed: 0 },
  lastGameAt: null,
  ledger: [],
  ...o,
});

describe("matchGate: may this match be offered to the pool at all?", () => {
  const table: Array<[string, Partial<PoolMatchContext>, string | null]> = [
    ["the fixture match", {}, null],
    ["the global switch or the club's flag off", { poolOpen: false }, "pool-closed"],
    ["a cancelled match", { matchStatus: "CANCELLED" }, "match-not-open"],
    ["a completed match", { matchStatus: "COMPLETED" }, "match-not-open"],
    ["teams already published is still open", { matchStatus: "TEAMS_PUBLISHED" }, null],
    ["a historical match", { isHistorical: true }, "match-not-open"],
    ["kickoff already passed", { kickoff: new Date(NOW.getTime() - 60_000) }, "match-not-open"],
    ["a venue with no coordinates (no town fallback: decision L4.2)", { venue: null }, "no-venue"],
    ["a club sport the pool does not have", { sport: null }, "no-sport"],
  ];
  it.each(table)("%s", (_n, o, want) => expect(matchGate(ctx(o), NOW)).toBe(want));
});

describe("candidateExclusion: each hard filter, one change at a time", () => {
  const blockedLedger: OfferLedgerEntry[] = [{ orgId: "x", at: new Date(NOW.getTime() - 3600_000), outcome: null, resolvedAt: null }];
  const table: Array<[string, Partial<PoolCandidateRow>, Partial<PoolMatchContext>, string | null]> = [
    ["the fixture player passes", {}, {}, null],
    ["paused", { status: "paused" }, {}, "not-active"],
    ["stopped", { status: "stopped" }, {}, "not-active"],
    ["still pending his WhatsApp confirm", { status: "pending-verify" }, {}, "not-active"],
    ["no consent recorded", { consentAt: null }, {}, "no-consent"],
    ["no phone to message", { hasPhone: false }, {}, "no-phone"],
    ["does not play football", { sports: [{ sport: "basketball", formats: [5], level: null }] }, {}, "sport"],
    ["an 'other' sport never matches a club sport", { sports: [{ sport: "other", formats: [], level: null }] }, {}, "sport"],
    ["plays football but not 7-a-side", { sports: [{ sport: "football", formats: [5, 11], level: null }] }, {}, "format"],
    ["no formats picked means any format", { sports: [{ sport: "football", formats: [], level: null }] }, {}, null],
    ["club format unknown: only an any-format player", {}, { sport: { sport: "football", format: null } }, "format"],
    ["club format unknown, any-format player", { sports: [{ sport: "football", formats: [], level: null }] }, { sport: { sport: "football", format: null } }, null],
    ["a sport with no formats ignores formats", { sports: [{ sport: "padel", formats: [], level: null }] }, { sport: { sport: "padel", format: null } }, null],
    ["level asked, his level is one of them", { sports: [{ sport: "football", formats: [7], level: "advanced" }] }, { levels: ["advanced", "pro"] }, null],
    ["level asked, his level is not", { sports: [{ sport: "football", formats: [7], level: "novice" }] }, { levels: ["advanced"] }, "level"],
    ["level asked, he gave none (or only his own words)", {}, { levels: ["advanced"] }, "level"],
    ["no level asked: any level, none needed", { sports: [{ sport: "football", formats: [7], level: "novice" }] }, { levels: null }, null],
    ["an empty level list counts as not asked", {}, { levels: [] }, null],
    ["too far", { area: north(3.2) }, {}, "too-far"],
    ["no area and no chosen pitch with a position", { area: null, chosenVenues: [] }, {}, "too-far"],
    ["a chosen pitch near the venue rescues a far area", { area: north(8), chosenVenues: [east(0.5)] }, {}, null],
    ["wrong day", { availability: [{ day: 3, fromMin: 18 * 60, toMin: 22 * 60 }] }, {}, "not-available"],
    ["right day, ends before full time", { availability: [{ day: 2, fromMin: 18 * 60, toMin: 19 * 60 + 59 }] }, {}, "not-available"],
    ["a member of the asking club", { isClubMember: true }, {}, "club-member"],
    ["already on this match", { onThisMatch: true }, {}, "on-match"],
    ["blocked either way", { blocked: true }, {}, "blocked"],
    ["already offered this match", { alreadyOffered: true }, {}, "already-offered"],
    ["playing another game that overlaps (with travel either side)", { busyGames: [{ kickoff: new Date(KICKOFF.getTime() + 90 * 60_000), durationMins: 60 }] }, {}, "busy"],
    ["another game well clear of this one", { busyGames: [{ kickoff: new Date(KICKOFF.getTime() + 4 * 3600_000), durationMins: 60 }] }, {}, null],
    ["an offer already today", { ledger: blockedLedger }, {}, "day-cap"],
  ];
  it.each(table)("%s", (_n, r, c, want) => expect(candidateExclusion(ctx(c), row(r), NOW)).toBe(want));

  it("each exclusion the table names is in the declared order", () => {
    for (const [, , , want] of table) if (want) expect(MATCH_EXCLUSION_ORDER).toContain(want);
  });

  it("several failures: the first in MATCH_EXCLUSION_ORDER is reported (deterministic)", () => {
    expect(candidateExclusion(ctx(), row({ status: "paused", isClubMember: true, area: null }), NOW)).toBe("not-active");
    expect(candidateExclusion(ctx(), row({ isClubMember: true, area: north(9) }), NOW)).toBe("too-far");
  });
});

describe("distance from the venue", () => {
  const table: Array<[string, number, boolean]> = [
    ["0.99 of a mile, 1 mile travel", 0.99, true],
    ["1.01 miles, 1 mile travel", 1.01, false],
  ];
  it.each(table)("%s", (_n, miles, want) => {
    const d = distanceToVenue(VENUE, north(miles), []);
    expect(d).not.toBeNull();
    expect(withinTravel(d!, 1)).toBe(want);
  });
  it("exactly the travel distance is in (within float error)", () => {
    for (const m of [1, 3, 5, 10]) {
      expect(withinTravel(distanceToVenue(VENUE, north(m), [])!, m)).toBe(true);
      expect(withinTravel(distanceToVenue(VENUE, east(m), [])!, m)).toBe(true);
      expect(withinTravel(distanceToVenue(VENUE, north(m + 0.01), [])!, m)).toBe(false);
    }
  });
  it("the nearest of his area and his chosen pitches", () => {
    expect(distanceToVenue(VENUE, north(4), [north(2), east(1)])!).toBeCloseTo(1, 6);
    expect(distanceToVenue(VENUE, null, [])).toBeNull();
  });
  it("never more than 10 miles, whatever the row says", () => {
    expect(withinTravel(12, 50)).toBe(false);
  });
});

describe("rankCandidates: turn-up record, then the most recent game, then distance, then id", () => {
  it("orders by each key in turn and is deterministic", () => {
    const recent = new Date("2026-10-20T19:00:00Z");
    const older = new Date("2026-09-01T19:00:00Z");
    const rows = [
      { userId: "z-new-near", record: { played: 0, missed: 0 }, lastGameAt: null, distanceMiles: 0.5 },
      { userId: "a-unreliable", record: { played: 1, missed: 3 }, lastGameAt: recent, distanceMiles: 0.1 },
      { userId: "b-reliable-old", record: { played: 4, missed: 0 }, lastGameAt: older, distanceMiles: 0.2 },
      { userId: "c-reliable-recent-far", record: { played: 4, missed: 0 }, lastGameAt: recent, distanceMiles: 2.5 },
      { userId: "d-reliable-recent-near", record: { played: 4, missed: 0 }, lastGameAt: recent, distanceMiles: 1.0 },
      { userId: "e-tie", record: { played: 4, missed: 0 }, lastGameAt: recent, distanceMiles: 1.0 },
      { userId: "y-new-far", record: { played: 0, missed: 0 }, lastGameAt: null, distanceMiles: 2.0 },
    ];
    const want = ["d-reliable-recent-near", "e-tie", "c-reliable-recent-far", "b-reliable-old", "z-new-near", "y-new-far", "a-unreliable"];
    for (let i = 0; i < rows.length; i++) {
      const shuffled = [...rows.slice(i), ...rows.slice(0, i)];
      expect(rankCandidates(shuffled).map((r) => r.userId)).toEqual(want);
      expect(rankCandidates([...shuffled].reverse()).map((r) => r.userId)).toEqual(want);
    }
  });
  it("does not mutate its input", () => {
    const rows = [
      { userId: "b", record: { played: 0, missed: 0 }, lastGameAt: null, distanceMiles: 1 },
      { userId: "a", record: { played: 0, missed: 0 }, lastGameAt: null, distanceMiles: 1 },
    ];
    rankCandidates(rows);
    expect(rows.map((r) => r.userId)).toEqual(["b", "a"]);
  });
});

describe("selectCandidates: filter, then rank, with counts of who was left out and why", () => {
  it("returns only eligible players, ranked, each with his distance", () => {
    const rows = [
      row({ userId: "far", area: north(5) }),
      row({ userId: "member", isClubMember: true }),
      row({ userId: "ok-2", area: north(2) }),
      row({ userId: "ok-1", area: north(1) }),
    ];
    const r = selectCandidates(ctx(), rows, NOW);
    expect(r.gate).toBeNull();
    expect(r.eligible.map((e) => e.userId)).toEqual(["ok-1", "ok-2"]);
    expect(r.eligible[0].distanceMiles).toBeCloseTo(1, 6);
    expect(r.excluded).toEqual({ "too-far": 1, "club-member": 1 });
  });
  it("a closed gate returns nobody, whatever the rows", () => {
    const r = selectCandidates(ctx({ poolOpen: false }), [row()], NOW);
    expect(r).toEqual({ gate: "pool-closed", eligible: [], excluded: {} });
  });
  it("caps are checked at the SEND time, not now: a deferred 08:30 offer meets tomorrow's day cap", () => {
    const night = londonDateTimeToUtc("2026-10-26", "22:00");
    const sendAt = londonDateTimeToUtc("2026-10-27", "08:30");
    const tomorrowOffer: OfferLedgerEntry = { orgId: "x", at: londonDateTimeToUtc("2026-10-27", "12:00"), outcome: null, resolvedAt: null };
    expect(selectCandidates(ctx(), [row({ ledger: [tomorrowOffer] })], night, sendAt).excluded).toEqual({ "day-cap": 1 });
    expect(selectCandidates(ctx(), [row({ ledger: [tomorrowOffer] })], night, night).eligible).toHaveLength(1);
  });
});
