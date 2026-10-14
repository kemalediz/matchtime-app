/**
 * The connect flow and a group MatchTime cannot post in (2026-10-14),
 * against a mocked database.
 *
 * DECISION: such a group is NOT linked. The add that matched an organiser's
 * request is put on hold (GroupPostState.heldConnectId), the request stays
 * as it was (dm_verified, so the organiser can still add MatchTime to the
 * players' group instead), the club stays draft, the owner hears nothing,
 * and the organiser gets ONE DM saying why and what to do. When MatchTime
 * is made an admin there, the link is finished exactly as a normal add
 * would have done it (`resumeHeldGroupAdd`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  organisation: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  clubConnect: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
  unsolicitedGroup: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  user: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  membership: { findMany: vi.fn() },
  onboardingSession: { findMany: vi.fn() },
  platformJob: { findFirst: vi.fn(), create: vi.fn() },
  groupPostState: { findUnique: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
  $executeRaw: vi.fn(),
  $transaction: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
const ownerDm = vi.hoisted(() => ({ queueOwnerDm: vi.fn() }));
vi.mock("@/lib/owner-dm", () => ownerDm);

import { handleSelfJoinGroupAdd, isSilentOutcome, resumeHeldGroupAdd } from "../group-add";

const NOW = new Date("2026-10-14T12:00:00Z");
const mins = (m: number) => new Date(NOW.getTime() + m * 60_000);
const GROUP = "120363400000000001@g.us";
const ALI = "447700900123";

const ADMIN_ONLY = { announce: true, communityAnnounce: false, botIsAdmin: false };
const COMMUNITY = { announce: true, communityAnnounce: true, botIsAdmin: false };
const IS_ADMIN = { announce: true, communityAnnounce: false, botIsAdmin: true };

function connectRow(over: Record<string, unknown> = {}) {
  return {
    id: "cc-ali",
    orgId: "org-riverside",
    userId: "u-ali",
    code: "7KQ2",
    status: "dm_verified",
    phone: ALI,
    dmAt: mins(-10),
    dmPhone: ALI,
    dmLid: null,
    issuedAt: mins(-20),
    expiresAt: mins(40),
    addWindowEndsAt: mins(24 * 60 - 10),
    ...over,
  };
}

const PARTICIPANTS = [
  { phone: ALI, pushname: "Ali" },
  { phone: "447700900201", pushname: "Ben" },
];

const add = (over: Record<string, unknown> = {}) =>
  handleSelfJoinGroupAdd({
    groupId: GROUP,
    groupSubject: "Riverside Announcements",
    addedByPhone: ALI,
    participants: PARTICIPANTS,
    enrichmentHistory: [],
    now: NOW,
    ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(dbMock));
  dbMock.organisation.findFirst.mockResolvedValue(null);
  dbMock.organisation.findUnique.mockResolvedValue({ name: "Riverside FC", language: "en" });
  dbMock.organisation.updateMany.mockResolvedValue({ count: 1 });
  dbMock.clubConnect.findFirst.mockResolvedValue(null);
  dbMock.clubConnect.findUnique.mockResolvedValue(null);
  dbMock.clubConnect.findMany.mockImplementation(async (a: { where?: Record<string, unknown> }) =>
    a?.where?.status === "group_linked" && a.where.botRemovedAt != null ? [] : [connectRow()],
  );
  dbMock.clubConnect.updateMany.mockResolvedValue({ count: 1 });
  dbMock.clubConnect.count.mockResolvedValue(0);
  dbMock.unsolicitedGroup.findFirst.mockResolvedValue(null);
  dbMock.unsolicitedGroup.create.mockResolvedValue({ id: "ug-1" });
  dbMock.unsolicitedGroup.updateMany.mockResolvedValue({ count: 0 });
  dbMock.user.findUnique.mockResolvedValue({ name: "Ali Demir" });
  dbMock.user.findFirst.mockResolvedValue({ id: "u-ali" });
  dbMock.membership.findMany.mockResolvedValue([]);
  dbMock.user.findMany.mockResolvedValue([]);
  dbMock.onboardingSession.findMany.mockResolvedValue([]);
  dbMock.organisation.findMany.mockResolvedValue([]);
  dbMock.platformJob.findFirst.mockResolvedValue(null);
  dbMock.platformJob.create.mockResolvedValue({ id: "pj-1" });
  dbMock.groupPostState.findUnique.mockResolvedValue(null);
  dbMock.groupPostState.upsert.mockResolvedValue({});
  dbMock.groupPostState.updateMany.mockResolvedValue({ count: 1 });
  dbMock.$executeRaw.mockResolvedValue(1);
  ownerDm.queueOwnerDm.mockResolvedValue({ queued: 1, skipped: 0 });
});

const dms = () => dbMock.platformJob.create.mock.calls.map((c) => c[0].data);

describe("an organiser's add into a group only admins can send in", () => {
  it("is held, not linked: the request and the club are untouched, the owner hears nothing", async () => {
    const out = await add({ postability: ADMIN_ONLY });
    expect(out).toEqual({ kind: "held-not-postable", connectId: "cc-ali", reason: "admin-only", organiserDmQueued: true });
    expect(isSilentOutcome(out)).toBe(true);
    expect(dbMock.clubConnect.updateMany).not.toHaveBeenCalled();
    expect(dbMock.organisation.updateMany).not.toHaveBeenCalled();
    expect(ownerDm.queueOwnerDm).not.toHaveBeenCalled();
    const held = dbMock.groupPostState.upsert.mock.calls[0][0];
    expect(held.where).toEqual({ groupId: GROUP });
    expect(held.create).toMatchObject({ canPost: false, heldConnectId: "cc-ali", announce: true, botIsAdmin: false });
    expect(held.create.heldAdd).toMatchObject({ kind: "first", status: "dm_verified", adderMatch: "phone", reason: "admin-only" });
  });

  it("the organiser gets ONE DM, in the club's language, saying why and both ways out", async () => {
    await add({ postability: ADMIN_ONLY });
    expect(dms()).toHaveLength(1);
    expect(dms()[0]).toMatchObject({ kind: "dm", phone: ALI, purpose: "connect-reply", refId: `cc-ali:not-postable:${GROUP}` });
    expect(dms()[0].text).toMatch(/only admins can send messages/);
    expect(dms()[0].text).toContain('"Riverside Announcements"');

    dbMock.platformJob.findFirst.mockResolvedValue({ id: "pj-1" });
    const again = await add({ postability: ADMIN_ONLY });
    expect(again).toMatchObject({ kind: "held-not-postable", organiserDmQueued: false });
    expect(dms()).toHaveLength(1);
  });

  it("Turkish club: the Turkish DM", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ name: "Cuma FC", language: "tr" });
    await add({ postability: ADMIN_ONLY });
    expect(dms()[0].text).toMatch(/yalnızca yöneticiler/);
  });

  it("a community announcements group: named as such, the players' group recommended", async () => {
    const out = await add({ postability: COMMUNITY });
    expect(out).toMatchObject({ kind: "held-not-postable", reason: "community-announce" });
    expect(dms()[0].text).toMatch(/announcements group/);
    expect(dms()[0].text).toMatch(/recommended/);
  });

  it("MatchTime already an admin there: linked exactly as before", async () => {
    const out = await add({ postability: IS_ADMIN });
    expect(out.kind).toBe("linked");
    expect(dbMock.groupPostState.upsert).not.toHaveBeenCalled();
  });

  it("no reading (an older Pi): linked exactly as before", async () => {
    const out = await add();
    expect(out.kind).toBe("linked");
    expect(dbMock.groupPostState.upsert).not.toHaveBeenCalled();
  });

  it("an add nobody asked for is unsolicited as before, whatever the setting", async () => {
    dbMock.clubConnect.findMany.mockResolvedValue([]);
    const out = await add({ postability: ADMIN_ONLY, addedByPhone: "447700900999", participants: [] });
    expect(out.kind).toBe("unsolicited");
    expect(dbMock.groupPostState.upsert).not.toHaveBeenCalled();
    expect(dms()).toHaveLength(0);
  });
});

describe("resumeHeldGroupAdd: MatchTime was made an admin there", () => {
  function held(over: Record<string, unknown> = {}) {
    return {
      groupId: GROUP,
      canPost: true,
      heldConnectId: "cc-ali",
      heldAt: mins(-30),
      heldAdd: {
        kind: "first",
        status: "dm_verified",
        subject: "Riverside Announcements",
        addedByPhone: ALI,
        addedByLid: null,
        participants: PARTICIPANTS,
        adderMatch: "phone",
        organiserPresent: true,
        reason: "admin-only",
        ...over,
      },
    };
  }

  it("finishes the link as a normal add would: linked, club pending, the owner's one DM, the hold cleared", async () => {
    dbMock.groupPostState.findUnique.mockResolvedValue(held());
    dbMock.clubConnect.findUnique.mockResolvedValue(connectRow());
    const out = await resumeHeldGroupAdd(GROUP, NOW);
    expect(out.kind).toBe("linked");
    const link = dbMock.clubConnect.updateMany.mock.calls[0][0];
    expect(link.where).toEqual({ id: "cc-ali", status: "dm_verified" });
    expect(link.data).toMatchObject({ status: "group_linked", groupId: GROUP, memberCount: 2, adderMatch: "phone" });
    expect(dbMock.organisation.updateMany).toHaveBeenCalled();
    expect(ownerDm.queueOwnerDm).toHaveBeenCalledWith(expect.any(String), "owner-approval", "cc-ali");
    expect(dbMock.$executeRaw).toHaveBeenCalled();
  });

  it("a request that moved on (linked elsewhere, expired): nothing linked, the hold cleared", async () => {
    dbMock.groupPostState.findUnique.mockResolvedValue(held());
    dbMock.clubConnect.findUnique.mockResolvedValue(connectRow());
    dbMock.clubConnect.updateMany.mockResolvedValue({ count: 0 });
    const out = await resumeHeldGroupAdd(GROUP, NOW);
    expect(out.kind).toBe("race-lost");
    expect(ownerDm.queueOwnerDm).not.toHaveBeenCalled();
    expect(dbMock.$executeRaw).toHaveBeenCalled();
  });

  it("the club has a newer request since (the organiser went back for a new code): not linked, hold cleared", async () => {
    dbMock.groupPostState.findUnique.mockResolvedValue(held());
    dbMock.clubConnect.findUnique.mockResolvedValue(connectRow());
    dbMock.clubConnect.count.mockResolvedValue(1);
    const out = await resumeHeldGroupAdd(GROUP, NOW);
    expect(out).toEqual({ kind: "superseded" });
    expect(dbMock.clubConnect.updateMany).not.toHaveBeenCalled();
  });

  it("nothing held in that group: nothing at all", async () => {
    dbMock.groupPostState.findUnique.mockResolvedValue({ groupId: GROUP, canPost: true, heldConnectId: null, heldAdd: null });
    expect(await resumeHeldGroupAdd(GROUP, NOW)).toEqual({ kind: "none" });
    expect(dbMock.clubConnect.updateMany).not.toHaveBeenCalled();
  });

  it("no table yet (migration not applied): nothing, never a throw", async () => {
    dbMock.groupPostState.findUnique.mockRejectedValue(Object.assign(new Error("missing"), { code: "P2021" }));
    expect(await resumeHeldGroupAdd(GROUP, NOW)).toEqual({ kind: "none" });
  });
});
