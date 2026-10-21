/**
 * The seed-rating nudge in the scheduler (seed-nudge.ts), driven through
 * the real `computeDuePosts` with Prisma mocked (the proxy pattern of
 * organisers-announce-scheduler.test.ts). No model anywhere.
 *
 * A club like FNF: live since Wednesday evening, plays Friday 21:00,
 * nobody seeded, no peer ratings. On Thursday from 09:00 its admins are
 * told once, through the admin channel, in the club's language.
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
    rollingSquad: false,
    benchPickMode: "first-come",
    badgeAnnouncements: false,
    squadMode: "weekly",
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
const WED_2130 = new Date("2026-10-14T20:30:00.000Z");
const THU_0805 = new Date("2026-10-15T07:05:00.000Z");
const THU_0905 = new Date("2026-10-15T08:05:00.000Z");

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

function match(over: Record<string, unknown> = {}) {
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
    attendances: Array.from({ length: 18 }, (_, i) => att(i)),
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
  setupStage?: string;
  seeded?: number;
  peerRating?: boolean;
  manualJob?: boolean;
  matches?: ReturnType<typeof match>[];
}

const calls = { rating: 0 };

function setWorld(w: World = {}) {
  for (const k of Object.keys(overrides)) delete overrides[k];
  calls.rating = 0;
  overrides.organisation = {
    findFirst: async () => ({
      id: ORG_ID,
      name: "FNF",
      whatsappGroupId: GROUP,
      whatsappBotEnabled: true,
      approvedAt: new Date("2026-10-10T10:00:00.000Z"),
      approvalStatus: "approved",
      setupStage: w.setupStage ?? "live",
      liveAt: LIVE_AT,
    }),
    findUnique: async () => ({
      id: ORG_ID,
      name: "FNF",
      language: w.language ?? "en",
      adminChannelMode: w.channelMode ?? "admin-group",
      adminChannelUserId: null,
      adminGroupId: ADMIN_GROUP,
    }),
  };
  overrides.membership = {
    findMany: async (args: unknown) => {
      const where = (args as { where?: { role?: unknown; provisionallyAddedAt?: unknown; subTentativeDm?: unknown } }).where;
      if (where?.role) {
        return [HAMZAH, RAIHAN].map((a) => ({ role: a.role, user: { id: a.id, name: a.name, phoneNumber: a.phoneNumber } }));
      }
      if (where?.provisionallyAddedAt || where?.subTentativeDm !== undefined) return [];
      return Array.from({ length: 24 }, (_, i) => ({
        userId: `p${i}`,
        seedRating: i < (w.seeded ?? 0) ? 6 : null,
        leftAt: null,
      }));
    },
  };
  overrides.match = { findMany: async () => w.matches ?? [match()] };
  overrides.rating = {
    findFirst: async () => {
      calls.rating++;
      return w.peerRating ? { id: "r1" } : null;
    },
  };
  overrides.botJob = {
    findMany: async () => [],
    findFirst: async (args: unknown) => {
      const text = (args as { where?: { text?: { contains?: string } } }).where?.text?.contains;
      return w.manualJob && text === "rough rating from 1 to 10" ? { id: "hqseed123" } : null;
    },
  };
  overrides.sentNotification = {
    findMany: async (args: unknown) => {
      const where = (args as { where?: { OR?: unknown } }).where;
      return where?.OR ? (w.sent ?? []).map((key) => ({ key })) : [];
    },
  };
}

async function nudges(now: Date, piCaps = { adminGroup: true }): Promise<DueInstruction[]> {
  const res = await computeDuePosts(GROUP, now, piCaps);
  return (res?.instructions ?? []).filter((i) => i.key.startsWith(`org-${ORG_ID}:seed-nudge`));
}

beforeEach(() => {
  resetFeatures();
  setWorld();
});

describe("the seed-rating nudge in computeDuePosts", () => {
  it("FNF, Thursday 09:05: one post in the admin group, naming both admins, with the plain ratings URL", async () => {
    const out = await nudges(THU_0905);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "admin-group-message", key: `org-${ORG_ID}:seed-nudge:admin-group`, groupId: ADMIN_GROUP });
    const text = (out[0] as { text: string }).text;
    expect(text).toContain("⭐ *One thing before Friday's teams*");
    expect(text).toContain("Hamzah or Raihan: give each player a rough rating from 1 to 10 here:");
    expect(text).toContain(appUrl("/admin/players/ratings"));
    expect(text).toContain("Rating just the 18 players in Friday's squad is enough, about 5 minutes.");
  });

  it("in Turkish for a Turkish club", async () => {
    setWorld({ language: "tr" });
    const text = ((await nudges(THU_0905))[0] as { text: string }).text;
    expect(text).toContain("⭐ *Cuma günkü takımlardan önce bir şey*");
    expect(text).toContain("Hamzah ya da Raihan: her oyuncuya 1 ile 10 arasında kabaca bir puan verin:");
  });

  it("each admin by DM, with their own signed-in link, when the club has no admin group", async () => {
    setWorld({ channelMode: "each-admin" });
    const out = await nudges(THU_0905);
    expect(out.map((i) => i.key).sort()).toEqual([`org-${ORG_ID}:seed-nudge:${HAMZAH.id}`, `org-${ORG_ID}:seed-nudge:${RAIHAN.id}`].sort());
    for (const i of out) {
      expect(i.kind).toBe("dm");
      const who = (i as { targetUser: string }).targetUser;
      expect((i as { text: string }).text).toContain(`https://signed.example/${who}/admin/players/ratings`);
    }
  });

  it("not before 09:00 Thursday, and not on the evening it went live", async () => {
    expect(await nudges(THU_0805)).toEqual([]);
    expect(await nudges(WED_2130)).toEqual([]);
  });

  it("only once: any recipient's key, the bare claim, or the manual FNF BotJob stops it", async () => {
    setWorld({ sent: [`org-${ORG_ID}:seed-nudge:admin-group`] });
    expect(await nudges(THU_0905)).toEqual([]);
    setWorld({ sent: [`org-${ORG_ID}:seed-nudge`] });
    expect(await nudges(THU_0905)).toEqual([]);
    setWorld({ sent: [`org-${ORG_ID}:seed-nudge:${HAMZAH.id}`], channelMode: "each-admin" });
    expect(await nudges(THU_0905)).toEqual([]);
    setWorld({ manualJob: true });
    expect(await nudges(THU_0905)).toEqual([]);
  });

  it("a club already nudged makes no rating query on later polls", async () => {
    setWorld({ sent: [`org-${ORG_ID}:seed-nudge`] });
    await nudges(THU_0905);
    expect(calls.rating).toBe(0);
  });

  it("not once the club has peer ratings, or half the confirmed players are seeded", async () => {
    setWorld({ peerRating: true });
    expect(await nudges(THU_0905)).toEqual([]);
    // p0..p8 seeded: 9 of the 18 confirmed
    setWorld({ seeded: 9 });
    expect(await nudges(THU_0905)).toEqual([]);
    setWorld({ seeded: 8 });
    expect(await nudges(THU_0905)).toHaveLength(1);
  });

  it("not once teams are generated, not for a monthly club, not without team balancing, not while setting up", async () => {
    setWorld({ matches: [match({ status: "TEAMS_GENERATED" })] });
    expect(await nudges(THU_0905)).toEqual([]);
    setWorld();
    resetFeatures({ squadMode: "monthly" });
    expect(await nudges(THU_0905)).toEqual([]);
    resetFeatures({ teamBalancing: false });
    expect(await nudges(THU_0905)).toEqual([]);
    resetFeatures();
    setWorld({ setupStage: "setting-up" });
    expect(await nudges(THU_0905)).toEqual([]);
  });
});
