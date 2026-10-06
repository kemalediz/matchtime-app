/**
 * Monthly squad, slice 5, in the scheduler
 * (MDs/monthly-squad-plan-2026-10-05.md, 5.3, 5.4 and 5.6), driven through
 * the real `computeDuePosts` with Prisma mocked (the proxy pattern of
 * rolling-squad-scheduler.test.ts).
 *
 * TWO HALVES, and the first is the one that protects a live club:
 *
 *   WEEKLY  a club on "weekly" (Sutton FC's shape) reads no month, and
 *           every branch slice 5 touched still does what it did: the
 *           17:00 post, the composed chase, the payment poll, the fee
 *           question with the whole squad as headcount, the pay chase to
 *           everyone unpaid, and no PAYG offer for a drop with no bench.
 *   MONTHLY the list post and its limits, no 17:00 roster, no composer,
 *           no payment poll, no pay link chase for a regular, the PAYG
 *           pool offer, and the PAYG fee to confirm.
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
  paymentTracking: true,
  paymentCollection: true,
  squadFromList: false,
  language: "en",
  rollingSquad: false,
  benchPickMode: "first-come",
  badgeAnnouncements: false,
};
vi.mock("@/lib/org-features", () => ({ getOrgFeatures: async () => ({ ...features }) }));

const composeChaseText = vi.fn(async () => "MODEL TEXT");
vi.mock("@/lib/message-analyzer", () => ({
  composeChaseText: (...a: unknown[]) => composeChaseText(...(a as [])),
}));
vi.mock("@/lib/short-link", () => ({ buildShortMagicLinkUrl: async () => "https://mt.test/l/abc" }));
vi.mock("@/lib/magic-link", () => ({
  signMagicLinkToken: () => "token",
  MAGIC_LINK_TTL: { bookmark: 1, actionNudge: 1 },
}));

import { computeDuePosts } from "@/lib/bot-scheduler";
import { buildWeekList, weekListHash, type WeekMember } from "@/lib/monthly-week-rules";
import { buildPaygPoolDm, buildPaygPoolGroupPost, buildWeekListPost } from "@/lib/monthly-week-copy";
import { buildFeeAskDm, buildFeeConfirmPrompt } from "@/lib/dm-copy";

const GROUP = "group-vets@g.us";
const ORG = { id: "org-vets", whatsappGroupId: GROUP, whatsappBotEnabled: true, paygPricePence: 800 };

/** Mon 12 Oct 2026, 20:00 London (19:00 UTC, BST). */
const KICKOFF = new Date("2026-10-12T19:00:00.000Z");
const MONTH_CREATED = new Date("2026-10-06T09:00:00.000Z");
const SEEDED_AT = new Date("2026-10-06T09:05:00.000Z");
/** Thu 8 Oct 2026, 10:00 London. */
const THU_10AM = new Date("2026-10-08T09:00:00.000Z");
/** Thu 8 Oct 2026, 17:05 London. */
const THU_5PM = new Date("2026-10-08T16:05:00.000Z");
/** Mon 12 Oct 2026, 21:30 London: after the final whistle. */
const AFTER_MATCH = new Date("2026-10-12T20:30:00.000Z");

const REGULARS = ["Alex", "Bilal", "Chris", "Dave"];

function att(name: string, i: number, over: Record<string, unknown> = {}) {
  return {
    id: `att-${name}`,
    userId: `u-${name.toLowerCase()}`,
    status: "CONFIRMED",
    position: i + 1,
    paidAt: null,
    directPendingAt: null,
    paymentMethod: "monthly" as string | null,
    user: { id: `u-${name.toLowerCase()}`, name, phoneNumber: `+44770090010${i}` },
    ...over,
  };
}

function match(over: Record<string, unknown> = {}) {
  return {
    id: "m-mon-12-oct",
    date: KICKOFF,
    status: "UPCOMING",
    maxPlayers: 6,
    isHistorical: false,
    activityId: "mon-7",
    attendanceDeadline: new Date(KICKOFF.getTime() - 5 * 60 * 60 * 1000),
    rollingSeededAt: SEEDED_AT,
    rollingSeededFromMatchId: null,
    postMatchEndFlow: true,
    feePerPlayer: null as number | null,
    feePendingConfirm: null as number | null,
    paymentLinksReleasedAt: null as Date | null,
    redScore: null,
    yellowScore: null,
    attendances: REGULARS.map((n, i) => att(n, i)),
    teamAssignments: [] as unknown[],
    benchConfirmations: [] as unknown[],
    benchSlotOffers: [] as Array<{ id: string; replacingUserId: string | null; createdAt: Date }>,
    paymentCredits: [] as unknown[],
    activity: {
      id: "mon-7",
      orgId: ORG.id,
      name: "Monday 7-a-side",
      venue: "Goals",
      dayOfWeek: 1,
      matchDurationMins: 60,
      sport: { name: "Basketball", playersPerTeam: 3, teamLabels: null },
      org: {
        paymentCollectionEnabled: true,
        paymentHolderId: "u-sam",
        paymentTrackingEnabled: true,
        teamLabels: null,
        language: "en",
      },
    },
    ...over,
  };
}

const MEMBERS: WeekMember[] = REGULARS.map((name, i) => ({
  userId: `u-${name.toLowerCase()}`,
  name,
  kind: "regular",
  slot: i + 1,
  paid: i === 2 ? "none" : "claimed",
  absent: false,
  paygDated: false,
}));

function monthRow() {
  return {
    id: "month-oct",
    monthStart: new Date("2026-10-01T00:00:00.000Z"),
    createdAt: MONTH_CREATED,
    startedMidMonthAt: monthStartedAt,
    activity: { orgId: ORG.id, venue: "Goals", dayOfWeek: 1 },
    members: MEMBERS.map((m) => ({
      userId: m.userId,
      kind: m.kind,
      slot: m.slot,
      paidAt: null,
      paidClaimedAt: m.paid === "claimed" ? MONTH_CREATED : null,
      absentMatchIds: [],
      paygMatchIds: [],
      user: { name: m.name },
    })),
  };
}

/** When the organiser started the month here (null: MatchTime opened it). */
let monthStartedAt: Date | null = null;

/** Regulars who have left the group. */
const left = new Set<string>();

interface Shown {
  key: string;
  kind: string;
  createdAt: Date;
}

const monthReads = vi.fn();
const signupReads = vi.fn();
const opsAlerts: Array<Record<string, unknown>> = [];

function setWorld(
  m: ReturnType<typeof match>,
  opts: {
    monthly: boolean;
    sent?: string[];
    shown?: Shown[];
    pool?: Array<{ userId: string; name: string; phone: string | null }>;
    paygPricePence?: number | null;
    monthsThrow?: boolean;
    /** Pool group lines already sent for the match. */
    poolLines?: Date[];
    /** The first fee question's row, as the ack left it. */
    feeAsk?: { waMessageId: string | null; createdAt: Date } | null;
    /** A month of the club still in sign-up (slice 3). */
    signupMonth?: Record<string, unknown>;
    /** A month of the club with a price (slice 4). */
    pricedMonth?: Record<string, unknown>;
  },
) {
  for (const k of Object.keys(overrides)) delete overrides[k];
  features.squadMode = opts.monthly ? "monthly" : undefined;
  monthReads.mockClear();
  signupReads.mockClear();
  overrides.organisation = {
    findFirst: async () => ({ ...ORG, paygPricePence: opts.paygPricePence === undefined ? 800 : opts.paygPricePence }),
  };
  overrides.opsAlert = {
    findFirst: async () => null,
    create: async (a: unknown) => {
      opsAlerts.push((a as { data: Record<string, unknown> }).data);
      return {};
    },
  };
  overrides.match = { findMany: async () => [m] };
  overrides.squadMonth = {
    findMany: async (args: unknown) => {
      // Slices 3 and 4 read the club's live months (`status: { in: [...] }`)
      // ONCE per poll, for a monthly club only. The month in this world is
      // a running one, read by the weekly flow (`status: "running"`).
      const status = (args as { where?: { status?: unknown } }).where?.status;
      if (status && typeof status === "object") {
        signupReads();
        return [opts.signupMonth, opts.pricedMonth].filter(Boolean);
      }
      monthReads();
      if (opts.monthsThrow) throw new Error("the database hiccuped");
      return [monthRow()];
    },
  };
  overrides.sentNotification = {
    findMany: async (args: unknown) => {
      const where = (args as { where?: { kind?: string; key?: { startsWith?: string } } }).where ?? {};
      if (where.key?.startsWith?.includes("payg-pool-line")) {
        return [...(opts.poolLines ?? [])].sort((a, b) => b.getTime() - a.getTime()).map((createdAt) => ({ createdAt }));
      }
      if (where.key?.startsWith) {
        return [...(opts.shown ?? [])].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }
      if (where.kind) return [];
      return (opts.sent ?? []).map((key) => ({ key }));
    },
    findUnique: async () => opts.feeAsk ?? null,
  };
  overrides.membership = {
    findMany: async (args: unknown) => {
      const where = (args as { where?: { userId?: { in: string[] } } }).where ?? {};
      if (!where.userId) return [];
      const pool = (opts.pool ?? [])
        .filter((p) => where.userId!.in.includes(p.userId))
        .map((p) => ({
          userId: p.userId,
          leftAt: null,
          subMatchInviteDm: true,
          user: { name: p.name, phoneNumber: p.phone, isActive: true },
        }));
      // The month's members who are still in the group (everyone but `left`).
      const regulars = MEMBERS.filter((mm) => where.userId!.in.includes(mm.userId) && !left.has(mm.userId)).map((mm) => ({ userId: mm.userId }));
      return [...pool, ...regulars];
    },
  };
  overrides.attendance = {
    // The PAYG pool's "played per game lately" read.
    findMany: async () => (opts.pool ?? []).map((p) => ({ userId: p.userId })),
  };
  overrides.user = { findUnique: async () => ({ name: "Sam Collector", phoneNumber: "+447700900999" }) };
  overrides.activity = { count: async () => 0 };
}

async function instructions(now: Date) {
  const res = await computeDuePosts(GROUP, now);
  return res?.instructions ?? [];
}

function listText(m: ReturnType<typeof match>): string {
  return buildWeekListPost({
    list: buildWeekList({
      members: MEMBERS,
      rows: m.attendances.map((a) => ({
        userId: a.userId,
        name: a.user.name,
        status: a.status as "CONFIRMED" | "BENCH" | "DROPPED",
        position: a.position,
      })),
      maxPlayers: m.maxPlayers,
    }),
    matchDate: m.date,
    paygPricePence: 800,
    lang: "en",
  });
}

beforeEach(() => {
  composeChaseText.mockClear();
  left.clear();
  opsAlerts.length = 0;
  monthStartedAt = null;
});

describe("WEEKLY: a club on weekly mode is untouched on every branch slice 5 changed", () => {
  const weekly = (over: Record<string, unknown> = {}) =>
    match({ attendances: REGULARS.map((n, i) => att(n, i, { paymentMethod: null })), rollingSeededAt: null, ...over });

  it("reads no month, and posts no list", async () => {
    setWorld(weekly(), { monthly: false });
    const out = await instructions(THU_10AM);
    expect(monthReads).not.toHaveBeenCalled();
    expect(out.some((i) => i.key.includes("month-list"))).toBe(false);
  });

  it("the 17:00 post still goes out, composed by the model as before", async () => {
    const m = weekly();
    setWorld(m, { monthly: false });
    const out = await instructions(THU_5PM);
    const evening = out.filter((i) => i.key.startsWith(`${m.id}:evening-update:`));
    expect(evening).toHaveLength(1);
    expect((evening[0] as { text: string }).text).toBe("MODEL TEXT");
    expect(composeChaseText).toHaveBeenCalledTimes(1);
  });

  it("the payment poll still goes out when the match ends", async () => {
    const m = weekly();
    setWorld(m, { monthly: false });
    expect((await instructions(AFTER_MATCH)).some((i) => i.key === `${m.id}:payment-poll`)).toBe(true);
  });

  it("the collector is still asked 'how much?', with the whole squad as headcount", async () => {
    const m = weekly();
    setWorld(m, { monthly: false });
    const ask = (await instructions(AFTER_MATCH)).find((i) => i.key === `${m.id}:fee-ask`) as { text: string };
    expect(ask.text).toBe(
      buildFeeAskDm({ collectorName: "Sam Collector", activityName: "Monday 7-a-side", headcount: 4, lang: "en" }),
    );
  });

  it("the daily pay chase still goes to everyone unpaid", async () => {
    const m = weekly({
      status: "COMPLETED",
      feePerPlayer: 8,
      paymentLinksReleasedAt: new Date("2026-10-12T21:00:00.000Z"),
    });
    setWorld(m, { monthly: false });
    // Tue 13 Oct, 18:05 London.
    const out = await instructions(new Date("2026-10-13T17:05:00.000Z"));
    expect(out.filter((i) => i.key.includes(":pay-chase:")).map((i) => (i as { targetUser: string }).targetUser)).toEqual([
      "u-alex",
      "u-bilal",
      "u-chris",
      "u-dave",
    ]);
  });

  it("an open offer with nobody on the bench posts nothing, as before (the chase covers it)", async () => {
    const m = weekly({ benchSlotOffers: [{ id: "o1", replacingUserId: "u-bilal" }] });
    setWorld(m, { monthly: false, pool: [{ userId: "u-omar", name: "Omar Khan", phone: "+447700900201" }] });
    expect((await instructions(THU_10AM)).some((i) => i.key.startsWith("offer-"))).toBe(false);
  });

  it("a monthly club's match with NO running month behaves as weekly too", async () => {
    // The month is for a Monday fixture at "Goals"; this match is elsewhere.
    const m = weekly();
    m.activity.venue = "Powerleague";
    setWorld(m, { monthly: true });
    const out = await instructions(THU_5PM);
    expect(out.some((i) => i.key.includes("month-list"))).toBe(false);
    expect(out.some((i) => i.key.startsWith(`${m.id}:evening-update:`))).toBe(true);
  });
});

describe("MONTHLY: the list post (plan 5.4)", () => {
  it("is posted once the regulars are on the match, in the group's format, keyed by its hash", async () => {
    const m = match();
    setWorld(m, { monthly: true });
    const out = await instructions(THU_10AM);
    const posts = out.filter((i) => i.key.startsWith(`${m.id}:month-list:`));
    expect(posts).toHaveLength(1);
    const text = listText(m);
    expect(posts[0]).toMatchObject({ kind: "group-message", matchId: m.id, key: `${m.id}:month-list:${weekListHash(text)}:0`, text });
    expect(text).toBe(
      [
        "📋 List for October: Mon 12 Oct, 20:00",
        "",
        "1. Alex (paid)",
        "2. Bilal (paid)",
        "3. Chris",
        "4. Dave (paid)",
        "5.",
        "6.",
        "",
        "2 places open, £8 PAYG: say *IN* to take one.",
      ].join("\n"),
    );
  });

  it("not before the regulars are on the match", async () => {
    const m = match({ rollingSeededAt: null });
    setWorld(m, { monthly: true });
    expect((await instructions(THU_10AM)).some((i) => i.key.includes("month-list"))).toBe(false);
  });

  it("not again while the group has already seen this list (a post, or a member's matching paste)", async () => {
    const m = match();
    const hash = weekListHash(listText(m));
    for (const kind of ["group-message", "month-list-seen"]) {
      setWorld(m, {
        monthly: true,
        shown: [{ key: `${m.id}:month-list:${hash}:0`, kind, createdAt: new Date("2026-10-07T09:00:00.000Z") }],
      });
      expect((await instructions(THU_10AM)).some((i) => i.key.includes("month-list"))).toBe(false);
    }
  });

  it("re-posted once when it changes, with the next number, and 'Paid but can't play'", async () => {
    const m = match();
    const before = weekListHash(listText(m));
    m.attendances[1].status = "DROPPED";
    setWorld(m, {
      monthly: true,
      shown: [{ key: `${m.id}:month-list:${before}:0`, kind: "group-message", createdAt: new Date("2026-10-07T09:00:00.000Z") }],
    });
    const posts = (await instructions(THU_10AM)).filter((i) => i.key.includes("month-list"));
    expect(posts).toHaveLength(1);
    expect(posts[0].key).toBe(`${m.id}:month-list:${weekListHash(listText(m))}:1`);
    expect((posts[0] as { text: string }).text).toContain("2.\n3. Chris");
    expect((posts[0] as { text: string }).text).toContain("Paid but can't play\n1. Bilal");
  });

  it("a list that returns to an earlier state is posted again", async () => {
    const m = match();
    const hash = weekListHash(listText(m));
    setWorld(m, {
      monthly: true,
      shown: [
        { key: `${m.id}:month-list:${hash}:0`, kind: "group-message", createdAt: new Date("2026-10-06T10:00:00.000Z") },
        { key: `${m.id}:month-list:someotherhash0000:1`, kind: "group-message", createdAt: new Date("2026-10-07T10:00:00.000Z") },
      ],
    });
    const posts = (await instructions(THU_10AM)).filter((i) => i.key.includes("month-list"));
    expect(posts.map((p) => p.key)).toEqual([`${m.id}:month-list:${hash}:2`]);
  });

  it("never within 30 minutes of the last list post; a member's paste does not start that clock", async () => {
    const m = match();
    const recent = new Date(THU_10AM.getTime() - 10 * 60 * 1000);
    setWorld(m, { monthly: true, shown: [{ key: `${m.id}:month-list:old0000000000000:0`, kind: "group-message", createdAt: recent }] });
    expect((await instructions(THU_10AM)).some((i) => i.key.includes("month-list"))).toBe(false);
    setWorld(m, { monthly: true, shown: [{ key: `${m.id}:month-list:old0000000000000:0`, kind: "month-list-seen", createdAt: recent }] });
    expect((await instructions(THU_10AM)).some((i) => i.key.includes("month-list"))).toBe(true);
  });

  it("never in quiet hours, and never once the teams are out", async () => {
    const m = match();
    setWorld(m, { monthly: true });
    // Thu 8 Oct, 22:30 London.
    expect((await instructions(new Date("2026-10-08T21:30:00.000Z"))).some((i) => i.key.includes("month-list"))).toBe(false);
    const withTeams = match({ teamAssignments: [{ userId: "u-alex", team: "RED", user: { id: "u-alex", name: "Alex" } }] });
    setWorld(withTeams, { monthly: true });
    expect((await instructions(THU_10AM)).some((i) => i.key.includes("month-list"))).toBe(false);
  });

  it("always once on match morning, even with nothing changed", async () => {
    const m = match();
    const hash = weekListHash(listText(m));
    setWorld(m, {
      monthly: true,
      shown: [{ key: `${m.id}:month-list:${hash}:0`, kind: "group-message", createdAt: new Date("2026-10-07T09:00:00.000Z") }],
    });
    // Mon 12 Oct, 08:30 London.
    const posts = (await instructions(new Date("2026-10-12T07:30:00.000Z"))).filter((i) => i.key.includes("month-list"));
    expect(posts.map((p) => p.key)).toEqual([`${m.id}:month-list:${hash}:1`]);
  });

  it("with the attendance feature off, no list", async () => {
    const m = match();
    setWorld(m, { monthly: true });
    features.attendance = false;
    try {
      expect((await instructions(THU_10AM)).some((i) => i.key.includes("month-list"))).toBe(false);
    } finally {
      features.attendance = true;
    }
  });
});

describe("MONTHLY: what a running month switches off (plan 5.4, 5.6)", () => {
  it("no 17:00 roster or chase, and the model is not asked", async () => {
    const m = match();
    setWorld(m, { monthly: true, shown: [{ key: `${m.id}:month-list:x:0`, kind: "group-message", createdAt: new Date(THU_5PM.getTime() - 60_000) }] });
    const out = await instructions(THU_5PM);
    expect(out.some((i) => i.key.startsWith(`${m.id}:evening-update:`))).toBe(false);
    expect(composeChaseText).not.toHaveBeenCalled();
  });

  it("no payment poll when the match ends", async () => {
    const m = match();
    setWorld(m, { monthly: true });
    expect((await instructions(AFTER_MATCH)).some((i) => i.key === `${m.id}:payment-poll`)).toBe(false);
  });

  it("no fee question when only regulars played", async () => {
    const m = match();
    setWorld(m, { monthly: true });
    expect((await instructions(AFTER_MATCH)).some((i) => i.key === `${m.id}:fee-ask`)).toBe(false);
  });

  it("with a PAYG player, the collector is asked to confirm the club's PAYG price for the PAYG players only", async () => {
    // Nothing is staged on the match yet: the amount is only staged once
    // this very question has been SENT (the ack), as the weekly flow only
    // stages an amount the collector has been shown.
    const m = match({ attendances: [...REGULARS.map((n, i) => att(n, i)), att("Omar", 4, { paymentMethod: null })] });
    expect(m.feePendingConfirm).toBeNull();
    setWorld(m, { monthly: true });
    const ask = (await instructions(AFTER_MATCH)).find((i) => i.key === `${m.id}:fee-ask`) as { text: string };
    expect(ask.text).toBe(buildFeeConfirmPrompt({ perPlayer: 8, headcount: 1, matchName: "Monday 7-a-side", wasTotal: false, lang: "en" }));
  });

  it("once the amount is staged (the question was sent), the collector is not asked again", async () => {
    const m = match({
      attendances: [...REGULARS.map((n, i) => att(n, i)), att("Omar", 4, { paymentMethod: null })],
      feePendingConfirm: 8,
    });
    setWorld(m, { monthly: true, sent: [`${m.id}:fee-ask`] });
    expect((await instructions(AFTER_MATCH)).some((i) => i.key === `${m.id}:fee-ask`)).toBe(false);
  });

  it("with a PAYG player and no price set, 'how much?' counts the PAYG players only", async () => {
    const m = match({ attendances: [...REGULARS.map((n, i) => att(n, i)), att("Omar", 4, { paymentMethod: null })] });
    setWorld(m, { monthly: true, paygPricePence: null });
    const ask = (await instructions(AFTER_MATCH)).find((i) => i.key === `${m.id}:fee-ask`) as { text: string };
    expect(ask.text).toBe(
      buildFeeAskDm({ collectorName: "Sam Collector", activityName: "Monday 7-a-side", headcount: 1, lang: "en" }),
    );
  });

  it("the pay chase goes to the PAYG player and never to a regular", async () => {
    const m = match({
      status: "COMPLETED",
      feePerPlayer: 8,
      paymentLinksReleasedAt: new Date("2026-10-12T21:00:00.000Z"),
      attendances: [...REGULARS.map((n, i) => att(n, i)), att("Omar", 4, { paymentMethod: null })],
    });
    setWorld(m, { monthly: true });
    const out = await instructions(new Date("2026-10-13T17:05:00.000Z"));
    expect(out.filter((i) => i.key.includes(":pay-chase:")).map((i) => (i as { targetUser: string }).targetUser)).toEqual(["u-omar"]);
  });
});

describe("MONTHLY: the PAYG pool offer (plan 5.3)", () => {
  /** When Bilal dropped and the offer for his place was opened. */
  const DROPPED_AT = new Date(THU_10AM.getTime() - 3 * 60 * 1000);
  const dropped = () => {
    const m = match({ benchSlotOffers: [{ id: "o1", replacingUserId: "u-bilal", createdAt: DROPPED_AT }] });
    m.attendances[1].status = "DROPPED";
    return m;
  };
  const POOL = [
    { userId: "u-omar", name: "Omar Khan", phone: "+447700900201" },
    { userId: "u-will", name: "Will Stone", phone: "+447700900202" },
  ];
  /** The group saw a list a few minutes BEFORE the drop, so no list post
   *  is due on this poll (the 30-minute floor) and that list did not
   *  announce this place. */
  const listJustPosted = (m: ReturnType<typeof match>): Shown[] => [
    { key: `${m.id}:month-list:old0000000000000:0`, kind: "group-message", createdAt: new Date(THU_10AM.getTime() - 5 * 60 * 1000) },
  ];
  const poolPosts = (out: Awaited<ReturnType<typeof instructions>>, m: ReturnType<typeof match>) =>
    out.filter((i) => i.key.startsWith("offer-") || i.key.startsWith(`${m.id}:payg-pool-`));

  it("nobody waiting and no list going out: one group line, and one DM to each pay-as-you-go player", async () => {
    const m = dropped();
    setWorld(m, { monthly: true, pool: POOL, shown: listJustPosted(m) });
    const out = poolPosts(await instructions(THU_10AM), m);
    expect(out.map((i) => [i.kind, i.key])).toEqual([
      ["group-message", `${m.id}:payg-pool-line:3:0`],
      ["dm", `${m.id}:payg-pool-dm:u-omar`],
      ["dm", `${m.id}:payg-pool-dm:u-will`],
    ]);
    // Three places are free (two from the start, one dropped): one line says so.
    expect((out[0] as { text: string }).text).toBe("🎟 3 places open for *Mon 12 Oct, 20:00*, £8 PAYG. First to say *IN* gets one.");
    expect(out[1]).toMatchObject({ phone: "447700900201", targetUser: "u-omar" });
    expect((out[1] as { text: string }).text).toBe(
      buildPaygPoolDm({ name: "Omar Khan", activityName: "Monday 7-a-side", matchDate: KICKOFF, paygPricePence: 800, lang: "en" }),
    );
  });

  it("SEVERAL offers held back by the list's floor go out as ONE line, never one each", async () => {
    const m = dropped();
    m.benchSlotOffers.push({ id: "o2", replacingUserId: null, createdAt: DROPPED_AT }, { id: "o3", replacingUserId: null, createdAt: DROPPED_AT });
    setWorld(m, { monthly: true, pool: POOL, shown: listJustPosted(m) });
    const lines = poolPosts(await instructions(THU_10AM), m).filter((i) => i.kind === "group-message");
    expect(lines.map((i) => i.key)).toEqual([`${m.id}:payg-pool-line:3:0`]);
  });

  it("when the list goes out on the same poll with its 'places open' line, the pool line does not", async () => {
    const m = dropped();
    setWorld(m, { monthly: true, pool: POOL });
    const out = await instructions(THU_10AM);
    const list = out.filter((i) => i.key.includes("month-list"));
    expect(list).toHaveLength(1);
    expect((list[0] as { text: string }).text).toContain("places open, £8 PAYG: say *IN*");
    expect(poolPosts(out, m).map((i) => [i.kind, i.key])).toEqual([
      ["dm", `${m.id}:payg-pool-dm:u-omar`],
      ["dm", `${m.id}:payg-pool-dm:u-will`],
    ]);
  });

  it("an offer the list has ALREADY announced never posts later, even when a newer list is held by the floor", async () => {
    // The list went out AFTER the offer was opened (it carried the open
    // line). Now the list has changed again but is inside its 30 minutes.
    const m = dropped();
    setWorld(m, {
      monthly: true,
      pool: POOL,
      shown: [{ key: `${m.id}:month-list:old0000000000000:0`, kind: "group-message", createdAt: new Date(DROPPED_AT.getTime() + 60 * 1000) }],
      sent: [`${m.id}:payg-pool-dm:u-omar`, `${m.id}:payg-pool-dm:u-will`],
    });
    const out = await instructions(THU_10AM);
    expect(out.some((i) => i.key.includes("month-list"))).toBe(false);
    expect(poolPosts(out, m)).toEqual([]);
  });

  it("nor again once a pool line has told the group; a place opened AFTER it gets one more line", async () => {
    const m = dropped();
    const told = new Date(DROPPED_AT.getTime() + 60 * 1000);
    const sent = [`${m.id}:payg-pool-dm:u-omar`, `${m.id}:payg-pool-dm:u-will`];
    setWorld(m, { monthly: true, pool: POOL, shown: listJustPosted(m), poolLines: [told], sent });
    expect(poolPosts(await instructions(THU_10AM), m)).toEqual([]);
    m.benchSlotOffers.push({ id: "o2", replacingUserId: null, createdAt: new Date(told.getTime() + 60 * 1000) });
    setWorld(m, { monthly: true, pool: POOL, shown: listJustPosted(m), poolLines: [told], sent });
    expect(poolPosts(await instructions(THU_10AM), m).map((i) => i.key)).toEqual([`${m.id}:payg-pool-line:3:1`]);
  });

  it("a pool player is DMed at most once per match, however many places open", async () => {
    const m = dropped();
    m.benchSlotOffers.push({ id: "o2", replacingUserId: null, createdAt: DROPPED_AT });
    setWorld(m, { monthly: true, pool: POOL, shown: listJustPosted(m), sent: [`${m.id}:payg-pool-dm:u-omar`] });
    const out = await instructions(THU_10AM);
    expect(out.filter((i) => i.kind === "dm" && i.key.includes("payg-pool-dm")).map((i) => i.key)).toEqual([`${m.id}:payg-pool-dm:u-will`]);
  });

  it("never overnight", async () => {
    const m = dropped();
    setWorld(m, { monthly: true, pool: POOL });
    expect(poolPosts(await instructions(new Date("2026-10-08T22:30:00.000Z")), m)).toEqual([]);
  });

  it("an organiser-pick club's pool is not asked", async () => {
    const m = dropped();
    setWorld(m, { monthly: true, pool: POOL, shown: listJustPosted(m) });
    features.benchPickMode = "organiser";
    try {
      expect(poolPosts(await instructions(THU_10AM), m)).toEqual([]);
    } finally {
      features.benchPickMode = "first-come";
    }
  });

  it("with somebody on the waiting list, today's bench offer runs and the pool is not asked", async () => {
    const m = dropped();
    m.attendances.push(att("Zed", 9, { status: "BENCH", paymentMethod: null }));
    setWorld(m, { monthly: true, pool: POOL });
    expect(poolPosts(await instructions(THU_10AM), m).map((i) => [i.kind, i.key])).toEqual([
      ["bench-prompt", "offer-o1"],
      ["dm", "offer-o1:dm:u-zed"],
    ]);
  });
});

describe("MONTHLY: round 2 of the review", () => {
  const withPayg = (over: Record<string, unknown> = {}) =>
    match({ attendances: [...REGULARS.map((n, i) => att(n, i)), att("Omar", 4, { paymentMethod: null })], ...over });
  const prompt = buildFeeConfirmPrompt({ perPlayer: 8, headcount: 1, matchName: "Monday 7-a-side", wasTotal: false, lang: "en" });

  it("D: the fee question is asked ONCE MORE when its first send reported no message id and 30 minutes have passed", async () => {
    const m = withPayg();
    const key = `${m.id}:fee-ask`;
    const asked = (minutesAgo: number, waMessageId: string | null) => ({
      waMessageId,
      createdAt: new Date(AFTER_MATCH.getTime() - minutesAgo * 60 * 1000),
    });
    // Too soon.
    setWorld(m, { monthly: true, sent: [key], feeAsk: asked(10, null) });
    expect((await instructions(AFTER_MATCH)).some((i) => i.key.includes("fee-ask"))).toBe(false);
    // It was sent (the ack carried an id): never asked again, whatever the collector answered.
    setWorld(m, { monthly: true, sent: [key], feeAsk: asked(120, "wa-1") });
    expect((await instructions(AFTER_MATCH)).some((i) => i.key.includes("fee-ask"))).toBe(false);
    // Not sent, and half an hour on: once more, on its own key.
    setWorld(m, { monthly: true, sent: [key], feeAsk: asked(31, null) });
    const again = (await instructions(AFTER_MATCH)).filter((i) => i.key.includes("fee-ask"));
    expect(again.map((i) => [i.key, (i as { text: string }).text])).toEqual([[`${key}:again`, prompt]]);
    // Never after the collector said no: the fee is then his to type.
    setWorld(m, { monthly: true, sent: [key, `${key}:declined`], feeAsk: asked(300, null) });
    expect((await instructions(AFTER_MATCH)).some((i) => i.key.includes("fee-ask"))).toBe(false);
    // And never a third time.
    setWorld(m, { monthly: true, sent: [key, `${key}:again`], feeAsk: asked(300, null) });
    expect((await instructions(AFTER_MATCH)).some((i) => i.key.includes("fee-ask"))).toBe(false);
  });

  it("D: a WEEKLY club's fee question is never asked twice", async () => {
    const m = match({ attendances: REGULARS.map((n, i) => att(n, i, { paymentMethod: null })), rollingSeededAt: null });
    setWorld(m, { monthly: false, sent: [`${m.id}:fee-ask`], feeAsk: { waMessageId: null, createdAt: new Date(AFTER_MATCH.getTime() - 3 * 60 * 60 * 1000) } });
    expect((await instructions(AFTER_MATCH)).some((i) => i.key.includes("fee-ask"))).toBe(false);
  });

  it("E: the running months the poll's sweep already read are not read again", async () => {
    const m = match();
    setWorld(m, { monthly: true });
    const { loadRunningMonths } = await import("@/lib/monthly-week");
    const months = await loadRunningMonths(ORG.id);
    monthReads.mockClear();
    const res = await computeDuePosts(GROUP, THU_10AM, { adminGroup: false }, months);
    expect(monthReads).not.toHaveBeenCalled();
    expect(res!.instructions.some((i) => i.key.includes("month-list"))).toBe(true);
  });
});

describe("MONTHLY: review fixes", () => {
  it("a regular who has left the group frees their slot number and is not on the list", async () => {
    const m = match();
    m.attendances = m.attendances.filter((a) => a.userId !== "u-bilal");
    left.add("u-bilal");
    setWorld(m, { monthly: true });
    const text = ((await instructions(THU_10AM)).find((i) => i.key.includes("month-list")) as { text: string }).text;
    expect(text).toContain("1. Alex (paid)\n2.\n3. Chris");
    expect(text).not.toContain("Bilal");
  });

  it("a game played BEFORE the month was started here is not the month's: its poll, its fee question and its chase are the weekly ones", async () => {
    // The month was started on Tue 13 Oct; this game was Mon 12 Oct.
    monthStartedAt = new Date("2026-10-13T09:00:00.000Z");
    const m = match({ attendances: REGULARS.map((n, i) => att(n, i, { paymentMethod: null })), rollingSeededAt: null });
    setWorld(m, { monthly: true });
    const out = await instructions(AFTER_MATCH);
    expect(out.some((i) => i.key === `${m.id}:payment-poll`)).toBe(true);
    const ask = out.find((i) => i.key === `${m.id}:fee-ask`) as { text: string };
    expect(ask.text).toBe(buildFeeAskDm({ collectorName: "Sam Collector", activityName: "Monday 7-a-side", headcount: 4, lang: "en" }));
    expect(out.some((i) => i.key.includes("month-list"))).toBe(false);
  });

  it("the month's rows cannot be read: the poll does not throw, posts nothing, and records a health event", async () => {
    const m = match();
    setWorld(m, { monthly: true, monthsThrow: true });
    const res = await computeDuePosts(GROUP, THU_5PM);
    expect(res).not.toBeNull();
    expect(res!.instructions).toEqual([]);
    expect(opsAlerts).toHaveLength(1);
    expect(opsAlerts[0]).toMatchObject({ orgId: ORG.id, kind: "monthly-squad" });
  });
});

// ── Slice 3 (2026-10-06): the month's sign-up list ──────────────────────
describe("SIGN-UP: the month's list, and a weekly club untouched by it", () => {
  /** Mon 2 Nov 2026, 20:00 London (GMT). */
  const NOV_KICKOFF = new Date("2026-11-02T20:00:00.000Z");
  /** Tue 27 Oct 2026, 09:30 London: inside the announcement window. */
  const TUE_0930 = new Date("2026-10-27T09:30:00.000Z");
  const OPENED = new Date("2026-10-26T10:00:00.000Z");
  const novMatch = () => match({ id: "m-mon-2-nov", date: NOV_KICKOFF, attendances: [], rollingSeededAt: null });
  const signupMonth = () => ({
    id: "month-nov",
    orgId: ORG.id,
    activityId: "mon-7",
    monthStart: new Date("2026-11-01T00:00:00.000Z"),
    status: "open",
    listOpenedAt: OPENED,
    activity: { name: "Monday 7-a-side", venue: "Goals", dayOfWeek: 1, time: "20:00", sport: { playersPerTeam: 3 } },
    org: { language: "en" },
    members: MEMBERS.map((mm) => ({
      userId: mm.userId,
      kind: "regular",
      tier: "standard",
      slot: mm.slot,
      note: null,
      leftAt: null,
      source: "carry-over",
      paidAt: null,
      paidClaimedAt: null,
      paygMatchIds: [],
      user: { name: mm.name },
    })),
  });
  const PREFIX = `org-${ORG.id}:msu:list:month-nov:`;

  it("WEEKLY: no sign-up month is ever read, and the cold announcement still goes out", async () => {
    const m = novMatch();
    setWorld(m, { monthly: false });
    const out = await instructions(TUE_0930);
    expect(signupReads).not.toHaveBeenCalled();
    expect(monthReads).not.toHaveBeenCalled();
    expect(out.some((i) => i.key === `${m.id}:announce-match`)).toBe(true);
    expect(out.some((i) => i.key.includes(":msu:") || i.key.includes(":mpy:"))).toBe(false);
  });

  it("the months the poll's sweep already read are not read again", async () => {
    const m = novMatch();
    setWorld(m, { monthly: true, signupMonth: signupMonth() });
    const { loadLiveMonths } = await import("@/lib/month-signup");
    const live = await loadLiveMonths(ORG.id, TUE_0930);
    signupReads.mockClear();
    const res = await computeDuePosts(GROUP, TUE_0930, { adminGroup: false }, null, live);
    expect(signupReads).not.toHaveBeenCalled();
    expect(res!.instructions.filter((i) => i.key.startsWith(PREFIX))).toHaveLength(1);
  });

  it("MONTHLY, no month in sign-up: one read, no list, and the announcement as before", async () => {
    const m = novMatch();
    setWorld(m, { monthly: true });
    const out = await instructions(TUE_0930);
    expect(signupReads).toHaveBeenCalledTimes(1);
    expect(out.some((i) => i.key.includes(":msu:"))).toBe(false);
  });

  it("MONTHLY, sign-up open: the list is posted once, under its own key, with the regulars carried over", async () => {
    const m = novMatch();
    setWorld(m, { monthly: true, signupMonth: signupMonth() });
    const out = await instructions(TUE_0930);
    const posts = out.filter((i) => i.key.startsWith(PREFIX));
    expect(posts).toHaveLength(1);
    const post = posts[0] as { kind: string; key: string; text: string; matchId?: string };
    expect(post.kind).toBe("group-message");
    expect(post.key.endsWith(":0")).toBe(true);
    // Not the weekly list's key namespace.
    expect(post.key).not.toContain("month-list");
    expect(post.text.split("\n").slice(0, 6)).toEqual([
      "📋 List for November (5 Mondays: 2, 9, 16, 23, 30)",
      "",
      "1. Alex",
      "2. Bilal",
      "3. Chris",
      "4. Dave",
    ]);
    expect(post.text).toContain("Regulars from October are on already. Not in for November? Say *OUT FOR NOVEMBER*.");
    expect(post.text).toContain("Names in by Sat 31 Oct, 20:00.");
  });

  it("MONTHLY, sign-up open: the match is NOT announced the weekly way beside the list", async () => {
    const m = novMatch();
    setWorld(m, { monthly: true, signupMonth: signupMonth() });
    const out = await instructions(TUE_0930);
    expect(out.some((i) => i.key === `${m.id}:announce-match`)).toBe(false);
  });

  it("the list the group has already seen is not posted again; a changed one waits out the 30 minutes", async () => {
    const m = novMatch();
    setWorld(m, { monthly: true, signupMonth: signupMonth() });
    const first = (await instructions(TUE_0930)).find((i) => i.key.startsWith(PREFIX))!;
    const hash = first.key.slice(PREFIX.length).split(":")[0];
    const seen = (minsAgo: number, h = hash): Shown => ({ key: `${PREFIX}${h}:0`, kind: "group-message", createdAt: new Date(TUE_0930.getTime() - minsAgo * 60_000) });

    setWorld(m, { monthly: true, signupMonth: signupMonth(), shown: [seen(120)] });
    expect((await instructions(TUE_0930)).some((i) => i.key.startsWith(PREFIX))).toBe(false);

    setWorld(m, { monthly: true, signupMonth: signupMonth(), shown: [seen(10, "0000000000000000")] });
    expect((await instructions(TUE_0930)).some((i) => i.key.startsWith(PREFIX))).toBe(false);

    setWorld(m, { monthly: true, signupMonth: signupMonth(), shown: [seen(31, "0000000000000000")] });
    const again = (await instructions(TUE_0930)).filter((i) => i.key.startsWith(PREFIX));
    expect(again.map((i) => i.key)).toEqual([`${PREFIX}${hash}:1`]);
  });

  it("never at night, and never once sign-up has ended", async () => {
    const m = novMatch();
    setWorld(m, { monthly: true, signupMonth: signupMonth() });
    // Mon 26 Oct, 23:00 London.
    expect((await instructions(new Date("2026-10-26T23:00:00.000Z"))).some((i) => i.key.startsWith(PREFIX))).toBe(false);
    // Sat 31 Oct, 20:00 London, two days before the first game: sign-up ends on the dot.
    expect((await instructions(new Date("2026-10-31T19:59:00.000Z"))).some((i) => i.key.startsWith(PREFIX))).toBe(true);
    expect((await instructions(new Date("2026-10-31T20:00:00.000Z"))).some((i) => i.key.startsWith(PREFIX))).toBe(false);
  });

  it("a club with attendance switched off gets no sign-up list", async () => {
    const m = novMatch();
    setWorld(m, { monthly: true, signupMonth: signupMonth() });
    features.attendance = false;
    try {
      expect((await instructions(TUE_0930)).some((i) => i.key.startsWith(PREFIX))).toBe(false);
    } finally {
      features.attendance = true;
    }
  });
});

// ── Slice 4 (2026-10-06): the month's price, payments and reminders ─────
describe("PAYMENTS: the priced list, the count and the reminder DMs", () => {
  /** Mon 2 Nov 2026, 20:00 London (GMT). */
  const NOV_KICKOFF = new Date("2026-11-02T20:00:00.000Z");
  /** Fri 30 Oct 2026, 21:00 London. */
  const PAY_BY = new Date("2026-10-30T21:00:00.000Z");
  const novMatch = () => match({ id: "m-mon-2-nov", date: NOV_KICKOFF, attendances: [], rollingSeededAt: null });
  const P = `org-${ORG.id}:mpy:`;
  /** Alex confirmed, Bilal says paid, Chris and Dave owe. Sam (the collector) is a regular too. */
  const pricedMonth = (over: Record<string, unknown> = {}) => ({
    id: "month-nov",
    orgId: ORG.id,
    activityId: "mon-7",
    monthStart: new Date("2026-11-01T00:00:00.000Z"),
    status: "running",
    listOpenedAt: new Date("2026-10-26T10:00:00.000Z"),
    sharePerGamePence: 750,
    concessionPerGamePence: null,
    venueCostPence: null,
    payByAt: PAY_BY,
    pricedAt: new Date("2026-10-27T12:00:00.000Z"),
    summarySentAt: null,
    activity: { name: "Monday 7-a-side", venue: "Goals", dayOfWeek: 1, time: "20:00", sport: { playersPerTeam: 3 } },
    org: { language: "en" },
    members: [...MEMBERS, { userId: "u-sam", name: "Sam Collector", slot: 5 }].map((mm) => ({
      userId: mm.userId,
      kind: "regular",
      tier: "standard",
      slot: mm.slot,
      note: null,
      leftAt: null,
      source: "carry-over",
      paidAt: mm.userId === "u-alex" ? new Date("2026-10-28T09:00:00.000Z") : null,
      paidClaimedAt: mm.userId === "u-bilal" ? new Date("2026-10-28T09:00:00.000Z") : null,
      paidAmountPence: mm.userId === "u-alex" ? 3750 : null,
      paidClaimedAmountPence: null,
      gamesCovered: 5,
      creditsApplied: mm.userId === "u-chris" ? 1 : 0,
      amountDuePence: mm.userId === "u-chris" ? 3000 : 3750,
      paygMatchIds: [],
      user: { name: mm.name },
    })),
    ...over,
  });
  const world = (o: { shown?: Shown[]; month?: Record<string, unknown> } = {}) => {
    const m = novMatch();
    setWorld(m, { monthly: true, pricedMonth: o.month ?? pricedMonth(), shown: o.shown });
    // The month's members are all still in the club, and have phones.
    overrides.membership = {
      findMany: async (args: unknown) =>
        ((args as { where?: { userId?: { in: string[] } } }).where?.userId?.in ?? []).map((userId) => ({ userId })),
    };
    overrides.organisation = {
      findFirst: async () => ({ ...ORG }),
      findUnique: async () => ({ paymentHolderId: "u-sam", paymentInstructions: "Bank details are in the group description." }),
    };
    overrides.user = {
      findUnique: async () => ({ name: "Sam Collector", phoneNumber: "+447700900999" }),
      findMany: async (args: unknown) =>
        ((args as { where: { id: { in: string[] } } }).where.id.in ?? []).map((id) => ({ id, phoneNumber: `+4477009${id.length}${id.charCodeAt(2)}` })),
    };
    return m;
  };
  const at = (iso: string) => new Date(iso);
  const pay = async (iso: string) => (await instructions(at(iso))).filter((i) => i.key.startsWith(P));

  it("WEEKLY: nothing of the month's payments is read or sent", async () => {
    setWorld(novMatch(), { monthly: false });
    const out = await instructions(at("2026-10-29T21:30:00.000Z"));
    expect(signupReads).not.toHaveBeenCalled();
    expect(out.some((i) => i.key.includes(":mpy:"))).toBe(false);
  });

  it("the priced list is posted once per price: amounts, the pay-by date, the club's own instructions", async () => {
    world();
    const out = await pay("2026-10-27T12:30:00.000Z");
    expect(out).toHaveLength(1);
    const post = out[0] as { kind: string; key: string; text: string };
    expect(post.kind).toBe("group-message");
    expect(post.key.startsWith(`${P}priced:month-nov:`)).toBe(true);
    expect(post.text).toBe(
      [
        "📋 List for November: £7.50 a game, pay Sam by Fri 30 Oct, 21:00",
        // The month's games are its matches, and this world has one.
        "(1 game = £7.50. Credits are already taken off.)",
        "",
        "1. Alex (paid £37.50)",
        "2. Bilal (paid £37.50)",
        "3. Chris (£30)",
        "4. Dave (£37.50)",
        "5. Sam Collector (£37.50)",
        "6.",
        "",
        "Payment: Bank details are in the group description.",
        'Paid? Add (paid) after your name and paste the list, or DM me "paid".',
      ].join("\n"),
    );
    // Posted already: not again. (A new price is a new key.)
    world({ shown: [{ key: post.key, kind: "group-message", createdAt: at("2026-10-27T12:30:00.000Z") }] });
    expect(await pay("2026-10-27T15:00:00.000Z")).toEqual([]);
    world({
      shown: [{ key: post.key, kind: "group-message", createdAt: at("2026-10-27T12:30:00.000Z") }],
      month: pricedMonth({ payByAt: at("2026-10-31T21:00:00.000Z") }),
    });
    const again = await pay("2026-10-27T15:00:00.000Z");
    expect(again.map((i) => i.kind)).toEqual(["group-message"]);
    expect(again[0].key).not.toBe(post.key);
  });

  it("a day before the pay-by date: the count in the group, and a DM to each regular who has not paid", async () => {
    const seen = [{ key: `${P}priced:month-nov:x`, kind: "group-message", createdAt: at("2026-10-27T12:30:00.000Z") }];
    world({ shown: seen, month: pricedMonth() });
    // The priced post for THIS price is not in `shown`, so it is due too; look at the rest.
    const out = (await pay("2026-10-29T21:30:00.000Z")).filter((i) => !i.key.startsWith(`${P}priced:`));
    expect(out.map((i) => i.key).sort()).toEqual([`${P}dm:month-nov:u-chris:r1`, `${P}dm:month-nov:u-dave:r1`, `${P}group:month-nov:count`].sort());
    const group = out.find((i) => i.kind === "group-message") as { text: string };
    // Chris and Dave. Not Alex (confirmed), not Bilal (says paid), not Sam (the collector).
    expect(group.text).toBe("💷 2 still to pay for November, by Fri 30 Oct, 21:00.");
    const chris = out.find((i) => i.key.endsWith("u-chris:r1")) as { kind: string; text: string; targetUser: string };
    expect(chris.kind).toBe("dm");
    expect(chris.targetUser).toBe("u-chris");
    expect(chris.text).toBe(
      "👋 Chris, your place for November is £30, to pay by Fri 30 Oct, 21:00. That is 5 games, with 1 credit taken off. Please pay Sam by bank transfer.\n\n" +
        "Bank details are in the group description.\n\nReply *paid* when you have.",
    );
    // Never a pay link: bank transfer only (D5).
    for (const i of out) expect((i as { text: string }).text).not.toMatch(/https?:/);
  });

  it("nothing before the last 24 hours, and nothing at night", async () => {
    world();
    expect((await pay("2026-10-29T20:00:00.000Z")).filter((i) => !i.key.startsWith(`${P}priced:`))).toEqual([]);
    expect(await pay("2026-10-29T23:00:00.000Z")).toEqual([]);
  });

  it("each DM once: the second on the deadline day, then one a day for three days, then silence", async () => {
    const r1 = (u: string) => ({ key: `${P}dm:month-nov:${u}:r1`, kind: "dm", createdAt: at("2026-10-29T21:30:00.000Z") });
    const sent: Shown[] = [{ key: `${P}group:month-nov:count`, kind: "group-message", createdAt: at("2026-10-29T21:30:00.000Z") }, r1("u-chris"), r1("u-dave")];
    const dms = async (iso: string, shown: Shown[]) => {
      world({ shown });
      return (await pay(iso)).filter((i) => i.kind === "dm").map((i) => i.key).sort();
    };
    expect(await dms("2026-10-29T21:45:00.000Z", sent)).toEqual([]);
    expect(await dms("2026-10-30T08:05:00.000Z", sent)).toEqual([`${P}dm:month-nov:u-chris:r2`, `${P}dm:month-nov:u-dave:r2`]);
    const r2 = (u: string) => ({ key: `${P}dm:month-nov:${u}:r2`, kind: "dm", createdAt: at("2026-10-30T08:05:00.000Z") });
    const both = [...sent, r2("u-chris"), r2("u-dave")];
    expect(await dms("2026-10-30T18:00:00.000Z", both)).toEqual([]);
    expect(await dms("2026-10-31T10:00:00.000Z", both)).toEqual([`${P}dm:month-nov:u-chris:late:2026-10-31`, `${P}dm:month-nov:u-dave:late:2026-10-31`]);
    const late = (u: string, day: string) => ({ key: `${P}dm:month-nov:${u}:late:${day}`, kind: "dm", createdAt: at(`${day}T10:00:00.000Z`) });
    const three = [...both, ...["2026-10-31", "2026-11-01", "2026-11-02"].flatMap((d) => [late("u-chris", d), late("u-dave", d)])];
    expect(await dms("2026-11-02T15:00:00.000Z", three)).toEqual([]);
    expect(await dms("2026-11-03T10:00:00.000Z", three)).toEqual([]);
  });

  it("somebody the collector said has NOT arrived is chased again", async () => {
    world({ shown: [{ key: `${P}declined:month-nov:u-bilal`, kind: "month-pay-declined", createdAt: at("2026-10-29T10:00:00.000Z") }] });
    const out = (await pay("2026-10-29T21:30:00.000Z")).filter((i) => i.kind === "dm").map((i) => i.key);
    expect(out).toContain(`${P}dm:month-nov:u-bilal:r1`);
  });
});
