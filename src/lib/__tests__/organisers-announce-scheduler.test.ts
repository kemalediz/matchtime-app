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

import { computeDuePosts, type DueInstruction } from "@/lib/bot-scheduler";
import { buildOrganiserListUpdate } from "@/lib/organisers-list-copy";

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

  it("the final list also queues the list poster in the admin group, once per match", async () => {
    graphics.sendGraphicToAdminChannel.mockClear();
    const m = match(FNF_DEADLINES);
    setWorld([m]);
    await instructions(TUE_2005);
    expect(graphics.sendGraphicToAdminChannel).toHaveBeenCalledTimes(1);
    expect(graphics.sendGraphicToAdminChannel).toHaveBeenCalledWith(ORG.id, m.id, "list", { onceKey: `${m.id}:final-list` });
  });

  it("a poster that fails to queue never costs the club its posts", async () => {
    graphics.sendGraphicToAdminChannel.mockRejectedValueOnce(new Error("boom"));
    const m = match(FNF_DEADLINES);
    setWorld([m]);
    const out = await instructions(TUE_2005);
    expect(byKey(out, `${m.id}:list-published`)?.kind).toBe("admin-group-message");
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
    // The gear reminder lists nobody and stays in the group.
    expect(byKey(last, `${m.id}:football-gear-reminder`)?.kind).toBe("group-message");
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

describe("the daily 'New players to review' notice", () => {
  function withProvisional(authoredUserIds: string[]) {
    const roles = overrides.membership.findMany;
    overrides.membership = {
      findMany: async (args: unknown) => {
        const where = (args as { where?: { provisionallyAddedAt?: unknown } }).where;
        if (where?.provisionallyAddedAt) {
          return [
            { userId: "p-posted", user: { name: "Poster Pete" } },
            { userId: "p-listed", user: { name: "Listed Larry" } },
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
