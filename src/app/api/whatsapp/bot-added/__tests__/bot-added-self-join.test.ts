/**
 * POST /api/whatsapp/bot-added, the self-join branch (slice 6, plan 5.5).
 *
 * With SELF_JOIN_ENABLED on, an add goes to the self-join linker BEFORE
 * the ONBOARDING_AUTOSTART gate (which decision 4 switches off), never
 * returns an intro, and queues the one approval DM to the owner through
 * queueOwnerDm. With the flag off, the route is exactly today's.
 *
 * The linker and the owner DM are mocked; their own tests pin them.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "test-wa-key";

const groupAdd = vi.hoisted(() => ({
  handleSelfJoinGroupAdd: vi.fn(),
  markOwnerDmQueued: vi.fn(),
  attachLateGroupHistory: vi.fn(async () => "stored"),
}));
vi.mock("@/lib/group-add", async (orig) => ({
  ...(await orig<typeof import("@/lib/group-add")>()),
  handleSelfJoinGroupAdd: (...a: unknown[]) => groupAdd.handleSelfJoinGroupAdd(...a),
  markOwnerDmQueued: (...a: unknown[]) => groupAdd.markOwnerDmQueued(...a),
  attachLateGroupHistory: (...a: unknown[]) => groupAdd.attachLateGroupHistory(...(a as [])),
}));
const ownerDm = vi.hoisted(() => ({ queueOwnerDm: vi.fn() }));
vi.mock("@/lib/owner-dm", () => ({ queueOwnerDm: (...a: unknown[]) => ownerDm.queueOwnerDm(...a) }));

const dbMock = vi.hoisted(() => ({
  organisation: { findFirst: vi.fn(), findMany: vi.fn() },
  clubConnect: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  platformJob: { findFirst: vi.fn() },
  unsolicitedGroup: { findMany: vi.fn() },
  onboardingSession: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
// Slice 2a: the admins' HQ group check has its own tests
// (lib/__tests__/admin-group-link.test.ts). Not a candidate unless a test says so.
const adminGroupLink = vi.hoisted(() => ({ detect: vi.fn(async () => false), record: vi.fn(async () => ({ id: "ug-1" })) }));
vi.mock("@/lib/admin-group-link", () => ({
  detectAdminGroupCandidate: (...a: unknown[]) => adminGroupLink.detect(...(a as [])),
  recordAdminGroupCandidate: (...a: unknown[]) => adminGroupLink.record(...(a as [])),
}));

import { POST } from "../route";

/** The requests stamped `ownerDmQueuedAt` (markOwnerDmQueued). */
const stamped = () =>
  dbMock.clubConnect.updateMany.mock.calls
    .filter((c) => (c[0] as { data?: { ownerDmQueuedAt?: unknown } }).data?.ownerDmQueuedAt)
    .map((c) => (c[0] as { where: { id: string } }).where.id);

const ENV = {
  key: process.env.WHATSAPP_API_KEY,
  autostart: process.env.ONBOARDING_AUTOSTART,
  selfJoin: process.env.SELF_JOIN_ENABLED,
};

const GROUP = "120363400000000001@g.us";

async function post(body: Record<string, unknown> = {}) {
  const res = await POST(
    new Request("http://x/api/whatsapp/bot-added", {
      method: "POST",
      headers: { "x-api-key": KEY, "content-type": "application/json" },
      body: JSON.stringify({
        groupId: GROUP,
        groupSubject: "Riverside Tuesday 5s",
        addedByPhone: "447700900123",
        addedByLid: "158055467598961",
        participants: [{ phone: "447700900123" }],
        ...body,
      }),
    }),
  );
  expect(res.status).toBe(200);
  return res.json();
}

const LINKED = {
  kind: "linked",
  connectId: "cc-ali",
  orgId: "org-riverside",
  adderMatch: "phone",
  ownerDm: { text: "New club waiting: *Riverside FC* (ref 7KQ2)", refId: "cc-ali" },
  organiserAckQueued: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WHATSAPP_API_KEY = KEY;
  process.env.SELF_JOIN_ENABLED = "1";
  delete process.env.ONBOARDING_AUTOSTART; // decision 4: off in prod once self-join is on
  groupAdd.handleSelfJoinGroupAdd.mockResolvedValue(LINKED);
  groupAdd.markOwnerDmQueued.mockResolvedValue(undefined);
  ownerDm.queueOwnerDm.mockResolvedValue({ queued: 1, skipped: 0 });
  dbMock.organisation.findFirst.mockResolvedValue(null);
  dbMock.organisation.findMany.mockResolvedValue([]);
  dbMock.clubConnect.findMany.mockResolvedValue([]);
  // The request still names the group when the owner's DM is queued.
  dbMock.clubConnect.findFirst.mockResolvedValue({ id: "cc-ali" });
  dbMock.clubConnect.updateMany.mockResolvedValue({ count: 1 });
  dbMock.platformJob.findFirst.mockResolvedValue(null);
  dbMock.unsolicitedGroup.findMany.mockResolvedValue([]);
  dbMock.onboardingSession.findFirst.mockResolvedValue(null);
  dbMock.onboardingSession.create.mockResolvedValue({ id: "sess-1" });
});
afterAll(() => {
  for (const [k, v] of [
    ["WHATSAPP_API_KEY", ENV.key],
    ["ONBOARDING_AUTOSTART", ENV.autostart],
    ["SELF_JOIN_ENABLED", ENV.selfJoin],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("self-join ON", () => {
  it("links, stays silent, and queues the owner's approval DM once, even with autostart off", async () => {
    const body = await post();
    expect(body).toMatchObject({ ok: true, introText: null, silent: true, ignored: "self-join-pending", selfJoin: "linked" });
    expect(groupAdd.handleSelfJoinGroupAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: GROUP,
        groupSubject: "Riverside Tuesday 5s",
        addedByPhone: "447700900123",
        addedByLid: "158055467598961",
        participants: [{ phone: "447700900123" }],
      }),
    );
    expect(ownerDm.queueOwnerDm).toHaveBeenCalledTimes(1);
    expect(ownerDm.queueOwnerDm).toHaveBeenCalledWith(LINKED.ownerDm.text, "owner-approval", "cc-ali");
    expect(stamped()).toEqual(["cc-ali"]);
    expect(dbMock.onboardingSession.create).not.toHaveBeenCalled();
  });

  // 2026-10-15 (the FNF incident): the organiser's own add moved the
  // request to their group a moment ago. This (weaker) link's DM is not
  // sent; the move sends the right one.
  it("a link whose request was moved to the organiser's group meanwhile: its DM is not sent", async () => {
    dbMock.clubConnect.findFirst.mockResolvedValue(null);
    const body = await post();
    expect(body).toMatchObject({ selfJoin: "linked", silent: true });
    expect(ownerDm.queueOwnerDm).not.toHaveBeenCalled();
    expect(stamped()).toEqual([]);
  });

  it("a request MOVED here, the owner already asked about the other group: the correction, once", async () => {
    groupAdd.handleSelfJoinGroupAdd.mockResolvedValue({
      ...LINKED,
      upgradedFrom: { groupId: "120363400000000009@g.us", subject: "FNF", memberCount: 8 },
      correctionDm: { text: "Correction: *Riverside FC* (ref 7KQ2) is now linked to ...", refId: `cc-ali:relinked:${GROUP}` },
    });
    dbMock.platformJob.findFirst.mockResolvedValue({ id: "pj-earlier" });
    await post();
    expect(ownerDm.queueOwnerDm.mock.calls).toEqual([
      ["Correction: *Riverside FC* (ref 7KQ2) is now linked to ...", "owner-approval", `cc-ali:relinked:${GROUP}`],
    ]);
    expect(stamped()).toEqual(["cc-ali"]);
  });

  it("a request MOVED here before the owner heard of it: the ordinary approval DM, no correction", async () => {
    groupAdd.handleSelfJoinGroupAdd.mockResolvedValue({
      ...LINKED,
      upgradedFrom: { groupId: "120363400000000009@g.us", subject: "FNF", memberCount: 8 },
      correctionDm: { text: "Correction", refId: `cc-ali:relinked:${GROUP}` },
    });
    await post();
    expect(ownerDm.queueOwnerDm.mock.calls).toEqual([[LINKED.ownerDm.text, "owner-approval", "cc-ali"]]);
  });

  it("the weak link's DM slipped in between: the move's approval DM is a duplicate, so the correction goes", async () => {
    groupAdd.handleSelfJoinGroupAdd.mockResolvedValue({
      ...LINKED,
      upgradedFrom: { groupId: "120363400000000009@g.us", subject: "FNF", memberCount: 8 },
      correctionDm: { text: "Correction", refId: `cc-ali:relinked:${GROUP}` },
    });
    ownerDm.queueOwnerDm.mockResolvedValueOnce({ queued: 0, skipped: 1 });
    await post();
    expect(ownerDm.queueOwnerDm.mock.calls.map((c) => c[2])).toEqual(["cc-ali", `cc-ali:relinked:${GROUP}`]);
  });

  it("a community's parent or announcements group: silent, nobody DMed, the community facts handed on", async () => {
    groupAdd.handleSelfJoinGroupAdd.mockResolvedValue({ kind: "community-group", role: "parent" });
    const community = { isCommunity: true, isCommunityAnnounce: false, linkedParent: null };
    const body = await post({ community });
    expect(body).toMatchObject({ introText: null, silent: true, ignored: "community-group", selfJoin: "community-group" });
    expect(groupAdd.handleSelfJoinGroupAdd).toHaveBeenCalledWith(expect.objectContaining({ community }));
    expect(ownerDm.queueOwnerDm).not.toHaveBeenCalled();
  });

  it("a LATE history bundle is not an add: it never reaches the linker, and changes no silence", async () => {
    const body = await post({
      lateHistory: true,
      enrichmentHistory: [{ author: "Ben", text: "hi", timestamp: "2026-10-15T18:00:00Z" }],
    });
    expect(body).toMatchObject({ ok: true, ignored: "late-history", lateHistory: "stored", introText: null });
    expect(groupAdd.attachLateGroupHistory).toHaveBeenCalledWith(GROUP, [
      { author: "Ben", text: "hi", timestamp: "2026-10-15T18:00:00Z" },
    ]);
    expect(groupAdd.handleSelfJoinGroupAdd).not.toHaveBeenCalled();
    expect(ownerDm.queueOwnerDm).not.toHaveBeenCalled();
    expect(body.silent).toBeUndefined();
  });

  it("no approver phone set: nothing queued, the request is not stamped (the owner page is the fallback)", async () => {
    ownerDm.queueOwnerDm.mockResolvedValue({ queued: 0, skipped: 0, reason: "no-approver-phones" });
    const body = await post();
    expect(body.selfJoin).toBe("linked");
    expect(stamped()).toEqual([]);
  });

  it("a re-add of a linked group: silent, and no second owner DM", async () => {
    groupAdd.handleSelfJoinGroupAdd.mockResolvedValue({ kind: "already-linked", connectId: "cc-ali" });
    const body = await post();
    expect(body).toMatchObject({ introText: null, silent: true, ignored: "self-join-pending" });
    expect(ownerDm.queueOwnerDm).not.toHaveBeenCalled();
  });

  it("unsolicited: silent, nobody DMed", async () => {
    groupAdd.handleSelfJoinGroupAdd.mockResolvedValue({ kind: "unsolicited", recorded: true, id: "ug-1" });
    const body = await post();
    expect(body).toMatchObject({ introText: null, silent: true, ignored: "unsolicited" });
    expect(ownerDm.queueOwnerDm).not.toHaveBeenCalled();
  });

  it("Sutton FC's group: 'live-org', NOT silent, no DM, no intro", async () => {
    groupAdd.handleSelfJoinGroupAdd.mockResolvedValue({ kind: "live-org", orgId: "sutton" });
    const body = await post();
    expect(body).toMatchObject({ introText: null, silent: false, ignored: "live-org" });
    expect(ownerDm.queueOwnerDm).not.toHaveBeenCalled();
  });

  it("a discovered group that matches nothing: not silent (the Pi just moves on)", async () => {
    groupAdd.handleSelfJoinGroupAdd.mockResolvedValue({ kind: "discovered-no-match" });
    const body = await post({ discovered: true });
    expect(body).toMatchObject({ introText: null, silent: false, ignored: "discovered-no-match" });
    expect(groupAdd.handleSelfJoinGroupAdd).toHaveBeenCalledWith(expect.objectContaining({ discovered: true }));
  });

  it("groupId is still required", async () => {
    const res = await POST(
      new Request("http://x/api/whatsapp/bot-added", {
        method: "POST",
        headers: { "x-api-key": KEY, "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("self-join OFF: exactly today's route", () => {
  beforeEach(() => {
    delete process.env.SELF_JOIN_ENABLED;
  });

  it("the self-join linker is never reached, with autostart off", async () => {
    const body = await post();
    expect(body).toEqual({ ok: true, ignored: "autostart-disabled", introText: null });
    expect(groupAdd.handleSelfJoinGroupAdd).not.toHaveBeenCalled();
    expect(ownerDm.queueOwnerDm).not.toHaveBeenCalled();
  });

  it("with autostart on, an unknown group gets no intro and no session (the legacy setup was deleted 2026-10-30)", async () => {
    process.env.ONBOARDING_AUTOSTART = "1";
    const body = await post();
    expect(body.introText).toBeNull();
    expect(dbMock.onboardingSession.create).not.toHaveBeenCalled();
    expect(groupAdd.handleSelfJoinGroupAdd).not.toHaveBeenCalled();
  });

  it("a DISCOVERED group (only a Pi told to sweep sends one) never starts a session", async () => {
    process.env.ONBOARDING_AUTOSTART = "1";
    const body = await post({ discovered: true });
    expect(body).toMatchObject({ ignored: "discovered", introText: null });
    expect(dbMock.onboardingSession.create).not.toHaveBeenCalled();
  });
});
