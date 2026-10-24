/**
 * The owner's pool funnel (growth slice G2): every metric definition,
 * pinned. Pure, no database.
 */
import { describe, expect, it } from "vitest";
import {
  FUNNEL_STEPS,
  buildFunnelReport,
  buildOfferHealth,
  funnelCsv,
  funnelSearch,
  funnelStepsReached,
  londonWeekStart,
  parseFunnelQuery,
  weekStarts,
  type FunnelPlaceFact,
  type FunnelProfileFact,
  type OfferHealthFacts,
} from "../funnel-rules";
import { poolOfferCancelFailReason } from "../dispatch-rules";
import { POOL_PLATFORM_CAPS } from "../caps";

const NOW = new Date("2026-10-24T12:00:00Z");
const DAY = 24 * 3600_000;

const place = (over: Partial<FunnelPlaceFact> = {}): FunnelPlaceFact => ({
  orgId: "club-a",
  match: { kickoff: new Date(NOW.getTime() - 3 * DAY), durationMins: 60, status: "COMPLETED" },
  attendance: "CONFIRMED",
  recorded: "booked",
  ...over,
});

const profile = (over: Partial<FunnelProfileFact> = {}): FunnelProfileFact => ({
  createdAt: new Date("2026-10-20T10:00:00Z"),
  status: "active",
  verified: true,
  town: null,
  sports: ["football"],
  source: "web",
  sourceCode: null,
  earlyList: false,
  offersDelivered: 0,
  places: [],
  memberOrgIds: [],
  ...over,
});

const reached = (p: FunnelProfileFact) => FUNNEL_STEPS.slice(0, funnelStepsReached(p, NOW));

describe("funnelStepsReached: one milestone after another, each needing the one before", () => {
  it("a sign-up still waiting for his WhatsApp message has only signed up", () => {
    expect(reached(profile({ status: "pending-verify", verified: false }))).toEqual(["signedUp"]);
  });

  it("confirmed on WhatsApp, still in the pool: verified and active", () => {
    expect(reached(profile())).toEqual(["signedUp", "verified", "active"]);
    expect(reached(profile({ status: "paused" }))).toEqual(["signedUp", "verified", "active"]);
  });

  it("confirmed, then stopped before any offer reached him: verified, not active", () => {
    expect(reached(profile({ status: "stopped" }))).toEqual(["signedUp", "verified"]);
  });

  it("a stop AFTER an offer reached him keeps him active: he was live long enough to be offered", () => {
    expect(reached(profile({ status: "stopped", offersDelivered: 1 }))).toEqual(["signedUp", "verified", "active", "offered"]);
  });

  it("offered counts delivered offers only (the loader passes delivered ones)", () => {
    expect(reached(profile({ offersDelivered: 0 }))).not.toContain("offered");
    expect(reached(profile({ offersDelivered: 2 }))).toContain("offered");
  });

  it("accepted: he took a guest place, whatever happened next", () => {
    expect(reached(profile({ offersDelivered: 1, places: [place({ recorded: "withdrawn", attendance: "DROPPED" })] }))).toEqual([
      "signedUp",
      "verified",
      "active",
      "offered",
      "accepted",
    ]);
  });

  it("played is the Guest players page's rule (settleGuestResult): CONFIRMED on an ended game", () => {
    expect(reached(profile({ offersDelivered: 1, places: [place()] }))).toContain("played");
    // Not played yet: the game is still to come.
    const upcoming = place({ match: { kickoff: new Date(NOW.getTime() + DAY), durationMins: 60, status: "UPCOMING" } });
    expect(reached(profile({ offersDelivered: 1, places: [upcoming] }))).not.toContain("played");
    // A no-show an organiser recorded wins over his CONFIRMED row.
    expect(reached(profile({ offersDelivered: 1, places: [place({ recorded: "no-show" })] }))).not.toContain("played");
    // A cancelled match was not a game.
    expect(
      reached(profile({ offersDelivered: 1, places: [place({ match: { kickoff: new Date(NOW.getTime() - DAY), durationMins: 60, status: "CANCELLED" } })] })),
    ).not.toContain("played");
  });

  it("became a member: a live ordinary member now of a club he PLAYED for as a pool guest", () => {
    expect(reached(profile({ offersDelivered: 1, places: [place()], memberOrgIds: ["club-a"] }))).toContain("becameMembers");
    // A member of some other club: not a conversion of this funnel.
    expect(reached(profile({ offersDelivered: 1, places: [place()], memberOrgIds: ["club-b"] }))).not.toContain("becameMembers");
    // Member of the club where he only withdrew: not counted (he never played there).
    expect(
      reached(profile({ offersDelivered: 1, places: [place({ recorded: "withdrawn", attendance: "DROPPED" })], memberOrgIds: ["club-a"] })),
    ).not.toContain("becameMembers");
  });

  it("a later step never counts without the earlier ones (no stray place without an offer)", () => {
    expect(reached(profile({ offersDelivered: 0, places: [place()], memberOrgIds: ["club-a"] }))).toEqual(["signedUp", "verified", "active"]);
    expect(reached(profile({ verified: false, status: "pending-verify", offersDelivered: 3 }))).toEqual(["signedUp"]);
  });
});

describe("London weeks (Monday 00:00)", () => {
  it("buckets by the Monday of the London week", () => {
    expect(londonWeekStart(new Date("2026-10-24T12:00:00Z")).key).toBe("2026-10-19"); // Saturday
    expect(londonWeekStart(new Date("2026-10-19T00:30:00+01:00")).key).toBe("2026-10-19"); // Monday 00:30 BST
    expect(londonWeekStart(new Date("2026-10-18T23:30:00Z")).key).toBe("2026-10-19"); // Sunday 23:30 UTC is Monday 00:30 BST
    expect(londonWeekStart(new Date("2026-10-25T23:59:00Z")).key).toBe("2026-10-19"); // Sunday after the clocks change, GMT
    expect(londonWeekStart(new Date("2026-10-19T12:00:00Z")).start.toISOString()).toBe("2026-10-18T23:00:00.000Z");
  });

  it("lists every week from the first to the last, newest first, empty weeks too", () => {
    expect(weekStarts("2026-10-01", "2026-10-24").map((w) => w.key)).toEqual(["2026-10-19", "2026-10-12", "2026-10-05", "2026-09-28"]);
  });
});

describe("parseFunnelQuery", () => {
  it("defaults to the last 12 London weeks up to today, every town, sport and source", () => {
    expect(parseFunnelQuery({}, NOW)).toEqual({ from: "2026-08-03", to: "2026-10-24", town: null, sport: null, source: null });
  });

  it("keeps good values and drops bad ones", () => {
    expect(parseFunnelQuery({ from: "2026-10-01", to: "2026-10-10", town: "sutton", sport: "padel", source: "campaign:li-kemal" }, NOW)).toEqual({
      from: "2026-10-01",
      to: "2026-10-10",
      town: "sutton",
      sport: "padel",
      source: "campaign:li-kemal",
    });
    expect(parseFunnelQuery({ from: "yesterday", to: "2026-13-45", town: "Not A Slug!", sport: "curling", source: "tv" }, NOW)).toEqual(
      parseFunnelQuery({}, NOW),
    );
    expect(parseFunnelQuery({ town: "_first", source: "referral" }, NOW)).toMatchObject({ town: "_first", source: "referral" });
  });

  it("round-trips through the page's URL (the CSV link carries the same filters)", () => {
    const q = parseFunnelQuery({ from: "2026-10-01", to: "2026-10-10", town: "_first", sport: "padel", source: "campaign:li-kemal" }, NOW);
    expect(parseFunnelQuery(Object.fromEntries(new URLSearchParams(funnelSearch(q))), NOW)).toEqual(q);
    expect(funnelSearch(parseFunnelQuery({}, NOW))).toBe("from=2026-08-03&to=2026-10-24");
  });

  it("a range given backwards is put the right way round; one too long is cut to two years", () => {
    expect(parseFunnelQuery({ from: "2026-10-10", to: "2026-10-01" }, NOW)).toMatchObject({ from: "2026-10-01", to: "2026-10-10" });
    expect(parseFunnelQuery({ from: "2020-01-01", to: "2026-10-24" }, NOW).from).toBe("2024-10-24");
  });
});

describe("buildFunnelReport", () => {
  const campaigns = [
    { code: "li-kemal", label: "LinkedIn post", source: "linkedin" },
    { code: "lf-sutton", label: "Sutton leaflets", source: "leaflet" },
  ];
  const q = parseFunnelQuery({ from: "2026-10-05", to: "2026-10-24" }, NOW);

  it("counts the cohort that signed up in the range at every step, with conversion from the step before", () => {
    const profiles = [
      profile({ status: "pending-verify", verified: false }),
      profile(),
      profile({ status: "stopped" }),
      profile({ offersDelivered: 1, places: [place()], memberOrgIds: ["club-a"] }),
      // Outside the range: not in the cohort.
      profile({ createdAt: new Date("2026-09-01T10:00:00Z"), offersDelivered: 5 }),
    ];
    const r = buildFunnelReport({ profiles, campaigns, now: NOW }, q);
    expect(r.total).toEqual({ signedUp: 4, verified: 3, active: 2, offered: 1, accepted: 1, played: 1, becameMembers: 1 });
    expect(r.conversion).toEqual({ signedUp: null, verified: 0.75, active: 2 / 3, offered: 0.5, accepted: 1, played: 1, becameMembers: 1 });
    expect(r.overall).toBe(0.25);
  });

  it("conversion is null (shown as a dash), never 0 or NaN, when the step before is empty", () => {
    const r = buildFunnelReport({ profiles: [], campaigns, now: NOW }, q);
    expect(r.total.signedUp).toBe(0);
    expect(Object.values(r.conversion).every((v) => v === null)).toBe(true);
    expect(r.overall).toBeNull();
    expect(r.empty).toBe(true);
  });

  it("the range's ends are London days, both inclusive", () => {
    const edge = [
      profile({ createdAt: new Date("2026-10-04T23:30:00Z") }), // 5 Oct 00:30 BST: in
      profile({ createdAt: new Date("2026-10-04T22:30:00Z") }), // 4 Oct 23:30 BST: out
      profile({ createdAt: new Date("2026-10-24T22:59:00Z") }), // 24 Oct 23:59 BST: in
      profile({ createdAt: new Date("2026-10-24T23:00:00Z") }), // 25 Oct: out
    ];
    expect(buildFunnelReport({ profiles: edge, campaigns, now: NOW }, q).total.signedUp).toBe(2);
  });

  it("weeks: every week of the range, sign-ups split by source, and each step for that week's sign-ups", () => {
    const profiles = [
      profile({ createdAt: new Date("2026-10-20T10:00:00Z"), source: "campaign", sourceCode: "li-kemal" }),
      profile({ createdAt: new Date("2026-10-21T10:00:00Z"), source: "referral", sourceCode: "ABC234" }),
      profile({ createdAt: new Date("2026-10-07T10:00:00Z"), source: "profile", offersDelivered: 1 }),
      profile({ createdAt: new Date("2026-10-07T11:00:00Z"), source: null, status: "pending-verify", verified: false }),
    ];
    const r = buildFunnelReport({ profiles, campaigns, now: NOW }, q);
    expect(r.weeks.map((w) => w.key)).toEqual(["2026-10-19", "2026-10-12", "2026-10-05"]);
    expect(r.weeks[0].bySource).toEqual({ web: 0, profile: 0, referral: 1, campaign: 1 });
    expect(r.weeks[1].counts.signedUp).toBe(0);
    // A sign-up with no source stamped is the web (G1.1: "else the web").
    expect(r.weeks[2].bySource).toEqual({ web: 1, profile: 1, referral: 0, campaign: 0 });
    expect(r.weeks[2].counts).toMatchObject({ signedUp: 2, verified: 1, offered: 1 });
  });

  it("by source and by campaign code; a referral is counted, its code (a person's share code) never shown", () => {
    const profiles = [
      profile({ source: "campaign", sourceCode: "li-kemal" }),
      profile({ source: "campaign", sourceCode: "li-kemal", status: "pending-verify", verified: false }),
      profile({ source: "campaign", sourceCode: "gone-code" }),
      profile({ source: "referral", sourceCode: "ABC234" }),
    ];
    const r = buildFunnelReport({ profiles, campaigns, now: NOW }, q);
    expect(r.bySource.map((s) => [s.source, s.counts.signedUp, s.counts.verified])).toEqual([
      ["web", 0, 0],
      ["profile", 0, 0],
      ["referral", 1, 1],
      ["campaign", 3, 2],
    ]);
    expect(r.byCampaign).toEqual([
      expect.objectContaining({ code: "li-kemal", label: "LinkedIn post", counts: expect.objectContaining({ signedUp: 2, verified: 1 }) }),
      expect.objectContaining({ code: "gone-code", label: null, counts: expect.objectContaining({ signedUp: 1 }) }),
    ]);
    expect(JSON.stringify(r)).not.toContain("ABC234");
  });

  it("filters: town (NULL is the first town), sport, source or one campaign code", () => {
    const profiles = [
      profile({ town: null, sports: ["football"], source: "web" }),
      profile({ town: "sutton", sports: ["padel", "football"], source: "campaign", sourceCode: "li-kemal" }),
      profile({ town: "croydon", sports: ["padel"], source: "campaign", sourceCode: "lf-sutton" }),
    ];
    const count = (extra: Record<string, string>) =>
      buildFunnelReport({ profiles, campaigns, now: NOW }, parseFunnelQuery({ from: "2026-10-05", to: "2026-10-24", ...extra }, NOW)).total.signedUp;
    expect(count({})).toBe(3);
    expect(count({ town: "_first" })).toBe(1);
    expect(count({ town: "sutton" })).toBe(1);
    expect(count({ sport: "padel" })).toBe(2);
    expect(count({ source: "campaign" })).toBe(2);
    expect(count({ source: "campaign:lf-sutton" })).toBe(1);
    expect(count({ source: "web", sport: "padel" })).toBe(0);
  });

  it("the early sign-up list: confirmed and not stopped, on the list, whenever they signed up (filters but not dates)", () => {
    const profiles = [
      profile({ earlyList: true }),
      profile({ earlyList: true, status: "paused", createdAt: new Date("2026-01-01T10:00:00Z") }),
      profile({ earlyList: true, status: "pending-verify", verified: false }),
      profile({ earlyList: true, status: "stopped" }),
      profile({ earlyList: true, town: "croydon" }),
      profile({ earlyList: false }),
    ];
    expect(buildFunnelReport({ profiles, campaigns, now: NOW }, q).earlyList).toBe(3);
    expect(buildFunnelReport({ profiles, campaigns, now: NOW }, { ...q, town: "croydon" }).earlyList).toBe(1);
  });

  it("filter choices: the towns profiles have (the first town as its own choice) and every catalogue sport", () => {
    const r = buildFunnelReport({ profiles: [profile({ town: "sutton" }), profile({ town: null }), profile({ town: "sutton" })], campaigns, now: NOW }, q);
    expect(r.options.towns).toEqual(["_first", "sutton"]);
    expect(r.options.sports).toContain("football");
    expect(r.options.sources).toEqual(["web", "profile", "referral", "campaign", "campaign:li-kemal", "campaign:lf-sutton"]);
  });
});

describe("buildOfferHealth", () => {
  const from = "2026-10-20";
  const to = "2026-10-24";
  const at = (iso: string) => new Date(iso);
  const job = (over: Partial<OfferHealthFacts["offerJobs"][number]> = {}): OfferHealthFacts["offerJobs"][number] => ({
    createdAt: at("2026-10-21T10:00:00Z"),
    sendAfter: null,
    failReason: null,
    failedAt: null,
    ...over,
  });

  it("caps hit: offers a player's own cap refused at dispatch, by reason (day, week, decline cool-off)", () => {
    const h = buildOfferHealth(
      {
        offerJobs: [
          job({ failReason: poolOfferCancelFailReason("day-cap"), failedAt: at("2026-10-21T10:00:00Z") }),
          job({ failReason: poolOfferCancelFailReason("week-cap"), failedAt: at("2026-10-22T10:00:00Z") }),
          job({ failReason: poolOfferCancelFailReason("decline-cooldown"), failedAt: at("2026-10-22T11:00:00Z") }),
          job({ failReason: poolOfferCancelFailReason("week-cap"), failedAt: at("2026-10-10T10:00:00Z") }), // before the range
          job({ failReason: poolOfferCancelFailReason("switched-off"), failedAt: at("2026-10-22T10:00:00Z") }), // not a cap
          job({ failReason: "Pi said no", failedAt: at("2026-10-22T10:00:00Z") }),
        ],
        delivered: [],
        ignoredPausedAt: [],
      },
      { from, to },
    );
    expect(h.capsHit).toEqual({ total: 3, dayCap: 1, weekCap: 1, declineCooldown: 1 });
  });

  it("quiet-hour holds: offer DMs made in the range that had to wait for the morning", () => {
    const h = buildOfferHealth(
      {
        offerJobs: [job({ sendAfter: at("2026-10-22T07:30:00Z") }), job(), job({ createdAt: at("2026-10-01T22:00:00Z"), sendAfter: at("2026-10-02T07:30:00Z") })],
        delivered: [],
        ignoredPausedAt: [],
      },
      { from, to },
    );
    expect(h.quietHourHolds).toBe(1);
  });

  it("ignored pauses: profiles paused for three ignored offers in a row, paused in the range", () => {
    const h = buildOfferHealth({ offerJobs: [], delivered: [], ignoredPausedAt: [at("2026-10-21T10:00:00Z"), at("2026-09-01T10:00:00Z")] }, { from, to });
    expect(h.ignoredPauses).toBe(1);
  });

  it("platform cap hits: each time a delivered offer filled the platform's hour or London day (the next one waited)", () => {
    const base = at("2026-10-21T08:00:00Z").getTime();
    // perHour offers in 30 minutes: the last one fills the hour.
    const burst = Array.from({ length: POOL_PLATFORM_CAPS.perHour }, (_, i) => new Date(base + i * 60_000));
    // One more, 2 hours later: the hour has room again.
    const later = [new Date(base + 2 * 3600_000)];
    const h = buildOfferHealth({ offerJobs: [], delivered: [...later, ...burst], ignoredPausedAt: [] }, { from, to });
    expect(h.platformCapHits).toBe(1);
    expect(h.delivered).toBe(POOL_PLATFORM_CAPS.perHour + 1);
  });

  it("a cap reached by offers sent before the range counts only for the moment it filled inside the range", () => {
    const start = at("2026-10-19T23:00:00Z").getTime(); // 20 Oct 00:00 BST
    const before = Array.from({ length: POOL_PLATFORM_CAPS.perHour - 1 }, (_, i) => new Date(start - (i + 1) * 60_000));
    const inside = [new Date(start + 60_000)];
    const h = buildOfferHealth({ offerJobs: [], delivered: [...before, ...inside], ignoredPausedAt: [] }, { from, to });
    expect(h.platformCapHits).toBe(1);
    expect(h.delivered).toBe(1);
  });

  it("nothing at all: every count is 0", () => {
    expect(buildOfferHealth({ offerJobs: [], delivered: [], ignoredPausedAt: [] }, { from, to })).toEqual({
      delivered: 0,
      capsHit: { total: 0, dayCap: 0, weekCap: 0, declineCooldown: 0 },
      quietHourHolds: 0,
      ignoredPauses: 0,
      platformCapHits: 0,
    });
  });
});

describe("funnelCsv", () => {
  const q = parseFunnelQuery({ from: "2026-10-05", to: "2026-10-24" }, NOW);
  const report = buildFunnelReport(
    {
      profiles: [profile({ source: "campaign", sourceCode: "=cmd" }), profile({ status: "pending-verify", verified: false })],
      campaigns: [{ code: "=cmd", label: "+SUM(A1)", source: "other" }],
      now: NOW,
    },
    q,
  );
  const health = buildOfferHealth({ offerJobs: [], delivered: [], ignoredPausedAt: [] }, q);
  const csv = funnelCsv(report, health, q);
  const lines = csv.split("\r\n");

  it("sections: the filters, the funnel with conversion, weeks, sources, campaign codes, offer health, the early list", () => {
    expect(lines[0]).toBe("Pool funnel,From 2026-10-05,To 2026-10-24,Town: all,Sport: all,Source: all");
    expect(csv).toContain("Step,People,Conversion from the step before\r\nSigned up,2,\r\nConfirmed on WhatsApp,1,50%\r\n");
    expect(csv).toContain(
      "Week from,Signed up,Web,From a club profile,Referral,Campaign,Confirmed on WhatsApp,Active,Offered,Accepted,Played,Became members\r\n2026-10-19,2,1,0,0,1,1,1,0,0,0,0\r\n",
    );
    expect(csv).toContain("Source,Signed up,");
    expect(csv).toContain("Campaign code,What it is for,Signed up,");
    expect(csv).toContain("Offer health,Count\r\nOffers delivered,0\r\n");
    expect(csv).toContain("Early sign-up list,0\r\n");
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("a cell starting with = + - @ cannot run as a spreadsheet formula", () => {
    expect(csv).toContain("'=cmd,'+SUM(A1),1,");
    expect(csv).not.toMatch(/(^|,)=cmd/m);
  });
});
