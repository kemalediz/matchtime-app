/**
 * "poster" and "team sheet" in a club's admin group (2026-10-14): the
 * deterministic command reader (English and Turkish, no model), the
 * owner/admin gate, and `sendGraphicToAdminChannel`, the one function the
 * final-list and approved-teams triggers will call later. Every
 * collaborator is mocked at its module boundary: no database, no model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  organisation: { findUnique: vi.fn() },
  membership: { findFirst: vi.fn() },
  sentNotification: { create: vi.fn() },
  botJob: { create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
const link = vi.hoisted(() => ({ resolveSenderUserIds: vi.fn() }));
vi.mock("@/lib/admin-group-link", () => link);
const data = vi.hoisted(() => ({ loadGraphicData: vi.fn(), nextGraphicMatch: vi.fn() }));
vi.mock("@/lib/match-graphics", () => data);
const postable = vi.hoisted(() => ({ isGroupPostable: vi.fn() }));
vi.mock("@/lib/group-postability-store", () => postable);

import { handleAdminGraphicsCommand, parseGraphicsCommand, sendGraphicToAdminChannel } from "../admin-group-graphics";

const HQ = "120363777000000001@g.us";
const NOW = new Date("2026-10-14T12:00:00Z");
// Fri 16 Oct 2026, 21:00 London.
const DATE = new Date("2026-10-16T20:00:00Z");
const LIVE = { id: "org-fnf", language: "en", whatsappBotEnabled: true };

const listData = { kind: "list", clubName: "FNF", lang: "en", matchDate: DATE, kickoff: "21:00", venue: "V", players: ["A"], reserves: [] };
const teamData = { kind: "teams", clubName: "FNF", lang: "en", matchDate: DATE, kickoff: "21:00", venue: "V", teams: [{ label: "Red", names: ["A"] }, { label: "Yellow", names: ["B"] }] };

const msg = (text: string, over: Record<string, unknown> = {}) => ({
  groupId: HQ,
  messageId: "wa-1",
  text,
  senderPhone: "447700900001",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.organisation.findUnique.mockResolvedValue({ id: "org-fnf", name: "FNF", language: "en", adminGroupId: HQ });
  dbMock.membership.findFirst.mockResolvedValue({ userId: "u-admin" });
  dbMock.sentNotification.create.mockResolvedValue({});
  dbMock.botJob.create.mockResolvedValue({ id: "job-1" });
  link.resolveSenderUserIds.mockResolvedValue(["u-admin"]);
  data.nextGraphicMatch.mockResolvedValue("m-1");
  data.loadGraphicData.mockImplementation(async (t: { kind: string }) => (t.kind === "list" ? listData : teamData));
  postable.isGroupPostable.mockResolvedValue(true);
});

describe("parseGraphicsCommand: English", () => {
  it.each(["poster", "Poster", "list poster", "LIST POSTER!", "squad poster", "  poster.  "])("%s is the list poster", (t) => {
    expect(parseGraphicsCommand(t)).toBe("list");
  });
  it.each(["teams poster", "team poster", "team sheet", "Team Sheet", "teamsheet", "TEAMS POSTER?"])("%s is the team sheet", (t) => {
    expect(parseGraphicsCommand(t)).toBe("teams");
  });
});

describe("parseGraphicsCommand: Turkish", () => {
  it.each(["liste", "Liste.", "LİSTE", "liste posteri", "kadro posteri"])("%s is the list poster", (t) => {
    expect(parseGraphicsCommand(t)).toBe("list");
  });
  it.each(["takım listesi", "TAKIM LİSTESİ", "takim listesi", "Takım listesi!", "takımlar posteri"])("%s is the team sheet", (t) => {
    expect(parseGraphicsCommand(t)).toBe("teams");
  });
});

describe("parseGraphicsCommand: addressed to MatchTime", () => {
  it("a tag or the name in front is fine", () => {
    expect(parseGraphicsCommand("@Match Time poster")).toBe("list");
    expect(parseGraphicsCommand("@447700900999 team sheet")).toBe("teams");
    expect(parseGraphicsCommand("@158055467598020 takım listesi")).toBe("teams");
    expect(parseGraphicsCommand("MatchTime, liste")).toBe("list");
  });
});

describe("parseGraphicsCommand: only the whole message", () => {
  it.each([
    "the list is ready",
    "poster please send it to the group",
    "liste nerede",
    "Shehryar out",
    "YES",
    "",
    "teams",
    "posters",
    "1. Ali\n2. Veli",
    "list",
  ])("%j is not a command", (t) => {
    expect(parseGraphicsCommand(t)).toBeNull();
  });
});

describe("handleAdminGraphicsCommand", () => {
  it("not a command: null, and nothing is read", async () => {
    expect(await handleAdminGraphicsCommand({ org: LIVE, msg: msg("Shehryar out"), now: NOW })).toBeNull();
    expect(link.resolveSenderUserIds).not.toHaveBeenCalled();
    expect(dbMock.membership.findFirst).not.toHaveBeenCalled();
  });

  it("a club that is not live: null (the group stays the admins' own)", async () => {
    expect(await handleAdminGraphicsCommand({ org: { ...LIVE, whatsappBotEnabled: false }, msg: msg("poster"), now: NOW })).toBeNull();
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });

  it("a non-admin: null, nothing queued, the sender found by phone or stored LID", async () => {
    dbMock.membership.findFirst.mockResolvedValue(null);
    expect(await handleAdminGraphicsCommand({ org: LIVE, msg: msg("poster", { senderLid: "9@lid", senderAltPhone: "447700900002" }), now: NOW })).toBeNull();
    expect(link.resolveSenderUserIds).toHaveBeenCalledWith({ phones: ["447700900001", "447700900002"], lid: "9@lid" });
    expect(dbMock.membership.findFirst.mock.calls[0][0].where).toEqual({
      orgId: "org-fnf",
      userId: { in: ["u-admin"] },
      leftAt: null,
      role: { in: ["OWNER", "ADMIN"] },
    });
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });

  it("an admin's 'poster': the list poster for the next match is queued for the admin group; no text reply", async () => {
    const r = await handleAdminGraphicsCommand({ org: LIVE, msg: msg("poster"), now: NOW });
    expect(r).toEqual({ handled: true, orgId: "org-fnf", outcome: "graphic-queued", replyText: null });
    expect(dbMock.sentNotification.create).toHaveBeenCalledWith({ data: { key: "admin-group-msg:wa-1", kind: "admin-notice" } });
    expect(data.nextGraphicMatch).toHaveBeenCalledWith("org-fnf", NOW);
    expect(dbMock.botJob.create).toHaveBeenCalledWith({
      data: {
        orgId: "org-fnf",
        kind: "admin-group",
        text: "Ready to post: FNF list for Fri 16 Oct",
        pollOptions: ["graphic:v1", "list", "m-1", "asked"],
      },
    });
  });

  it("an admin's 'takım listesi' at a Turkish club: the team sheet, Turkish caption", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ id: "org-tr", name: "Erdal FC", language: "tr", adminGroupId: HQ });
    const r = await handleAdminGraphicsCommand({ org: { ...LIVE, id: "org-tr", language: "tr" }, msg: msg("takım listesi"), now: NOW });
    expect(r).toMatchObject({ handled: true, outcome: "graphic-queued" });
    expect(dbMock.botJob.create.mock.calls[0][0].data).toMatchObject({
      text: "Paylaşıma hazır: Erdal FC takımları, 16 Ekim Cuma",
      pollOptions: ["graphic:v1", "teams", "m-1", "asked"],
    });
  });

  it("'team sheet' with no teams yet: 'No teams yet.' / 'Henüz takım yok.', nothing queued", async () => {
    data.loadGraphicData.mockResolvedValue(null);
    expect(await handleAdminGraphicsCommand({ org: LIVE, msg: msg("team sheet"), now: NOW })).toEqual({
      handled: true,
      orgId: "org-fnf",
      outcome: "graphic-no-teams",
      replyText: "No teams yet.",
    });
    dbMock.organisation.findUnique.mockResolvedValue({ id: "org-tr", name: "X", language: "tr", adminGroupId: HQ });
    expect(await handleAdminGraphicsCommand({ org: { ...LIVE, language: "tr" }, msg: msg("takım listesi", { messageId: "wa-2" }), now: NOW })).toMatchObject({
      replyText: "Henüz takım yok.",
    });
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });

  it("no upcoming match: says so, in the club's language", async () => {
    data.nextGraphicMatch.mockResolvedValue(null);
    expect(await handleAdminGraphicsCommand({ org: LIVE, msg: msg("poster"), now: NOW })).toMatchObject({
      handled: true,
      outcome: "graphic-no-match",
      replyText: "No upcoming match to make that for.",
    });
    expect(await handleAdminGraphicsCommand({ org: { ...LIVE, language: "tr" }, msg: msg("liste", { messageId: "wa-3" }), now: NOW })).toMatchObject({
      replyText: "Bunun için yaklaşan maç yok.",
    });
  });

  it("a Pi retry of the same message: a duplicate, nothing queued twice", async () => {
    dbMock.sentNotification.create.mockRejectedValue(new Error("P2002"));
    expect(await handleAdminGraphicsCommand({ org: LIVE, msg: msg("poster"), now: NOW })).toEqual({
      handled: false,
      ignored: "duplicate",
      orgId: "org-fnf",
      replyText: null,
    });
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });
});

describe("sendGraphicToAdminChannel (for the final-list and approved-teams triggers)", () => {
  it("queues a trigger's graphic: waits for posting hours ('auto')", async () => {
    expect(await sendGraphicToAdminChannel("org-fnf", "m-1", "teams")).toEqual({ queued: true, jobId: "job-1" });
    expect(dbMock.botJob.create).toHaveBeenCalledWith({
      data: { orgId: "org-fnf", kind: "admin-group", text: "Ready to post: FNF teams for Fri 16 Oct", pollOptions: ["graphic:v1", "teams", "m-1", "auto"] },
    });
  });

  it("only for a club with a linked admin group", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ id: "org-fnf", name: "FNF", language: "en", adminGroupId: null });
    expect(await sendGraphicToAdminChannel("org-fnf", "m-1", "list")).toEqual({ queued: false, reason: "no-admin-group" });
    dbMock.organisation.findUnique.mockResolvedValue(null);
    expect(await sendGraphicToAdminChannel("org-x", "m-1", "list")).toEqual({ queued: false, reason: "no-admin-group" });
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });

  it("not into a group where MatchTime cannot post", async () => {
    postable.isGroupPostable.mockResolvedValue(false);
    expect(await sendGraphicToAdminChannel("org-fnf", "m-1", "list")).toEqual({ queued: false, reason: "not-postable" });
  });

  it("a match that is not this club's, or teams not made yet: nothing queued", async () => {
    data.loadGraphicData.mockResolvedValue(null);
    expect(await sendGraphicToAdminChannel("org-fnf", "m-other", "list")).toEqual({ queued: false, reason: "no-match" });
    expect(await sendGraphicToAdminChannel("org-fnf", "m-1", "teams")).toEqual({ queued: false, reason: "no-teams" });
    expect(data.loadGraphicData).toHaveBeenCalledWith({ orgId: "org-fnf", matchId: "m-other", kind: "list" });
  });

  it("once per key when the caller gives one, so a re-run trigger never posts twice", async () => {
    expect(await sendGraphicToAdminChannel("org-fnf", "m-1", "list", { onceKey: "m-1:final-list" })).toEqual({ queued: true, jobId: "job-1" });
    expect(dbMock.sentNotification.create).toHaveBeenCalledWith({ data: { key: "graphic:m-1:final-list", kind: "admin-notice" } });
    dbMock.sentNotification.create.mockRejectedValue(new Error("P2002"));
    expect(await sendGraphicToAdminChannel("org-fnf", "m-1", "list", { onceKey: "m-1:final-list" })).toEqual({ queued: false, reason: "already-sent" });
    expect(dbMock.botJob.create).toHaveBeenCalledTimes(1);
  });
});
