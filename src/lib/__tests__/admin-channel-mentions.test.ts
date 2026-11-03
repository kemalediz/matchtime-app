/**
 * A queued HQ post that TAGS someone (2026-11-03): a BotJob of kind
 * "admin-group" with `mentions` (phones without the +). Posted in the
 * admin group, the instruction carries the mentions, so the Pi sends a
 * real WhatsApp tag (notification, clickable). Falling back to the owner
 * by DM, a tag would reach nobody (the tagged person is not in that chat),
 * so the mentions are dropped and each inline "@<phone>" is written as the
 * person's name when they are one of the club's admins, else "+<phone>":
 * the DM still reads.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  organisation: { findUnique: vi.fn() },
  membership: { findMany: vi.fn() },
  botJob: { create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/group-postability-store", () => ({ isGroupPostable: vi.fn(async () => true) }));

import { adminGroupJobInstruction, loadAdminChannel } from "../admin-channel";

const ORG = "org-fnf";
const GROUP = "120363900000000001@g.us";
const OWNER = { id: "u-owner", name: "Hamzah", phoneNumber: "+447700900101" };
const RAIHAN = { id: "u-raihan", name: "Raihan", phoneNumber: "+447961809174" };
const NOON = new Date("2026-09-30T11:00:00Z");
const TEXT = "@447961809174 can you confirm the pitch for Friday?";

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.organisation.findUnique.mockResolvedValue({
    id: ORG,
    name: "FNF",
    language: "en",
    adminChannelMode: "admin-group",
    adminChannelUserId: null,
    adminGroupId: GROUP,
  });
  dbMock.membership.findMany.mockResolvedValue([
    { role: "OWNER", user: OWNER },
    { role: "ADMIN", user: RAIHAN },
  ]);
});

const channel = async () => (await loadAdminChannel(ORG))!;

describe("admin-group BotJob with mentions", () => {
  it("posted in the admin group, the instruction carries the mentions and the text as written", async () => {
    const instr = adminGroupJobInstruction({ id: "j1", text: TEXT, mentions: ["447961809174"] }, await channel(), { adminGroup: true }, NOON);
    expect(instr).toEqual({ kind: "admin-group-message", key: "botjob-j1", groupId: GROUP, text: TEXT, mentions: ["447961809174"] });
  });

  it("with no mentions the instruction has no mentions field: exactly today's shape", async () => {
    const ch = await channel();
    for (const mentions of [undefined, null, []]) {
      const instr = adminGroupJobInstruction({ id: "j1", text: "hi", mentions }, ch, { adminGroup: true }, NOON);
      expect(instr).toEqual({ kind: "admin-group-message", key: "botjob-j1", groupId: GROUP, text: "hi" });
    }
  });

  it("falling back to the owner by DM, the mentions are dropped and an admin's @phone reads as their name", async () => {
    const instr = adminGroupJobInstruction({ id: "j1", text: TEXT, mentions: ["447961809174"] }, await channel(), { adminGroup: false }, NOON);
    expect(instr).toEqual({
      kind: "dm",
      key: "botjob-j1",
      phone: "447700900101",
      text: "Raihan can you confirm the pitch for Friday?",
      targetUser: OWNER.id,
    });
  });

  it("a tagged phone that is no admin of the club reads as +<phone> in the DM", async () => {
    const instr = adminGroupJobInstruction(
      { id: "j1", text: "@447700900555 and @447961809174, over to you", mentions: ["447700900555", "447961809174"] },
      await channel(),
      { adminGroup: false },
      NOON,
    );
    expect(instr).toMatchObject({ kind: "dm", text: "+447700900555 and Raihan, over to you" });
    expect(instr).not.toHaveProperty("mentions");
  });

  it("only the tagged phones are rewritten: another @ in the text stays as written", async () => {
    const instr = adminGroupJobInstruction(
      { id: "j1", text: "@447961809174 mail ops@fnf.test or ring @447700900999", mentions: ["447961809174"] },
      await channel(),
      { adminGroup: false },
      NOON,
    );
    expect(instr).toMatchObject({ kind: "dm", text: "Raihan mail ops@fnf.test or ring @447700900999" });
  });

  it("a notice's own DM wording is used as written in the fallback", async () => {
    const instr = adminGroupJobInstruction(
      { id: "j1", text: TEXT, mentions: ["447961809174"], pollOptions: ["admin-dm-text:v1", "Ask Raihan to confirm the pitch"] },
      await channel(),
      { adminGroup: false },
      NOON,
    );
    expect(instr).toMatchObject({ kind: "dm", text: "Ask Raihan to confirm the pitch" });
  });
});
