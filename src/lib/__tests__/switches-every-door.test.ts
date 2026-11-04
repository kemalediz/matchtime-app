/**
 * EVERY DOOR HONOURS THE CLUB'S SWITCHES (club summary, slice B7; plan D8,
 * D11; decision K4, Kemal 2026-11-04).
 *
 * The pure and scheduler half. The web half (the match page, the IN and OUT
 * actions, the rate page and its actions) is
 * `src/app/__tests__/switches-every-door-web.test.ts`.
 *
 *   - D11: the players' group hello and the admin group's introduction say
 *     the same thing about ratings, Man of the Match and IN and OUT, from
 *     one description (`describeClub`).
 *   - D8: a bench offer's DM is a bench message (it went out with bench
 *     off), and the tentative follow-up asks for an IN the club does not
 *     take with attendance off.
 *   - D8: a DM question is answered with no stats or history when the club
 *     has stats answers off, as the players' group answers none.
 */
import { describe, expect, it } from "vitest";
import { describeClub, type ClubDescriptionInput } from "../club-description";
import { DEFAULT_HELLO_SETTINGS, helloFeatureLines, signsUpEachWeek, type GroupHelloSettings } from "../group-hello";
import { buildAdminGroupIntro, type AdminGroupIntroClub } from "../admin-group-help";
import { featureGateAllows } from "../bot-scheduler";
import { gateFeatureOfKey, topicOfDueKey, featureForDueKey } from "../due-key-feature";
import { formatScopedContext, type ScopedContextInput } from "../dm-qa";
import { t } from "../i18n/t";
import type { OrgFeatures } from "../org-features";

const BASE: ClubDescriptionInput = {
  attendance: true,
  squadFromList: false,
  rollingSquad: false,
  monthly: false,
  playerRating: true,
  momVoting: true,
  momByOrganisers: false,
};

describe("describeClub: one description of what MatchTime does for the club", () => {
  it("a weekly club with everything on reads IN and OUT, sends ratings, runs MoM", () => {
    expect(describeClub(BASE)).toEqual({ readsInAndOut: true, signsUpEachWeek: true, ratings: true, mom: true });
  });
  it("ratings only with a pasted squad (the Thursday shape): ratings and MoM, no IN and OUT", () => {
    expect(describeClub({ ...BASE, attendance: false, squadFromList: true })).toEqual({
      readsInAndOut: false,
      signsUpEachWeek: false,
      ratings: true,
      mom: true,
    });
  });
  it("attendance off and no pasted squad: the rating DMs reach nobody, so no ratings and no players' vote", () => {
    expect(describeClub({ ...BASE, attendance: false })).toMatchObject({ ratings: false, mom: false });
  });
  it("the organisers pick Man of the Match: MoM follows its own switch, not the ratings", () => {
    expect(describeClub({ ...BASE, attendance: false, momByOrganisers: true }).mom).toBe(true);
    expect(describeClub({ ...BASE, momByOrganisers: true, momVoting: false }).mom).toBe(false);
  });
  it("a pasted squad is never read for IN and OUT, even with attendance on", () => {
    expect(describeClub({ ...BASE, squadFromList: true }).readsInAndOut).toBe(false);
  });
  it("a rolling squad still reads IN and OUT but does not sign up each week; a monthly club does neither", () => {
    expect(describeClub({ ...BASE, rollingSquad: true })).toMatchObject({ readsInAndOut: true, signsUpEachWeek: false });
    expect(describeClub({ ...BASE, monthly: true })).toMatchObject({ readsInAndOut: false, signsUpEachWeek: false });
  });
});

/** One club, as the hello's settings and as the intro's row. */
function shapes(c: ClubDescriptionInput): { hello: GroupHelloSettings; intro: AdminGroupIntroClub } {
  return {
    hello: {
      ...DEFAULT_HELLO_SETTINGS,
      attendance: c.attendance,
      squadFromList: c.squadFromList,
      rollingSquad: c.rollingSquad,
      squadMode: c.monthly ? "monthly" : "weekly",
      playerRating: c.playerRating,
      momVoting: c.momVoting,
      momByOrganisers: c.momByOrganisers,
    },
    intro: {
      name: "Thursday Ratings",
      language: "en",
      whatsappBotEnabled: true,
      squadMode: c.monthly ? "monthly" : "weekly",
      featureAttendance: c.attendance,
      featureSquadFromList: c.squadFromList,
      rollingSquadEnabled: c.rollingSquad,
      featurePlayerRating: c.playerRating,
      featureMomVoting: c.momVoting,
      momChosenBy: c.momByOrganisers ? "organisers" : "players",
      activityDays: [4],
    },
  };
}

const CASES: Array<[string, ClubDescriptionInput]> = [
  ["everything on", BASE],
  ["ratings only, pasted squad", { ...BASE, attendance: false, squadFromList: true }],
  ["attendance off, no pasted squad", { ...BASE, attendance: false }],
  ["attendance on, pasted squad", { ...BASE, squadFromList: true }],
  ["organisers pick MoM, attendance off", { ...BASE, attendance: false, momByOrganisers: true }],
  ["rolling squad", { ...BASE, rollingSquad: true }],
];

describe("D11: the hello and the admin group's introduction agree", () => {
  const optional = t("en").sj_hello_optional({ organiser: null });
  it.each(CASES)("%s", (_label, c) => {
    const { hello, intro } = shapes(c);
    const d = describeClub(c);
    const lines = helloFeatureLines({ organiser: null, lang: "en", settings: hello });
    const helloRatings = !lines[0].includes(optional.trim());
    const text = buildAdminGroupIntro(intro);
    const introRatings = /ratings after the game/.test(text);
    const introMom = /Man of the Match/.test(text);
    const introInOut = text.includes("*IN* and *OUT*");
    expect({ helloRatings, introRatings }).toEqual({ helloRatings: d.ratings, introRatings: d.ratings });
    expect(introMom).toBe(d.mom);
    expect(introInOut).toBe(d.readsInAndOut);
    expect(signsUpEachWeek(hello)).toBe(d.signsUpEachWeek);
  });
});

const FEATURES = (over: Partial<OrgFeatures>): OrgFeatures => ({
  botEnabled: true,
  attendance: true,
  bench: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  reminders: true,
  statsQa: true,
  paymentTracking: false,
  paymentCollection: false,
  squadFromList: false,
  language: "en",
  rollingSquad: false,
  benchPickMode: "first-come",
  badgeAnnouncements: true,
  squadMode: "weekly",
  ...over,
});

describe("D8: the scheduler's gate covers the bench offer's DMs and the tentative follow-up", () => {
  const offerDm = { kind: "dm", key: "offer-bso1:dm:u-ali" };
  const offerPost = { kind: "bench-prompt", key: "offer-bso1" };
  const tentative = { kind: "dm", key: "m-1:tentative-followup:u-ali" };
  it("bench off: neither the group post nor the bencher's DM goes out", () => {
    expect(featureGateAllows(FEATURES({ bench: false }), offerPost)).toBe(false);
    expect(featureGateAllows(FEATURES({ bench: false }), offerDm)).toBe(false);
  });
  it("bench on: both go out, as before", () => {
    expect(featureGateAllows(FEATURES({}), offerPost)).toBe(true);
    expect(featureGateAllows(FEATURES({}), offerDm)).toBe(true);
  });
  it("attendance off: no tentative follow-up; on: as before", () => {
    expect(featureGateAllows(FEATURES({ attendance: false }), tentative)).toBe(false);
    expect(featureGateAllows(FEATURES({}), tentative)).toBe(true);
  });
  it("the keys' topics, which a DM classifier is shown, do not change", () => {
    expect(gateFeatureOfKey(offerDm.key)).toBe("bench");
    expect(gateFeatureOfKey(tentative.key)).toBe("attendance");
    expect(featureForDueKey(offerDm.key)).toBeNull();
    expect(topicOfDueKey(offerDm.key)).toBeNull();
    expect(topicOfDueKey(tentative.key)).toBe("tentativeFollowup");
    expect(gateFeatureOfKey("m-1:chase-morning")).toBeNull();
  });
});

describe("D8: a DM question with stats answers off", () => {
  const input: ScopedContextInput = {
    orgName: "Thursday Ratings",
    match: null,
    stats: {
      gamesPlayed: 5,
      totalOrgMatches: 6,
      attendanceRate: 83,
      avgRating: 7.1,
      fieldAvgSeason: 6.5,
      momCount: 1,
      record: { w: 3, d: 1, l: 1 },
      form: { last5Avg: 7.0, trend: "steady" },
      bestPartner: null,
      nemesis: null,
    },
    history: null,
  };
  it("on (absent): the context is exactly as before", () => {
    expect(formatScopedContext(input)).toBe(formatScopedContext({ ...input, statsOff: undefined }));
    expect(formatScopedContext(input)).toContain("YOUR STATS:");
    expect(formatScopedContext(input)).not.toContain("switched off");
  });
  it("off: the loader hands in no stats; the context says they are switched off", () => {
    const text = formatScopedContext({ ...input, stats: null, history: null, statsOff: true });
    expect(text).not.toContain("YOUR STATS:");
    expect(text).not.toContain("Recent History");
    expect(text).toContain("STATS AND RESULTS: switched off by this club's organisers.");
  });
});
