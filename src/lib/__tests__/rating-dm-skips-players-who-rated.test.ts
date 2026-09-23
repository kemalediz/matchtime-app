/**
 * DO NOT ASK A PLAYER FOR SOMETHING THEY HAVE ALREADY DONE.
 *
 * The incident (Sutton FC, 2026-09-22). The match kicked off at 20:30 UTC.
 * Kemal submitted all 13 of his ratings and his Man of the Match vote at
 * 23:42 that night, through the web app; Sait did the same at 23:10. At
 * 07:06 UTC the next morning, 08:06 London and so the first tick past the
 * 08:00 gate, MatchTime DMed Kemal anyway: "Rate your teammates and pick
 * Man of the Match."
 *
 * The cause was in section 6b of `bot-scheduler.ts`. The rating-DM loop
 * skipped on three conditions only: no phone number, opted out of rating
 * DMs, and an existing idempotency breadcrumb. It never asked whether the
 * player had already rated. The 18:00 reminder in 6d did ask, and the
 * early Man of the Match trigger in 6e did too, so the first DM was the
 * one path in the post-match flow that could nag someone who was done.
 *
 * ENGAGED means: at least one Rating row, OR a MoMVote, for this match.
 * That is not a new definition invented here; it is the one 6d already
 * used to stop reminding a player and the one 6e already used to decide
 * the whole squad had engaged. All three now read it from one place, so
 * they cannot drift apart and disagree about the same player.
 *
 * These tests drive the real `computeDuePosts` with Prisma mocked, the
 * `vi.mock("@/lib/db")` pattern from mom-announcement-recovery.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.AUTH_SECRET ??= "test-secret-for-magic-links";

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

import { computeDuePosts } from "@/lib/bot-scheduler";

const GROUP = "group-sutton@g.us";
const ORG = { id: "org-sutton", whatsappGroupId: GROUP, whatsappBotEnabled: true };
const MATCH_ID = "match-tue-22-sep";

/** Tue 22 Sept 2026, 21:30 London (20:30 UTC, BST). The real fixture. */
const KICKOFF = new Date("2026-09-22T20:30:00.000Z");

/** 07:06 UTC the next morning: 08:06 London, the tick that DMed Kemal. */
const MORNING_AFTER = new Date("2026-09-23T07:06:00.000Z");

/** 17:10 UTC the next day: 18:10 London, the daily reminder hour in 6d. */
const REMINDER_HOUR = new Date("2026-09-23T17:10:00.000Z");

/**
 * Kemal and Sait are the two who rated on the night. The rest of the
 * squad did nothing, and are the ones a rating DM is actually for.
 */
const SQUAD = [
  "Kemal Ediz", "Sait Demir", "Erdal Ozkan", "Abid Hussain",
  "Idris Bello", "Wasim Akhtar", "Zair Malik", "Faris Nasser",
];
const KEMAL = "u-0";
const SAIT = "u-1";
const DID_NOTHING = ["u-2", "u-3", "u-4", "u-5", "u-6", "u-7"];

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

function match() {
  return {
    id: MATCH_ID,
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
    attendances: SQUAD.map(player) as unknown[],
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
      sport: {
        name: "Football 7-a-side",
        playersPerTeam: 7,
        teamLabels: null,
        mvpLabel: "Man of the Match",
      },
      org: {
        paymentCollectionEnabled: false,
        paymentHolderId: null,
        teamLabels: null,
        language: "en",
      },
    },
  };
}

interface Instruction {
  kind: string;
  key: string;
  targetUser?: string | null;
  text?: string;
}

interface RunOpts {
  now?: Date;
  /** Users with at least one Rating row for this match. */
  rated?: string[];
  /** Users with a MoMVote for this match. */
  votedMom?: string[];
  sentKeys?: string[];
}

async function run(opts: RunOpts = {}): Promise<Instruction[]> {
  const votedMom = opts.votedMom ?? [];
  overrides.organisation = { findFirst: async () => ORG };
  overrides.sentNotification = {
    findMany: async () =>
      (opts.sentKeys ?? []).map((key) => ({ key, targetUser: null, createdAt: new Date(0) })),
    findFirst: async () => null,
  };
  overrides.match = { findMany: async () => [match()] };
  overrides.moMVote = {
    findMany: async () => votedMom.map((voterId) => ({ voterId })),
    groupBy: async () =>
      votedMom.length > 0 ? [{ playerId: "u-2", _count: { playerId: votedMom.length } }] : [],
  };
  overrides.rating = {
    findMany: async () => (opts.rated ?? []).map((raterId) => ({ raterId })),
  };
  overrides.user = { findMany: async () => [{ id: "u-2", name: "Erdal Ozkan" }] };
  const res = await computeDuePosts(GROUP, opts.now ?? MORNING_AFTER);
  return (res?.instructions ?? []) as Instruction[];
}

/** Who is being asked to rate, by the initial 6b DM. */
async function rateDmTargets(opts: RunOpts = {}): Promise<string[]> {
  const all = await run(opts);
  return all
    .filter((i) => i.key.startsWith(`${MATCH_ID}:rate-dm:`))
    .map((i) => i.key.slice(`${MATCH_ID}:rate-dm:`.length));
}

/** Who is being chased by the 18:00 reminder in 6d. */
async function reminderTargets(opts: RunOpts = {}): Promise<string[]> {
  const all = await run({ now: REMINDER_HOUR, ...opts });
  return all
    .filter((i) => i.key.includes(":rate-reminder:"))
    .map((i) => i.key.split(":rate-reminder:")[1].split(":")[0]);
}

beforeEach(() => {
  for (const k of Object.keys(overrides)) delete overrides[k];
});

describe("the 2026-09-23 incident: DMed at 08:06 after rating at 23:42", () => {
  it("THE BUG: a player who rated everyone AND voted for MoM last night is not asked again", async () => {
    const targets = await rateDmTargets({
      rated: [KEMAL, SAIT],
      votedMom: [KEMAL, SAIT],
    });
    expect(targets, "Kemal finished at 23:42; nothing left to ask him").not.toContain(KEMAL);
    expect(targets).not.toContain(SAIT);
  });

  it("a player who has done nothing still gets exactly one DM", async () => {
    const targets = await rateDmTargets({
      rated: [KEMAL, SAIT],
      votedMom: [KEMAL, SAIT],
    });
    expect(targets.sort()).toEqual(DID_NOTHING);
    expect(targets.filter((t) => t === "u-2")).toHaveLength(1);
  });

  it("and no second DM on a later tick, once the breadcrumb exists", async () => {
    const targets = await rateDmTargets({
      rated: [KEMAL, SAIT],
      votedMom: [KEMAL, SAIT],
      sentKeys: DID_NOTHING.map((u) => `${MATCH_ID}:rate-dm:${u}`),
    });
    expect(targets, "every DM already sent, so the tick is silent").toEqual([]);
  });

  it("a squad where nobody has rated yet is untouched: everyone gets their DM", async () => {
    const targets = await rateDmTargets();
    expect(targets.sort()).toEqual([KEMAL, SAIT, ...DID_NOTHING]);
  });
});

describe("half-done still counts as done, because 6d and 6e already treat it that way", () => {
  it("ratings submitted but no MoM vote: no DM, since the 18:00 reminder would not chase them either", async () => {
    expect(await rateDmTargets({ rated: [KEMAL] })).not.toContain(KEMAL);
    expect(await reminderTargets({ rated: [KEMAL] })).not.toContain(KEMAL);
  });

  it("a MoM vote but no ratings: no DM, for the same reason", async () => {
    expect(await rateDmTargets({ votedMom: [KEMAL] })).not.toContain(KEMAL);
    expect(await reminderTargets({ votedMom: [KEMAL] })).not.toContain(KEMAL);
  });

  it("the morning DM and the 18:00 reminder never disagree about the same player", async () => {
    // Half-done in one direction each. Whatever the rule is, both paths
    // must apply it identically, or one goes quiet while the other nags.
    const opts = { rated: [KEMAL], votedMom: [SAIT] };
    const dmed = await rateDmTargets(opts);
    const reminded = await reminderTargets({
      ...opts,
      // The reminder only ever fires for a player who got the first DM.
      sentKeys: [KEMAL, SAIT, ...DID_NOTHING].map((u) => `${MATCH_ID}:rate-dm:${u}`),
    });
    expect(dmed).not.toContain(KEMAL);
    expect(dmed).not.toContain(SAIT);
    expect(reminded).not.toContain(KEMAL);
    expect(reminded).not.toContain(SAIT);
  });
});

describe("the group promo follows the DMs that were actually needed", () => {
  const promoKey = `${MATCH_ID}:rate-promo`;

  it("fires once every player who NEEDED a DM has one, without waiting on players who had already rated", async () => {
    const all = await run({
      rated: [KEMAL, SAIT],
      votedMom: [KEMAL, SAIT],
      // Only the six who needed a DM have a breadcrumb. Kemal and Sait
      // never will, because they were never DMed.
      sentKeys: DID_NOTHING.map((u) => `${MATCH_ID}:rate-dm:${u}`),
    });
    expect(all.map((i) => i.key)).toContain(promoKey);
  });

  it("does not fire while a needed DM is still outstanding", async () => {
    const all = await run({
      rated: [KEMAL, SAIT],
      votedMom: [KEMAL, SAIT],
      sentKeys: DID_NOTHING.slice(0, 3).map((u) => `${MATCH_ID}:rate-dm:${u}`),
    });
    expect(all.map((i) => i.key)).not.toContain(promoKey);
  });

  it("does not fire at all when the whole squad had already rated: it would be announcing DMs nobody got", async () => {
    const everyone = [KEMAL, SAIT, ...DID_NOTHING];
    const all = await run({ rated: everyone, votedMom: everyone });
    expect(all.filter((i) => i.key.startsWith(`${MATCH_ID}:rate-dm:`))).toEqual([]);
    expect(all.map((i) => i.key)).not.toContain(promoKey);
  });

  it("still fires for a squad where nobody had rated and every DM has landed", async () => {
    const all = await run({
      sentKeys: [KEMAL, SAIT, ...DID_NOTHING].map((u) => `${MATCH_ID}:rate-dm:${u}`),
    });
    expect(all.map((i) => i.key)).toContain(promoKey);
  });
});
