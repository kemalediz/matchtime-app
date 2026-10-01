/**
 * The standalone unpaid reminder in the group for weekly-deadline clubs
 * (2026-10-01, decided by Kemal). D4 turned the daily 17:00 post off
 * except on match day for a club with both weekly deadlines, and the
 * unpaid tail only ever rode on that post (never on match day or the day
 * before), so those groups lost their "please pay" nudge entirely.
 *
 *   - the existing tail text, ON ITS OWN, once, key `<matchId>:unpaid-group`;
 *   - 10:00 London two days after a COMPLETED match, payment tracking on,
 *     the group tail's unpaid rule (holder out, credits off, no-signal);
 *   - only where `hasWeeklyRhythm` is true: a club without both settings
 *     (Sutton FC) gets nothing new and keeps its tail on the 17:00 post.
 *
 * Driven through the real `computeDuePosts` with Prisma mocked (the proxy
 * pattern of weekly-deadlines-scheduler.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// A completed match also gets its rating DMs, which sign magic links.
process.env.AUTH_SECRET ??= "test-secret-for-magic-links";

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

const features = {
  botEnabled: true,
  attendance: true,
  bench: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  reminders: true,
  statsQa: true,
  paymentTracking: true,
  paymentCollection: false,
  squadFromList: false,
  language: "en",
  rollingSquad: false,
};
vi.mock("@/lib/org-features", () => ({ getOrgFeatures: async () => ({ ...features }) }));

const composeChaseText = vi.fn(async () => "MODEL TEXT");
vi.mock("@/lib/message-analyzer", () => ({
  composeChaseText: (...a: unknown[]) => composeChaseText(...(a as [])),
}));

import { computeDuePosts } from "@/lib/bot-scheduler";
import { buildUnpaidGroupReminder, buildUnpaidTailText } from "@/lib/scheduler-copy";

const GROUP = "group-fnf@g.us";
const ORG = { id: "org-fnf", whatsappGroupId: GROUP, whatsappBotEnabled: true };

/** Fri 9 Oct 2026, 20:30 London (19:30 UTC, BST). */
const KICKOFF = new Date("2026-10-09T19:30:00.000Z");
/** The match's own sign-up deadline (kickoff minus 5h). */
const SIGNUP_DEADLINE = new Date("2026-10-09T14:30:00.000Z");
const MON_1759 = new Date("2026-10-05T16:59:00.000Z");
const MON_1805 = new Date("2026-10-05T17:05:00.000Z");
const MON_1705 = new Date("2026-10-05T16:05:00.000Z");
const TUE_1955 = new Date("2026-10-06T18:55:00.000Z");
const TUE_2005 = new Date("2026-10-06T19:05:00.000Z");
const FRI_1705 = new Date("2026-10-09T16:05:00.000Z");

const HAMZAH_CLUB = {
  dropOutDeadlineDay: 1,
  dropOutDeadlineTime: "21:00",
  listPublishDay: 2,
  listPublishTime: "20:00",
};
const SUTTON_CLUB = {
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
    attendances: NAMES.map((n, i) => player(n, i)),
    teamAssignments: [] as unknown[],
    benchConfirmations: [] as unknown[],
    benchSlotOffers: [] as unknown[],
    activity: {
      id: "fri-9",
      orgId: ORG.id,
      name: "Friday 9-a-side",
      venue: "Powerleague",
      dayOfWeek: 5,
      matchDurationMins: 60,
      sport: { name: "Football 9-a-side", playersPerTeam: 9, teamLabels: null },
      org: {
        paymentCollectionEnabled: false,
        paymentHolderId: null as string | null,
        paymentTrackingEnabled: true,
        teamLabels: null,
        language: "en",
        ...club,
      },
    },
    ...over,
  };
}

function setWorld(ms: ReturnType<typeof match>[], opts: { sent?: string[]; carried?: number } = {}) {
  for (const k of Object.keys(overrides)) delete overrides[k];
  overrides.organisation = { findFirst: async () => ORG };
  overrides.match = { findMany: async () => ms };
  overrides.sentNotification = {
    findMany: async (args: unknown) =>
      (args as { where?: { kind?: string } }).where?.kind ? [] : (opts.sent ?? []).map((key) => ({ key })),
  };
  overrides.attendanceEvent = { count: async () => opts.carried ?? 0 };
  overrides.activity = { count: async () => 0 };
}

async function instructions(now: Date) {
  const res = await computeDuePosts(GROUP, now);
  return res?.instructions ?? [];
}

const text = (out: { key: string }[], key: string) => (out.find((i) => i.key === key) as { text?: string } | undefined)?.text;


const KEY = "m-fri-9-oct:unpaid-group";
const PAID = new Date("2026-10-09T21:00:00.000Z");
/** Sun 11 Oct 2026, London BST. */
const SUN_0955 = new Date("2026-10-11T08:55:00.000Z");
const SUN_1005 = new Date("2026-10-11T09:05:00.000Z");
const SAT_1005 = new Date("2026-10-10T09:05:00.000Z");

function completed(club: Record<string, unknown>, paid: number[] = [1, 2], over: Record<string, unknown> = {}) {
  return match(club, {
    status: "COMPLETED",
    postMatchEndFlow: true,
    paymentCredits: [] as Array<{ count: number }>,
    attendances: NAMES.map((n, i) => ({ ...player(n, i), paidAt: paid.includes(i) ? PAID : null })),
    ...over,
  });
}

beforeEach(() => {
  features.paymentTracking = true;
  features.rollingSquad = false;
  features.attendance = true;
});

describe("the standalone unpaid reminder in the group (weekly-deadline clubs)", () => {
  it("10:05 two days after: the tail text on its own, once, as a group message", async () => {
    setWorld([completed(HAMZAH_CLUB)]);
    const out = await instructions(SUN_1005);
    const mine = out.filter((i) => i.key === KEY);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: "group-message", matchId: "m-fri-9-oct" });
    expect(text(out, KEY)).toBe(
      "💳 *2* payments still pending for Friday's match. If you've already paid, tick your team in the payment poll to clear it 🙏",
    );
    expect(text(out, KEY)).toBe(buildUnpaidGroupReminder({ unpaid: 2, dayName: "Friday", lang: "en" }));
    // Its own words, not the 17:00 tail's ("last week's match", "the poll above").
    expect(text(out, KEY)).not.toBe(buildUnpaidTailText(2, "en"));
    expect(text(out, KEY)).not.toMatch(/[\u2013\u2014]/);
  });

  it("not before 10:00, not the day before, not once sent", async () => {
    setWorld([completed(HAMZAH_CLUB)]);
    expect((await instructions(SUN_0955)).some((i) => i.key === KEY)).toBe(false);
    expect((await instructions(SAT_1005)).some((i) => i.key === KEY)).toBe(false);
    setWorld([completed(HAMZAH_CLUB)], { sent: [KEY] });
    expect((await instructions(SUN_1005)).some((i) => i.key === KEY)).toBe(false);
  });

  it("Sutton FC's shape (no weekly deadlines) gets nothing new", async () => {
    setWorld([completed(SUTTON_CLUB)]);
    expect((await instructions(SUN_1005)).some((i) => i.key.endsWith(":unpaid-group"))).toBe(false);
  });

  it("only one of the two settings is not a weekly rhythm: nothing", async () => {
    setWorld([completed({ ...HAMZAH_CLUB, listPublishDay: null, listPublishTime: null })]);
    expect((await instructions(SUN_1005)).some((i) => i.key === KEY)).toBe(false);
  });

  it("the payment holder is left out and credits come off, exactly as the 17:00 tail", async () => {
    // u0 is the holder and unpaid; u1, u2 paid; u3 unpaid; one bulk credit.
    setWorld([
      completed(
        { ...HAMZAH_CLUB, paymentHolderId: "u0" },
        [1, 2],
        { paymentCredits: [{ count: 1 }] },
      ),
    ]);
    expect((await instructions(SUN_1005)).some((i) => i.key === KEY)).toBe(false);
    setWorld([completed({ ...HAMZAH_CLUB, paymentHolderId: "u0" }, [1, 2])]);
    expect(text(await instructions(SUN_1005), KEY)).toBe(
      "💳 1 payment still pending for Friday's match. If you've already paid, tick your team in the payment poll to clear it 🙏",
    );
  });

  it("no signal (nobody ticked, no credit): nothing", async () => {
    setWorld([completed(HAMZAH_CLUB, [])]);
    expect((await instructions(SUN_1005)).some((i) => i.key === KEY)).toBe(false);
  });

  it("everyone paid: nothing", async () => {
    setWorld([completed(HAMZAH_CLUB, [0, 1, 2, 3])]);
    expect((await instructions(SUN_1005)).some((i) => i.key === KEY)).toBe(false);
  });

  it("payment tracking off: nothing", async () => {
    features.paymentTracking = false;
    setWorld([completed({ ...HAMZAH_CLUB, paymentTrackingEnabled: false })]);
    expect((await instructions(SUN_1005)).some((i) => i.key === KEY)).toBe(false);
  });

  it("a match that is not COMPLETED, or whose post-match flow is off: nothing", async () => {
    setWorld([completed(HAMZAH_CLUB, [1, 2], { status: "TEAMS_PUBLISHED" })]);
    expect((await instructions(SUN_1005)).some((i) => i.key === KEY)).toBe(false);
    setWorld([completed(HAMZAH_CLUB, [1, 2], { postMatchEndFlow: false })]);
    expect((await instructions(SUN_1005)).some((i) => i.key === KEY)).toBe(false);
  });

  it("Turkish club: the Turkish tail", async () => {
    setWorld([completed({ ...HAMZAH_CLUB, language: "tr" })]);
    expect(text(await instructions(SUN_1005), KEY)).toBe(
      buildUnpaidGroupReminder({ unpaid: 2, dayName: "Cuma", lang: "tr" }),
    );
    expect(text(await instructions(SUN_1005), KEY)).toContain("Cuma günkü maç için *2* ödeme");
  });
});
