/**
 * Weekly deadlines in the scheduler (slice 3 of
 * MDs/friday-group-features-plan-2026-09-30.md, 3.2 and 3.3), driven
 * through the real `computeDuePosts` with Prisma mocked (the proxy
 * pattern of rolling-squad-scheduler.test.ts).
 *
 *   no drop-out reminder before the deadline (removed 2026-11-05);
 *   D3  the final list at publish time, once, only for the next live match;
 *   D4  with both set, the 17:00 post is off except on match day;
 *       a club without the settings (Sutton FC) gets none of it and keeps
 *       its 17:00 post;
 *   the rolling squad's deadline follows the club's weekly deadline.
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

const features = {
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
};
vi.mock("@/lib/org-features", () => ({ getOrgFeatures: async () => ({ ...features }) }));

const composeChaseText = vi.fn(async () => "MODEL TEXT");
vi.mock("@/lib/message-analyzer", () => ({
  composeChaseText: (...a: unknown[]) => composeChaseText(...(a as [])),
}));

import { computeDuePosts } from "@/lib/bot-scheduler";
import { buildListPublishedPost, buildRollingDeadlineLine } from "@/lib/scheduler-copy";

const GROUP = "group-fnf@g.us";
const ORG = { id: "org-fnf", whatsappGroupId: GROUP, whatsappBotEnabled: true };

/** Fri 9 Oct 2026, 20:30 London (19:30 UTC, BST). */
const KICKOFF = new Date("2026-10-09T19:30:00.000Z");
/** The match's own sign-up deadline (kickoff minus 5h). */
const SIGNUP_DEADLINE = new Date("2026-10-09T14:30:00.000Z");
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
        paymentHolderId: null,
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

beforeEach(() => {
  features.rollingSquad = false;
  features.attendance = true;
  composeChaseText.mockClear();
});

// Kemal, 2026-11-05: "i think we can eliminate the drop out reminder, i
// don't think there is a need for that." The deadline itself stays (late
// drop-outs, D3 the list, D4 the 17:00 rule); nothing is ever posted
// ahead of it. (D2, the organisers' summary after it, was removed the same
// day: no-deadline-summary.test.ts.)
describe("no drop-out reminder, ever (Kemal, 2026-11-05)", () => {
  /** Every 10 minutes across the deadline day, 08:00 to 22:50 London. */
  const DEADLINE_DAY = Array.from({ length: 90 }, (_, i) => new Date(Date.UTC(2026, 9, 5, 7, 0) + i * 10 * 60_000));
  const PHRASES = [/drop-out deadline is/i, /son çıkış saati \*bugün/i];
  const noReminder = (out: { key: string; text?: string }[]) => {
    expect(out.some((i) => i.key.includes("dropout-reminder"))).toBe(false);
    expect(out.some((i) => PHRASES.some((re) => re.test(i.text ?? "")))).toBe(false);
  };

  for (const [name, club] of [
    ["both weekly deadlines", HAMZAH_CLUB],
    ["a drop-out deadline only", { ...HAMZAH_CLUB, listPublishDay: null, listPublishTime: null }],
    ["a drop-out deadline only, in Turkish", { ...HAMZAH_CLUB, listPublishDay: null, listPublishTime: null, language: "tr" }],
  ] as const) {
    it(`${name}: nothing in the group at any time on the deadline day`, async () => {
      for (const now of DEADLINE_DAY) {
        setWorld([match(club)]);
        noReminder(await instructions(now));
      }
    });
  }

  it("a short squad or a thin bench brings no reminder either", async () => {
    const short = match(HAMZAH_CLUB, { attendances: NAMES.slice(0, 2).map((n, i) => player(n, i)) });
    const thin = match(HAMZAH_CLUB, {
      maxPlayers: 4,
      attendances: [...NAMES.map((n, i) => player(n, i)), player("Bench 1", 4, "BENCH")],
    });
    for (const m of [short, thin]) {
      for (const now of DEADLINE_DAY) {
        setWorld([m]);
        noReminder(await instructions(now));
      }
    }
  });
});

describe("D3: the list at publish time", () => {
  it("fires from Tuesday 20:00 with who is playing and who is waiting, once", async () => {
    const m = match(HAMZAH_CLUB, {
      maxPlayers: 3,
      attendances: [...NAMES.slice(0, 3).map((n, i) => player(n, i)), player("Kemal", 3, "BENCH")],
    });
    setWorld([m]);
    const key = `${m.id}:list-published`;
    const out = await instructions(TUE_2005);
    expect(out.filter((i) => i.key === key)).toHaveLength(1);
    expect(text(out, key)).toBe(
      buildListPublishedPost({
        activityName: "Friday 9-a-side",
        dateLabel: "Friday 9 October at 20:30",
        venue: "Powerleague",
        confirmed: NAMES.slice(0, 3).map((name) => ({ name })),
        bench: [{ name: "Kemal" }],
        maxPlayers: 3,
        lang: "en",
      }),
    );
    setWorld([m], { sent: [key] });
    expect((await instructions(TUE_2005)).some((i) => i.key === key)).toBe(false);
  });

  it("not before publish time", async () => {
    const m = match(HAMZAH_CLUB);
    setWorld([m]);
    expect((await instructions(TUE_1955)).some((i) => i.key.endsWith(":list-published"))).toBe(false);
  });

  it("only for the next live match", async () => {
    const thisWeek = match(HAMZAH_CLUB, { id: "m-a", date: new Date("2026-10-02T19:30:00.000Z") });
    const nextWeek = match(HAMZAH_CLUB, { id: "m-b" });
    setWorld([thisWeek, nextWeek]);
    expect((await instructions(TUE_2005)).some((i) => i.key === "m-b:list-published")).toBe(false);
  });

  it("not once the teams are out (the team sheet is the announcement)", async () => {
    const m = match(HAMZAH_CLUB, {
      teamAssignments: [{ userId: "u0", team: "RED", user: { id: "u0", name: "Hamzah" } }],
    });
    setWorld([m]);
    expect((await instructions(TUE_2005)).some((i) => i.key.endsWith(":list-published"))).toBe(false);
  });
});

describe("D4: the 17:00 post for a club with weekly deadlines", () => {
  it("is off on a day that is not match day", async () => {
    const m = match(HAMZAH_CLUB);
    setWorld([m]);
    expect((await instructions(MON_1705)).some((i) => i.key.includes(":evening-update:"))).toBe(false);
    expect(composeChaseText).not.toHaveBeenCalled();
  });

  it("still fires on match day", async () => {
    // Full squad, no teams: the match-day "squad locked" post (2-pre-alt).
    const m = match(HAMZAH_CLUB, { maxPlayers: 4 });
    setWorld([m]);
    expect((await instructions(FRI_1705)).some((i) => i.key.includes(":evening-update:"))).toBe(true);
  });

  it("stays on with only a drop-out deadline (no publish time)", async () => {
    const m = match({ ...HAMZAH_CLUB, listPublishDay: null, listPublishTime: null });
    setWorld([m]);
    expect((await instructions(MON_1705)).some((i) => i.key.includes(":evening-update:"))).toBe(true);
  });
});

describe("Sutton FC (no weekly deadlines): unchanged", () => {
  it("no reminder, no list, and the 17:00 post as before", async () => {
    const m = match(SUTTON_CLUB);
    setWorld([m]);
    for (const now of [MON_1805, TUE_2005]) {
      const out = await instructions(now);
      expect(out.some((i) => i.key.endsWith(":dropout-reminder") || i.key.endsWith(":list-published"))).toBe(false);
    }
    const evening = await instructions(MON_1705);
    expect(text(evening, `${m.id}:evening-update:2026-10-05`)).toBe("MODEL TEXT");
  });

  it("an org row without the columns at all behaves the same", async () => {
    const m = match({});
    setWorld([m]);
    const evening = await instructions(MON_1705);
    expect(text(evening, `${m.id}:evening-update:2026-10-05`)).toBe("MODEL TEXT");
    expect((await instructions(MON_1805)).some((i) => i.key.endsWith(":dropout-reminder"))).toBe(false);
  });
});

describe("the rolling squad reads the club's weekly deadline", () => {
  it("the rolling announcement names Monday 21:00, not the match's sign-up deadline", async () => {
    features.rollingSquad = true;
    const m = match(HAMZAH_CLUB, { rollingSeededAt: new Date("2026-10-03T07:00:00.000Z") });
    setWorld([m], { carried: 4 });
    const out = await instructions(new Date("2026-10-03T09:00:00.000Z"));
    expect(text(out, `${m.id}:rolling-announce`)).toContain("Drop-out deadline: *Monday 21:00*.");
  });

  it("the match-day 17:00 post no longer carries a deadline that has passed", async () => {
    features.rollingSquad = true;
    const m = match(HAMZAH_CLUB, { maxPlayers: 4, rollingSeededAt: new Date("2026-10-03T07:00:00.000Z") });
    setWorld([m], { carried: 4 });
    const post = text(await instructions(FRI_1705), `${m.id}:evening-update:2026-10-09`);
    expect(post).toBeDefined();
    expect(post).not.toContain(buildRollingDeadlineLine({ deadline: "Monday 21:00", lang: "en" }));
  });

  it("a rolling club with only a drop-out deadline gets it on the Sunday 17:00 post", async () => {
    features.rollingSquad = true;
    const m = match(
      { ...HAMZAH_CLUB, listPublishDay: null, listPublishTime: null },
      { rollingSeededAt: new Date("2026-10-03T07:00:00.000Z") },
    );
    // Half of the 18 places were carried over: the standing line (2026-10-13).
    setWorld([m], { carried: 9 });
    const post = text(await instructions(new Date("2026-10-04T16:05:00.000Z")), `${m.id}:evening-update:2026-10-04`);
    expect(post).toContain(buildRollingDeadlineLine({ deadline: "Monday 21:00", lang: "en" }));
  });
});
