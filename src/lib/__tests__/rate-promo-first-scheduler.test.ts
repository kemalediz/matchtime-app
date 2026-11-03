/**
 * THE FIRST RATING POST EXPLAINS ITSELF, through the real scheduler
 * (Kemal, 2026-11-03). See rate-promo-first.test.ts for the copy.
 *
 * Drives the real `computeDuePosts` with Prisma mocked (the harness of
 * rating-dm-skips-players-who-rated.test.ts). The club's history is the
 * SentNotification keys the scheduler reads for all of its matches.
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

const FEATURES: Record<string, unknown> = {};
vi.mock("@/lib/org-features", () => ({
  getOrgFeatures: async () => ({ ...BASE_FEATURES, ...FEATURES }),
}));
const BASE_FEATURES = {
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
};

vi.mock("@/lib/message-analyzer", () => ({
  composeChaseText: async () => null,
}));

import { computeDuePosts } from "@/lib/bot-scheduler";

const LANG = { value: "en" };
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
        language: LANG.value,
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


const EVERY_DM = [KEMAL, SAIT, ...DID_NOTHING].map((u) => `${MATCH_ID}:rate-dm:${u}`);
const PROMO_KEY = `${MATCH_ID}:rate-promo`;

async function promo(opts: RunOpts = {}): Promise<Instruction | undefined> {
  const all = await run({ ...opts, sentKeys: [...EVERY_DM, ...(opts.sentKeys ?? [])] });
  return all.find((i) => i.key === PROMO_KEY);
}

beforeEach(() => {
  for (const k of Object.keys(overrides)) delete overrides[k];
  for (const k of Object.keys(FEATURES)) delete FEATURES[k];
  LANG.value = "en";
});

describe("the first rating post a club ever gets", () => {
  it("a club with no rating post in its history gets the long one, MoM sentence included", async () => {
    const p = await promo();
    expect(p?.kind).toBe("group-message");
    expect(p?.text).toContain("*Why rate?* I use the ratings to pick two balanced teams");
    expect(p?.text).toContain("I've just DM'd the players from the *Tuesday 7-a-side* on Tue 22 Sep");
    expect(p?.text).toContain("The same link is where you pick Man of the Match.");
    expect(p?.text).not.toContain("Just DM'd every player");
  });

  it("a club that has had one before (another match) gets today's short post", async () => {
    const p = await promo({ sentKeys: ["match-tue-15-sep:rate-promo"] });
    expect(p?.text).toContain("Just DM'd every player from the *Tuesday 7-a-side*");
    expect(p?.text).not.toContain("Why rate?");
  });

  it("an earlier relay to the organisers counts as having had it", async () => {
    const p = await promo({ sentKeys: ["match-tue-15-sep:rate-promo:u-admin"] });
    expect(p?.text).not.toContain("Why rate?");
  });

  it("organisers choose MoM: the long post without the MoM sentence", async () => {
    FEATURES.momChosenBy = "organisers";
    const p = await promo();
    expect(p?.text).toContain("Why rate?");
    expect(p?.text).not.toMatch(/Man of the Match|same link/);
  });

  it("a club whose teams MatchTime does not pick gets the short post: the 'why' would not be true", async () => {
    FEATURES.teamBalancing = false;
    const p = await promo();
    expect(p?.text).toContain("Just DM'd every player");
    expect(p?.text).not.toContain("Why rate?");
  });

  it("a Turkish club gets it in Turkish", async () => {
    LANG.value = "tr";
    const p = await promo();
    expect(p?.text).toContain("iki dengeli takım");
    expect(p?.text).not.toContain("Why rate?");
  });

  it("the key is unchanged, so the long post can only ever go once per match", async () => {
    expect(await promo({ sentKeys: [PROMO_KEY] })).toBeUndefined();
  });
});
