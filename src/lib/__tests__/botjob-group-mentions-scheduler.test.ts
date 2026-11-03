/**
 * A queued players'-group post that TAGS someone (2026-11-03): a BotJob of
 * kind "group" with `mentions` becomes a group-message carrying them, as
 * the scheduler's own posts do, so the Pi sends a real WhatsApp tag. A job
 * with none is today's plain group-message, with no mentions field.
 * Through the real `computeDuePosts` with Prisma mocked (the proxy pattern
 * of dm-reply-priority-scheduler.test.ts). No model anywhere.
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

const GROUP = "group-fnf@g.us";
const ORG_ID = "org-fnf";
const NOW = new Date("2026-11-03T12:00:00.000Z");

const job = (id: string, over: Record<string, unknown>) => ({
  id,
  orgId: ORG_ID,
  kind: "group",
  phone: null,
  text: id,
  pollQuestion: null,
  pollOptions: [],
  pollMulti: false,
  sendAfter: null,
  sentAt: null,
  createdAt: new Date(NOW.getTime() - 60_000),
  priority: 0,
  matchId: null,
  aboutKey: null,
  mentions: [],
  ...over,
});

function setWorld(jobs: ReturnType<typeof job>[]) {
  for (const k of Object.keys(overrides)) delete overrides[k];
  overrides.organisation = {
    findFirst: async () => ({
      id: ORG_ID,
      name: "FNF",
      whatsappGroupId: GROUP,
      whatsappBotEnabled: true,
      approvedAt: null,
      setupStage: "live",
      language: "en",
    }),
  };
  overrides.botJob = { findMany: async () => jobs };
}

beforeEach(() => setWorld([]));

describe("group BotJob mentions", () => {
  it("a group job with mentions is a group-message that carries them", async () => {
    setWorld([job("tag", { text: "@447961809174 the pitch is booked", mentions: ["447961809174"] })]);
    const r = await computeDuePosts(GROUP, NOW);
    expect(r?.instructions.find((i) => i.key === "botjob-tag")).toEqual({
      kind: "group-message",
      key: "botjob-tag",
      text: "@447961809174 the pitch is booked",
      mentions: ["447961809174"],
    });
  });

  it("a group job with none is today's plain group-message, no mentions field", async () => {
    setWorld([job("plain", { text: "Squad is up" })]);
    const r = await computeDuePosts(GROUP, NOW);
    expect(r?.instructions.find((i) => i.key === "botjob-plain")).toEqual({ kind: "group-message", key: "botjob-plain", text: "Squad is up" });
  });
});
