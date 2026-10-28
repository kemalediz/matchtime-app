/**
 * An admin-group notice that carries its own DM wording (2026-10-28,
 * review of #430): when the post cannot go to the admin group at dispatch
 * (an older Pi, unlinked since, MatchTime cannot post there) it falls back
 * to the owner by DM, and the DM then reads as a DM, not as a group post
 * ("ask me here" would be wrong). Opt in per notice (`dmWording`); every
 * other notice's fallback is unchanged. A caller may also queue the jobs
 * inside its own transaction (`client`), so a once-ever claim and the
 * notice commit together.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  organisation: { findUnique: vi.fn() },
  membership: { findMany: vi.fn() },
  botJob: { create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/group-postability-store", () => ({ isGroupPostable: vi.fn(async () => true) }));

import { adminGroupJobInstruction, loadAdminChannel, sendAdminNotice } from "../admin-channel";

const ORG = "org-fnf";
const GROUP = "120363900000000001@g.us";
const OWNER = { id: "u-owner", name: "Hamzah", phoneNumber: "+447700900101" };
const RAIHAN = { id: "u-raihan", name: "Raihan", phoneNumber: "+447700900102" };
const NOON = new Date("2026-09-30T11:00:00Z");
const text = (_link: string, audience: "dm" | "group") => (audience === "group" ? "ask me here" : "ask me in your group");

function org(over: Record<string, unknown> = {}) {
  dbMock.organisation.findUnique.mockResolvedValue({ id: ORG, name: "FNF", language: "en", adminChannelMode: "admin-group", adminChannelUserId: null, adminGroupId: GROUP, ...over });
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.membership.findMany.mockResolvedValue([
    { role: "OWNER", user: OWNER },
    { role: "ADMIN", user: RAIHAN },
  ]);
  dbMock.botJob.create.mockImplementation(async ({ data }) => ({ id: "j1", ...data }));
});

describe("dmWording", () => {
  it("the admin-group job carries the DM wording; posted in the group it uses the group wording", async () => {
    org();
    await sendAdminNotice({ orgId: ORG, now: NOON, text, dmWording: true });
    const data = dbMock.botJob.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ kind: "admin-group", text: "ask me here" });
    const ch = (await loadAdminChannel(ORG))!;
    expect(adminGroupJobInstruction({ id: "j1", text: data.text, pollOptions: data.pollOptions }, ch, { adminGroup: true }, NOON)).toMatchObject({
      kind: "admin-group-message",
      text: "ask me here",
    });
  });

  it("falling back to the owner by DM at dispatch, it uses the DM wording", async () => {
    org();
    await sendAdminNotice({ orgId: ORG, now: NOON, text, dmWording: true });
    const data = dbMock.botJob.create.mock.calls[0][0].data;
    const ch = (await loadAdminChannel(ORG))!;
    expect(adminGroupJobInstruction({ id: "j1", text: data.text, pollOptions: data.pollOptions }, ch, { adminGroup: false }, NOON)).toMatchObject({
      kind: "dm",
      phone: "447700900101",
      text: "ask me in your group",
    });
  });

  it("without it, the fallback DM is the group text as before", async () => {
    org();
    await sendAdminNotice({ orgId: ORG, now: NOON, text });
    const data = dbMock.botJob.create.mock.calls[0][0].data;
    expect(data.pollOptions ?? []).toEqual([]);
    const ch = (await loadAdminChannel(ORG))!;
    expect(adminGroupJobInstruction({ id: "j1", text: data.text, pollOptions: data.pollOptions }, ch, { adminGroup: false }, NOON)).toMatchObject({ kind: "dm", text: "ask me here" });
  });

  it("one-person mode goes to the chosen admin only, with the DM wording", async () => {
    org({ adminChannelMode: "one-person", adminChannelUserId: RAIHAN.id, adminGroupId: null });
    const r = await sendAdminNotice({ orgId: ORG, now: NOON, text, dmWording: true });
    expect(r).toMatchObject({ channel: "dm", queued: 1 });
    expect(dbMock.botJob.create.mock.calls.map((c) => c[0].data)).toEqual([expect.objectContaining({ kind: "dm", phone: "447700900102", text: "ask me in your group" })]);
  });
});

describe("client", () => {
  it("queues through the caller's transaction client, never the global db", async () => {
    org();
    const tx = { botJob: { create: vi.fn(async () => ({})) } };
    await sendAdminNotice({ orgId: ORG, now: NOON, text, client: tx });
    expect(tx.botJob.create).toHaveBeenCalledTimes(1);
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });
});
