/**
 * A club on "monthly" never gets the weekly announcement.
 *
 * The incident (3 Nov 2026, 09:00 London, the Vets group, a club with
 * `Organisation.squadMode = "monthly"` and NO SquadMonth row yet): the
 * scheduler posted
 *
 *     📅 *Football 7-a-side*: *Monday 9 November at 20:30* at Oaks Park
 *     High School football field.
 *
 *     Say *IN* to join. First 14 confirmed play.
 *
 * The announce branch only held back for a month in sign-up
 * (`!monthly?.signup`); with no month at all `monthly` was null and the
 * weekly copy went out. In a monthly club the regulars have paid for the
 * whole month and are in every game, so asking everyone to say IN is
 * wrong. Kemal's wording for the group: the monthly squad says nothing,
 * pay as you go players say IN to take an open place (paying for that game
 * only), a guest can be put IN by name, and the organiser posts the
 * month's list.
 *
 * Driven through the real `computeDuePosts` with Prisma mocked (the proxy
 * of announce-suppressed-when-squad-non-empty.test.ts).
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
import { t } from "@/lib/i18n/t";

const GROUP = "group-vets@g.us";
const ORG = { id: "org-vets", whatsappGroupId: GROUP, whatsappBotEnabled: true, paygPricePence: null };

/** Mon 9 Nov 2026, 20:30 London (GMT). */
const KICKOFF = new Date("2026-11-09T20:30:00.000Z");
/** Tue 3 Nov 2026, 09:00 London: the incident tick. */
const NINE_AM = new Date("2026-11-03T09:00:00.000Z");

const WEEKLY_ASK = "Say *IN* to join. First 14 confirmed play.";

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
  overrides.activity = {
    count: async () => 0,
    findMany: async () => [{ id: "vets-mon", venue: "Oaks Park High School football field", dayOfWeek: 1 }],
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

const announce = (out: Awaited<ReturnType<typeof run>>) => out.find((i) => i.key === "m-mon-9-nov:announce-match") as
  | { kind: string; text: string }
  | undefined;

beforeEach(() => {
  for (const k of Object.keys(overrides)) delete overrides[k];
  adminChannel.on = false;
  features.squadMode = "monthly";
  features.language = "en";
});

describe("a monthly club's announcement (the Vets incident, 3 Nov 2026)", () => {
  it("THE INCIDENT: no SquadMonth yet, empty squad, 09:00 → never the weekly 'Say IN to join' copy", async () => {
    const a = announce(await run());
    expect(a).toBeDefined();
    expect(a!.text).not.toContain(WEEKLY_ASK);
    expect(a!.text).not.toContain("First 14");
  });

  it("it is the monthly announcement, naming the organiser who posts the month's list", async () => {
    const a = announce(await run());
    expect(a!.kind).toBe("group-message");
    expect(a!.text).toBe(
      t("en").announce_match_monthly({
        activityName: "Football 7-a-side",
        dateLabel: "Monday 9 November at 20:30",
        venue: "Oaks Park High School football field",
        organiser: "Kemal",
      }),
    );
    expect(a!.text).toContain("*Monday 9 November at 20:30*");
    expect(a!.text).toContain("Kemal will post the month's list");
    expect(a!.text).toContain("Pay as you go");
  });

  it("a guest: a player says a friend is coming and gets a link; an organiser just says the name (the welcome's friend line)", async () => {
    const a = announce(await run());
    expect(a!.text).not.toContain("Say it for them");
    expect(a!.text).not.toContain("*David is IN*");
    expect(a!.text).toContain("Bringing a friend? Say a friend is coming and I'll DM you a link to send them.");
    expect(a!.text).toContain("Organisers can just say the friend's name (for example *Sam Jones is in*)");
  });

  it("with no organiser to name, the line still reads", async () => {
    const a = announce(await run({ organiserName: null }));
    expect(a!.text).toContain("The organiser will post the month's list");
  });

  it("in Turkish for a Turkish club, never the weekly Turkish ask either", async () => {
    features.language = "tr";
    const m = match();
    m.activity.org.language = "tr";
    const a = announce(await run({ matches: [m] }));
    expect(a).toBeDefined();
    expect(a!.text).not.toContain("İlk 14 kişi oynar");
    expect(a!.text).toContain("VARIM");
    expect(a!.text).not.toContain("*David VAR*");
    expect(a!.text).toContain("Organizatörlerin arkadaşın adını yazması yeter");
  });

  it("A RUNNING MONTH NOT YET SEEDED: nothing (the week's list is the announcement once the regulars are on)", async () => {
    const out = await run({ running: true });
    expect(announce(out)).toBeUndefined();
    expect(out.some((i) => "text" in i && String((i as { text: string }).text).includes(WEEKLY_ASK))).toBe(false);
  });

  it("A HELD MONTH (waiting for the organiser's list): still nothing, as before", async () => {
    const out = await run({ heldKey: true });
    expect(announce(out)).toBeUndefined();
  });

  it("anyone already confirmed: no announcement, as for every club", async () => {
    expect(announce(await run({ matches: [match({ attendances: [att("Elvin", 0)] })] }))).toBeUndefined();
  });

  it("already sent: not again", async () => {
    expect(announce(await run({ sent: ["m-mon-9-nov:announce-match"] }))).toBeUndefined();
  });

  it("REGRESSION GUARD: a weekly club still gets the weekly copy", async () => {
    features.squadMode = "weekly";
    const a = announce(await run());
    expect(a!.text).toContain(WEEKLY_ASK);
  });
});

// Kemal, 2026-11-03: in a monthly club the squad starts from the posted
// monthly list, and IN is only for a pay as you go player or a named guest
// taking an open place. With no month in MatchTime yet the confirmed count
// is only whoever happened to say IN, so every weekly post that counts the
// squad and asks for more (the 17:00 chase and roster, the match-day and
// pre-kickoff chases, the drop-out reminder and the published list) would
// ask the paid-up regulars to say IN. None of them goes out.
describe("a monthly club with no month yet: no other weekly post asks the regulars to say IN", () => {
  const two = () => [att("Payg One", 0), att("Payg Two", 1)];
  /** Thu 5 Nov, 17:05 London. */
  const THU_5PM = new Date("2026-11-05T17:05:00.000Z");
  /** Match day, 08:30 London. */
  const MATCH_DAY_0830 = new Date("2026-11-09T08:30:00.000Z");
  /** 3.5h and 1.5h before kick-off. */
  const PRE_3H = new Date("2026-11-09T17:00:00.000Z");
  const PRE_90M = new Date("2026-11-09T19:00:00.000Z");
  const deadlines = { dropOutDeadlineDay: 4, dropOutDeadlineTime: "18:00", listPublishDay: 5, listPublishTime: "10:00" };
  /** Thu 5 Nov 15:30 (3h before the drop-out deadline) and Fri 6 Nov 10:05. */
  const THU_REMINDER = new Date("2026-11-05T15:30:00.000Z");
  const FRI_PUBLISH = new Date("2026-11-06T10:05:00.000Z");

  const cases: Array<{ name: string; now: Date; key: (id: string) => string; org?: Record<string, unknown> }> = [
    { name: "the 17:00 short-squad chase", now: THU_5PM, key: (id) => `${id}:evening-update:2026-11-05` },
    { name: "the match-day morning chase", now: MATCH_DAY_0830, key: (id) => `${id}:chase-match-day-morning:2026-11-09` },
    { name: "the 3-4h pre-kickoff chase", now: PRE_3H, key: (id) => `${id}:chase-pre-kickoff` },
    { name: "the 2h last-chance plea", now: PRE_90M, key: (id) => `${id}:pre-kickoff` },
    { name: "the drop-out reminder", now: THU_REMINDER, key: (id) => `${id}:dropout-reminder`, org: deadlines },
    { name: "the published list", now: FRI_PUBLISH, key: (id) => `${id}:list-published`, org: deadlines },
  ];

  for (const c of cases) {
    const world = () => {
      const m = match({ attendances: two() });
      Object.assign(m.activity.org, c.org ?? {});
      return m;
    };
    it(`REGRESSION GUARD, weekly: ${c.name} still goes out`, async () => {
      features.squadMode = "weekly";
      const m = world();
      const out = await run({ matches: [m], now: c.now });
      expect(out.some((i) => i.key === c.key(m.id))).toBe(true);
    });
    it(`monthly, no month: ${c.name} does not`, async () => {
      const m = world();
      const out = await run({ matches: [m], now: c.now });
      expect(out.some((i) => i.key === c.key(m.id))).toBe(false);
    });
  }

  it("a full squad of fourteen at 17:00 gets no weekly roster with its bench ask either", async () => {
    const m = match({ attendances: Array.from({ length: 14 }, (_, i) => att(`P${i}`, i)) });
    const out = await run({ matches: [m], now: THU_5PM });
    expect(out.some((i) => i.key.startsWith(`${m.id}:evening-update:`))).toBe(false);
  });
});

// Vets sandbox, 3 Nov 2026 (scenario A): Sunday 18:00 the owner got
// "🚨 Match in trouble: only 0 confirmed ... Cancel and refund the booking?"
// for a monthly club with no month. The 0 is only whoever said IN, which in
// a monthly club before its month is nobody by design. The day-before nudges
// count the squad on the match, so they wait until the month's regulars are
// on it; once they are, the count is the regulars' and the nudge is true.
describe("the owner's day-before nudges in a monthly club", () => {
  /** Sun 8 Nov 18:05 London (GMT): the cancel nudge's hour. */
  const SUN_6PM = new Date("2026-11-08T18:05:00.000Z");
  const cancelKey = (id: string) => `${id}:cancel-nudge:u-owner`;
  const regulars = (n: number) => Array.from({ length: n }, (_, i) => att(`Regular ${i}`, i));

  it("REGRESSION GUARD, weekly: 0 confirmed on Sunday 18:00 still nudges the owner to cancel", async () => {
    features.squadMode = "weekly";
    adminChannel.on = true;
    const out = await run({ now: SUN_6PM });
    expect(out.some((i) => i.key === cancelKey("m-mon-9-nov"))).toBe(true);
  });

  it("THE SANDBOX FAILURE: monthly, no month, 0 confirmed: no 'Match in trouble' DM", async () => {
    adminChannel.on = true;
    const out = await run({ now: SUN_6PM });
    expect(out.some((i) => i.key === cancelKey("m-mon-9-nov"))).toBe(false);
    expect(out.some((i) => "text" in i && String((i as { text: string }).text).includes("Match in trouble"))).toBe(false);
  });

  it("monthly, no month, a couple of pay as you go INs: still nothing (the count is not the squad)", async () => {
    adminChannel.on = true;
    const out = await run({ matches: [match({ attendances: regulars(2) })], now: SUN_6PM });
    expect(out.some((i) => i.key === cancelKey("m-mon-9-nov"))).toBe(false);
  });

  it("a held month (waiting for the organiser's list): nothing", async () => {
    adminChannel.on = true;
    const out = await run({ heldKey: true, now: SUN_6PM });
    expect(out.some((i) => i.key === cancelKey("m-mon-9-nov"))).toBe(false);
  });

  it("a running month not yet seeded: nothing (the regulars are not on the match yet)", async () => {
    adminChannel.on = true;
    const out = await run({ running: true, now: SUN_6PM });
    expect(out.some((i) => i.key === cancelKey("m-mon-9-nov"))).toBe(false);
  });

  it("a running month, seeded, 13 regulars of 14: the nudge counts the regulars", async () => {
    adminChannel.on = true;
    const m = match({ attendances: regulars(13), rollingSeededAt: new Date("2026-11-03T08:05:00.000Z") });
    const out = await run({ running: true, matches: [m], now: SUN_6PM });
    const dm = out.find((i) => i.key === cancelKey(m.id)) as { text: string } | undefined;
    expect(dm).toBeDefined();
    expect(dm!.text).toContain("only *13* confirmed");
  });

  it("a running month, seeded, all 14 regulars: no nudge", async () => {
    adminChannel.on = true;
    const m = match({ attendances: regulars(14), rollingSeededAt: new Date("2026-11-03T08:05:00.000Z") });
    const out = await run({ running: true, matches: [m], now: SUN_6PM });
    expect(out.some((i) => i.key === cancelKey(m.id))).toBe(false);
  });
});
