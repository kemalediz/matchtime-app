/**
 * TWO RATING REMINDERS, NOT FIVE (Kemal, 2026-10-18).
 *
 * Section 6d of `bot-scheduler.ts` used to remind every player who had not
 * rated at 18:00 London on every day of the five-day window. The owner's
 * rule: reminder 1 at 18:00 the day after the first DM, reminder 2 (the
 * last) two days later, then nothing. For a Tuesday-night match with the
 * first DM on Wednesday morning that is Thursday and Saturday, and
 * silence on Friday and Sunday.
 *
 * These tests drive the real `computeDuePosts` day by day, with Prisma
 * mocked (the pattern from rating-dm-skips-players-who-rated.test.ts),
 * carrying the keys each day really sent into the next day.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.AUTH_SECRET ??= "test-secret-for-magic-links";

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

const features = { momChosenBy: "players" as string };

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

const GROUP = "group-sutton@g.us";
const ORG = { id: "org-sutton", whatsappGroupId: GROUP, whatsappBotEnabled: true };
const MATCH_ID = "match-tue-22-sep";
/** Tue 22 Sept 2026, 21:30 London. */
const KICKOFF = new Date("2026-09-22T20:30:00.000Z");
/** Wed 23 Sept, 08:06 London: when the first rating DM went. */
const FIRST_DM_AT = new Date("2026-09-23T07:06:00.000Z");
const PLAYERS = ["u-0", "u-1"];

function match() {
  return {
    id: MATCH_ID,
    date: KICKOFF,
    status: "COMPLETED",
    maxPlayers: 8,
    isHistorical: false,
    activityId: "tuesday-7aside",
    attendanceDeadline: new Date(KICKOFF.getTime() - 4 * 3_600_000),
    postMatchEndFlow: true,
    paymentLinksReleasedAt: null,
    feePerPlayer: null,
    feePendingConfirm: null,
    redScore: 3,
    yellowScore: 2,
    attendances: PLAYERS.map((id, i) => ({
      id: `att-${i}`,
      userId: id,
      status: "CONFIRMED",
      position: i + 1,
      paidAt: null,
      directPendingAt: null,
      user: { id, name: i === 0 ? "Sait Demir" : "Erdal Ozkan", phoneNumber: `+44770090000${i}` },
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
      ratingWindowHours: 120,
      sport: { name: "Football 7-a-side", playersPerTeam: 7, teamLabels: null, mvpLabel: "Man of the Match" },
      org: { paymentCollectionEnabled: false, paymentHolderId: null, teamLabels: null, language: "en" },
    },
  };
}

interface Instruction {
  kind: string;
  key: string;
  targetUser?: string | null;
  text?: string;
}

/** Sent rows, carried from one simulated day to the next. */
let sent: Array<{ key: string; createdAt: Date }> = [];

async function tick(now: Date): Promise<Instruction[]> {
  overrides.organisation = { findFirst: async () => ORG };
  overrides.sentNotification = {
    findMany: async () => sent.map((s) => ({ ...s, targetUser: null })),
    findFirst: async () => null,
  };
  overrides.match = { findMany: async () => [match()] };
  const res = await computeDuePosts(GROUP, now);
  return ((res?.instructions ?? []) as Instruction[]).filter((i) => i.key.includes(":rate-reminder:"));
}

/** Run one tick and record what it sent, as the Pi's claim would. */
async function tickAndSend(now: Date): Promise<Instruction[]> {
  const out = await tick(now);
  for (const i of out) sent.push({ key: i.key, createdAt: now });
  return out;
}

const at1810 = (day: number) => new Date(`2026-09-${day}T17:10:00.000Z`);

beforeEach(() => {
  for (const k of Object.keys(overrides)) delete overrides[k];
  features.momChosenBy = "players";
  sent = PLAYERS.map((u) => ({ key: `${MATCH_ID}:rate-dm:${u}`, createdAt: FIRST_DM_AT }));
});

describe("a Tuesday match, first DM Wednesday morning", () => {
  it("reminds on Thursday and Saturday only: nothing Wednesday, Friday or Sunday", async () => {
    const byDay: Record<number, number> = {};
    for (const day of [23, 24, 25, 26, 27]) byDay[day] = (await tickAndSend(at1810(day))).length;
    expect(byDay).toEqual({ 23: 0, 24: 2, 25: 0, 26: 2, 27: 0 });
  });

  it("Thursday's is the first variant, Saturday's says it is the last", async () => {
    const thu = await tickAndSend(at1810(24));
    await tickAndSend(at1810(25));
    const sat = await tickAndSend(at1810(26));
    expect(thu[0].text).not.toMatch(/last reminder/i);
    expect(thu[0].text).toContain("Man of the Match");
    expect(sat[0].text).toMatch(/last reminder/i);
    expect(sat[0].text).toMatch(/close soon/i);
  });

  it("a second tick in the same 18:00 hour sends nothing more", async () => {
    expect(await tickAndSend(at1810(24))).toHaveLength(2);
    expect(await tickAndSend(new Date("2026-09-24T17:40:00.000Z"))).toHaveLength(0);
  });

  it("bot down on Thursday: one reminder Friday, the last on Sunday, never both at once", async () => {
    const counts = [];
    for (const day of [25, 26, 27]) counts.push((await tickAndSend(at1810(day))).length);
    expect(counts).toEqual([2, 0, 2]);
    expect(sent.filter((s) => s.key.includes(":rate-reminder:u-0:"))).toHaveLength(2);
  });

  it("a player who rated after the first reminder is not reminded again", async () => {
    await tickAndSend(at1810(24));
    overrides.rating = { findMany: async () => [{ raterId: "u-0" }] };
    const sat = await tick(at1810(26));
    expect(sat.map((i) => i.targetUser)).toEqual(["u-1"]);
  });

  it("organisers pick Man of the Match: neither reminder mentions it", async () => {
    features.momChosenBy = "organisers";
    const thu = await tickAndSend(at1810(24));
    const sat = await tickAndSend(at1810(26));
    expect(thu).toHaveLength(2);
    expect(sat).toHaveLength(2);
    for (const i of [...thu, ...sat]) expect(i.text).not.toContain("Man of the Match");
  });
});
