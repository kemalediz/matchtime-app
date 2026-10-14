/**
 * The server's half of "can MatchTime post in this group" (2026-10-14):
 * what one reading from the Pi does, against a mocked database.
 *
 *   a live club's group      blocked: a health condition and ONE notice to
 *                            the club's organisers (their admin channel);
 *                            postable again: the condition resolved.
 *   a club's admin group     the same, its own condition; admin notices go
 *                            by DM meanwhile (admin-channel.ts).
 *   a held connect add       postable now: the link is finished.
 *   anything else            stored, nothing else.
 * Never Kemal by ops DM; never a throw on a missing table.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  organisation: { findMany: vi.fn() },
  groupPostState: { findUnique: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
  opsAlert: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  $executeRaw: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
const adminChannel = vi.hoisted(() => ({ sendAdminNotice: vi.fn() }));
vi.mock("@/lib/admin-channel", () => adminChannel);
const groupAdd = vi.hoisted(() => ({ resumeHeldGroupAdd: vi.fn() }));
vi.mock("@/lib/group-add", () => groupAdd);

import { recordGroupPostability, ADMIN_GROUP_POSTING_KIND, GROUP_POSTING_KIND } from "../group-postability";

const NOW = new Date("2026-10-14T12:00:00Z");
const EARLIER = new Date("2026-10-14T09:00:00Z");
const GROUP = "120363000000000001@g.us";
const BLOCKED = { announce: true, communityAnnounce: false, botIsAdmin: false };
const OPEN = { announce: true, communityAnnounce: false, botIsAdmin: true };

type Where = { where: Record<string, unknown> };

function liveClub() {
  dbMock.organisation.findMany.mockImplementation(async (a: Where) =>
    a.where.whatsappGroupId === GROUP ? [{ id: "sutton", name: "Sutton FC", language: "en" }] : [],
  );
}
function adminGroupOf() {
  dbMock.organisation.findMany.mockImplementation(async (a: Where) =>
    a.where.adminGroupId === GROUP ? [{ id: "sutton", name: "Sutton FC", language: "tr", adminGroupSubject: "Sutton admins" }] : [],
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.organisation.findMany.mockResolvedValue([]);
  dbMock.groupPostState.findUnique.mockResolvedValue(null);
  dbMock.groupPostState.upsert.mockResolvedValue({});
  dbMock.groupPostState.updateMany.mockResolvedValue({ count: 1 });
  dbMock.opsAlert.findFirst.mockResolvedValue(null);
  dbMock.opsAlert.create.mockResolvedValue({ id: "a1" });
  dbMock.opsAlert.updateMany.mockResolvedValue({ count: 1 });
  adminChannel.sendAdminNotice.mockResolvedValue({ channel: "dm", queued: 1 });
  groupAdd.resumeHeldGroupAdd.mockResolvedValue({ kind: "none" });
});

describe("the health page", () => {
  it("lists both conditions (they are not hourly health: findings, which the sweep would close)", async () => {
    const { NON_HEALTH_CONDITION_KINDS, alertKindLabel, isActiveAlert } = await import("../ops-alerts");
    expect(NON_HEALTH_CONDITION_KINDS).toEqual(expect.arrayContaining([GROUP_POSTING_KIND, ADMIN_GROUP_POSTING_KIND]));
    expect(GROUP_POSTING_KIND.startsWith("health:")).toBe(false);
    expect(alertKindLabel(GROUP_POSTING_KIND)).toBe("Cannot post in the group");
    expect(isActiveAlert({ kind: GROUP_POSTING_KIND, resolvedAt: null })).toBe(true);
  });
});

describe("recordGroupPostability", () => {
  it("stores every reading, group id and booleans only", async () => {
    const r = await recordGroupPostability({ groupId: GROUP, input: BLOCKED, now: NOW });
    expect(r.canPost).toBe(false);
    const up = dbMock.groupPostState.upsert.mock.calls[0][0];
    expect(up.where).toEqual({ groupId: GROUP });
    expect(up.create).toMatchObject({ groupId: GROUP, announce: true, botIsAdmin: false, canPost: false, blockedSince: NOW });
    // No club owns it: nothing else.
    expect(adminChannel.sendAdminNotice).not.toHaveBeenCalled();
    expect(dbMock.opsAlert.create).not.toHaveBeenCalled();
  });

  it("a live club's group became admin-only: a health condition, and ONE notice to the club's organisers", async () => {
    liveClub();
    await recordGroupPostability({ groupId: GROUP, input: BLOCKED, now: NOW });
    expect(dbMock.opsAlert.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ orgId: "sutton", kind: GROUP_POSTING_KIND, severity: "critical", resolvedAt: null }),
    });
    expect(adminChannel.sendAdminNotice).toHaveBeenCalledTimes(1);
    const notice = adminChannel.sendAdminNotice.mock.calls[0][0];
    expect(notice.orgId).toBe("sutton");
    expect(notice.text).toMatch(/only admins can send messages/);
    // Marked told.
    expect(dbMock.groupPostState.updateMany).toHaveBeenCalledWith({
      where: { groupId: GROUP },
      data: { noticeSentAt: NOW },
    });
  });

  it("still blocked and already told: the condition is refreshed, nobody is told again", async () => {
    liveClub();
    dbMock.groupPostState.findUnique.mockResolvedValue({ groupId: GROUP, canPost: false, blockedSince: EARLIER, noticeSentAt: EARLIER });
    dbMock.opsAlert.findFirst.mockResolvedValue({ id: "a1" });
    await recordGroupPostability({ groupId: GROUP, input: BLOCKED, now: NOW });
    expect(adminChannel.sendAdminNotice).not.toHaveBeenCalled();
    expect(dbMock.opsAlert.create).not.toHaveBeenCalled();
    expect(dbMock.opsAlert.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: expect.objectContaining({ lastSeenAt: NOW }) });
  });

  it("MatchTime promoted: postable again, the condition resolved, the stretch cleared", async () => {
    liveClub();
    dbMock.groupPostState.findUnique.mockResolvedValue({ groupId: GROUP, canPost: false, blockedSince: EARLIER, noticeSentAt: EARLIER });
    const r = await recordGroupPostability({ groupId: GROUP, input: OPEN, now: NOW });
    expect(r.canPost).toBe(true);
    expect(dbMock.opsAlert.updateMany).toHaveBeenCalledWith({
      where: { orgId: "sutton", kind: GROUP_POSTING_KIND, resolvedAt: null },
      data: { resolvedAt: NOW, lastSeenAt: NOW },
    });
    const update = dbMock.groupPostState.upsert.mock.calls[0][0].update;
    expect(update).toMatchObject({ canPost: true, blockedSince: null });
    // Kept, so a flapping setting tells the organisers at most once a day.
    expect(update).not.toHaveProperty("noticeSentAt");
    expect(adminChannel.sendAdminNotice).not.toHaveBeenCalled();
  });

  it("a club's admin group: its own condition, and the notice (which falls back to DM) in the club's language", async () => {
    adminGroupOf();
    await recordGroupPostability({ groupId: GROUP, input: BLOCKED, now: NOW });
    expect(dbMock.opsAlert.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ orgId: "sutton", kind: ADMIN_GROUP_POSTING_KIND, severity: "warning" }),
    });
    expect(adminChannel.sendAdminNotice.mock.calls[0][0].text).toMatch(/yönetici grubunda/);
  });

  it("a held connect add, and MatchTime can post there now: the link is finished", async () => {
    dbMock.groupPostState.findUnique.mockResolvedValue({ groupId: GROUP, canPost: false, blockedSince: EARLIER, noticeSentAt: null, heldConnectId: "cc-ali" });
    groupAdd.resumeHeldGroupAdd.mockResolvedValue({ kind: "linked", connectId: "cc-ali", orgId: "org-r" });
    const r = await recordGroupPostability({ groupId: GROUP, input: OPEN, now: NOW });
    expect(groupAdd.resumeHeldGroupAdd).toHaveBeenCalledWith(GROUP, NOW);
    expect(r.resumed).toBe("linked");
  });

  it("a held add still blocked: nothing finished, and the organiser is not told twice from here", async () => {
    dbMock.groupPostState.findUnique.mockResolvedValue({ groupId: GROUP, canPost: false, blockedSince: EARLIER, noticeSentAt: null, heldConnectId: "cc-ali" });
    await recordGroupPostability({ groupId: GROUP, input: BLOCKED, now: NOW });
    expect(groupAdd.resumeHeldGroupAdd).not.toHaveBeenCalled();
    expect(adminChannel.sendAdminNotice).not.toHaveBeenCalled();
  });

  it("no table yet: the reading is not stored, nobody is told, no throw", async () => {
    liveClub();
    dbMock.groupPostState.findUnique.mockRejectedValue(Object.assign(new Error("missing"), { code: "P2021" }));
    dbMock.groupPostState.upsert.mockRejectedValue(Object.assign(new Error("missing"), { code: "P2021" }));
    const r = await recordGroupPostability({ groupId: GROUP, input: BLOCKED, now: NOW });
    expect(r.stored).toBe(false);
    expect(adminChannel.sendAdminNotice).not.toHaveBeenCalled();
  });
});
