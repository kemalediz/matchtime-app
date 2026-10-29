/**
 * What the loader's query results MEAN (slice L4): the match context and
 * one row per person, built without a database.
 */
import { describe, expect, it } from "vitest";
import { candidateRowsOf, ledgerEntryOf, matchContextOf, offerCountsAt, type RawPerUser, type RawProfile } from "../candidate-rows";

const raw = {
  id: "m1",
  date: new Date("2026-10-27T19:00:00Z"),
  status: "UPCOMING",
  isHistorical: false,
  activity: {
    orgId: "club",
    matchDurationMins: 60,
    venueRef: { lat: 51.36, lng: -0.19 },
    sport: { preset: "football-7aside", name: "Football 7-a-side", playersPerTeam: 7 },
  },
};

describe("matchContextOf", () => {
  it("maps the match, its venue position and its pool sport", () => {
    expect(matchContextOf(raw, true)).toEqual({
      matchId: "m1",
      orgId: "club",
      kickoff: raw.date,
      durationMins: 60,
      matchStatus: "UPCOMING",
      isHistorical: false,
      venue: { lat: 51.36, lng: -0.19 },
      sport: { sport: "football", format: 7 },
      levels: null,
      poolOpen: true,
    });
  });
  it("a venue with no position, or no venue, is null; an unknown sport is null", () => {
    expect(matchContextOf({ ...raw, activity: { ...raw.activity, venueRef: { lat: null, lng: -0.19 } } }, true).venue).toBeNull();
    expect(matchContextOf({ ...raw, activity: { ...raw.activity, venueRef: null } }, true).venue).toBeNull();
    expect(matchContextOf({ ...raw, activity: { ...raw.activity, sport: { preset: "cricket", name: "Cricket", playersPerTeam: 11 } } }, true).sport).toBeNull();
  });
  it("carries the levels the ask names", () => {
    expect(matchContextOf(raw, true, ["pro"]).levels).toEqual(["pro"]);
  });
});

describe("offerCountsAt / ledgerEntryOf", () => {
  const created = new Date("2026-10-26T21:45:00Z");
  const held = new Date("2026-10-27T08:30:00Z");
  const sent = new Date("2026-10-27T08:31:00Z");
  it("sent: its sentAt; queued and held: the job's send time; else its creation", () => {
    expect(offerCountsAt({ sentAt: sent, jobSendAfter: held, createdAt: created })).toEqual(sent);
    expect(offerCountsAt({ sentAt: null, jobSendAfter: held, createdAt: created })).toEqual(held);
    expect(offerCountsAt({ sentAt: null, jobSendAfter: null, createdAt: created })).toEqual(created);
  });
  it("an unknown outcome string reads as still open", () => {
    const o = { userId: "u", matchId: "m", orgId: "c", sentAt: sent, createdAt: created, resolvedAt: null, jobSendAfter: null };
    expect(ledgerEntryOf({ ...o, outcome: "declined" }).outcome).toBe("declined");
    expect(ledgerEntryOf({ ...o, outcome: "bogus" }).outcome).toBeNull();
  });
});

describe("candidateRowsOf", () => {
  const profile = (o: Partial<RawProfile> = {}): RawProfile => ({
    userId: "u1",
    status: "active",
    consentAt: new Date("2026-10-01T00:00:00Z"),
    maxMiles: 3,
    areaLat: 51.37,
    areaLng: -0.19,
    phoneNumber: "447700900001",
    sports: [{ sport: "football", formats: [7], level: "advanced" }],
    availability: [{ day: 2, fromMin: 1080, toMin: 1320 }],
    ...o,
  });
  const empty: RawPerUser = {
    clubMemberIds: new Set(),
    onMatchIds: new Set(),
    blockedIds: new Set(),
    offers: [],
    busy: [],
    guestPlaces: [],
    ownGames: [],
  };

  it("a person with nothing else on record", () => {
    const [r] = candidateRowsOf("m1", [profile()], empty);
    expect(r).toMatchObject({
      userId: "u1",
      hasPhone: true,
      area: { lat: 51.37, lng: -0.19 },
      isClubMember: false,
      onThisMatch: false,
      blocked: false,
      alreadyOffered: false,
      busyGames: [],
      record: { played: 0, missed: 0 },
      lastGameAt: null,
      ledger: [],
    });
  });

  it("no phone and no area: no position at all, and no chosen pitches either (postcode area only)", () => {
    const [r] = candidateRowsOf("m1", [profile({ phoneNumber: null, areaLat: null })], empty);
    expect(r.hasPhone).toBe(false);
    expect(r.area).toBeNull();
    expect(r).not.toHaveProperty("chosenVenues");
  });

  it("each per-person fact lands on the right person only", () => {
    const d = (s: string) => new Date(s);
    const per: RawPerUser = {
      ...empty,
      clubMemberIds: new Set(["a"]),
      onMatchIds: new Set(["b"]),
      blockedIds: new Set(["a"]),
      offers: [
        { userId: "a", matchId: "m1", orgId: "club", sentAt: d("2026-10-26T10:00:00Z"), createdAt: d("2026-10-26T10:00:00Z"), outcome: null, resolvedAt: null, jobSendAfter: null },
        { userId: "b", matchId: "m9", orgId: "x", sentAt: d("2026-10-20T10:00:00Z"), createdAt: d("2026-10-20T10:00:00Z"), outcome: "ignored", resolvedAt: d("2026-10-20T16:00:00Z"), jobSendAfter: null },
      ],
      busy: [{ userId: "b", kickoff: d("2026-10-27T20:00:00Z"), durationMins: 60 }],
      guestPlaces: [
        { userId: "b", result: "played", matchDate: d("2026-10-10T19:00:00Z") },
        { userId: "b", result: "no-show", matchDate: d("2026-10-17T19:00:00Z") },
        { userId: "b", result: "booked", matchDate: d("2026-10-30T19:00:00Z") },
      ],
      ownGames: [{ userId: "a", matchDate: d("2026-10-21T19:00:00Z") }],
    };
    const [a, b] = candidateRowsOf("m1", [profile({ userId: "a" }), profile({ userId: "b" })], per);
    expect(a).toMatchObject({ isClubMember: true, blocked: true, onThisMatch: false, alreadyOffered: true, busyGames: [], record: { played: 0, missed: 0 }, lastGameAt: d("2026-10-21T19:00:00Z") });
    expect(a.ledger).toHaveLength(1);
    expect(b).toMatchObject({ isClubMember: false, blocked: false, onThisMatch: true, alreadyOffered: false, record: { played: 1, missed: 1 } });
    expect(b.busyGames).toEqual([{ kickoff: d("2026-10-27T20:00:00Z"), durationMins: 60 }]);
    // His last game is the one he PLAYED, not the no-show or the booked one.
    expect(b.lastGameAt).toEqual(d("2026-10-10T19:00:00Z"));
    expect(b.ledger[0]).toEqual({ orgId: "x", at: d("2026-10-20T10:00:00Z"), outcome: "ignored", resolvedAt: d("2026-10-20T16:00:00Z") });
  });
  it("an offer that never reached him (cancelled before its DM went) is not already-offered; one that reached him is, whatever its outcome", () => {
    const d = (s: string) => new Date(s);
    const base = { orgId: "club", createdAt: d("2026-10-26T10:00:00Z"), resolvedAt: d("2026-10-26T10:05:00Z"), jobSendAfter: null };
    const per: RawPerUser = {
      ...empty,
      offers: [
        { ...base, userId: "never", matchId: "m1", sentAt: null, outcome: "cancelled" },
        { ...base, userId: "sentCancelled", matchId: "m1", sentAt: d("2026-10-26T10:01:00Z"), outcome: "cancelled" },
        { ...base, userId: "expired", matchId: "m1", sentAt: d("2026-10-26T10:01:00Z"), outcome: "expired" },
        { ...base, userId: "queued", matchId: "m1", sentAt: null, outcome: null, resolvedAt: null },
      ],
    };
    const rows = candidateRowsOf("m1", ["never", "sentCancelled", "expired", "queued"].map((userId) => profile({ userId })), per);
    expect(rows.map((r) => [r.userId, r.alreadyOffered])).toEqual([
      ["never", false],
      ["sentCancelled", true],
      ["expired", true],
      ["queued", true],
    ]);
    // The caps already ignore it: its ledger entry is "cancelled".
    expect(rows[0].ledger[0].outcome).toBe("cancelled");
  });
});
