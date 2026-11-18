/**
 * The Sutton night of 17 Nov 2026, end to end through the real
 * `computeDuePosts` (Prisma mocked, the proxy pattern of
 * dm-reply-priority-scheduler.test.ts). No model, nothing sent.
 *
 *   23:01  fee confirmed inside quiet hours: `releaseMatchPayments` queues
 *          a pay link per player with sendAfter 09:00;
 *   23:13  the collector marks Wasim paid on /collect;
 *   09:00  the scheduler polls: Wasim's link is not handed to the Pi (and
 *          its job is deleted), Ali, still unpaid, gets his.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    paymentTracking: true,
    paymentCollection: true,
    squadFromList: false,
    language: "en",
    rollingSquad: false,
    benchPickMode: "first-come",
    badgeAnnouncements: false,
    squadMode: "weekly",
  }),
}));
vi.mock("@/lib/message-analyzer", () => ({ composeChaseText: async () => "MODEL TEXT" }));
vi.mock("@/lib/team-proposal", () => ({ teamProposalJobs: async () => 0 }));

import { computeDuePosts } from "@/lib/bot-scheduler";
import { payLinkAboutKey } from "@/lib/pay-link-job-rules";

const GROUP = "group-sutton@g.us";
const ORG_ID = "org-sutton";
const MATCH = "cmtbrqkro0002009k6zyrwdmg";
const RELEASED = new Date("2026-11-17T23:01:02Z");
const NINE = new Date("2026-11-18T09:00:00Z");
const NOW = new Date("2026-11-18T09:00:20Z");

interface Job {
  id: string;
  orgId: string;
  kind: string;
  phone: string | null;
  text: string;
  pollQuestion: null;
  pollOptions: string[];
  pollMulti: boolean;
  sendAfter: Date | null;
  sentAt: Date | null;
  createdAt: Date;
  priority: number;
  matchId: string | null;
  aboutKey: string | null;
  mentions: string[];
}

const payLink = (userId: string, phone: string, i: number): Job => ({
  id: `pay-${userId}`,
  orgId: ORG_ID,
  kind: "dm",
  phone,
  text: `Hi ${userId}, the match fee for Tuesday 7-a-side is £10.15. Tap to pay`,
  pollQuestion: null,
  pollOptions: [],
  pollMulti: false,
  sendAfter: NINE,
  sentAt: null,
  createdAt: new Date(RELEASED.getTime() + 2000 + i),
  priority: 0,
  matchId: null,
  aboutKey: payLinkAboutKey(MATCH, userId),
  mentions: [],
});

const owing = { status: "CONFIRMED", paidAt: null, feeWaivedAt: null, directPendingAt: null, paymentMethod: null };

let table: Job[] = [];
const deleted: unknown[] = [];

function setWorld(
  attendances: Array<Record<string, unknown>>,
  matchOver: Record<string, unknown> = {},
  claimed: string[] = [],
) {
  for (const k of Object.keys(overrides)) delete overrides[k];
  deleted.length = 0;
  table = [
    payLink("wasim", "447404111243", 0),
    payLink("ali", "447700900001", 1),
    // An ordinary DM queued with no about key goes out as before.
    { ...payLink("note", "447700900002", 2), id: "plain", aboutKey: null, text: "Reminder" },
  ];
  overrides.organisation = {
    findFirst: async () => ({
      id: ORG_ID,
      name: "Sutton FC",
      whatsappGroupId: GROUP,
      whatsappBotEnabled: true,
      approvedAt: null,
      setupStage: "live",
      language: "en",
    }),
  };
  overrides.botJob = {
    findMany: async (args: unknown) => {
      const a = args as { where: { sentAt?: null } };
      return a.where.sentAt === null ? table.filter((j) => j.sentAt === null) : [];
    },
    deleteMany: async (args: unknown) => {
      deleted.push(args);
      return { count: 1 };
    },
  };
  // The claim rows due-posts writes at hand-off (`botjob-<id>`, matchId
  // null): the scheduler's own sent-key read never loads them.
  overrides.sentNotification = {
    findMany: async (args: unknown) => {
      const a = args as { where: { key?: { in?: string[] } } };
      const keys = a.where?.key?.in;
      return keys ? claimed.filter((k) => keys.includes(k)).map((key) => ({ key })) : [];
    },
  };
  overrides.match = {
    findMany: async (args: unknown) => {
      const a = args as { where: { id?: { in?: string[] } } };
      if (!a.where?.id?.in) return [];
      return [
        {
          id: MATCH,
          status: "TEAMS_PUBLISHED",
          feePerPlayer: 10.15,
          paymentLinksReleasedAt: RELEASED,
          activity: { org: { paymentHolderId: "collector", paymentCollectionEnabled: true } },
          ...matchOver,
        },
      ];
    },
  };
  overrides.attendance = {
    findMany: async (args: unknown) => {
      const a = args as { where: { OR?: unknown[] } };
      return a.where?.OR ? attendances : [];
    },
  };
}

const dmKeys = (r: Awaited<ReturnType<typeof computeDuePosts>>) =>
  (r?.instructions ?? []).filter((i) => i.kind === "dm").map((i) => i.key);

beforeEach(() => setWorld([]));

describe("pay links released in quiet hours, players marked paid before 09:00", () => {
  it("the paid player gets nothing and his job is deleted; the unpaid player still gets his link", async () => {
    setWorld([
      { matchId: MATCH, userId: "wasim", ...owing, paidAt: new Date("2026-11-17T23:13:13Z") },
      { matchId: MATCH, userId: "ali", ...owing },
    ]);
    const keys = dmKeys(await computeDuePosts(GROUP, NOW));
    expect(keys).not.toContain("botjob-pay-wasim");
    expect(keys).toContain("botjob-pay-ali");
    expect(keys).toContain("botjob-plain");
    expect(deleted).toEqual([{ where: { id: "pay-wasim", sentAt: null } }]);
  });

  it("a link handed to the Pi but not yet acked is never deleted once the player pays, and not handed out again", async () => {
    setWorld(
      [
        { matchId: MATCH, userId: "wasim", ...owing, paidAt: new Date("2026-11-18T09:00:10Z") },
        { matchId: MATCH, userId: "ali", ...owing },
      ],
      {},
      ["botjob-pay-wasim"],
    );
    const keys = dmKeys(await computeDuePosts(GROUP, NOW));
    expect(keys).not.toContain("botjob-pay-wasim");
    expect(keys).toContain("botjob-pay-ali");
    expect(deleted).toEqual([]);
  });

  it("payment collection switched off before 09:00: no pay link goes out", async () => {
    setWorld([{ matchId: MATCH, userId: "ali", ...owing }], {
      activity: { org: { paymentHolderId: "collector", paymentCollectionEnabled: false } },
    });
    const keys = dmKeys(await computeDuePosts(GROUP, NOW));
    expect(keys).not.toContain("botjob-pay-ali");
    expect(keys).toContain("botjob-plain");
  });

  it("preview mode (x-no-claim, tests only) holds a link no longer owed and deletes nothing", async () => {
    setWorld([
      { matchId: MATCH, userId: "wasim", ...owing, paidAt: new Date("2026-11-17T23:13:13Z") },
      { matchId: MATCH, userId: "ali", ...owing },
    ]);
    const keys = dmKeys(await computeDuePosts(GROUP, NOW, undefined, null, null, { preview: true }));
    expect(keys).not.toContain("botjob-pay-wasim");
    expect(keys).toContain("botjob-pay-ali");
    expect(deleted).toEqual([]);
  });

  it("a free place, a direct payment, or a drop since release: no link", async () => {
    setWorld([
      { matchId: MATCH, userId: "wasim", ...owing, feeWaivedAt: new Date("2026-11-17T23:20:00Z") },
      { matchId: MATCH, userId: "ali", ...owing, directPendingAt: new Date("2026-11-17T23:30:00Z") },
    ]);
    let keys = dmKeys(await computeDuePosts(GROUP, NOW));
    expect(keys).not.toContain("botjob-pay-wasim");
    expect(keys).not.toContain("botjob-pay-ali");

    setWorld([
      { matchId: MATCH, userId: "wasim", ...owing, status: "DROPPED" },
      { matchId: MATCH, userId: "ali", ...owing },
    ]);
    keys = dmKeys(await computeDuePosts(GROUP, NOW));
    expect(keys).not.toContain("botjob-pay-wasim");
    expect(keys).toContain("botjob-pay-ali");
  });

  it("the fee withdrawn or the match cancelled: no pay link goes to anyone", async () => {
    const both = [
      { matchId: MATCH, userId: "wasim", ...owing },
      { matchId: MATCH, userId: "ali", ...owing },
    ];
    setWorld(both, { feePerPlayer: null });
    let keys = dmKeys(await computeDuePosts(GROUP, NOW));
    expect(keys).not.toContain("botjob-pay-wasim");
    expect(keys).not.toContain("botjob-pay-ali");
    expect(keys).toContain("botjob-plain");

    setWorld(both, { status: "CANCELLED" });
    keys = dmKeys(await computeDuePosts(GROUP, NOW));
    expect(keys).not.toContain("botjob-pay-wasim");
    expect(keys).not.toContain("botjob-pay-ali");
  });

  it("before 09:00 nothing is due and nothing is read or deleted", async () => {
    setWorld([{ matchId: MATCH, userId: "wasim", ...owing, paidAt: new Date() }]);
    overrides.botJob.findMany = async (args: unknown) => {
      const a = args as { where: { OR?: Array<{ sendAfter: null | { lte: Date } }> } };
      const lte = (a.where.OR?.[1]?.sendAfter as { lte: Date } | undefined)?.lte;
      return table.filter((j) => j.sentAt === null && (j.sendAfter === null || (lte && j.sendAfter <= lte)));
    };
    const keys = dmKeys(await computeDuePosts(GROUP, new Date("2026-11-18T08:30:00Z")));
    expect(keys).not.toContain("botjob-pay-wasim");
    expect(keys).not.toContain("botjob-pay-ali");
    expect(deleted).toEqual([]);
  });
});
