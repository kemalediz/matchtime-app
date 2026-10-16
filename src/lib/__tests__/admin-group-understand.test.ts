/**
 * An organiser's message in the admin group, read by the SHARED pipeline
 * (2026-10-16): the real gate, router parser and teams extractor parser,
 * with a STUBBED model behind each (it says what the model would have
 * said). Every owner behind a route is mocked at its module boundary; what
 * is under test is the routing, the context the router is shown, and the
 * safe-YES rule wired to real proposals. No database, no real model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRequest, PipelineModel } from "../pipeline/llm";
import type { HqLogRow } from "../admin-group-log";

const dbMock = vi.hoisted(() => ({
  adminTeamProposal: { findFirst: vi.fn() },
  adminSquadProposal: { findFirst: vi.fn() },
  match: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
const hqLog = vi.hoisted(() => ({
  hqLogSince: vi.fn(),
  recordMatchTimeQuestion: vi.fn(),
  teamsAskRef: (id: string) => `teams:${id}`,
  listAskRef: (id: string) => `list:${id}`,
}));
vi.mock("@/lib/admin-group-log", () => hqLog);
vi.mock("@/lib/ai-budget", () => ({
  withOrgAiBudget: (_k: string, fn: () => Promise<unknown>) => fn(),
  getAiBudgetStatus: vi.fn(async () => ({ capped: false })),
}));
const squad = vi.hoisted(() => ({ handleAdminSquadChange: vi.fn(), nameMentions: vi.fn(async (_o: string, text: string) => text) }));
vi.mock("@/lib/admin-group-squad-change", () => squad);
const teams = vi.hoisted(() => ({ answerTeamsYes: vi.fn(), handleTeamCommand: vi.fn() }));
vi.mock("@/lib/team-proposal", () => teams);
const paste = vi.hoisted(() => ({ answerSquadPasteYes: vi.fn() }));
vi.mock("@/lib/admin-group-paste", () => paste);
const graphics = vi.hoisted(() => ({ answerGraphicRequest: vi.fn() }));
vi.mock("@/lib/admin-group-graphics", () => graphics);

import { understandAdminMessage } from "../admin-group-understand";

const NOW = new Date("2026-10-16T09:10:00Z");
const ASKED = new Date("2026-10-16T09:00:00Z");
const ORG = { id: "org-fnf", language: "en", squadMode: "weekly", benchPickMode: null };
const TEAMS_TEXT = "📝 *Proposed teams*: 21:00 at Goals\n\n*Red*:\n1. Ali Khan";

const requests: ModelRequest[] = [];
function model(answer: (req: ModelRequest) => unknown): PipelineModel {
  return {
    name: "stub",
    async complete(req) {
      requests.push(req);
      return { text: JSON.stringify(answer(req)), stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 0 };
    },
  };
}
const routeTo = (route: string) => model(() => ({ routes: [{ id: "wa-9", route }] }));
const teamsFacts = (facts: Record<string, unknown>) =>
  model(() => ({ action: "swap", includeRefs: [], teamNames: [], swaps: [], moves: [], pairings: [], ...facts }));

const mtRow = (at: Date, askRef: string, text = TEAMS_TEXT): HqLogRow => ({ waMessageId: `mt:${askRef}:1`, fromMatchTime: true, senderUserId: null, text, askRef, createdAt: at });
const orgRow = (at: Date, text = "who has the bibs?"): HqLogRow => ({ waMessageId: `wa-${at.getTime()}`, fromMatchTime: false, senderUserId: "u-2", text, askRef: null, createdAt: at });

function ask(text: string, route: string, over: Partial<Parameters<typeof understandAdminMessage>[0]> = {}) {
  return understandAdminMessage({
    org: ORG,
    messageId: "wa-9",
    text,
    quoted: null,
    adminUserId: "u-admin",
    senderName: "Raihan",
    sentAt: null,
    now: NOW,
    deps: { routerModel: routeTo(route) },
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requests.length = 0;
  dbMock.adminTeamProposal.findFirst.mockResolvedValue({ matchId: "m1", askedAt: ASKED, state: "proposed" });
  dbMock.match.findUnique.mockResolvedValue({ date: new Date("2026-10-16T20:00:00Z"), status: "TEAMS_GENERATED" });
  dbMock.adminSquadProposal.findFirst.mockResolvedValue(null);
  hqLog.hqLogSince.mockResolvedValue([mtRow(ASKED, "teams:m1")]);
  teams.answerTeamsYes.mockResolvedValue({ outcome: "teams-final", replyText: "Teams are final." });
  teams.handleTeamCommand.mockResolvedValue({ outcome: "teams-swapped", replyText: "📝 *Proposed teams* ..." });
  paste.answerSquadPasteYes.mockResolvedValue({ outcome: "paste-applied", replyText: "Done." });
  graphics.answerGraphicRequest.mockResolvedValue({ outcome: "graphic-queued", replyText: null });
  squad.handleAdminSquadChange.mockResolvedValue({ handled: true, outcome: "squad-changed", replyText: "Done: Tom out." });
});

describe("the router is the players' group's router, shown the organisers' context", () => {
  it("the message goes under the organisers' header with what is waiting, the reply and recent chat", async () => {
    hqLog.hqLogSince.mockResolvedValue([mtRow(ASKED, "teams:m1"), orgRow(new Date("2026-10-16T09:05:00Z"))]);
    await ask("yes", "approve", { quoted: { text: "shall we start at 8?", fromMatchTime: false } });
    const user = requests[0].user;
    expect(user).toContain("ORGANISERS' GROUP. The sender is an organiser of the club.");
    expect(user).toContain("WAITING: approval of the proposed teams for Fri 16 Oct, asked at 10:00.");
    expect(user).toContain('REPLYING TO another organiser: "shall we start at 8?"');
    expect(user).toContain("- an organiser: who has the bibs?");
    expect(user).toContain("[wa-9] Raihan: yes");
    expect(requests[0].system).toContain("IN THE ORGANISERS' GROUP");
  });
});

describe("approve: the safe-YES rule", () => {
  it("the next message after the teams were proposed, within 15 minutes: the teams are final", async () => {
    expect(await ask("looks good, go", "approve")).toEqual({ route: "approve", outcome: "teams-final", replyText: "Teams are final." });
    expect(teams.answerTeamsYes).toHaveBeenCalledWith({ orgId: "org-fnf", lang: "en", messageId: "wa-9", senderUserId: "u-admin", now: NOW });
  });

  it("a quoted reply to the proposal: final, whatever was said in between", async () => {
    hqLog.hqLogSince.mockResolvedValue([mtRow(ASKED, "teams:m1"), orgRow(new Date("2026-10-16T09:05:00Z"))]);
    const r = await ask("YES", "approve", { quoted: { text: TEAMS_TEXT, fromMatchTime: true } });
    expect(r?.outcome).toBe("teams-final");
  });

  it("after other chat: asks once, in the club's words, and records the question", async () => {
    hqLog.hqLogSince.mockResolvedValue([mtRow(ASKED, "teams:m1"), orgRow(new Date("2026-10-16T09:05:00Z"))]);
    const r = await ask("yes", "approve");
    expect(r).toEqual({ route: "approve", outcome: "hq-confirm-asked", replyText: "Is that YES to the proposed teams for Fri 16 Oct?" });
    expect(teams.answerTeamsYes).not.toHaveBeenCalled();
    expect(hqLog.recordMatchTimeQuestion).toHaveBeenCalledWith({ orgId: "org-fnf", askRef: "teams:m1", text: r!.replyText, now: NOW, confirm: true });
  });

  it("in Turkish", async () => {
    hqLog.hqLogSince.mockResolvedValue([mtRow(ASKED, "teams:m1"), orgRow(new Date("2026-10-16T09:05:00Z"))]);
    const r = await ask("evet", "approve", { org: { ...ORG, language: "tr" } });
    expect(r?.replyText).toBe("Bu EVET, 16 Ekim Cuma için önerilen takımlara mı?");
  });

  it("a YES quoting another organiser: nothing", async () => {
    expect(await ask("yes", "approve", { quoted: { text: "shall we start at 8?", fromMatchTime: false } })).toBeNull();
    expect(teams.answerTeamsYes).not.toHaveBeenCalled();
  });

  it("a stale proposal (asked 3 hours ago): asks", async () => {
    hqLog.hqLogSince.mockResolvedValue([mtRow(new Date("2026-10-16T06:00:00Z"), "teams:m1")]);
    expect((await ask("yes", "approve"))?.outcome).toBe("hq-confirm-asked");
  });

  it("two items waiting: asks which", async () => {
    dbMock.adminSquadProposal.findFirst.mockResolvedValue({ waMessageId: "wa-paste", createdAt: new Date("2026-10-16T09:02:00Z") });
    hqLog.hqLogSince.mockResolvedValue([mtRow(ASKED, "teams:m1"), orgRow(new Date("2026-10-16T09:01:00Z")), mtRow(new Date("2026-10-16T09:02:00Z"), "list:wa-paste", "Reply YES to apply."), orgRow(new Date("2026-10-16T09:03:00Z"))]);
    const r = await ask("yes", "approve");
    expect(r?.replyText).toBe("Which one is that YES for: the proposed teams for Fri 16 Oct, or the pasted squad list? Reply YES to that message.");
  });

  it("the pasted list, as the last question: applied", async () => {
    dbMock.adminTeamProposal.findFirst.mockResolvedValue(null);
    dbMock.adminSquadProposal.findFirst.mockResolvedValue({ waMessageId: "wa-paste", createdAt: ASKED });
    hqLog.hqLogSince.mockResolvedValue([mtRow(ASKED, "list:wa-paste", "Adding: Bilal. Reply YES to apply.")]);
    expect((await ask("go ahead", "approve"))?.outcome).toBe("paste-applied");
  });

  it("teams for a game long over are not waiting", async () => {
    dbMock.match.findUnique.mockResolvedValue({ date: new Date("2026-10-15T20:00:00Z"), status: "TEAMS_GENERATED" });
    expect(await ask("yes", "approve")).toBeNull();
  });
});

describe("the other routes reach the code the rest of MatchTime uses", () => {
  it("poster and team_sheet: the graphics", async () => {
    await ask("can you do the poster for this week", "poster");
    expect(graphics.answerGraphicRequest).toHaveBeenCalledWith({ orgId: "org-fnf", lang: "en", kind: "list", now: NOW });
    await ask("send us the team sheet image", "team_sheet");
    expect(graphics.answerGraphicRequest).toHaveBeenLastCalledWith({ orgId: "org-fnf", lang: "en", kind: "teams", now: NOW });
  });

  it("help: the HQ list for this club", async () => {
    const r = await ask("what can you do?", "help");
    expect(r?.outcome).toBe("hq-help");
    expect(r?.replyText).toContain("*MatchTime in your admin group*");
  });

  it("balancer: the shared teams extractor, then the team change", async () => {
    const r = await ask("swap Ali and Can", "balancer", { deps: { routerModel: routeTo("balancer"), extractorModel: teamsFacts({ moves: ["Ali", "Can"] }) } });
    expect(r?.outcome).toBe("teams-swapped");
    expect(teams.handleTeamCommand).toHaveBeenCalledWith({
      orgId: "org-fnf",
      lang: "en",
      messageId: "wa-9",
      senderUserId: "u-admin",
      now: NOW,
      command: { kind: "swap", pairs: [["Ali", "Can"]] },
    });
    expect(requests[1].system).toContain("moves");
  });

  it("balancer with no players the extractor could name: says which it needs", async () => {
    const r = await ask("swap them", "balancer", { deps: { routerModel: routeTo("balancer"), extractorModel: teamsFacts({}) } });
    expect(r).toEqual({ route: "balancer", outcome: "teams-which-players", replyText: "Which players? For example: swap Sam and Alex, or move Sam to the other team." });
    expect(teams.handleTeamCommand).not.toHaveBeenCalled();
  });

  it("other_att: the attendance engine, with the route the shared router gave (no second router call)", async () => {
    const r = await ask("Tom is out tonight", "other_att");
    expect(r?.outcome).toBe("squad-changed");
    expect(squad.handleAdminSquadChange).toHaveBeenCalledWith(expect.objectContaining({ route: "other_att", text: "Tom is out tonight", namedBody: "Tom is out tonight" }));
    expect(requests).toHaveLength(1);
  });

  it("a monthly club: no weekly squad or team change, one line instead", async () => {
    const r = await ask("Tom is out tonight", "other_att", { org: { ...ORG, squadMode: "monthly" } });
    expect(r?.outcome).toBe("hq-not-here");
    expect(squad.handleAdminSquadChange).not.toHaveBeenCalled();
  });

  it.each(["question", "score", "admin_ops"])("%s: clearly for MatchTime but not done from HQ: one line, never silent", async (route) => {
    expect((await ask("@Match Time who has paid?", route))?.replyText).toBe("I can't do that from this group. Ask *what can you do?* to see what I can do here.");
  });

  it.each(["none", "offer", "unsure"])("%s: the organisers' own conversation, silent", async (route) => {
    expect(await ask("who is bringing the bibs?", route)).toBeNull();
  });
});
