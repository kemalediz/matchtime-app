/**
 * A queued graphic (list poster, team sheet) at emit time, in
 * `adminGroupJobInstruction` (2026-10-14). Unlike a text notice it goes to
 * the club's LINKED ADMIN GROUP whatever the channel mode (it is a picture
 * for the admins to forward, and the group is where they forward from),
 * with a freshly signed image URL. Asked for by an admin: at once, at any
 * hour. Queued by a trigger: inside the admin group's posting hours. With
 * no group to post in, the owner gets the caption and a day-long link.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  organisation: { findUnique: vi.fn() },
  membership: { findMany: vi.fn() },
  botJob: { create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { adminGroupJobInstruction, loadAdminChannel } from "../admin-channel";
import { graphicJobOptions } from "../graphic-job";
import { verifyGraphicToken } from "../graphic-token";

const ORG = "org-fnf";
const GROUP = "120363900000000001@g.us";
const OWNER = { id: "u-owner", name: "Hamzah", phoneNumber: "+447700900101" };
const RAIHAN = { id: "u-raihan", name: "Raihan", phoneNumber: "+447700900102" };

const NOON = new Date("2026-09-30T11:00:00Z");
const NIGHT = new Date("2026-09-30T22:30:00Z");

let saved: Record<string, string | undefined>;
beforeEach(() => {
  vi.clearAllMocks();
  saved = { AUTH_SECRET: process.env.AUTH_SECRET, NEXTAUTH_URL: process.env.NEXTAUTH_URL };
  process.env.AUTH_SECRET = "unit-graphic-secret";
  process.env.NEXTAUTH_URL = "https://mt.example";
  dbMock.membership.findMany.mockResolvedValue([
    { role: "OWNER", user: OWNER },
    { role: "ADMIN", user: RAIHAN },
  ]);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function channel(over: Record<string, unknown>) {
  dbMock.organisation.findUnique.mockResolvedValue({
    id: ORG,
    name: "FNF",
    language: "en",
    adminChannelMode: "each-admin",
    adminChannelUserId: null,
    adminGroupId: GROUP,
    ...over,
  });
  return (await loadAdminChannel(ORG))!;
}

const job = (asked: boolean, kind: "list" | "teams" = "list") => ({
  id: "job9",
  text: "Ready to post: FNF list for Fri 16 Oct",
  pollOptions: graphicJobOptions({ kind, matchId: "m-1", asked }),
});

const tokenOf = (url: unknown) => verifyGraphicToken(String(url).split("/").pop()!);

describe("a graphic job", () => {
  it("posts in the linked admin group with the caption and a signed image URL, even when notices go by DM", async () => {
    const ch = await channel({ adminChannelMode: "each-admin" });
    const instr = adminGroupJobInstruction(job(true), ch, { adminGroup: true }, NOON);
    expect(instr).toMatchObject({
      kind: "admin-group-message",
      key: "botjob-job9",
      groupId: GROUP,
      matchId: "m-1",
      text: "Ready to post: FNF list for Fri 16 Oct",
    });
    const url = (instr as { imageUrl?: string }).imageUrl;
    expect(url).toMatch(/^https:\/\/mt\.example\/api\/graphics\//);
    expect(tokenOf(url)).toEqual({ orgId: ORG, matchId: "m-1", kind: "list" });
  });

  it("asked for by an admin: goes at once, even at night", async () => {
    const ch = await channel({ adminChannelMode: "admin-group" });
    expect(adminGroupJobInstruction(job(true, "teams"), ch, { adminGroup: true }, NIGHT)).toMatchObject({ kind: "admin-group-message" });
  });

  it("queued by a trigger: waits for the admin group's posting hours", async () => {
    const ch = await channel({ adminChannelMode: "admin-group" });
    expect(adminGroupJobInstruction(job(false), ch, { adminGroup: true }, NIGHT)).toBeNull();
    expect(adminGroupJobInstruction(job(false), ch, { adminGroup: true }, NOON)).toMatchObject({ kind: "admin-group-message" });
  });

  it("no group to post in (an old Pi, or unlinked since): the owner by DM, the caption and a day-long link, in the club's language", async () => {
    for (const [over, caps] of [
      [{ adminChannelMode: "admin-group" }, { adminGroup: false }],
      [{ adminGroupId: null }, { adminGroup: true }],
    ] as const) {
      const ch = await channel({ ...over });
      const instr = adminGroupJobInstruction(job(true), ch, caps, NOON) as { kind: string; phone: string; text: string; targetUser: string };
      expect(instr).toMatchObject({ kind: "dm", key: "botjob-job9", phone: "447700900101", targetUser: "u-owner" });
      expect(instr.text.split("\n")[0]).toBe("Ready to post: FNF list for Fri 16 Oct");
      expect(instr.text).toContain("could not go to the admin group");
      const url = instr.text.split("\n").pop();
      expect(tokenOf(url)).toEqual({ orgId: ORG, matchId: "m-1", kind: "list" });
    }
    const tr = await channel({ adminGroupId: null, language: "tr" });
    const trText = (adminGroupJobInstruction(job(true), tr, { adminGroup: true }, NOON) as { text: string }).text;
    expect(trText).toContain("Resim yönetici grubuna gönderilemedi");
  });

  it("the group is known to refuse MatchTime's posts: the owner by DM", async () => {
    const ch = { ...(await channel({ adminChannelMode: "admin-group" })), adminGroupPostable: false };
    expect(adminGroupJobInstruction(job(true), ch, { adminGroup: true }, NOON)).toMatchObject({ kind: "dm", targetUser: "u-owner" });
  });

  it("an ordinary admin-group job is unchanged: no image URL", async () => {
    const ch = await channel({ adminChannelMode: "admin-group" });
    expect(adminGroupJobInstruction({ id: "j1", text: "hello admins", pollOptions: [] }, ch, { adminGroup: true }, NOON)).toEqual({
      kind: "admin-group-message",
      key: "botjob-j1",
      groupId: GROUP,
      text: "hello admins",
    });
  });
});
