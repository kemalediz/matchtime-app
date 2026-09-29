/**
 * queueOwnerDm: the ONE way MatchTime DMs Kemal (self-join plan 6.1, 6.4).
 *
 * Kemal's rule (2026-09-28): DMs to him only for things he must act on.
 * Routine alerts go to the owner dashboard (`src/lib/ops-alerts.ts`). So
 * this helper is deliberately narrow:
 *   - two purposes only, "owner-approval" and "owner-ack", checked at
 *     runtime as well as by the type;
 *   - a refId is required (an approval is always about a thing);
 *   - one DM per (purpose, refId, phone), ever: a retry or a re-add can
 *     never DM him twice about the same club;
 *   - only to the numbers in SELF_JOIN_APPROVER_PHONES; none set, none sent;
 *   - an approval request that would land between 22:00 and 08:00 London
 *     waits until 08:00 (nothing about a waiting group is urgent). An ack
 *     is a reply to something he just did, so it goes at once.
 *
 * The source guard beside this file keeps routine alerting code from
 * importing it at all.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  platformJob: { create: vi.fn(), findFirst: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { ownerQuietHoursSendAfter, parseApproverPhones, queueOwnerDm } from "../owner-dm";

const ENV = process.env.SELF_JOIN_APPROVER_PHONES;
// 12:00 London (BST) on a Tuesday.
const NOON = new Date("2026-09-29T11:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SELF_JOIN_APPROVER_PHONES = "+44 7700 900001";
  dbMock.platformJob.findFirst.mockResolvedValue(null);
  dbMock.platformJob.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: `job-${data.phone}`,
    ...data,
  }));
});
afterAll(() => {
  if (ENV === undefined) delete process.env.SELF_JOIN_APPROVER_PHONES;
  else process.env.SELF_JOIN_APPROVER_PHONES = ENV;
});

describe("parseApproverPhones", () => {
  it("reads a comma or space separated list into digits, dropping junk and duplicates", () => {
    expect(parseApproverPhones("+44 7700 900001, 447700900002;447700900001 abc")).toEqual([
      "447700900001",
      "447700900002",
    ]);
  });

  it("is empty when unset", () => {
    expect(parseApproverPhones(undefined)).toEqual([]);
    expect(parseApproverPhones("   ")).toEqual([]);
  });
});

describe("ownerQuietHoursSendAfter", () => {
  it("is null in the day", () => {
    expect(ownerQuietHoursSendAfter(NOON)).toBeNull();
  });

  it("holds a late-evening request until 08:00 London the next morning", () => {
    // 23:30 BST on 29 Sept.
    expect(ownerQuietHoursSendAfter(new Date("2026-09-29T22:30:00Z"))?.toISOString()).toBe(
      "2026-09-30T07:00:00.000Z",
    );
  });

  it("holds an early-morning request until 08:00 London the same day", () => {
    // 05:00 BST on 30 Sept.
    expect(ownerQuietHoursSendAfter(new Date("2026-09-30T04:00:00Z"))?.toISOString()).toBe(
      "2026-09-30T07:00:00.000Z",
    );
  });

  it("uses GMT after the clocks go back", () => {
    // 23:00 GMT on 2 Nov -> 08:00 GMT on 3 Nov.
    expect(ownerQuietHoursSendAfter(new Date("2026-11-02T23:00:00Z"))?.toISOString()).toBe(
      "2026-11-03T08:00:00.000Z",
    );
  });
});

describe("queueOwnerDm", () => {
  it("queues one approval DM per approver phone", async () => {
    process.env.SELF_JOIN_APPROVER_PHONES = "447700900001,447700900002";
    const out = await queueOwnerDm("New club waiting", "owner-approval", "cc1", NOON);
    expect(out).toEqual({ queued: 2, skipped: 0 });
    expect(dbMock.platformJob.create).toHaveBeenCalledTimes(2);
    expect(dbMock.platformJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "dm",
        phone: "447700900001",
        text: "New club waiting",
        purpose: "owner-approval",
        refId: "cc1",
        status: "queued",
        sendAfter: null,
      }),
    });
  });

  it("never DMs twice about the same thing", async () => {
    dbMock.platformJob.findFirst.mockResolvedValue({ id: "already" });
    const out = await queueOwnerDm("New club waiting", "owner-approval", "cc1", NOON);
    expect(out).toEqual({ queued: 0, skipped: 1 });
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
    expect(dbMock.platformJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { kind: "dm", purpose: "owner-approval", refId: "cc1", phone: "447700900001" },
      }),
    );
  });

  it("sends nothing, and says so, when no approver phone is configured", async () => {
    delete process.env.SELF_JOIN_APPROVER_PHONES;
    const out = await queueOwnerDm("New club waiting", "owner-approval", "cc1", NOON);
    expect(out).toEqual({ queued: 0, skipped: 0, reason: "no-approver-phones" });
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("holds an approval request through quiet hours, but not an ack", async () => {
    const late = new Date("2026-09-29T22:30:00Z");
    await queueOwnerDm("New club waiting", "owner-approval", "cc1", late);
    expect(dbMock.platformJob.create.mock.calls[0][0].data.sendAfter.toISOString()).toBe(
      "2026-09-30T07:00:00.000Z",
    );
    await queueOwnerDm("Approved Riverside FC.", "owner-ack", "cc1", late);
    expect(dbMock.platformJob.create.mock.calls[1][0].data.sendAfter).toBeNull();
  });

  it("refuses anything that is not an approval or an ack: routine alerts go to ops-alerts", async () => {
    for (const purpose of ["health", "operator-note", "ai-daily-cap", "otp", "connect-reply"]) {
      await expect(queueOwnerDm("x", purpose as never, "r1", NOON)).rejects.toThrow(/ops-alerts/);
    }
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("requires a refId and a text", async () => {
    await expect(queueOwnerDm("x", "owner-approval", "", NOON)).rejects.toThrow(/refId/);
    await expect(queueOwnerDm("  ", "owner-approval", "r1", NOON)).rejects.toThrow(/text/);
  });
});
