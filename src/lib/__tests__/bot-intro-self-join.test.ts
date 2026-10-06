/**
 * One introduction per club (2026-10-06).
 *
 * A club approved through self-join is introduced by the group hello
 * (`sj_group_hello`, queued by `decideClub`). The scheduler's older
 * one-time intro (`org-<id>:bot-intro`) must not follow it: a create-org
 * club always has an active activity, so before this the group got two
 * long introductions on its first poll.
 *
 * Driven through the real `computeDuePosts` with Prisma mocked (the proxy
 * pattern of rolling-squad-scheduler.test.ts). No model anywhere.
 */
import { describe, it, expect, vi } from "vitest";

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
    paymentTracking: false,
    paymentCollection: false,
    squadFromList: false,
    language: "en",
    rollingSquad: false,
    benchPickMode: "first-come",
  }),
}));

import { computeDuePosts } from "@/lib/bot-scheduler";

const GROUP = "group-intro@g.us";
const NOW = new Date("2026-10-06T10:00:00.000Z");

/** A club with one active activity and no match yet: exactly a club the day it goes live. */
function setWorld(org: { id: string; approvedAt: Date | null }, sent: string[] = []) {
  for (const k of Object.keys(overrides)) delete overrides[k];
  overrides.organisation = {
    findFirst: async () => ({ ...org, whatsappGroupId: GROUP, whatsappBotEnabled: true }),
  };
  overrides.sentNotification = { findMany: async () => sent.map((key) => ({ key })) };
  overrides.activity = { count: async () => 1 };
}

async function introFor(org: { id: string; approvedAt: Date | null }, sent: string[] = []) {
  setWorld(org, sent);
  const res = await computeDuePosts(GROUP, NOW);
  return (res?.instructions ?? []).filter((i) => i.key === `org-${org.id}:bot-intro`);
}

describe("the scheduler's one-time intro", () => {
  it("is never sent to a club approved through self-join, even with no claim on the key", async () => {
    // A club approved before decideClub started claiming the key.
    expect(await introFor({ id: "org-riverside", approvedAt: new Date("2026-10-05T18:00:00.000Z") })).toEqual([]);
  });

  it("still goes, once, to a club that did not come through self-join", async () => {
    const intro = await introFor({ id: "org-chat-onboarded", approvedAt: null });
    expect(intro).toHaveLength(1);
    expect(intro[0]).toMatchObject({ kind: "group-message" });
  });

  it("is not repeated for a club that already had it (Sutton FC)", async () => {
    expect(await introFor({ id: "org-sutton", approvedAt: null }, ["org-org-sutton:bot-intro"])).toEqual([]);
  });
});
