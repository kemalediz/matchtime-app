/**
 * A linked admin group MatchTime cannot post in (2026-10-14): admin notices
 * fall back to the club's one person by DM instead of vanishing into a
 * group where nobody would see them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  organisation: { findUnique: vi.fn() },
  membership: { findMany: vi.fn() },
  botJob: { create: vi.fn() },
  groupPostState: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/admin-link", async () => {
  const actual = await vi.importActual<typeof import("../admin-link")>("../admin-link");
  return { ...actual, buildAdminLink: vi.fn(async (a: { userId: string }) => `https://mt.example/s/${a.userId}`) };
});

import { adminGroupJobInstruction, adminNoticeInstructions, loadAdminChannel, sendAdminNotice } from "../admin-channel";

const ORG = "org-fnf";
const ADMIN_GROUP = "120363900000000001@g.us";
const OWNER = { id: "u-owner", name: "Hamzah", phoneNumber: "+447700900101" };
const RAIHAN = { id: "u-raihan", name: "Raihan", phoneNumber: "+447700900102" };
const NOON = new Date("2026-10-14T11:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.organisation.findUnique.mockResolvedValue({
    id: ORG,
    name: "Friday FNF",
    language: "en",
    adminChannelMode: "admin-group",
    adminChannelUserId: null,
    adminGroupId: ADMIN_GROUP,
  });
  dbMock.membership.findMany.mockResolvedValue([
    { role: "OWNER", user: OWNER },
    { role: "ADMIN", user: RAIHAN },
  ]);
  dbMock.botJob.create.mockResolvedValue({});
});

const blocked = () => dbMock.groupPostState.findUnique.mockResolvedValue({ groupId: ADMIN_GROUP, canPost: false });
const postable = () => dbMock.groupPostState.findUnique.mockResolvedValue({ groupId: ADMIN_GROUP, canPost: true });

describe("sendAdminNotice with an admin group MatchTime cannot post in", () => {
  it("goes to the owner by DM, not to the group", async () => {
    blocked();
    const r = await sendAdminNotice({ orgId: ORG, holdOvernight: false, text: "A notice" });
    expect(r).toEqual({ channel: "dm", queued: 1 });
    expect(dbMock.botJob.create.mock.calls[0][0].data).toMatchObject({ kind: "dm", phone: "447700900101", text: "A notice" });
  });

  it("an admin group it CAN post in, or no reading at all: the group, as before", async () => {
    postable();
    expect((await sendAdminNotice({ orgId: ORG, holdOvernight: false, text: "A" })).channel).toBe("admin-group");
    dbMock.groupPostState.findUnique.mockResolvedValue(null);
    expect((await sendAdminNotice({ orgId: ORG, holdOvernight: false, text: "B" })).channel).toBe("admin-group");
    dbMock.groupPostState.findUnique.mockRejectedValue(new Error("no table"));
    expect((await sendAdminNotice({ orgId: ORG, holdOvernight: false, text: "C" })).channel).toBe("admin-group");
  });
});

describe("the scheduled and queued notices", () => {
  it("adminNoticeInstructions: the owner by DM while the admin group is blocked", async () => {
    blocked();
    const ch = (await loadAdminChannel(ORG))!;
    expect(ch.adminGroupPostable).toBe(false);
    const out = await adminNoticeInstructions({
      channel: ch,
      piCaps: { adminGroup: true },
      sentKeys: new Set(),
      now: NOON,
      key: (s) => `k:${s}`,
      notice: { text: "Review" },
    });
    expect(out).toEqual([expect.objectContaining({ kind: "dm", targetUser: "u-owner", key: "k:u-owner" })]);
  });

  it("adminGroupJobInstruction: a queued admin-group job goes to the owner by DM while blocked", async () => {
    blocked();
    const ch = (await loadAdminChannel(ORG))!;
    expect(adminGroupJobInstruction({ id: "j1", text: "T" }, ch, { adminGroup: true }, NOON)).toEqual({
      kind: "dm",
      key: "botjob-j1",
      phone: "447700900101",
      text: "T",
      targetUser: "u-owner",
    });
  });

  it("and to the group as before when it can post there", async () => {
    postable();
    const ch = (await loadAdminChannel(ORG))!;
    expect(adminGroupJobInstruction({ id: "j1", text: "T" }, ch, { adminGroup: true }, NOON)).toMatchObject({
      kind: "admin-group-message",
      groupId: ADMIN_GROUP,
    });
  });
});
