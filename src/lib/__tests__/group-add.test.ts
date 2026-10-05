/**
 * SELF-JOIN SLICE 6: a group add, a removal, the unsolicited auto-leave
 * and the reconnect sweep's list, against a mocked database.
 * Plan: MDs/self-join-and-approval-plan-2026-09-28.md, sections 4.1, 5.5,
 * 5.6, 5.7, 6.1 and 8.
 *
 * Deterministic: no model anywhere in the module (asserted below by
 * mocking the Anthropic SDK and counting its calls).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const anthropicCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: () => {
        anthropicCalls.n++;
        throw new Error("no model in the group-add path");
      },
    };
  },
}));

const dbMock = vi.hoisted(() => {
  const m = {
    organisation: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    clubConnect: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
    unsolicitedGroup: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    user: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    membership: { findMany: vi.fn() },
    // Slice 2a: the admin-group candidate check resolves a LID-only adder.
    onboardingSession: { findMany: vi.fn() },
    platformJob: { findFirst: vi.fn(), create: vi.fn() },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  return m;
});
vi.mock("@/lib/db", () => ({ db: dbMock }));

import {
  handleBotRemoved,
  handleSelfJoinGroupAdd,
  loadSelfJoinSweep,
  markOwnerDmQueued,
  queueUnsolicitedAutoLeaves,
} from "../group-add";

const NOW = new Date("2026-09-29T12:00:00Z");
const mins = (m: number) => new Date(NOW.getTime() + m * 60_000);
const GROUP = "120363400000000001@g.us";
const SUTTON_GROUP = "120363000000000001@g.us";
const ALI = "447700900123";
const ALI_LID = "158055467598961";
const STRANGER = "447700900999";

const ENV = process.env.SELF_JOIN_APPROVER_PHONES;

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
    dmLid: ALI_LID,
    issuedAt: mins(-20),
    expiresAt: mins(40),
    addWindowEndsAt: mins(24 * 60 - 10),
    ...over,
  };
}

const add = (over: Record<string, unknown> = {}) =>
  handleSelfJoinGroupAdd({
    groupId: GROUP,
    groupSubject: "Riverside Tuesday 5s",
    addedByPhone: ALI,
    participants: [
      { phone: ALI, pushname: "Ali" },
      { phone: "447700900201", pushname: "Ben" },
    ],
    enrichmentHistory: [],
    now: NOW,
    ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
  anthropicCalls.n = 0;
  dbMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(dbMock));
  dbMock.organisation.findFirst.mockResolvedValue(null);
  dbMock.organisation.findUnique.mockResolvedValue({ name: "Riverside FC", language: "en" });
  dbMock.organisation.updateMany.mockResolvedValue({ count: 1 });
  dbMock.clubConnect.findFirst.mockResolvedValue(null);
  dbMock.clubConnect.findMany.mockResolvedValue([connectRow()]);
  dbMock.clubConnect.updateMany.mockResolvedValue({ count: 1 });
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
});
afterAll(() => {
  if (ENV === undefined) delete process.env.SELF_JOIN_APPROVER_PHONES;
  else process.env.SELF_JOIN_APPROVER_PHONES = ENV;
});

describe("a group an approved club already owns (Sutton FC)", () => {
  it("is ignored exactly as today: no link, no pending, no unsolicited row, no DM", async () => {
    dbMock.organisation.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      args.where.whatsappGroupId === SUTTON_GROUP && args.where.approvalStatus === "approved" ? { id: "sutton" } : null,
    );
    const out = await add({ groupId: SUTTON_GROUP });
    expect(out).toEqual({ kind: "live-org", orgId: "sutton" });
    expect(dbMock.clubConnect.updateMany).not.toHaveBeenCalled();
    expect(dbMock.organisation.updateMany).not.toHaveBeenCalled();
    expect(dbMock.unsolicitedGroup.create).not.toHaveBeenCalled();
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("even while an organiser with an open request is in that group", async () => {
    dbMock.organisation.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      args.where.approvalStatus === "approved" ? { id: "sutton" } : null,
    );
    const out = await add({ groupId: SUTTON_GROUP, addedByPhone: STRANGER });
    expect(out.kind).toBe("live-org");
    expect(dbMock.clubConnect.findMany).not.toHaveBeenCalled();
  });

  it("a MUTED approved club is still its owner: ignored, never unsolicited", async () => {
    // APPROVED_CLUB_WHERE carries no whatsappBotEnabled: the mute switch is not a lifecycle state.
    dbMock.organisation.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      "whatsappBotEnabled" in args.where ? null : args.where.approvalStatus === "approved" ? { id: "sutton" } : null,
    );
    expect((await add({ groupId: SUTTON_GROUP, discovered: true })).kind).toBe("live-org");
  });
});

describe("a group another (unapproved) club owns", () => {
  it("is silent and untouched", async () => {
    dbMock.organisation.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      args.where.approvalStatus ? null : { id: "org-suspended" },
    );
    expect(await add()).toEqual({ kind: "club-group", orgId: "org-suspended" });
    expect(dbMock.clubConnect.updateMany).not.toHaveBeenCalled();
  });
});

describe("a matched add (the organiser added MatchTime)", () => {
  it("links the request, sets the club pending, stays silent, acks the organiser and hands back the owner DM", async () => {
    const out = await add();
    expect(out).toMatchObject({
      kind: "linked",
      connectId: "cc-ali",
      orgId: "org-riverside",
      adderMatch: "phone",
      organiserAckQueued: true,
    });

    // The request: compare-and-set on the status it had.
    const upd = dbMock.clubConnect.updateMany.mock.calls[0][0];
    expect(upd.where).toEqual({ id: "cc-ali", status: "dm_verified" });
    expect(upd.data).toMatchObject({
      status: "group_linked",
      groupId: GROUP,
      groupSubject: "Riverside Tuesday 5s",
      memberCount: 2,
      addedByPhone: ALI,
      addedByLid: null,
      adderMatch: "phone",
      detectedLang: "en",
      linkedAt: NOW,
    });
    expect(upd.data.participants).toEqual([
      { phone: ALI, lidId: null, pushname: "Ali" },
      { phone: "447700900201", lidId: null, pushname: "Ben" },
    ]);

    // The club: draft -> pending, and nothing else (no bot switch, no group id).
    expect(dbMock.organisation.updateMany).toHaveBeenCalledWith({
      where: { id: "org-riverside", approvalStatus: "draft" },
      data: { approvalStatus: "pending" },
    });

    // The organiser's ack, once, on the platform channel.
    const ack = dbMock.platformJob.create.mock.calls[0][0].data;
    expect(ack).toMatchObject({ kind: "dm", phone: ALI, purpose: "connect-reply", refId: "cc-ali:in-group" });
    expect(ack.text).toBe(
      "Thanks, I'm in \"Riverside Tuesday 5s\". I'll stay quiet there until your club is approved, usually within a day. I'll message you here when it's live.",
    );

    // The owner DM is handed back for the route to queue.
    if (out.kind !== "linked") throw new Error("unreachable");
    expect(out.ownerDm.refId).toBe("cc-ali");
    expect(out.ownerDm.text).toBe(
      [
        "New club waiting: *Riverside FC* (ref 7KQ2)",
        "Organiser: Ali Demir, +44 7700 900123 (phone verified at sign-up)",
        "Added by: the organiser (matched by phone)",
        'Group: "Riverside Tuesday 5s", 2 members, looks English (club chose English)',
        "Reply APPROVE 7KQ2 or REJECT 7KQ2, or use matchtime.ai/admin/clubs",
      ].join("\n"),
    );
    expect(anthropicCalls.n).toBe(0);
  });

  it("a Turkish club: the ack is Turkish; the owner DM says what the group looks like", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ name: "Kartallar", language: "tr" });
    const out = await add({
      groupSubject: "Cuma Halı Saha",
      enrichmentHistory: [{ author: "Erdal", text: "ben varım bu hafta", timestamp: "2026-09-29T10:00:00Z" }],
    });
    const ack = dbMock.platformJob.create.mock.calls[0][0].data;
    expect(ack.text).toBe(
      'Teşekkürler, "Cuma Halı Saha" grubuna katıldım. Kulübünüz onaylanana kadar orada sessiz kalacağım, genellikle bir gün içinde. Yayına geçince size buradan yazacağım.',
    );
    if (out.kind !== "linked") throw new Error("unreachable");
    expect(out.ownerDm.text).toContain("looks Turkish (club chose Türkçe)");
  });

  it("matched by the connect DM's LID: labelled, acked", async () => {
    const out = await add({ addedByPhone: null, addedByLid: `${ALI_LID}@lid` });
    expect(out).toMatchObject({ kind: "linked", adderMatch: "lid", organiserAckQueued: true });
    if (out.kind !== "linked") throw new Error("unreachable");
    expect(out.ownerDm.text).toContain("Added by: the organiser (matched by WhatsApp id)");
  });

  it("the organiser's number was never confirmed at the DM: the owner is told", async () => {
    dbMock.clubConnect.findMany.mockResolvedValue([connectRow({ dmPhone: null })]);
    const out = await add({ addedByPhone: null, addedByLid: ALI_LID });
    if (out.kind !== "linked") throw new Error("unreachable");
    expect(out.ownerDm.text).toContain("(organiser's WhatsApp number not confirmed)");
  });

  it("members who already play in an approved club are counted for the owner", async () => {
    dbMock.membership.findMany.mockResolvedValue([
      { userId: "u1", org: { name: "Sutton FC" } },
      { userId: "u2", org: { name: "Sutton FC" } },
      { userId: "u2", org: { name: "Sutton FC" } },
    ]);
    const out = await add();
    if (out.kind !== "linked") throw new Error("unreachable");
    expect(out.ownerDm.text).toContain("Also in your other clubs: 2 members play at Sutton FC");
    expect(dbMock.membership.findMany.mock.calls[0][0].where).toMatchObject({
      org: { approvalStatus: "approved" },
      user: { phoneNumber: { in: [`+${ALI}`, "+447700900201"] } },
    });
  });
});

describe("an add by someone else", () => {
  it("organiser IS in the group: linked and labelled, but NO ack to the organiser", async () => {
    const out = await add({ addedByPhone: STRANGER });
    expect(out).toMatchObject({ kind: "linked", adderMatch: "other-organiser-present", organiserAckQueued: false });
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
    if (out.kind !== "linked") throw new Error("unreachable");
    expect(out.ownerDm.text).toContain("Added by: someone else; the organiser IS in the group");
  });

  it("organiser NOT in the group: recorded as unsolicited, nobody DMed, nothing linked", async () => {
    const out = await add({ addedByPhone: STRANGER, participants: [{ phone: STRANGER }] });
    expect(out).toEqual({ kind: "unsolicited", recorded: true, id: "ug-1" });
    expect(dbMock.unsolicitedGroup.create).toHaveBeenCalledWith({
      data: {
        groupId: GROUP,
        subject: "Riverside Tuesday 5s",
        memberCount: 1,
        addedByPhone: STRANGER,
        addedByLid: null,
        addedAt: NOW,
      },
    });
    expect(dbMock.clubConnect.updateMany).not.toHaveBeenCalled();
    expect(dbMock.organisation.updateMany).not.toHaveBeenCalled();
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });
});

describe("F3: the chat is kept for the learned setup", () => {
  const CHAT = [
    { author: "Ali", text: "same lot as last week", timestamp: "2026-09-28T10:00:00Z" },
    { author: "Ben", text: "can't make it", timestamp: "2026-09-28T10:05:00Z" },
  ];
  it("the link stores the chat WhatsApp shared on the connect request", async () => {
    await add({ enrichmentHistory: CHAT });
    const upd = dbMock.clubConnect.updateMany.mock.calls[0][0];
    expect(upd.data.capturedHistory).toEqual([
      { author: "Ali", authorPhone: null, text: "same lot as last week", timestamp: "2026-09-28T10:00:00Z" },
      { author: "Ben", authorPhone: null, text: "can't make it", timestamp: "2026-09-28T10:05:00Z" },
    ]);
  });
  it("no chat: nothing stored", async () => {
    await add({ enrichmentHistory: [] });
    expect(dbMock.clubConnect.updateMany.mock.calls[0][0].data.capturedHistory).toBeUndefined();
  });
  it("a re-add carrying chat fills it in only when none is stored yet", async () => {
    dbMock.clubConnect.findFirst.mockResolvedValue({ id: "cc-ali" });
    await add({ enrichmentHistory: CHAT });
    const sql = (dbMock.$executeRaw.mock.calls[0][0] as TemplateStringsArray).join("?");
    expect(sql).toContain(`SET "capturedHistory" =`);
    expect(sql).toContain(`AND "capturedHistory" IS NULL`);
  });
  it("removed from the group while pending: the chat is deleted with the link", async () => {
    dbMock.clubConnect.findMany.mockResolvedValue([{ id: "cc-ali", orgId: "org-riverside" }]);
    await handleBotRemoved(GROUP, NOW);
    const sqls = dbMock.$executeRaw.mock.calls.map((c) => (c[0] as TemplateStringsArray).join("?"));
    expect(sqls).toContain(`UPDATE "ClubConnect" SET "capturedHistory" = NULL WHERE "id" = ?`);
  });
});

describe("idempotency and races", () => {
  it("a re-add of a group already linked and waiting: nothing new (no second owner DM)", async () => {
    dbMock.clubConnect.findFirst.mockResolvedValue({ id: "cc-ali" });
    expect(await add()).toEqual({ kind: "already-linked", connectId: "cc-ali" });
    expect(dbMock.clubConnect.updateMany).not.toHaveBeenCalled();
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
    expect(dbMock.clubConnect.findFirst.mock.calls[0][0].where).toMatchObject({
      groupId: GROUP,
      status: "group_linked",
      botRemovedAt: null,
      org: { approvalStatus: "pending" },
    });
  });

  it("the request moved under us: race lost, nothing else written", async () => {
    dbMock.clubConnect.updateMany.mockResolvedValue({ count: 0 });
    expect(await add()).toEqual({ kind: "race-lost" });
    expect(dbMock.organisation.updateMany).not.toHaveBeenCalled();
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("the club was no longer draft: the link is rolled back (race lost)", async () => {
    dbMock.organisation.updateMany.mockResolvedValue({ count: 0 });
    expect(await add()).toEqual({ kind: "race-lost" });
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("an unsolicited group already recorded and not left: not recorded twice", async () => {
    dbMock.clubConnect.findMany.mockResolvedValue([]);
    dbMock.unsolicitedGroup.findFirst.mockResolvedValue({ id: "ug-0" });
    expect(await add()).toEqual({ kind: "unsolicited", recorded: false, id: "ug-0" });
    expect(dbMock.unsolicitedGroup.create).not.toHaveBeenCalled();
  });

  it("only draft clubs' open requests are candidates", async () => {
    await add();
    expect(dbMock.clubConnect.findMany.mock.calls[0][0].where).toEqual({
      status: { in: ["issued", "dm_verified"] },
      org: { approvalStatus: "draft" },
    });
  });
});

describe("discovered by the reconnect sweep", () => {
  it("links when exactly one verified organiser is in the group", async () => {
    const out = await add({ addedByPhone: null, discovered: true });
    expect(out).toMatchObject({ kind: "linked", adderMatch: "unknown", organiserAckQueued: false });
  });

  it("no match: NOT recorded as unsolicited (it may be a group from before self-join), no writes", async () => {
    const out = await add({ addedByPhone: null, discovered: true, participants: [{ phone: STRANGER }] });
    expect(out).toEqual({ kind: "discovered-no-match" });
    expect(dbMock.unsolicitedGroup.create).not.toHaveBeenCalled();
  });
});

describe("markOwnerDmQueued", () => {
  it("stamps the request once", async () => {
    await markOwnerDmQueued("cc-ali", NOW);
    expect(dbMock.clubConnect.updateMany).toHaveBeenCalledWith({
      where: { id: "cc-ali", ownerDmQueuedAt: null },
      data: { ownerDmQueuedAt: NOW },
    });
  });
});

describe("handleBotRemoved (plan 5.7)", () => {
  it("a pending club goes back to draft; the request is marked removed; no DMs", async () => {
    dbMock.clubConnect.findMany.mockResolvedValue([{ id: "cc-ali", orgId: "org-riverside" }]);
    const out = await handleBotRemoved(GROUP, NOW);
    expect(out).toEqual({ returnedToDraft: 1, unsolicitedLeft: 0 });
    expect(dbMock.clubConnect.findMany.mock.calls[0][0].where).toEqual({
      groupId: GROUP,
      status: "group_linked",
      botRemovedAt: null,
      org: { approvalStatus: "pending" },
    });
    expect(dbMock.clubConnect.updateMany).toHaveBeenCalledWith({
      where: { id: "cc-ali", botRemovedAt: null },
      data: { botRemovedAt: NOW },
    });
    expect(dbMock.organisation.updateMany).toHaveBeenCalledWith({
      where: { id: "org-riverside", approvalStatus: "pending" },
      data: { approvalStatus: "draft" },
    });
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("an unsolicited group is marked left", async () => {
    dbMock.clubConnect.findMany.mockResolvedValue([]);
    dbMock.unsolicitedGroup.updateMany.mockResolvedValue({ count: 1 });
    expect(await handleBotRemoved(GROUP, NOW)).toEqual({ returnedToDraft: 0, unsolicitedLeft: 1 });
    expect(dbMock.unsolicitedGroup.updateMany).toHaveBeenCalledWith({
      where: { groupId: GROUP, leftAt: null },
      data: { leftAt: NOW },
    });
  });

  it("Sutton FC's group: nothing about an approved club can change", async () => {
    dbMock.clubConnect.findMany.mockResolvedValue([]);
    await handleBotRemoved(SUTTON_GROUP, NOW);
    expect(dbMock.organisation.updateMany).not.toHaveBeenCalled();
  });
});

describe("queueUnsolicitedAutoLeaves (decision 3)", () => {
  it("queues a leave for groups added 48 hours ago or more, once", async () => {
    dbMock.unsolicitedGroup.findMany.mockResolvedValue([{ id: "ug-1", groupId: GROUP, addedAt: mins(-49 * 60) }]);
    dbMock.organisation.findFirst.mockResolvedValue(null);
    const out = await queueUnsolicitedAutoLeaves(NOW);
    expect(out).toEqual({ queued: 1, markedLeft: 0 });
    expect(dbMock.unsolicitedGroup.findMany.mock.calls[0][0].where).toEqual({
      leftAt: null,
      addedAt: { lte: mins(-48 * 60) },
    });
    expect(dbMock.platformJob.create).toHaveBeenCalledWith({
      data: { kind: "leave-group", groupId: GROUP, purpose: "leave-group", refId: "ug-1", status: "queued" },
    });
  });

  it("a leave already sent marks the group left; one queued, claimed or failed is not repeated", async () => {
    dbMock.unsolicitedGroup.findMany.mockResolvedValue([
      { id: "ug-1", groupId: GROUP, addedAt: mins(-50 * 60) },
      { id: "ug-2", groupId: "120363400000000002@g.us", addedAt: mins(-50 * 60) },
    ]);
    dbMock.platformJob.findFirst
      .mockResolvedValueOnce({ status: "sent", sentAt: mins(-5) })
      .mockResolvedValueOnce({ status: "failed", sentAt: null });
    const out = await queueUnsolicitedAutoLeaves(NOW);
    expect(out).toEqual({ queued: 0, markedLeft: 1 });
    expect(dbMock.unsolicitedGroup.updateMany).toHaveBeenCalledWith({
      where: { id: "ug-1", leftAt: null },
      data: { leftAt: mins(-5) },
    });
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("never leaves a group an approved club owns (Sutton FC), whatever row names it", async () => {
    dbMock.unsolicitedGroup.findMany.mockResolvedValue([{ id: "ug-x", groupId: SUTTON_GROUP, addedAt: mins(-72 * 60) }]);
    dbMock.organisation.findFirst.mockResolvedValue({ id: "sutton" });
    expect(await queueUnsolicitedAutoLeaves(NOW)).toEqual({ queued: 0, markedLeft: 0 });
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });
});

describe("loadSelfJoinSweep: does the Pi need to look for adds it missed?", () => {
  it("no open DM-verified request: no sweep", async () => {
    dbMock.clubConnect.count.mockResolvedValue(0);
    expect(await loadSelfJoinSweep(NOW)).toBeNull();
    expect(dbMock.organisation.findMany).not.toHaveBeenCalled();
  });

  it("with one: every group the server already knows, so the Pi reads none of them", async () => {
    dbMock.clubConnect.count.mockResolvedValue(1);
    dbMock.organisation.findMany.mockResolvedValue([{ whatsappGroupId: SUTTON_GROUP }, { whatsappGroupId: null }]);
    dbMock.clubConnect.findMany.mockResolvedValue([{ groupId: GROUP }]);
    dbMock.unsolicitedGroup.findMany.mockResolvedValue([{ groupId: "120363400000000009@g.us" }]);
    const out = await loadSelfJoinSweep(NOW);
    expect(out?.knownGroups.sort()).toEqual([SUTTON_GROUP, GROUP, "120363400000000009@g.us"].sort());
    expect(dbMock.clubConnect.count.mock.calls[0][0].where).toEqual({
      status: "dm_verified",
      addWindowEndsAt: { gt: NOW },
      org: { approvalStatus: "draft" },
    });
    // Every club's group, whatever its status: approved (muted too), dormant or not.
    // Slice 2a: and every club's linked admin group.
    expect(dbMock.organisation.findMany.mock.calls[0][0].where).toEqual({
      OR: [{ whatsappGroupId: { not: null } }, { adminGroupId: { not: null } }],
    });
  });

  it("a linked admin group is known, so the sweep never reads it", async () => {
    dbMock.clubConnect.count.mockResolvedValue(1);
    dbMock.organisation.findMany.mockResolvedValue([{ whatsappGroupId: SUTTON_GROUP, adminGroupId: "120363400000000077@g.us" }]);
    dbMock.clubConnect.findMany.mockResolvedValue([]);
    dbMock.unsolicitedGroup.findMany.mockResolvedValue([]);
    const out = await loadSelfJoinSweep(NOW);
    expect(out?.knownGroups.sort()).toEqual([SUTTON_GROUP, "120363400000000077@g.us"].sort());
  });
});

describe("slice 2a: the admins' HQ group (plan 2.4)", () => {
  const RAIHAN = "447700900555";

  it("an add by an owner or admin of an approved club, with no connect request matching: a silent candidate, no approval DM, no ack", async () => {
    dbMock.user.findMany.mockImplementation(async (a: { where: { phoneNumber: { in: string[] } } }) =>
      a.where.phoneNumber.in.includes(`+${RAIHAN}`) ? [{ id: "u-raihan" }] : [],
    );
    dbMock.membership.findMany.mockImplementation(async (a: { where: { userId?: { in: string[] } } }) =>
      a.where.userId?.in.includes("u-raihan") ? [{ userId: "u-raihan", orgId: "org-fnf", org: { id: "org-fnf", name: "FNF", language: "en" } }] : [],
    );
    const out = await add({ addedByPhone: RAIHAN, participants: [{ phone: RAIHAN }] });
    expect(out).toEqual({ kind: "admin-group-candidate", id: "ug-1" });
    expect(dbMock.unsolicitedGroup.create.mock.calls[0][0].data).toMatchObject({ groupId: GROUP, awaitingAdminLink: true });
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
    expect(dbMock.clubConnect.updateMany).not.toHaveBeenCalled();
    const { isSilentOutcome } = await import("../group-add");
    expect(isSilentOutcome(out)).toBe(true);
  });

  it("a matching connect request wins over the candidate rule", async () => {
    // Ali is the organiser with a DM-verified request AND (here) an admin
    // of an approved club: he said what he wants, so the request is linked.
    dbMock.user.findMany.mockResolvedValue([{ id: "u-ali" }]);
    dbMock.membership.findMany.mockResolvedValue([{ userId: "u-ali", orgId: "org-x", org: { id: "org-x", name: "X", language: "en" } }]);
    const out = await add();
    expect(out.kind).toBe("linked");
  });

  it("a group that is already a club's admin group is not a new club, and not silent", async () => {
    dbMock.organisation.findFirst.mockImplementation(async (a: { where: Record<string, unknown> }) =>
      a.where.adminGroupId === GROUP ? { id: "org-fnf" } : null,
    );
    const out = await add();
    expect(out).toEqual({ kind: "admin-group", orgId: "org-fnf" });
    const { isSilentOutcome } = await import("../group-add");
    expect(isSilentOutcome(out)).toBe(false);
  });
});
