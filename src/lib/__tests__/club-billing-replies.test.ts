/**
 * CLUB FEE BILLING, slice B1 (review fixes): a club paused for the club
 * fee must not answer anything, through any door that does not go through
 * the group's analyze route:
 *
 *   - its linked ADMIN group: not handed to the Pi as an admin group, but
 *     listed silent, and the server's admin-group handler refuses it;
 *   - organiser pick replies (admin group and DM): never engaged;
 *
 * Each with the flag OFF: exactly today's queries and behaviour.
 * db is mocked. No network, no model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  organisation: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
  organiserPickRound: { findFirst: vi.fn() },
  membership: { findFirst: vi.fn(), findMany: vi.fn() },
  sentNotification: { create: vi.fn(), deleteMany: vi.fn() },
  user: { findMany: vi.fn() },
  clubConnect: { findMany: vi.fn() },
  unsolicitedGroup: { findMany: vi.fn() },
  botJob: { create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { loadAdminGroups } from "../admin-group-link";
import { handleAdminGroupMessage } from "../admin-group";
import { handleOrganiserPickDm, handlePickReply } from "../organiser-pick";
import { loadSilentGroupIds } from "../club-approval";

const ENV = process.env.BILLING_ENABLED;
const on = () => (process.env.BILLING_ENABLED = "1");
const off = () => delete process.env.BILLING_ENABLED;
afterEach(() => {
  if (ENV === undefined) delete process.env.BILLING_ENABLED;
  else process.env.BILLING_ENABLED = ENV;
});

const SUTTON_GROUP = "120363000000000001@g.us";
const PAUSED_GROUP = "120363000000000099@g.us";
const PAUSED_HQ = "120363000000000098@g.us";
const SUTTON_HQ = "120363000000000097@g.us";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadAdminGroups: a paused club's admin group is not an admin group to the Pi", () => {
  beforeEach(() => dbMock.organisation.findMany.mockResolvedValue([]));
  it("flag off: exactly today's query", async () => {
    off();
    await loadAdminGroups();
    expect(dbMock.organisation.findMany.mock.calls[0][0].where).toEqual({
      approvalStatus: "approved",
      adminGroupId: { not: null },
    });
  });
  it("flag on: billing-paused clubs left out", async () => {
    on();
    await loadAdminGroups();
    expect(dbMock.organisation.findMany.mock.calls[0][0].where).toEqual({
      approvalStatus: "approved",
      billingStatus: { not: "paused" },
      adminGroupId: { not: null },
    });
  });
});

describe("loadSilentGroupIds: a paused club's admin group is silent (flag on)", () => {
  type Where = { approvalStatus?: unknown; billingStatus?: unknown; adminGroupId?: unknown };
  beforeEach(() => {
    dbMock.organisation.findMany.mockImplementation((args: { where: Where; select: Record<string, boolean> }) => {
      const w = args.where;
      const excludesPaused = JSON.stringify(w.billingStatus) === JSON.stringify({ not: "paused" });
      if (w.billingStatus === "paused") {
        return Promise.resolve([{ whatsappGroupId: PAUSED_GROUP, adminGroupId: PAUSED_HQ }]);
      }
      if (w.adminGroupId !== undefined) {
        return Promise.resolve(
          excludesPaused ? [{ adminGroupId: SUTTON_HQ }] : [{ adminGroupId: SUTTON_HQ }, { adminGroupId: PAUSED_HQ }],
        );
      }
      if (w.approvalStatus === "approved") {
        return Promise.resolve(
          excludesPaused
            ? [{ whatsappGroupId: SUTTON_GROUP }]
            : [{ whatsappGroupId: SUTTON_GROUP }, { whatsappGroupId: PAUSED_GROUP }],
        );
      }
      return Promise.resolve([]);
    });
    dbMock.clubConnect.findMany.mockResolvedValue([]);
    dbMock.unsolicitedGroup.findMany.mockResolvedValue([]);
  });

  it("flag off: nothing silent, the admin-groups query is today's", async () => {
    off();
    expect(await loadSilentGroupIds()).toEqual([]);
    const adminQ = dbMock.organisation.findMany.mock.calls.find((c) => c[0].where.adminGroupId !== undefined);
    expect(adminQ?.[0]).toEqual({ where: { adminGroupId: { not: null } }, select: { adminGroupId: true } });
  });

  it("flag on: the paused club's group AND its admin group are silent; Sutton's never", async () => {
    on();
    expect((await loadSilentGroupIds()).sort()).toEqual([PAUSED_HQ, PAUSED_GROUP].sort());
  });
});

describe("handleAdminGroupMessage: the server refuses a paused club's admin group", () => {
  beforeEach(() => {
    dbMock.organisation.findFirst.mockResolvedValue({ id: "paused-org", billingStatus: "paused" });
    dbMock.organiserPickRound.findFirst.mockResolvedValue({ id: "round-1" });
  });

  it("flag on: ignored before anything is read or written", async () => {
    on();
    const r = await handleAdminGroupMessage({ groupId: PAUSED_HQ, messageId: "m1", text: "1", senderPhone: "447700900001" });
    expect(r).toEqual({ handled: false, ignored: "club-billing-paused", orgId: "paused-org", replyText: null });
    expect(dbMock.organiserPickRound.findFirst).not.toHaveBeenCalled();
    expect(dbMock.sentNotification.create).not.toHaveBeenCalled();
  });

  it("flag off: carries on exactly as before (reaches the round lookup)", async () => {
    off();
    dbMock.organiserPickRound.findFirst.mockResolvedValue(null);
    const r = await handleAdminGroupMessage({ groupId: PAUSED_HQ, messageId: "m1", text: "1", senderPhone: "447700900001" });
    expect(r).toMatchObject({ handled: false, ignored: "no-open-pick" });
  });
});

describe("handlePickReply: never engages for a paused club", () => {
  it("flag on: not handled, no round read", async () => {
    on();
    dbMock.organisation.findUnique.mockResolvedValue({
      id: "paused-org",
      name: "P",
      language: "en",
      benchPickMode: "organiser",
      benchPickFallback: "bench-offer",
      approvalStatus: "approved",
      dormantAt: null,
      billingStatus: "paused",
      dropOutDeadlineDay: null,
      dropOutDeadlineTime: null,
    });
    const r = await handlePickReply({ orgId: "paused-org", door: "dm", senderUserId: "u1", text: "1" });
    expect(r.handled).toBe(false);
    expect(dbMock.organiserPickRound.findFirst).not.toHaveBeenCalled();
  });
});

describe("handleOrganiserPickDm: a paused club's admins are not looked at", () => {
  beforeEach(() => {
    dbMock.organiserPickRound.findFirst.mockResolvedValue({ id: "round-1" });
    dbMock.user.findMany.mockResolvedValue([{ id: "u1", phoneNumber: "+447700900001" }]);
    dbMock.membership.findMany.mockResolvedValue([]);
  });
  it("flag off: today's membership query", async () => {
    off();
    await handleOrganiserPickDm({ phone: "447700900001", text: "1", waMessageId: "w1" });
    expect(dbMock.membership.findMany.mock.calls[0][0].where).toEqual({
      userId: "u1",
      leftAt: null,
      role: { in: ["OWNER", "ADMIN"] },
      org: { benchPickMode: "organiser" },
    });
  });
  it("flag on: billing-paused clubs left out, so nothing is claimed or written for them", async () => {
    on();
    await handleOrganiserPickDm({ phone: "447700900001", text: "1", waMessageId: "w1" });
    expect(dbMock.membership.findMany.mock.calls[0][0].where.org).toEqual({
      benchPickMode: "organiser",
      billingStatus: { not: "paused" },
    });
    expect(dbMock.sentNotification.create).not.toHaveBeenCalled();
  });
});
