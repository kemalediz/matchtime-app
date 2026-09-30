/**
 * Slice 2a: linking an admin WhatsApp group with a code, keeping an HQ
 * group out of the in-group setup, unlinking, and being removed. Against a
 * mocked database. Plan: MDs/friday-group-features-plan-2026-09-30.md,
 * sections 2.3 and 2.4.
 *
 * Deterministic: no model anywhere in the module (asserted by mocking the
 * Anthropic SDK and counting its calls).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const anthropicCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: () => {
        anthropicCalls.n++;
        throw new Error("no model in the admin-group link path");
      },
    };
  },
}));

const dbMock = vi.hoisted(() => {
  const m = {
    organisation: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    user: { findMany: vi.fn() },
    membership: { findMany: vi.fn() },
    clubConnect: { findMany: vi.fn() },
    onboardingSession: { findMany: vi.fn(), updateMany: vi.fn() },
    unsolicitedGroup: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    botJob: { create: vi.fn() },
    platformJob: { findFirst: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  };
  m.$transaction.mockImplementation(async (fn: (tx: typeof m) => unknown) => fn(m));
  return m;
});
vi.mock("@/lib/db", () => ({ db: dbMock }));

import {
  createAdminGroupLinkCode,
  detectAdminGroupCandidate,
  handleAdminGroupRemoved,
  linkAdminGroup,
  loadAdminGroups,
  recordAdminGroupCandidate,
  unlinkAdminGroup,
} from "../admin-group-link";

const NOW = new Date("2026-09-30T12:00:00Z");
const HQ = "120363900000000001@g.us";
const FNF_GROUP = "120363900000000009@g.us";
const RAIHAN_PHONE = "447700900102";
const RAIHAN_LID = "158055467598102";
const STRANGER_PHONE = "447700900999";

const FNF = {
  id: "org-fnf",
  name: "Friday FNF",
  language: "en",
  whatsappGroupId: FNF_GROUP,
  adminGroupId: null as string | null,
  adminGroupLinkCode: "K7P3QX" as string | null,
  adminGroupLinkCodeExpiresAt: new Date(NOW.getTime() + 3_600_000) as Date | null,
};

/** Users by phone. Raihan is an admin of Friday FNF (approved). */
function world(opts: { code?: Partial<typeof FNF>; adminGroupOwner?: unknown; communityOwner?: unknown } = {}) {
  const fnf = { ...FNF, ...(opts.code ?? {}) };
  dbMock.user.findMany.mockImplementation(async (args: { where: { phoneNumber: { in: string[] } } }) =>
    args.where.phoneNumber.in.includes(`+${RAIHAN_PHONE}`) ? [{ id: "u-raihan" }] : [],
  );
  dbMock.membership.findMany.mockImplementation(async (args: { where: { userId: { in: string[] } } }) =>
    args.where.userId.in.includes("u-raihan")
      ? [{ userId: "u-raihan", orgId: fnf.id, org: { id: fnf.id, name: fnf.name, language: fnf.language } }]
      : [],
  );
  dbMock.organisation.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) => {
    if ("whatsappGroupId" in args.where) return opts.communityOwner ?? null;
    if ("adminGroupId" in args.where) return opts.adminGroupOwner ?? null;
    if ("adminGroupLinkCode" in args.where) {
      return args.where.adminGroupLinkCode === fnf.adminGroupLinkCode ? fnf : null;
    }
    return null;
  });
  dbMock.organisation.updateMany.mockResolvedValue({ count: 1 });
  return fnf;
}

const ENV = process.env.SELF_JOIN_ENABLED;
afterAll(() => {
  process.env.SELF_JOIN_ENABLED = ENV;
  expect(anthropicCalls.n).toBe(0);
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.$transaction.mockImplementation(async (fn: (tx: typeof dbMock) => unknown) => fn(dbMock));
  dbMock.clubConnect.findMany.mockResolvedValue([]);
  dbMock.onboardingSession.findMany.mockResolvedValue([]);
  dbMock.onboardingSession.updateMany.mockResolvedValue({ count: 0 });
  dbMock.unsolicitedGroup.updateMany.mockResolvedValue({ count: 0 });
  dbMock.organisation.findMany.mockResolvedValue([]);
  dbMock.platformJob.findFirst.mockResolvedValue(null);
  dbMock.platformJob.create.mockResolvedValue({ id: "pj1" });
});

const send = (text: string, over: Record<string, unknown> = {}) =>
  linkAdminGroup({ groupId: HQ, text, senderPhone: RAIHAN_PHONE, groupSubject: "FNF HQ", now: NOW, ...over });

describe("linkAdminGroup", () => {
  it("a valid code from an admin links the group, clears the code, abandons a setup, closes the candidate row, replies L1", async () => {
    world();
    const r = await send("@Match Time admin group k7p3qx");
    expect(r).toEqual({
      outcome: "linked",
      replyText: "✅ Linked as the admin group for *Friday FNF*.",
      adminGroup: { groupId: HQ, orgId: "org-fnf" },
    });
    const update = dbMock.organisation.updateMany.mock.calls[0][0];
    expect(update.where).toMatchObject({ id: "org-fnf", adminGroupLinkCode: "K7P3QX" });
    expect(update.data).toMatchObject({
      adminGroupId: HQ,
      adminGroupSubject: "FNF HQ",
      adminGroupLinkedAt: NOW,
      adminGroupLinkedByUserId: "u-raihan",
      adminGroupLinkCode: null,
      adminGroupLinkCodeExpiresAt: null,
      adminChannelMode: "admin-group",
    });
    expect(dbMock.unsolicitedGroup.updateMany.mock.calls[0][0]).toMatchObject({
      where: { groupId: HQ, leftAt: null },
      data: { leftAt: NOW, awaitingAdminLink: false },
    });
    expect(dbMock.onboardingSession.updateMany.mock.calls[0][0].where.whatsappGroupId).toBe(HQ);
    expect(dbMock.onboardingSession.updateMany.mock.calls[0][0].data).toEqual({ stage: "abandoned" });
  });

  it("with no subject from the Pi, the subject recorded at the add is used", async () => {
    world();
    dbMock.unsolicitedGroup.findFirst.mockResolvedValue({ subject: "FNF HQ (from the add)" });
    await send("@Match Time admin group K7P3QX", { groupSubject: undefined });
    expect(dbMock.organisation.updateMany.mock.calls[0][0].data.adminGroupSubject).toBe("FNF HQ (from the add)");
  });

  it("the sender is resolved by a stored LID pair when the phone is hidden", async () => {
    world();
    dbMock.clubConnect.findMany.mockResolvedValue([{ userId: "u-raihan", dmLid: RAIHAN_LID, participants: null }]);
    const r = await send("@Match Time admin group K7P3QX", { senderPhone: null, senderLid: `${RAIHAN_LID}@lid` });
    expect(r.outcome).toBe("linked");
  });

  it("replies in the club's language", async () => {
    world({ code: { language: "tr" } });
    dbMock.membership.findMany.mockResolvedValue([
      { userId: "u-raihan", orgId: "org-fnf", org: { id: "org-fnf", name: "Friday FNF", language: "tr" } },
    ]);
    const r = await send("@Match Time yönetici grubu K7P3QX");
    expect(r.replyText).toBe("✅ *Friday FNF* için yönetici grubu olarak bağlandı.");
  });

  it("a wrong code from an admin gets L2", async () => {
    world();
    const r = await send("@Match Time admin group ZZZZZZ");
    expect(r.outcome).toBe("bad-code");
    expect(r.replyText).toMatch(/^That code isn't valid any more\./);
    expect(dbMock.organisation.updateMany).not.toHaveBeenCalled();
  });

  it("an expired code from an admin gets L2", async () => {
    world({ code: { adminGroupLinkCodeExpiresAt: new Date(NOW.getTime() - 1) } });
    expect((await send("@Match Time admin group K7P3QX")).outcome).toBe("bad-code");
  });

  it("anyone who is not an admin anywhere gets no reply, right code or wrong", async () => {
    world();
    for (const text of ["@Match Time admin group K7P3QX", "@Match Time admin group ZZZZZZ"]) {
      const r = await send(text, { senderPhone: STRANGER_PHONE });
      expect(r).toEqual({ outcome: "ignored", replyText: null, reason: "not-an-admin" });
    }
    expect(dbMock.organisation.updateMany).not.toHaveBeenCalled();
  });

  it("the club's own community group gets L3 and is not linked", async () => {
    world({ communityOwner: { id: "org-fnf", name: "Friday FNF", language: "en" } });
    const r = await send("@Match Time admin group K7P3QX", { groupId: FNF_GROUP });
    expect(r.outcome).toBe("main-group");
    expect(r.replyText).toBe("This is *Friday FNF*'s main group, so it can't be the admin group. Add me to a separate group for the admins.");
    expect(dbMock.organisation.updateMany).not.toHaveBeenCalled();
  });

  it("another club's admin group gets no reply", async () => {
    world({ adminGroupOwner: { id: "org-other", name: "Other", language: "en" } });
    const r = await send("@Match Time admin group K7P3QX");
    expect(r).toMatchObject({ outcome: "ignored", replyText: null });
    expect(dbMock.organisation.updateMany).not.toHaveBeenCalled();
  });

  it("a Pi retry after linking is answered quietly, not with L2", async () => {
    world({ adminGroupOwner: { id: "org-fnf", name: "Friday FNF", language: "en" }, code: { adminGroupLinkCode: null } });
    const r = await send("@Match Time admin group K7P3QX");
    expect(r).toEqual({ outcome: "already-linked", replyText: null, adminGroup: { groupId: HQ, orgId: "org-fnf" } });
  });

  it("a code reused after linking fails (the compare-and-set on the code loses)", async () => {
    world();
    dbMock.organisation.updateMany.mockResolvedValue({ count: 0 });
    const r = await send("@Match Time admin group K7P3QX");
    expect(r).toMatchObject({ outcome: "ignored", replyText: null, reason: "race-lost" });
  });

  it("a message that is not the command is ignored without a single read", async () => {
    world();
    const r = await send("@Match Time who is playing?");
    expect(r).toEqual({ outcome: "ignored", replyText: null, reason: "not-a-link-command" });
    expect(dbMock.user.findMany).not.toHaveBeenCalled();
  });
});

describe("detectAdminGroupCandidate and recordAdminGroupCandidate", () => {
  it("an adder who is an admin of an approved club, by phone", async () => {
    world();
    expect(await detectAdminGroupCandidate({ addedByPhone: RAIHAN_PHONE, participants: [], now: NOW })).toBe(true);
  });

  it("an adder known only by a stored LID pair", async () => {
    world();
    dbMock.onboardingSession.findMany.mockResolvedValue([
      { participants: [{ phone: RAIHAN_PHONE, lidId: `${RAIHAN_LID}@lid` }] },
    ]);
    expect(await detectAdminGroupCandidate({ addedByPhone: null, addedByLid: RAIHAN_LID, participants: [], now: NOW })).toBe(true);
  });

  it("an unknown adder, an open code, and that club's admin among the members", async () => {
    world();
    dbMock.organisation.findMany.mockResolvedValue([{ id: "org-fnf", adminGroupLinkCodeExpiresAt: new Date(NOW.getTime() + 60_000) }]);
    expect(
      await detectAdminGroupCandidate({
        addedByPhone: STRANGER_PHONE,
        participants: [{ phone: STRANGER_PHONE }, { phone: RAIHAN_PHONE }],
        now: NOW,
      }),
    ).toBe(true);
  });

  it("a stranger adding MatchTime with no code open is a new club", async () => {
    world();
    expect(
      await detectAdminGroupCandidate({ addedByPhone: STRANGER_PHONE, participants: [{ phone: RAIHAN_PHONE }], now: NOW }),
    ).toBe(false);
  });

  it("records a silent candidate row, or marks an open unsolicited row as waiting", async () => {
    dbMock.unsolicitedGroup.findFirst.mockResolvedValue(null);
    dbMock.unsolicitedGroup.create.mockResolvedValue({ id: "ug1" });
    await recordAdminGroupCandidate({ groupId: HQ, subject: "FNF HQ", memberCount: 3, addedByPhone: RAIHAN_PHONE, now: NOW });
    expect(dbMock.unsolicitedGroup.create.mock.calls[0][0].data).toMatchObject({ groupId: HQ, awaitingAdminLink: true, addedAt: NOW });

    dbMock.unsolicitedGroup.findFirst.mockResolvedValue({ id: "ug0" });
    await recordAdminGroupCandidate({ groupId: HQ, subject: "FNF HQ", memberCount: 3, addedByPhone: RAIHAN_PHONE, now: NOW });
    expect(dbMock.unsolicitedGroup.update.mock.calls[0][0]).toEqual({ where: { id: "ug0" }, data: { awaitingAdminLink: true } });
  });
});

describe("codes, unlinking and removal", () => {
  it("creates a 6-character code valid for 48 hours, replacing any earlier one", async () => {
    dbMock.organisation.updateMany.mockResolvedValue({ count: 1 });
    const r = await createAdminGroupLinkCode("org-fnf", NOW);
    expect(r.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    expect(r.expiresAt).toEqual(new Date(NOW.getTime() + 48 * 3_600_000));
    expect(dbMock.organisation.updateMany.mock.calls[0][0]).toEqual({
      where: { id: "org-fnf" },
      data: { adminGroupLinkCode: r.code, adminGroupLinkCodeExpiresAt: r.expiresAt },
    });
  });

  it("unlink clears the group, moves the club to the owner, and leaves the group", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ id: "org-fnf", adminGroupId: HQ });
    dbMock.organisation.findFirst.mockResolvedValue(null);
    dbMock.organisation.updateMany.mockResolvedValue({ count: 1 });
    const r = await unlinkAdminGroup("org-fnf");
    expect(r).toEqual({ unlinked: true, leaveQueued: true });
    expect(dbMock.organisation.updateMany.mock.calls[0][0].data).toMatchObject({
      adminGroupId: null,
      adminChannelMode: "one-person",
      adminChannelUserId: null,
    });
    expect(dbMock.platformJob.create.mock.calls[0][0].data).toMatchObject({ kind: "leave-group", groupId: HQ });
  });

  it("removed from a linked admin group: cleared, back to the owner, and L4 to the owner by DM", async () => {
    dbMock.organisation.findFirst.mockResolvedValue({ id: "org-fnf", name: "Friday FNF", language: "en" });
    dbMock.organisation.updateMany.mockResolvedValue({ count: 1 });
    dbMock.membership.findMany.mockResolvedValue([{ user: { phoneNumber: "+447700900101" } }]);
    const r = await handleAdminGroupRemoved(HQ, NOW);
    expect(r).toEqual({ unlinked: true, orgId: "org-fnf" });
    expect(dbMock.botJob.create.mock.calls[0][0].data).toEqual({
      orgId: "org-fnf",
      kind: "dm",
      phone: "447700900101",
      text: "I was removed from *Friday FNF*'s admin group, so admin messages now come to you by DM. You can link a group again in Settings.",
    });
  });

  it("removed from a group that is nobody's admin group: nothing", async () => {
    dbMock.organisation.findFirst.mockResolvedValue(null);
    expect(await handleAdminGroupRemoved(HQ, NOW)).toEqual({ unlinked: false });
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });

  it("lists every approved club's linked admin group for the Pi", async () => {
    dbMock.organisation.findMany.mockResolvedValue([{ id: "org-fnf", adminGroupId: HQ }]);
    expect(await loadAdminGroups()).toEqual([{ groupId: HQ, orgId: "org-fnf" }]);
  });
});
