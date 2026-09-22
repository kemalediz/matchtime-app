/**
 * THE MAN-OF-THE-MATCH ANNOUNCEMENT MUST SURVIVE AN OUTAGE.
 *
 * The incident (Sutton FC, 2026-09-22). The Tue 15 Sept match had a clear
 * winner, 4 of 8 votes, and the group was never told. Two independent
 * windows in `bot-scheduler.ts` left a margin of one day between them:
 *
 *   - the scheduler loaded COMPLETED matches from the last 6 days only;
 *   - the MoM backstop fired 5 days after the match, and only between
 *     15:00 and 16:00 London: one hour per day.
 *
 * So the match had one, maybe two chances, each an hour long. The bot was
 * down from 20 Sept 14:33 to 22 Sept 12:20, which covered the only one.
 * By the time it came back the match was 7 days old, had dropped out of
 * the query, and the announcement was unreachable for good. No error, no
 * log: the club simply never heard who won.
 *
 * These tests drive the real `computeDuePosts` with Prisma mocked (the
 * `vi.mock("@/lib/db")` pattern from evening-full-squad-post.test.ts).
 * The load-bearing detail is that the `match.findMany` mock HONOURS the
 * `date: { gte: windowStart }` clause the scheduler sends, so a match
 * that falls out of the lookback really does disappear from the tick,
 * exactly as it did in production. Narrow the lookback again and these
 * tests fail.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Prisma seam ───────────────────────────────────────────────────────
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

vi.mock("@/lib/org-features", () => ({
  getOrgFeatures: async () => ({
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
  }),
}));

vi.mock("@/lib/message-analyzer", () => ({
  composeChaseText: async () => null,
}));

import {
  computeDuePosts,
  MOM_ANNOUNCE_MAX_AGE_DAYS,
  MOM_BACKSTOP_DAYS,
  MOM_BACKSTOP_FROM_HOUR,
  MOM_BACKSTOP_TO_HOUR,
  POST_MATCH_END_FLOW_MAX_AGE_DAYS,
  POST_MATCH_LOOKBACK_DAYS,
} from "@/lib/bot-scheduler";

const GROUP = "group-sutton@g.us";
const ORG = { id: "org-sutton", whatsappGroupId: GROUP, whatsappBotEnabled: true };

/** Tue 15 Sept 2026, 21:30 London (20:30 UTC, BST). The real fixture. */
const KICKOFF = new Date("2026-09-15T20:30:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** `n` days after kickoff, at `londonHour` London wall-clock (BST = UTC+1). */
function dayAfterKickoff(n: number, londonHour: number): Date {
  const d = new Date(KICKOFF.getTime() + n * DAY_MS);
  // Kickoff's London date + n days, at the wanted hour. September is BST,
  // so London = UTC + 1 for every instant these tests use.
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), londonHour - 1, 10, 0),
  );
}

const EIGHT = [
  "Erdal Ozkan", "Kemal Ediz", "Sait Demir", "Abid Hussain",
  "Idris Bello", "Wasim Akhtar", "Zair Malik", "Faris Nasser",
];

function player(name: string, i: number) {
  return {
    id: `att-${i}`,
    userId: `u-${i}`,
    status: "CONFIRMED",
    position: i + 1,
    paidAt: null,
    directPendingAt: null,
    user: { id: `u-${i}`, name, phoneNumber: `+4477009000${String(i).padStart(2, "0")}` },
  };
}

function match(over: Record<string, unknown> = {}) {
  return {
    id: "match-tue-15-sep",
    date: KICKOFF,
    status: "COMPLETED",
    maxPlayers: 8,
    isHistorical: false,
    activityId: "tuesday-7aside",
    attendanceDeadline: new Date(KICKOFF.getTime() - 4 * 60 * 60 * 1000),
    postMatchEndFlow: true,
    paymentLinksReleasedAt: null,
    feePerPlayer: null,
    feePendingConfirm: null,
    redScore: 3,
    yellowScore: 2,
    attendances: EIGHT.map(player) as unknown[],
    teamAssignments: [] as unknown[],
    benchConfirmations: [] as unknown[],
    benchSlotOffers: [] as unknown[],
    paymentCredits: [] as unknown[],
    activity: {
      id: "tuesday-7aside",
      orgId: ORG.id,
      name: "Tuesday 7-a-side",
      venue: "Goals North Cheam",
      dayOfWeek: 2,
      matchDurationMins: 60,
      sport: { name: "Football 7-a-side", playersPerTeam: 7, teamLabels: null, mvpLabel: "Man of the Match" },
      org: {
        paymentCollectionEnabled: false,
        paymentHolderId: null,
        teamLabels: null,
        language: "en",
      },
    },
    ...over,
  };
}

/** The NEXT week's fixture, same activity, seven days later. */
function nextWeek(status: string) {
  return match({
    id: "match-tue-22-sep",
    date: new Date(KICKOFF.getTime() + 7 * DAY_MS),
    status,
    attendances: [] as unknown[],
  });
}

interface WhereClause {
  status?: string | { in: string[] };
  date?: { gte?: Date };
}

/**
 * Stand-in for Prisma's own filtering. Only the COMPLETED branch of the
 * scheduler's `OR` carries a date bound, and it is the bound this whole
 * file is about, so it is the one the mock honours. Everything else is
 * returned untouched, as the real query does.
 */
function findManyHonouringWindow(all: ReturnType<typeof match>[]) {
  return async (...args: unknown[]) => {
    const where = (args[0] as { where?: { OR?: WhereClause[] } } | undefined)?.where;
    const completed = where?.OR?.find((c) => c.status === "COMPLETED");
    const gte = completed?.date?.gte;
    if (!gte) return all;
    return all.filter((m) => m.status !== "COMPLETED" || m.date.getTime() >= gte.getTime());
  };
}

interface Instruction {
  kind: string;
  key: string;
  text?: string;
}

/**
 * Four of the eight voted, Erdal the winner. Mirrors the real tally.
 * `momVotes` is also what the EARLY trigger counts as engagement.
 */
function momRows(voterCount: number) {
  const voters = EIGHT.slice(0, voterCount).map((_, i) => ({ voterId: `u-${i}` }));
  return { voters };
}

async function run(
  opts: {
    matches?: ReturnType<typeof match>[];
    now: Date;
    sentKeys?: string[];
    voterCount?: number;
  },
): Promise<Instruction[]> {
  const { voters } = momRows(opts.voterCount ?? 4);
  overrides.organisation = { findFirst: async () => ORG };
  overrides.sentNotification = {
    findMany: async () =>
      (opts.sentKeys ?? []).map((key) => ({ key, targetUser: null, createdAt: new Date(0) })),
    findFirst: async () => null,
  };
  overrides.match = { findMany: findManyHonouringWindow(opts.matches ?? [match()]) };
  overrides.moMVote = {
    findMany: async () => voters,
    // Erdal (u-0) takes 4 of the 4 cast votes; the others got none.
    groupBy: async () => [{ playerId: "u-0", _count: { playerId: voters.length } }],
  };
  overrides.user = {
    findMany: async () => [{ id: "u-0", name: "Erdal Ozkan" }],
  };
  const res = await computeDuePosts(GROUP, opts.now);
  return (res?.instructions ?? []) as Instruction[];
}

/** The MoM announcement instruction for the 15 Sept match, or null. */
async function announcement(opts: Parameters<typeof run>[0]): Promise<Instruction | null> {
  const all = await run(opts);
  const posts = all.filter((i) => i.key.endsWith(":mom-announcement"));
  expect(posts.length, "at most one MoM announcement").toBeLessThanOrEqual(1);
  return posts[0] ?? null;
}

beforeEach(() => {
  for (const k of Object.keys(overrides)) delete overrides[k];
});

describe("the 2026-09-22 incident: an outage over the only backstop window", () => {
  it("THE BUG: the bot comes back on day 7 and the announcement still goes out", async () => {
    // Bot down 20 Sept 14:33 → 22 Sept 12:20. The single 21 Sept
    // 15:00-16:00 window was inside the outage. This is the first tick
    // in civil hours after recovery.
    const post = await announcement({ now: dayAfterKickoff(7, 15) });
    expect(post, "the club must still be told who won").not.toBeNull();
    expect(post!.kind).toBe("group-message");
    expect(post!.text).toContain("Erdal Ozkan");
    expect(post!.text).toContain("Man of the Match");
  });

  it("an afternoon or evening recovery does not have to wait for tomorrow", async () => {
    // Day 6 at 18:10 London: inside the old 6-day lookback, but the old
    // one-hour 15:00-16:00 gate had already closed for the day.
    const post = await announcement({ now: dayAfterKickoff(6, 18) });
    expect(post).not.toBeNull();
  });

  it("once announced it never repeats", async () => {
    const post = await announcement({
      now: dayAfterKickoff(7, 15),
      sentKeys: ["match-tue-15-sep:mom-announcement"],
    });
    expect(post).toBeNull();
  });
});

describe("civil hours are kept", () => {
  it("never overnight, however overdue it is", async () => {
    expect(await announcement({ now: dayAfterKickoff(7, 3) })).toBeNull();
    expect(await announcement({ now: dayAfterKickoff(7, 23) })).toBeNull();
  });

  it("the backstop still never speaks before 15:00 London", async () => {
    // The morning of a day the announcement is overdue: not yet.
    expect(await announcement({ now: dayAfterKickoff(7, 10) })).toBeNull();
    expect(await announcement({ now: dayAfterKickoff(7, 14) })).toBeNull();
  });

  it("and it stops at 21:00 London, same as the early path", async () => {
    expect(await announcement({ now: dayAfterKickoff(7, 20) })).not.toBeNull();
    expect(await announcement({ now: dayAfterKickoff(7, 21) })).toBeNull();
  });

  it("nothing fires before the backstop is due", async () => {
    expect(await announcement({ now: dayAfterKickoff(4, 16) })).toBeNull();
  });
});

describe("the outer limit: too stale to post", () => {
  // Kickoff is 21:30, so an afternoon tick on the Nth day after the
  // match is an age of N days minus about five hours. The cap is read in
  // ages, not calendar days, which is why these two sit either side of
  // it rather than on it.
  it(`still announces at an age under ${MOM_ANNOUNCE_MAX_AGE_DAYS} days`, async () => {
    const now = dayAfterKickoff(MOM_ANNOUNCE_MAX_AGE_DAYS, 16);
    expect(now.getTime() - KICKOFF.getTime()).toBeLessThan(
      MOM_ANNOUNCE_MAX_AGE_DAYS * DAY_MS,
    );
    expect(await announcement({ now })).not.toBeNull();
  });

  it(`stops carrying it once past ${MOM_ANNOUNCE_MAX_AGE_DAYS} days`, async () => {
    const now = dayAfterKickoff(MOM_ANNOUNCE_MAX_AGE_DAYS + 1, 16);
    expect(now.getTime() - KICKOFF.getTime()).toBeGreaterThan(
      MOM_ANNOUNCE_MAX_AGE_DAYS * DAY_MS,
    );
    // Still inside the query's lookback, so the match IS loaded: the
    // refusal is the explicit staleness rule, not an accident of the
    // window.
    expect(now.getTime() - KICKOFF.getTime()).toBeLessThan(
      POST_MATCH_LOOKBACK_DAYS * DAY_MS,
    );
    expect(await announcement({ now })).toBeNull();
  });

  it("the club plays weekly: once the NEXT fixture has been played we let it go", async () => {
    // Day 8, 15:10 London: next week's match (day 7, 21:30 London) has
    // been played. Announcing last week's winner now reads as this
    // week's result.
    const post = await announcement({
      now: dayAfterKickoff(8, 15),
      matches: [match(), nextWeek("COMPLETED")],
    });
    expect(post, "last week's winner after this week's game was played").toBeNull();
  });

  it("but a next fixture that has NOT kicked off yet suppresses nothing", async () => {
    const post = await announcement({
      now: dayAfterKickoff(7, 15), // 15:10 London, kickoff is 21:30
      matches: [match(), nextWeek("TEAMS_PUBLISHED")],
    });
    expect(post).not.toBeNull();
  });
});

describe("the early trigger is untouched", () => {
  // Day 2 rather than day 1: past the 36h rating-DM band, so the tick
  // produces the announcement and nothing else. Still long before the
  // day-5 backstop, which is the point.
  it("everyone has voted, so it goes out long before the backstop", async () => {
    const post = await announcement({ now: dayAfterKickoff(2, 10), voterCount: 8 });
    expect(post).not.toBeNull();
    expect(post!.text).toContain("Erdal Ozkan");
  });

  it("but not overnight", async () => {
    expect(await announcement({ now: dayAfterKickoff(2, 2), voterCount: 8 })).toBeNull();
  });
});

describe("the lookback and the deadlines it serves", () => {
  it("the query reaches back past every post-match deadline below it", () => {
    // The margin this file exists because of. Every deadline measured
    // from kickoff must be strictly inside the lookback, or the work
    // silently becomes unreachable.
    expect(POST_MATCH_LOOKBACK_DAYS).toBeGreaterThan(MOM_ANNOUNCE_MAX_AGE_DAYS);
    expect(POST_MATCH_LOOKBACK_DAYS).toBeGreaterThan(POST_MATCH_END_FLOW_MAX_AGE_DAYS);
    expect(MOM_ANNOUNCE_MAX_AGE_DAYS).toBeGreaterThan(MOM_BACKSTOP_DAYS);
  });

  it("the backstop window is hours wide, not one hour", () => {
    expect(MOM_BACKSTOP_TO_HOUR - MOM_BACKSTOP_FROM_HOUR).toBeGreaterThanOrEqual(6);
  });
});
