/**
 * TWO SCHEDULER FIXES FROM THE SANDBOXED CLUB REPLAY (2026-11-04), driven
 * through the real `computeDuePosts` with Prisma mocked (the harness of
 * organisers-announce-scheduler.test.ts).
 *
 * 1. "SHORT" IS ONE THING. FNF's game takes 12 to 18 (`Activity.minPlayers`
 *    12, 18 places). With 12 confirmed the day before there is rightly no
 *    "Match in trouble", yet the admins were told three times on match day
 *    "Kickoff is getting close and the squad is still short": the chases
 *    counted against the places, the nudges against the minimum. At or
 *    above the game's minimum the game is on and HQ never hears "short".
 *    The players' chase for the open places is unchanged.
 *
 * 2. NO MODEL CALL FOR A POST THAT CANNOT BE SENT. A club with attendance
 *    off (ratings only) had every chase's opening line written by the model
 *    and then dropped by the feature gate: 15 calls in the replayed week,
 *    none sent. The gate is read before the composer now.
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

vi.mock("@/lib/db", () => ({
  db: new Proxy(
    {},
    {
      get: (_t, model: string) =>
        new Proxy(
          {},
          {
            get: (_t2, method: string) => overrides[model]?.[method] ?? defaultFor(method),
          },
        ),
    },
  ),
}));

const features: Record<string, unknown> = {};
function resetFeatures() {
  for (const k of Object.keys(features)) delete features[k];
  Object.assign(features, {
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
    squadMode: "weekly",
  });
}
vi.mock("@/lib/org-features", () => ({ getOrgFeatures: async () => ({ ...features }) }));

const composeChaseText = vi.fn(async () => "MODEL TEXT");
vi.mock("@/lib/message-analyzer", () => ({
  composeChaseText: (...a: unknown[]) => composeChaseText(...(a as [])),
}));

const graphics = vi.hoisted(() => ({ sendGraphicToAdminChannel: vi.fn(async () => ({ queued: true, jobId: "g" })) }));
vi.mock("@/lib/admin-group-graphics", () => graphics);
// The "Teams ready" hook (team-proposal.ts) has its own tests.
vi.mock("@/lib/team-proposal", () => ({ teamProposalJobs: async () => 0 }));
// The badges post's own rules are tested in badge-announcements.test.ts;
// here only where it goes. Empty unless a test sets it.
const badges = vi.hoisted(() => ({ posts: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/badge-announcement-scheduler", async (orig) => ({
  ...(await orig<object>()),
  computeBadgeAnnouncements: async () => badges.posts.map((p) => ({ ...p })),
}));

// Who was left out after a cancelled week (2026-10-24): its own tests
// are in rolling-squad.test.ts; here only that the post names them.
const leftOutMock = vi.hoisted(() => ({ names: [] as string[] }));
vi.mock("@/lib/rolling-squad", () => ({
  loadRollingLeftOut: async () => leftOutMock.names.map((name, i) => ({ userId: `lo${i}`, name })),
  rollingSeedPendingAt: async () => null,
}));

import { computeDuePosts, type DueInstruction } from "@/lib/bot-scheduler";
import { buildOrganiserListUpdate } from "@/lib/organisers-list-copy";

const GROUP = "group-fnf@g.us";
const ADMIN_GROUP = "admins-fnf@g.us";
const ORG = { id: "org-fnf", whatsappGroupId: GROUP, whatsappBotEnabled: true };

/** Fri 9 Oct 2026, 20:30 London (19:30 UTC, BST). */
const KICKOFF = new Date("2026-10-09T19:30:00.000Z");
const SIGNUP_DEADLINE = new Date("2026-10-09T14:30:00.000Z");
const MON_1005 = new Date("2026-10-05T09:05:00.000Z");
const MON_1705 = new Date("2026-10-05T16:05:00.000Z");
const MON_1805 = new Date("2026-10-05T17:05:00.000Z");
const TUE_2005 = new Date("2026-10-06T19:05:00.000Z");
const FRI_0805 = new Date("2026-10-09T07:05:00.000Z");
const FRI_1700 = new Date("2026-10-09T16:00:00.000Z");
const FRI_1705 = new Date("2026-10-09T16:05:00.000Z");
const FRI_1830 = new Date("2026-10-09T17:30:00.000Z");

const FNF_DEADLINES = {
  dropOutDeadlineDay: 1,
  dropOutDeadlineTime: "21:00",
  listPublishDay: 2,
  listPublishTime: "20:00",
};
const NO_DEADLINES = {
  dropOutDeadlineDay: null,
  dropOutDeadlineTime: null,
  listPublishDay: null,
  listPublishTime: null,
};

const NAMES = ["Hamzah", "Raihan", "Wasim", "Kemal"];

function player(name: string, i: number, status = "CONFIRMED") {
  return {
    id: `att-${i}`,
    userId: `u${i}`,
    status,
    position: i + 1,
    paidAt: null,
    directPendingAt: null,
    user: { id: `u${i}`, name, phoneNumber: `+44770090000${i}` },
  };
}

function match(club: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    id: "m-fri-9-oct",
    date: KICKOFF,
    status: "UPCOMING",
    maxPlayers: 18,
    isHistorical: false,
    activityId: "fri-9",
    attendanceDeadline: SIGNUP_DEADLINE,
    rollingSeededAt: null as Date | null,
    rollingSeededFromMatchId: null as string | null,
    postMatchEndFlow: true,
    attendances: NAMES.map((n, i) => player(n, i)) as ReturnType<typeof player>[],
    teamAssignments: [] as unknown[],
    benchConfirmations: [] as unknown[],
    benchSlotOffers: [] as unknown[],
    paymentCredits: [] as unknown[],
    activity: {
      id: "fri-9",
      orgId: ORG.id,
      name: "FNF",
      venue: "Powerleague",
      dayOfWeek: 5,
      matchDurationMins: 60,
      sportId: "s9",
      sport: { name: "Football 9-a-side", playersPerTeam: 9, teamLabels: null, mvpLabel: "MoM" },
      org: {
        paymentCollectionEnabled: false,
        paymentHolderId: null,
        paymentTrackingEnabled: false,
        teamLabels: null,
        language: "en",
        ...club,
      },
    },
    ...over,
  };
}

const OWNER = { id: "admin-owner", name: "Owner", phoneNumber: "+447700111111", role: "OWNER" };
const ADMIN2 = { id: "admin-two", name: "Second", phoneNumber: "+447700222222", role: "ADMIN" };

function setWorld(
  ms: ReturnType<typeof match>[],
  opts: { sent?: string[]; carried?: number; channelMode?: string; adminGroupId?: string | null } = {},
) {
  for (const k of Object.keys(overrides)) delete overrides[k];
  overrides.organisation = {
    findFirst: async () => ORG,
    findUnique: async () => ({
      id: ORG.id,
      name: "FNF",
      language: "en",
      adminChannelMode: opts.channelMode ?? "admin-group",
      adminChannelUserId: null,
      adminGroupId: opts.adminGroupId === undefined ? ADMIN_GROUP : opts.adminGroupId,
    }),
  };
  overrides.membership = {
    findMany: async (args: unknown) => {
      const where = (args as { where?: { role?: unknown } }).where;
      if (!where?.role) return [];
      return [OWNER, ADMIN2].map((a) => ({ role: a.role, user: { id: a.id, name: a.name, phoneNumber: a.phoneNumber } }));
    },
  };
  overrides.match = { findMany: async () => ms };
  overrides.sentNotification = {
    findMany: async (args: unknown) =>
      (args as { where?: { kind?: unknown; key?: unknown } }).where?.kind ||
      (args as { where?: { key?: unknown } }).where?.key
        ? []
        : (opts.sent ?? []).map((key) => ({ key })),
    findFirst: async () => null,
  };
  overrides.attendanceEvent = { count: async () => opts.carried ?? 0 };
  overrides.activity = { count: async () => 0, findMany: async () => [] };
  // The club has played and been rated before, so the one-off
  // seed-rating nudge (seed-nudge.ts, its own tests) is not due here.
  overrides.rating = { findFirst: async () => ({ id: "r-earlier" }) };
}

const GROUP_CAPS = { adminGroup: true };

async function instructions(now: Date, caps = GROUP_CAPS): Promise<DueInstruction[]> {
  const res = await computeDuePosts(GROUP, now, caps);
  return res?.instructions ?? [];
}

const groupPosts = (out: DueInstruction[]) => out.filter((i) => i.kind === "group-message");
const adminPosts = (out: DueInstruction[]) =>
  out.filter((i): i is Extract<DueInstruction, { kind: "admin-group-message" }> => i.kind === "admin-group-message");
const byKey = (out: DueInstruction[], key: string) => out.find((i) => i.key === key) as (DueInstruction & { text?: string }) | undefined;


const ADMIN_TEXT = (names: string[]) =>
  buildOrganiserListUpdate({
    reason: "chase",
    activityName: "FNF",
    whenLabel: "Fri 9 Oct at 20:30",
    confirmed: names.map((name) => ({ name })),
    bench: [],
    maxPlayers: 18,
    lang: "en",
  });

const SHORT_LINE = "Kickoff is getting close and the squad is still short.";
const squadOf = (n: number) => Array.from({ length: n }, (_, i) => `Player ${i + 1}`);

/** FNF's Friday game with `n` confirmed, 18 places and this minimum. */
function fnfGame(n: number, minPlayers: number | null) {
  const m = match(NO_DEADLINES, { attendances: squadOf(n).map((name, i) => player(name, i)) });
  m.activity = { ...m.activity, minPlayers } as typeof m.activity;
  return m;
}

const hqShort = (out: DueInstruction[]) =>
  out.filter((i) => "text" in i && String((i as { text?: string }).text).includes(SHORT_LINE));

beforeEach(() => {
  resetFeatures();
  composeChaseText.mockClear();
  badges.posts = [];
});

describe("1. at or above the game's minimum, HQ is never told the squad is short", () => {
  beforeEach(() => {
    features.listAnnouncer = "organisers";
  });

  it("minimum 12, 12 of 18, the 3h chase: no 'still short' notice to the admins", async () => {
    const m = fnfGame(12, 12);
    setWorld([m]);
    const out = await instructions(FRI_1700);
    expect(byKey(out, `${m.id}:chase-pre-kickoff`)).toBeUndefined();
    expect(hqShort(out)).toEqual([]);
  });

  it("minimum 12, 12 of 18, the 2h last call: no 'still short' notice", async () => {
    const m = fnfGame(12, 12);
    setWorld([m]);
    const out = await instructions(FRI_1830);
    expect(byKey(out, `${m.id}:pre-kickoff`)).toBeUndefined();
    expect(hqShort(out)).toEqual([]);
  });

  it("minimum 12, 15 of 18, the 08:00 chase by DM: no 'still short' DM to any admin", async () => {
    const m = fnfGame(15, 12);
    setWorld([m], { channelMode: "each-admin", adminGroupId: null });
    const out = await instructions(FRI_0805);
    expect(out.filter((i) => i.key.includes("chase-match-day-morning"))).toEqual([]);
    expect(hqShort(out)).toEqual([]);
  });

  it("minimum 12, 11 of 18: below the minimum, the 3h chase still goes to the admins", async () => {
    const m = fnfGame(11, 12);
    setWorld([m]);
    const out = await instructions(FRI_1700);
    expect(byKey(out, `${m.id}:chase-pre-kickoff`)?.kind).toBe("admin-group-message");
    expect(byKey(out, `${m.id}:chase-pre-kickoff`)?.text).toBe(ADMIN_TEXT(squadOf(11)));
  });

  it("minimum 12, 11 of 18: the 2h last call and the 08:00 DMs still go", async () => {
    const m = fnfGame(11, 12);
    setWorld([m]);
    expect(byKey(await instructions(FRI_1830), `${m.id}:pre-kickoff`)?.kind).toBe("admin-group-message");
    setWorld([m], { channelMode: "each-admin", adminGroupId: null });
    const dms = (await instructions(FRI_0805)).filter((i) => i.key.includes("chase-match-day-morning"));
    expect(dms).toHaveLength(2);
  });

  it("REGRESSION GUARD: no minimum set, 17 of 18 on a 9-a-side: the notice goes, as before", async () => {
    const m = fnfGame(17, null);
    setWorld([m]);
    const out = await instructions(FRI_1700);
    expect(byKey(out, `${m.id}:chase-pre-kickoff`)?.text).toBe(ADMIN_TEXT(squadOf(17)));
  });

  it("REGRESSION GUARD: a full squad gets no chase notice", async () => {
    const m = fnfGame(18, 12);
    setWorld([m]);
    expect(byKey(await instructions(FRI_1700), `${m.id}:chase-pre-kickoff`)).toBeUndefined();
  });
});

describe("1b. the players' chase for the open places is unchanged", () => {
  beforeEach(() => {
    features.listAnnouncer = "matchtime";
  });

  it("MatchTime announces, minimum 12, 12 of 18: the 3h chase still asks the players' group", async () => {
    const m = fnfGame(12, 12);
    setWorld([m]);
    const out = await instructions(FRI_1700);
    expect(byKey(out, `${m.id}:chase-pre-kickoff`)?.kind).toBe("group-message");
  });

  it("MatchTime announces, minimum 12, 12 of 18: the 2h last call still goes to the players' group", async () => {
    const m = fnfGame(12, 12);
    setWorld([m]);
    const out = await instructions(FRI_1830);
    expect(byKey(out, `${m.id}:pre-kickoff`)?.kind).toBe("group-message");
  });
});

describe("2. no model call for a chase the feature gate drops", () => {
  const TIMES: Array<[string, Date, string]> = [
    ["the 17:00 daily post", MON_1705, "evening-update:2026-10-05"],
    ["the 08:00 match-day chase", FRI_0805, "chase-match-day-morning:2026-10-09"],
    ["the 3h chase", FRI_1700, "chase-pre-kickoff"],
    ["the 2h last call", FRI_1830, "pre-kickoff"],
  ];

  for (const [label, now, suffix] of TIMES) {
    it(`attendance off: ${label} makes no model call and sends nothing`, async () => {
      features.attendance = false;
      const m = fnfGame(0, null);
      setWorld([m]);
      const out = await instructions(now);
      expect(composeChaseText).not.toHaveBeenCalled();
      expect(byKey(out, `${m.id}:${suffix}`)).toBeUndefined();
    });

    it(`REGRESSION GUARD: attendance on, ${label} is composed and sent as before`, async () => {
      const m = fnfGame(4, null);
      setWorld([m]);
      const out = await instructions(now);
      expect(composeChaseText).toHaveBeenCalledTimes(1);
      const post = byKey(out, `${m.id}:${suffix}`);
      expect(post?.kind).toBe("group-message");
      expect(post?.text).toContain("MODEL TEXT");
    });
  }
});
