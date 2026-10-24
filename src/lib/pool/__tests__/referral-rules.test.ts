/**
 * Referral badges and "Brought by" (growth slice G4): the pure rules.
 */
import { describe, expect, it } from "vitest";
import { REFERRAL_BADGES, referralBadgesEarned } from "@/lib/badge-rules";
import {
  broughtByName,
  chooseHomeClub,
  countReferrals,
  friendHasPlayed,
  isCountableReferral,
  pickReferralAwards,
  recognitionShown,
  referralAnnouncedKey,
} from "../referral-rules";

const D = (iso: string) => new Date(iso);

describe("the referral badges' thresholds", () => {
  it("Recruiter 1, Scout 3, Talent Spotter 10 (spec)", () => {
    expect(REFERRAL_BADGES.map((b) => [b.key, b.minFriends])).toEqual([
      ["recruiter", 1],
      ["scout", 3],
      ["talent-spotter", 10],
    ]);
    expect(referralBadgesEarned(0)).toEqual({ recruiter: false, scout: false, "talent-spotter": false });
    expect(referralBadgesEarned(2)).toEqual({ recruiter: true, scout: false, "talent-spotter": false });
    expect(referralBadgesEarned(3)).toEqual({ recruiter: true, scout: true, "talent-spotter": false });
    expect(referralBadgesEarned(10)).toEqual({ recruiter: true, scout: true, "talent-spotter": true });
  });
});

describe("friendHasPlayed: a game he actually played", () => {
  it("a settled played guest game counts", () => {
    expect(friendHasPlayed({ guestPlaces: [{ matchId: "m1", result: "played", settledAt: D("2026-10-20") }], memberGames: [{ matchId: "m1" }] })).toBe(true);
  });
  it("a guest place not settled yet (the no-show window is open) does not, even with his CONFIRMED row on the completed match", () => {
    expect(friendHasPlayed({ guestPlaces: [{ matchId: "m1", result: "played", settledAt: null }], memberGames: [{ matchId: "m1" }] })).toBe(false);
    expect(friendHasPlayed({ guestPlaces: [{ matchId: "m1", result: "booked", settledAt: null }], memberGames: [{ matchId: "m1" }] })).toBe(false);
  });
  it("a no-show, late cancel or withdrawn guest game does not", () => {
    for (const result of ["no-show", "late-cancel", "withdrawn", "booked"]) {
      expect(friendHasPlayed({ guestPlaces: [{ matchId: "m1", result, settledAt: D("2026-10-20") }], memberGames: [{ matchId: "m1" }] })).toBe(false);
    }
  });
  it("a completed match he was CONFIRMED on as a member (no guest place) counts", () => {
    expect(friendHasPlayed({ guestPlaces: [], memberGames: [{ matchId: "m2" }] })).toBe(true);
    expect(friendHasPlayed({ guestPlaces: [{ matchId: "m1", result: "no-show", settledAt: D("2026-10-20") }], memberGames: [{ matchId: "m1" }, { matchId: "m2" }] })).toBe(true);
  });
  it("signed up but never played: no", () => {
    expect(friendHasPlayed({ guestPlaces: [], memberGames: [] })).toBe(false);
  });
});

describe("isCountableReferral", () => {
  const base = { friendUserId: "bea", referrerUserId: "ali", referralCountedAt: D("2026-10-20"), referrersOwnReferrerId: null };
  it("a kept referral whose friend has played counts", () => {
    expect(isCountableReferral(base)).toBe(true);
  });
  it("not yet played (not stamped), or not kept (no referrer): no", () => {
    expect(isCountableReferral({ ...base, referralCountedAt: null })).toBe(false);
    expect(isCountableReferral({ ...base, referrerUserId: null })).toBe(false);
  });
  it("himself, or a loop (the friend brought the referrer): never", () => {
    expect(isCountableReferral({ ...base, referrerUserId: "bea" })).toBe(false);
    expect(isCountableReferral({ ...base, referrersOwnReferrerId: "bea" })).toBe(false);
  });
  it("countReferrals: per referrer, only the countable ones", () => {
    const n = countReferrals([
      base,
      { ...base, friendUserId: "cem" },
      { ...base, friendUserId: "dan", referralCountedAt: null },
      { ...base, friendUserId: "eve", referrerUserId: "zed" },
      { ...base, friendUserId: "ali", referrerUserId: "ali" },
    ]);
    expect(Object.fromEntries(n)).toEqual({ ali: 2, zed: 1 });
  });
});

describe("chooseHomeClub: the one club he plays most", () => {
  it("most games, then the latest game, then a stable tie-break", () => {
    expect(chooseHomeClub([])).toBeNull();
    expect(
      chooseHomeClub([
        { orgId: "a", gamesPlayed: 3, lastPlayedAt: D("2026-10-01") },
        { orgId: "b", gamesPlayed: 5, lastPlayedAt: D("2026-09-01") },
      ]),
    ).toBe("b");
    expect(
      chooseHomeClub([
        { orgId: "a", gamesPlayed: 5, lastPlayedAt: D("2026-09-01") },
        { orgId: "b", gamesPlayed: 5, lastPlayedAt: D("2026-10-01") },
      ]),
    ).toBe("b");
    expect(
      chooseHomeClub([
        { orgId: "b", gamesPlayed: 0, lastPlayedAt: null },
        { orgId: "a", gamesPlayed: 0, lastPlayedAt: null },
      ]),
    ).toBe("a");
  });
});

describe("recognitionShown: his privacy switch", () => {
  it("named only for a live profile with the switch showing", () => {
    expect(recognitionShown({ status: "active", showRecognition: true })).toBe(true);
    expect(recognitionShown({ status: "paused", showRecognition: true })).toBe(true);
    expect(recognitionShown({ status: "active", showRecognition: false })).toBe(false);
    expect(recognitionShown({ status: "stopped", showRecognition: true })).toBe(false);
    expect(recognitionShown(null)).toBe(false);
  });
});

describe("pickReferralAwards: who this club's post names", () => {
  const ali = { userId: "ali", friendsPlayed: 1, homeOrgId: "fnf", shown: true };
  const args = (over: Partial<Parameters<typeof pickReferralAwards>[0]> = {}) => ({
    orgId: "fnf",
    referrers: [ali],
    announced: new Set<string>(),
    eligibleUserIds: new Set(["ali", "bob"]),
    ...over,
  });

  it("his first friend played: Recruiter, in his home club", () => {
    expect(pickReferralAwards(args())).toEqual({ awards: [{ userId: "ali", badgeKey: "recruiter" }], silent: [] });
  });
  it("another club (not his home club) says nothing", () => {
    expect(pickReferralAwards(args({ orgId: "sutton" }))).toEqual({ awards: [], silent: [] });
  });
  it("announced already (in ANY club): never again", () => {
    expect(pickReferralAwards(args({ announced: new Set([referralAnnouncedKey("ali", "recruiter")]) }))).toEqual({ awards: [], silent: [] });
  });
  it("three friends at once: only Scout is announced, Recruiter recorded silently", () => {
    expect(pickReferralAwards(args({ referrers: [{ ...ali, friendsPlayed: 3 }] }))).toEqual({
      awards: [{ userId: "ali", badgeKey: "scout" }],
      silent: [{ userId: "ali", badgeKey: "recruiter" }],
    });
    expect(
      pickReferralAwards(args({ referrers: [{ ...ali, friendsPlayed: 3 }], announced: new Set([referralAnnouncedKey("ali", "recruiter")]) })),
    ).toEqual({ awards: [{ userId: "ali", badgeKey: "scout" }], silent: [] });
  });
  it("kept private: nothing, not even a silent row", () => {
    expect(pickReferralAwards(args({ referrers: [{ ...ali, shown: false }] }))).toEqual({ awards: [], silent: [] });
  });
  it("not a current member of the club: nothing", () => {
    expect(pickReferralAwards(args({ eligibleUserIds: new Set(["bob"]) }))).toEqual({ awards: [], silent: [] });
  });
  it("no friend has played: nothing", () => {
    expect(pickReferralAwards(args({ referrers: [{ ...ali, friendsPlayed: 0 }] }))).toEqual({ awards: [], silent: [] });
  });
});

describe("broughtByName: the line on the friend's first game", () => {
  const referrer = { displayName: "Ali Kaya", status: "active", showRecognition: true };
  it("his first game: first name and last initial", () => {
    expect(broughtByName({ firstGame: true, referrer })).toBe("Ali K.");
  });
  it("not his first game, no referrer, or the referrer keeps it private: nothing", () => {
    expect(broughtByName({ firstGame: false, referrer })).toBeNull();
    expect(broughtByName({ firstGame: true, referrer: null })).toBeNull();
    expect(broughtByName({ firstGame: true, referrer: { ...referrer, showRecognition: false } })).toBeNull();
    expect(broughtByName({ firstGame: true, referrer: { ...referrer, status: "stopped" } })).toBeNull();
  });
});
