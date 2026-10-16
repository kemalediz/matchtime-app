/**
 * Replies and the new-club DM cap (FNF, 2026-10-16, follow-up on #303).
 *
 * FNF is a new self-join club, so its members get at most 20 DMs a London
 * day (cap 8, `newClubDmCap`). The 16 pay links plus earlier DMs spent the
 * 20, so "Thanks Akram, I've told Raihan" and the collector's "says
 * they've paid you" notice were held until midnight.
 *
 * With DM_REPLY_PRIORITY_ENABLED on, a reply (BotJob priority 1) is never
 * held by the cap and does not count toward it. Bulk DMs stay capped
 * exactly as today. Off: byte-identical.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: { findMany: unknown[]; count: unknown[] } = { findMany: [], count: [] };
vi.mock("@/lib/db", () => ({
  db: {
    botJob: {
      findMany: async (a: unknown) => {
        calls.findMany.push(a);
        return [{ id: "b1" }];
      },
    },
    sentNotification: {
      count: async (a: unknown) => {
        calls.count.push(a);
        return 7;
      },
    },
  },
}));

import { holdDmsOverAllowance } from "@/lib/club-decision-rules";
import { countOrgDmsSince } from "@/lib/org-dm-count";

type I = { kind: string; key: string };
const dm = (key: string): I => ({ kind: "dm", key });
const group = (key: string): I => ({ kind: "group-message", key });

describe("holdDmsOverAllowance with replies exempt", () => {
  const list = [group("g1"), dm("reply"), dm("pay0"), dm("notice"), dm("pay1")];
  const isReply = (i: I) => i.key === "reply" || i.key === "notice";

  it("cap reached: replies still go, bulk is held", () => {
    const r = holdDmsOverAllowance(list, 0, isReply);
    expect(r.keep.map((i) => i.key)).toEqual(["g1", "reply", "notice"]);
    expect(r.held.map((i) => i.key)).toEqual(["pay0", "pay1"]);
  });

  it("replies do not use up the allowance left", () => {
    const r = holdDmsOverAllowance(list, 1, isReply);
    expect(r.keep.map((i) => i.key)).toEqual(["g1", "reply", "pay0", "notice"]);
    expect(r.held.map((i) => i.key)).toEqual(["pay1"]);
  });

  it("no exemption (flag off): exactly today's result", () => {
    expect(holdDmsOverAllowance(list, 0)).toEqual({ keep: [group("g1")], held: [dm("reply"), dm("pay0"), dm("notice"), dm("pay1")] });
    expect(holdDmsOverAllowance(list, 1, undefined)).toEqual(holdDmsOverAllowance(list, 1));
  });
});

describe("countOrgDmsSince: replies are not counted when asked", () => {
  beforeEach(() => {
    calls.findMany = [];
    calls.count = [];
  });
  const SINCE = new Date("2026-10-15T23:00:00.000Z");
  const weekBefore = new Date(SINCE.getTime() - 7 * 24 * 60 * 60 * 1000);

  it("default (flag off): today's exact query", async () => {
    expect(await countOrgDmsSince("org-fnf", SINCE)).toBe(7);
    expect(calls.findMany).toEqual([
      { where: { orgId: "org-fnf", kind: "dm", createdAt: { gte: weekBefore } }, select: { id: true }, take: 500 },
    ]);
  });

  it("excludeReplies: only priority-0 BotJobs are attributed to the club's DM count", async () => {
    await countOrgDmsSince("org-fnf", SINCE, { excludeReplies: true });
    expect(calls.findMany).toEqual([
      { where: { orgId: "org-fnf", kind: "dm", createdAt: { gte: weekBefore }, priority: 0 }, select: { id: true }, take: 500 },
    ]);
    // The rest of the count is unchanged.
    expect(JSON.stringify(calls.count[0])).toContain("botjob-b1");
  });

  it("excludeReplies false is the default", async () => {
    await countOrgDmsSince("org-fnf", SINCE, { excludeReplies: false });
    expect(calls.findMany[0]).toEqual({ where: { orgId: "org-fnf", kind: "dm", createdAt: { gte: weekBefore } }, select: { id: true }, take: 500 });
  });
});
