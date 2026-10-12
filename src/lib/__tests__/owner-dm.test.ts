/**
 * queueOwnerDm: the ONE way MatchTime DMs Kemal (self-join plan 6.1, 6.4).
 *
 * Kemal's rule (2026-09-28): DMs to him only for things he must act on.
 * Routine alerts go to the owner dashboard (`src/lib/ops-alerts.ts`). So
 * this helper is deliberately narrow:
 *   - three purposes only, "owner-approval", "owner-ack" and
 *     "owner-setup-stuck" (go-live slice S6: the one note about a club
 *     still setting up three days after its approval, which he acts on
 *     with "Go live now"), checked at runtime as well as by the type;
 *   - a refId is required (an approval is always about a thing);
 *   - one DM per (purpose, refId, phone), ever: a retry or a re-add can
 *     never DM him twice about the same club;
 *   - only to the numbers in SELF_JOIN_APPROVER_PHONES; none set, none sent;
 *   - an approval request that would land between 23:00 and 09:00 London
 *     waits until 09:00 (nothing about a waiting group is urgent). An ack
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

  it("holds a late-evening request until 09:00 London the next morning", () => {
    // 23:30 BST on 29 Sept.
    expect(ownerQuietHoursSendAfter(new Date("2026-09-29T22:30:00Z"))?.toISOString()).toBe(
      "2026-09-30T08:00:00.000Z",
    );
  });

  it("holds an early-morning request until 09:00 London the same day", () => {
    // 05:00 BST on 30 Sept.
    expect(ownerQuietHoursSendAfter(new Date("2026-09-30T04:00:00Z"))?.toISOString()).toBe(
      "2026-09-30T08:00:00.000Z",
    );
  });

  it("uses GMT after the clocks go back", () => {
    // 23:00 GMT on 2 Nov -> 09:00 GMT on 3 Nov.
    expect(ownerQuietHoursSendAfter(new Date("2026-11-02T23:00:00Z"))?.toISOString()).toBe(
      "2026-11-03T09:00:00.000Z",
    );
  });

  it("the edges: 08:59 held to 09:00, 09:00 and 22:59 at once, 23:00 held to tomorrow's 09:00 (winter)", () => {
    const after = (iso: string) => ownerQuietHoursSendAfter(new Date(iso))?.toISOString() ?? null;
    expect(after("2026-12-01T08:00:00Z")).toBe("2026-12-01T09:00:00.000Z");
    expect(after("2026-12-01T08:59:00Z")).toBe("2026-12-01T09:00:00.000Z");
    expect(after("2026-12-01T09:00:00Z")).toBeNull();
    expect(after("2026-12-01T22:00:00Z")).toBeNull();
    expect(after("2026-12-01T22:59:00Z")).toBeNull();
    expect(after("2026-12-01T23:00:00Z")).toBe("2026-12-02T09:00:00.000Z");
  });

  it("the edges in summer (BST)", () => {
    const after = (iso: string) => ownerQuietHoursSendAfter(new Date(iso))?.toISOString() ?? null;
    expect(after("2026-07-01T07:59:00Z")).toBe("2026-07-01T08:00:00.000Z");
    expect(after("2026-07-01T08:00:00Z")).toBeNull();
    expect(after("2026-07-01T21:59:00Z")).toBeNull();
    expect(after("2026-07-01T22:00:00Z")).toBe("2026-07-02T08:00:00.000Z");
  });

  it("both clock change days", () => {
    const after = (iso: string) => ownerQuietHoursSendAfter(new Date(iso))?.toISOString() ?? null;
    // Sun 29 Mar 2026: Saturday 23:30 GMT, then the missing hour, wait for 09:00 BST.
    expect(after("2026-03-28T23:30:00Z")).toBe("2026-03-29T08:00:00.000Z");
    expect(after("2026-03-29T01:00:00Z")).toBe("2026-03-29T08:00:00.000Z");
    expect(after("2026-03-29T08:00:00Z")).toBeNull();
    expect(after("2026-03-29T22:00:00Z")).toBe("2026-03-30T08:00:00.000Z");
    // Sun 25 Oct 2026: 01:30 twice, both wait for 09:00 GMT.
    expect(after("2026-10-24T22:30:00Z")).toBe("2026-10-25T09:00:00.000Z");
    expect(after("2026-10-25T00:30:00Z")).toBe("2026-10-25T09:00:00.000Z");
    expect(after("2026-10-25T01:30:00Z")).toBe("2026-10-25T09:00:00.000Z");
    expect(after("2026-10-25T08:59:00Z")).toBe("2026-10-25T09:00:00.000Z");
    expect(after("2026-10-25T22:59:00Z")).toBeNull();
    expect(after("2026-10-25T23:00:00Z")).toBe("2026-10-26T09:00:00.000Z");
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
      "2026-09-30T08:00:00.000Z",
    );
    await queueOwnerDm("Approved Riverside FC.", "owner-ack", "cc1", late);
    expect(dbMock.platformJob.create.mock.calls[1][0].data.sendAfter).toBeNull();
  });

  it("go-live S6: the note about a club still setting up is an owner purpose, held through quiet hours like an approval", async () => {
    const out = await queueOwnerDm("Riverside FC has been approved for 3 days", "owner-setup-stuck", "org-riverside:setup-stuck", NOON);
    expect(out).toEqual({ queued: 1, skipped: 0 });
    expect(dbMock.platformJob.create.mock.calls[0][0].data).toMatchObject({
      purpose: "owner-setup-stuck",
      refId: "org-riverside:setup-stuck",
      sendAfter: null,
    });
    await queueOwnerDm("x", "owner-setup-stuck", "org-other:setup-stuck", new Date("2026-09-29T22:30:00Z"));
    expect(dbMock.platformJob.create.mock.calls[1][0].data.sendAfter.toISOString()).toBe("2026-09-30T08:00:00.000Z");
  });

  it("go-live S6: one note per club, ever, by (purpose, refId, phone)", async () => {
    dbMock.platformJob.findFirst.mockResolvedValue({ id: "already" });
    expect(await queueOwnerDm("x", "owner-setup-stuck", "org-riverside:setup-stuck", NOON)).toEqual({ queued: 0, skipped: 1 });
    expect(dbMock.platformJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { kind: "dm", purpose: "owner-setup-stuck", refId: "org-riverside:setup-stuck", phone: "447700900001" },
      }),
    );
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
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
