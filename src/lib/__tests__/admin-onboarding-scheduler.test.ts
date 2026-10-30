/**
 * "Teams for <weekday>" in the scheduler (admin-onboarding.ts
 * `firstTeamsInstructions`), driven through the real `computeDuePosts` with
 * Prisma mocked (the proxy pattern of seed-nudge-scheduler.test.ts). No
 * model anywhere.
 *
 * A club like FNF: live since Wednesday 20:00, organisers announce,
 * admin group linked, Friday 21:00, Teams ready 10:00 (the organisers
 * default), the squad full on Thursday evening, nobody seeded.
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

const features: Record<string, unknown> = {};
function resetFeatures(over: Record<string, unknown> = {}) {
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
    rollingSquad: true,
    benchPickMode: "organiser",
    badgeAnnouncements: false,
    squadMode: "weekly",
    listAnnouncer: "organisers",
    ...over,
  });
}
vi.mock("@/lib/org-features", () => ({ getOrgFeatures: async () => ({ ...features }) }));
vi.mock("@/lib/message-analyzer", () => ({ composeChaseText: async () => "MODEL TEXT" }));
vi.mock("@/lib/team-proposal", () => ({ teamProposalJobs: async () => 0 }));
vi.mock("@/lib/admin-link", async (orig) => ({
  ...(await orig<object>()),
  buildAdminLink: async (a: { userId: string; nextPath: string }) => `https://signed.example/${a.userId}${a.nextPath}`,
}));

import { computeDuePosts, type DueInstruction } from "@/lib/bot-scheduler";
import { appUrl } from "@/lib/app-url";

const GROUP = "group-fnf@g.us";
const ADMIN_GROUP = "admins-fnf@g.us";
const ORG_ID = "org-fnf";
const LIVE_AT = new Date("2026-10-14T19:00:00.000Z"); // Wed 20:00 London
const KICKOFF = new Date("2026-10-16T20:00:00.000Z"); // Fri 21:00 London
const THU_2000 = new Date("2026-10-15T19:00:00.000Z");
const FRI_1005 = new Date("2026-10-16T09:05:00.000Z");

const HAMZAH = { id: "u-hamzah", name: "Hamzah Khan", phoneNumber: "+447700111111", role: "OWNER" };
const RAIHAN = { id: "u-raihan", name: "Raihan Ahmed", phoneNumber: "+447700222222", role: "ADMIN" };

function att(i: number) {
  return {
    id: `att-${i}`,
    userId: `p${i}`,
    status: "CONFIRMED",
    position: i + 1,
    paidAt: null,
    directPendingAt: null,
    user: { id: `p${i}`, name: `Player ${i}`, phoneNumber: `+4477009000${String(i).padStart(2, "0")}` },
  };
}

function match(over: Record<string, unknown> = {}, confirmed = 18) {
  return {
    id: "m-fri",
    date: KICKOFF,
    status: "UPCOMING",
    maxPlayers: 18,
    isHistorical: false,
    activityId: "act-fnf",
    attendanceDeadline: new Date("2026-10-16T15:00:00.000Z"),
    rollingSeededAt: null,
    rollingSeededFromMatchId: null,
    postMatchEndFlow: true,
    attendances: Array.from({ length: confirmed }, (_, i) => att(i)),
    teamAssignments: [],
    benchConfirmations: [],
    benchSlotOffers: [],
    paymentCredits: [],
    activity: {
      id: "act-fnf",
      orgId: ORG_ID,
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
        dropOutDeadlineDay: null,
        dropOutDeadlineTime: null,
        listPublishDay: null,
        listPublishTime: null,
      },
    },
    ...over,
  };
}

interface World {
  sent?: string[];
  channelMode?: string;
  language?: string;
  seeded?: number;
  listAnnouncer?: string;
  teamsReadyTime?: string | null;
  adminGroupId?: string | null;
  pasteApplied?: boolean;
  priorProposal?: boolean;
  matches?: ReturnType<typeof match>[];
}

function setWorld(w: World = {}) {
  for (const k of Object.keys(overrides)) delete overrides[k];
  const adminGroupId = w.adminGroupId === undefined ? ADMIN_GROUP : w.adminGroupId;
  overrides.organisation = {
    findFirst: async () => ({
      id: ORG_ID,
      name: "FNF",
      whatsappGroupId: GROUP,
      whatsappBotEnabled: true,
      approvedAt: new Date("2026-10-10T10:00:00.000Z"),
      approvalStatus: "approved",
      setupStage: "live",
      liveAt: LIVE_AT,
      adminGroupId,
      listAnnouncer: w.listAnnouncer ?? "organisers",
      teamsReadyTime: w.teamsReadyTime === undefined ? null : w.teamsReadyTime,
      billingStatus: "trial",
    }),
    findUnique: async () => ({
      id: ORG_ID,
      name: "FNF",
      language: w.language ?? "en",
      adminChannelMode: w.channelMode ?? "admin-group",
      adminChannelUserId: null,
      adminGroupId,
    }),
  };
  overrides.membership = {
    findMany: async (args: unknown) => {
      const where = (args as { where?: { role?: unknown; provisionallyAddedAt?: unknown; subTentativeDm?: unknown } }).where;
      if (where?.role) {
        return [HAMZAH, RAIHAN].map((a) => ({ role: a.role, user: { id: a.id, name: a.name, phoneNumber: a.phoneNumber } }));
      }
      if (where?.provisionallyAddedAt || where?.subTentativeDm !== undefined) return [];
      return Array.from({ length: 24 }, (_, i) => ({ userId: `p${i}`, seedRating: i < (w.seeded ?? 0) ? 6 : null, leftAt: null }));
    },
  };
  overrides.match = { findMany: async () => w.matches ?? [match()] };
  overrides.adminSquadProposal = { findFirst: async () => (w.pasteApplied ? { id: "paste-1" } : null) };
  overrides.adminTeamProposal = { findFirst: async () => (w.priorProposal ? { id: "tp-1" } : null) };
  overrides.sentNotification = {
    findMany: async (args: unknown) => {
      const where = (args as { where?: { OR?: unknown } }).where;
      return where?.OR ? (w.sent ?? []).map((key) => ({ key })) : [];
    },
  };
}

async function poll(now: Date, piCaps = { adminGroup: true }): Promise<DueInstruction[]> {
  return (await computeDuePosts(GROUP, now, piCaps))?.instructions ?? [];
}
const firstTeams = (out: DueInstruction[]) => out.filter((i) => i.key.includes("first-teams"));
const seedNudges = (out: DueInstruction[]) =>
  out.filter((i) => i.key.startsWith(`org-${ORG_ID}:seed-nudge`) && !i.key.includes("first-teams"));
const textOf = (i: DueInstruction) => (i as { text: string }).text;

beforeEach(() => {
  resetFeatures();
  setWorld();
});

describe("Teams for <weekday> in computeDuePosts", () => {
  it("FNF, Thursday 20:00, squad full, nobody seeded: one admin-group post with the seed line, and no separate seed nudge", async () => {
    const out = await poll(THU_2000);
    const ft = firstTeams(out);
    expect(ft).toHaveLength(1);
    expect(ft[0]).toMatchObject({ kind: "admin-group-message", key: `org-${ORG_ID}:seed-nudge:first-teams:admin-group`, groupId: ADMIN_GROUP });
    const text = textOf(ft[0]);
    expect(text).toContain("🟥🟦 *Teams for Friday*");
    expect(text).toContain("The squad is set, 18 of 18. At 10:00 on Friday I'll build two balanced teams and post them here for you to check.");
    expect(text).toContain("For the team sheet, a graphic to share with the players, tag me and ask any time");
    expect(text).toContain("⭐ No one in this squad has a rating yet");
    expect(text).toContain(appUrl("/admin/players/ratings"));
    // The seed nudge would be due now (Thursday from 09:00); it is skipped.
    expect(seedNudges(out)).toEqual([]);
  });

  it("once its key is sent, neither it nor the seed nudge comes again", async () => {
    setWorld({ sent: [`org-${ORG_ID}:seed-nudge:first-teams:admin-group`] });
    const out = await poll(THU_2000);
    expect(firstTeams(out)).toEqual([]);
    expect(seedNudges(out)).toEqual([]);
  });

  it("the squad mostly seeded: no seed line, its own key", async () => {
    setWorld({ seeded: 12 });
    const ft = firstTeams(await poll(THU_2000));
    expect(ft).toHaveLength(1);
    expect(ft[0].key).toBe(`org-${ORG_ID}:first-teams:admin-group`);
    expect(textOf(ft[0])).not.toContain("⭐");
  });

  it("the seed nudge already sent: no seed line, and the nudge is not repeated", async () => {
    setWorld({ sent: [`org-${ORG_ID}:seed-nudge:admin-group`] });
    const out = await poll(THU_2000);
    expect(firstTeams(out).map((i) => i.key)).toEqual([`org-${ORG_ID}:first-teams:admin-group`]);
    expect(textOf(firstTeams(out)[0])).not.toContain("⭐");
    expect(seedNudges(out)).toEqual([]);
  });

  it("only once: the bare claim (the mark script) or a delivered key stops it", async () => {
    for (const sent of [[`org-${ORG_ID}:first-teams`], [`org-${ORG_ID}:first-teams:admin-group`]]) {
      setWorld({ sent, seeded: 12 });
      expect(firstTeams(await poll(THU_2000))).toEqual([]);
    }
  });

  it("a short squad waits; a pasted list applied for the match sets it", async () => {
    setWorld({ matches: [match({}, 15)] });
    expect(firstTeams(await poll(THU_2000))).toEqual([]);
    setWorld({ matches: [match({}, 15)], pasteApplied: true });
    const ft = firstTeams(await poll(THU_2000));
    expect(ft).toHaveLength(1);
    expect(textOf(ft[0])).toContain("The squad is set, 15 of 18.");
  });

  it("not the club's first teams, not at or after the Teams ready time, not once teams exist", async () => {
    setWorld({ priorProposal: true });
    expect(firstTeams(await poll(THU_2000))).toEqual([]);
    setWorld();
    expect(firstTeams(await poll(FRI_1005))).toEqual([]);
    setWorld({ matches: [match({ status: "TEAMS_GENERATED" })] });
    expect(firstTeams(await poll(THU_2000))).toEqual([]);
  });

  it("only where the proposal goes: an admin group linked and routed there, and a Pi that can post there", async () => {
    setWorld({ adminGroupId: null });
    expect(firstTeams(await poll(THU_2000))).toEqual([]);
    setWorld({ channelMode: "each-admin" });
    expect(firstTeams(await poll(THU_2000))).toEqual([]);
    setWorld();
    expect(firstTeams(await poll(THU_2000, { adminGroup: false }))).toEqual([]);
  });

  it("a club MatchTime announces for: nothing with no Teams ready time; with one, YES posts in the main chat", async () => {
    resetFeatures({ listAnnouncer: "matchtime", benchPickMode: "first-come" });
    setWorld({ listAnnouncer: "matchtime", seeded: 12 });
    expect(firstTeams(await poll(THU_2000))).toEqual([]);
    setWorld({ listAnnouncer: "matchtime", teamsReadyTime: "18:00", seeded: 12 });
    const ft = firstTeams(await poll(THU_2000));
    expect(ft).toHaveLength(1);
    expect(textOf(ft[0])).toContain("At 18:00 on Friday");
    expect(textOf(ft[0])).toContain("Reply *YES* to make them final and I'll post them in the main chat");
  });

  it("not for a monthly club or with attendance off", async () => {
    resetFeatures({ squadMode: "monthly" });
    expect(firstTeams(await poll(THU_2000))).toEqual([]);
    resetFeatures({ attendance: false });
    expect(firstTeams(await poll(THU_2000))).toEqual([]);
  });

  it("in Turkish for a Turkish club", async () => {
    setWorld({ language: "tr" });
    const text = textOf(firstTeams(await poll(THU_2000))[0]);
    expect(text).toContain("🟥🟦 *Cuma günkü takımlar*");
    expect(text).toContain("Kadro belli: 18/18.");
    expect(text).toContain("Bu kadroda henüz kimsenin puanı yok");
  });
});
