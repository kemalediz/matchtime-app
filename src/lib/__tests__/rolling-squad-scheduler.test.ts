/**
 * Rolling squad in the scheduler (plan 1.5 and 1.7), driven through the
 * real `computeDuePosts` with Prisma mocked (the proxy pattern of
 * announce-suppressed-when-squad-non-empty.test.ts).
 *
 *   R1  the morning announcement over a carried squad, once, instead of
 *       the cold "Say IN to join"; the cold one still fires when nobody
 *       was carried;
 *   R2  the 17:00 post carries the drop-out deadline line;
 *       a rolling club's scheduled chases use the fixed text and never
 *       call the model; a club without the setting (Sutton) still does;
 *   R3  the day-one intro's attendance line;
 *       recruit chase-ups skip carried players (they have a row).
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
  rollingSquad: true,
};
vi.mock("@/lib/org-features", () => ({ getOrgFeatures: async () => ({ ...features }) }));

const composeChaseText = vi.fn(async () => "MODEL TEXT");
vi.mock("@/lib/message-analyzer", () => ({
  composeChaseText: (...a: unknown[]) => composeChaseText(...(a as [])),
}));

import { computeDuePosts } from "@/lib/bot-scheduler";
import { buildRollingAnnouncePost, buildRollingDeadlineLine } from "@/lib/scheduler-copy";

const GROUP = "group-fnf@g.us";
const ORG = { id: "org-fnf", whatsappGroupId: GROUP, whatsappBotEnabled: true };

/** Fri 9 Oct 2026, 20:30 London (19:30 UTC, BST). */
const KICKOFF = new Date("2026-10-09T19:30:00.000Z");
/** Sat 3 Oct 2026 10:00 London: the morning after last week's match. */
const SAT_10AM = new Date("2026-10-03T09:00:00.000Z");
/** Mon 5 Oct 2026 17:05 London. */
const MON_5PM = new Date("2026-10-05T16:05:00.000Z");
/** Fri 9 Oct 2026 08:10 London: match-day morning chase window. */
const FRI_8AM = new Date("2026-10-09T07:10:00.000Z");
/** The match's own sign-up deadline (kickoff minus 5h): Fri 15:30 London. */
const DEADLINE = new Date("2026-10-09T14:30:00.000Z");

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

function match(over: Record<string, unknown> = {}) {
  return {
    id: "m-fri-9-oct",
    date: KICKOFF,
    status: "UPCOMING",
    maxPlayers: 18,
    isHistorical: false,
    activityId: "fri-9",
    attendanceDeadline: DEADLINE,
    rollingSeededAt: new Date("2026-10-03T07:00:00.000Z"),
    rollingSeededFromMatchId: "m-fri-2-oct",
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
      org: { paymentCollectionEnabled: false, paymentHolderId: null, teamLabels: null, language: "en" },
    },
    ...over,
  };
}

function setWorld(m: ReturnType<typeof match>, opts: { sent?: string[]; carried?: number } = {}) {
  for (const k of Object.keys(overrides)) delete overrides[k];
  overrides.organisation = { findFirst: async () => ORG };
  overrides.match = { findMany: async () => [m] };
  overrides.sentNotification = {
    // The sent-keys read has no `kind`; the recruit-invite read does.
    findMany: async (args: unknown) =>
      (args as { where?: { kind?: string } }).where?.kind ? [] : (opts.sent ?? []).map((key) => ({ key })),
  };
  overrides.attendanceEvent = { count: async () => opts.carried ?? 4 };
  // The one-time intro is not what these tests are about.
  overrides.activity = { count: async () => 0 };
}

async function instructions(now: Date) {
  const res = await computeDuePosts(GROUP, now);
  return res?.instructions ?? [];
}

beforeEach(() => {
  features.rollingSquad = true;
  composeChaseText.mockClear();
});

describe("R1: the rolling announcement", () => {
  it("fires once in the 09:00 to 12:59 window with the carried squad and the deadline", async () => {
    const m = match();
    setWorld(m);
    const out = await instructions(SAT_10AM);
    const ann = out.filter((i) => i.key === `${m.id}:rolling-announce`);
    expect(ann).toHaveLength(1);
    expect(ann[0]).toMatchObject({ kind: "group-message", matchId: m.id });
    expect((ann[0] as { text: string }).text).toBe(
      buildRollingAnnouncePost({
        activityName: "Friday 9-a-side",
        dateLabel: "Friday 9 October at 20:30",
        venue: "Powerleague",
        deadline: "Friday 15:30",
        confirmed: NAMES.map((name) => ({ name })),
        bench: [],
        maxPlayers: 18,
        lang: "en",
      }),
    );
    expect(out.some((i) => i.key === `${m.id}:announce-match`)).toBe(false);
  });

  it("not again once sent", async () => {
    const m = match();
    setWorld(m, { sent: [`${m.id}:rolling-announce`] });
    expect((await instructions(SAT_10AM)).some((i) => i.key.includes("announce"))).toBe(false);
  });

  it("not outside the window", async () => {
    const m = match();
    setWorld(m);
    expect((await instructions(new Date("2026-10-03T12:30:00.000Z"))).some((i) => i.key.includes("announce"))).toBe(
      false,
    );
  });

  it("the full-squad tail and the waiting list", async () => {
    const m = match({
      maxPlayers: 3,
      attendances: [...NAMES.slice(0, 3).map((n, i) => player(n, i)), player("Kemal", 3, "BENCH")],
    });
    setWorld(m);
    const text = ((await instructions(SAT_10AM)).find((i) => i.key === `${m.id}:rolling-announce`) as { text: string })
      .text;
    expect(text).toContain("*Waiting list (1):*\n1. Kemal");
    expect(text).toContain("The squad is full. Say *IN* to go on the waiting list.");
  });

  it("nobody carried: the cold announcement fires as today, the rolling one does not", async () => {
    const m = match({ attendances: [] });
    setWorld(m, { carried: 0 });
    const out = await instructions(SAT_10AM);
    expect(out.some((i) => i.key === `${m.id}:announce-match`)).toBe(true);
    expect(out.some((i) => i.key === `${m.id}:rolling-announce`)).toBe(false);
  });

  it("a club without the setting (Sutton) never gets it", async () => {
    features.rollingSquad = false;
    const m = match({ rollingSeededAt: null, rollingSeededFromMatchId: null });
    setWorld(m);
    const out = await instructions(SAT_10AM);
    expect(out.some((i) => i.key.includes("announce"))).toBe(false);
  });
});

describe("R2: the 17:00 post", () => {
  it("a rolling club's short-squad post is the fixed text plus the deadline line, no model call", async () => {
    const m = match();
    setWorld(m);
    const out = await instructions(MON_5PM);
    const post = out.find((i) => i.key.startsWith(`${m.id}:evening-update:`)) as { text: string } | undefined;
    expect(post).toBeDefined();
    expect(post!.text).toContain("need *14 more*");
    expect(post!.text).toContain(buildRollingDeadlineLine({ deadline: "Friday 15:30", lang: "en" }));
    expect(composeChaseText).not.toHaveBeenCalled();
  });

  it("a rolling club's full-squad post carries the deadline line too", async () => {
    const m = match({ maxPlayers: 4 });
    setWorld(m);
    const post = (await instructions(MON_5PM)).find((i) => i.key.startsWith(`${m.id}:evening-update:`)) as {
      text: string;
    };
    expect(post.text).toContain("squad is full");
    expect(post.text).toContain("Drop-out deadline: *Friday 15:30*.");
  });

  it("a club without the setting still asks the model, and gets no deadline line", async () => {
    features.rollingSquad = false;
    const m = match({ rollingSeededAt: null });
    setWorld(m);
    const post = (await instructions(MON_5PM)).find((i) => i.key.startsWith(`${m.id}:evening-update:`)) as {
      text: string;
    };
    expect(composeChaseText).toHaveBeenCalledTimes(1);
    expect(post.text).toBe("MODEL TEXT");
  });
});

describe("the scheduled chases use fixed text for a rolling club", () => {
  it("match-day morning: no model call for a rolling club", async () => {
    const m = match();
    setWorld(m);
    const out = await instructions(FRI_8AM);
    expect(out.some((i) => i.key.startsWith(`${m.id}:chase-match-day-morning:`))).toBe(true);
    expect(composeChaseText).not.toHaveBeenCalled();
  });

  it("match-day morning: still the model for Sutton", async () => {
    features.rollingSquad = false;
    const m = match({ rollingSeededAt: null });
    setWorld(m);
    await instructions(FRI_8AM);
    expect(composeChaseText).toHaveBeenCalled();
  });

  it("3 to 4 hours and 2 hours before kickoff: no model call for a rolling club", async () => {
    const m = match();
    setWorld(m);
    await instructions(new Date(KICKOFF.getTime() - 3.5 * 60 * 60 * 1000));
    await instructions(new Date(KICKOFF.getTime() - 1.5 * 60 * 60 * 1000));
    expect(composeChaseText).not.toHaveBeenCalled();
  });
});

describe("recruit chase-ups skip a carried player", () => {
  it("an invite on record, but the player has a row: no chase", async () => {
    const m = match();
    setWorld(m);
    overrides.sentNotification = {
      findMany: async (args: unknown) => {
        const where = (args as { where?: { kind?: string } }).where ?? {};
        if (where.kind === "recruit-dm") {
          return [{ targetUser: "u1", createdAt: new Date(MON_5PM.getTime() - 8 * 60 * 60 * 1000) }];
        }
        return [];
      },
    };
    overrides.user = { findMany: async () => [{ id: "u1", name: "Raihan", phoneNumber: "+447700900001" }] };
    overrides.attendance = { findMany: async () => [{ userId: "u1" }] };
    const out = await instructions(new Date(MON_5PM.getTime() - 3 * 60 * 60 * 1000));
    expect(out.some((i) => i.key.includes("recruit-chase"))).toBe(false);
  });
});

describe("R3: the day-one intro", () => {
  it("a rolling club's intro explains the rolling squad", async () => {
    const m = match();
    setWorld(m);
    overrides.activity = { count: async () => 1 };
    const intro = (await instructions(SAT_10AM)).find((i) => i.key === `org-${ORG.id}:bot-intro`) as { text: string };
    expect(intro.text).toContain("*Rolling squad*: if you played last time, you're in next time too.");
    expect(intro.text).not.toContain("*Attendance*");
  });
});
