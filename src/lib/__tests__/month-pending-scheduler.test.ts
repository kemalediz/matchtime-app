/**
 * ONE MONTH PHASE IN THE SCHEDULER (club summary, slice B2): a weekly post
 * never reaches a monthly club. Each case below was a door where today's
 * scheduler let a weekly-shaped post through for a monthly club's game
 * whose month is not under way (plan D2a, D2c, and the choices K8 b to e in
 * section 3.18), each with its weekly regression guard.
 *
 * Driven through the real `computeDuePosts` with Prisma mocked, the
 * harness of announce-monthly-club.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Overrides = Record<string, Record<string, (...a: unknown[]) => unknown>>;
const overrides: Overrides = {};
const calls: Array<{ model: string; method: string; args: unknown }> = [];

function defaultFor(method: string) {
  if (method === "findMany" || method === "groupBy") return async () => [];
  if (method === "count") return async () => 0;
  if (method === "findFirst" || method === "findUnique") return async () => null;
  return async () => ({});
}

vi.mock("@/lib/club-summary/load", () => import("./fixtures/club-summary-from-test-db"));
vi.mock("@/lib/db", () => ({
  db: new Proxy(
    {},
    {
      get: (_t, model: string) =>
        new Proxy(
          {},
          {
            get: (_t2, method: string) => async (args: unknown) => {
              calls.push({ model, method, args });
              return (overrides[model]?.[method] ?? defaultFor(method))(args);
            },
          },
        ),
    },
  ),
}));

const features: Record<string, unknown> = {};
const baseFeatures = {
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
  badgeAnnouncements: false,
  squadMode: "monthly",
  listAnnouncer: "matchtime",
};
vi.mock("@/lib/org-features", () => ({ getOrgFeatures: async () => ({ ...features }) }));
vi.mock("@/lib/message-analyzer", () => ({ composeChaseText: async () => null }));
vi.mock("@/lib/admin-channel", async (orig) => ({
  ...(await orig<typeof import("@/lib/admin-channel")>()),
  loadAdminChannel: async () => ({ orgId: "org-vets" }),
  adminNoticeInstructions: async (a: { key: (who: string) => string; matchId?: string; notice: { text: (url: string, audience: string) => string } }) => [
    { kind: "dm", key: a.key("u-owner"), matchId: a.matchId, targetUser: "u-owner", phone: "447700900999", text: a.notice.text("https://x/t", "dm") },
  ],
}));

import { computeDuePosts } from "@/lib/bot-scheduler";

const GROUP = "group-vets@g.us";
const ORG = { id: "org-vets", whatsappGroupId: GROUP, whatsappBotEnabled: true, paygPricePence: 800 };
/** Mon 9 Nov 2026, 20:30 London (GMT). */
const KICKOFF = new Date("2026-11-09T20:30:00.000Z");

function att(name: string, i: number, status = "CONFIRMED") {
  return { id: `att-${i}`, userId: `u${i}`, status, position: i + 1, paidAt: null, feeWaivedAt: null, directPendingAt: null, paymentMethod: null, user: { id: `u${i}`, name, phoneNumber: `+44770090000${i}` } };
}

function match(over: Record<string, unknown> = {}, org: Record<string, unknown> = {}) {
  return {
    id: "m-mon-9-nov",
    date: KICKOFF,
    status: "UPCOMING",
    maxPlayers: 14,
    isHistorical: false,
    activityId: "vets-mon",
    attendanceDeadline: new Date("2026-11-09T18:00:00.000Z"),
    rollingSeededAt: null as Date | null,
    rollingSeededFromMatchId: null,
    feePerPlayer: null,
    feePendingConfirm: null,
    attendances: [att("Payg One", 0), att("Payg Two", 1)] as unknown[],
    teamAssignments: [] as unknown[],
    benchConfirmations: [] as unknown[],
    benchSlotOffers: [] as unknown[],
    paymentCredits: [] as unknown[],
    activity: {
      id: "vets-mon",
      orgId: ORG.id,
      name: "Football 7-a-side",
      venue: "Oaks Park High School football field",
      dayOfWeek: 1,
      time: "20:30",
      matchDurationMins: 60,
      sport: { name: "Football 7-a-side", playersPerTeam: 7, teamLabels: null },
      org: { paymentCollectionEnabled: false, paymentTrackingEnabled: false, paymentHolderId: null, teamLabels: null, language: "en", ...org },
    },
    ...over,
  };
}

/** A month row of the game, in the shape the scheduler's reads see it. */
function monthRow(status: string, over: Record<string, unknown> = {}) {
  return {
    id: "month-nov",
    activityId: "vets-mon",
    monthStart: new Date("2026-11-01T00:00:00.000Z"),
    createdAt: new Date("2026-10-25T09:00:00.000Z"),
    startedMidMonthAt: null,
    listOpenedAt: status === "open" ? new Date("2026-10-25T10:00:00.000Z") : null,
    status,
    closedAt: null,
    activity: { orgId: ORG.id, venue: "Oaks Park High School football field", dayOfWeek: 1 },
    members: [],
    ...over,
  };
}

async function run(opts: { matches?: unknown[]; month?: ReturnType<typeof monthRow> | null; heldKey?: boolean; now: Date }) {
  overrides.organisation = { findFirst: async () => ORG, findUnique: async () => ORG };
  overrides.match = { findMany: async () => opts.matches ?? [match()] };
  overrides.squadMonth = {
    findMany: async (args: unknown) => {
      const m = opts.month;
      if (!m) return [];
      const where = (args as { where?: { status?: unknown; OR?: unknown } }).where ?? {};
      if (where.OR) return m.status === "running" || m.status === "closed" ? [m] : [];
      if (typeof where.status === "object") return ["open", "priced", "running"].includes(m.status) ? [m] : [];
      if (where.status === "running") return m.status === "running" ? [m] : [];
      return [m];
    },
  };
  overrides.sentNotification = {
    findMany: async (args: unknown) => {
      const where = (args as { where?: { key?: { startsWith?: string } } }).where ?? {};
      if (where.key?.startsWith?.includes(":msu:held:")) return opts.heldKey ? [{ key: `${where.key.startsWith}2026-11-01:vets-mon` }] : [];
      return [];
    },
  };
  overrides.activity = { count: async () => 1, findMany: async () => [{ id: "vets-mon", venue: "Oaks Park High School football field", dayOfWeek: 1 }] };
  overrides.membership = { findFirst: async () => ({ userId: "u-owner" }) };
  overrides.user = { findUnique: async () => ({ name: "Davide Russo", phoneNumber: "+447700900999" }) };
  const res = await computeDuePosts(GROUP, opts.now);
  return res?.instructions ?? [];
}

const has = (out: Array<{ key: string }>, key: string) => out.some((i) => i.key === key || i.key.startsWith(`${key}:`));

beforeEach(() => {
  for (const k of Object.keys(overrides)) delete overrides[k];
  for (const k of Object.keys(features)) delete features[k];
  Object.assign(features, baseFeatures);
  calls.length = 0;
});

describe("K8 b: a month in sign-up (open or priced) gets no announcement, as a held month does", () => {
  /** Tue 3 Nov 2026, 09:00 London. */
  const NINE_AM = new Date("2026-11-03T09:00:00.000Z");
  const empty = () => [match({ attendances: [] })];
  const announce = (out: Array<{ key: string }>) => has(out, "m-mon-9-nov:announce-match");

  it("no month at all: the monthly announcement (unchanged, #501)", async () => {
    expect(announce(await run({ matches: empty(), now: NINE_AM }))).toBe(true);
  });
  it("a priced month: nothing (it went out as 'no month yet' before B2)", async () => {
    expect(announce(await run({ matches: empty(), month: monthRow("priced"), now: NINE_AM }))).toBe(false);
  });
  it("an open month whose list has not opened: nothing (it went out as 'no month yet' before B2)", async () => {
    expect(announce(await run({ matches: empty(), month: monthRow("open", { listOpenedAt: null }), now: NINE_AM }))).toBe(false);
  });
  it("an open month with its list: nothing (unchanged)", async () => {
    expect(announce(await run({ matches: empty(), month: monthRow("open"), now: NINE_AM }))).toBe(false);
  });
});

describe("K8 c: the match-day chases never reach a game whose month is not under way", () => {
  /** Match day, 08:30 London. */
  const MATCH_DAY_0830 = new Date("2026-11-09T08:30:00.000Z");
  const key = "m-mon-9-nov:chase-match-day-morning:2026-11-09";

  it("REGRESSION GUARD, weekly: the morning chase goes out", async () => {
    features.squadMode = "weekly";
    expect(has(await run({ now: MATCH_DAY_0830 }), key)).toBe(true);
  });
  it("a held month: no chase (it went out before B2)", async () => {
    expect(has(await run({ heldKey: true, now: MATCH_DAY_0830 }), key)).toBe(false);
  });
  it("a month in sign-up: no chase (it went out before B2)", async () => {
    expect(has(await run({ month: monthRow("open"), now: MATCH_DAY_0830 }), key)).toBe(false);
  });
  it("no month, the organisers announce: no chase notice to them either (it went out before B2)", async () => {
    features.listAnnouncer = "organisers";
    const out = await run({ matches: [match({ attendances: [] })], now: MATCH_DAY_0830 });
    expect(has(out, key)).toBe(false);
  });
  it("REGRESSION GUARD, weekly with the organisers announcing: the chase notice goes to them", async () => {
    features.squadMode = "weekly";
    features.listAnnouncer = "organisers";
    expect(has(await run({ matches: [match({ attendances: [] })], now: MATCH_DAY_0830 }), key)).toBe(true);
  });
});

describe("D2a: the organisers' 17:00 post skips a monthly club with no month, as the players' branch does", () => {
  /** Thu 5 Nov, 17:05 London. */
  const THU_5PM = new Date("2026-11-05T17:05:00.000Z");
  const key = "m-mon-9-nov:evening-update:2026-11-05";

  it("REGRESSION GUARD, weekly: the organisers get the 17:00 squad", async () => {
    features.squadMode = "weekly";
    features.listAnnouncer = "organisers";
    expect(has(await run({ now: THU_5PM }), key)).toBe(true);
  });
  it("monthly, no month: nothing to the organisers (it went out before B2)", async () => {
    features.listAnnouncer = "organisers";
    expect(has(await run({ now: THU_5PM }), key)).toBe(false);
  });
});

describe("D2c: no payment poll, unpaid reminder or fee ask for a monthly club's game with no month", () => {
  /** Mon 9 Nov 21:45 London: the game has ended. */
  const AFTER = new Date("2026-11-09T21:45:00.000Z");

  it("REGRESSION GUARD, weekly: the payment poll goes out", async () => {
    features.squadMode = "weekly";
    features.paymentTracking = true;
    expect(has(await run({ now: AFTER }), "m-mon-9-nov:payment-poll")).toBe(true);
  });
  it("monthly, no month: no payment poll (it went out before B2)", async () => {
    features.paymentTracking = true;
    expect(has(await run({ now: AFTER }), "m-mon-9-nov:payment-poll")).toBe(false);
  });

  const collects = { paymentCollectionEnabled: true, paymentHolderId: "u-owner" };
  it("REGRESSION GUARD, weekly: the collector is asked the fee", async () => {
    features.squadMode = "weekly";
    features.paymentCollection = true;
    expect(has(await run({ matches: [match({}, collects)], now: AFTER }), "m-mon-9-nov:fee-ask")).toBe(true);
  });
  it("monthly, no month: the collector is not asked a per-game fee (K8 d; it went out before B2)", async () => {
    features.paymentCollection = true;
    expect(has(await run({ matches: [match({}, collects)], now: AFTER }), "m-mon-9-nov:fee-ask")).toBe(false);
  });

  /** Wed 11 Nov 10:05 London: two days after the completed game. */
  const WED_10AM = new Date("2026-11-11T10:05:00.000Z");
  const rhythm = { paymentTrackingEnabled: true, dropOutDeadlineDay: 4, dropOutDeadlineTime: "18:00", listPublishDay: 5, listPublishTime: "10:00" };
  // One of the two paid, one has not: somebody to remind.
  const played = () =>
    match({ status: "COMPLETED", postMatchEndFlow: true, attendances: [{ ...att("Payg One", 0), paidAt: new Date("2026-11-09T21:40:00.000Z") }, att("Payg Two", 1)] }, rhythm);
  it("REGRESSION GUARD, weekly: the unpaid group reminder goes out", async () => {
    features.squadMode = "weekly";
    features.paymentTracking = true;
    expect(has(await run({ matches: [played()], now: WED_10AM }), "m-mon-9-nov:unpaid-group")).toBe(true);
  });
  it("monthly, no month: no unpaid group reminder (it went out before B2)", async () => {
    features.paymentTracking = true;
    expect(has(await run({ matches: [played()], now: WED_10AM }), "m-mon-9-nov:unpaid-group")).toBe(false);
  });
});

describe("K8 e: the recruit chase-up DM is not read for a game whose month is not under way", () => {
  /** Sat 7 Nov 14:00 London: a sociable hour, the game two days away. */
  const SAT = new Date("2026-11-07T14:00:00.000Z");
  const recruitRead = () => calls.some((c) => c.model === "sentNotification" && c.method === "findMany" && (c.args as { where?: { kind?: string } })?.where?.kind === "recruit-dm");

  it("REGRESSION GUARD, weekly: the invites are read to chase them", async () => {
    features.squadMode = "weekly";
    await run({ now: SAT });
    expect(recruitRead()).toBe(true);
  });
  it("monthly, no month: never (they were before B2)", async () => {
    await run({ now: SAT });
    expect(recruitRead()).toBe(false);
  });
});
