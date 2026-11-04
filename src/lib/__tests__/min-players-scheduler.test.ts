/**
 * THE FEWEST PLAYERS A GAME IS PLAYED WITH, in the owner's day-before
 * nudges (2026-11-03, the Vets preview). With 13 of 14 confirmed, Davide
 * would have been told on the Sunday at 18:00 "Match in trouble: only 13
 * confirmed ... below the minimum to play (14). Cancel and refund the
 * booking?". The Vets play one down (6 v 7). `Activity.minPlayers` is the
 * organiser's own minimum; null keeps today's behaviour exactly.
 *
 * Driven through the real `computeDuePosts` with Prisma mocked (the
 * harness of announce-monthly-club.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Overrides = Record<string, Record<string, (...a: unknown[]) => unknown>>;
const overrides: Overrides = {};

function defaultFor(method: string) {
  if (method === "findMany" || method === "groupBy") return async () => [];
  if (method === "count") return async () => 0;
  if (method === "findFirst" || method === "findUnique") return async () => null;
  return async () => ({});
}

// The scheduler reads its club facts from the club summary (A1): the summary of this test's own world.
vi.mock("@/lib/club-summary/load", () => import("./fixtures/club-summary-from-test-db"));
vi.mock("@/lib/db", () => ({
  db: new Proxy(
    {},
    {
      get: (_t, model: string) =>
        new Proxy({}, { get: (_t2, method: string) => overrides[model]?.[method] ?? defaultFor(method) }),
    },
  ),
}));

const features: Record<string, unknown> = {
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
};
vi.mock("@/lib/org-features", () => ({ getOrgFeatures: async () => ({ ...features }) }));
vi.mock("@/lib/message-analyzer", () => ({ composeChaseText: async () => null }));
// The owner's day-before nudges go through the admin channel. Off unless a
// test turns it on, so every other case here is unchanged.
const adminChannel = { on: false };
vi.mock("@/lib/admin-channel", async (orig) => ({
  ...(await orig<typeof import("@/lib/admin-channel")>()),
  loadAdminChannel: async () => (adminChannel.on ? { orgId: "org-vets" } : null),
  adminNoticeInstructions: async (a: { key: (who: string) => string; matchId?: string; notice: { text: (url: string, audience: string) => string } }) => [
    { kind: "dm", key: a.key("u-owner"), matchId: a.matchId, targetUser: "u-owner", phone: "447700900999", text: a.notice.text("https://x/t", "dm") },
  ],
}));

import { computeDuePosts } from "@/lib/bot-scheduler";

const GROUP = "group-vets@g.us";
const ORG = { id: "org-vets", whatsappGroupId: GROUP, whatsappBotEnabled: true, paygPricePence: null };

/** Mon 9 Nov 2026, 20:30 London (GMT). */
const KICKOFF = new Date("2026-11-09T20:30:00.000Z");
/** Tue 3 Nov 2026, 09:00 London: the incident tick. */
const NINE_AM = new Date("2026-11-03T09:00:00.000Z");

function att(name: string, i: number, status = "CONFIRMED") {
  return {
    id: `att-${i}`,
    userId: `u${i}`,
    status,
    position: i + 1,
    paidAt: null,
    directPendingAt: null,
    paymentMethod: null,
    user: { id: `u${i}`, name, phoneNumber: `+44770090000${i}` },
  };
}

function match(over: Record<string, unknown> = {}) {
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
    attendances: [] as unknown[],
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
      matchDurationMins: 60,
      sport: { name: "Football 7-a-side", playersPerTeam: 7, teamLabels: null },
      org: { paymentCollectionEnabled: false, paymentHolderId: null, teamLabels: null, language: "en" },
    },
    ...over,
  };
}

/** A running November month for the fixture, created before the seed. */
function runningMonth() {
  return {
    id: "month-nov",
    monthStart: new Date("2026-11-01T00:00:00.000Z"),
    createdAt: new Date("2026-11-01T09:00:00.000Z"),
    startedMidMonthAt: null,
    status: "running",
    closedAt: null,
    activity: { orgId: ORG.id, venue: "Oaks Park High School football field", dayOfWeek: 1 },
    members: [],
  };
}

async function run(opts: {
  matches?: unknown[];
  organiserName?: string | null;
  running?: boolean;
  sent?: string[];
  heldKey?: boolean;
  now?: Date;
} = {}) {
  overrides.organisation = { findFirst: async () => ORG, findUnique: async () => ORG };
  overrides.match = { findMany: async () => opts.matches ?? [match()] };
  overrides.squadMonth = {
    findMany: async (args: unknown) => {
      const status = (args as { where?: { status?: unknown; OR?: unknown } }).where;
      // The weekly flow's read (running, or closed lately).
      if (opts.running && (status?.OR || status?.status === "running")) return [runningMonth()];
      return [];
    },
  };
  overrides.sentNotification = {
    findMany: async (args: unknown) => {
      const where = (args as { where?: { key?: { startsWith?: string } } }).where ?? {};
      if (where.key?.startsWith?.includes(":msu:held:")) {
        return opts.heldKey ? [{ key: `${where.key.startsWith}2026-11-01:vets-mon` }] : [];
      }
      if (where.key?.startsWith) return [];
      return (opts.sent ?? []).map((key) => ({ key, targetUser: null, createdAt: new Date(0) }));
    },
  };
  overrides.sport = { findUnique: async () => ({ name: "Football 7-a-side" }) };
  overrides.activity = {
    count: async () => 0,
    findMany: async (args: unknown) => {
      // The club's games of the sport, as `findMinimumToPlay` and
      // `findSmallerSameSportActivity` read them.
      const a = args as { select?: { minPlayers?: boolean }; include?: { sport?: unknown } };
      if (a.select?.minPlayers || a.include?.sport) {
        return formats.map((f, i) => ({
          id: `act-${i}`,
          minPlayers: f.minPlayers,
          sport: { name: f.name, playersPerTeam: f.ppt, teamLabels: null },
        }));
      }
      return [{ id: "vets-mon", venue: "Oaks Park High School football field", dayOfWeek: 1 }];
    },
  };
  // The organiser the group hello names: the club's OWNER here.
  overrides.membership = {
    findFirst: async (args: unknown) =>
      (args as { where?: { role?: string } }).where?.role === "OWNER" && opts.organiserName !== null ? { userId: "u-owner" } : null,
  };
  overrides.user = {
    findUnique: async (args: unknown) =>
      (args as { where?: { id?: string } }).where?.id === "u-owner" ? { name: opts.organiserName ?? "Kemal Ediz" } : null,
  };
  const res = await computeDuePosts(GROUP, opts.now ?? NINE_AM);
  return res?.instructions ?? [];
}


beforeEach(() => {
  for (const k of Object.keys(overrides)) delete overrides[k];
  adminChannel.on = false;
  features.squadMode = "monthly";
  features.language = "en";
});

/** Sun 8 Nov 18:05 London (GMT): the cancel nudge's hour. */
const SUN_6PM = new Date("2026-11-08T18:05:00.000Z");
/** Sun 8 Nov 10:05 London: the switch nudge's hour. */
const SUN_10AM = new Date("2026-11-08T10:05:00.000Z");
const cancelKey = (id: string) => `${id}:cancel-nudge:u-owner`;
const switchKey = (id: string) => `${id}:switch-nudge:u-owner`;
const regulars = (n: number) => Array.from({ length: n }, (_, i) => att(`Regular ${i}`, i));
const SEEDED = new Date("2026-11-03T08:05:00.000Z");

/** The Vets' Monday game with `n` regulars on it and this minimum. */
function vetsGame(n: number, minPlayers: number | null) {
  const m = match({ attendances: regulars(n), rollingSeededAt: SEEDED });
  return { ...m, activity: { ...(m.activity as object), sportId: "sport-7s", minPlayers } };
}

type Format = { name: string; ppt: number; minPlayers: number | null };
let formats: Format[] = [];

async function runWith(m: unknown, now: Date, f: Format[]) {
  adminChannel.on = true;
  formats = f;
  return run({ running: true, matches: [m], now });
}

describe("the 18:00 'Match in trouble' nudge uses the game's minimum", () => {
  beforeEach(() => {
    features.squadMode = "weekly";
  });

  it("REGRESSION GUARD: no minimum set, 13 of 14: the nudge goes, minimum 14, as before", async () => {
    const m = vetsGame(13, null);
    const f = [{ name: "Football 7-a-side", ppt: 7, minPlayers: null }];
    const out = await runWith(m, SUN_6PM, f);
    const dm = out.find((i) => i.key === cancelKey(m.id)) as { text: string } | undefined;
    expect(dm).toBeDefined();
    expect(dm!.text).toContain("only *13* confirmed");
    expect(dm!.text).toContain("below the minimum to play (14)");
  });

  it("THE VETS: minimum 12, 13 of 14 the day before: no 'Match in trouble'", async () => {
    const m = vetsGame(13, 12);
    const f = [{ name: "Football 7-a-side", ppt: 7, minPlayers: 12 }];
    const out = await runWith(m, SUN_6PM, f);
    expect(out.some((i) => i.key === cancelKey(m.id))).toBe(false);
    expect(out.some((i) => "text" in i && String((i as { text: string }).text).includes("Match in trouble"))).toBe(false);
  });

  it("minimum 12, exactly 12: no nudge", async () => {
    const m = vetsGame(12, 12);
    const f = [{ name: "Football 7-a-side", ppt: 7, minPlayers: 12 }];
    const out = await runWith(m, SUN_6PM, f);
    expect(out.some((i) => i.key === cancelKey(m.id))).toBe(false);
  });

  it("minimum 12, 11 of 14: it warns, naming 12", async () => {
    const m = vetsGame(11, 12);
    const f = [{ name: "Football 7-a-side", ppt: 7, minPlayers: 12 }];
    const out = await runWith(m, SUN_6PM, f);
    const dm = out.find((i) => i.key === cancelKey(m.id)) as { text: string } | undefined;
    expect(dm).toBeDefined();
    expect(dm!.text).toContain("only *11* confirmed");
    expect(dm!.text).toContain("below the minimum to play (12)");
  });

  it("REGRESSION GUARD: a 5-a-side game of the same sport still lowers it to 10 (no minimums set)", async () => {
    const m = vetsGame(11, null);
    const f = [
      { name: "Football 7-a-side", ppt: 7, minPlayers: null },
      { name: "Football 5-a-side", ppt: 5, minPlayers: null },
    ];
    const out = await runWith(m, SUN_6PM, f);
    expect(out.some((i) => i.key === cancelKey(m.id))).toBe(false);
  });

  it("a Turkish club hears it in Turkish", async () => {
    features.language = "tr";
    const m = vetsGame(11, 12);
    const act = m.activity as unknown as { org: Record<string, unknown> };
    act.org = { ...act.org, language: "tr" };
    const f = [{ name: "Football 7-a-side", ppt: 7, minPlayers: 12 }];
    const out = await runWith(m, SUN_6PM, f);
    const dm = out.find((i) => i.key === cancelKey(m.id)) as { text: string } | undefined;
    expect(dm!.text).toContain("Maç tehlikede");
    expect(dm!.text).toContain("en az 12 kişi");
  });
});

describe("the 10:00 'Low numbers' switch nudge uses the game's minimum", () => {
  beforeEach(() => {
    features.squadMode = "weekly";
  });
  const twoFormats = (min: number | null) => [
    { name: "Football 7-a-side", ppt: 7, minPlayers: min },
    { name: "Football 5-a-side", ppt: 5, minPlayers: null },
  ];

  it("REGRESSION GUARD: no minimum, 13 of 14 and a 5-a-side to switch to: the nudge goes", async () => {
    const m = vetsGame(13, null);
    const f = twoFormats(null);
    const out = await runWith(m, SUN_10AM, f);
    const dm = out.find((i) => i.key === switchKey(m.id)) as { text: string } | undefined;
    expect(dm).toBeDefined();
    expect(dm!.text).toContain("13 of 14 confirmed");
  });

  it("minimum 12, 13 of 14: no switch offer", async () => {
    const m = vetsGame(13, 12);
    const f = twoFormats(12);
    const out = await runWith(m, SUN_10AM, f);
    expect(out.some((i) => i.key === switchKey(m.id))).toBe(false);
  });

  it("minimum 12, 11 of 14: the switch offer goes", async () => {
    const m = vetsGame(11, 12);
    const f = twoFormats(12);
    const out = await runWith(m, SUN_10AM, f);
    expect(out.some((i) => i.key === switchKey(m.id))).toBe(true);
  });
});

// REVIEW OF #517 (uncommitted, failing): a match switched UP inside its
// range keeps the day-before "Low numbers" nudge keyed on the match's new
// places. A game with only a maximum set (16) and no minimum, switched to
// 8-a-side, with 14 in (two full 7-a-side teams), must not be told it is
// short and offered the 5-a-side.
describe("review #517: a switched-up match is not 'low numbers' at the format's own places", () => {
  beforeEach(() => {
    features.squadMode = "weekly";
  });
  it("max 16, no minimum, match at 16 places, 14 confirmed: no 'Low numbers' switch nudge", async () => {
    const base = vetsGame(14, null);
    const m = { ...base, maxPlayers: 16, activity: { ...(base.activity as object), maxPlayers: 16 } };
    const f = [
      { name: "Football 7-a-side", ppt: 7, minPlayers: null },
      { name: "Football 5-a-side", ppt: 5, minPlayers: null },
    ];
    const out = await runWith(m, SUN_10AM, f);
    const dm = out.find((i) => i.key === switchKey(m.id)) as { text: string } | undefined;
    expect(dm?.text).toBeUndefined();
  });
});
