/**
 * THE CLUB SUMMARY'S DERIVE FUNCTIONS (slice A0). PURE: no database, no
 * model, $0. Each fact is checked over the five club shapes (fixtures.ts),
 * and each one must equal what today's rule function says for the same
 * input, so the summary never becomes a second version of a rule.
 */
import { schedulerMonthShape } from "../../scheduler-month-shape";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildClubSummary,
  gameFacts,
  lastPlayedMatchIdOf,
  lifecycleFacts,
  matchNumbers,
  monthFacts,
  monthPhaseFor,
  parseHeldKey,
  paymentFacts,
  pickNextMatch,
  routineFacts,
  sortRoster,
  squadFacts,
} from "../derive";
import { FNF, MUTED, NOW, RATINGS, SHAPES, SUTTON, VETS, VETS_A, VETS_NOV, activity, match, month, orgRow } from "./fixtures";
import { isSquadShort, shortBelow } from "../../squad-short";
import { formatMinimum, minimumToPlay } from "../../min-players";
import { selectRegistrationMatch } from "../../registration-match-select";
import { isNextUpcomingForPosting } from "../../next-upcoming-match";
import { paymentMessagesOn } from "../../payment-messages";
import { effectiveTeamsReadyTime, DEFAULT_TEAMS_READY_TIME } from "../../team-proposal-rules";

afterEach(() => vi.unstubAllEnvs());

describe("lifecycle", () => {
  it("Sutton is served: on, approved, live, not paused", () => {
    expect(lifecycleFacts(SUTTON.org)).toEqual({
      botOn: true,
      dormant: false,
      approved: true,
      settingUp: false,
      billingPaused: false,
      operational: true,
      liveAt: null,
      approvedAt: null,
    });
  });

  it("a self-join club's approval instant is a fact of its own (slice A1: the bot intro reads it)", () => {
    const at = new Date("2026-10-01T10:00:00Z");
    expect(lifecycleFacts({ ...SUTTON.org, approvedAt: at }).approvedAt).toBe(at.toISOString());
  });

  it("the mute switch is its own fact: a muted club is still operational (isClubOperational is blind to it)", () => {
    const f = lifecycleFacts(MUTED.org);
    expect(f.botOn).toBe(false);
    expect(f.operational).toBe(true);
  });

  it("billing pause follows BILLING_ENABLED, as isBillingPaused does", () => {
    const paused = orgRow({ id: "o", name: "o", billingStatus: "paused" });
    vi.stubEnv("BILLING_ENABLED", "");
    expect(lifecycleFacts(paused).billingPaused).toBe(false);
    expect(lifecycleFacts(paused).operational).toBe(true);
    vi.stubEnv("BILLING_ENABLED", "1");
    expect(lifecycleFacts(paused).billingPaused).toBe(true);
    expect(lifecycleFacts(paused).operational).toBe(false);
  });

  it("dormant, unapproved and setting-up clubs say so", () => {
    expect(lifecycleFacts(orgRow({ id: "o", name: "o", dormantAt: new Date("2026-06-18T00:00:00Z") }))).toMatchObject({ dormant: true, operational: false });
    expect(lifecycleFacts(orgRow({ id: "o", name: "o", approvalStatus: "pending" }))).toMatchObject({ approved: false, operational: false, settingUp: false });
    expect(lifecycleFacts(orgRow({ id: "o", name: "o", setupStage: "setting-up" }))).toMatchObject({ settingUp: true, operational: true });
  });
});

describe("payments", () => {
  it("Sutton: collection on and live, tracking off, Kemal collects, every method", () => {
    expect(paymentFacts(SUTTON.org, { collectorName: "Kemal" })).toEqual({
      tracking: false,
      collection: true,
      messagesOn: true,
      stripe: { accountConnected: true, chargesEnabled: true },
      collectionLive: true,
      methods: { payByBank: true, card: true, direct: true },
      collector: { userId: "u-kemal", name: "Kemal" },
      instructions: null,
    });
  });

  it("FNF and the Vets: both flags off, so no payment message; the Vets still name Davide", () => {
    expect(paymentFacts(FNF.org, { collectorName: null })).toMatchObject({ messagesOn: false, collector: null });
    const vets = paymentFacts(VETS.org, { collectorName: "Davide" });
    expect(vets).toMatchObject({ tracking: false, collection: false, messagesOn: false, collector: { userId: "u-davide", name: "Davide" } });
    // No Stripe account: a card or Pay by Bank cannot be taken; direct can.
    expect(vets.methods).toEqual({ payByBank: false, card: false, direct: true });
  });

  it("tracking only is payments on (the outer gate), not collection (D3 keeps both facts)", () => {
    const f = paymentFacts(MUTED.org, { collectorName: null });
    expect(f).toMatchObject({ tracking: true, collection: false, messagesOn: true });
    for (const shape of Object.values(SHAPES)) {
      expect(paymentFacts(shape.org, { collectorName: null }).messagesOn).toBe(paymentMessagesOn(shape.org));
    }
  });
});

describe("routine", () => {
  it("FNF, organisers announce: teams ready at the default time, as effectiveTeamsReadyTime says", () => {
    const r = routineFacts(FNF.org);
    expect(r.listAnnouncer).toBe("organisers");
    expect(r.teamsReady).toBe(DEFAULT_TEAMS_READY_TIME);
    expect(r.teamsReady).toBe(effectiveTeamsReadyTime(null, true));
  });

  it("Sutton: MatchTime announces, no teams-ready time, its quiet hours, no weekly rhythm", () => {
    const r = routineFacts(SUTTON.org);
    expect(r).toMatchObject({ listAnnouncer: "matchtime", momChosenBy: "players", benchPickMode: "first-come", benchPickFallback: "bench-offer", teamsReady: "off", weeklyRhythm: false });
    expect(r.quietHours).toEqual({ enabled: true, from: "23:00", to: "09:00" });
  });

  it("weekly deadlines are kept as stored, and the rhythm needs both", () => {
    const both = routineFacts(orgRow({ id: "o", name: "o", dropOutDeadlineDay: 1, dropOutDeadlineTime: "18:00", listPublishDay: 2, listPublishTime: "12:00" }));
    expect(both.weeklyRhythm).toBe(true);
    expect(both.weeklyDeadlineSettings).toEqual({ dropOutDeadlineDay: 1, dropOutDeadlineTime: "18:00", listPublishDay: 2, listPublishTime: "12:00" });
    expect(routineFacts(orgRow({ id: "o", name: "o", dropOutDeadlineDay: 1, dropOutDeadlineTime: "18:00" })).weeklyRhythm).toBe(false);
  });

  it("unknown stored values read as today's defaults", () => {
    const r = routineFacts(orgRow({ id: "o", name: "o", listAnnouncer: "??", momChosenBy: "??", benchPickMode: "??", benchPickFallback: "??" }));
    expect(r).toMatchObject({ listAnnouncer: "matchtime", momChosenBy: "players", benchPickMode: "first-come", benchPickFallback: "bench-offer" });
  });
});

describe("squad", () => {
  it("the Vets are monthly with pay as you go at 800p; Sutton is weekly", () => {
    expect(squadFacts(VETS.org, [])).toEqual({ mode: "monthly", rolling: false, paygPricePence: 800, creditRule: "any-miss", months: [] });
    expect(squadFacts(SUTTON.org, []).mode).toBe("weekly");
    expect(squadFacts(orgRow({ id: "o", name: "o", squadMode: "fortnightly" }), []).mode).toBe("weekly");
  });
});

describe("games", () => {
  it("the Vets: 7-a-side, 14 places, playable with 12 to 16", () => {
    const [g] = gameFacts(VETS.activities);
    expect(g).toMatchObject({ formatPlaces: 14, minPlayers: 12, maxPlayers: 16, fewestToPlay: 12, range: { min: 12, max: 16, normal: 14 }, fewestAnyFormat: 12 });
    expect(g.sport.family).toBe("Football");
  });

  it("Sutton: the inactive 5-a-side still counts for the 18:00 minimum, as findMinimumToPlay reads it", () => {
    const games = gameFacts(SUTTON.activities);
    const seven = games.find((g) => g.activityId === "a-sutton-7")!;
    expect(seven.fewestToPlay).toBe(14);
    expect(seven.fewestAnyFormat).toBe(10);
    expect(seven.fewestAnyFormat).toBe(minimumToPlay({ minPlayers: null, playersPerTeam: 7 }, [{ minPlayers: null, playersPerTeam: 7 }, { minPlayers: null, playersPerTeam: 5 }]));
    expect(games.map((g) => [g.activityId, g.active])).toEqual([["a-sutton-7", true], ["a-sutton-5", false]]);
    expect(seven.fee).toEqual({ perPlayer: 6, splitTotal: false });
  });

  it("another sport family never lowers the minimum", () => {
    const games = gameFacts([
      activity({ id: "f7", sport: { name: "Football 7-a-side", playersPerTeam: 7 } }),
      activity({ id: "b3", sport: { name: "Basketball 3x3", playersPerTeam: 3 } }),
    ]);
    expect(games[0].fewestAnyFormat).toBe(14);
    expect(games[1].fewestAnyFormat).toBe(6);
  });

  it("the muted club's own minimum is its fewest", () => {
    expect(gameFacts(MUTED.activities)[0]).toMatchObject({ fewestToPlay: 8, formatPlaces: 10, fewestAnyFormat: 8 });
    expect(formatMinimum({ minPlayers: 8, playersPerTeam: 5 })).toBe(8);
  });
});

describe("matchNumbers: places open and short are two facts", () => {
  const cases: Array<[string, { places: number; confirmed: number; minPlayers: number | null; playersPerTeam: number }, { placesOpen: number; shortBelow: number; short: boolean }]> = [
    ["Vets, 13 of 14, minimum 12: one place open, not short", { places: 14, confirmed: 13, minPlayers: 12, playersPerTeam: 7 }, { placesOpen: 1, shortBelow: 12, short: false }],
    ["FNF, 12 of 14, minimum 12: two open, not short", { places: 14, confirmed: 12, minPlayers: 12, playersPerTeam: 7 }, { placesOpen: 2, shortBelow: 12, short: false }],
    ["Sutton, 12 of 14, no minimum: two open and short", { places: 14, confirmed: 12, minPlayers: null, playersPerTeam: 7 }, { placesOpen: 2, shortBelow: 14, short: true }],
    ["muted, 7 of 10, minimum 8: short", { places: 10, confirmed: 7, minPlayers: 8, playersPerTeam: 5 }, { placesOpen: 3, shortBelow: 8, short: true }],
    ["switched up to 16 with 14 in: two full sides, not short (#517)", { places: 16, confirmed: 14, minPlayers: null, playersPerTeam: 7 }, { placesOpen: 2, shortBelow: 14, short: false }],
    ["switched down to 12 with 12 in: full", { places: 12, confirmed: 12, minPlayers: null, playersPerTeam: 7 }, { placesOpen: 0, shortBelow: 12, short: false }],
    ["over-full never opens a negative place", { places: 14, confirmed: 16, minPlayers: null, playersPerTeam: 7 }, { placesOpen: 0, shortBelow: 14, short: false }],
  ];
  it.each(cases)("%s", (_, input, want) => {
    expect(matchNumbers(input)).toEqual(want);
    // The same answer as squad-short.ts, never a second version of it.
    const g = { minPlayers: input.minPlayers, maxPlayers: input.places, playersPerTeam: input.playersPerTeam };
    expect(matchNumbers(input).shortBelow).toBe(shortBelow(g));
    expect(matchNumbers(input).short).toBe(isSquadShort(input.confirmed, g));
  });
});

describe("month facts", () => {
  it("the Vets' November: running, 13 regulars, 13 paid, started on the 1st", () => {
    expect(monthFacts([VETS_NOV], VETS.activities)).toEqual([
      {
        id: "sm-vets-nov",
        activityId: "a-vets",
        fixture: { venue: "Vets Ground", dayOfWeek: 1 },
        monthStart: "2026-11-01",
        status: "running",
        listOpenedAt: "2026-10-25T10:00:00.000Z",
        pricedAt: null,
        closedAt: null,
        createdAt: "2026-10-28T10:00:00.000Z",
        startsAt: "2026-11-01T00:00:00.000Z",
        startedPartWay: false,
        regulars: 13,
        paid: { confirmed: 13, claimed: 0 },
      },
    ]);
  });

  it("claimed is a claim not yet confirmed; pay as you go rows are not regulars", () => {
    const [m] = monthFacts([month({ id: "x", activityId: "a-vets", monthStart: new Date("2026-11-01T00:00:00Z") }, { regulars: 10, paid: 4, claimed: 3, payg: 2 })], VETS.activities);
    expect(m.regulars).toBe(10);
    expect(m.paid).toEqual({ confirmed: 4, claimed: 3 });
  });

  it("a month started part way starts at that instant (summer: London is UTC+1 on the 1st of July)", () => {
    const [m] = monthFacts([month({ id: "x", activityId: "a-vets", monthStart: new Date("2026-11-01T00:00:00Z"), startedMidMonthAt: new Date("2026-11-12T09:00:00Z") })], VETS.activities);
    expect(m).toMatchObject({ startedPartWay: true, startsAt: "2026-11-12T09:00:00.000Z" });
    const [july] = monthFacts([month({ id: "j", activityId: "a-vets", monthStart: new Date("2026-07-01T00:00:00Z") })], VETS.activities);
    expect(july.startsAt).toBe("2026-06-30T23:00:00.000Z");
  });
});

describe("held keys", () => {
  it("parses the scheduler's held key: org-<id>:msu:held:<YYYY-MM-01>:<activityId>", () => {
    expect(parseHeldKey("org-vets", "org-org-vets:msu:held:2026-12-01:a-vets")).toEqual({ monthStart: "2026-12-01", activityId: "a-vets" });
    expect(parseHeldKey("org-vets", "org-org-vets:msu:list:sm1:abc:0")).toBeNull();
    expect(parseHeldKey("org-vets", "org-other:msu:held:2026-12-01:a-vets")).toBeNull();
  });
});

/**
 * THE MONTH PHASE TABLE: every SquadMonth status, a held key, no row, a
 * closed month with a game still to play, a month started part way, and a
 * format switch (another Activity of the same fixture).
 */
describe("monthPhaseFor", () => {
  const nov = (over: Partial<Parameters<typeof month>[0]> = {}, members = {}) =>
    month({ id: "sm", activityId: "a-vets", monthStart: new Date("2026-11-01T00:00:00Z"), createdAt: new Date("2026-10-28T10:00:00Z"), ...over }, members);
  const FIVE = activity({ id: "a-vets-5", venue: "Vets Ground", dayOfWeek: 1, time: "20:00", sport: { name: "Football 5-a-side", playersPerTeam: 5 } });
  const OTHER = activity({ id: "a-thu", venue: "Vets Ground", dayOfWeek: 4, sport: { name: "Football 7-a-side", playersPerTeam: 7 } });
  const acts = [VETS_A, FIVE, OTHER];
  const game = (over: Partial<Parameters<typeof match>[0]> = {}) =>
    match({ id: "m", activityId: "a-vets", date: new Date("2026-11-09T20:00:00Z"), maxPlayers: 14, ...over });
  const phase = (m: ReturnType<typeof game>, rows: ReturnType<typeof nov>[], held: string[] = []) =>
    monthPhaseFor({ orgId: "org-vets", match: m, months: monthFacts(rows, acts), activities: acts, heldKeys: held });

  const rows: Array<[string, ReturnType<typeof game>, ReturnType<typeof nov>[], string[], Record<string, unknown>]> = [
    ["no row: none", game(), [], [], { phase: "none", monthId: null, held: false, rowForOwnActivity: false }],
    ["open, list not opened yet: signup, listOpened false", game(), [nov({ status: "open" })], [], { phase: "signup", monthId: "sm", listOpened: false }],
    ["open, list opened: signup", game(), [nov({ status: "open", listOpenedAt: new Date("2026-10-25T10:00:00Z") })], [], { phase: "signup", listOpened: true }],
    ["priced", game(), [nov({ status: "priced" })], [], { phase: "priced" }],
    ["running", game(), [nov({ status: "running" })], [], { phase: "running", rowForOwnActivity: true, beforeStart: false }],
    ["closed, a game still to play: the fact is closed", game(), [nov({ status: "closed", closedAt: new Date("2026-11-03T10:00:00Z") })], [], { phase: "closed" }],
    ["held key, no row: held", game(), [], ["org-org-vets:msu:held:2026-11-01:a-vets"], { phase: "held", monthId: null, held: true, rowForOwnActivity: false }],
    ["held key AND a priced row: the row's phase, held still true", game(), [nov({ status: "priced" })], ["org-org-vets:msu:held:2026-11-01:a-vets"], { phase: "priced", held: true }],
    ["held key of another fixture: none", game(), [], ["org-org-vets:msu:held:2026-11-01:a-thu"], { phase: "none", held: false }],
    ["held key of another month: none", game(), [], ["org-org-vets:msu:held:2026-12-01:a-vets"], { phase: "none", held: false }],
    ["started part way, a game before the start: beforeStart", game({ date: new Date("2026-11-02T20:00:00Z") }), [nov({ startedMidMonthAt: new Date("2026-11-04T09:00:00Z") })], [], { phase: "running", beforeStart: true }],
    ["started part way, a game after the start", game(), [nov({ startedMidMonthAt: new Date("2026-11-04T09:00:00Z") })], [], { phase: "running", beforeStart: false }],
    ["format switch: the 5-a-side match finds the fixture's month, but not its own activity's (D5)", game({ activityId: "a-vets-5" }), [nov()], [], { phase: "running", monthId: "sm", rowForOwnActivity: false }],
    ["another fixture's month is not this one", game(), [nov({ activityId: "a-thu" })], [], { phase: "none", rowForOwnActivity: false }],
    ["a different London month", game({ date: new Date("2026-12-07T20:00:00Z") }), [nov()], [], { phase: "none", monthStart: "2026-12-01" }],
    ["two rows for one fixture: the one furthest on", game(), [nov({ id: "sm-open", activityId: "a-vets-5", status: "open" }), nov({ id: "sm-run", status: "running" })], [], { phase: "running", monthId: "sm-run" }],
  ];
  it.each(rows)("%s", (_, m, monthRows, held, want) => {
    expect(phase(m, monthRows, held)).toMatchObject(want);
  });

  it("seeded: the regulars were put on the match after the month was made", () => {
    expect(phase(game({ rollingSeededAt: new Date("2026-11-03T09:00:00Z") }), [nov()]).seeded).toBe(true);
    expect(phase(game({ rollingSeededAt: new Date("2026-10-01T09:00:00Z") }), [nov()]).seeded).toBe(false);
    expect(phase(game(), [nov()]).seeded).toBe(false);
  });

  it("the London month of a kickoff late on the 31st in summer is the next month", () => {
    const m = game({ date: new Date("2026-07-31T23:30:00Z") });
    expect(phase(m, []).monthStart).toBe("2026-08-01");
  });

  /**
   * The facts are enough to re-express TODAY's scheduler mapping with no
   * second read: since slice A1 that mapping is `schedulerMonthShape`
   * (scheduler-month-shape.ts), which `computeDuePosts` calls. Here its
   * three shapes are read as A0 wrote them out ("held" is treated as in
   * sign-up by the scheduler).
   */
  function schedulerShape(f: ReturnType<typeof phase>, m: ReturnType<typeof game>, rows: ReturnType<typeof nov>[], now: Date): "month" | "signup" | null {
    const shape = schedulerMonthShape({ facts: f, months: monthFacts(rows, acts), match: m, now });
    return shape.kind === "month" ? "month" : shape.kind === "none" ? null : "signup";
  }
  const shapeRows: Array<[string, ReturnType<typeof game>, ReturnType<typeof nov>[], string[], "month" | "signup" | null]> = [
    ["running: the month", game(), [nov()], [], "month"],
    ["closed, still to play: no month", game(), [nov({ status: "closed", closedAt: new Date("2026-11-03T10:00:00Z") })], [], null],
    ["closed, played: the month", game({ date: new Date("2026-11-02T20:00:00Z"), status: "COMPLETED" }), [nov({ status: "closed", closedAt: new Date("2026-11-03T10:00:00Z") })], [], "month"],
    ["open, list opened: sign-up", game(), [nov({ status: "open", listOpenedAt: new Date("2026-10-25T10:00:00Z") })], [], "signup"],
    ["open, list not opened: noMonthYet", game(), [nov({ status: "open" })], [], null],
    ["priced: noMonthYet (the plan said sign-up; the code says no)", game(), [nov({ status: "priced" })], [], null],
    ["priced and held: sign-up", game(), [nov({ status: "priced" })], ["org-org-vets:msu:held:2026-11-01:a-vets"], "signup"],
    ["held: sign-up", game(), [], ["org-org-vets:msu:held:2026-11-01:a-vets"], "signup"],
    ["before a part-way start: noMonthYet", game({ date: new Date("2026-11-02T20:00:00Z") }), [nov({ startedMidMonthAt: new Date("2026-11-04T09:00:00Z") })], [], null],
    ["no row: noMonthYet", game(), [], [], null],
  ];
  it.each(shapeRows)("today's scheduler mapping from the facts: %s", (_, m, monthRows, held, want) => {
    expect(schedulerShape(phase(m, monthRows, held), m, monthRows, NOW)).toBe(want);
  });
});

describe("pickNextMatch", () => {
  const A = activity({ id: "a", venue: "V", dayOfWeek: 2, sport: { name: "Football 7-a-side", playersPerTeam: 7 } });
  const at = (iso: string) => new Date(iso);

  it("the registration match is selectRegistrationMatch's, over the same rows", () => {
    for (const shape of Object.values(SHAPES)) {
      const want = selectRegistrationMatch(shape.matches.map((m) => ({ id: m.id, date: m.date, status: m.status })), NOW)?.id ?? null;
      expect(pickNextMatch({ orgId: shape.org.id, matches: shape.matches, activities: shape.activities, now: NOW }).nextMatchId).toBe(want);
    }
    expect(pickNextMatch({ orgId: "org-vets", matches: VETS.matches, activities: VETS.activities, now: NOW }).nextMatchId).toBe("m-vets-9nov");
  });

  it("a live match from before today blocks the next one", () => {
    const ms = [match({ id: "old", activityId: "a", date: at("2026-11-03T21:30:00Z"), maxPlayers: 14 }), match({ id: "new", activityId: "a", date: at("2026-11-10T21:30:00Z"), maxPlayers: 14 })];
    expect(pickNextMatch({ orgId: "o", matches: ms, activities: [A], now: NOW }).nextMatchId).toBeNull();
  });

  it("a cancelled match today holds the fixture's next match for the announcement only (both values kept)", () => {
    const now = at("2026-11-10T12:00:00Z");
    const ms = [
      match({ id: "cancelled", activityId: "a", date: at("2026-11-10T21:30:00Z"), maxPlayers: 14, status: "CANCELLED" }),
      match({ id: "next", activityId: "a", date: at("2026-11-17T21:30:00Z"), maxPlayers: 14 }),
    ];
    const r = pickNextMatch({ orgId: "o", matches: ms, activities: [A], now });
    expect(r.nextForPosting.get("next")).toEqual({ withHold: false, withoutHold: true });
    expect(r.nextForPosting.get("cancelled")).toEqual({ withHold: false, withoutHold: false });
    const asScheduler = ms.map((m) => ({ id: m.id, activityId: m.activityId, date: m.date, status: m.status, activity: { orgId: "o", venue: "V", dayOfWeek: 2 } }));
    expect(isNextUpcomingForPosting(asScheduler, asScheduler[1], now)).toBe(false);
    expect(isNextUpcomingForPosting(asScheduler, asScheduler[1])).toBe(true);
  });

  it("the rollover guard works across a format switch (same venue and weekday)", () => {
    const FIVE = activity({ id: "a5", venue: "V", dayOfWeek: 2, sport: { name: "Football 5-a-side", playersPerTeam: 5 } });
    const ms = [
      match({ id: "this-week", activityId: "a5", date: at("2026-11-10T21:15:00Z"), maxPlayers: 10 }),
      match({ id: "next-week", activityId: "a", date: at("2026-11-17T21:30:00Z"), maxPlayers: 14 }),
    ];
    const r = pickNextMatch({ orgId: "o", matches: ms, activities: [A, FIVE], now: NOW });
    expect(r.nextForPosting.get("this-week")!.withHold).toBe(true);
    expect(r.nextForPosting.get("next-week")!.withHold).toBe(false);
  });
});

describe("lastPlayedMatchIdOf", () => {
  it("the most recent match whose kickoff plus duration has passed", () => {
    const rows = [
      { id: "playing-now", date: new Date("2026-11-04T11:30:00Z"), activity: { matchDurationMins: 60 } },
      { id: "yesterday", date: new Date("2026-11-03T21:30:00Z"), activity: { matchDurationMins: 60 } },
    ];
    expect(lastPlayedMatchIdOf(rows, NOW)).toBe("yesterday");
    expect(lastPlayedMatchIdOf(rows, new Date("2026-11-04T12:30:00Z"))).toBe("playing-now");
    expect(lastPlayedMatchIdOf([], NOW)).toBeNull();
  });
});

describe("sortRoster", () => {
  it("one stable order: membership createdAt, then its id; aliases sorted; admins named", () => {
    const r = sortRoster(SUTTON.members!);
    expect(r.roster.map((m) => m.userId)).toEqual(["u-kemal", "u-amir", "u-zed"]);
    expect(r.roster.find((m) => m.userId === "u-amir")!.aliases).toEqual(["AK", "Amo"]);
    expect(r.adminUserIds).toEqual(["u-kemal"]);
  });

  it("FNF's nameless members: name is empty, the printed line is loadPlayerNames', ties broken by id", () => {
    const r = sortRoster(FNF.members!);
    expect(r.roster.map((m) => m.userId)).toEqual(["u-fnf-org", "u-fnf-a", "u-fnf-b"]);
    expect(r.roster[1]).toEqual({ userId: "u-fnf-a", name: "", displayName: "Smiler", aliases: ["Smiler"], isAdmin: false, hasPhone: true });
    // No printed line at all: the plain name, here empty.
    expect(r.roster[2].displayName).toBe("");
  });

  it("the same rows in another order give the same roster", () => {
    const rows = FNF.members!;
    expect(sortRoster({ ...rows, rows: [...rows.rows].reverse() })).toEqual(sortRoster(rows));
  });
});

describe("buildClubSummary over the five shapes", () => {
  it("the Vets read as Kemal's example", () => {
    const s = buildClubSummary(VETS, NOW);
    expect(s.squad.mode).toBe("monthly");
    expect(s.squad.months[0]).toMatchObject({ monthStart: "2026-11-01", status: "running", regulars: 13, paid: { confirmed: 13, claimed: 0 } });
    expect(s.squad.paygPricePence).toBe(800);
    expect(s.payments).toMatchObject({ tracking: false, collection: false, messagesOn: false, collector: { name: "Davide" } });
    expect(s.games[0]).toMatchObject({ sport: { playersPerTeam: 7 }, formatPlaces: 14, range: { min: 12, max: 16 } });
    expect(s.nextMatchId).toBe("m-vets-9nov");
    const next = s.matches.find((m) => m.id === s.nextMatchId)!;
    expect(next).toMatchObject({ kickoffAt: "2026-11-09T20:00:00.000Z", confirmed: 13, placesOpen: 1, short: false });
    expect(next.month).toMatchObject({ phase: "running", monthId: "sm-vets-nov", seeded: true });
    expect(s.matches.find((m) => m.id === "m-vets-7dec")!.month).toMatchObject({ phase: "none", monthStart: "2026-12-01" });
    expect(s.members!.roster.find((m) => m.userId === "u-nabz")!.aliases).toEqual(["Smiler"]);
    expect(s.lastPlayedMatchId).toBe("m-vets-2nov");
  });

  it("a weekly club's matches carry no month", () => {
    for (const shape of [SUTTON, FNF, RATINGS, MUTED]) {
      expect(buildClubSummary(shape, NOW).matches.every((m) => m.month === null)).toBe(true);
    }
  });

  it("Sutton: places, fee, posting and the last game", () => {
    const s = buildClubSummary(SUTTON, NOW);
    expect(s.nextMatchId).toBe("m-sutton-10nov");
    const next = s.matches.find((m) => m.id === "m-sutton-10nov")!;
    expect(next).toMatchObject({ places: 14, confirmed: 12, bench: 2, placesOpen: 2, short: true, fewestAnyFormat: 10, teamsMade: false, fee: { matchFee: null, pendingConfirm: null, linksReleased: false }, nextForPosting: { withHold: true, withoutHold: true } });
    expect(s.matches.find((m) => m.id === "m-sutton-3nov")!.teamsMade).toBe(true);
    expect(s.lastPlayedMatchId).toBe("m-sutton-3nov");
    expect(s.groups.playersGroupId).toBe("org-sutton@g.us");
  });

  it("FNF: HQ linked, organisers announce, nobody short at 12 of 14", () => {
    const s = buildClubSummary(FNF, NOW);
    expect(s.groups.hq).toEqual({ groupId: "hq-fnf@g.us", channelMode: "admin-group", channelUserId: null });
    expect(s.routine.listAnnouncer).toBe("organisers");
    expect(s.matches[0]).toMatchObject({ confirmed: 12, placesOpen: 2, short: false });
    expect(s.members!.adminUserIds).toEqual(["u-fnf-org"]);
  });

  it("ratings only: the switches are getOrgFeatures' object, untouched; no members loaded", () => {
    const s = buildClubSummary(RATINGS, NOW);
    expect(s.features).toBe(RATINGS.features);
    expect(s.features.attendance).toBe(false);
    expect(s.members).toBeNull();
  });

  it("muted: bot off, short at 7 of its own 8", () => {
    const s = buildClubSummary(MUTED, NOW);
    expect(s.lifecycle.botOn).toBe(false);
    expect(s.matches[0]).toMatchObject({ shortBelow: 8, short: true, placesOpen: 3 });
  });

  it("asOf, name and language", () => {
    const s = buildClubSummary(SUTTON, NOW);
    expect(s).toMatchObject({ orgId: "org-sutton", name: "Sutton FC", asOf: NOW.toISOString(), language: "en" });
    expect(buildClubSummary({ ...SUTTON, org: { ...SUTTON.org, language: "xx" } }, NOW).language).toBe("en");
  });

  it("weekly deadlines per match come from weeklyDeadlinesFor", () => {
    const org = { ...SUTTON.org, dropOutDeadlineDay: 1, dropOutDeadlineTime: "18:00", listPublishDay: 2, listPublishTime: "12:00" };
    const next = buildClubSummary({ ...SUTTON, org }, NOW).matches.find((m) => m.id === "m-sutton-10nov")!;
    expect(next.weeklyDeadlines).toEqual({ dropOut: "2026-11-09T18:00:00.000Z", listPublish: "2026-11-10T12:00:00.000Z" });
  });
});
