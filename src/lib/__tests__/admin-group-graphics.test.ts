/**
 * The list poster and the team sheet in a club's admin group (2026-10-14):
 * the answer to a request the shared router read (its `poster` and
 * `team_sheet` routes, since 2026-10-16), and `sendGraphicToAdminChannel`, the one function the
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
const data = vi.hoisted(() => ({ loadGraphicData: vi.fn(), nextGraphicMatch: vi.fn() }));
vi.mock("@/lib/match-graphics", () => data);
const postable = vi.hoisted(() => ({ isGroupPostable: vi.fn() }));
vi.mock("@/lib/group-postability-store", () => postable);

import { answerGraphicRequest, sendGraphicToAdminChannel } from "../admin-group-graphics";

const HQ = "120363777000000001@g.us";
const NOW = new Date("2026-10-14T12:00:00Z");
// Fri 16 Oct 2026, 21:00 London.
const DATE = new Date("2026-10-16T20:00:00Z");

const listData = { kind: "list", clubName: "FNF", lang: "en", matchDate: DATE, kickoff: "21:00", venue: "V", players: ["A"], reserves: [] };
const teamData = { kind: "teams", clubName: "FNF", lang: "en", matchDate: DATE, kickoff: "21:00", venue: "V", teams: [{ label: "Red", names: ["A"] }, { label: "Yellow", names: ["B"] }] };


beforeEach(() => {
  vi.clearAllMocks();
  dbMock.organisation.findUnique.mockResolvedValue({ id: "org-fnf", name: "FNF", language: "en", adminGroupId: HQ });
  dbMock.membership.findFirst.mockResolvedValue({ userId: "u-admin" });
  dbMock.sentNotification.create.mockResolvedValue({});
  dbMock.botJob.create.mockResolvedValue({ id: "job-1" });
  data.nextGraphicMatch.mockResolvedValue("m-1");
  data.loadGraphicData.mockImplementation(async (t: { kind: string }) => (t.kind === "list" ? listData : teamData));
  postable.isGroupPostable.mockResolvedValue(true);
});

describe("answerGraphicRequest (the router's poster and team_sheet routes)", () => {
  const ask = (kind: "list" | "teams", lang = "en") => answerGraphicRequest({ orgId: "org-fnf", lang, kind, now: NOW });

  it("the list poster for the next match is queued for the admin group; no text reply", async () => {
    expect(await ask("list")).toEqual({ outcome: "graphic-queued", replyText: null });
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

  it("the team sheet at a Turkish club: Turkish caption", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ id: "org-tr", name: "Erdal FC", language: "tr", adminGroupId: HQ });
    expect(await ask("teams", "tr")).toEqual({ outcome: "graphic-queued", replyText: null });
    expect(dbMock.botJob.create.mock.calls[0][0].data).toMatchObject({
      text: "Paylaşıma hazır: Erdal FC takımları, 16 Ekim Cuma",
      pollOptions: ["graphic:v1", "teams", "m-1", "asked"],
    });
  });

  it("asked again after approval: sent again (no once-key on a request)", async () => {
    await ask("teams");
    await ask("teams");
    expect(dbMock.botJob.create).toHaveBeenCalledTimes(2);
    expect(dbMock.sentNotification.create).not.toHaveBeenCalled();
  });

  it("the team sheet with no teams yet: 'No teams yet.' / 'Henüz takım yok.', nothing queued", async () => {
    data.loadGraphicData.mockResolvedValue(null);
    expect(await ask("teams")).toEqual({ outcome: "graphic-no-teams", replyText: "No teams yet." });
    expect(await ask("teams", "tr")).toMatchObject({ replyText: "Henüz takım yok." });
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });

  it("no upcoming match: says so, in the club's language", async () => {
    data.nextGraphicMatch.mockResolvedValue(null);
    expect(await ask("list")).toEqual({ outcome: "graphic-no-match", replyText: "No upcoming match to make that for." });
    expect(await ask("list", "tr")).toMatchObject({ replyText: "Bunun için yaklaşan maç yok." });
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
