/**
 * The announcement must never fire over a squad that already exists.
 *
 * The incident (2026-09-06, Sutton FC, live group): at 09:00 MatchTime
 * posted the plain announcement
 *
 *     📅 *Tuesday 7-a-side* — *Tuesday 8 September at 21:30* at Goals
 *     North Cheam.
 *
 *     Say *IN* to join. First 14 confirmed play.
 *
 * for a match that already had SIX confirmed players. The post carries no
 * roster and no count, so to the group it read as though the squad had
 * been wiped and everybody had to sign up again.
 *
 * Nothing about the timing was a bug: the match was created 27 Aug, the
 * `isNextUpcoming` gate correctly held the announcement while the 1 Sept
 * match was still the next fixture, the bot was muted 1–5 Sept, and this
 * was simply the first 09:00–13:00 window with the bot live. Every
 * existing gate behaved correctly — the announcement itself was the wrong
 * message to send over a non-empty squad.
 *
 * Kemal's call: "it shouldn't fire if the squad is non-empty as we already
 * announce at 5pm". So the fix is SUPPRESSION, not rewording — the 17:00
 * daily post already states the fixture with a real roster and a real
 * count once anyone is in.
 *
 * These tests drive the real `computeDuePosts` with Prisma mocked (the
 * `vi.mock("@/lib/db")` pattern used by out-of-band-announce.test.ts), so
 * they exercise the actual gate rather than a copy of it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Prisma seam ───────────────────────────────────────────────────────
//   A permissive proxy: every model/method the scheduler touches answers
//   with an empty result unless explicitly overridden below. Keeps the
//   fixture to the handful of rows this gate actually reads.
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

// Every feature on — Sutton FC's shape. The post-compute feature filter
// classifies `announce-match` as `attendance`.
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

// No network: the announcement is a hardcoded template, but sibling
// blocks in the same function reach for the composer.
vi.mock("@/lib/message-analyzer", () => ({
  composeChaseText: async () => null,
}));

import { computeDuePosts } from "@/lib/bot-scheduler";

const GROUP = "group-sutton@g.us";
const ORG = { id: "org-sutton", whatsappGroupId: GROUP, whatsappBotEnabled: true };

/** Tue 8 Sept 2026, 21:30 London (= 20:30 UTC, BST). The incident match. */
const KICKOFF = new Date("2026-09-08T20:30:00.000Z");
/** Sun 6 Sept 2026, 09:00 London (= 08:00 UTC). The incident tick. */
const NINE_AM = new Date("2026-09-06T08:00:00.000Z");

const SIX_NAMES = ["Elvin", "Mustafa", "Kemal", "Ibrahim", "Kieran", "Rashad"];

function player(name: string, i: number, status: string) {
  return {
    id: `att-${i}`,
    status,
    position: i + 1,
    paidAt: null,
    directPendingAt: null,
    user: { id: `u${i}`, name, phoneNumber: `+44770090000${i}` },
  };
}

function match(over: Record<string, unknown> = {}) {
  return {
    id: "match-tue-8-sep",
    date: KICKOFF,
    status: "UPCOMING",
    maxPlayers: 14,
    isHistorical: false,
    activityId: "tuesday-7aside",
    attendanceDeadline: new Date("2026-09-08T18:00:00.000Z"),
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
      org: {
        paymentCollectionEnabled: false,
        paymentHolderId: null,
        teamLabels: null,
      },
    },
    ...over,
  };
}

/** Run the scheduler and return the announcement instruction, if any. */
async function announcement(
  opts: {
    matches?: unknown[];
    sentKeys?: string[];
    now?: Date;
  } = {},
) {
  overrides.organisation = { findFirst: async () => ORG };
  overrides.sentNotification = {
    // `targetUser: null` keeps these rows out of the recruit-chase block,
    // which re-queries this model with its own `select`.
    findMany: async () =>
      (opts.sentKeys ?? []).map((key) => ({
        key,
        targetUser: null,
        createdAt: new Date(0),
      })),
  };
  overrides.match = { findMany: async () => opts.matches ?? [match()] };
  const res = await computeDuePosts(GROUP, opts.now ?? NINE_AM);
  return res?.instructions.find((i) => i.key.endsWith(":announce-match")) ?? null;
}

beforeEach(() => {
  for (const k of Object.keys(overrides)) delete overrides[k];
});

describe("announce-match — the 2026-09-06 non-empty-squad suppression", () => {
  it("REGRESSION GUARD: an empty squad in the announce window still gets its announcement", async () => {
    const a = await announcement();
    expect(a).not.toBeNull();
    expect(a?.kind).toBe("group-message");
    expect((a as { text: string }).text).toContain("Say *IN* to join");
  });

  it("ONE confirmed player is enough to suppress it (the incident, minimised)", async () => {
    const a = await announcement({
      matches: [match({ attendances: [player("Elvin", 0, "CONFIRMED")] })],
    });
    expect(a).toBeNull();
  });

  it("THE INCIDENT: six confirmed on 2026-09-06 at 09:00 → no announcement", async () => {
    const a = await announcement({
      matches: [
        match({
          attendances: SIX_NAMES.map((n, i) => player(n, i, "CONFIRMED")),
        }),
      ],
    });
    expect(a).toBeNull();
  });

  it("a full 14 confirmed is likewise suppressed", async () => {
    const a = await announcement({
      matches: [
        match({
          attendances: Array.from({ length: 14 }, (_, i) =>
            player(`P${i}`, i, "CONFIRMED"),
          ),
        }),
      ],
    });
    expect(a).toBeNull();
  });

  it("BENCH-ONLY, NOBODY CONFIRMED: the announcement STILL fires — 'squad' means confirmed players", async () => {
    // The chosen definition of "non-empty" is `confirmed.length > 0`, not
    // "confirmed or bench". A bench with zero confirmed is a degenerate
    // state (bench only fills past maxPlayers), and in it the
    // announcement's literal ask — "Say IN to join. First 14 confirmed
    // play" — is still true: nobody has a playing spot and 14 are needed.
    const a = await announcement({
      matches: [
        match({
          attendances: [player("Elvin", 0, "BENCH"), player("Mustafa", 1, "BENCH")],
        }),
      ],
    });
    expect(a).not.toBeNull();
  });

  it("DROPPED players do not count as a squad", async () => {
    const a = await announcement({
      matches: [
        match({ attendances: [player("Elvin", 0, "DROPPED")] }),
      ],
    });
    expect(a).not.toBeNull();
  });
});

describe("announce-match — the pre-existing gates are undisturbed", () => {
  it("already sent → still suppressed (empty squad)", async () => {
    const a = await announcement({ sentKeys: ["match-tue-8-sep:announce-match"] });
    expect(a).toBeNull();
  });

  it("outside 09:00–12:59 London → still suppressed (empty squad)", async () => {
    // 14:00 London on 6 Sept.
    const a = await announcement({ now: new Date("2026-09-06T13:00:00.000Z") });
    expect(a).toBeNull();
  });

  it("inside 24h of kickoff → still suppressed (empty squad)", async () => {
    // 09:00 London on match day itself.
    const a = await announcement({ now: new Date("2026-09-08T08:00:00.000Z") });
    expect(a).toBeNull();
  });

  it("not the next match in the fixture → still suppressed (empty squad)", async () => {
    // An earlier live match in the same recurring fixture (same org,
    // venue, weekday) blocks next week's announcement.
    const thisWeek = match({
      id: "match-tue-1-sep",
      date: new Date("2026-09-01T20:30:00.000Z"),
    });
    const a = await announcement({ matches: [thisWeek, match()] });
    expect(a).toBeNull();
  });

  it("a non-UPCOMING status → still suppressed (empty squad)", async () => {
    const a = await announcement({
      matches: [match({ status: "TEAMS_PUBLISHED" })],
    });
    expect(a).toBeNull();
  });
});
