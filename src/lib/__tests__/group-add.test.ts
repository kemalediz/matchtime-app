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
  isSilentOutcome,
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
  // Every read gets the open request, except the relink rule's (removed
  // links of this group, 2026-10-11): there are none unless a test says so.
  dbMock.clubConnect.findMany.mockImplementation(async (a: { where?: Record<string, unknown> }) =>
    a?.where?.status === "group_linked" && a.where.botRemovedAt != null ? [] : [connectRow()],
  );
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
    // Never onto a request a removal, a rejection or an approval cleared
    // after it was read: the statement checks it is still linked.
    expect(sql.replace(/\s+/g, " ")).toContain(`AND "status" = 'group_linked' AND "botRemovedAt" IS NULL`);
  });
  it("removed from the group while pending: the chat is deleted with the link", async () => {
    dbMock.clubConnect.findMany.mockResolvedValue([{ id: "cc-ali", orgId: "org-riverside" }]);
    await handleBotRemoved(GROUP, NOW);
    const sqls = dbMock.$executeRaw.mock.calls.map((c) => (c[0] as TemplateStringsArray).join("?"));
    expect(sqls).toContain(`UPDATE "ClubConnect" SET "capturedHistory" = NULL, "capturedDescription" = NULL WHERE "id" = ?`);
  });
});

describe("the group description is kept beside the chat, masked (2026-10-12)", () => {
  const RAW = "Mondays 20:30, 9 a side, £7.\nSort 12-34-56 Acc 12345678";
  const MASKED = "Mondays 20:30, 9 a side, £7.\nSort [number removed] Acc [number removed]";
  const sqlCalls = () =>
    dbMock.$executeRaw.mock.calls.map((c) => ({ sql: (c[0] as TemplateStringsArray).join("?"), values: c.slice(1) as unknown[] }));
  const everythingWritten = () =>
    JSON.stringify([
      dbMock.clubConnect.updateMany.mock.calls,
      dbMock.$executeRaw.mock.calls,
      dbMock.unsolicitedGroup.create.mock.calls,
      dbMock.platformJob.create.mock.calls,
    ]);

  it("the link stores it masked, and the unmasked text is written nowhere and logged nowhere", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const out = await add({ groupDescription: RAW });
    expect(out.kind).toBe("linked");
    expect(dbMock.clubConnect.updateMany.mock.calls[0][0].data.capturedDescription).toBe(MASKED);
    const written = everythingWritten();
    const logged = JSON.stringify(log.mock.calls);
    for (const secret of ["12-34-56", "12345678"]) {
      expect(written).not.toContain(secret);
      expect(logged).not.toContain(secret);
    }
    // The log says how long it is, and nothing of what it says.
    expect(logged).toContain(`description ${MASKED.length} chars`);
    expect(logged).not.toContain("9 a side");
    // Nor is it in what the owner is told.
    if (out.kind === "linked") expect(out.ownerDm.text).not.toContain("Mondays");
    log.mockRestore();
  });

  it("none sent, blank, not text, or far too long: nothing stored", async () => {
    for (const groupDescription of [undefined, null, "   ", 42, { text: "x" }, "x".repeat(4097)]) {
      vi.clearAllMocks();
      dbMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(dbMock));
      dbMock.clubConnect.updateMany.mockResolvedValue({ count: 1 });
      dbMock.organisation.updateMany.mockResolvedValue({ count: 1 });
      await add({ groupDescription });
      expect(dbMock.clubConnect.updateMany.mock.calls[0][0].data.capturedDescription).toBeUndefined();
    }
  });

  it("a re-add of a linked group fills it in only when none is stored, masked, and never replaces one", async () => {
    dbMock.clubConnect.findFirst.mockResolvedValue({ id: "cc-ali", linkedAt: mins(-60) });
    const out = await add({ groupDescription: RAW });
    expect(out).toEqual({ kind: "already-linked", connectId: "cc-ali" });
    const q = sqlCalls().find((c) => c.sql.includes(`"capturedDescription" =`));
    expect(q).toBeDefined();
    expect(q!.sql.replace(/\s+/g, " ")).toBe(
      `UPDATE "ClubConnect" SET "capturedDescription" = ? WHERE "id" = ? AND "capturedDescription" IS NULL ` +
        `AND "status" = 'group_linked' AND "botRemovedAt" IS NULL`,
    );
    expect(q!.values).toEqual([MASKED, "cc-ali"]);
    expect(everythingWritten()).not.toContain("12345678");
  });

  it("a re-add that brings none writes nothing about it", async () => {
    dbMock.clubConnect.findFirst.mockResolvedValue({ id: "cc-ali", linkedAt: mins(-60) });
    await add({});
    expect(sqlCalls().some((c) => c.sql.includes("capturedDescription"))).toBe(false);
  });

  it("a re-add on a link already past the retention limit stores nothing: the expiry would only delete it again", async () => {
    dbMock.clubConnect.findFirst.mockResolvedValue({ id: "cc-ali", linkedAt: mins(-8 * 24 * 60) });
    await add({ groupDescription: RAW, enrichmentHistory: [{ author: "Ali", text: "in", timestamp: "2026-09-28T10:00:00Z" }] });
    expect(dbMock.$executeRaw).not.toHaveBeenCalled();
  });

  it("a group the reconnect sweep found brings no description, whatever the post carries", async () => {
    const out = await add({ discovered: true, addedByPhone: undefined, groupDescription: RAW });
    expect(out.kind).toBe("linked");
    expect(dbMock.clubConnect.updateMany.mock.calls[0][0].data).not.toHaveProperty("capturedDescription");
    expect(everythingWritten()).not.toContain("Mondays");

    vi.clearAllMocks();
    dbMock.clubConnect.findFirst.mockResolvedValue({ id: "cc-ali", linkedAt: mins(-60) });
    await add({ discovered: true, groupDescription: RAW });
    expect(sqlCalls().some((c) => c.sql.includes("capturedDescription"))).toBe(false);
  });

  it("an unsolicited add stores none of it", async () => {
    dbMock.clubConnect.findMany.mockResolvedValue([]);
    const out = await add({ addedByPhone: STRANGER, groupDescription: RAW });
    expect(out.kind).toBe("unsolicited");
    expect(everythingWritten()).not.toContain("Mondays");
    expect(dbMock.clubConnect.updateMany).not.toHaveBeenCalled();
  });

  it("a group an approved club owns (Sutton FC): the description is never read into anything", async () => {
    dbMock.organisation.findFirst.mockResolvedValueOnce({ id: "org-sutton" });
    const out = await add({ groupId: SUTTON_GROUP, groupDescription: RAW });
    expect(out).toEqual({ kind: "live-org", orgId: "org-sutton" });
    expect(dbMock.clubConnect.updateMany).not.toHaveBeenCalled();
    expect(dbMock.$executeRaw).not.toHaveBeenCalled();
  });

  it("removed from the group while pending: the description is deleted in the same statement as the chat", async () => {
    dbMock.clubConnect.findMany.mockResolvedValue([{ id: "cc-ali", orgId: "org-riverside" }]);
    await handleBotRemoved(GROUP, NOW);
    expect(sqlCalls().map((c) => c.sql)).toEqual([`UPDATE "ClubConnect" SET "capturedHistory" = NULL, "capturedDescription" = NULL WHERE "id" = ?`]);
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
    // An ordinary unsolicited group costs no extra query: the admin-code
    // condition below is only looked at for a candidate admin group.
    expect(dbMock.user.findMany).not.toHaveBeenCalled();
    expect(dbMock.membership.findMany).not.toHaveBeenCalled();
    expect(dbMock.organisation.findMany).not.toHaveBeenCalled();
  });

  describe("a candidate admin group is not left while its adder's club has an open admin group code (2026-10-12)", () => {
    const RAIHAN = "447700900555";
    const candidate = (addedMinsAgo: number, over: Record<string, unknown> = {}) => ({
      id: "ug-hq",
      groupId: GROUP,
      addedAt: mins(-addedMinsAgo),
      awaitingAdminLink: true,
      addedByPhone: RAIHAN,
      addedByLid: null,
      ...over,
    });
    /** Raihan is an admin of org-fnf; `openUntil` is that club's code expiry (null: no code). */
    function world(openUntil: Date | null) {
      dbMock.organisation.findFirst.mockResolvedValue(null);
      dbMock.user.findMany.mockImplementation(async (a: { where: { phoneNumber: { in: string[] } } }) =>
        a.where.phoneNumber.in.includes(`+${RAIHAN}`) ? [{ id: "u-raihan" }] : [],
      );
      dbMock.membership.findMany.mockImplementation(async (a: { where: { userId?: { in: string[] } } }) =>
        a.where.userId?.in.includes("u-raihan") ? [{ userId: "u-raihan", orgId: "org-fnf", org: { id: "org-fnf", name: "FNF", language: "en" } }] : [],
      );
      dbMock.organisation.findMany.mockImplementation(async (a: { where: { adminGroupLinkCodeExpiresAt?: { gt: Date } } }) =>
        openUntil && a.where.adminGroupLinkCodeExpiresAt && openUntil.getTime() > a.where.adminGroupLinkCodeExpiresAt.gt.getTime() ? [{ id: "org-fnf" }] : [],
      );
    }

    it("three days after the add, with the setup DM's 7-day code still open: NOT left", async () => {
      dbMock.unsolicitedGroup.findMany.mockResolvedValue([candidate(72 * 60)]);
      world(mins(4 * 24 * 60));
      expect(await queueUnsolicitedAutoLeaves(NOW)).toEqual({ queued: 0, markedLeft: 0 });
      expect(dbMock.platformJob.create).not.toHaveBeenCalled();
      // The code that counts: an approved club the ADDER is an owner or admin of, unexpired.
      expect(dbMock.membership.findMany.mock.calls[0][0].where).toMatchObject({
        userId: { in: ["u-raihan"] },
        leftAt: null,
        role: { in: ["OWNER", "ADMIN"] },
        org: { approvalStatus: "approved" },
      });
      expect(dbMock.organisation.findMany.mock.calls[0][0].where).toMatchObject({
        id: { in: ["org-fnf"] },
        approvalStatus: "approved",
        adminGroupLinkCode: { not: null },
        adminGroupLinkCodeExpiresAt: { gt: NOW },
      });
    });

    it("once that code has expired: left, as any unsolicited group", async () => {
      dbMock.unsolicitedGroup.findMany.mockResolvedValue([candidate(8 * 24 * 60)]);
      world(mins(-60));
      expect(await queueUnsolicitedAutoLeaves(NOW)).toEqual({ queued: 1, markedLeft: 0 });
    });

    it("no code at all (never asked for, or used to link another group): left at 48 hours, as today", async () => {
      dbMock.unsolicitedGroup.findMany.mockResolvedValue([candidate(49 * 60)]);
      world(null);
      expect(await queueUnsolicitedAutoLeaves(NOW)).toEqual({ queued: 1, markedLeft: 0 });
    });

    it("the Settings button's 48-hour code, minted before the add: it expires before the 48 hours are up, so the leave is exactly today's", async () => {
      // Code minted an hour before the add; 48 hours and one minute after the add it has expired.
      dbMock.unsolicitedGroup.findMany.mockResolvedValue([candidate(48 * 60 + 1)]);
      world(mins(-61));
      expect(await queueUnsolicitedAutoLeaves(NOW)).toEqual({ queued: 1, markedLeft: 0 });
    });

    it("an adder who is no longer an owner or admin of any approved club: left", async () => {
      dbMock.unsolicitedGroup.findMany.mockResolvedValue([candidate(72 * 60)]);
      world(mins(4 * 24 * 60));
      dbMock.membership.findMany.mockResolvedValue([]);
      expect(await queueUnsolicitedAutoLeaves(NOW)).toEqual({ queued: 1, markedLeft: 0 });
    });

    it("an ordinary unsolicited group added by the same person is left at 48 hours whatever codes are open", async () => {
      dbMock.unsolicitedGroup.findMany.mockResolvedValue([candidate(49 * 60, { awaitingAdminLink: false })]);
      world(mins(4 * 24 * 60));
      expect(await queueUnsolicitedAutoLeaves(NOW)).toEqual({ queued: 1, markedLeft: 0 });
      expect(dbMock.organisation.findMany).not.toHaveBeenCalled();
    });

    it("a held candidate does not stop the groups after it from being left", async () => {
      dbMock.unsolicitedGroup.findMany.mockResolvedValue([
        candidate(72 * 60),
        { id: "ug-2", groupId: "120363400000000002@g.us", addedAt: mins(-50 * 60), awaitingAdminLink: false, addedByPhone: "447700900999", addedByLid: null },
      ]);
      world(mins(4 * 24 * 60));
      expect(await queueUnsolicitedAutoLeaves(NOW)).toEqual({ queued: 1, markedLeft: 0 });
      expect(dbMock.platformJob.create.mock.calls[0][0].data).toMatchObject({ groupId: "120363400000000002@g.us" });
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

describe("relink after a re-add (2026-10-11): removed while pending, added straight back without a new code", () => {
  const REMOVED_AT = mins(-5);
  const CHAT = [{ author: "Ben", text: "in for Tuesday", timestamp: "2026-10-10T18:00:00.000Z" }];
  const removedRow = (over: Record<string, unknown> = {}) =>
    connectRow({
      status: "group_linked",
      groupId: GROUP,
      botRemovedAt: REMOVED_AT,
      org: { approvalStatus: "draft" },
      ...over,
    });
  const isRemovedLinksQuery = (a: { where?: Record<string, unknown> }) =>
    a?.where?.status === "group_linked" && a.where.botRemovedAt != null;
  const removedLinksCalls = () =>
    dbMock.clubConnect.findMany.mock.calls.filter((c: Array<{ where?: Record<string, unknown> }>) => isRemovedLinksQuery(c[0]));
  /** No open request (and no LID on file); the removed links that name this group. */
  const removedLinks = (rows: unknown[], open: unknown[] = []) => {
    dbMock.clubConnect.findMany.mockReset();
    dbMock.clubConnect.findMany.mockImplementation(async (a: { where?: Record<string, unknown> }) =>
      isRemovedLinksQuery(a) ? rows : a?.where?.org ? open : [],
    );
  };

  beforeEach(() => {
    removedLinks([removedRow()]);
    dbMock.clubConnect.count.mockResolvedValue(0);
  });

  it("the organiser re-adds: the same request is linked again through the normal link, with the new chat", async () => {
    const out = await add({ enrichmentHistory: CHAT });
    expect(out).toMatchObject({
      kind: "linked",
      relinked: true,
      connectId: "cc-ali",
      orgId: "org-riverside",
      adderMatch: "phone",
      organiserAckQueued: true,
    });

    // Which rows were read: removed links of THIS group only.
    expect(removedLinksCalls()).toHaveLength(1);
    expect(removedLinksCalls()[0][0].where).toEqual({
      groupId: GROUP,
      status: "group_linked",
      botRemovedAt: { not: null },
    });

    // Compare-and-set on the very removal that was read.
    const upd = dbMock.clubConnect.updateMany.mock.calls[0][0];
    expect(upd.where).toEqual({ id: "cc-ali", status: "group_linked", groupId: GROUP, botRemovedAt: REMOVED_AT });
    expect(upd.data).toMatchObject({
      status: "group_linked",
      groupId: GROUP,
      groupSubject: "Riverside Tuesday 5s",
      memberCount: 2,
      addedByPhone: ALI,
      adderMatch: "phone",
      detectedLang: "en",
      linkedAt: NOW,
      botRemovedAt: null,
    });
    expect(upd.data.capturedHistory).toHaveLength(1);
    expect(upd.data.capturedHistory[0]).toMatchObject({ author: "Ben", text: "in for Tuesday" });
    expect(upd.data.participants).toHaveLength(2);

    // The club: draft -> pending, the one writer, compare-and-set.
    expect(dbMock.organisation.updateMany).toHaveBeenCalledWith({
      where: { id: "org-riverside", approvalStatus: "draft" },
      data: { approvalStatus: "pending" },
    });

    // An unsolicited row left open for this group must not get it left in 48 hours.
    expect(dbMock.unsolicitedGroup.updateMany).toHaveBeenCalledWith({
      where: { groupId: GROUP, leftAt: null },
      data: { leftAt: NOW, awaitingAdminLink: false },
    });
    expect(dbMock.unsolicitedGroup.create).not.toHaveBeenCalled();

    // One ack and one owner DM, keyed on this removal, not on the first link.
    if (out.kind !== "linked") throw new Error("unreachable");
    const stamp = REMOVED_AT.toISOString();
    expect(dbMock.platformJob.create).toHaveBeenCalledTimes(1);
    expect(dbMock.platformJob.create.mock.calls[0][0].data).toMatchObject({
      phone: ALI,
      purpose: "connect-reply",
      refId: `cc-ali:in-group:relink:${stamp}`,
    });
    expect(out.ownerDm.refId).toBe(`cc-ali:relink:${stamp}`);
    expect(out.ownerDm.text).toContain("New club waiting: *Riverside FC* (ref 7KQ2)");
    expect(out.ownerDm.text).toContain("Added by: the organiser (matched by phone)");
    expect(anthropicCalls.n).toBe(0);
  });

  it("matched by the connect DM's LID", async () => {
    const out = await add({ addedByPhone: null, addedByLid: `${ALI_LID}@lid` });
    expect(out).toMatchObject({ kind: "linked", relinked: true, adderMatch: "lid", organiserAckQueued: true });
  });

  it("a stranger re-adds, the organiser still in the group: unsolicited exactly as before, nothing linked, nobody DMed", async () => {
    const out = await add({ addedByPhone: STRANGER });
    expect(out).toEqual({ kind: "unsolicited", recorded: true, id: "ug-1" });
    expect(dbMock.clubConnect.updateMany).not.toHaveBeenCalled();
    expect(dbMock.organisation.updateMany).not.toHaveBeenCalled();
    expect(dbMock.unsolicitedGroup.updateMany).not.toHaveBeenCalled();
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("removed more than 24 hours ago: unsolicited", async () => {
    removedLinks([removedRow({ botRemovedAt: mins(-24 * 60 - 1) })]);
    expect(await add()).toMatchObject({ kind: "unsolicited" });
    expect(dbMock.clubConnect.updateMany).not.toHaveBeenCalled();
  });

  it.each(["pending", "approved", "rejected", "suspended"])("the club is %s: unsolicited", async (approvalStatus) => {
    removedLinks([removedRow({ org: { approvalStatus } })]);
    expect(await add()).toMatchObject({ kind: "unsolicited" });
    expect(dbMock.clubConnect.updateMany).not.toHaveBeenCalled();
  });

  it("the club has a newer connect request: the code flow owns it, so unsolicited", async () => {
    dbMock.clubConnect.count.mockResolvedValue(1);
    expect(await add()).toMatchObject({ kind: "unsolicited" });
    expect(dbMock.clubConnect.count.mock.calls[0][0].where).toEqual({
      orgId: "org-riverside",
      id: { not: "cc-ali" },
      issuedAt: { gte: connectRow().issuedAt },
    });
    expect(dbMock.clubConnect.updateMany).not.toHaveBeenCalled();
  });

  it("an open request that matches the add wins: linked by the normal rule, the removed link is never read", async () => {
    removedLinks([removedRow()], [connectRow({ id: "cc-new" })]);
    const out = await add();
    expect(out).toMatchObject({ kind: "linked", connectId: "cc-new" });
    expect(out).not.toHaveProperty("relinked");
    expect(removedLinksCalls()).toHaveLength(0);
    expect(dbMock.clubConnect.updateMany.mock.calls[0][0].where).toEqual({ id: "cc-new", status: "dm_verified" });
    expect(dbMock.unsolicitedGroup.updateMany).not.toHaveBeenCalled();
    if (out.kind !== "linked") throw new Error("unreachable");
    expect(out.ownerDm.refId).toBe("cc-new");
  });

  describe("the relink comes BEFORE the admin-group rule: the organiser already proved this is the club's group", () => {
    const BEN = "447700900201";
    /** `phone` is an owner or admin of the approved club org-x. */
    const adminOfApprovedClub = (phone: string, userId: string) => {
      dbMock.user.findMany.mockImplementation(async (a: { where: { phoneNumber: { in: string[] } } }) =>
        a.where.phoneNumber.in.includes(`+${phone}`) ? [{ id: userId }] : [],
      );
      dbMock.membership.findMany.mockImplementation(async (a: { where: { userId?: { in: string[] } } }) =>
        a.where.userId?.in.includes(userId) ? [{ userId, orgId: "org-x", org: { id: "org-x", name: "X", language: "en" } }] : [],
      );
    };
    /** org-x has an admin-group link code open. */
    const openAdminCode = () =>
      dbMock.organisation.findMany.mockResolvedValue([{ id: "org-x", adminGroupLinkCodeExpiresAt: mins(30) }]);

    it("(a) the organiser is also an owner or admin of an approved club: relinked, not an admin-group candidate", async () => {
      adminOfApprovedClub(ALI, "u-ali");
      const out = await add();
      expect(out).toMatchObject({ kind: "linked", relinked: true, connectId: "cc-ali", adderMatch: "phone" });
      expect(dbMock.unsolicitedGroup.create).not.toHaveBeenCalled();
      expect(dbMock.unsolicitedGroup.update).not.toHaveBeenCalled();
    });

    it("(b) a group member is an admin of an approved club with a link code open: relinked, not an admin-group candidate", async () => {
      adminOfApprovedClub(BEN, "u-ben");
      openAdminCode();
      const out = await add();
      expect(out).toMatchObject({ kind: "linked", relinked: true, connectId: "cc-ali" });
      expect(dbMock.unsolicitedGroup.create).not.toHaveBeenCalled();
    });

    it("a NON-organiser admin of an approved club adds MatchTime to that group: still an admin-group candidate", async () => {
      adminOfApprovedClub(STRANGER, "u-raihan");
      const out = await add({ addedByPhone: STRANGER });
      expect(out).toEqual({ kind: "admin-group-candidate", id: "ug-1" });
      expect(removedLinksCalls()).toHaveLength(1);
      expect(dbMock.clubConnect.updateMany).not.toHaveBeenCalled();
      expect(dbMock.organisation.updateMany).not.toHaveBeenCalled();
      expect(dbMock.platformJob.create).not.toHaveBeenCalled();
    });

    it("a stranger's add while a member-admin has a code open: still an admin-group candidate, as before", async () => {
      adminOfApprovedClub(BEN, "u-ben");
      openAdminCode();
      expect(await add({ addedByPhone: STRANGER })).toEqual({ kind: "admin-group-candidate", id: "ug-1" });
      expect(dbMock.clubConnect.updateMany).not.toHaveBeenCalled();
    });

    it("a relink closes an admin-group candidate row left open for the group", async () => {
      await add();
      expect(dbMock.unsolicitedGroup.updateMany).toHaveBeenCalledWith({
        where: { groupId: GROUP, leftAt: null },
        data: { leftAt: NOW, awaitingAdminLink: false },
      });
    });
  });

  describe("a new code issued while the relink runs", () => {
    const lockKeys = () =>
      dbMock.$executeRaw.mock.calls
        .map((c: unknown[]) => c[1])
        .filter((v: unknown): v is string => typeof v === "string" && /^(group-add|club-connect):/.test(v));

    it("the relink takes the group lock, then the club's code lock, and checks again inside", async () => {
      await add();
      expect(lockKeys()).toEqual([`group-add:${GROUP}`, "club-connect:org-riverside"]);
      // Once to decide, once more under the locks.
      expect(dbMock.clubConnect.count).toHaveBeenCalledTimes(2);
      expect(dbMock.clubConnect.count.mock.calls[1][0].where).toEqual(dbMock.clubConnect.count.mock.calls[0][0].where);
    });

    it("a newer request appeared in between: the relink is abandoned, nothing written, the add is unsolicited", async () => {
      dbMock.clubConnect.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
      expect(await add()).toEqual({ kind: "unsolicited", recorded: true, id: "ug-1" });
      expect(dbMock.clubConnect.updateMany).not.toHaveBeenCalled();
      expect(dbMock.organisation.updateMany).not.toHaveBeenCalled();
      expect(dbMock.unsolicitedGroup.updateMany).not.toHaveBeenCalled();
      expect(dbMock.platformJob.create).not.toHaveBeenCalled();
    });

    it("abandoned, and the adder is an admin of an approved club: falls through to the admin-group rule", async () => {
      dbMock.clubConnect.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
      dbMock.user.findMany.mockResolvedValue([{ id: "u-ali" }]);
      dbMock.membership.findMany.mockResolvedValue([{ userId: "u-ali", orgId: "org-x", org: { id: "org-x", name: "X", language: "en" } }]);
      expect(await add()).toEqual({ kind: "admin-group-candidate", id: "ug-1" });
      expect(dbMock.clubConnect.updateMany).not.toHaveBeenCalled();
    });

    it("a first link takes the group lock only, as before", async () => {
      removedLinks([], [connectRow()]);
      await add();
      expect(lockKeys()).toEqual([`group-add:${GROUP}`]);
    });
  });

  describe("the member list of a relink", () => {
    const clearsParticipants = () =>
      dbMock.$executeRaw.mock.calls.some((c: unknown[]) => (c[0] as string[]).join("?").includes('"participants" = NULL'));

    it("no member list came with the re-add: the one from before the removal is cleared, not kept", async () => {
      await add({ participants: [] });
      const upd = dbMock.clubConnect.updateMany.mock.calls[0][0];
      expect(upd.data.memberCount).toBe(0);
      expect(clearsParticipants()).toBe(true);
    });

    it("a member list came: it replaces the old one, nothing is cleared", async () => {
      await add();
      expect(dbMock.clubConnect.updateMany.mock.calls[0][0].data.participants).toHaveLength(2);
      expect(clearsParticipants()).toBe(false);
    });

    it("a first link has no earlier list to clear", async () => {
      removedLinks([], [connectRow()]);
      await add({ participants: [] });
      expect(clearsParticipants()).toBe(false);
    });
  });

  describe("two clubs' removed links name this group", () => {
    const theirs = (over: Record<string, unknown> = {}) =>
      removedRow({ id: "cc-other", orgId: "org-other", userId: "u-other", phone: STRANGER, dmLid: null, ...over });

    it("Ali's was removed last: Ali's is the one relinked", async () => {
      removedLinks([theirs({ botRemovedAt: mins(-120) }), removedRow({ botRemovedAt: mins(-10) })]);
      const out = await add();
      expect(out).toMatchObject({ kind: "linked", relinked: true, connectId: "cc-ali", orgId: "org-riverside" });
      expect(dbMock.clubConnect.updateMany.mock.calls[0][0].where).toMatchObject({ id: "cc-ali", botRemovedAt: mins(-10) });
    });

    it("the other club's was removed last: Ali's older link is NOT revived", async () => {
      removedLinks([theirs({ botRemovedAt: mins(-10) }), removedRow({ botRemovedAt: mins(-120) })]);
      expect(await add()).toMatchObject({ kind: "unsolicited" });
      expect(dbMock.clubConnect.updateMany).not.toHaveBeenCalled();
    });
  });

  it("the same add delivered twice: the second finds the link waiting and DMs nobody", async () => {
    await add();
    expect(dbMock.platformJob.create).toHaveBeenCalledTimes(1);
    dbMock.clubConnect.findFirst.mockResolvedValue({ id: "cc-ali", linkedAt: NOW });
    expect(await add()).toEqual({ kind: "already-linked", connectId: "cc-ali" });
    expect(dbMock.platformJob.create).toHaveBeenCalledTimes(1);
    expect(dbMock.clubConnect.updateMany).toHaveBeenCalledTimes(1);
  });

  it("two deliveries racing: the one that loses the compare-and-set writes nothing more", async () => {
    dbMock.clubConnect.updateMany.mockResolvedValue({ count: 0 });
    expect(await add()).toEqual({ kind: "race-lost" });
    expect(dbMock.organisation.updateMany).not.toHaveBeenCalled();
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("the club stopped being a draft while relinking: rolled back", async () => {
    dbMock.organisation.updateMany.mockResolvedValue({ count: 0 });
    expect(await add()).toEqual({ kind: "race-lost" });
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("an ack already queued for this removal is not queued again", async () => {
    dbMock.platformJob.findFirst.mockResolvedValue({ id: "pj-0" });
    const out = await add();
    expect(out).toMatchObject({ kind: "linked", relinked: true, organiserAckQueued: false });
    expect(dbMock.platformJob.findFirst.mock.calls[0][0].where).toEqual({
      purpose: "connect-reply",
      refId: `cc-ali:in-group:relink:${REMOVED_AT.toISOString()}`,
    });
  });

  it("found by the reconnect sweep: never relinked, never recorded", async () => {
    expect(await add({ discovered: true, addedByPhone: undefined })).toEqual({ kind: "discovered-no-match" });
    expect(removedLinksCalls()).toHaveLength(0);
    expect(dbMock.clubConnect.updateMany).not.toHaveBeenCalled();
  });
});

// ── 2026-10-15: the FNF incident ──────────────────────────────────────────

describe("a WhatsApp community's parent or announcements group", () => {
  it("the parent group: refused before any request is read; nothing written, recorded or sent", async () => {
    const out = await add({
      addedByPhone: undefined,
      community: { isCommunity: true, isCommunityAnnounce: false, linkedParent: null },
    });
    expect(out).toEqual({ kind: "community-group", role: "parent" });
    expect(isSilentOutcome(out)).toBe(true);
    expect(dbMock.clubConnect.findMany).not.toHaveBeenCalled();
    expect(dbMock.clubConnect.updateMany).not.toHaveBeenCalled();
    expect(dbMock.unsolicitedGroup.create).not.toHaveBeenCalled();
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("the announcements group, even added by the organiser", async () => {
    const out = await add({ community: { isCommunity: false, isCommunityAnnounce: true, linkedParent: "120363400000000777@g.us" } });
    expect(out).toEqual({ kind: "community-group", role: "announce" });
    expect(dbMock.clubConnect.updateMany).not.toHaveBeenCalled();
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("a group INSIDE a community (it has a parent) links as any group does", async () => {
    const out = await add({ community: { isCommunity: false, isCommunityAnnounce: false, linkedParent: "120363400000000777@g.us" } });
    expect(out.kind).toBe("linked");
  });

  it("an approved club's group is still 'live-org' first, whatever the community facts say", async () => {
    dbMock.organisation.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      args.where.approvalStatus === "approved" ? { id: "sutton" } : null,
    );
    const out = await add({ community: { isCommunity: true } });
    expect(out).toEqual({ kind: "live-org", orgId: "sutton" });
  });
});

describe("the stronger add wins: the organiser's own add moves a request linked on weak evidence", () => {
  const PARENT = "120363400000000777@g.us";
  const weakRow = (over: Record<string, unknown> = {}) => ({
    ...connectRow(),
    status: "group_linked",
    groupId: PARENT,
    botRemovedAt: null,
    adderMatch: "other-organiser-present",
    linkedAt: mins(-0.2),
    org: { approvalStatus: "pending" },
    ...over,
  });
  const isUpgradeQuery = (a: { where?: Record<string, unknown> }) =>
    !!a?.where && (a.where.adderMatch as { in?: unknown } | undefined)?.in !== undefined;
  const moveCall = () =>
    dbMock.clubConnect.updateMany.mock.calls.find(
      (c) => (c[0] as { where: { groupId?: unknown } }).where.groupId === PARENT,
    )?.[0] as { where: Record<string, unknown>; data: Record<string, unknown> } | undefined;

  beforeEach(() => {
    (dbMock.clubConnect as unknown as { findUnique: ReturnType<typeof vi.fn> }).findUnique = vi.fn(async () => connectRow());
    dbMock.clubConnect.findFirst.mockImplementation(async (a: { where: Record<string, unknown> }) =>
      a.where.id === "cc-ali" && a.where.groupId === PARENT ? { groupSubject: "FNF ⚽️", memberCount: 8 } : null,
    );
  });

  it("THE RACE OF THAT DAY: the first link loses its compare-and-set to the parent group's weak link, and the request is moved here", async () => {
    dbMock.clubConnect.findMany.mockImplementation(async (a: { where?: Record<string, unknown> }) => {
      if (isUpgradeQuery(a)) return [weakRow()];
      if (a?.where?.status === "group_linked") return []; // the relink rule's removed links
      return [connectRow()]; // the open request, as read before the weak link committed
    });
    dbMock.clubConnect.updateMany.mockResolvedValueOnce({ count: 0 }); // the first link's CAS: lost
    const out = await add({ groupSubject: "Friday Night Football 🏟", addedByLid: ALI_LID });
    expect(out).toMatchObject({
      kind: "linked",
      connectId: "cc-ali",
      adderMatch: "phone",
      upgradedFrom: { groupId: PARENT, subject: "FNF ⚽️", memberCount: 8 },
      organiserAckQueued: true,
    });
    const move = moveCall();
    expect(move?.where).toMatchObject({
      id: "cc-ali",
      status: "group_linked",
      groupId: PARENT,
      botRemovedAt: null,
      adderMatch: { in: ["other-organiser-present", "unknown"] },
    });
    expect(move?.where.org).toBeDefined();
    expect(move?.data).toMatchObject({ groupId: GROUP, groupSubject: "Friday Night Football 🏟", memberCount: 2, adderMatch: "phone" });
    // Both groups' locks, in sorted order; the other group's chat cleared.
    const sql = dbMock.$executeRaw.mock.calls.map((c) => (c[0] as TemplateStringsArray).join("?"));
    expect(sql.filter((s) => s.includes("pg_advisory_xact_lock")).length).toBeGreaterThanOrEqual(2);
    expect(sql.some((s) => s.includes(`"capturedHistory" = NULL`))).toBe(true);
    // The owner's DMs are built, not sent here.
    if (out.kind !== "linked") throw new Error("not linked");
    expect(out.ownerDm.refId).toBe("cc-ali");
    expect(out.ownerDm.text).toContain(`Group: "Friday Night Football 🏟", 2 members`);
    expect(out.correctionDm?.refId).toBe(`cc-ali:relinked:${GROUP}`);
    expect(out.correctionDm?.text).toContain(`It replaces "FNF ⚽️", 8 members`);
    // The organiser's one "I'm in" ack.
    expect(dbMock.platformJob.create.mock.calls.map((c) => c[0].data)).toEqual([
      expect.objectContaining({ phone: ALI, refId: "cc-ali:in-group" }),
    ]);
  });

  it("the weak link already committed when this add read the requests: no match, then moved", async () => {
    dbMock.clubConnect.findMany.mockImplementation(async (a: { where?: Record<string, unknown> }) =>
      isUpgradeQuery(a) ? [weakRow({ adderMatch: "unknown" })] : [],
    );
    const out = await add();
    expect(out).toMatchObject({ kind: "linked", upgradedFrom: { groupId: PARENT } });
    expect(dbMock.unsolicitedGroup.create).not.toHaveBeenCalled();
  });

  it("an add by anybody else never moves it: unsolicited, as before", async () => {
    dbMock.clubConnect.findMany.mockImplementation(async (a: { where?: Record<string, unknown> }) =>
      isUpgradeQuery(a) ? [weakRow()] : [],
    );
    const out = await add({ addedByPhone: STRANGER });
    expect(out.kind).toBe("unsolicited");
    expect(moveCall()).toBeUndefined();
  });

  it("a club no longer pending is never moved", async () => {
    dbMock.clubConnect.findMany.mockImplementation(async (a: { where?: Record<string, unknown> }) =>
      isUpgradeQuery(a) ? [weakRow({ org: { approvalStatus: "approved" } })] : [],
    );
    const out = await add();
    expect(out.kind).toBe("unsolicited");
    expect(moveCall()).toBeUndefined();
  });

  it("never into a group MatchTime cannot post in", async () => {
    dbMock.clubConnect.findMany.mockImplementation(async (a: { where?: Record<string, unknown> }) =>
      isUpgradeQuery(a) ? [weakRow()] : [],
    );
    await add({ postability: { announce: true, communityAnnounce: false, botIsAdmin: false } });
    expect(moveCall()).toBeUndefined();
  });

  it("the request moved again under the locks (or the club was decided): nothing written, nobody told", async () => {
    dbMock.clubConnect.findMany.mockImplementation(async (a: { where?: Record<string, unknown> }) =>
      isUpgradeQuery(a) ? [weakRow()] : [],
    );
    dbMock.clubConnect.updateMany.mockResolvedValue({ count: 0 });
    const out = await add();
    expect(out.kind).not.toBe("linked");
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
    const sql = dbMock.$executeRaw.mock.calls.map((c) => (c[0] as TemplateStringsArray).join("?"));
    expect(sql.some((s) => s.includes(`"capturedHistory" = NULL`))).toBe(false);
  });

  it("another request already linked to this group: already-linked, nothing moved", async () => {
    dbMock.clubConnect.findMany.mockImplementation(async (a: { where?: Record<string, unknown> }) =>
      isUpgradeQuery(a) ? [weakRow()] : [],
    );
    let calls = 0;
    dbMock.clubConnect.findFirst.mockImplementation(async (a: { where: Record<string, unknown> }) => {
      // Step 2 (before the matcher) sees nothing; inside the move's locks, another request has it.
      if (a.where.groupId === GROUP && a.where.status === "group_linked") return ++calls > 1 ? { id: "cc-other" } : null;
      return null;
    });
    const out = await add();
    expect(out).toEqual({ kind: "already-linked", connectId: "cc-other" });
    expect(moveCall()).toBeUndefined();
  });
});
