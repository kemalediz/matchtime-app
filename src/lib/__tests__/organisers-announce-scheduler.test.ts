/**
 * "Who announces the list and teams" = "The organisers" in the scheduler
 * (2026-10-14, list-announcer.ts), driven through the real
 * `computeDuePosts` with Prisma mocked (the proxy pattern of
 * weekly-deadlines-scheduler.test.ts).
 *
 * Every scheduled post that lists the squad goes to the club's ADMIN
 * channel instead of the players' group, written for the admins; no team
 * sheet is posted in the players' group; and a club on "MatchTime" (the
 * default, Sutton FC) gets exactly the instructions it got before.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

const features: Record<string, unknown> = {};
function resetFeatures() {
  for (const k of Object.keys(features)) delete features[k];
  Object.assign(features, {
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
  });
}
vi.mock("@/lib/org-features", () => ({ getOrgFeatures: async () => ({ ...features }) }));

const composeChaseText = vi.fn(async () => "MODEL TEXT");
vi.mock("@/lib/message-analyzer", () => ({
  composeChaseText: (...a: unknown[]) => composeChaseText(...(a as [])),
}));

const graphics = vi.hoisted(() => ({ sendGraphicToAdminChannel: vi.fn(async () => ({ queued: true, jobId: "g" })) }));
vi.mock("@/lib/admin-group-graphics", () => graphics);
// The "Teams ready" hook (team-proposal.ts) has its own tests.
vi.mock("@/lib/team-proposal", () => ({ teamProposalJobs: async () => 0 }));
// The badges post's own rules are tested in badge-announcements.test.ts;
// here only where it goes. Empty unless a test sets it.
const badges = vi.hoisted(() => ({ posts: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/badge-announcement-scheduler", async (orig) => ({
  ...(await orig<object>()),
  computeBadgeAnnouncements: async () => badges.posts.map((p) => ({ ...p })),
}));

// Who was left out after a cancelled week (2026-10-24): its own tests
// are in rolling-squad.test.ts; here only that the post names them.
const leftOutMock = vi.hoisted(() => ({ names: [] as string[] }));
vi.mock("@/lib/rolling-squad", () => ({
  loadRollingLeftOut: async () => leftOutMock.names.map((name, i) => ({ userId: `lo${i}`, name })),
  rollingSeedPendingAt: async () => null,
}));

import { computeDuePosts, type DueInstruction } from "@/lib/bot-scheduler";
import { buildOrganiserListUpdate, buildOrganiserRelay } from "@/lib/organisers-list-copy";
import { buildGearReminder } from "@/lib/scheduler-copy";
import { buildRatePromoPost } from "@/lib/group-copy";

const GROUP = "group-fnf@g.us";
const ADMIN_GROUP = "admins-fnf@g.us";
const ORG = { id: "org-fnf", whatsappGroupId: GROUP, whatsappBotEnabled: true };

/** Fri 9 Oct 2026, 20:30 London (19:30 UTC, BST). */
const KICKOFF = new Date("2026-10-09T19:30:00.000Z");
const SIGNUP_DEADLINE = new Date("2026-10-09T14:30:00.000Z");
const MON_1005 = new Date("2026-10-05T09:05:00.000Z");
const MON_1705 = new Date("2026-10-05T16:05:00.000Z");
const MON_1805 = new Date("2026-10-05T17:05:00.000Z");
const TUE_2005 = new Date("2026-10-06T19:05:00.000Z");
const FRI_0805 = new Date("2026-10-09T07:05:00.000Z");
const FRI_1700 = new Date("2026-10-09T16:00:00.000Z");
const FRI_1705 = new Date("2026-10-09T16:05:00.000Z");
const FRI_1830 = new Date("2026-10-09T17:30:00.000Z");

const FNF_DEADLINES = {
  dropOutDeadlineDay: 1,
  dropOutDeadlineTime: "21:00",
  listPublishDay: 2,
  listPublishTime: "20:00",
};
const NO_DEADLINES = {
  dropOutDeadlineDay: null,
  dropOutDeadlineTime: null,
  listPublishDay: null,
  listPublishTime: null,
};

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

function match(club: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    id: "m-fri-9-oct",
    date: KICKOFF,
    status: "UPCOMING",
    maxPlayers: 18,
    isHistorical: false,
    activityId: "fri-9",
    attendanceDeadline: SIGNUP_DEADLINE,
    rollingSeededAt: null as Date | null,
    rollingSeededFromMatchId: null as string | null,
    postMatchEndFlow: true,
    attendances: NAMES.map((n, i) => player(n, i)) as ReturnType<typeof player>[],
    teamAssignments: [] as unknown[],
    benchConfirmations: [] as unknown[],
    benchSlotOffers: [] as unknown[],
    paymentCredits: [] as unknown[],
    activity: {
      id: "fri-9",
      orgId: ORG.id,
      name: "FNF",
      venue: "Powerleague",
      dayOfWeek: 5,
      matchDurationMins: 60,
      sportId: "s9",
      sport: { name: "Football 9-a-side", playersPerTeam: 9, teamLabels: null, mvpLabel: "MoM" },
      org: {
        paymentCollectionEnabled: false,
        paymentHolderId: null,
        paymentTrackingEnabled: false,
        teamLabels: null,
        language: "en",
        ...club,
      },
    },
    ...over,
  };
}

const OWNER = { id: "admin-owner", name: "Owner", phoneNumber: "+447700111111", role: "OWNER" };
const ADMIN2 = { id: "admin-two", name: "Second", phoneNumber: "+447700222222", role: "ADMIN" };

function setWorld(
  ms: ReturnType<typeof match>[],
  opts: { sent?: string[]; carried?: number; channelMode?: string; adminGroupId?: string | null } = {},
) {
  for (const k of Object.keys(overrides)) delete overrides[k];
  overrides.organisation = {
    findFirst: async () => ORG,
    findUnique: async () => ({
      id: ORG.id,
      name: "FNF",
      language: "en",
      adminChannelMode: opts.channelMode ?? "admin-group",
      adminChannelUserId: null,
      adminGroupId: opts.adminGroupId === undefined ? ADMIN_GROUP : opts.adminGroupId,
    }),
  };
  overrides.membership = {
    findMany: async (args: unknown) => {
      const where = (args as { where?: { role?: unknown } }).where;
      if (!where?.role) return [];
      return [OWNER, ADMIN2].map((a) => ({ role: a.role, user: { id: a.id, name: a.name, phoneNumber: a.phoneNumber } }));
    },
  };
  overrides.match = { findMany: async () => ms };
  overrides.sentNotification = {
    findMany: async (args: unknown) =>
      (args as { where?: { kind?: unknown; key?: unknown } }).where?.kind ||
      (args as { where?: { key?: unknown } }).where?.key
        ? []
        : (opts.sent ?? []).map((key) => ({ key })),
    findFirst: async () => null,
  };
  overrides.attendanceEvent = { count: async () => opts.carried ?? 0 };
  overrides.activity = { count: async () => 0, findMany: async () => [] };
  // The club has played and been rated before, so the one-off
  // seed-rating nudge (seed-nudge.ts, its own tests) is not due here.
  overrides.rating = { findFirst: async () => ({ id: "r-earlier" }) };
}

const GROUP_CAPS = { adminGroup: true };

async function instructions(now: Date, caps = GROUP_CAPS): Promise<DueInstruction[]> {
  const res = await computeDuePosts(GROUP, now, caps);
  return res?.instructions ?? [];
}

const groupPosts = (out: DueInstruction[]) => out.filter((i) => i.kind === "group-message");
const adminPosts = (out: DueInstruction[]) =>
  out.filter((i): i is Extract<DueInstruction, { kind: "admin-group-message" }> => i.kind === "admin-group-message");
const byKey = (out: DueInstruction[], key: string) => out.find((i) => i.key === key) as (DueInstruction & { text?: string }) | undefined;

const ADMIN_TEXT = (reason: Parameters<typeof buildOrganiserListUpdate>[0]["reason"], extra: Record<string, unknown> = {}) =>
  buildOrganiserListUpdate({
    reason,
    activityName: "FNF",
    whenLabel: "Fri 9 Oct at 20:30",
    confirmed: NAMES.map((name) => ({ name })),
    bench: [],
    maxPlayers: 18,
    lang: "en",
    ...extra,
  });

beforeEach(() => {
  resetFeatures();
  composeChaseText.mockClear();
  badges.posts = [];
});

describe("the default (MatchTime announces) is exactly what it was", () => {
  const cases: Array<[string, Date, Record<string, unknown>, Record<string, unknown>]> = [
    ["17:00 short squad", MON_1705, NO_DEADLINES, {}],
    ["the drop-out reminder", MON_1805, FNF_DEADLINES, {}],
    ["the final list", TUE_2005, FNF_DEADLINES, {}],
    ["the morning chase", FRI_0805, NO_DEADLINES, {}],
    ["the 3h chase", FRI_1700, NO_DEADLINES, {}],
    ["the 2h last call", FRI_1830, NO_DEADLINES, {}],
    ["the cold announcement", MON_1005, NO_DEADLINES, { attendances: [] }],
  ];
  for (const [label, now, club, over] of cases) {
    it(`${label}: absent setting and "matchtime" give identical instructions, and they post in the group`, async () => {
      setWorld([match(club, over)]);
      const before = await instructions(now);
      features.listAnnouncer = "matchtime";
      setWorld([match(club, over)]);
      const after = await instructions(now);
      expect(after).toEqual(before);
      expect(groupPosts(after).length).toBeGreaterThan(0);
      expect(adminPosts(after)).toHaveLength(0);
    });
  }

  it("MatchTime announces: the final list queues no poster", async () => {
    graphics.sendGraphicToAdminChannel.mockClear();
    setWorld([match(FNF_DEADLINES)]);
    await instructions(TUE_2005);
    expect(graphics.sendGraphicToAdminChannel).not.toHaveBeenCalled();
  });
});

describe("MatchTime announces, after a cancelled week: the left-out names go to the organisers only (2026-10-24)", () => {
  beforeEach(() => {
    features.listAnnouncer = "matchtime";
    features.rollingSquad = true;
  });
  afterEach(() => {
    leftOutMock.names = [];
  });

  it("the group post names nobody; the organisers get their own notice, once, on its own key", async () => {
    leftOutMock.names = ["Mo", "Feroz", "Yaseen"];
    const m = match(NO_DEADLINES, { rollingSeededAt: new Date("2026-10-03T08:00:00.000Z") });
    setWorld([m], { carried: 4 });
    const out = await instructions(MON_1005);
    const group = byKey(out, `${m.id}:rolling-announce`);
    expect(group?.kind).toBe("group-message");
    expect(group?.text).not.toMatch(/Mo|Feroz|Yaseen/);
    const key = `${m.id}:rolling-announce-left-out`;
    expect(byKey(out, key)).toEqual({
      kind: "admin-group-message",
      key,
      matchId: m.id,
      groupId: ADMIN_GROUP,
      text:
        "📋 *FNF, Fri 9 Oct at 20:30*: the squad carried over from last week is posted in the group.\n\n" +
        "Left off this week's squad because they said *OUT* or were taken off the list last week:\n• Mo\n• Feroz\n• Yaseen\n\n" +
        "To put any of them back, just say their name and *IN*, for example *Mo IN*.",
    });
    setWorld([m], { carried: 4, sent: [`${m.id}:rolling-announce`, key] });
    expect((await instructions(MON_1005)).some((i) => i.key === key)).toBe(false);
  });

  it("nobody left out: no organiser notice", async () => {
    const m = match(NO_DEADLINES, { rollingSeededAt: new Date("2026-10-03T08:00:00.000Z") });
    setWorld([m], { carried: 4 });
    const out = await instructions(MON_1005);
    expect(byKey(out, `${m.id}:rolling-announce`)?.kind).toBe("group-message");
    expect(out.some((i) => i.key.includes("rolling-announce-left-out"))).toBe(false);
  });
});

describe('"The organisers": the squad posts go to the admin group', () => {
  beforeEach(() => {
    features.listAnnouncer = "organisers";
  });

  it("17:00, squad short: one admin-group post on the same key, no group post, no model call", async () => {
    const m = match(NO_DEADLINES);
    setWorld([m]);
    const out = await instructions(MON_1705);
    const key = `${m.id}:evening-update:2026-10-05`;
    expect(byKey(out, key)).toEqual({ kind: "admin-group-message", key, matchId: m.id, groupId: ADMIN_GROUP, text: ADMIN_TEXT("evening") });
    expect(groupPosts(out).filter((i) => i.key.includes("evening-update"))).toHaveLength(0);
    expect(composeChaseText).not.toHaveBeenCalled();
    // The group never saw a roster, so nothing is marked as shown.
    expect(out.some((i) => "rosterShown" in i)).toBe(false);
  });

  it("17:00, squad full: the admins get the full squad", async () => {
    const m = match(NO_DEADLINES, { maxPlayers: 4 });
    setWorld([m]);
    const out = await instructions(MON_1705);
    const post = byKey(out, `${m.id}:evening-update:2026-10-05`);
    expect(post?.kind).toBe("admin-group-message");
    expect(post?.text).toContain("4 of 4 in, full.");
    expect(groupPosts(out)).toHaveLength(0);
  });

  it("17:00, already sent to the admin group: nothing again", async () => {
    const m = match(NO_DEADLINES);
    setWorld([m], { sent: [`${m.id}:evening-update:2026-10-05`] });
    const out = await instructions(MON_1705);
    expect(out.filter((i) => i.key.includes("evening-update"))).toHaveLength(0);
  });

  it("match day with teams: no line-ups in the players' group, and none to the admins either", async () => {
    const m = match(NO_DEADLINES, {
      status: "TEAMS_GENERATED",
      teamAssignments: NAMES.map((n, i) => ({ userId: `u${i}`, team: i % 2 ? "RED" : "YELLOW", user: { id: `u${i}`, name: n } })),
    });
    setWorld([m]);
    const out = await instructions(FRI_1705);
    expect(out.filter((i) => i.key.includes("evening-update"))).toHaveLength(0);
    expect(groupPosts(out).some((i) => /Hamzah|Raihan/.test((i as { text: string }).text))).toBe(false);
  });

  it("match day, full squad, no teams yet: the admins get the squad, the group nothing", async () => {
    const m = match(NO_DEADLINES, { maxPlayers: 4 });
    setWorld([m]);
    const out = await instructions(FRI_1705);
    const post = byKey(out, `${m.id}:evening-update:2026-10-09`);
    expect(post?.kind).toBe("admin-group-message");
    expect(groupPosts(out).filter((i) => i.key.includes("evening-update"))).toHaveLength(0);
  });

  it("the drop-out reminder goes to the admins with the deadline time", async () => {
    const m = match(FNF_DEADLINES);
    setWorld([m]);
    const out = await instructions(MON_1805);
    const key = `${m.id}:dropout-reminder`;
    expect(byKey(out, key)).toEqual({
      kind: "admin-group-message",
      key,
      matchId: m.id,
      groupId: ADMIN_GROUP,
      text: ADMIN_TEXT("dropout-reminder", { dropOutTime: "21:00" }),
    });
    expect(groupPosts(out)).toHaveLength(0);
  });

  it("the final list (listPublish) goes to the admins", async () => {
    const m = match(FNF_DEADLINES);
    setWorld([m]);
    const out = await instructions(TUE_2005);
    const key = `${m.id}:list-published`;
    expect(byKey(out, key)?.kind).toBe("admin-group-message");
    expect(byKey(out, key)?.text).toBe(ADMIN_TEXT("list-published"));
    expect(groupPosts(out)).toHaveLength(0);
  });

  // Kemal, 2026-10-30: a poster only when asked, tagged. The final list
  // still goes to the organisers; no list poster comes with it.
  it("the final list queues no list poster on its own", async () => {
    graphics.sendGraphicToAdminChannel.mockClear();
    const m = match(FNF_DEADLINES);
    setWorld([m]);
    const out = await instructions(TUE_2005);
    expect(byKey(out, `${m.id}:list-published`)?.kind).toBe("admin-group-message");
    expect(graphics.sendGraphicToAdminChannel).not.toHaveBeenCalled();
  });

  it("no final list due: no poster", async () => {
    graphics.sendGraphicToAdminChannel.mockClear();
    setWorld([match(FNF_DEADLINES)]);
    await instructions(MON_1805);
    expect(graphics.sendGraphicToAdminChannel).not.toHaveBeenCalled();
  });

  it("the rolling squad's announcement goes to the admins", async () => {
    features.rollingSquad = true;
    const m = match(NO_DEADLINES, { rollingSeededAt: new Date("2026-10-03T08:00:00.000Z") });
    setWorld([m], { carried: 4 });
    const out = await instructions(MON_1005);
    const key = `${m.id}:rolling-announce`;
    expect(byKey(out, key)?.kind).toBe("admin-group-message");
    expect(byKey(out, key)?.text).toBe(ADMIN_TEXT("announce"));
    expect(groupPosts(out)).toHaveLength(0);
  });

  it("after a cancelled week, the admins' rolling notice names who was left out for saying OUT (2026-10-24)", async () => {
    features.rollingSquad = true;
    leftOutMock.names = ["Yaseen", "Mo", "Feroz"];
    try {
      const m = match(NO_DEADLINES, { rollingSeededAt: new Date("2026-10-03T08:00:00.000Z") });
      setWorld([m], { carried: 4 });
      const out = await instructions(MON_1005);
      const text = byKey(out, `${m.id}:rolling-announce`)?.text ?? "";
      expect(text).toContain(
        "Left off this week's squad because they said *OUT* or were taken off the list last week:\n• Yaseen\n• Mo\n• Feroz\n\nTo put any of them back, just say their name and *IN*, for example *Yaseen IN*.",
      );
      expect(groupPosts(out)).toHaveLength(0);
      // Inside the one notice: no separate left-out notice as well.
      expect(out.some((i) => i.key.includes("rolling-announce-left-out"))).toBe(false);
    } finally {
      leftOutMock.names = [];
    }
  });

  it("the cold announcement goes to the admins", async () => {
    const m = match(NO_DEADLINES, { attendances: [] });
    setWorld([m]);
    const out = await instructions(MON_1005);
    const key = `${m.id}:announce-match`;
    expect(byKey(out, key)?.kind).toBe("admin-group-message");
    expect(byKey(out, key)?.text).toContain("0 of 18 in, 18 spaces.");
    expect(groupPosts(out)).toHaveLength(0);
  });

  it("the 3h chase and the 2h last call go to the admins, with no model call", async () => {
    const m = match(NO_DEADLINES);
    setWorld([m]);
    const chase = await instructions(FRI_1700);
    expect(byKey(chase, `${m.id}:chase-pre-kickoff`)?.kind).toBe("admin-group-message");
    expect(byKey(chase, `${m.id}:chase-pre-kickoff`)?.text).toBe(ADMIN_TEXT("chase"));
    setWorld([m]);
    const last = await instructions(FRI_1830);
    expect(byKey(last, `${m.id}:pre-kickoff`)?.kind).toBe("admin-group-message");
    expect(composeChaseText).not.toHaveBeenCalled();
  });

  it("the 08:00 chase is held from an admin group (its hours start at 09:00), and never posts in the players' group", async () => {
    const m = match(NO_DEADLINES);
    setWorld([m]);
    const out = await instructions(FRI_0805);
    expect(out.filter((i) => i.key.includes("chase-match-day-morning"))).toHaveLength(0);
  });
});

describe('"The organisers" with no admin group the Pi can post in: the existing fallback', () => {
  beforeEach(() => {
    features.listAnnouncer = "organisers";
  });

  it("an older Pi (no admin-group capability): the owner by DM, keyed per recipient", async () => {
    const m = match(NO_DEADLINES);
    setWorld([m]);
    const out = await instructions(MON_1705, { adminGroup: false });
    const key = `${m.id}:evening-update:2026-10-05:${OWNER.id}`;
    expect(byKey(out, key)).toMatchObject({ kind: "dm", key, phone: "447700111111", targetUser: OWNER.id, text: ADMIN_TEXT("evening") });
    expect(groupPosts(out)).toHaveLength(0);
  });

  it("each admin by DM: one DM per admin; the 08:00 chase is not held", async () => {
    const m = match(NO_DEADLINES);
    setWorld([m], { channelMode: "each-admin", adminGroupId: null });
    const out = await instructions(FRI_0805);
    const dms = out.filter((i) => i.key.startsWith(`${m.id}:chase-match-day-morning:2026-10-09:`));
    expect(dms.map((i) => i.key).sort()).toEqual(
      [`${m.id}:chase-match-day-morning:2026-10-09:${ADMIN2.id}`, `${m.id}:chase-match-day-morning:2026-10-09:${OWNER.id}`].sort(),
    );
    expect(dms.every((i) => i.kind === "dm")).toBe(true);
    expect(groupPosts(out)).toHaveLength(0);
  });

  it("a recipient already told is not told again", async () => {
    const m = match(NO_DEADLINES);
    setWorld([m], { channelMode: "each-admin", adminGroupId: null, sent: [`${m.id}:evening-update:2026-10-05:${OWNER.id}`] });
    const out = await instructions(MON_1705);
    expect(out.filter((i) => i.key.includes("evening-update")).map((i) => i.key)).toEqual([
      `${m.id}:evening-update:2026-10-05:${ADMIN2.id}`,
    ]);
  });
});

// ── "New players to review" says how each got there (2026-10-14) ─────
//   The FNF rehearsal: a player an organiser pasted into a list was
//   reported as "auto-added after posting in the group". Whether a
//   provisional player posted is read from `AnalyzedMessage.authorUserId`.

describe("the 'New players to review' notice", () => {
  function withProvisional(authoredUserIds: string[]) {
    const roles = overrides.membership.findMany;
    overrides.membership = {
      findMany: async (args: unknown) => {
        const where = (args as { where?: { provisionallyAddedAt?: unknown } }).where;
        if (where?.provisionallyAddedAt) {
          return [
            { userId: "p-posted", provisionallyAddedAt: new Date("2026-10-04T18:00:01.000Z"), user: { name: "Poster Pete" } },
            { userId: "p-listed", provisionallyAddedAt: new Date("2026-10-04T18:00:00.000Z"), user: { name: "Listed Larry" } },
          ];
        }
        return roles(args);
      },
    };
    overrides.analyzedMessage = {
      findMany: async () => authoredUserIds.map((authorUserId) => ({ authorUserId })),
    };
  }
  const notice = (out: DueInstruction[]) =>
    adminPosts(out).find((i) => i.key.startsWith(`org-${ORG.id}:provisional-review:`)) as { text?: string } | undefined;

  it("a pasted player is 'added by name', a poster 'posted in the group'", async () => {
    setWorld([match(NO_DEADLINES)]);
    withProvisional(["p-posted"]);
    const text = notice(await instructions(MON_1005))?.text;
    expect(text).toContain("2 people were added automatically.");
    expect(text).toContain("Posted in the group: Poster Pete\nAdded by name, from a list or someone else's message: Listed Larry");
    expect(text).not.toContain("auto-added after posting in the group");
  });

  it("once per player: the next day, the same two players get no second notice", async () => {
    setWorld([match(NO_DEADLINES)]);
    withProvisional(["p-posted"]);
    const first = notice(await instructions(MON_1005)) as { key: string } | undefined;
    expect(first?.key).toBe(`org-${ORG.id}:provisional-review:admin-group:p${Date.parse("2026-10-04T18:00:01.000Z")}`);
    setWorld([match(NO_DEADLINES)], { sent: [first!.key] });
    withProvisional(["p-posted"]);
    expect(notice(await instructions(TUE_2005))).toBeUndefined();
  });

  it("Turkish", async () => {
    features.language = "tr";
    setWorld([match({ ...NO_DEADLINES, language: "tr" })]);
    overrides.organisation.findUnique = async () => ({
      id: ORG.id,
      name: "FNF",
      language: "tr",
      adminChannelMode: "admin-group",
      adminChannelUserId: null,
      adminGroupId: ADMIN_GROUP,
    });
    withProvisional([]);
    const text = notice(await instructions(MON_1005))?.text;
    expect(text).toContain("Bir listeden ya da başkasının mesajından adıyla eklendi: Poster Pete, Listed Larry");
  });
});

// ── The rating notice and the badges post (2026-10-14) ──
//   Kemal, after the club rehearsal: for a club whose organisers announce,
//   these two went to the admin channel, not the players' group, under the
//   relay lead ("For the organisers, not posted in the players' group:")
//   so the organisers can forward them. The go-live hello, the payments
//   poll, the score ask and the Man of the Match result stay in the group.
//   The rating DMs themselves still go to every player.
//   Badges moved back (Kemal, 2026-10-16): the badges post goes in the
//   players' group for every club, whoever announces. Only the rating
//   notice is still relayed to the admins.
//
//   The match-day gear reminder is NOT moved (Kemal, 2026-10-15): it is a
//   club setting (`featureGearReminder`, OFF for a new club, ON for every
//   existing one), the same for every club whoever announces. Off: it is
//   not sent anywhere.

/** Sat 10 Oct 2026, 09:05 London: the morning after, inside the admin group's hours. */
const SAT_0905 = new Date("2026-10-10T08:05:00.000Z");
/** Sun 11 Oct 2026, 18:05 London: the badges post's evening. */
const SUN_1805 = new Date("2026-10-11T17:05:00.000Z");

const GEAR_KEY = (m: { id: string }) => `${m.id}:football-gear-reminder`;
const PROMO_KEY = (m: { id: string }) => `${m.id}:rate-promo`;
const BADGES_KEY = (m: { id: string }) => `${m.id}:badges`;
const RATE_DM_KEYS = (m: { id: string }) => NAMES.map((_, i) => `${m.id}:rate-dm:u${i}`);
const GEAR_TEXT = (lang: string) => buildGearReminder({ timeLabel: "20:30", venue: "Powerleague", lang });
const PROMO_TEXT = buildRatePromoPost({ activityName: "FNF", matchDateLabel: "Fri 9 Oct", lang: "en" });
const LEDGER = [{ userId: "u0", badgeKey: "first-game", matchId: "m-fri-9-oct" }];
const BADGES_TEXT = "🏅 *New badges this week*\n\n🎉 First game: Hamzah";
const badgePost = (m: { id: string }) => ({ kind: "group-message", key: BADGES_KEY(m), matchId: m.id, text: BADGES_TEXT, badgeLedger: LEDGER });

const completed = (club: Record<string, unknown> = {}) =>
  match({ ...NO_DEADLINES, ...club }, { status: "COMPLETED", redScore: 3, yellowScore: 2 });

describe("the default (MatchTime announces): the three posts stay in the players' group, unchanged", () => {
  it("the gear reminder", async () => {
    const m = match(NO_DEADLINES);
    setWorld([m]);
    const before = await instructions(FRI_1830);
    features.listAnnouncer = "matchtime";
    setWorld([m]);
    const after = await instructions(FRI_1830);
    expect(after).toEqual(before);
    expect(byKey(after, GEAR_KEY(m))).toEqual({ kind: "group-message", key: GEAR_KEY(m), matchId: m.id, text: GEAR_TEXT("en") });
  });

  it("the rating notice", async () => {
    const m = completed();
    setWorld([m], { sent: RATE_DM_KEYS(m) });
    const before = await instructions(SAT_0905);
    features.listAnnouncer = "matchtime";
    setWorld([m], { sent: RATE_DM_KEYS(m) });
    const after = await instructions(SAT_0905);
    expect(after).toEqual(before);
    expect(byKey(after, PROMO_KEY(m))).toEqual({ kind: "group-message", key: PROMO_KEY(m), matchId: m.id, text: PROMO_TEXT });
  });

  it("the badges post", async () => {
    features.badgeAnnouncements = true;
    const m = completed();
    badges.posts = [badgePost(m)];
    setWorld([m]);
    const before = await instructions(SUN_1805);
    features.listAnnouncer = "matchtime";
    setWorld([m]);
    const after = await instructions(SUN_1805);
    expect(after).toEqual(before);
    expect(byKey(after, BADGES_KEY(m))).toEqual(badgePost(m));
  });
});

describe("the gear reminder is a club setting, the same whoever announces", () => {
  for (const announcer of ["matchtime", "organisers"] as const) {
    it(`${announcer}: on (an existing club), it posts in the players' group exactly as before`, async () => {
      features.listAnnouncer = announcer;
      features.gearReminder = true;
      const m = match(NO_DEADLINES);
      setWorld([m]);
      const out = await instructions(FRI_1830);
      expect(out.filter((i) => i.key.startsWith(GEAR_KEY(m)))).toEqual([
        { kind: "group-message", key: GEAR_KEY(m), matchId: m.id, text: GEAR_TEXT("en") },
      ]);
    });

    it(`${announcer}: off (the default for a new club), it is sent nowhere`, async () => {
      features.listAnnouncer = announcer;
      features.gearReminder = false;
      const m = match(NO_DEADLINES);
      setWorld([m]);
      const out = await instructions(FRI_1830);
      expect(out.filter((i) => i.key.includes("football-gear-reminder"))).toEqual([]);
      expect(out.some((i) => "text" in i && /goalie gloves/.test(i.text))).toBe(false);
    });
  }

  it("on, in Turkish", async () => {
    features.language = "tr";
    features.gearReminder = true;
    const m = match({ ...NO_DEADLINES, language: "tr" });
    setWorld([m]);
    expect(byKey(await instructions(FRI_1830), GEAR_KEY(m))?.text).toBe(GEAR_TEXT("tr"));
  });

  it("on, it still respects the attendance switch", async () => {
    features.attendance = false;
    features.gearReminder = true;
    const m = match(NO_DEADLINES);
    setWorld([m]);
    expect(byKey(await instructions(FRI_1830), GEAR_KEY(m))).toBeUndefined();
  });
});

describe('"The organisers": the rating notice goes to the admins, the badges post to the players', () => {
  beforeEach(() => {
    features.listAnnouncer = "organisers";
  });

  it("the players still get their rating DMs, and the notice waits for them", async () => {
    vi.stubEnv("AUTH_SECRET", "test-secret-for-rating-links");
    const m = completed();
    setWorld([m]);
    const out = await instructions(SAT_0905);
    const dms = out.filter((i) => i.key.startsWith(`${m.id}:rate-dm:`));
    expect(dms.map((i) => i.key).sort()).toEqual(RATE_DM_KEYS(m).sort());
    expect(dms.every((i) => i.kind === "dm" && i.phone.startsWith("44770090000"))).toBe(true);
    expect(out.filter((i) => i.key.startsWith(PROMO_KEY(m)))).toHaveLength(0);
  });

  it("once every rating DM is out, the notice goes to the admin group, not the players' group", async () => {
    const m = completed();
    setWorld([m], { sent: RATE_DM_KEYS(m) });
    const out = await instructions(SAT_0905);
    expect(byKey(out, PROMO_KEY(m))).toEqual({
      kind: "admin-group-message",
      key: PROMO_KEY(m),
      matchId: m.id,
      groupId: ADMIN_GROUP,
      text: buildOrganiserRelay(PROMO_TEXT, "en"),
    });
    expect(groupPosts(out).some((i) => i.key.startsWith(PROMO_KEY(m)))).toBe(false);
  });

  it("the rating notice, in Turkish", async () => {
    features.language = "tr";
    const m = completed({ language: "tr" });
    setWorld([m], { sent: RATE_DM_KEYS(m) });
    const text = byKey(await instructions(SAT_0905), PROMO_KEY(m))?.text ?? "";
    expect(text.startsWith("📋 Organizatörler için, oyuncu grubuna gönderilmedi:\n\n🎯 ")).toBe(true);
    expect(text).toContain("puanlama linkini DM'den gönderdim");
  });

  it("the rating notice already sent to the admin group: nothing again", async () => {
    const m = completed();
    setWorld([m], { sent: [...RATE_DM_KEYS(m), PROMO_KEY(m)] });
    expect(byKey(await instructions(SAT_0905), PROMO_KEY(m))).toBeUndefined();
  });

  // Kemal, 2026-10-16: badges go in the players' group for every club,
  // whoever announces; only the rating notice is still relayed here.
  it("the badges post goes to the PLAYERS' group with its ledger rows, never to the admin group", async () => {
    features.badgeAnnouncements = true;
    const m = completed();
    badges.posts = [badgePost(m)];
    setWorld([m]);
    const out = await instructions(SUN_1805);
    expect(out.filter((i) => i.key.startsWith(BADGES_KEY(m)))).toEqual([badgePost(m)]);
    expect(out.some((i) => i.kind !== "group-message" && i.key.includes(":badges"))).toBe(false);
  });

  it("the badges post is the same instruction whoever announces", async () => {
    features.badgeAnnouncements = true;
    const m = completed();
    badges.posts = [badgePost(m)];
    setWorld([m]);
    const organisers = (await instructions(SUN_1805)).filter((i) => i.key.startsWith(BADGES_KEY(m)));
    features.listAnnouncer = "matchtime";
    setWorld([m]);
    const matchtime = (await instructions(SUN_1805)).filter((i) => i.key.startsWith(BADGES_KEY(m)));
    expect(organisers).toEqual(matchtime);
  });

  it("badge announcements off: no badges post anywhere", async () => {
    features.badgeAnnouncements = false;
    const m = completed();
    badges.posts = [badgePost(m)];
    setWorld([m]);
    expect((await instructions(SUN_1805)).some((i) => i.key.includes(":badges"))).toBe(false);
  });
});

describe('"The organisers" with no admin group to post in: the same fallback as the squad posts', () => {
  beforeEach(() => {
    features.listAnnouncer = "organisers";
  });

  it("an older Pi: the rating notice goes to the owner by DM", async () => {
    const m = completed();
    setWorld([m], { sent: RATE_DM_KEYS(m) });
    const out = await instructions(SAT_0905, { adminGroup: false });
    expect(byKey(out, `${PROMO_KEY(m)}:${OWNER.id}`)).toMatchObject({ kind: "dm", phone: "447700111111", targetUser: OWNER.id });
    expect(groupPosts(out).some((i) => i.key.startsWith(PROMO_KEY(m)))).toBe(false);
  });

  it("each admin by DM: the badges post still goes to the players' group, and no admin gets a badges DM", async () => {
    features.badgeAnnouncements = true;
    const m = completed();
    badges.posts = [badgePost(m)];
    setWorld([m], { channelMode: "each-admin", adminGroupId: null });
    const out = await instructions(SUN_1805);
    expect(out.filter((i) => i.key.startsWith(BADGES_KEY(m)))).toEqual([badgePost(m)]);
  });
});
