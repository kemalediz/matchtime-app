/**
 * Slice 2a: `sendAdminNotice`, the one door for admin-only notices, and
 * its scheduler twin `adminNoticeInstructions`, against a mocked database.
 * Plan: MDs/friday-group-features-plan-2026-09-30.md, section 2.2.
 *
 * The contract that matters most is the first block: a club on
 * "each-admin" (every club that existed before the migration, Sutton FC
 * included) gets exactly today's rows, texts and keys.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  organisation: { findUnique: vi.fn() },
  membership: { findMany: vi.fn() },
  botJob: { create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/admin-link", async () => {
  const actual = await vi.importActual<typeof import("../admin-link")>("../admin-link");
  return {
    ...actual,
    buildAdminLink: vi.fn(async (a: { userId: string; nextPath: string }) => `https://mt.example/s/${a.userId}${a.nextPath}`),
  };
});

import {
  adminGroupJobInstruction,
  adminNoticeInstructions,
  loadAdminChannel,
  sendAdminNotice,
  type AdminNotice,
} from "../admin-channel";

const ORG = "org-fnf";
const GROUP = "120363900000000001@g.us";
const OWNER = { id: "u-owner", name: "Hamzah", phoneNumber: "+447700900101" };
const RAIHAN = { id: "u-raihan", name: "Raihan", phoneNumber: "+447700900102" };
const WASIM = { id: "u-wasim", name: "Wasim", phoneNumber: "+447700900103" };
const NOPHONE = { id: "u-nophone", name: "Nophone", phoneNumber: null };
// Prisma orders role asc; today's findOrgAdminsWithPhone keeps that order.
const MEMBERSHIPS = [
  { role: "OWNER", user: OWNER },
  { role: "ADMIN", user: RAIHAN },
  { role: "ADMIN", user: WASIM },
  { role: "ADMIN", user: NOPHONE },
];

function org(over: Record<string, unknown> = {}) {
  return {
    id: ORG,
    name: "Friday FNF",
    language: "en",
    adminChannelMode: "each-admin",
    adminChannelUserId: null,
    adminGroupId: null,
    ...over,
  };
}

const NOTICE: AdminNotice = {
  text: (link) => `🆕 New player on *Friday FNF*.\n${link}`,
  nextPath: "/admin/players/phones",
};

// 12:00 London on 30 Sept (BST).
const NOON = new Date("2026-09-30T11:00:00Z");
const NIGHT = new Date("2026-09-30T22:30:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.membership.findMany.mockResolvedValue(MEMBERSHIPS);
  dbMock.botJob.create.mockResolvedValue({});
});

const jobs = () => dbMock.botJob.create.mock.calls.map((c) => c[0].data);

describe("sendAdminNotice: each-admin is today's behaviour, byte for byte", () => {
  it("one DM BotJob per owner and admin with a phone, each with their own signed-in link", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(org());
    const r = await sendAdminNotice({ orgId: ORG, holdOvernight: false, ...NOTICE });
    expect(jobs()).toEqual([
      { orgId: ORG, kind: "dm", phone: "447700900101", text: "🆕 New player on *Friday FNF*.\nhttps://mt.example/s/u-owner/admin/players/phones" },
      { orgId: ORG, kind: "dm", phone: "447700900102", text: "🆕 New player on *Friday FNF*.\nhttps://mt.example/s/u-raihan/admin/players/phones" },
      { orgId: ORG, kind: "dm", phone: "447700900103", text: "🆕 New player on *Friday FNF*.\nhttps://mt.example/s/u-wasim/admin/players/phones" },
    ]);
    expect(r).toEqual({ channel: "dm", queued: 3 });
  });

  it("never tells an admin about themselves", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(org());
    await sendAdminNotice({ orgId: ORG, holdOvernight: false, ...NOTICE, excludeUserId: "u-raihan" });
    expect(jobs().map((j) => j.phone)).toEqual(["447700900101", "447700900103"]);
  });

  it("no link path: the text gets an empty link, as today", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(org());
    await sendAdminNotice({ orgId: ORG, holdOvernight: false, text: (link) => `left${link}` });
    expect(jobs().map((j) => j.text)).toEqual(["left", "left", "left"]);
  });
});

describe("sendAdminNotice: the other two channels", () => {
  it("one-person, nobody chosen: the owner only", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(org({ adminChannelMode: "one-person" }));
    const r = await sendAdminNotice({ orgId: ORG, holdOvernight: false, ...NOTICE });
    expect(jobs().map((j) => j.phone)).toEqual(["447700900101"]);
    expect(r).toEqual({ channel: "dm", queued: 1 });
  });

  it("one-person, Wasim chosen: Wasim only", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(org({ adminChannelMode: "one-person", adminChannelUserId: "u-wasim" }));
    await sendAdminNotice({ orgId: ORG, holdOvernight: false, ...NOTICE });
    expect(jobs().map((j) => j.phone)).toEqual(["447700900103"]);
  });

  it("admin-group with a linked group: ONE job for the group, with the plain link and never a personal one", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(org({ adminChannelMode: "admin-group", adminGroupId: GROUP }));
    const r = await sendAdminNotice({ orgId: ORG, holdOvernight: false, ...NOTICE });
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0]).toMatchObject({ orgId: ORG, kind: "admin-group" });
    expect(jobs()[0].text).toMatch(/\/admin\/players\/phones$/);
    expect(jobs()[0].text).not.toContain("/s/");
    expect(r).toEqual({ channel: "admin-group", queued: 1 });
  });

  it("admin-group with no group linked yet: the owner by DM", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(org({ adminChannelMode: "admin-group" }));
    await sendAdminNotice({ orgId: ORG, holdOvernight: false, ...NOTICE });
    expect(jobs().map((j) => [j.kind, j.phone])).toEqual([["dm", "447700900101"]]);
  });

  it("a new notice (slice 1's R4, a plain string) is held overnight to 08:00 London; an existing one is not", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(org({ adminChannelMode: "one-person" }));
    await sendAdminNotice({ orgId: ORG, text: "Late drop-out: *Ali*", now: NIGHT });
    expect(jobs()[0]).toMatchObject({ kind: "dm", phone: "447700900101", text: "Late drop-out: *Ali*" });
    expect(jobs()[0].sendAfter).toEqual(new Date("2026-10-01T07:00:00Z"));
    await sendAdminNotice({ orgId: ORG, text: "Someone left", now: NIGHT, holdOvernight: false });
    expect(jobs()[1].sendAfter).toBeUndefined();
    await sendAdminNotice({ orgId: ORG, text: "Late drop-out: *Ali*", now: NOON });
    expect(jobs()[2].sendAfter).toBeUndefined();
  });

  it("an unknown club queues nothing", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(null);
    expect(await sendAdminNotice({ orgId: ORG, holdOvernight: false, ...NOTICE })).toEqual({ channel: "none", queued: 0 });
    expect(jobs()).toEqual([]);
  });
});

describe("adminNoticeInstructions (the scheduler's notices)", () => {
  const key = (suffix: string) => `m1:switch-nudge:${suffix}`;

  async function run(over: Record<string, unknown>, opts: { caps?: boolean; now?: Date; sent?: string[] } = {}) {
    dbMock.organisation.findUnique.mockResolvedValue(org(over));
    const channel = await loadAdminChannel(ORG);
    return adminNoticeInstructions({
      channel: channel!,
      piCaps: { adminGroup: opts.caps ?? true },
      sentKeys: new Set(opts.sent ?? []),
      now: opts.now ?? NOON,
      key,
      matchId: "m1",
      notice: NOTICE,
    });
  }

  it("each-admin: today's keys (…:<adminId>), targetUser and phone without the +", async () => {
    const out = await run({});
    expect(out.map((i) => i.key)).toEqual(["m1:switch-nudge:u-owner", "m1:switch-nudge:u-raihan", "m1:switch-nudge:u-wasim"]);
    expect(out[0]).toEqual({
      kind: "dm",
      key: "m1:switch-nudge:u-owner",
      matchId: "m1",
      targetUser: "u-owner",
      phone: "447700900101",
      text: "🆕 New player on *Friday FNF*.\nhttps://mt.example/s/u-owner/admin/players/phones",
    });
  });

  it("skips a key already sent", async () => {
    const out = await run({}, { sent: ["m1:switch-nudge:u-raihan"] });
    expect(out.map((i) => i.key)).toEqual(["m1:switch-nudge:u-owner", "m1:switch-nudge:u-wasim"]);
  });

  it("admin-group: one post, key ending :admin-group, carrying its own group id and a plain link", async () => {
    const out = await run({ adminChannelMode: "admin-group", adminGroupId: GROUP });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "admin-group-message", key: "m1:switch-nudge:admin-group", groupId: GROUP, matchId: "m1" });
    expect((out[0] as { text: string }).text).not.toContain("/s/");
  });

  it("admin-group, but the Pi did not advertise the capability: the owner by DM", async () => {
    const out = await run({ adminChannelMode: "admin-group", adminGroupId: GROUP }, { caps: false });
    expect(out.map((i) => [i.kind, i.key])).toEqual([["dm", "m1:switch-nudge:u-owner"]]);
  });

  it("admin-group posts wait for 08:00 to 21:59 London", async () => {
    expect(await run({ adminChannelMode: "admin-group", adminGroupId: GROUP }, { now: NIGHT })).toEqual([]);
  });
});

describe("adminGroupJobInstruction (a queued admin-group BotJob at emit time)", () => {
  const job = { id: "job1", text: "hello admins" };

  it("posts in the group when the Pi can and it is waking hours", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(org({ adminChannelMode: "admin-group", adminGroupId: GROUP }));
    const channel = (await loadAdminChannel(ORG))!;
    expect(adminGroupJobInstruction(job, channel, { adminGroup: true }, NOON)).toEqual({
      kind: "admin-group-message",
      key: "botjob-job1",
      groupId: GROUP,
      text: "hello admins",
    });
  });

  it("holds it overnight", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(org({ adminChannelMode: "admin-group", adminGroupId: GROUP }));
    const channel = (await loadAdminChannel(ORG))!;
    expect(adminGroupJobInstruction(job, channel, { adminGroup: true }, NIGHT)).toBeNull();
  });

  it("falls back to the owner by DM without the capability, or once the group is unlinked", async () => {
    for (const over of [{ adminChannelMode: "admin-group", adminGroupId: GROUP }, { adminChannelMode: "one-person" }]) {
      dbMock.organisation.findUnique.mockResolvedValue(org(over));
      const channel = (await loadAdminChannel(ORG))!;
      expect(adminGroupJobInstruction(job, channel, { adminGroup: false }, NIGHT)).toEqual({
        kind: "dm",
        key: "botjob-job1",
        phone: "447700900101",
        text: "hello admins",
        targetUser: "u-owner",
      });
    }
  });
});

describe("the settings page: saveAdminChannelChoice and loadAdminChannelStatus", () => {
  beforeEach(() => {
    (dbMock.organisation as Record<string, unknown>).updateMany = vi.fn().mockResolvedValue({ count: 1 });
  });
  const updates = () => (dbMock.organisation as unknown as { updateMany: ReturnType<typeof vi.fn> }).updateMany.mock.calls.map((c) => c[0].data);

  it("admin-group only takes effect once a group is linked", async () => {
    const { saveAdminChannelChoice } = await import("../admin-channel");
    dbMock.organisation.findUnique.mockResolvedValue({ adminGroupId: null });
    expect(await saveAdminChannelChoice(ORG, "admin-group", null)).toEqual({ ok: false, reason: "needs-link" });
    expect(updates()).toEqual([]);
    dbMock.organisation.findUnique.mockResolvedValue({ adminGroupId: GROUP });
    expect(await saveAdminChannelChoice(ORG, "admin-group", null)).toEqual({ ok: true });
    expect(updates()).toEqual([{ adminChannelMode: "admin-group" }]);
  });

  it("one person must be an owner or admin with a phone; null is the owner", async () => {
    const { saveAdminChannelChoice } = await import("../admin-channel");
    expect(await saveAdminChannelChoice(ORG, "one-person", "u-nophone")).toEqual({ ok: false, reason: "not-an-admin-with-phone" });
    expect(await saveAdminChannelChoice(ORG, "one-person", "u-player")).toEqual({ ok: false, reason: "not-an-admin-with-phone" });
    expect(await saveAdminChannelChoice(ORG, "one-person", "u-wasim")).toEqual({ ok: true });
    expect(await saveAdminChannelChoice(ORG, "one-person", null)).toEqual({ ok: true });
    expect(await saveAdminChannelChoice(ORG, "each-admin", "u-wasim")).toEqual({ ok: true });
    expect(updates()).toEqual([
      { adminChannelMode: "one-person", adminChannelUserId: "u-wasim" },
      { adminChannelMode: "one-person", adminChannelUserId: null },
      { adminChannelMode: "each-admin", adminChannelUserId: null },
    ]);
    expect(await saveAdminChannelChoice(ORG, "everyone", null)).toEqual({ ok: false, reason: "bad-mode" });
  });

  it("the status shows the linked group, a live code only, and the people who can be chosen", async () => {
    const { loadAdminChannelStatus } = await import("../admin-channel");
    dbMock.organisation.findUnique.mockResolvedValue({
      adminChannelMode: "admin-group",
      adminChannelUserId: null,
      adminGroupId: GROUP,
      adminGroupSubject: "FNF HQ",
      adminGroupLinkedAt: NOON,
      adminGroupLinkCode: "K7P3QX",
      adminGroupLinkCodeExpiresAt: new Date(NOON.getTime() - 1),
    });
    const s = await loadAdminChannelStatus(ORG, NOON);
    expect(s).toEqual({
      mode: "admin-group",
      channelUserId: null,
      adminGroup: { subject: "FNF HQ", linkedAt: NOON.toISOString() },
      code: null,
      people: [
        { id: "u-owner", name: "Hamzah", role: "OWNER" },
        { id: "u-raihan", name: "Raihan", role: "ADMIN" },
        { id: "u-wasim", name: "Wasim", role: "ADMIN" },
      ],
    });
  });
});
