/**
 * Next week's posts wait until the cancelled game's day is over.
 *
 * The incident (2026-10-13, Sutton FC, live group). The club plays
 * Tuesdays at 21:30 and its matches exist weeks ahead (block booking).
 *
 *   Mon 12 Oct 18:00  the Tue 13 Oct match was CANCELLED (too few players)
 *   Tue 13 Oct 09:00  MatchTime announced the NEXT match, Tue 20 Oct:
 *                     "Say IN to join. First 14 confirmed play."
 *   Tue 13 Oct 17:00  the evening squad post for 20 Oct, 0/14
 *
 * No gate misfired. The next-upcoming gate held a later match only while
 * an earlier one in the fixture was still live, and the scheduler's query
 * did not load cancelled matches at all, so from the moment of the
 * cancellation the 20 Oct match was "next". When the game is played the
 * next week's announcement goes on Wednesday morning; Kemal's call is
 * that a cancelled week keeps that rhythm.
 *
 * These tests drive the real `computeDuePosts` with Prisma mocked (the
 * pattern of announce-suppressed-when-squad-non-empty.test.ts). The pure
 * rule, with its clock-change cases, is in next-upcoming-post.test.ts.
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
            get: (_t2, method: string) =>
              overrides[model]?.[method] ?? defaultFor(method),
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
  }),
}));

vi.mock("@/lib/message-analyzer", () => ({
  composeChaseText: async () => null,
}));

import { computeDuePosts } from "@/lib/bot-scheduler";

const GROUP = "group-sutton@g.us";
const ORG = { id: "org-sutton", whatsappGroupId: GROUP, whatsappBotEnabled: true };

/** London wall clock in BST (UTC+1), which holds until 25 Oct 2026. */
const bst = (day: string, time: string) => new Date(`${day}T${time}:00.000+01:00`);

function match(id: string, day: string, over: Record<string, unknown> = {}) {
  return {
    id,
    date: bst(day, "21:30"),
    status: "UPCOMING",
    maxPlayers: 14,
    isHistorical: false,
    activityId: "tuesday-7aside",
    attendanceDeadline: bst(day, "19:00"),
    attendances: [] as unknown[],
    teamAssignments: [] as unknown[],
    benchConfirmations: [] as unknown[],
    benchSlotOffers: [] as unknown[],
    activity: {
      id: "tuesday-7aside",
      orgId: ORG.id,
      name: "Tuesday 7-a-side",
      venue: "Goals North Cheam",
      dayOfWeek: 2,
      matchDurationMins: 60,
      sport: { name: "Football 7-a-side", playersPerTeam: 7, teamLabels: null },
      org: { paymentCollectionEnabled: false, paymentHolderId: null, teamLabels: null },
    },
    ...over,
  };
}

const player = (name: string, i: number) => ({
  id: `att-${i}`,
  status: "CONFIRMED",
  position: i + 1,
  paidAt: null,
  directPendingAt: null,
  user: { id: `u${i}`, name, phoneNumber: `+44770090000${i}` },
});

const CANCELLED_13 = () => match("tue-13", "2026-10-13", { status: "CANCELLED" });
const UPCOMING_20 = (over: Record<string, unknown> = {}) => match("tue-20", "2026-10-20", over);
const UPCOMING_27 = () => match("tue-27", "2026-10-27", { date: new Date("2026-10-27T21:30:00.000Z") });

/** The `where` the scheduler last gave `match.findMany`. */
let lastMatchWhere: unknown = null;

async function duePosts(matches: unknown[], now: Date) {
  overrides.organisation = { findFirst: async () => ORG };
  overrides.match = {
    findMany: async (args: unknown) => {
      lastMatchWhere = (args as { where?: unknown }).where ?? null;
      return matches;
    },
  };
  const res = await computeDuePosts(GROUP, now);
  return res?.instructions ?? [];
}

const keysOf = (posts: Array<{ key: string }>) => posts.map((p) => p.key);

beforeEach(() => {
  for (const k of Object.keys(overrides)) delete overrides[k];
  lastMatchWhere = null;
});

describe("the scheduler loads a cancelled match while its day can still hold a post", () => {
  it("asks for CANCELLED matches from the last 24 hours on, beside the live and recently completed ones", async () => {
    const now = bst("2026-10-13", "09:00");
    await duePosts([UPCOMING_20()], now);
    const where = lastMatchWhere as { isHistorical: boolean; OR: Array<Record<string, unknown>> };
    expect(where.isHistorical).toBe(false);
    expect(where.OR).toContainEqual({
      status: "CANCELLED",
      date: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
    });
  });
});

describe("announce-match after a cancelled week (the 2026-10-13 incident)", () => {
  it("THE INCIDENT: 09:00 on the cancelled day, next week's match is NOT announced", async () => {
    const posts = await duePosts([CANCELLED_13(), UPCOMING_20()], bst("2026-10-13", "09:00"));
    expect(keysOf(posts)).not.toContain("tue-20:announce-match");
  });

  it("09:00 the morning after, it is announced, exactly as after a played game", async () => {
    const posts = await duePosts([CANCELLED_13(), UPCOMING_20()], bst("2026-10-14", "09:00"));
    expect(keysOf(posts)).toContain("tue-20:announce-match");
  });

  it("two cancelled weeks in a row: 27 Oct is announced on 21 Oct, not before", async () => {
    const all = () => [CANCELLED_13(), UPCOMING_20({ status: "CANCELLED" }), UPCOMING_27()];
    expect(keysOf(await duePosts(all(), bst("2026-10-14", "09:00")))).not.toContain("tue-27:announce-match");
    expect(keysOf(await duePosts(all(), bst("2026-10-20", "09:00")))).not.toContain("tue-27:announce-match");
    expect(keysOf(await duePosts(all(), bst("2026-10-21", "09:00")))).toContain("tue-27:announce-match");
  });

  it("the cancelled match itself never posts anything", async () => {
    for (const time of ["09:00", "17:00", "19:30"]) {
      const posts = await duePosts([CANCELLED_13(), UPCOMING_20()], bst("2026-10-13", time));
      expect(posts.filter((p) => p.key.startsWith("tue-13:"))).toEqual([]);
    }
  });
});

describe("the 17:00 evening update after a cancelled week", () => {
  it("THE INCIDENT: 17:00 on the cancelled day, no squad post for next week (0/14)", async () => {
    const posts = await duePosts([CANCELLED_13(), UPCOMING_20()], bst("2026-10-13", "17:00"));
    expect(keysOf(posts)).not.toContain("tue-20:evening-update:2026-10-13");
  });

  it("held even when somebody signed up for next week during the cancelled day", async () => {
    const withOne = UPCOMING_20({ attendances: [player("Elvin", 0)] });
    const posts = await duePosts([CANCELLED_13(), withOne], bst("2026-10-13", "17:00"));
    expect(keysOf(posts)).not.toContain("tue-20:evening-update:2026-10-13");
  });

  it("17:00 the day after, the squad post goes out", async () => {
    const withOne = UPCOMING_20({ attendances: [player("Elvin", 0)] });
    const posts = await duePosts([CANCELLED_13(), withOne], bst("2026-10-14", "17:00"));
    expect(keysOf(posts)).toContain("tue-20:evening-update:2026-10-14");
  });

  it("CONTROL: with no cancelled match, 17:00 on 13 Oct posts next week's squad as before", async () => {
    const posts = await duePosts([UPCOMING_20()], bst("2026-10-13", "17:00"));
    expect(keysOf(posts)).toContain("tue-20:evening-update:2026-10-13");
  });
});
