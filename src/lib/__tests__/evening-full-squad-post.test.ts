/**
 * THE 17:00 POST WHEN THE SQUAD IS ALREADY FULL.
 *
 * Until now the evening update had nothing to say to a full squad. Its
 * branches were: match day with teams, match day with a full squad and
 * no teams, a short squad before the deadline, and (for a
 * payment-tracking org) an unpaid tail on its own. A full squad on a
 * Wednesday, in an org that does not track payments, fell off the end
 * of that chain and the bot said nothing at all. Verified against the
 * live database on 2026-09-17: Sutton FC's Tue 22 Sept match was 14/14,
 * `paymentTrackingEnabled` was false, and `computeDuePosts` returned
 * zero instructions at both 17:10 and 17:40.
 *
 * Kemal, 2026-09-17: "it is better to still list the squad even though
 * it is full, listing the benchers and asking for more bench people if
 * there are less than 3 players on the bench".
 *
 * So the branch posts the squad state instead of nothing: the roster
 * block the short-squad branch already uses (names and counts from the
 * rows, never from the model), the bench, and — while the bench is thin
 * and the org's bench feature is on — the approved squad-complete bench
 * invite. The unpaid tail still appends where it applies.
 *
 * These tests drive the real `computeDuePosts` with Prisma mocked (the
 * `vi.mock("@/lib/db")` pattern from
 * announce-suppressed-when-squad-non-empty.test.ts), so they exercise
 * the real branch chain rather than a copy of it. That matters most for
 * what must NOT happen: exactly one group message per evening window.
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

// Sutton FC's shape: every feature on except the payment ones. The
// bench flag is overridable per test — it gates the invite.
let benchFeature = true;
vi.mock("@/lib/org-features", () => ({
  getOrgFeatures: async () => ({
    botEnabled: true,
    attendance: true,
    bench: benchFeature,
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

// No network. The short-squad branch asks the composer for its text;
// returning null makes it fall back to the static template, which is
// what these tests assert on.
vi.mock("@/lib/message-analyzer", () => ({
  composeChaseText: async () => null,
}));

import { computeDuePosts } from "@/lib/bot-scheduler";
import { BENCH_THIN_BELOW, buildSquadFullEveningPost, buildSquadRosterBlock } from "@/lib/scheduler-copy";
import { buildSquadCompleteBenchInvite } from "@/lib/bench-offer-copy";

const GROUP = "group-sutton@g.us";
const ORG = { id: "org-sutton", whatsappGroupId: GROUP, whatsappBotEnabled: true };

/** Tue 22 Sept 2026, 21:30 London (= 20:30 UTC, BST). Tonight's fixture. */
const KICKOFF = new Date("2026-09-22T20:30:00.000Z");
/** Thu 17 Sept 2026, 17:10 London (= 16:10 UTC). The replayed tick. */
const FIVE_PM = new Date("2026-09-17T16:10:00.000Z");

const FOURTEEN = [
  "Kemal Ediz", "Elvin Aliyev", "Sait Demir", "Abid Hussain", "Idris Bello",
  "Wasim Akhtar", "Zair Malik", "Faris Nasser", "Habib Rahman", "Mojib Khan",
  "Ehtisham Ekin", "Baki Aydin", "Ersin Kaya", "David Ross",
];
const BENCHERS = ["Erdal Ozkan", "Amir Ahmadi", "Najib Ahmadi", "Karahan Yuce"];

function player(name: string, i: number, status: string) {
  return {
    id: `att-${i}-${status}`,
    status,
    position: i + 1,
    paidAt: null,
    directPendingAt: null,
    user: { id: `u-${i}-${status}`, name, phoneNumber: `+4477009000${String(i).padStart(2, "0")}` },
  };
}

function squad(confirmed: number, benched: number) {
  return [
    ...FOURTEEN.slice(0, confirmed).map((n, i) => player(n, i, "CONFIRMED")),
    ...BENCHERS.slice(0, benched).map((n, i) => player(n, i, "BENCH")),
  ];
}

function match(over: Record<string, unknown> = {}, language = "en") {
  return {
    id: "match-tue-22-sep",
    date: KICKOFF,
    status: "UPCOMING",
    maxPlayers: 14,
    isHistorical: false,
    activityId: "tuesday-7aside",
    // 18:00 London on match day, so every 17:00 tick before then is
    // "before the deadline".
    attendanceDeadline: new Date("2026-09-22T17:00:00.000Z"),
    attendances: squad(14, 0) as unknown[],
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
      org: { paymentCollectionEnabled: false, paymentHolderId: null, teamLabels: null, language },
    },
    ...over,
  };
}

interface Instruction {
  kind: string;
  key: string;
  text?: string;
}

/** Run the scheduler and return every instruction it produced. */
async function run(
  opts: {
    matches?: unknown[];
    sentKeys?: string[];
    now?: Date;
    /** `createdAt` for the `<matchId>:squad-locked` SentNotification. */
    squadLockedAt?: Date | null;
  } = {},
): Promise<Instruction[]> {
  overrides.organisation = { findFirst: async () => ORG };
  overrides.sentNotification = {
    findMany: async () =>
      (opts.sentKeys ?? []).map((key) => ({ key, targetUser: null, createdAt: new Date(0) })),
    findFirst: async () =>
      opts.squadLockedAt ? { createdAt: opts.squadLockedAt } : null,
  };
  overrides.match = { findMany: async () => opts.matches ?? [match()] };
  const res = await computeDuePosts(GROUP, opts.now ?? FIVE_PM);
  return (res?.instructions ?? []) as Instruction[];
}

/** The one evening-update group message, or null. */
async function evening(opts: Parameters<typeof run>[0] = {}): Promise<string | null> {
  const all = await run(opts);
  const posts = all.filter((i) => i.key.includes(":evening-update:"));
  expect(posts.length, "at most one evening-update instruction").toBeLessThanOrEqual(1);
  return posts[0]?.text ?? null;
}

beforeEach(() => {
  for (const k of Object.keys(overrides)) delete overrides[k];
  benchFeature = true;
});

describe("the full-squad 17:00 post", () => {
  it("THE ASK: a full squad with an EMPTY bench now posts the roster, the empty bench and the invite", async () => {
    const text = await evening();
    expect(text).not.toBeNull();
    // The roster is the database's, composed by the same builder the
    // short-squad branch uses.
    expect(text).toContain("*Confirmed (14/14):*");
    expect(text).toContain("1. Kemal Ediz");
    expect(text).toContain("14. David Ross");
    // The bench says it is empty rather than going missing.
    expect(text).toContain("*Bench (0):*");
    expect(text).toContain("_nobody yet_");
    // And it asks for benchers, in the approved words.
    expect(text).toContain(buildSquadCompleteBenchInvite({ lang: "en" }));
  });

  it("names the benchers when there are some, and still asks below the floor", async () => {
    const text = await evening({ matches: [match({ attendances: squad(14, 2) })] });
    expect(text).toContain("*Bench (2):*");
    expect(text).toContain("1. Erdal Ozkan");
    expect(text).toContain("2. Amir Ahmadi");
    expect(text).not.toContain("*Bench (0):*");
    expect(text).toContain(buildSquadCompleteBenchInvite({ lang: "en" }));
  });

  it(`stops asking at the floor: ${BENCH_THIN_BELOW} on the bench is enough cover`, async () => {
    const text = await evening({ matches: [match({ attendances: squad(14, 3) })] });
    expect(text).toContain("*Bench (3):*");
    expect(text).toContain("3. Najib Ahmadi");
    expect(text).not.toContain(buildSquadCompleteBenchInvite({ lang: "en" }));
  });

  it("a bench above the floor still gets its list, never the ask", async () => {
    const text = await evening({ matches: [match({ attendances: squad(14, 4) })] });
    expect(text).toContain("*Bench (4):*");
    expect(text).not.toContain(buildSquadCompleteBenchInvite({ lang: "en" }));
  });

  it("the ask is gated on the org's bench feature: off means squad and bench only", async () => {
    benchFeature = false;
    const text = await evening();
    expect(text).toContain("*Confirmed (14/14):*");
    expect(text).toContain("*Bench (0):*");
    // Promising to tag a bench the scheduler will never tag is a lie.
    expect(text).not.toContain(buildSquadCompleteBenchInvite({ lang: "en" }));
  });

  it("a Turkish org reads it in Turkish, with no English left in it", async () => {
    const text = await evening({ matches: [match({ attendances: squad(14, 1) }, "tr")] });
    expect(text).toContain("*Onaylananlar (14/14):*");
    expect(text).toContain("*Yedekler (1):*");
    expect(text).toContain(buildSquadCompleteBenchInvite({ lang: "tr" }));
    expect(text).not.toMatch(/\*Confirmed \(|\*Bench \(|Say \*IN\*|squad is full/);
  });
});

describe("one post per evening, and nothing else changed", () => {
  it("a short squad is untouched: the chase, no full-squad lead", async () => {
    const text = await evening({ matches: [match({ attendances: squad(11, 1) })] });
    expect(text).toContain("need *3 more*");
    expect(text).toContain("*Confirmed (11/14):*");
    expect(text).toContain("*Bench (1):*");
    expect(text).not.toContain("squad is full");
    expect(text).not.toContain(buildSquadCompleteBenchInvite({ lang: "en" }));
  });

  it("match day with teams generated is untouched: the lineup, not the squad post", async () => {
    // 17:10 London on match day itself, teams already generated.
    const text = await evening({
      now: new Date("2026-09-22T16:10:00.000Z"),
      matches: [
        match({
          status: "TEAMS_GENERATED",
          teamAssignments: FOURTEEN.map((n, i) => ({
            team: i % 2 === 0 ? "RED" : "YELLOW",
            user: { id: `u-${i}`, name: n },
          })),
        }),
      ],
    });
    expect(text).toContain("*Tonight at 21:30*");
    expect(text).not.toContain("squad is full");
    expect(text).not.toContain(buildSquadCompleteBenchInvite({ lang: "en" }));
  });

  it("match day with a full squad and no teams is untouched: the generate-teams nudge", async () => {
    const text = await evening({ now: new Date("2026-09-22T16:10:00.000Z") });
    expect(text).toContain("Squad is locked.");
    expect(text).not.toContain("squad is full");
  });

  it("the evening key still claims the whole window: once sent, nothing fires", async () => {
    const text = await evening({ sentKeys: ["match-tue-22-sep:evening-update:2026-09-17"] });
    expect(text).toBeNull();
  });

  it("outside 17:00-17:59 London nothing fires", async () => {
    const text = await evening({ now: new Date("2026-09-17T15:10:00.000Z") });
    expect(text).toBeNull();
  });

  it("NO DOUBLE-UP with squad-announce: the squad-complete post fired TODAY, so 17:00 stays quiet", async () => {
    // `announceSquadFullIfJustFilled` claims `<matchId>:squad-locked` and
    // queues its own BotJob the moment the last IN lands. A squad that
    // filled at 16:50 has already shown the group this roster and this
    // bench invite; posting it again at 17:10 is the same message twice.
    const text = await evening({ squadLockedAt: new Date("2026-09-17T15:50:00.000Z") });
    expect(text).toBeNull();
  });

  it("but a squad-complete post from an EARLIER day does not silence today's", async () => {
    const text = await evening({ squadLockedAt: new Date("2026-09-16T10:00:00.000Z") });
    expect(text).toContain("*Confirmed (14/14):*");
  });

  it("exactly ONE group message for this match in the window", async () => {
    const all = await run();
    const groupPosts = all.filter(
      (i) => i.kind === "group-message" && i.key.startsWith("match-tue-22-sep:"),
    );
    expect(groupPosts.map((i) => i.key)).toEqual([
      "match-tue-22-sep:evening-update:2026-09-17",
    ]);
  });
});

describe("buildSquadFullEveningPost (pure)", () => {
  const roster = (bench: string[]) =>
    buildSquadRosterBlock({
      confirmed: FOURTEEN.map((name) => ({ name })),
      bench: bench.map((name) => ({ name })),
      maxPlayers: 14,
      lang: "en",
    });
  const post = (benchNames: string[], invite: string | null) =>
    buildSquadFullEveningPost({
      activityName: "Tuesday 7-a-side",
      confirmedCount: 14,
      maxPlayers: 14,
      rosterBlock: roster(benchNames),
      benchCount: benchNames.length,
      benchInvite: invite,
      lang: "en",
    });

  it("the floor is a floor on the BENCH, and it is three", () => {
    expect(BENCH_THIN_BELOW).toBe(3);
    const invite = buildSquadCompleteBenchInvite({ lang: "en" });
    for (let n = 0; n < BENCH_THIN_BELOW; n++) {
      expect(post(BENCHERS.slice(0, n), invite), `bench of ${n}`).toContain(invite);
    }
    expect(post(BENCHERS.slice(0, BENCH_THIN_BELOW), invite)).not.toContain(invite);
  });

  it("no invite is offered when the caller has none (bench feature off)", () => {
    expect(post([], null)).not.toContain("🪑");
  });

  it("the empty-bench block is only added when the roster block has no bench", () => {
    expect(post([], null)).toContain("*Bench (0):*");
    expect(post(["Erdal Ozkan"], null)).not.toContain("*Bench (0):*");
  });
});
