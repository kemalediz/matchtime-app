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
    benchSlotOffers: [] as Array<{ id: string; replacingUserId: string | null }>,
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

interface Shown {
  key: string;
  kind: string;
  createdAt: Date;
}

const monthReads = vi.fn();

function setWorld(
  m: ReturnType<typeof match>,
  opts: { monthly: boolean; sent?: string[]; shown?: Shown[]; pool?: Array<{ userId: string; name: string; phone: string | null }> },
) {
  for (const k of Object.keys(overrides)) delete overrides[k];
  features.squadMode = opts.monthly ? "monthly" : undefined;
  monthReads.mockClear();
  overrides.organisation = { findFirst: async () => ORG };
  overrides.match = { findMany: async () => [m] };
  overrides.squadMonth = {
    findMany: async () => {
      monthReads();
      return [monthRow()];
    },
  };
  overrides.sentNotification = {
    findMany: async (args: unknown) => {
      const where = (args as { where?: { kind?: string; key?: { startsWith?: string } } }).where ?? {};
      if (where.key?.startsWith) {
        return [...(opts.shown ?? [])].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }
      if (where.kind) return [];
      return (opts.sent ?? []).map((key) => ({ key }));
    },
  };
  overrides.membership = {
    findMany: async (args: unknown) => {
      const where = (args as { where?: { userId?: { in: string[] } } }).where ?? {};
      if (!where.userId) return [];
      return (opts.pool ?? [])
        .filter((p) => where.userId!.in.includes(p.userId))
        .map((p) => ({
          userId: p.userId,
          leftAt: null,
          subMatchInviteDm: true,
          user: { name: p.name, phoneNumber: p.phone, isActive: true },
        }));
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
    const m = match({
      attendances: [...REGULARS.map((n, i) => att(n, i)), att("Omar", 4, { paymentMethod: null })],
      feePendingConfirm: 8,
    });
    setWorld(m, { monthly: true });
    const ask = (await instructions(AFTER_MATCH)).find((i) => i.key === `${m.id}:fee-ask`) as { text: string };
    expect(ask.text).toBe(buildFeeConfirmPrompt({ perPlayer: 8, headcount: 1, matchName: "Monday 7-a-side", wasTotal: false, lang: "en" }));
  });

  it("with a PAYG player and no price set, 'how much?' counts the PAYG players only", async () => {
    const m = match({ attendances: [...REGULARS.map((n, i) => att(n, i)), att("Omar", 4, { paymentMethod: null })] });
    setWorld(m, { monthly: true });
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
  const dropped = () => {
    const m = match({ benchSlotOffers: [{ id: "o1", replacingUserId: "u-bilal" }] });
    m.attendances[1].status = "DROPPED";
    return m;
  };
  const POOL = [
    { userId: "u-omar", name: "Omar Khan", phone: "+447700900201" },
    { userId: "u-will", name: "Will Stone", phone: "+447700900202" },
  ];

  it("nobody waiting: one group line and one DM to each pay-as-you-go player, on the offer's keys", async () => {
    const m = dropped();
    setWorld(m, { monthly: true, pool: POOL });
    const out = (await instructions(THU_10AM)).filter((i) => i.key.startsWith("offer-o1"));
    expect(out.map((i) => [i.kind, i.key])).toEqual([
      ["group-message", "offer-o1"],
      ["dm", "offer-o1:dm:u-omar"],
      ["dm", "offer-o1:dm:u-will"],
    ]);
    expect((out[0] as { text: string }).text).toBe(buildPaygPoolGroupPost({ matchDate: KICKOFF, paygPricePence: 800, lang: "en" }));
    expect(out[1]).toMatchObject({ phone: "447700900201", targetUser: "u-omar" });
    expect((out[1] as { text: string }).text).toBe(
      buildPaygPoolDm({ name: "Omar Khan", activityName: "Monday 7-a-side", matchDate: KICKOFF, paygPricePence: 800, lang: "en" }),
    );
  });

  it("sent once: nothing again for keys already sent", async () => {
    const m = dropped();
    setWorld(m, { monthly: true, pool: POOL, sent: ["offer-o1", "offer-o1:dm:u-omar", "offer-o1:dm:u-will"] });
    expect((await instructions(THU_10AM)).some((i) => i.key.startsWith("offer-o1"))).toBe(false);
  });

  it("never overnight", async () => {
    const m = dropped();
    setWorld(m, { monthly: true, pool: POOL });
    expect((await instructions(new Date("2026-10-08T22:30:00.000Z"))).some((i) => i.key.startsWith("offer-o1"))).toBe(false);
  });

  it("an organiser-pick club's pool is not asked", async () => {
    const m = dropped();
    setWorld(m, { monthly: true, pool: POOL });
    features.benchPickMode = "organiser";
    try {
      expect((await instructions(THU_10AM)).some((i) => i.key.startsWith("offer-o1"))).toBe(false);
    } finally {
      features.benchPickMode = "first-come";
    }
  });

  it("with somebody on the waiting list, today's bench offer runs and the pool is not asked", async () => {
    const m = dropped();
    m.attendances.push(att("Zed", 9, { status: "BENCH", paymentMethod: null }));
    setWorld(m, { monthly: true, pool: POOL });
    const out = (await instructions(THU_10AM)).filter((i) => i.key.startsWith("offer-o1"));
    expect(out.map((i) => [i.kind, i.key])).toEqual([
      ["bench-prompt", "offer-o1"],
      ["dm", "offer-o1:dm:u-zed"],
    ]);
  });
});
