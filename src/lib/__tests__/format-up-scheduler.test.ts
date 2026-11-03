/**
 * GOING UP A SIZE WHEN TWO ARE ON THE BENCH (2026-11-03, the Vets play 6, 7
 * or 8 a side). With a maximum above the game's places, a full squad and
 * two waiting on the bench, MatchTime suggests the next size up in the
 * players' group, naming the organisers. Once per match per size; again
 * only after the bench drops below two and fills again.
 *
 * Driven through the real `computeDuePosts` with Prisma mocked (the harness
 * of min-players-scheduler.test.ts). No model, no network.
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
  squadMode: "weekly",
};
vi.mock("@/lib/org-features", () => ({ getOrgFeatures: async () => ({ ...features }) }));
vi.mock("@/lib/message-analyzer", () => ({ composeChaseText: async () => null }));
vi.mock("@/lib/admin-channel", async (orig) => ({
  ...(await orig<typeof import("@/lib/admin-channel")>()),
  loadAdminChannel: async () => null,
}));

import { computeDuePosts } from "@/lib/bot-scheduler";

const GROUP = "group-vets@g.us";
const ORG = { id: "org-vets", whatsappGroupId: GROUP, whatsappBotEnabled: true, paygPricePence: null };
/** Mon 9 Nov 2026, 20:30 London (GMT). */
const KICKOFF = new Date("2026-11-09T20:30:00.000Z");
/** Thu 5 Nov 2026, 14:00 London: an ordinary afternoon poll. */
const NOW = new Date("2026-11-05T14:00:00.000Z");
const MATCH_ID = "m-mon-9-nov";
const UP_KEY = `${MATCH_ID}:format-up:16:e0`;
const SETTLED = `${MATCH_ID}:format-up:16`;

function att(i: number, status = "CONFIRMED") {
  return {
    id: `att-${i}`,
    userId: `u${i}`,
    status,
    position: i + 1,
    paidAt: null,
    directPendingAt: null,
    paymentMethod: null,
    user: { id: `u${i}`, name: `Player ${i}`, phoneNumber: `+4477009000${String(i).padStart(2, "0")}` },
  };
}

function game(p: { confirmed: number; bench: number; maxPlayers?: number; actMax?: number | null; teams?: boolean; lang?: string }) {
  const attendances = [
    ...Array.from({ length: p.confirmed }, (_, i) => att(i)),
    ...Array.from({ length: p.bench }, (_, i) => att(p.confirmed + i, "BENCH")),
  ];
  return {
    id: MATCH_ID,
    date: KICKOFF,
    status: "UPCOMING",
    maxPlayers: p.maxPlayers ?? 14,
    isHistorical: false,
    activityId: "vets-mon",
    attendanceDeadline: new Date("2026-11-09T15:30:00.000Z"),
    rollingSeededAt: null,
    rollingSeededFromMatchId: null,
    attendances,
    teamAssignments: p.teams ? [{ userId: "u0", team: "RED", user: { id: "u0", name: "Player 0" } }] : [],
    benchConfirmations: [],
    benchSlotOffers: [],
    paymentCredits: [],
    activity: {
      id: "vets-mon",
      orgId: ORG.id,
      sportId: "sport-7s",
      name: "Football 7-a-side",
      venue: "Oaks Park High School football field",
      dayOfWeek: 1,
      matchDurationMins: 60,
      minPlayers: 12,
      maxPlayers: p.actMax === undefined ? 16 : p.actMax,
      sport: { name: "Football 7-a-side", playersPerTeam: 7, teamLabels: null },
      org: { paymentCollectionEnabled: false, paymentHolderId: null, teamLabels: null, language: p.lang ?? "en" },
    },
  };
}

let deleted: string[][] = [];
let marked: string[] = [];

async function run(m: unknown, opts: { sent?: string[]; choseBench?: string[] } = {}) {
  overrides.organisation = { findFirst: async () => ORG, findUnique: async () => ORG };
  overrides.match = { findMany: async () => [m] };
  overrides.sentNotification = {
    findMany: async (args: unknown) => {
      const where = (args as { where?: { key?: { startsWith?: string } } }).where ?? {};
      if (where.key?.startsWith) return [];
      return (opts.sent ?? []).map((key) => ({ key, targetUser: null, createdAt: new Date(0) }));
    },
    deleteMany: async (args: unknown) => {
      deleted.push(((args as { where: { key: { in: string[] } } }).where.key.in));
      return { count: 1 };
    },
    upsert: async (args: unknown) => {
      marked.push((args as { where: { key: string } }).where.key);
      return {};
    },
  };
  overrides.attendanceEvent = {
    findMany: async () => (opts.choseBench ?? []).map((userId) => ({ userId, note: "explicit bench request" })),
  };
  overrides.sport = { findUnique: async () => ({ name: "Football 7-a-side" }) };
  overrides.activity = { count: async () => 0, findMany: async () => [] };
  overrides.membership = {
    findFirst: async () => null,
    findMany: async (args: unknown) =>
      JSON.stringify(args).includes("OWNER") ? [{ user: { name: "Davide Russo" } }, { user: { name: "Shane Walton" } }] : [],
  };
  const res = await computeDuePosts(GROUP, NOW);
  return (res?.instructions ?? []) as Array<{ kind: string; key?: string; text?: string }>;
}

const ups = (out: Array<{ kind: string; key?: string; text?: string }>) => out.filter((i) => i.key?.includes(":format-up:"));

beforeEach(() => {
  for (const k of Object.keys(overrides)) delete overrides[k];
  deleted = [];
  marked = [];
});

describe("the suggestion to go up a size", () => {
  it("THE VETS: 14 in and 2 on the bench, up to 16 allowed: the suggestion, naming the organisers", async () => {
    const out = ups(await run(game({ confirmed: 14, bench: 2 })));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "group-message", key: UP_KEY });
    expect(out[0].text).toBe(
      "We've got 16 for Monday, 2 on the bench. Shall we go 8-a-side? Davide or Shane, reply *yes* to this message and I'll switch it.",
    );
  });

  it("Turkish", async () => {
    const out = ups(await run(game({ confirmed: 14, bench: 2, lang: "tr" })));
    expect(out[0].text).toContain("8'e 8 oynayalım mı?");
    expect(out[0].text).toContain("*evet*");
  });

  it("once per match per size: already suggested, nothing", async () => {
    expect(ups(await run(game({ confirmed: 14, bench: 3 }), { sent: [UP_KEY] }))).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it("the bench drops below two: a re-arm marker starts the next episode; nothing is deleted", async () => {
    expect(ups(await run(game({ confirmed: 14, bench: 1 }), { sent: [UP_KEY] }))).toEqual([]);
    expect(deleted).toEqual([]);
    expect(marked).toEqual([`${MATCH_ID}:format-up-rearm:1`]);
  });

  it("after the re-arm, two on the bench again: suggested again, in episode 1", async () => {
    const out = ups(await run(game({ confirmed: 14, bench: 2 }), { sent: [UP_KEY, `${MATCH_ID}:format-up-rearm:1`] }));
    expect(out.map((i) => i.key)).toEqual([`${MATCH_ID}:format-up:16:e1`]);
  });

  it("a size an organiser switched through (settled) is never suggested, and survives the bench emptying", async () => {
    expect(ups(await run(game({ confirmed: 14, bench: 2 }), { sent: [SETTLED] }))).toEqual([]);
    expect(ups(await run(game({ confirmed: 14, bench: 0 }), { sent: [SETTLED] }))).toEqual([]);
    expect(deleted).toEqual([]);
    expect(marked).toEqual([]);
  });

  it("a bench player who asked to be on the bench does not count", async () => {
    expect(ups(await run(game({ confirmed: 14, bench: 2 }), { choseBench: ["u15"] }))).toEqual([]);
  });

  it("REGRESSION GUARD: no maximum set (every club today): never", async () => {
    expect(ups(await run(game({ confirmed: 14, bench: 4, actMax: null })))).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it("already at the maximum: nothing", async () => {
    expect(ups(await run(game({ confirmed: 16, bench: 2, maxPlayers: 16 })))).toEqual([]);
  });

  it("a squad not full yet, or the teams out: nothing", async () => {
    expect(ups(await run(game({ confirmed: 13, bench: 2 })))).toEqual([]);
    expect(ups(await run(game({ confirmed: 14, bench: 2, teams: true })))).toEqual([]);
  });
});
