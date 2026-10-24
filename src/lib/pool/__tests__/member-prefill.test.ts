/**
 * Slice L3: a club member's "Play elsewhere" form starts from what his clubs
 * already say about him (plan 3.2: "the area defaults to his clubs' venues,
 * so most members only tick consent and the days"). PURE rules.
 */
import { describe, expect, it } from "vitest";
import { fromSavedProfile, toPoolPayload } from "../form-state";
import { memberJoinConsent, memberOptInPath, phoneTail, memberPrefill, shortDisplayName, type MemberClubFacts } from "../member-prefill";
import { validatePoolFields } from "../profile-fields";
import { POOL_CONSENT_VERSION, POOL_SIGNUP } from "../rules";

const venue = (id: string, lat: number | null = 51.36) => ({ id, name: `Pitch ${id}`, address: `${id} Road`, lat, lng: lat === null ? null : -0.19 });
const five = { preset: "football-5aside", name: "Football 5-a-side", playersPerTeam: 5 };
const seven = { preset: "football-7aside", name: "Football 7-a-side", playersPerTeam: 7 };

function club(over: Partial<MemberClubFacts> = {}): MemberClubFacts {
  return {
    language: "en",
    homeVenue: null,
    activities: [{ dayOfWeek: 2, time: "20:00", matchDurationMins: 60, sport: five, venue: venue("a") }],
    ...over,
  };
}

describe("shortDisplayName: first name and last initial", () => {
  it.each([
    ["Pete Peterson", "Pete P"],
    ["  pete   van  dijk ", "pete d"],
    ["Ali", "Ali"],
    ["Ali K", "Ali K"],
    ["Ömer Çelik", "Ömer Ç"],
    ["Bartholomew Maximilian Fitzgerald-Montgomery Jr", "Bartholomew F"],
  ])("%s -> %s", (raw, want) => expect(shortDisplayName(raw)).toBe(want));
  it("nothing the validator would refuse: a number, a link, nothing", () => {
    expect(shortDisplayName("+44 7700 900003")).toBe("");
    expect(shortDisplayName("evil.com promo")).toBe("");
    expect(shortDisplayName(null)).toBe("");
  });
});

describe("memberPrefill", () => {
  it("one club: his venue, the game's day and hours, its sport and format", () => {
    const p = memberPrefill({ name: "Pat Player", clubs: [club()] });
    expect(p).toEqual({
      name: "Pat P",
      area: { kind: "venues", venueIds: ["a"] },
      venues: [{ id: "a", name: "Pitch a", address: "a Road" }],
      maxMiles: 3,
      availability: [{ day: 2, from: "20:00", to: "21:00" }],
      sports: [{ sport: "football", otherName: "", formats: [5], level: null, levelText: null }],
      language: "en",
    });
  });

  it("an odd kickoff and length widen to the half hours around the game", () => {
    const p = memberPrefill({ name: "A B", clubs: [club({ activities: [{ dayOfWeek: 4, time: "19:45", matchDurationMins: 70, sport: five, venue: venue("a") }] })] });
    expect(p.availability).toEqual([{ day: 4, from: "19:30", to: "21:00" }]);
  });

  it("a game past midnight is two ranges on two days (none crosses midnight)", () => {
    const p = memberPrefill({ name: "A B", clubs: [club({ activities: [{ dayOfWeek: 6, time: "23:30", matchDurationMins: 90, sport: five, venue: venue("a") }] })] });
    expect(p.availability).toEqual([
      { day: 0, from: "00:00", to: "01:00" },
      { day: 6, from: "23:30", to: "24:00" },
    ]);
  });

  it("several clubs and games: venues in order, once each; formats merged per sport; days merged", () => {
    const p = memberPrefill({
      name: "Pat Player",
      clubs: [
        club({
          activities: [
            { dayOfWeek: 2, time: "20:00", matchDurationMins: 60, sport: five, venue: venue("a") },
            { dayOfWeek: 2, time: "20:30", matchDurationMins: 60, sport: seven, venue: venue("b") },
          ],
        }),
        club({
          language: "tr",
          homeVenue: venue("c"),
          activities: [
            { dayOfWeek: 5, time: "18:00", matchDurationMins: 60, sport: { preset: "basketball-5v5", name: "Basketball", playersPerTeam: 5 }, venue: venue("a") },
          ],
        }),
      ],
    });
    expect(p.area).toEqual({ kind: "venues", venueIds: ["a", "b", "c"] });
    expect(p.availability).toEqual([
      { day: 2, from: "20:00", to: "21:30" },
      { day: 5, from: "18:00", to: "19:00" },
    ]);
    expect(p.sports.map((s) => [s.sport, s.formats])).toEqual([
      ["football", [5, 7]],
      ["basketball", [5]],
    ]);
    expect(p.language).toBe("en");
  });

  it("the language is his clubs' when they agree on Turkish", () => {
    expect(memberPrefill({ name: "A B", clubs: [club({ language: "tr" })] }).language).toBe("tr");
  });

  it("venues with no point are left out; at most POOL_SIGNUP.maxVenues", () => {
    const acts = ["v1", "v2", "v3", "v4", "v5", "v6"].map((id, i) => ({ dayOfWeek: i, time: "10:00", matchDurationMins: 60, sport: five, venue: venue(id) }));
    const p = memberPrefill({ name: "A B", clubs: [club({ activities: [{ ...acts[0], venue: venue("nowhere", null) }, ...acts] })] });
    expect(p.area).toEqual({ kind: "venues", venueIds: ["v1", "v2", "v3", "v4", "v5"] });
    expect(p.venues).toHaveLength(POOL_SIGNUP.maxVenues);
  });

  it("no geocoded venue at all: he types his postcode area", () => {
    const p = memberPrefill({ name: "A B", clubs: [club({ activities: [{ dayOfWeek: 2, time: "20:00", matchDurationMins: 60, sport: five, venue: null }] })] });
    expect(p.area).toEqual({ kind: "district", district: "" });
    expect(p.venues).toEqual([]);
  });

  it("a club sport the pool lacks is left out; a format the catalogue lacks means any format", () => {
    const p = memberPrefill({
      name: "A B",
      clubs: [
        club({
          activities: [
            { dayOfWeek: 1, time: "19:00", matchDurationMins: 60, sport: { preset: null, name: "Cricket nets", playersPerTeam: 6 }, venue: venue("a") },
            { dayOfWeek: 3, time: "19:00", matchDurationMins: 60, sport: { preset: null, name: "Football 6-a-side", playersPerTeam: 6 }, venue: venue("a") },
          ],
        }),
      ],
    });
    expect(p.sports).toEqual([{ sport: "football", otherName: "", formats: [], level: null, levelText: null }]);
  });

  it("no club game the pool knows: football, the form's default", () => {
    const p = memberPrefill({ name: "A B", clubs: [] });
    expect(p.sports).toEqual([{ sport: "football", otherName: "", formats: [], level: null, levelText: null }]);
    expect(p.availability).toEqual([]);
    expect(p.area).toEqual({ kind: "district", district: "" });
  });

  it("a time that is not a time is skipped, never guessed", () => {
    const p = memberPrefill({ name: "A B", clubs: [club({ activities: [{ dayOfWeek: 2, time: "evening", matchDurationMins: 60, sport: five, venue: venue("a") }] })] });
    expect(p.availability).toEqual([]);
  });

  it("the prefill goes through the one form model and the one validator untouched", () => {
    const p = memberPrefill({ name: "Pat Player", clubs: [club()] });
    const payload = toPoolPayload(fromSavedProfile(p));
    const v = validatePoolFields(payload);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value).toMatchObject({ displayName: "Pat P", venueIds: ["a"], availability: [{ day: 2, fromMin: 1200, toMin: 1260 }] });
  });
});

describe("memberOptInPath: which way a signed-in member joins", () => {
  it("in the pool already (any status): the card links to his manage page", () => {
    for (const status of ["active", "paused", "stopped"] as const) {
      expect(memberOptInPath({ hasPhone: true, profile: { status } })).toEqual({ kind: "in-pool", status });
    }
  });
  it("a number on his account: he joins here, active at once (the number is his sign-in)", () => {
    expect(memberOptInPath({ hasPhone: true, profile: null })).toEqual({ kind: "join-here" });
  });
  it("no number: the WhatsApp step, which verifies one", () => {
    expect(memberOptInPath({ hasPhone: false, profile: null })).toEqual({ kind: "join-whatsapp" });
  });
  it("a WhatsApp step he started and has not sent yet", () => {
    expect(memberOptInPath({ hasPhone: false, profile: { status: "pending-verify" } })).toEqual({ kind: "waiting-whatsapp" });
  });
  it("a number no account holds sent his code: he is asked whether it is his, by its last 4 digits only", () => {
    expect(memberOptInPath({ hasPhone: false, profile: { status: "pending-verify", claimPhone: "447700917041" } })).toEqual({ kind: "claim", tail: "7041" });
  });
  it("the claim waits for him even if he added a number meanwhile (he answers it first)", () => {
    expect(memberOptInPath({ hasPhone: true, profile: { status: "pending-verify", claimPhone: "447700917041" } })).toEqual({ kind: "claim", tail: "7041" });
  });
  it("phoneTail: the last 4 digits, never more", () => {
    expect(phoneTail("+44 7700 917041")).toBe("7041");
    expect(phoneTail("12")).toBe("12");
  });
  it("he added a number since he started the WhatsApp step: he joins here", () => {
    expect(memberOptInPath({ hasPhone: true, profile: { status: "pending-verify" } })).toEqual({ kind: "join-here" });
  });
});

describe("memberJoinConsent", () => {
  it("the web channel, the policy version, the 18+ tick, the signed-in request as evidence", () => {
    const now = new Date("2026-10-24T18:00:00Z");
    expect(memberJoinConsent("u1", now)).toEqual({
      consentAt: now,
      consentVersion: POOL_CONSENT_VERSION,
      consentChannel: "web",
      consentEvidence: `web:u1:${now.getTime()}:profile`,
      adultConfirmedAt: now,
    });
  });
});
