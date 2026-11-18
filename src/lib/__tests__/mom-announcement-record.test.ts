/**
 * THE MAN OF THE MATCH ANNOUNCEMENT CARRIES WHAT IT SAYS, AS DATA (Kemal,
 * 2026-11-16). The scheduler builds the post's words from a tally; the same
 * tally rides on the instruction as `momResult`, so /api/whatsapp/due-posts
 * can store exactly what the group was shown when it claims the post. The
 * scheduler's decisions about WHEN to announce are untouched (those are
 * pinned by mom-announcement-recovery.test.ts and e2e/api/due-posts.spec.ts).
 *
 * The real `computeDuePosts`, Prisma mocked (the recovery test's pattern).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Overrides = Record<string, Record<string, (...a: unknown[]) => unknown>>;
const overrides: Overrides = {};
const features = vi.hoisted(() => ({ momChosenBy: "players" as string }));

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
    momChosenBy: features.momChosenBy,
  }),
}));

vi.mock("@/lib/message-analyzer", () => ({ composeChaseText: async () => null }));

import { computeDuePosts } from "@/lib/bot-scheduler";
import { withoutServerBookkeeping } from "@/lib/badge-announcement-scheduler";

const GROUP = "group-sutton@g.us";
const ORG = { id: "org-sutton", whatsappGroupId: GROUP, whatsappBotEnabled: true };
/** Tue 15 Sept 2026, 21:30 London (BST). */
const KICKOFF = new Date("2026-09-15T20:30:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
/** Day 6 after kickoff, 16:10 London: inside the backstop window. */
const BACKSTOP_TICK = new Date(Date.UTC(2026, 8, 21, 15, 10, 0));
/** Day 2, 10:10 London: civil hours for an organisers' pick, past the
 *  rating-DM band (so the tick posts the announcement and nothing else). */
const PICK_TICK = new Date(Date.UTC(2026, 8, 17, 9, 10, 0));

const NAMES = ["Erdal Ozkan", "Kemal Ediz", "Sait Demir", "Abid Hussain"];

function match() {
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
    attendances: NAMES.map((name, i) => ({
      id: `att-${i}`,
      userId: `u-${i}`,
      status: "CONFIRMED",
      position: i + 1,
      paidAt: null,
      directPendingAt: null,
      user: { id: `u-${i}`, name, phoneNumber: `+4477009000${String(i).padStart(2, "0")}` },
    })),
    teamAssignments: [],
    benchConfirmations: [],
    benchSlotOffers: [],
    paymentCredits: [],
    activity: {
      id: "tuesday-7aside",
      orgId: ORG.id,
      name: "Tuesday 7-a-side",
      venue: "Goals North Cheam",
      dayOfWeek: 2,
      matchDurationMins: 60,
      sport: { name: "Football 7-a-side", playersPerTeam: 7, teamLabels: null, mvpLabel: "Man of the Match" },
      org: { paymentCollectionEnabled: false, paymentHolderId: null, teamLabels: null, language: "en" },
    },
  };
}

interface Instruction {
  kind: string;
  key: string;
  text?: string;
  momResult?: unknown;
}

async function announcement(now: Date, votes: Array<{ playerId: string; n: number }>, picks: string[] = []): Promise<Instruction | null> {
  overrides.organisation = { findFirst: async () => ORG };
  overrides.sentNotification = { findMany: async () => [], findFirst: async () => null };
  overrides.match = { findMany: async () => [match()] };
  overrides.moMVote = {
    findMany: async () => (picks.length ? picks.map((playerId) => ({ playerId, voterId: "u-admin" })) : votes.map((v) => ({ voterId: `v-${v.playerId}`, playerId: v.playerId }))),
    groupBy: async () => votes.map((v) => ({ playerId: v.playerId, _count: { playerId: v.n } })),
  };
  overrides.user = {
    findMany: async () => NAMES.map((name, i) => ({ id: `u-${i}`, name })),
    findUnique: async (...a: unknown[]) => {
      const id = (a[0] as { where: { id: string } }).where.id;
      return { name: NAMES[Number(id.slice(2))] };
    },
  };
  const res = await computeDuePosts(GROUP, now);
  const posts = ((res?.instructions ?? []) as Instruction[]).filter((i) => i.key.endsWith(":mom-announcement"));
  expect(posts.length).toBeLessThanOrEqual(1);
  return posts[0] ?? null;
}

beforeEach(() => {
  for (const k of Object.keys(overrides)) delete overrides[k];
  features.momChosenBy = "players";
});

describe("a voted result", () => {
  it("carries the tally it was built from, most first, ties by name, with user ids", async () => {
    const post = await announcement(BACKSTOP_TICK, [
      { playerId: "u-2", n: 2 },
      { playerId: "u-0", n: 4 },
      { playerId: "u-1", n: 2 },
    ]);
    expect(post).not.toBeNull();
    expect(post!.momResult).toEqual({
      v: 1,
      kind: "vote",
      tally: [
        { userId: "u-0", name: "Erdal Ozkan", votes: 4 },
        { userId: "u-1", name: "Kemal Ediz", votes: 2 },
        { userId: "u-2", name: "Sait Demir", votes: 2 },
      ],
      // The winners the post announced, stored, never re-derived later.
      winners: ["u-0"],
    });
    // The words say the same thing.
    expect(post!.text).toContain("Erdal Ozkan");
    expect(post!.text).toMatch(/4\b/);
  });

  it("the record is server-side: stripped before the Pi sees the post", async () => {
    const post = await announcement(BACKSTOP_TICK, [{ playerId: "u-0", n: 4 }]);
    const sent = withoutServerBookkeeping(post!);
    expect("momResult" in sent).toBe(false);
    expect(sent.text).toBe(post!.text);
  });
});

describe("an organisers' pick", () => {
  it("carries the one name it announces, no votes", async () => {
    features.momChosenBy = "organisers";
    const post = await announcement(PICK_TICK, [{ playerId: "u-3", n: 1 }], ["u-3"]);
    expect(post).not.toBeNull();
    expect(post!.text).toContain("Abid Hussain");
    expect(post!.momResult).toEqual({ v: 1, kind: "pick", winner: { userId: "u-3", name: "Abid Hussain" } });
  });
});

describe("nothing else changes", () => {
  it("the same tick with no votes posts nothing, as before", async () => {
    expect(await announcement(BACKSTOP_TICK, [])).toBeNull();
  });

  it("before the backstop is due, nothing is posted, as before", async () => {
    expect(await announcement(new Date(KICKOFF.getTime() + 4 * DAY_MS), [{ playerId: "u-0", n: 4 }])).toBeNull();
  });
});
