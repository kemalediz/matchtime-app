/**
 * THE PLATFORM CHANNEL (self-join slice 3, plan sections 3.3 and 7).
 *
 * `PlatformJob` carries the DMs and actions that belong to no live club.
 * These tests pin:
 *   - who may be messaged, per purpose (rule 12 of section 7): a sign-up
 *     code may go to any number, because that is how a number gets
 *     verified; a connect reply or decision DM only to a number MatchTime
 *     already knows; owner DMs never through this door at all;
 *   - claim-on-dispatch: queued -> claimed by compare-and-set, the same
 *     at-most-once rule as due-posts, so two pollers cannot both send;
 *   - honest outcomes: a failed send is `failed`, never `sent`, and is not
 *     retried; a paced DM is released back to `queued`;
 *   - leaving a group is refused, at queue time AND at dispatch time, for
 *     any group an approved club owns (Sutton FC's group can never be left
 *     by this channel).
 *
 * db is mocked. No network, no model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  platformJob: {
    create: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
    findFirst: vi.fn(),
  },
  user: { findFirst: vi.fn() },
  organisation: { findMany: vi.fn(), findFirst: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import {
  BRIDGE_DMS_PER_POLL,
  MAX_JOBS_PER_POLL,
  PLATFORM_JOBS_CAPABLE_HEADER,
  bridgePlatformDmsForLegacyPi,
  OTP_DM_TTL_MS,
  PlatformDmRefused,
  claimDuePlatformJobs,
  parsePlatformJobKey,
  planPlatformDispatch,
  platformJobKey,
  queuePlatformDm,
  queuePlatformInviteCode,
  queuePlatformLeaveGroup,
  recordPlatformJobOutcome,
} from "../platform-jobs";

const NOW = new Date("2026-09-29T12:00:00Z");

function job(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "pj1",
    kind: "dm",
    phone: "447700900123",
    groupId: null,
    text: "hello",
    purpose: "connect-reply",
    refId: null,
    status: "queued",
    sendAfter: null,
    createdAt: new Date(NOW.getTime() - 60_000),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.platformJob.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "new-job",
    ...data,
  }));
  dbMock.platformJob.updateMany.mockResolvedValue({ count: 1 });
  dbMock.organisation.findMany.mockResolvedValue([]);
  dbMock.organisation.findFirst.mockResolvedValue(null);
  dbMock.user.findFirst.mockResolvedValue(null);
});

describe("keys", () => {
  it("round-trips a platform job id through the due-posts key", () => {
    expect(platformJobKey("abc")).toBe("platform-abc");
    expect(parsePlatformJobKey("platform-abc")).toBe("abc");
  });

  it("does not claim any existing key class", () => {
    for (const k of ["botjob-1", "org-x:y", "m1:rate-dm:u1", "offer-1", "retro-react-1", "platform-"]) {
      expect(parsePlatformJobKey(k)).toBeNull();
    }
  });
});

describe("queuePlatformDm: who MatchTime may message", () => {
  it("queues a sign-up code to a number nobody knows yet (the one standing exception)", async () => {
    const out = await queuePlatformDm({ phone: "+44 7700 900123", text: "code 123456", purpose: "otp" });
    expect(out.id).toBe("new-job");
    expect(dbMock.platformJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "dm",
        phone: "447700900123",
        text: "code 123456",
        purpose: "otp",
        status: "queued",
      }),
    });
    expect(dbMock.user.findFirst).not.toHaveBeenCalled();
  });

  it("refuses a connect reply to a number MatchTime does not know", async () => {
    await expect(
      queuePlatformDm({ phone: "447700900999", text: "hi", purpose: "connect-reply" }),
    ).rejects.toBeInstanceOf(PlatformDmRefused);
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("queues a connect reply to a known user's number", async () => {
    dbMock.user.findFirst.mockResolvedValue({ id: "u1" });
    await queuePlatformDm({ phone: "447700900123", text: "hi", purpose: "connect-reply", refId: "cc1" });
    expect(dbMock.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { phoneNumber: "+447700900123" } }),
    );
    expect(dbMock.platformJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ purpose: "connect-reply", refId: "cc1" }),
    });
  });

  it("refuses the owner purposes: those go through queueOwnerDm and nowhere else", async () => {
    for (const purpose of ["owner-approval", "owner-ack", "owner-setup-stuck"]) {
      await expect(
        queuePlatformDm({ phone: "447700900123", text: "x", purpose: purpose as never }),
      ).rejects.toThrow(/queueOwnerDm/);
    }
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("refuses an unknown purpose, an invalid number and an empty text", async () => {
    await expect(queuePlatformDm({ phone: "447700900123", text: "x", purpose: "health" as never })).rejects.toThrow();
    await expect(queuePlatformDm({ phone: "12", text: "x", purpose: "otp" })).rejects.toThrow(/phone/i);
    await expect(queuePlatformDm({ phone: "447700900123", text: "  ", purpose: "otp" })).rejects.toThrow(/text/i);
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });
});

describe("queuePlatformDm: go-live slices S6 and S7", () => {
  it("the reminder and the admin group command are platform purposes, to a known number only", async () => {
    for (const purpose of ["setup-reminder", "setup-admin-code"] as const) {
      dbMock.user.findFirst.mockResolvedValue(null);
      await expect(queuePlatformDm({ phone: "447700900123", text: "x", purpose })).rejects.toMatchObject({ code: "number-not-known" });
      dbMock.user.findFirst.mockResolvedValue({ id: "u1" });
      await queuePlatformDm({ phone: "447700900123", text: "x", purpose, refId: "org-a:x" });
      expect(dbMock.platformJob.create.mock.calls.at(-1)![0].data).toMatchObject({ purpose, refId: "org-a:x", status: "queued" });
    }
  });

  it("createdAt is written only when given (two DMs queued in one transaction, in a fixed order)", async () => {
    dbMock.user.findFirst.mockResolvedValue({ id: "u1" });
    await queuePlatformDm({ phone: "447700900123", text: "x", purpose: "setup-ask" });
    expect("createdAt" in dbMock.platformJob.create.mock.calls[0][0].data).toBe(false);
    const at = new Date("2026-10-12T11:00:00.001Z");
    await queuePlatformDm({ phone: "447700900123", text: "y", purpose: "setup-admin-code", createdAt: at });
    expect(dbMock.platformJob.create.mock.calls[1][0].data.createdAt).toEqual(at);
  });

  it("dispatch hands the setup DM out before its admin group command, one millisecond apart", () => {
    const base = new Date(NOW.getTime() - 60_000);
    const plan = planPlatformDispatch(
      [
        job({ id: "code", purpose: "setup-admin-code", createdAt: new Date(base.getTime() + 1) }),
        job({ id: "ask", purpose: "setup-ask", createdAt: base }),
      ],
      { now: NOW, approvedGroupIds: new Set(), limit: 5 },
    );
    expect(plan.dispatch.map((d) => d.id)).toEqual(["ask", "code"]);
  });
});

describe("queuePlatformLeaveGroup", () => {
  it("queues a leave for a group no approved club owns", async () => {
    const out = await queuePlatformLeaveGroup({ groupId: "120363900000000001@g.us", refId: "cc1" });
    expect(out).toEqual({ id: "new-job" });
    expect(dbMock.platformJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "leave-group",
        groupId: "120363900000000001@g.us",
        purpose: "leave-group",
        refId: "cc1",
      }),
    });
  });

  it("refuses to queue leaving an approved club's group (Sutton FC can never be left this way)", async () => {
    dbMock.organisation.findFirst.mockResolvedValue({ id: "sutton" });
    const out = await queuePlatformLeaveGroup({ groupId: "120363000000000001@g.us" });
    expect(out).toEqual({ refused: "approved-club-group" });
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("slice 2a: refuses to queue leaving a club's linked admin group", async () => {
    dbMock.organisation.findFirst.mockImplementation(async (a: { where: Record<string, unknown> }) =>
      a.where.adminGroupId ? { id: "org-fnf" } : null,
    );
    const out = await queuePlatformLeaveGroup({ groupId: "120363900000000001@g.us" });
    expect(out).toEqual({ refused: "admin-group" });
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("does not queue a second leave for the same group while one is outstanding", async () => {
    dbMock.platformJob.findFirst.mockResolvedValue({ id: "existing" });
    const out = await queuePlatformLeaveGroup({ groupId: "120363900000000001@g.us" });
    expect(out).toEqual({ id: "existing" });
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });
});

describe("planPlatformDispatch (pure)", () => {
  it("puts sign-up codes first, then oldest first, up to the limit", () => {
    const jobs = [
      job({ id: "old-reply", createdAt: new Date(NOW.getTime() - 300_000) }),
      job({ id: "otp", purpose: "otp", createdAt: new Date(NOW.getTime() - 10_000) }),
      job({ id: "leave", kind: "leave-group", phone: null, text: null, groupId: "g1", purpose: "leave-group" }),
    ];
    const plan = planPlatformDispatch(jobs, { now: NOW, approvedGroupIds: new Set(), limit: 2 });
    expect(plan.dispatch.map((j) => j.id)).toEqual(["otp", "old-reply"]);
    expect(plan.refuse).toEqual([]);
  });

  it("fails a sign-up code that waited past its code's life instead of sending a dead code", () => {
    const stale = job({ id: "stale", purpose: "otp", createdAt: new Date(NOW.getTime() - OTP_DM_TTL_MS - 1) });
    const plan = planPlatformDispatch([stale], { now: NOW, approvedGroupIds: new Set(), limit: 5 });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refuse).toEqual([{ id: "stale", reason: expect.stringMatching(/expired/i) }]);
  });

  it("refuses at dispatch a leave for a group that an approved club now owns", () => {
    const leave = job({ id: "leave", kind: "leave-group", phone: null, text: null, groupId: "g-live", purpose: "leave-group" });
    const plan = planPlatformDispatch([leave], { now: NOW, approvedGroupIds: new Set(["g-live"]), limit: 5 });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refuse).toEqual([{ id: "leave", reason: expect.stringMatching(/approved club/i) }]);
  });

  it("slice 2a: refuses at dispatch a leave for a group that is now a club's admin group", () => {
    const leave = job({ id: "leave", kind: "leave-group", phone: null, text: null, groupId: "g-hq", purpose: "leave-group" });
    const plan = planPlatformDispatch([leave], {
      now: NOW,
      approvedGroupIds: new Set(),
      adminGroupIds: new Set(["g-hq"]),
      limit: 5,
    });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refuse).toEqual([{ id: "leave", reason: expect.stringMatching(/admin group/i) }]);
  });

  it("refuses a malformed row rather than handing the Pi nothing to send", () => {
    const plan = planPlatformDispatch([job({ id: "bad", phone: null })], {
      now: NOW,
      approvedGroupIds: new Set(),
      limit: 5,
    });
    expect(plan.refuse.map((r) => r.id)).toEqual(["bad"]);
  });
});

describe("claimDuePlatformJobs: claim-on-dispatch", () => {
  it("claims each job with a compare-and-set on status queued, and returns only what it won", async () => {
    dbMock.platformJob.findMany.mockResolvedValue([job({ id: "a" }), job({ id: "b" })]);
    dbMock.platformJob.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 }); // another poller won "b"
    const out = await claimDuePlatformJobs({ now: NOW });
    expect(out).toEqual([{ id: "a", kind: "dm", phone: "447700900123", text: "hello", purpose: "connect-reply" }]);
    expect(dbMock.platformJob.updateMany).toHaveBeenCalledWith({
      where: { id: "a", status: "queued" },
      data: { status: "claimed", claimedAt: NOW },
    });
  });

  it("only reads queued jobs that are due: sign-up codes in one read, everything else in another", async () => {
    dbMock.platformJob.findMany.mockResolvedValue([]);
    await claimDuePlatformJobs({ now: NOW, kinds: ["dm"] });
    const due = {
      status: "queued",
      kind: { in: ["dm"] },
      OR: [{ sendAfter: null }, { sendAfter: { lte: NOW } }],
    };
    expect(dbMock.platformJob.findMany).toHaveBeenCalledTimes(2);
    expect(dbMock.platformJob.findMany.mock.calls[0][0].where).toEqual({ ...due, purpose: "otp" });
    expect(dbMock.platformJob.findMany.mock.calls[1][0].where).toEqual({ ...due, purpose: { not: "otp" } });
    for (const call of dbMock.platformJob.findMany.mock.calls) {
      expect(call[0].orderBy).toEqual({ createdAt: "asc" });
      expect(call[0].take).toBe(50);
    }
  });

  // PR #234 review, fix 1c. The read used to take the 50 OLDEST queued
  // rows and only then rank codes first, so a backlog of more than 50
  // older DMs hid a new sign-up code until its ten minutes were up.
  it("a sign-up code is never starved by a backlog: 60 older queued replies and one new code", async () => {
    const backlog = Array.from({ length: 60 }, (_, i) =>
      job({ id: `reply-${i}`, purpose: "setup-reply", createdAt: new Date(NOW.getTime() - (3_600_000 - i * 1000)) }),
    );
    const code = job({ id: "code", purpose: "otp", text: "Your code: 123456", createdAt: new Date(NOW.getTime() - 5_000) });
    // A stand-in for the table that honours the filter, the order and the limit.
    dbMock.platformJob.findMany.mockImplementation(
      async (args: { where: { purpose?: string | { not: string } }; take: number }) => {
        const p = args.where.purpose;
        return [...backlog, code]
          .filter((r) => (typeof p === "string" ? r.purpose === p : p ? r.purpose !== p.not : true))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, args.take);
      },
    );
    const out = await claimDuePlatformJobs({ now: NOW });
    expect(out).toHaveLength(MAX_JOBS_PER_POLL);
    expect(out[0]).toMatchObject({ id: "code", purpose: "otp" });
    // The rest are still the oldest first.
    expect(out.slice(1).map((j) => j.id)).toEqual(["reply-0", "reply-1", "reply-2", "reply-3"]);
  });

  it("a row the two reads both returned is handed out once", async () => {
    dbMock.platformJob.findMany.mockResolvedValue([job({ id: "a" }), job({ id: "b", purpose: "otp" })]);
    const out = await claimDuePlatformJobs({ now: NOW });
    expect(out.map((j) => j.id)).toEqual(["b", "a"]);
  });

  it("marks refused jobs failed, with the reason, and does not hand them out", async () => {
    dbMock.platformJob.findMany.mockResolvedValue([
      job({ id: "leave", kind: "leave-group", phone: null, text: null, groupId: "g-live", purpose: "leave-group" }),
    ]);
    dbMock.organisation.findMany.mockResolvedValue([{ whatsappGroupId: "g-live" }]);
    const out = await claimDuePlatformJobs({ now: NOW });
    expect(out).toEqual([]);
    expect(dbMock.platformJob.updateMany).toHaveBeenCalledWith({
      where: { id: "leave", status: "queued" },
      data: expect.objectContaining({ status: "failed", failedAt: NOW, failReason: expect.any(String) }),
    });
  });

  it("hands out at most MAX_JOBS_PER_POLL by default", async () => {
    dbMock.platformJob.findMany.mockResolvedValue(
      Array.from({ length: MAX_JOBS_PER_POLL + 3 }, (_, i) => job({ id: `j${i}` })),
    );
    const out = await claimDuePlatformJobs({ now: NOW });
    expect(out).toHaveLength(MAX_JOBS_PER_POLL);
  });
});

describe("recordPlatformJobOutcome: a failed send is never recorded as sent", () => {
  it("sent: stamps sentAt and the message id, only from claimed", async () => {
    await recordPlatformJobOutcome("a", { outcome: "sent", waMessageId: "wa1" }, NOW);
    expect(dbMock.platformJob.updateMany).toHaveBeenCalledWith({
      where: { id: "a", status: "claimed" },
      data: { status: "sent", sentAt: NOW, waMessageId: "wa1" },
    });
  });

  it("failed: failedAt and the reason, NOT sentAt", async () => {
    await recordPlatformJobOutcome("a", { outcome: "failed", reason: "not on WhatsApp" }, NOW);
    const { data } = dbMock.platformJob.updateMany.mock.calls[0][0];
    expect(data).toEqual({ status: "failed", failedAt: NOW, failReason: "not on WhatsApp" });
    expect(data).not.toHaveProperty("sentAt");
  });

  it("release: back to queued, claim cleared, so the next poll re-emits it", async () => {
    await recordPlatformJobOutcome("a", { outcome: "release" }, NOW);
    // ONE statement, as always. Since the go-live merge (PR #235) its WHERE
    // also skips a job that was CANCELLED while the Pi held it (marked by
    // `cancelQueuedPlatformDms`), which is failed instead of re-queued:
    // see club-setup-dm-cancel.test.ts. No job has that mark unless a
    // setup DM was cancelled, so for every other job nothing changes.
    expect(dbMock.platformJob.updateMany).toHaveBeenCalledTimes(1);
    expect(dbMock.platformJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: "a",
        status: "claimed",
        OR: [{ failReason: null }, { NOT: { failReason: { startsWith: "cancelled: " } } }],
      },
      data: { status: "queued", claimedAt: null },
    });
  });

  it("sent, failed and unconfirmed reports are compare-and-sets on 'claimed' alone, exactly as before", async () => {
    for (const outcome of [{ outcome: "sent" as const }, { outcome: "failed" as const, reason: "x" }, { outcome: "unconfirmed" as const, reason: "y" }]) {
      dbMock.platformJob.updateMany.mockClear();
      await recordPlatformJobOutcome("a", outcome, NOW);
      expect(dbMock.platformJob.updateMany.mock.calls[0][0].where).toEqual({ id: "a", status: "claimed" });
    }
  });

  it("unconfirmed: an older Pi's id-less ack is recorded as unconfirmed, not sent", async () => {
    await recordPlatformJobOutcome("a", { outcome: "unconfirmed", reason: "no id" }, NOW);
    const { data } = dbMock.platformJob.updateMany.mock.calls[0][0];
    expect(data).toEqual({ status: "unconfirmed", failReason: "no id" });
  });

  it("reports whether anything changed (a replayed ack changes nothing)", async () => {
    dbMock.platformJob.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await recordPlatformJobOutcome("a", { outcome: "sent" }, NOW)).toEqual({ updated: false });
  });

  it("truncates a huge failure reason", async () => {
    await recordPlatformJobOutcome("a", { outcome: "failed", reason: "x".repeat(5000) }, NOW);
    const { data } = dbMock.platformJob.updateMany.mock.calls[0][0];
    expect(data.failReason.length).toBeLessThanOrEqual(500);
  });
});

describe("the due-posts bridge for a Pi built before slice 3", () => {
  const req = (h: Record<string, string> = {}) => new Request("http://x/api/whatsapp/due-posts?groupId=g", { headers: h });

  it("uses the header name the Pi sends", () => {
    expect(PLATFORM_JOBS_CAPABLE_HEADER).toBe("x-mt-platform-jobs");
  });

  it("bridges due platform DMs as ordinary dm instructions keyed platform-<id>, DMs only", async () => {
    dbMock.platformJob.findMany.mockResolvedValue([job({ id: "a", purpose: "otp", text: "code 1" })]);
    const out = await bridgePlatformDmsForLegacyPi(req(), NOW);
    expect(out).toEqual([{ kind: "dm", key: "platform-a", phone: "447700900123", text: "code 1" }]);
    expect(dbMock.platformJob.findMany.mock.calls[0][0].where.kind).toEqual({ in: ["dm"] });
  });

  it("bridges at most BRIDGE_DMS_PER_POLL per poll", async () => {
    dbMock.platformJob.findMany.mockResolvedValue([job({ id: "a" }), job({ id: "b" }), job({ id: "c" })]);
    expect(await bridgePlatformDmsForLegacyPi(req(), NOW)).toHaveLength(BRIDGE_DMS_PER_POLL);
  });

  it("bridges nothing to a Pi that polls /platform-jobs itself", async () => {
    dbMock.platformJob.findMany.mockResolvedValue([job({ id: "a" })]);
    expect(await bridgePlatformDmsForLegacyPi(req({ [PLATFORM_JOBS_CAPABLE_HEADER]: "1" }), NOW)).toEqual([]);
    expect(dbMock.platformJob.findMany).not.toHaveBeenCalled();
  });

  it("fails open: a broken bridge never breaks a club's due-posts", async () => {
    dbMock.platformJob.findMany.mockRejectedValue(new Error('relation "PlatformJob" does not exist'));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await bridgePlatformDmsForLegacyPi(req(), NOW)).toEqual([]);
    spy.mockRestore();
  });
});

describe("the group invite code job (pool L8)", () => {
  it("queues reading the invite code of an approved club's group, once per invitation while outstanding", async () => {
    dbMock.organisation.findFirst.mockResolvedValue({ id: "fnf" });
    dbMock.platformJob.findFirst.mockResolvedValue(null);
    const out = await queuePlatformInviteCode({ groupId: "120363000000000009@g.us", refId: "inv1" });
    expect(out).toEqual({ id: "new-job" });
    expect(dbMock.platformJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: "invite-code", groupId: "120363000000000009@g.us", purpose: "invite-code", refId: "inv1", status: "queued" }),
    });
    dbMock.platformJob.findFirst.mockResolvedValue({ id: "existing" });
    expect(await queuePlatformInviteCode({ groupId: "120363000000000009@g.us", refId: "inv1" })).toEqual({ id: "existing" });
  });

  it("refuses a group no approved club owns, and anything that is not a group", async () => {
    expect(await queuePlatformInviteCode({ groupId: "120363000000000009@g.us", refId: "inv1" })).toEqual({ refused: "not-a-club-group" });
    expect(await queuePlatformInviteCode({ groupId: "447700900123@s.whatsapp.net", refId: "inv1" })).toEqual({ refused: "not-a-group" });
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("dispatch hands it out only for a group an approved club still owns", () => {
    const code = job({ id: "ic", kind: "invite-code", phone: null, text: null, groupId: "g-live", purpose: "invite-code" });
    const ok = planPlatformDispatch([code], { now: NOW, approvedGroupIds: new Set(["g-live"]), limit: 5 });
    expect(ok.dispatch.map((d) => d.instruction)).toEqual([{ id: "ic", kind: "invite-code", groupId: "g-live" }]);
    const gone = planPlatformDispatch([code], { now: NOW, approvedGroupIds: new Set(), limit: 5 });
    expect(gone.dispatch).toEqual([]);
    expect(gone.refuse).toEqual([{ id: "ic", reason: expect.stringMatching(/no approved club/i) }]);
    const bad = planPlatformDispatch([job({ id: "ic2", kind: "invite-code", phone: null, text: null, groupId: null, purpose: "invite-code" })], { now: NOW, approvedGroupIds: new Set(), limit: 5 });
    expect(bad.refuse.map((r) => r.id)).toEqual(["ic2"]);
  });

  it("the club invite DMs are platform purposes, to a known number only", async () => {
    for (const purpose of ["club-invite-ask", "club-invite-link", "club-invite-closed"] as const) {
      await expect(queuePlatformDm({ phone: "+447700900123", text: "x", purpose })).rejects.toMatchObject({ code: "number-not-known" });
    }
  });
});
