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
import type { StoredAsk } from "../refused-ask-retry";
import { asShortIds } from "../pipeline/__tests__/router-ids";

const dbMock = vi.hoisted(() => ({
  adminTeamProposal: { findFirst: vi.fn() },
  adminSquadProposal: { findFirst: vi.fn() },
  match: { findUnique: vi.fn(), findMany: vi.fn() },
  membership: { findMany: vi.fn(), findFirst: vi.fn() },
  // What an HQ reply quotes, by its WhatsApp id (slice S4).
  sentNotification: { findMany: vi.fn() },
  botJob: { findMany: vi.fn() },
  adminGroupMessage: { findMany: vi.fn(), updateMany: vi.fn() },
  user: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
const hqLog = vi.hoisted(() => ({
  hqLogSince: vi.fn(),
  recordMatchTimeQuestion: vi.fn(),
  recordMatchTimeLine: vi.fn(),
  NOT_HERE_ID_PREFIX: "mt:said:not-here:",
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
const groupAsk = vi.hoisted(() => ({ askPlayersGroup: vi.fn() }));
vi.mock("@/lib/admin-group-ask-group", () => groupAsk);
const hqQuestion = vi.hoisted(() => ({ answerHqQuestion: vi.fn() }));
vi.mock("@/lib/admin-group-question", () => hqQuestion);
// A partner club's ask waiting for this club's YES (cross-club ask, S2).
// None by default; the #297 cases below set one.
const partnerAsk = vi.hoisted(() => ({
  partnerAsksAwaitingApproval: vi.fn().mockResolvedValue([]),
  answerPartnerAskYes: vi.fn(),
  partnerAskRef: (id: string) => `xask:${id}`,
  parsePartnerAskRef: (ref: string) => (ref.startsWith("xask:") ? ref.slice(5) : null),
}));
vi.mock("@/lib/partner-ask", () => partnerAsk);
// Free places (2026-10-16): the owner behind admin_ops' fee_waiver.
const feeWaiver = vi.hoisted(() => ({
  proposeFeeFreeInHq: vi.fn(),
  answerFeeProposalYes: vi.fn(),
  feeProposalsAwaiting: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/fee-waiver", () => feeWaiver);
// A partner-club pairing waiting for this club's owner (2026-10-21). None
// by default; the pairing cases below set one.
const pairing = vi.hoisted(() => ({
  pairingsAwaitingOwner: vi.fn().mockResolvedValue([]),
  answerPairingInHq: vi.fn(),
}));
vi.mock("@/lib/pairing-reply", () => pairing);
// The score in HQ (2026-10-16): nothing waiting and no override by default.
const hqScore = vi.hoisted(() => ({ answerHqScore: vi.fn(), hqScoreRouting: vi.fn() }));
vi.mock("@/lib/admin-group-score", () => hqScore);

// Partner clubs asked in an organiser's words (slice S6): none by default.
const partnerWords = vi.hoisted(() => ({
  activePartnerChoices: vi.fn().mockResolvedValue([]),
  askPartnersFromWords: vi.fn(),
}));
vi.mock("@/lib/partner-ask-words", () => partnerWords);

// The MatchTime player pool asked from HQ (local player pool L10): nothing
// waiting by default.
const hqPool = vi.hoisted(() => ({
  askPoolFromWords: vi.fn(),
  poolNoticesAwaiting: vi.fn().mockResolvedValue([]),
  joinRequestsAwaiting: vi.fn().mockResolvedValue([]),
  answerJoinRequestInHq: vi.fn(),
}));
vi.mock("@/lib/pool-ask-words", () => hqPool);

// Cancelling a match, or putting it back on, from HQ (2026-10-22).
const matchCancel = vi.hoisted(() => ({ hqCancelOrRestore: vi.fn() }));
vi.mock("@/lib/match-cancel", () => matchCancel);
// The monthly club's coming-month list (2026-10-29), read by the monthly
// reader inside this door. Null: not such a list.
const monthSeedRead = vi.hoisted(() => ({ proposeMonthSeedPaste: vi.fn(async () => null as unknown) }));
vi.mock("@/lib/month-seed-read", () => monthSeedRead);
vi.mock("../month-seed-read", () => monthSeedRead);
// The collector's answer to the paid-claims list (2026-10-29), read by a
// model inside this door. Null: not such an answer.
const monthPayment = vi.hoisted(() => ({ handleCollectorPaidReply: vi.fn(async () => null as unknown) }));
vi.mock("@/lib/month-payment", () => monthPayment);
vi.mock("../month-payment", () => monthPayment);

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
      return { text: req.label === "router" ? asShortIds(JSON.stringify(answer(req)), req) : JSON.stringify(answer(req)), stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 0 };
    },
  };
}
const routeTo = (route: string) => model(() => ({ routes: [{ id: "wa-9", route }] }));
const teamsFacts = (facts: Record<string, unknown>) =>
  model(() => ({ action: "swap", includeRefs: [], teamNames: [], swaps: [], moves: [], pairings: [], ...facts }));
const adminFacts = (facts: Record<string, unknown>) =>
  model(() => ({ action: "other", payerRef: "", count: 0, coveredRefs: [], phrase: "", note: "", lookbackMatches: 0, ...facts }));

const mtRow = (at: Date, askRef: string, text = TEAMS_TEXT): HqLogRow => ({ waMessageId: `mt:${askRef}:1`, fromMatchTime: true, senderUserId: null, text, askRef, createdAt: at });
const orgRow = (at: Date, text = "who has the bibs?"): HqLogRow => ({ waMessageId: `wa-${at.getTime()}`, fromMatchTime: false, senderUserId: "u-2", text, askRef: null, createdAt: at });

function ask(text: string, route: string, over: Partial<Parameters<typeof understandAdminMessage>[0]> = {}) {
  return understandAdminMessage({
    org: ORG,
    messageId: "wa-9",
    text,
    quoted: null,
    senderUserId: "u-admin",
    organiser: true,
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
  feeWaiver.feeProposalsAwaiting.mockResolvedValue([]);
  pairing.pairingsAwaitingOwner.mockResolvedValue([]);
  pairing.answerPairingInHq.mockResolvedValue({ outcome: "pairing-accepted", replyText: "✅ Accepted." });
  dbMock.adminTeamProposal.findFirst.mockResolvedValue({ matchId: "m1", askedAt: ASKED, state: "proposed" });
  dbMock.match.findUnique.mockResolvedValue({ date: new Date("2026-10-16T20:00:00Z"), status: "TEAMS_GENERATED" });
  dbMock.adminSquadProposal.findFirst.mockResolvedValue(null);
  hqLog.hqLogSince.mockResolvedValue([mtRow(ASKED, "teams:m1")]);
  teams.answerTeamsYes.mockResolvedValue({ outcome: "teams-final", replyText: "Teams are final." });
  teams.handleTeamCommand.mockResolvedValue({ outcome: "teams-swapped", replyText: "📝 *Proposed teams* ..." });
  paste.answerSquadPasteYes.mockResolvedValue({ outcome: "paste-applied", replyText: "Done." });
  graphics.answerGraphicRequest.mockResolvedValue({ outcome: "graphic-queued", replyText: null });
  squad.handleAdminSquadChange.mockResolvedValue({ handled: true, outcome: "squad-changed", replyText: "Done: Tom out." });
  groupAsk.askPlayersGroup.mockResolvedValue({ outcome: "group-asked", replyText: "Asked in the main chat for 1 player." });
  hqQuestion.answerHqQuestion.mockResolvedValue(null);
  dbMock.membership.findMany.mockResolvedValue([{ user: { name: "Hamzah Ali" } }, { user: { name: "Raihan" } }]);
  hqScore.hqScoreRouting.mockResolvedValue({ waiting: null, scoreAnswerIds: new Set(), scoreCorrectionIds: new Set() });
  hqScore.answerHqScore.mockResolvedValue({ outcome: "hq-score-saved", replyText: "Score saved: Yellow 7, Red 4." });
  dbMock.sentNotification.findMany.mockResolvedValue([]);
  dbMock.botJob.findMany.mockResolvedValue([]);
  dbMock.adminGroupMessage.findMany.mockResolvedValue([]);
  dbMock.adminGroupMessage.updateMany.mockResolvedValue({ count: 1 });
  dbMock.user.findMany.mockResolvedValue([]);
  dbMock.membership.findFirst.mockResolvedValue(null);
  partnerWords.activePartnerChoices.mockResolvedValue([]);
  partnerWords.askPartnersFromWords.mockResolvedValue({ outcome: "xask-words-asked", replyText: "I've asked *Sutton FC*'s organisers.", asked: 1 });
  hqPool.poolNoticesAwaiting.mockResolvedValue([]);
  hqPool.joinRequestsAwaiting.mockResolvedValue([]);
  hqPool.answerJoinRequestInHq.mockResolvedValue({ outcome: "hq-join-link-sent", replyText: "✅ Sending Sam K the players' group's invite link." });
  hqPool.askPoolFromWords.mockResolvedValue({ outcome: "hq-pool-asked", replyText: "🔎 Asking nearby players from the MatchTime player pool for 1 place on Fri 16 Oct, 20:00." });
});

describe("what MatchTime decided is kept on the HQ row (FNF HQ 2026-10-24, \"Glazers OUT\")", () => {
  const saved = () => {
    expect(dbMock.adminGroupMessage.updateMany).toHaveBeenCalledTimes(1);
    return dbMock.adminGroupMessage.updateMany.mock.calls[0][0];
  };

  it("a squad change that went silent: the router's route and source, and \"silent\"", async () => {
    squad.handleAdminSquadChange.mockResolvedValue({ handled: false, why: "not-a-squad-change" });
    expect(await ask("Glazers OUT", "other_att")).toBeNull();
    const arg = saved();
    expect(arg.where).toEqual({ orgId: ORG.id, waMessageId: "wa-9" });
    expect(arg.data.hqOutcome).toBe("silent");
    expect(arg.data.pipelineTrace).toMatchObject({ v: 1, router: { route: "other_att", source: "model" } });
  });

  it("an answered message: its outcome", async () => {
    await ask("Tom out", "other_att");
    expect(saved().data.hqOutcome).toBe("squad-changed");
  });

  it("the organisers' own chat: none, and silent", async () => {
    expect(await ask("who has the bibs?", "none")).toBeNull();
    const arg = saved();
    expect(arg.data.hqOutcome).toBe("silent");
    expect(arg.data.pipelineTrace.router.route).toBe("none");
  });

  it("a failed save never fails HQ", async () => {
    dbMock.adminGroupMessage.updateMany.mockRejectedValue(new Error("column does not exist"));
    expect(await ask("Tom out", "other_att")).toMatchObject({ outcome: "squad-changed" });
  });
});

describe("the router is the players' group's router, shown the organisers' context", () => {
  it("the message goes under the organisers' header with what is waiting, the reply and recent chat", async () => {
    hqLog.hqLogSince.mockResolvedValue([mtRow(ASKED, "teams:m1"), orgRow(new Date("2026-10-16T09:05:00Z"))]);
    await ask("yes", "approve", { quoted: { text: "shall we start at 8?", fromMatchTime: false } });
    const user = requests[0].user;
    expect(user).toContain("ORGANISERS' GROUP. The sender is an organiser of the club.");
    expect(user).toContain("WAITING: approval of the proposed teams for Fri 16 Oct, asked at 10:00.");
    expect(user).toContain('THEY ARE REPLYING TO a message from a member (not identified) (when it was sent is not known):\n"shall we start at 8?"\n[m1] Raihan: yes');
    expect(user).toMatch(/^NOW: /);
    expect(user).toContain("- a member: who has the bibs?");
    // The model is shown a short id, never the WhatsApp id.
    expect(user).toContain("[m1] Raihan: yes");
    expect(user).not.toContain("wa-9");
    expect(requests[0].system).toContain("IN THE ORGANISERS' GROUP");
  });

  // 2026-10-21: the header states what code knows about the sender, never
  // that everyone in HQ is an organiser (players are in HQ too).
  it("a member who is not an organiser is shown as one, not as an organiser", async () => {
    await ask("Naim is out", "other_att", { organiser: false, member: true, senderUserId: "u-pat", senderName: "Pat" });
    const user = requests[0].user;
    expect(user).toContain("ORGANISERS' GROUP. The sender is a member of the club, not an organiser.");
    expect(user).not.toContain("The sender is an organiser");
  });
});

describe("an HQ reply is decided by the quoted message's id (quoted-reply context, slice S4, and review of #341, findings 4 and 5)", () => {
  const teamsPost = { key: "botjob-j1", kind: "admin-group-message", matchId: null, waMessageId: "true_hq@g.us_3EB0TEAMS", waStanzaId: "3EB0TEAMS", text: null, createdAt: ASKED };
  const stamped = (at: Date, stanza: string, text = TEAMS_TEXT) => ({ ...mtRow(at, "teams:m1", text), waMessageId: `mt:teams:m1:${stanza}`, waStanzaId: stanza });

  it("a YES quoting MatchTime's teams post by id approves those teams, though the Pi's copy of the words is cut and its flag missing", async () => {
    // Other chat in between: without the quote this YES would be asked about.
    hqLog.hqLogSince.mockResolvedValue([stamped(ASKED, "3EB0TEAMS"), orgRow(new Date("2026-10-16T09:05:00Z"))]);
    dbMock.sentNotification.findMany.mockResolvedValue([teamsPost]);
    dbMock.botJob.findMany.mockResolvedValue([{ id: "j1", orgId: "org-fnf", kind: "admin-group", text: TEAMS_TEXT, sentAt: ASKED, createdAt: ASKED, matchId: "m1", aboutKey: null }]);
    dbMock.match.findMany.mockResolvedValue([{ id: "m1", date: new Date("2026-10-16T20:00:00Z"), activity: { name: "Friday 7s", orgId: "org-fnf" } }]);
    const r = await ask("YES", "approve", { quoted: { messageId: "3EB0TEAMS", text: "📝 Proposed", fromMatchTime: false } });
    expect(r?.outcome).toBe("teams-final");
    expect(requests[0].user).toContain("THEY ARE REPLYING TO MatchTime's message of Fri 16 Oct, 10:00");
  });

  it("a YES quoting an OLDER proposal (the teams changed and were proposed again) asks, and does not approve the new line-up", async () => {
    const OLD = new Date("2026-10-16T08:30:00Z");
    // The proposal was re-asked at 10:00 (ASKED); the YES quotes the 09:30 one.
    hqLog.hqLogSince.mockResolvedValue([stamped(OLD, "3EB0OLDTEAMS", `${TEAMS_TEXT}\n2. Old Line-up`), stamped(ASKED, "3EB0TEAMS")]);
    const r = await ask("YES", "approve", { quoted: { messageId: "3EB0OLDTEAMS", text: `${TEAMS_TEXT}\n2. Old Line-up`, fromMatchTime: true } });
    expect(r?.outcome).toBe("hq-confirm-asked");
    expect(teams.answerTeamsYes).not.toHaveBeenCalled();
  });

  it("the same, with no id the log knows (text fallback): the whole line must agree, so the older proposal is not mistaken for the new one", async () => {
    const OLD = new Date("2026-10-16T08:30:00Z");
    hqLog.hqLogSince.mockResolvedValue([mtRow(OLD, "teams:m1", `${TEAMS_TEXT}\n2. Old Line-up`), mtRow(ASKED, "teams:m1", `${TEAMS_TEXT}\n2. New Line-up`)]);
    const r = await ask("YES", "approve", { quoted: { text: `${TEAMS_TEXT}\n2. Old Line-up`, fromMatchTime: true } });
    expect(r?.outcome).toBe("hq-confirm-asked");
    expect(teams.answerTeamsYes).not.toHaveBeenCalled();
  });

  it("another organiser's message, found by id, is named, and an untagged reply to it is their conversation", async () => {
    dbMock.adminGroupMessage.findMany.mockResolvedValue([
      { waMessageId: "false_hq@g.us_3EB0ORG_4478@s.whatsapp.net", waStanzaId: null, fromMatchTime: false, senderUserId: "u-2", text: "Imti is back next week", createdAt: new Date("2026-10-16T09:05:00Z") },
    ]);
    dbMock.user.findMany.mockResolvedValue([{ id: "u-2", name: "Hamzah Ali" }]);
    const r = await ask("Rafi too", "other_att", { quoted: { messageId: "3EB0ORG", text: "Imti is back", fromMatchTime: false } });
    expect(requests[0].user).toContain('THEY ARE REPLYING TO Hamzah Ali\'s message of Fri 16 Oct, 10:05:\n"Imti is back next week"');
    expect(r).toBeNull();
    expect(squad.handleAdminSquadChange).not.toHaveBeenCalled();
  });

  it("an organiser's message, found by id, whose words copy MatchTime's proposal is NOT relabelled MatchTime's: a YES to it is their conversation", async () => {
    // Hamzah pasted the proposal's text himself; Raihan replies YES to Hamzah.
    dbMock.adminGroupMessage.findMany.mockResolvedValue([
      { waMessageId: "false_hq@g.us_3EB0COPY_4478@s.whatsapp.net", waStanzaId: null, fromMatchTime: false, senderUserId: "u-2", text: TEAMS_TEXT, createdAt: new Date("2026-10-16T09:05:00Z") },
    ]);
    dbMock.user.findMany.mockResolvedValue([{ id: "u-2", name: "Hamzah Ali" }]);
    hqLog.hqLogSince.mockResolvedValue([mtRow(ASKED, "teams:m1"), { ...orgRow(new Date("2026-10-16T09:05:00Z"), TEAMS_TEXT), waMessageId: "false_hq@g.us_3EB0COPY_4478@s.whatsapp.net" }]);
    const r = await ask("YES", "approve", { quoted: { messageId: "3EB0COPY", text: TEAMS_TEXT, fromMatchTime: false } });
    expect(teams.answerTeamsYes).not.toHaveBeenCalled();
    expect(r).toBeNull();
  });

  it("a failed read keeps the Pi's quote", async () => {
    dbMock.sentNotification.findMany.mockRejectedValue(new Error("db down"));
    const r = await ask("YES", "approve", { quoted: { messageId: "3EB0TEAMS", text: TEAMS_TEXT, fromMatchTime: true } });
    expect(r?.outcome).toBe("teams-final");
  });
});

describe("a partner-club pairing waiting for the owner (2026-10-21)", () => {
  const REF = "pairing:p1:org-fnf";
  const NOTICE = "🤝 MatchTime has paired *FNF* with *MT Test*: ... Club owner: reply to this message with *1* to accept or *2* to decline, or open https://x";
  const noticeRow = (at: Date) => ({ ...mtRow(at, REF, NOTICE), waMessageId: "mt:pairing:1", waStanzaId: "3EB0PAIR" });
  beforeEach(() => {
    dbMock.adminTeamProposal.findFirst.mockResolvedValue(null);
    pairing.pairingsAwaitingOwner.mockResolvedValue([{ ref: REF, club: "FNF", other: "MT Test", askedAt: ASKED }]);
    hqLog.hqLogSince.mockResolvedValue([noticeRow(ASKED)]);
  });

  it("the router is told what is waiting, and how the owner answers it", async () => {
    await ask("1", "approve");
    expect(requests[0].user).toContain("WAITING: the club owner's answer to pairing FNF with MT Test as partner clubs (1 or yes accepts, 2 or no declines), asked at 10:00.");
  });

  it("a reply quoting the notice is read by the pairing reader, whatever the router would say, and no router call is paid", async () => {
    const r = await ask("2", "none", { quoted: { messageId: "3EB0PAIR", text: NOTICE, fromMatchTime: true } });
    expect(pairing.answerPairingInHq).toHaveBeenCalledWith({ ref: REF, orgId: "org-fnf", text: "2", senderUserId: "u-admin", noticeText: NOTICE, noticeAt: ASKED, quoted: true, now: NOW });
    expect(r).toEqual({ route: null, outcome: "pairing-accepted", replyText: "✅ Accepted." });
    expect(requests.filter((q) => q.label === "router")).toHaveLength(0);
  });

  it("a quoted reply the reader says is not an answer: silent", async () => {
    pairing.answerPairingInHq.mockResolvedValue(null);
    expect(await ask("who are they?", "question", { quoted: { messageId: "3EB0PAIR", text: NOTICE, fromMatchTime: true } })).toBeNull();
  });

  it("an unquoted YES as the next message after the notice: the safe-YES rule hands it to the pairing reader", async () => {
    const r = await ask("yes", "approve");
    expect(pairing.answerPairingInHq).toHaveBeenCalledWith(expect.objectContaining({ ref: REF, text: "yes", quoted: false, noticeText: NOTICE }));
    expect(r?.outcome).toBe("pairing-accepted");
  });

  it("an unquoted YES after other chat: asks, naming the pairing, and nothing is accepted", async () => {
    hqLog.hqLogSince.mockResolvedValue([noticeRow(ASKED), orgRow(new Date("2026-10-16T09:05:00Z"))]);
    const r = await ask("yes", "approve");
    expect(r?.replyText).toBe("Is that about pairing *FNF* with *MT Test*? Club owner: reply to the pairing message with *1* to accept or *2* to decline.");
    expect(pairing.answerPairingInHq).not.toHaveBeenCalled();
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

  // 2026-10-20 (Kemal): anyone who may paste a list may say YES to their own.
  describe("a member who is not an organiser and the pasted list", () => {
    const member = { senderUserId: "u-kemal", organiser: false, member: true, senderName: "Kemal" };
    const ONLY = "Only Hamzah or Raihan can change that.";
    const listWaiting = (by: string) => {
      dbMock.adminTeamProposal.findFirst.mockResolvedValue(null);
      dbMock.adminSquadProposal.findFirst.mockResolvedValue({ waMessageId: "wa-paste", createdAt: ASKED, proposedByUserId: by });
      hqLog.hqLogSince.mockResolvedValue([mtRow(ASKED, "list:wa-paste", "Adding: Bilal. Reply YES to apply.")]);
    };

    it("their YES to the list they pasted: applied, that list only", async () => {
      listWaiting("u-kemal");
      expect((await ask("yes", "approve", member))?.outcome).toBe("paste-applied");
      expect(paste.answerSquadPasteYes).toHaveBeenCalledWith(expect.objectContaining({ senderUserId: "u-kemal", proposedBy: "u-kemal" }));
    });

    it("their YES to a list someone else pasted: the line naming who can, nothing applied", async () => {
      listWaiting("u-admin");
      expect(await ask("yes", "approve", member)).toEqual({ route: "approve", outcome: "hq-only-organisers", replyText: ONLY });
      expect(paste.answerSquadPasteYes).not.toHaveBeenCalled();
    });

    it("their YES while the teams wait: the line, the teams untouched", async () => {
      expect(await ask("yes", "approve", member)).toEqual({ route: "approve", outcome: "hq-only-organisers", replyText: ONLY });
      expect(teams.answerTeamsYes).not.toHaveBeenCalled();
    });

    it("someone not in the club, their YES to any list: the line", async () => {
      listWaiting("u-kemal");
      expect((await ask("yes", "approve", { ...member, member: false }))?.outcome).toBe("hq-only-organisers");
      expect(paste.answerSquadPasteYes).not.toHaveBeenCalled();
    });

    it("an organiser's YES to a member's list: applied, any list", async () => {
      listWaiting("u-kemal");
      expect((await ask("yes", "approve"))?.outcome).toBe("paste-applied");
      expect(paste.answerSquadPasteYes).toHaveBeenCalledWith(expect.not.objectContaining({ proposedBy: expect.anything() }));
    });
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

  it("help that the question extractor does not answer: the HQ list for this club", async () => {
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
      command: { kind: "change", swapSides: false, moves: ["Ali", "Can"], sides: [], together: [] },
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

  // FNF HQ 2026-10-17 09:01: "Imti\nRafi\nAH\n\nIn" was routed none by the
  // model. An organiser's list of names with IN/OUT is structured data: a
  // squad change, and the router is not asked.
  it.each(["Imti \nRafi \nAH\n\nIn", "Yaseen \nMo\nFeroz\nAli\n\nOut", "Imti, Rafi and AH in"])(
    "an organiser's list %j: a squad change without the router, even when the router would say none",
    async (text) => {
      const r = await ask(text, "none");
      expect(r).toMatchObject({ route: "other_att", outcome: "squad-changed" });
      expect(squad.handleAdminSquadChange).toHaveBeenCalledWith(expect.objectContaining({ route: "other_att", text }));
      expect(requests).toHaveLength(0);
    },
  );

  it("the same list from someone who is not an organiser goes to the router as before", async () => {
    await ask("Imti \nRafi \nAH\n\nIn", "none", { organiser: false });
    expect(requests).toHaveLength(1);
    expect(squad.handleAdminSquadChange).not.toHaveBeenCalled();
  });

  it("the same list as a reply to another organiser, untagged: their conversation, silent", async () => {
    expect(await ask("Imti \nRafi \nAH\n\nIn", "none", { quoted: { text: "who's back?", fromMatchTime: false } })).toBeNull();
    expect(squad.handleAdminSquadChange).not.toHaveBeenCalled();
  });

  it("tells the squad change whether the message was addressed to MatchTime", async () => {
    await ask("Tom is out tonight", "other_att");
    expect(squad.handleAdminSquadChange).toHaveBeenLastCalledWith(expect.objectContaining({ addressed: false }));
    await ask("@Match Time Tom is out tonight", "other_att");
    expect(squad.handleAdminSquadChange).toHaveBeenLastCalledWith(expect.objectContaining({ addressed: true }));
    await ask("Tom is out tonight", "other_att", { quoted: { text: TEAMS_TEXT, fromMatchTime: true } });
    expect(squad.handleAdminSquadChange).toHaveBeenLastCalledWith(expect.objectContaining({ addressed: true }));
  });

  it("tells the squad change whether the sender is an organiser", async () => {
    await ask("Tom is out tonight", "other_att");
    expect(squad.handleAdminSquadChange).toHaveBeenLastCalledWith(expect.objectContaining({ organiser: true }));
    await ask("Tom is out tonight", "other_att", { organiser: false, member: true });
    expect(squad.handleAdminSquadChange).toHaveBeenLastCalledWith(expect.objectContaining({ organiser: false }));
  });

  // FNF HQ 2026-10-24 13:47, Kemal (owner): "Glazers is out now.\n\n@Match
  // Time what is the list?" Routed other_att; the attendance extractor read
  // the OUT; nobody answered the tagged question. The extractor now says the
  // message also asks MatchTime something (its "question" side request), and
  // HQ answers it with the same question answering, after the change.
  describe("a squad change that also asks MatchTime something (FNF HQ 2026-10-24)", () => {
    const TEXT = "Glazers is out now.\n\n@Match Time what is the list?";
    const NOT_ON = "I can't find Glazers on the list for Fri 20:30, so nothing changed.";
    const LIST = "*Fri 20:30*: 17 of 18\n1. Ali";

    it("the incident: the squad line, then the answer, in one reply", async () => {
      squad.handleAdminSquadChange.mockResolvedValue({ handled: true, outcome: "squad-not-on-list", replyText: NOT_ON, alsoAsks: true });
      hqQuestion.answerHqQuestion.mockResolvedValue({ outcome: "hq-answered", replyText: LIST });
      const r = await ask(TEXT, "other_att");
      expect(r).toEqual({ route: "other_att", outcome: "squad-not-on-list+hq-answered", replyText: `${NOT_ON}\n\n${LIST}` });
      expect(hqQuestion.answerHqQuestion).toHaveBeenCalledWith(expect.objectContaining({ body: TEXT }));
      // Answered after the change, so the list it prints is the new one.
      expect(hqQuestion.answerHqQuestion.mock.invocationCallOrder[0]).toBeGreaterThan(squad.handleAdminSquadChange.mock.invocationCallOrder[0]);
    });

    it("a change that says nothing: the answer alone", async () => {
      squad.handleAdminSquadChange.mockResolvedValue({ handled: false, why: "not-a-squad-change", alsoAsks: true });
      hqQuestion.answerHqQuestion.mockResolvedValue({ outcome: "hq-answered", replyText: LIST });
      expect(await ask(TEXT, "other_att")).toEqual({ route: "other_att", outcome: "hq-answered", replyText: LIST });
    });

    it("the question answering answers nothing: the squad line alone", async () => {
      squad.handleAdminSquadChange.mockResolvedValue({ handled: true, outcome: "squad-not-on-list", replyText: NOT_ON, alsoAsks: true });
      hqQuestion.answerHqQuestion.mockResolvedValue(null);
      expect(await ask(TEXT, "other_att")).toEqual({ route: "other_att", outcome: "squad-not-on-list", replyText: NOT_ON });
    });

    it("not asked of MatchTime (no tag, not a reply to it): the question is the organisers' own, never answered", async () => {
      squad.handleAdminSquadChange.mockResolvedValue({ handled: true, outcome: "squad-changed", replyText: "Done: Tom out.", alsoAsks: true });
      const r = await ask("Tom out, who's got the bibs?", "other_att");
      expect(r).toEqual({ route: "other_att", outcome: "squad-changed", replyText: "Done: Tom out." });
      expect(hqQuestion.answerHqQuestion).not.toHaveBeenCalled();
    });

    it("no question in it: no question answering call", async () => {
      await ask("@Match Time Tom is out tonight", "other_att");
      expect(hqQuestion.answerHqQuestion).not.toHaveBeenCalled();
    });

    it("routed unsure and addressed: the same, change then answer", async () => {
      squad.handleAdminSquadChange.mockResolvedValue({ handled: true, outcome: "squad-changed", replyText: "Done: Tom out.", alsoAsks: true });
      hqQuestion.answerHqQuestion.mockResolvedValue({ outcome: "hq-answered", replyText: LIST });
      const r = await ask("@Match Time Tom out and the list?", "unsure");
      expect(r).toEqual({ route: "unsure", outcome: "squad-changed+hq-answered", replyText: `Done: Tom out.\n\n${LIST}` });
      expect(hqQuestion.answerHqQuestion).toHaveBeenCalledTimes(1);
    });
  });

  it("a monthly club: no weekly squad or team change, one line instead", async () => {
    const r = await ask("Tom is out tonight", "other_att", { org: { ...ORG, squadMode: "monthly" } });
    expect(r?.outcome).toBe("hq-not-here");
    expect(squad.handleAdminSquadChange).not.toHaveBeenCalled();
  });

  it.each(["admin_ops"])("%s: clearly for MatchTime but not done from HQ: one line, never silent", async (route) => {
    const deps = { routerModel: routeTo(route), extractorModel: adminFacts({ action: "other" }) };
    expect((await ask("@Match Time who has paid?", route, { deps }))?.replyText).toBe("I can't do that from this group.");
    expect(feeWaiver.proposeFeeFreeInHq).not.toHaveBeenCalled();
    expect(groupAsk.askPlayersGroup).not.toHaveBeenCalled();
    expect(hqQuestion.answerHqQuestion).not.toHaveBeenCalled();
  });

  it("ask_group: the players' group is asked for a player, HQ hears one line (the extractor said the club's own group)", async () => {
    const deps = { routerModel: routeTo("ask_group"), extractorModel: adminFacts({ action: "recruit", playersFrom: "club", toMatchTime: true }) };
    const r = await ask("@Match Time ask in the group if anyone is available", "ask_group", { deps });
    expect(r).toEqual({ route: "ask_group", outcome: "group-asked", replyText: "Asked in the main chat for 1 player." });
    expect(groupAsk.askPlayersGroup).toHaveBeenCalledWith({ orgId: "org-fnf", lang: "en", messageId: "wa-9", now: NOW });
    expect(requests.map((q) => q.label)).toEqual(["router", "extractor:admin"]);
  });

  it("ask_group in a monthly club: no weekly squad to ask for, one line", async () => {
    const r = await ask("gruba sor, oynayabilecek var mı", "ask_group", { org: { ...ORG, squadMode: "monthly" } });
    expect(r?.outcome).toBe("hq-not-here");
    expect(groupAsk.askPlayersGroup).not.toHaveBeenCalled();
  });

  it.each(["none", "offer", "unsure"])("%s: the organisers' own conversation, silent", async (route) => {
    expect(await ask("who is bringing the bibs?", route)).toBeNull();
  });
});

// FNF HQ, 2026-10-16 23:49 London: "Imti Rafi AH back", a WhatsApp reply to
// ANOTHER organiser's message about next week, was routed other_att by the
// model (prod log "routed other_att by model (0 waiting, a reply)"), and HQ
// got a tick and "I don't know AH yet". A reply to another organiser, with
// no @tag, is the organisers talking to each other: nothing MatchTime does
// from it, whatever the route. The safe-YES rule and the score keep their
// own rules for a quoted message.
describe("a reply to another organiser, not tagged: the organisers' own conversation", () => {
  const fromOrganiser = { text: "We have the below out - Yaseen Mo Feroz", fromMatchTime: false };

  it.each(["other_att", "self_att", "unsure", "balancer", "ask_group", "question", "help", "admin_ops", "poster", "team_sheet"])(
    "%s: silent, nothing asked or done",
    async (route) => {
      expect(await ask("Imti Rafi AH back", route, { quoted: fromOrganiser })).toBeNull();
      expect(squad.handleAdminSquadChange).not.toHaveBeenCalled();
      expect(teams.handleTeamCommand).not.toHaveBeenCalled();
      expect(groupAsk.askPlayersGroup).not.toHaveBeenCalled();
      expect(hqQuestion.answerHqQuestion).not.toHaveBeenCalled();
      expect(graphics.answerGraphicRequest).not.toHaveBeenCalled();
      expect(requests).toHaveLength(1);
    },
  );

  it("an @tag in it: addressed to MatchTime after all, handled as usual", async () => {
    const r = await ask("@Match Time put Imti in", "other_att", { quoted: fromOrganiser });
    expect(r?.outcome).toBe("squad-changed");
    expect(squad.handleAdminSquadChange).toHaveBeenCalledWith(expect.objectContaining({ addressed: true }));
  });

  it("a reply to MatchTime's own message is not this", async () => {
    const r = await ask("put Imti in", "other_att", { quoted: { text: TEAMS_TEXT, fromMatchTime: true } });
    expect(r?.outcome).toBe("squad-changed");
  });

  it("a plain instruction in HQ, quoting nobody: still applied", async () => {
    expect((await ask("put Bilal in", "other_att"))?.outcome).toBe("squad-changed");
    expect(squad.handleAdminSquadChange).toHaveBeenCalledWith(expect.objectContaining({ addressed: false }));
  });

  it("the score keeps its own rules: a scoreline replying to another organiser's question is still read", async () => {
    expect((await ask("7-4", "score", { quoted: { text: "What was the final score!", fromMatchTime: false } }))?.outcome).toBe("hq-score-saved");
  });
});

// FNF, 2026-10-16 13:10 London: "@Match Time update the graphic please", a
// WhatsApp reply to MatchTime's own "Team change" message, came back from
// the router as `unsure`, and HQ treated `unsure` as the organisers' own
// conversation: no graphic, no reply, nothing. A message addressed to
// MatchTime (an @tag, or a reply to MatchTime's own message) is never met
// with silence. `unsure` goes to the attendance engine, as in the players'
// group; when that owns nothing, one line says so.
describe("unsure, addressed to MatchTime: never silent", () => {
  const NOT_UNDERSTOOD = "I didn't catch what you'd like me to do.";
  const changeMsg = { text: "🔄 *Team change*: Naim replaces Uncle Najib on Red.\n\n✅ *Final teams*: 20:30 at Harris Merton", fromMatchTime: true };

  beforeEach(() => {
    squad.handleAdminSquadChange.mockResolvedValue({ handled: false, why: "not-a-squad-change" });
  });

  it("the incident: a tagged reply to MatchTime's team change that the router called unsure gets one line", async () => {
    const r = await ask("@Match Time update the graphic please", "unsure", { quoted: changeMsg });
    expect(r).toEqual({ route: "unsure", outcome: "hq-not-understood", replyText: NOT_UNDERSTOOD });
    // The attendance engine was asked first, with the route the router gave.
    expect(squad.handleAdminSquadChange).toHaveBeenCalledWith(expect.objectContaining({ route: "unsure", messageId: "wa-9" }));
  });

  it("an @tag alone is enough", async () => {
    expect((await ask("@Match Time can you sort it", "unsure"))?.outcome).toBe("hq-not-understood");
  });

  it("a reply to MatchTime's own message, with no tag, is enough", async () => {
    expect((await ask("can you sort it", "unsure", { quoted: changeMsg }))?.outcome).toBe("hq-not-understood");
  });

  it("the attendance engine owns it: its line, not the fallback", async () => {
    squad.handleAdminSquadChange.mockResolvedValue({ handled: true, outcome: "squad-changed", replyText: "Done: Uncle Najib is out, AbdulHafeez is in." });
    const r = await ask("@Match Time replace Uncle with AbdulHafeez", "unsure");
    expect(r).toEqual({ route: "unsure", outcome: "squad-changed", replyText: "Done: Uncle Najib is out, AbdulHafeez is in." });
  });

  it("in Turkish", async () => {
    const r = await ask("@Match Time şunu hallet", "unsure", { org: { ...ORG, language: "tr" } });
    expect(r?.replyText).toBe("Ne yapmamı istediğinizi anlayamadım.");
  });

  it("the bare word matchtime, no @ and no reply, is talk ABOUT MatchTime: silent, nothing asked", async () => {
    expect(await ask("Matchtime has done it according to ratings", "unsure")).toBeNull();
    expect(squad.handleAdminSquadChange).not.toHaveBeenCalled();
  });

  it("a reply to another organiser: silent", async () => {
    expect(await ask("can you sort it", "unsure", { quoted: { text: "who has the bibs?", fromMatchTime: false } })).toBeNull();
  });

  it("a monthly club: the one line, no weekly squad engine", async () => {
    const r = await ask("@Match Time can you sort it", "unsure", { org: { ...ORG, squadMode: "monthly" } });
    expect(r?.outcome).toBe("hq-not-understood");
    expect(squad.handleAdminSquadChange).not.toHaveBeenCalled();
  });

  // FNF HQ, 2026-10-18 13:32 London: Kemal (a player of the club) asked
  // "@Match Time what is squad now including bench?". The router's answer
  // was dropped (its id echoed wrong), the message fell back to `unsure`,
  // and HQ said "I didn't catch what you'd like me to do". A message
  // addressed to MatchTime that routes `unsure`, by the model or by a
  // fallback, is also tried as a question before that line.
  describe("the shared question answering is tried before the one line", () => {
    const SQUAD = "✅ *In (18/18)*: ...\n🪑 *Bench (1)*: Naim";
    const INCIDENT = "@Match Time what is squad now including bench?";
    const player = { senderUserId: "u-kemal", organiser: false, senderName: "Kemal" };
    const failing: PipelineModel = {
      name: "down",
      complete: async () => {
        throw new Error("529 Overloaded");
      },
    };

    beforeEach(() => {
      hqQuestion.answerHqQuestion.mockResolvedValue({ outcome: "hq-answered", replyText: SQUAD });
    });

    it("the incident: a player's tagged squad question the model called unsure is answered", async () => {
      const r = await ask(INCIDENT, "unsure", player);
      expect(r).toEqual({ route: "unsure", outcome: "hq-answered", replyText: SQUAD });
      expect(hqQuestion.answerHqQuestion).toHaveBeenCalledWith(expect.objectContaining({ messageId: "wa-9", body: INCIDENT, senderUserId: "u-kemal" }));
      // A player changes nothing: the attendance engine is never asked.
      expect(squad.handleAdminSquadChange).not.toHaveBeenCalled();
    });

    it("the router call failed (fallback unsure): answered the same way", async () => {
      const r = await ask(INCIDENT, "unsure", { ...player, deps: { routerModel: failing } });
      expect(r).toEqual({ route: "unsure", outcome: "hq-answered", replyText: SQUAD });
    });

    it("the incident's real cause: the router is shown a short id, never the WhatsApp id, and its answer lands", async () => {
      const waId = "false_120363046757382958@g.us_AC5922E2E21D4093AAD157B03EDDADA1_89485761081551@lid";
      const shortAnswer: PipelineModel = {
        name: "answers m1",
        async complete(req) {
          requests.push(req);
          return { text: '{"routes":[{"id":"[m1]","route":"question"}]}', stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 0 };
        },
      };
      const r = await ask(INCIDENT, "question", { ...player, messageId: waId, deps: { routerModel: shortAnswer } });
      expect(r).toEqual({ route: "question", outcome: "hq-answered", replyText: SQUAD });
      expect(requests[0].user).toContain("[m1] Kemal: @Match Time what is squad now including bench?");
      expect(requests[0].user).not.toContain(waId);
    });

    it("an organiser: the attendance engine first, then the question", async () => {
      const r = await ask(INCIDENT, "unsure");
      expect(r?.outcome).toBe("hq-answered");
      expect(squad.handleAdminSquadChange).toHaveBeenCalled();
      expect(squad.handleAdminSquadChange.mock.invocationCallOrder[0]).toBeLessThan(hqQuestion.answerHqQuestion.mock.invocationCallOrder[0]);
    });

    it("an organiser's change the engine owns is not asked as a question", async () => {
      squad.handleAdminSquadChange.mockResolvedValue({ handled: true, outcome: "squad-changed", replyText: "Done." });
      expect((await ask("@Match Time Ali in", "unsure"))?.outcome).toBe("squad-changed");
      expect(hqQuestion.answerHqQuestion).not.toHaveBeenCalled();
    });

    it("nothing answers it: the one line, as before", async () => {
      hqQuestion.answerHqQuestion.mockResolvedValue(null);
      expect((await ask(INCIDENT, "unsure", player))?.outcome).toBe("hq-not-understood");
    });

    it("not addressed to MatchTime: silent, and no question is asked", async () => {
      expect(await ask("what is squad now including bench?", "unsure", player)).toBeNull();
      expect(hqQuestion.answerHqQuestion).not.toHaveBeenCalled();
    });

    it("the routed line carries the router's degradations, with no message text", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await ask(INCIDENT, "unsure", { ...player, deps: { routerModel: failing } });
      const routed = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes("routed unsure by fallback"));
      log.mockRestore();
      expect(routed).toMatch(/router call failed \(529 Overloaded\)/);
      expect(routed).not.toContain("squad now");
    });
  });
});

// FNF, 2026-10-16 14:29 London: Hamzah wrote "MatchTime who are the admins?"
// in HQ. The router returned `help` (Vercel: "routed help by model"), and
// `help` sent the generic HQ menu. `question` had a canned "not from this
// group" line. Both now ask the SAME question extractor and answer code the
// players' group uses (`answerHqQuestion`, `runAnswerBatch` with the
// organisers as the audience); the HQ menu stays for what that code does not
// answer on the help route.
describe("questions in HQ: the shared question answering, with the organisers' context", () => {
  const ADMINS = "👥 Admins: Hamzah and Raihan\n💷 Money collector: Hamzah\n💷 Match fee: £5 a player\n⚽ Teams ready: 10:00 on match day";

  it("the incident: routed help, the extractor reads a club question, the admins are named", async () => {
    hqQuestion.answerHqQuestion.mockResolvedValue({ outcome: "hq-answered", replyText: ADMINS });
    const r = await ask("MatchTime who are the admins?", "help");
    expect(r).toEqual({ route: "help", outcome: "hq-answered", replyText: ADMINS });
    expect(hqQuestion.answerHqQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-fnf",
        lang: "en",
        messageId: "wa-9",
        body: "MatchTime who are the admins?",
        senderUserId: "u-admin",
        senderName: "Raihan",
        now: NOW,
      }),
    );
    // The help menu is what a how-it-works question is answered with in HQ.
    expect(hqQuestion.answerHqQuestion.mock.calls[0][0].hqHelp).toContain("*MatchTime in your admin group*");
  });

  it("routed question: the same path", async () => {
    hqQuestion.answerHqQuestion.mockResolvedValue({ outcome: "hq-answered", replyText: "On the bench: Tom." });
    const r = await ask("who's on the bench?", "question");
    expect(r).toEqual({ route: "question", outcome: "hq-answered", replyText: "On the bench: Tom." });
  });

  it("the recent HQ chat is the extractor's history, MatchTime's own lines as MatchTime", async () => {
    hqLog.hqLogSince.mockResolvedValue([mtRow(ASKED, "teams:m1"), orgRow(new Date("2026-10-16T09:05:00Z"))]);
    await ask("how many are in?", "question");
    expect(hqQuestion.answerHqQuestion.mock.calls[0][0].history).toEqual([
      { author: "MatchTime", body: TEAMS_TEXT },
      { author: null, body: "who has the bibs?" },
    ]);
  });

  it("an organiser's line in the recent HQ chat carries his roster name (Kemal, 2026-10-20)", async () => {
    hqLog.hqLogSince.mockResolvedValue([mtRow(ASKED, "teams:m1"), orgRow(new Date("2026-10-16T09:05:00Z"))]);
    dbMock.user.findMany.mockImplementation(async (args: { where?: { id?: { in?: string[] } } }) =>
      args.where?.id?.in?.includes("u-2") ? [{ id: "u-2", name: "Hamzah Ali" }] : [],
    );
    await ask("how many are in?", "question");
    expect(hqQuestion.answerHqQuestion.mock.calls[0][0].history).toEqual([
      { author: "MatchTime", body: TEAMS_TEXT },
      { author: "Hamzah Ali", body: "who has the bibs?" },
    ]);
  });

  it("a question nothing answers: one line, never silent", async () => {
    const r = await ask("what's the weather like?", "question");
    expect(r).toEqual({ route: "question", outcome: "hq-not-here", replyText: "I can't do that from this group." });
  });

  it("in Turkish: the club's language reaches the answering code", async () => {
    await ask("yöneticiler kim?", "help", { org: { ...ORG, language: "tr" } });
    expect(hqQuestion.answerHqQuestion.mock.calls[0][0].lang).toBe("tr");
  });
});

// "Anyone in that group should be able to ask questions" (Kemal,
// 2026-10-16). A sender who is not an owner or admin of the club (a
// player, someone MatchTime does not know) is read by the same router. A
// question, help and the graphics are answered for them as for an
// organiser; anything that changes the club is the organisers' alone. A
// non-organiser who clearly asks MatchTime (an @tag, or a reply to its own
// message) to change something is told, once, who can; their chat stays
// silent, as an organiser's does.
describe("a sender who is not an organiser", () => {
  const ONLY = "Only Hamzah or Raihan can change that.";
  // Not a member of the club either (`member` unset): who plays is open to
  // the club's members only (2026-10-20, see the next describe).
  const player = (over: Partial<Parameters<typeof understandAdminMessage>[0]> = {}) => ({
    senderUserId: "u-kemal",
    organiser: false,
    senderName: "Kemal",
    ...over,
  });

  it("the incident: Kemal, a player, asks who the admins are and is answered by the shared question code", async () => {
    hqQuestion.answerHqQuestion.mockResolvedValue({ outcome: "hq-answered", replyText: "👥 Admins: Hamzah and Raihan" });
    const r = await ask("Who are are admins?", "question", player());
    expect(r).toEqual({ route: "question", outcome: "hq-answered", replyText: "👥 Admins: Hamzah and Raihan" });
    expect(hqQuestion.answerHqQuestion).toHaveBeenCalledWith(expect.objectContaining({ senderUserId: "u-kemal", senderName: "Kemal" }));
  });

  it("someone MatchTime does not know: answered, with no sender", async () => {
    hqQuestion.answerHqQuestion.mockResolvedValue({ outcome: "hq-answered", replyText: "On the bench: Tom." });
    const r = await ask("who's on the bench?", "question", player({ senderUserId: null, senderName: null }));
    expect(r?.outcome).toBe("hq-answered");
    expect(hqQuestion.answerHqQuestion).toHaveBeenCalledWith(expect.objectContaining({ senderUserId: null, senderName: null }));
  });

  it("help: the HQ menu, as for an organiser", async () => {
    const r = await ask("what can you do?", "help", player());
    expect(r?.outcome).toBe("hq-help");
    expect(r?.replyText).toContain("*MatchTime in your admin group*");
  });

  it("a graphic: anyone may ask for one", async () => {
    expect((await ask("@Match Time send the team sheet", "team_sheet", player()))?.outcome).toBe("graphic-queued");
    expect(graphics.answerGraphicRequest).toHaveBeenCalled();
  });

  it("a question nothing answers, not addressed to MatchTime: silent (their own chat)", async () => {
    expect(await ask("what's the weather like?", "question", player())).toBeNull();
  });

  it("a question nothing answers, tagged: the one line, as for an organiser", async () => {
    expect((await ask("@Match Time what's the weather like?", "question", player()))?.outcome).toBe("hq-not-here");
  });

  it.each([
    ["@Match Time swap Maj and Kieran", "balancer"],
    ["@Match Time Naim IN", "other_att"],
    ["@Match Time I'm in", "self_att"],
    ["@Match Time ask the group for a player", "ask_group"],
    ["@Match Time yes", "approve"],
  ])("%s (%s): not done, one line naming who can", async (text, route) => {
    const r = await ask(text, route, player());
    expect(r).toEqual({ route, outcome: "hq-only-organisers", replyText: ONLY });
    expect(teams.handleTeamCommand).not.toHaveBeenCalled();
    expect(teams.answerTeamsYes).not.toHaveBeenCalled();
    expect(squad.handleAdminSquadChange).not.toHaveBeenCalled();
    expect(groupAsk.askPlayersGroup).not.toHaveBeenCalled();
    expect(requests.length).toBe(1); // the router only: no extractor call for a change they cannot make
  });

  it("a reply to MatchTime's own message asking for a change: the same line", async () => {
    const r = await ask("swap Maj and Kieran", "balancer", player({ quoted: { text: TEAMS_TEXT, fromMatchTime: true } }));
    expect(r?.outcome).toBe("hq-only-organisers");
  });

  it("in Turkish, the club's organisers named in Turkish", async () => {
    const r = await ask("@Match Time Maj ile Kieran'ı değiştir", "balancer", player({ org: { ...ORG, language: "tr" } }));
    expect(r?.replyText).toBe("Bunu yalnızca Hamzah ya da Raihan değiştirebilir.");
  });

  it("the organisers are the club's current owners and admins", async () => {
    await ask("@Match Time swap Maj and Kieran", "balancer", player());
    expect(dbMock.membership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: "org-fnf", leftAt: null, role: { in: ["OWNER", "ADMIN"] }, guestMatchId: null } }),
    );
  });

  it.each([
    ["If you dont have anyone by later today ill play", "self_att"],
    ["shall we swap Maj and Kieran?", "none"],
    ["Matchtime has done it according to ratings", "unsure"],
  ])("their chat, not addressed to MatchTime (%s): silent", async (text, route) => {
    expect(await ask(text, route, player())).toBeNull();
    expect(dbMock.membership.findMany).not.toHaveBeenCalled();
  });

  // 2026-10-20 (Kemal): a request the router reads as one only an organiser
  // may make gets the line whether or not MatchTime was tagged.
  it.each([
    ["ask the group for a player", "ask_group"],
    ["make the fee 6 pounds", "admin_ops"],
  ])("untagged %s (%s): not done, the same one line", async (text, route) => {
    const r = await ask(text, route, player());
    expect(r).toEqual({ route, outcome: "hq-only-organisers", replyText: ONLY });
    expect(teams.handleTeamCommand).not.toHaveBeenCalled();
    expect(groupAsk.askPlayersGroup).not.toHaveBeenCalled();
    expect(requests.length).toBe(1); // the router only
  });

  // 2026-10-29, FNF HQ: a player's "Akram & maj in the same team" (17:32)
  // and "We going with these teams right?" (20:33), untagged and asked of
  // nobody, each got "Only Hamzah, Raihan, Imz or Kemal can change that."
  // Talk about the teams is theirs; only a request TO MatchTime gets the line.
  it.each([
    ["Akram & maj in the same team"],
    ["We going with these teams right?"],
    ["swap Maj and Kieran"],
  ])("untagged teams talk from a player (%s): silent, nothing read, nothing done", async (text) => {
    expect(await ask(text, "balancer", player())).toBeNull();
    expect(teams.handleTeamCommand).not.toHaveBeenCalled();
    expect(requests.length).toBe(1); // the router only
  });

  it("tagged, and the router cannot tell what it is: the one line, never the attendance engine", async () => {
    const r = await ask("@Match Time can you sort it", "unsure", player());
    expect(r?.outcome).toBe("hq-not-understood");
    expect(squad.handleAdminSquadChange).not.toHaveBeenCalled();
  });
});

// WHO PLAYS IS OPEN TO EVERYONE IN THE CLUB IN HQ (2026-10-20, Kemal and
// FNF's admin Raihan). FNF HQ: Abdul-Hafeez, a PLAYER, wrote "Naim is out"
// and nothing happened. A member of the club, whatever their role, now
// changes attendance there exactly as an organiser does, as themselves;
// everything else that changes the club stays the organisers'.
describe("a member of the club who is not an organiser", () => {
  const ONLY = "Only Hamzah or Raihan can change that.";
  const member = (over: Partial<Parameters<typeof understandAdminMessage>[0]> = {}) => ({
    senderUserId: "u-ah",
    organiser: false,
    member: true,
    senderName: "Abdul-Hafeez",
    ...over,
  });

  it.each([
    ["Naim is out", "other_att"],
    ["@Match Time Naim IN", "other_att"],
    ["put Bilal on the bench", "other_att"],
    ["I'm in", "self_att"],
  ])("the incident and its kin (%s, %s): the attendance engine, as the sender", async (text, route) => {
    const r = await ask(text, route, member());
    expect(r?.outcome).toBe("squad-changed");
    expect(squad.handleAdminSquadChange).toHaveBeenCalledWith(expect.objectContaining({ route, text, senderUserId: "u-ah", senderName: "Abdul-Hafeez" }));
  });

  it("a list of names with IN: read as structured data, as an organiser's is", async () => {
    await ask("Imti \nRafi \nAH\n\nIn", "none", member());
    expect(requests).toHaveLength(0);
    expect(squad.handleAdminSquadChange).toHaveBeenCalledWith(expect.objectContaining({ route: "other_att", senderUserId: "u-ah" }));
  });

  it("tagged, and the router cannot tell what it is: the attendance engine is tried, as for an organiser", async () => {
    await ask("@Match Time Naim not coming", "unsure", member());
    expect(squad.handleAdminSquadChange).toHaveBeenCalledWith(expect.objectContaining({ route: "unsure", senderUserId: "u-ah" }));
  });

  it("a monthly club: the one line, as for an organiser", async () => {
    const r = await ask("Naim is out", "other_att", member({ org: { ...ORG, squadMode: "monthly" } }));
    expect(r?.outcome).toBe("hq-not-here");
    expect(squad.handleAdminSquadChange).not.toHaveBeenCalled();
  });

  it.each([
    ["@Match Time swap Maj and Kieran", "balancer"],
    ["@Match Time ask the group for a player", "ask_group"],
    ["@Match Time yes", "approve"],
  ])("%s (%s): still the organisers', one line naming who can", async (text, route) => {
    const r = await ask(text, route, member());
    expect(r).toEqual({ route, outcome: "hq-only-organisers", replyText: ONLY });
    expect(teams.handleTeamCommand).not.toHaveBeenCalled();
    expect(teams.answerTeamsYes).not.toHaveBeenCalled();
    expect(groupAsk.askPlayersGroup).not.toHaveBeenCalled();
    expect(squad.handleAdminSquadChange).not.toHaveBeenCalled();
  });
});

// Free places (2026-10-16, review of #301): "Bilal washed the bibs, he's
// free this week" routes admin_ops; the SHARED admin extractor reads
// fee_waiver, who, the day and undo; MatchTime ASKS (fee-waiver.ts
// proposeFeeFreeInHq) and an organiser's YES applies it.
describe("a free place, asked for in HQ in the organisers' own words, given on YES", () => {
  const free = (facts: Record<string, unknown> = {}) => ({
    routerModel: routeTo("admin_ops"),
    extractorModel: adminFacts({ action: "fee_waiver", coveredRefs: ["Bilal"], ...facts }),
  });
  const ASKED_TEXT = "Make Bilal Ahmed free for Fri 16 Oct? Reply YES.";
  beforeEach(() => {
    feeWaiver.proposeFeeFreeInHq.mockResolvedValue({ outcome: "fee-free-asked", replyText: ASKED_TEXT });
    feeWaiver.answerFeeProposalYes.mockResolvedValue({
      outcome: "fee-free",
      replyText: "Free place for Fri 16 Oct: Bilal Ahmed. No pay link and no reminders to pay.",
    });
    // No teams waiting in these cases, so the only question is the free place's.
    dbMock.adminTeamProposal.findFirst.mockResolvedValue(null);
    hqLog.hqLogSince.mockResolvedValue([]);
  });

  it("an organiser, untagged: MatchTime ASKS (nothing written here), with the day and the undo flag read", async () => {
    const r = await ask("Bilal washed the bibs, he's free this week", "admin_ops", { deps: free() });
    expect(r).toEqual({ route: "admin_ops", outcome: "fee-free-asked", replyText: ASKED_TEXT });
    expect(feeWaiver.proposeFeeFreeInHq).toHaveBeenCalledWith({
      orgId: "org-fnf",
      lang: "en",
      refs: ["Bilal"],
      undo: false,
      dayPhrase: null,
      senderUserId: "u-admin",
      messageId: "wa-9",
      now: NOW,
    });
    expect(feeWaiver.answerFeeProposalYes).not.toHaveBeenCalled();
    expect(requests).toHaveLength(2);
    expect(requests[1].system).toContain('"fee_waiver"');
  });

  it("'Bilal isn't free after all, next Friday': undo and the named day reach the proposal", async () => {
    await ask("Bilal isn't free after all next Friday", "admin_ops", { deps: free({ undo: true, matchDay: "next Friday" }) });
    expect(feeWaiver.proposeFeeFreeInHq).toHaveBeenCalledWith(expect.objectContaining({ undo: true, dayPhrase: "next Friday" }));
  });

  it("the money collector, not an admin, may ask in HQ (item 8)", async () => {
    const r = await ask("Bilal is free this week", "admin_ops", {
      deps: free(),
      org: { ...ORG, paymentHolderId: "u-col" },
      senderUserId: "u-col",
      organiser: false,
      senderName: "Colin",
    });
    expect(r?.outcome).toBe("fee-free-asked");
    expect(feeWaiver.proposeFeeFreeInHq).toHaveBeenCalledWith(expect.objectContaining({ senderUserId: "u-col" }));
  });

  it("someone in HQ who is not an organiser nor the collector, tagged: the #297 line, nothing asked", async () => {
    const r = await ask("@Match Time Bilal is free this week", "admin_ops", {
      deps: free(),
      senderUserId: "u-kemal",
      organiser: false,
      senderName: "Kemal",
    });
    expect(r).toEqual({ route: "admin_ops", outcome: "hq-only-organisers", replyText: "Only Hamzah or Raihan can change that." });
    expect(feeWaiver.proposeFeeFreeInHq).not.toHaveBeenCalled();
  });

  it("not an organiser, untagged: the line naming who can (2026-10-20), and the extractor is never asked", async () => {
    const r = await ask("Bilal is free this week", "admin_ops", { deps: free(), senderUserId: "u-kemal", organiser: false });
    expect(r?.outcome).toBe("hq-only-organisers");
    expect(feeWaiver.proposeFeeFreeInHq).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  it("an organiser's other instruction on admin_ops: still the one line, never a free place", async () => {
    const r = await ask("@Match Time remind me on Monday", "admin_ops", { deps: free({ action: "reminder", coveredRefs: [], phrase: "on Monday" }) });
    expect(r?.outcome).toBe("hq-not-here");
    expect(feeWaiver.proposeFeeFreeInHq).not.toHaveBeenCalled();
  });

  const WAITING = { ref: "fee:fp1", kind: "fee" as const, day: "Fri 16 Oct", names: "Bilal Ahmed", undo: false, askedAt: ASKED };
  const asked = () => ({ waMessageId: "mt:fee:fp1:1", fromMatchTime: true, senderUserId: null, text: ASKED_TEXT, askRef: "fee:fp1", createdAt: ASKED });

  it("the next message is YES: the free place is given (the safe-YES rule)", async () => {
    feeWaiver.feeProposalsAwaiting.mockResolvedValue([WAITING]);
    hqLog.hqLogSince.mockResolvedValue([asked()]);
    const r = await ask("yes", "approve");
    expect(r).toEqual({ route: "approve", outcome: "fee-free", replyText: "Free place for Fri 16 Oct: Bilal Ahmed. No pay link and no reminders to pay." });
    expect(feeWaiver.answerFeeProposalYes).toHaveBeenCalledWith({ orgId: "org-fnf", proposalId: "fp1", userId: "u-admin", lang: "en", now: NOW });
    // The router was told what waits.
    expect(requests[0].user).toContain("WAITING: YES to give Bilal Ahmed a free place for Fri 16 Oct, asked at 10:00.");
  });

  it("a YES after other chat: asks once whether it is for the free place, nothing given", async () => {
    feeWaiver.feeProposalsAwaiting.mockResolvedValue([WAITING]);
    hqLog.hqLogSince.mockResolvedValue([asked(), orgRow(new Date("2026-10-16T09:05:00Z"))]);
    const r = await ask("yes", "approve");
    expect(r).toEqual({ route: "approve", outcome: "hq-confirm-asked", replyText: "Is that YES to the free place for Bilal Ahmed on Fri 16 Oct?" });
    expect(feeWaiver.answerFeeProposalYes).not.toHaveBeenCalled();
  });

  it("the collector's YES to the free place question is taken (item 8)", async () => {
    feeWaiver.feeProposalsAwaiting.mockResolvedValue([WAITING]);
    hqLog.hqLogSince.mockResolvedValue([asked()]);
    const r = await ask("yes", "approve", { org: { ...ORG, paymentHolderId: "u-col" }, senderUserId: "u-col", organiser: false, senderName: "Colin" });
    expect(r?.outcome).toBe("fee-free");
    expect(feeWaiver.answerFeeProposalYes).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-col" }));
  });

  it("the collector's YES to the TEAMS is not theirs to give: the #297 line", async () => {
    dbMock.adminTeamProposal.findFirst.mockResolvedValue({ matchId: "m1", askedAt: ASKED, state: "proposed" });
    hqLog.hqLogSince.mockResolvedValue([mtRow(ASKED, "teams:m1")]);
    const r = await ask("@Match Time yes", "approve", { org: { ...ORG, paymentHolderId: "u-col" }, senderUserId: "u-col", organiser: false, senderName: "Colin" });
    expect(r?.outcome).toBe("hq-only-organisers");
    expect(teams.answerTeamsYes).not.toHaveBeenCalled();
  });
});

// A partner club's ask in HQ and #297 (merge of main, 2026-10-16): only an
// organiser's YES posts it, and the organiser is who is recorded.
describe("a partner club's ask waiting for this club's YES", () => {
  beforeEach(() => {
    partnerAsk.partnerAsksAwaitingApproval.mockResolvedValue([
      { askId: "ask1", askedAt: ASKED, askerName: "Sutton FC", matchDate: new Date("2026-10-16T19:30:00Z") },
    ]);
    partnerAsk.answerPartnerAskYes.mockResolvedValue({ outcome: "xask-approved", replyText: "Done." });
  });

  it("a player's YES posts nothing: the one line naming who can", async () => {
    const r = await ask("@Match Time yes", "approve", { senderUserId: "u-kemal", organiser: false, senderName: "Kemal" });
    expect(r?.outcome).toBe("hq-only-organisers");
    expect(partnerAsk.answerPartnerAskYes).not.toHaveBeenCalled();
  });

  it("an organiser's YES, the next message after the question: posted, approved by that organiser", async () => {
    hqLog.hqLogSince.mockResolvedValue([
      { waMessageId: "mt:xask:ask1:1", fromMatchTime: true, senderUserId: null, text: "🤝 *Sutton FC* ask if one of your players can play", askRef: "xask:ask1", createdAt: ASKED },
    ]);
    const r = await ask("yes", "approve");
    expect(partnerAsk.answerPartnerAskYes).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-fnf", askId: "ask1", userId: "u-admin" }));
    expect(r?.outcome).toBe("xask-approved");
  });
});

describe("score: the players' group's score handling, with HQ's context (2026-10-16)", () => {
  it("an organiser's score goes to the shared score handler, addressed or not", async () => {
    const r = await ask("Yellow won 7-4", "score");
    expect(r).toEqual({ route: "score", outcome: "hq-score-saved", replyText: "Score saved: Yellow 7, Red 4." });
    expect(hqScore.answerHqScore).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-fnf", lang: "en", messageId: "wa-9", body: "Yellow won 7-4", senderUserId: "u-admin", organiser: true, addressed: false, now: NOW }),
    );
  });

  it("anyone else: handed over as not an organiser; a change they may not make gets the organisers' line", async () => {
    hqScore.answerHqScore.mockResolvedValue("organisers-only");
    const r = await ask("@Match Time no it was 7-5", "score", { organiser: false, senderUserId: "u-p" });
    expect(hqScore.answerHqScore).toHaveBeenCalledWith(expect.objectContaining({ organiser: false, addressed: true }));
    expect(r).toEqual({ route: "score", outcome: "hq-only-organisers", replyText: "Only Hamzah or Raihan can change that." });
  });

  it("nothing to say: silent", async () => {
    hqScore.answerHqScore.mockResolvedValue(null);
    expect(await ask("7-4 lads", "score")).toBeNull();
  });

  it("the router is shown the score MatchTime is waiting for", async () => {
    hqScore.hqScoreRouting.mockResolvedValue({
      waiting: { kind: "result", day: "Thu 15 Oct", labels: ["Red", "Yellow"] },
      scoreAnswerIds: new Set(),
      scoreCorrectionIds: new Set(),
    });
    await ask("Yellow won 7-4", "score");
    expect(requests[0].user).toContain("WAITING: the final score of Thu 15 Oct's match, Red against Yellow.");
  });

  it("a scoreline the router could not place (unsure) while a score is waiting: the score handling reads it", async () => {
    hqScore.hqScoreRouting.mockResolvedValue({
      waiting: { kind: "result", day: "Thu 15 Oct", labels: ["Kırmızı", "Sarı"] },
      scoreAnswerIds: new Set(),
      scoreCorrectionIds: new Set(),
    });
    hqScore.answerHqScore.mockResolvedValue({ outcome: "hq-score-asked", replyText: "Bundan son skoru çıkaramadım." });
    const r = await ask("7-4 mü 7-5 mi emin değilim", "unsure");
    expect(r).toEqual({ route: "score", outcome: "hq-score-asked", replyText: "Bundan son skoru çıkaramadım." });
    expect(squad.handleAdminSquadChange).not.toHaveBeenCalled();
  });

  it("unsure with no score waiting, or with no scoreline: as before, never the score handling", async () => {
    expect(await ask("7-4 mü 7-5 mi emin değilim", "unsure")).toBeNull();
    hqScore.hqScoreRouting.mockResolvedValue({
      waiting: { kind: "result", day: "Thu 15 Oct", labels: ["Red", "Yellow"] },
      scoreAnswerIds: new Set(),
      scoreCorrectionIds: new Set(),
    });
    expect(await ask("see you at 21:00", "unsure")).toBeNull();
    expect(hqScore.answerHqScore).not.toHaveBeenCalled();
  });

  it('an answer to MatchTime\'s open "which team won?" goes to score whatever the router says', async () => {
    hqScore.hqScoreRouting.mockResolvedValue({ waiting: null, scoreAnswerIds: new Set(["wa-9"]), scoreCorrectionIds: new Set() });
    const r = await ask("Yellow", "none");
    expect(r?.route).toBe("score");
    expect(hqScore.answerHqScore).toHaveBeenCalledWith(expect.objectContaining({ body: "Yellow" }));
  });
});

// Man of the Match picked by the organisers (2026-10-18). The live check
// showed the router calling "MoM was Naim" approve under the WAITING line.
describe("Man of the Match, where the organisers pick it", () => {
  const momWaiting = () =>
    hqScore.hqScoreRouting.mockResolvedValue({ waiting: { kind: "mom", day: "Fri 16 Oct" }, scoreAnswerIds: new Set(), scoreCorrectionIds: new Set() });
  const nothingPending = () => {
    dbMock.adminTeamProposal.findFirst.mockResolvedValue(null);
    partnerAsk.partnerAsksAwaitingApproval.mockResolvedValue([]);
    hqLog.hqLogSince.mockResolvedValue([]);
  };
  const PICK_ORG = { ...ORG, momChosenBy: "organisers" };

  it("the routing is told the organisers pick it", async () => {
    await ask("MoM was Naim", "score", { org: PICK_ORG });
    expect(hqScore.hqScoreRouting).toHaveBeenCalledWith(expect.objectContaining({ momByOrganisers: true }));
    await ask("MoM was Naim", "score");
    expect(hqScore.hqScoreRouting).toHaveBeenLastCalledWith(expect.objectContaining({ momByOrganisers: false }));
  });

  it("approve with nothing to approve, while the result waits: the score handling reads it", async () => {
    nothingPending();
    momWaiting();
    hqScore.answerHqScore.mockResolvedValue({ outcome: "hq-mom-saved", replyText: "Man of the Match: Naim Khan." });
    expect(await ask("MoM was Naim", "approve", { org: PICK_ORG })).toEqual({ route: "score", outcome: "hq-mom-saved", replyText: "Man of the Match: Naim Khan." });
  });

  it("a real YES with nothing to approve: when the score handling owns nothing, the YES rules decide, as before (silent)", async () => {
    nothingPending();
    momWaiting();
    hqScore.answerHqScore.mockResolvedValue(null);
    expect(await ask("yes", "approve", { org: PICK_ORG })).toBeNull();
    expect(hqScore.answerHqScore).toHaveBeenCalledTimes(1);
  });

  it("approve while the teams wait for a YES: the YES rules, never the score", async () => {
    momWaiting();
    expect((await ask("looks good, go", "approve", { org: PICK_ORG }))?.outcome).toBe("teams-final");
    expect(hqScore.answerHqScore).not.toHaveBeenCalled();
  });

  it("a reply quoting MatchTime's Man of the Match question goes to the score handling, whatever the router says", async () => {
    const asked = "Score saved: Yellow 7, Red 4. Who was Man of the Match?";
    hqLog.hqLogSince.mockResolvedValue([mtRow(ASKED, "mom:m1", asked)]);
    hqScore.answerHqScore.mockResolvedValue({ outcome: "hq-mom-saved", replyText: "Man of the Match: Naim Khan." });
    const r = await ask("Naim", "other_att", { org: PICK_ORG, quoted: { text: asked, fromMatchTime: true } });
    expect(r).toEqual({ route: "score", outcome: "hq-mom-saved", replyText: "Man of the Match: Naim Khan." });
    expect(squad.handleAdminSquadChange).not.toHaveBeenCalled();
  });

  it("the same reply in a club whose players vote: unchanged, an attendance change", async () => {
    const asked = "Score saved: Yellow 7, Red 4. Who was Man of the Match?";
    hqLog.hqLogSince.mockResolvedValue([mtRow(ASKED, "mom:m1", asked)]);
    expect((await ask("Naim", "other_att", { quoted: { text: asked, fromMatchTime: true } }))?.outcome).toBe("squad-changed");
  });
});

describe("slice S6: an organiser asks MatchTime to ask the partner clubs", () => {
  const recruitFromPartners = (clubRef: string) =>
    adminFacts({ action: "recruit", undo: false, matchDay: "", playersFrom: "partners", clubRef, toMatchTime: true });

  const SUTTON = { partnershipId: "p1", partnerOrgId: "sutton", name: "Sutton FC" };

  it("the router's turn is the same with or without partner clubs", async () => {
    await ask("ask Sutton if anyone can play", "none");
    partnerWords.activePartnerChoices.mockResolvedValue([SUTTON]);
    await ask("ask Sutton if anyone can play", "none");
    expect(requests[1].user).toBe(requests[0].user);
  });

  it("ask_group, tagged, a club with no partner: the players' group ask; the extractor is read (L10: is it the pool?)", async () => {
    const deps = { routerModel: routeTo("ask_group"), extractorModel: recruitFromPartners("Sutton") };
    const r = await ask("@Match Time ask Sutton if anyone can play tonight", "ask_group", { deps });
    expect(r?.outcome).toBe("group-asked");
    expect(requests.map((q) => q.label)).toEqual(["router", "extractor:admin"]);
    expect(partnerWords.askPartnersFromWords).not.toHaveBeenCalled();
  });

  it("ask_group, a partnered club, another club meant: the partner ask, not the players' group", async () => {
    partnerWords.activePartnerChoices.mockResolvedValue([SUTTON]);
    const deps = { routerModel: routeTo("ask_group"), extractorModel: recruitFromPartners("Sutton") };
    const r = await ask("ask Sutton if anyone can play tonight", "ask_group", { deps });
    expect(partnerWords.askPartnersFromWords).toHaveBeenCalledWith(expect.objectContaining({ via: "hq", clubRef: "Sutton", requestedByUserId: "u-admin" }));
    expect(r).toEqual({ route: "ask_group", outcome: "xask-words-asked", replyText: "I've asked *Sutton FC*'s organisers." });
    expect(groupAsk.askPlayersGroup).not.toHaveBeenCalled();
  });

  it("ask_group, a partnered club, the club's own group meant: the players' group ask as before", async () => {
    partnerWords.activePartnerChoices.mockResolvedValue([SUTTON]);
    const deps = { routerModel: routeTo("ask_group"), extractorModel: adminFacts({ action: "recruit", toMatchTime: true }) };
    const r = await ask("gruba sor, oynayabilecek var mı", "ask_group", { deps });
    expect(r?.outcome).toBe("group-asked");
    expect(partnerWords.askPartnersFromWords).not.toHaveBeenCalled();
  });

  it("ask_group, tagged, a partnered club, the extractor failing: the players' group ask as before", async () => {
    partnerWords.activePartnerChoices.mockResolvedValue([SUTTON]);
    const router = routeTo("ask_group");
    const broken: PipelineModel = { name: "broken", async complete() { throw new Error("529"); } };
    const r = await ask("@Match Time ask in the group if anyone is free", "ask_group", { deps: { routerModel: router, extractorModel: broken } });
    expect(r?.outcome).toBe("group-asked");
  });

  it("admin_ops, recruit from a partner club: the shared door, via hq, one reply", async () => {
    const deps = { routerModel: routeTo("admin_ops"), extractorModel: recruitFromPartners("Sutton") };
    const r = await ask("ask Sutton if anyone can play tonight", "admin_ops", { deps });
    expect(partnerWords.askPartnersFromWords).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-fnf", requestedByUserId: "u-admin", via: "hq", clubRef: "Sutton", lang: "en", now: NOW }),
    );
    expect(r).toEqual({ route: "admin_ops", outcome: "xask-words-asked", replyText: "I've asked *Sutton FC*'s organisers." });
    expect(groupAsk.askPlayersGroup).not.toHaveBeenCalled();
  });

  it("no club named: clubRef null, every partner", async () => {
    const deps = { routerModel: routeTo("admin_ops"), extractorModel: recruitFromPartners("") };
    await ask("search for players from our partner groups", "admin_ops", { deps });
    expect(partnerWords.askPartnersFromWords.mock.calls[0][0].clubRef).toBeNull();
  });

  it("the money collector who is not an organiser may not ask: the one line naming who can", async () => {
    const deps = { routerModel: routeTo("admin_ops"), extractorModel: recruitFromPartners("Sutton") };
    const r = await ask("ask Sutton if anyone can play", "admin_ops", {
      deps,
      organiser: false,
      member: true,
      senderUserId: "u-collector",
      org: { ...ORG, paymentHolderId: "u-collector" },
    });
    expect(r?.outcome).toBe("hq-only-organisers");
    expect(partnerWords.askPartnersFromWords).not.toHaveBeenCalled();
  });

  it("a recruit of the club's own players is still not done from HQ, unchanged", async () => {
    const deps = { routerModel: routeTo("admin_ops"), extractorModel: adminFacts({ action: "recruit", lookbackMatches: 5, toMatchTime: true }) };
    const r = await ask("message the lads from the last 5 games", "admin_ops", { deps });
    expect(r?.outcome).toBe("hq-not-here");
    expect(partnerWords.askPartnersFromWords).not.toHaveBeenCalled();
  });
});

describe("cancelling a match from HQ, and putting it back on (2026-10-22)", () => {
  const deps = (facts: Record<string, unknown>) => ({ routerModel: routeTo("admin_ops"), extractorModel: adminFacts(facts) });
  const DONE = "Done: Friday Night Football, Fri 23 Oct at 20:30 is cancelled. I've told the players' group.";
  beforeEach(() => {
    matchCancel.hqCancelOrRestore.mockResolvedValue({ outcome: "hq-match-cancelled", replyText: DONE });
    dbMock.adminTeamProposal.findFirst.mockResolvedValue(null);
    hqLog.hqLogSince.mockResolvedValue([]);
  });

  it("an organiser tags MatchTime to cancel: the next match is cancelled and HQ is told", async () => {
    const r = await ask("@Match Time cancel the session", "admin_ops", { deps: deps({ action: "cancel_match", matchDay: "" }) });
    expect(r).toEqual({ route: "admin_ops", outcome: "hq-match-cancelled", replyText: DONE });
    expect(matchCancel.hqCancelOrRestore).toHaveBeenCalledWith({ orgId: "org-fnf", lang: "en", mode: "cancel", dayPhrase: null, pastGame: false, addressed: true, now: NOW });
  });

  it("untagged (Kemal: it only acts when an admin tags it): nothing written, nothing said", async () => {
    for (const [text, action] of [["Cancel the session", "cancel_match"], ["storm, no game Friday", "cancel_match"], ["it's back on", "restore_match"]]) {
      expect(await ask(text, "admin_ops", { deps: deps({ action }) })).toBeNull();
    }
    expect(matchCancel.hqCancelOrRestore).not.toHaveBeenCalled();
    expect(hqLog.recordMatchTimeLine).not.toHaveBeenCalled();
  });

  it("in Turkish, with the day named", async () => {
    await ask("@Match Time cuma maçı iptal et", "admin_ops", { org: { ...ORG, language: "tr" }, deps: deps({ action: "cancel_match", matchDay: "cuma" }) });
    expect(matchCancel.hqCancelOrRestore).toHaveBeenCalledWith(expect.objectContaining({ lang: "tr", mode: "cancel", dayPhrase: "cuma", addressed: true }));
  });

  it("a game that did not happen (2026-10-28): the extractor's pastGame reaches the one core", async () => {
    await ask("@Match Time Tuesday's game didn't happen", "admin_ops", { deps: deps({ action: "cancel_match", matchDay: "Tuesday", pastGame: true }) });
    expect(matchCancel.hqCancelOrRestore).toHaveBeenCalledWith(expect.objectContaining({ mode: "cancel", dayPhrase: "Tuesday", pastGame: true, addressed: true }));
  });

  it("'it's back on': the cancelled match is put back on", async () => {
    await ask("@Match Time it's back on, uncancel Friday", "admin_ops", { deps: deps({ action: "restore_match", matchDay: "Friday" }) });
    expect(matchCancel.hqCancelOrRestore).toHaveBeenCalledWith(expect.objectContaining({ mode: "restore", dayPhrase: "Friday" }));
  });

  it("a member who is not an organiser: nothing is cancelled, and the model is not asked", async () => {
    const r = await ask("@Match Time cancel the session", "admin_ops", { organiser: false, member: true, senderUserId: "u-player", deps: deps({ action: "cancel_match" }) });
    expect(r?.outcome).toBe("hq-only-organisers");
    expect(matchCancel.hqCancelOrRestore).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  it("the money collector who is not an admin: may give a free place, may not cancel", async () => {
    const r = await ask("@Match Time cancel the session", "admin_ops", {
      org: { ...ORG, paymentHolderId: "u-col" },
      organiser: false,
      member: true,
      senderUserId: "u-col",
      deps: deps({ action: "cancel_match" }),
    });
    expect(r?.outcome).toBe("hq-only-organisers");
    expect(matchCancel.hqCancelOrRestore).not.toHaveBeenCalled();
  });

  it("a monthly club: cancelled through the same core as a weekly one (Kemal: every admin feature by tagging)", async () => {
    await ask("@Match Time cancel the session", "admin_ops", { org: { ...ORG, squadMode: "monthly" }, deps: deps({ action: "cancel_match" }) });
    expect(matchCancel.hqCancelOrRestore).toHaveBeenCalledWith(expect.objectContaining({ mode: "cancel" }));
  });

  it("a monthly club: put back on through the same core", async () => {
    await ask("@Match Time it's back on", "admin_ops", { org: { ...ORG, squadMode: "monthly" }, deps: deps({ action: "restore_match" }) });
    expect(matchCancel.hqCancelOrRestore).toHaveBeenCalledWith(expect.objectContaining({ mode: "restore" }));
  });

  it("put back on with nothing cancelled, when the owner says nothing: silent", async () => {
    matchCancel.hqCancelOrRestore.mockResolvedValue(null);
    expect(await ask("@Match Time game's on lads", "admin_ops", { deps: deps({ action: "restore_match" }) })).toBeNull();
  });
});

describe("'I can't do that from this group' is one line, and not repeated (2026-10-22)", () => {
  const other = { routerModel: routeTo("admin_ops"), extractorModel: adminFacts({ action: "other" }) };
  const notHereRow = (at: Date): HqLogRow => ({ waMessageId: `mt:said:not-here:${at.getTime()}:x`, fromMatchTime: true, senderUserId: null, text: "I can't do that from this group.", askRef: null, createdAt: at });
  beforeEach(() => dbMock.adminTeamProposal.findFirst.mockResolvedValue(null));

  it("the first time: the short line, with no help advert, and it is recorded", async () => {
    hqLog.hqLogSince.mockResolvedValue([]);
    const r = await ask("@Match Time change the kit colour", "admin_ops", { deps: other });
    expect(r?.replyText).toBe("I can't do that from this group.");
    expect(hqLog.recordMatchTimeLine).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-fnf", idPrefix: "mt:said:not-here:" }));
  });

  it("said an hour ago: silent, and nothing recorded", async () => {
    hqLog.hqLogSince.mockResolvedValue([notHereRow(new Date(NOW.getTime() - 60 * 60 * 1000))]);
    const r = await ask("@Match Time change the kit colour", "admin_ops", { deps: other });
    expect(r).toEqual({ route: "admin_ops", outcome: "hq-not-here", replyText: null });
    expect(hqLog.recordMatchTimeLine).not.toHaveBeenCalled();
  });

  it("said seven hours ago: said again", async () => {
    hqLog.hqLogSince.mockResolvedValue([notHereRow(new Date(NOW.getTime() - 7 * 60 * 60 * 1000))]);
    expect((await ask("@Match Time change the kit colour", "admin_ops", { deps: other }))?.replyText).toBe("I can't do that from this group.");
  });
});

// AN ACTION THAT LEAVES HQ NEEDS TO BE ASKED OF MATCHTIME (2026-10-22).
// FNF HQ 07:22 UTC: Raihan wrote "@89485761081551 can we ask Sutton
// group?". The tag was Kemal, a person. The router sent it to ask_group and
// MatchTime posted "We need 3 more players" in the players' group. Now a
// post in the players' group or an ask to partner clubs happens only when
// the message tags MatchTime, or the admin extractor says it is spoken to
// MatchTime (toMatchTime). Otherwise nothing leaves HQ and nothing is said.
describe("an action that leaves HQ happens only when it is asked of MatchTime (2026-10-22)", () => {
  const INCIDENT = "@89485761081551 can we ask Sutton group?";
  const SUTTON = { partnershipId: "p1", partnerOrgId: "sutton", name: "Sutton FC" };
  const facts = (f: Record<string, unknown>) => adminFacts({ undo: false, matchDay: "", playersFrom: "club", clubRef: "", ...f });

  it("the incident, a club with no partner: the extractor says it is spoken to a person, nothing posted, silent", async () => {
    const deps = { routerModel: routeTo("ask_group"), extractorModel: facts({ action: "recruit", playersFrom: "partners", clubRef: "Sutton", toMatchTime: false }) };
    expect(await ask(INCIDENT, "ask_group", { deps })).toBeNull();
    expect(groupAsk.askPlayersGroup).not.toHaveBeenCalled();
    expect(partnerWords.askPartnersFromWords).not.toHaveBeenCalled();
    // The extractor is told the truth: no tag on the bot.
    const ex = requests.find((r) => r.label === "extractor:admin");
    expect(ex?.user).toContain("THE MESSAGE (from Raihan):");
  });

  it("the incident, a partnered club: no partner ask either", async () => {
    partnerWords.activePartnerChoices.mockResolvedValue([SUTTON]);
    const deps = { routerModel: routeTo("ask_group"), extractorModel: facts({ action: "recruit", playersFrom: "partners", clubRef: "Sutton", toMatchTime: false }) };
    expect(await ask(INCIDENT, "ask_group", { deps })).toBeNull();
    expect(partnerWords.askPartnersFromWords).not.toHaveBeenCalled();
    expect(groupAsk.askPlayersGroup).not.toHaveBeenCalled();
  });

  it("untagged, spoken to MatchTime: the players' group is asked, as before", async () => {
    const deps = { routerModel: routeTo("ask_group"), extractorModel: facts({ action: "recruit", toMatchTime: true }) };
    const r = await ask("ask the group if anyone can play", "ask_group", { deps });
    expect(r?.outcome).toBe("group-asked");
    expect(groupAsk.askPlayersGroup).toHaveBeenCalledTimes(1);
  });

  it("untagged, the extractor failing: nothing leaves HQ (fails closed)", async () => {
    const broken: PipelineModel = { name: "broken", async complete() { throw new Error("529"); } };
    expect(await ask("ask the group if anyone can play", "ask_group", { deps: { routerModel: routeTo("ask_group"), extractorModel: broken } })).toBeNull();
    expect(groupAsk.askPlayersGroup).not.toHaveBeenCalled();
  });

  it("tagged, a club with no partner: asked whatever the extractor says of the addressee (the tag says it)", async () => {
    const deps = { routerModel: routeTo("ask_group"), extractorModel: facts({ action: "recruit", toMatchTime: false }) };
    const r = await ask("@Match Time ask the group if anyone can play", "ask_group", { deps });
    expect(r?.outcome).toBe("group-asked");
    expect(requests.map((q) => q.label)).toEqual(["router", "extractor:admin"]);
  });

  it("tagged, a partnered club: the tag wins over the extractor's toMatchTime", async () => {
    partnerWords.activePartnerChoices.mockResolvedValue([SUTTON]);
    const deps = { routerModel: routeTo("ask_group"), extractorModel: facts({ action: "recruit", playersFrom: "partners", clubRef: "Sutton", toMatchTime: false }) };
    const r = await ask("@Match Time ask Sutton if anyone can play", "ask_group", { deps });
    expect(r?.outcome).toBe("xask-words-asked");
  });

  it("admin_ops, recruit from a partner club, spoken to a person: no partner ask, silent", async () => {
    const deps = { routerModel: routeTo("admin_ops"), extractorModel: facts({ action: "recruit", playersFrom: "partners", clubRef: "Sutton", toMatchTime: false }) };
    expect(await ask(INCIDENT, "admin_ops", { deps })).toBeNull();
    expect(partnerWords.askPartnersFromWords).not.toHaveBeenCalled();
  });

  it.each(["recruit", "stats_blast"])("admin_ops %s, untagged and spoken to the others: silent, not even the one line", async (action) => {
    const deps = { routerModel: routeTo("admin_ops"), extractorModel: facts({ action, toMatchTime: false }) };
    expect(await ask("should we send everyone their stats?", "admin_ops", { deps })).toBeNull();
    expect(hqLog.recordMatchTimeLine).not.toHaveBeenCalled();
  });

  it("what stays in HQ is unchanged: an untagged free place spoken to the others is still asked about", async () => {
    feeWaiver.proposeFeeFreeInHq.mockResolvedValue({ outcome: "fee-asked", replyText: "Bilal plays free on Fri? YES to confirm." });
    const deps = { routerModel: routeTo("admin_ops"), extractorModel: facts({ action: "fee_waiver", coveredRefs: ["Bilal"], toMatchTime: false }) };
    expect((await ask("Bilal washed the bibs, he's free this week", "admin_ops", { deps }))?.outcome).toBe("fee-asked");
  });
});

describe("local player pool L10: asking the pool in HQ, in words and by YES to its notice", () => {
  const fromPool = (f: Record<string, unknown> = {}) =>
    adminFacts({ action: "recruit", undo: false, matchDay: "", playersFrom: "pool", clubRef: "", toMatchTime: true, ...f });
  const POOL_NOTICE = "📋 Fri 16 Oct, 20:00: 6 of 7.\n\n🔎 Or I can ask nearby players from the MatchTime pool (a few near you): reply YES here, or open the match page: https://matchtime.ai/matches/m1";
  const poolWaiting = { ref: "pool-ask:m1", kind: "pool-ask" as const, day: "Fri 16 Oct", askedAt: ASKED };
  const ENV = { MT_POOL_OPEN: "1" };

  it("ask_group, tagged, the extractor reads the pool: the pool is asked in words for the next match, nothing posted", async () => {
    const deps = { routerModel: routeTo("ask_group"), extractorModel: fromPool() };
    const r = await ask("@Match Time ask the pool for a player", "ask_group", { deps, poolEnv: ENV });
    // The ask's own message id: a refusal the club can fix is remembered against it (2026-10-28).
    expect(hqPool.askPoolFromWords).toHaveBeenCalledWith({ orgId: "org-fnf", userId: "u-admin", via: "words", lang: "en", now: NOW, env: ENV, remember: { askMessageId: "wa-9" } });
    expect(r).toEqual({ route: "ask_group", outcome: "hq-pool-asked", replyText: expect.stringMatching(/^🔎 Asking nearby players/) });
    expect(groupAsk.askPlayersGroup).not.toHaveBeenCalled();
    expect(partnerWords.askPartnersFromWords).not.toHaveBeenCalled();
  });

  it("Turkish, untagged but spoken to MatchTime: the same ask", async () => {
    const deps = { routerModel: routeTo("ask_group"), extractorModel: fromPool() };
    expect((await ask("havuzdan bir oyuncu bulur musun", "ask_group", { deps, org: { ...ORG, language: "tr" } }))?.outcome).toBe("hq-pool-asked");
    expect(hqPool.askPoolFromWords).toHaveBeenCalledWith(expect.objectContaining({ via: "words", lang: "tr" }));
  });

  it("the pool wins over partner clubs when the pool is what was asked for", async () => {
    partnerWords.activePartnerChoices.mockResolvedValue([{ partnershipId: "p1", partnerOrgId: "sutton", name: "Sutton FC" }]);
    const deps = { routerModel: routeTo("ask_group"), extractorModel: fromPool() };
    expect((await ask("@Match Time find someone nearby", "ask_group", { deps }))?.outcome).toBe("hq-pool-asked");
    expect(partnerWords.askPartnersFromWords).not.toHaveBeenCalled();
  });

  it("admin_ops, recruit from the pool: the same door", async () => {
    const deps = { routerModel: routeTo("admin_ops"), extractorModel: fromPool() };
    expect((await ask("@Match Time get us a player from the app", "admin_ops", { deps }))?.outcome).toBe("hq-pool-asked");
    expect(hqPool.askPoolFromWords).toHaveBeenCalledWith(expect.objectContaining({ via: "words", userId: "u-admin" }));
  });

  it("untagged and spoken to the others ('shall we try the pool?'): nothing leaves HQ, silent", async () => {
    const deps = { routerModel: routeTo("ask_group"), extractorModel: fromPool({ toMatchTime: false }) };
    expect(await ask("shall we try the pool?", "ask_group", { deps })).toBeNull();
    expect(hqPool.askPoolFromWords).not.toHaveBeenCalled();
    expect(groupAsk.askPlayersGroup).not.toHaveBeenCalled();
  });

  it("someone who is not an organiser: the one line naming who can, the pool never asked", async () => {
    const deps = { routerModel: routeTo("ask_group"), extractorModel: fromPool() };
    const r = await ask("@Match Time ask the pool for a player", "ask_group", { deps, organiser: false, member: true, senderUserId: "u-pete" });
    expect(r?.outcome).toBe("hq-only-organisers");
    expect(hqPool.askPoolFromWords).not.toHaveBeenCalled();
    const viaOps = await ask("@Match Time ask the pool for a player", "admin_ops", { deps: { routerModel: routeTo("admin_ops"), extractorModel: fromPool() }, organiser: false, member: true, senderUserId: "u-pete" });
    expect(viaOps?.outcome).toBe("hq-only-organisers");
    expect(hqPool.askPoolFromWords).not.toHaveBeenCalled();
  });

  it("a monthly club: not from HQ (the one line)", async () => {
    const deps = { routerModel: routeTo("admin_ops"), extractorModel: fromPool() };
    expect((await ask("@Match Time ask the pool", "admin_ops", { deps, org: { ...ORG, squadMode: "monthly" } }))?.outcome).toBe("hq-not-here");
    expect(hqPool.askPoolFromWords).not.toHaveBeenCalled();
  });

  it("ask_group of the club's own group is still the players' group ask (the extractor now always says which)", async () => {
    const deps = { routerModel: routeTo("ask_group"), extractorModel: adminFacts({ action: "recruit", playersFrom: "club", toMatchTime: true }) };
    expect((await ask("@Match Time ask the group if anyone can play", "ask_group", { deps }))?.outcome).toBe("group-asked");
    expect(hqPool.askPoolFromWords).not.toHaveBeenCalled();
  });

  it("the router is shown the pool notice as waiting for a YES", async () => {
    hqPool.poolNoticesAwaiting.mockResolvedValue([poolWaiting]);
    await ask("who has the bibs?", "none", { poolEnv: ENV });
    expect(hqPool.poolNoticesAwaiting).toHaveBeenCalledWith("org-fnf", NOW, "en", ENV);
    expect(requests[0].user).toContain("WAITING: YES to ask nearby players from the MatchTime player pool for Fri 16 Oct");
  });

  it("YES right after the notice: the pool is asked for that notice's match, via notice", async () => {
    dbMock.adminTeamProposal.findFirst.mockResolvedValue(null);
    hqPool.poolNoticesAwaiting.mockResolvedValue([poolWaiting]);
    hqLog.hqLogSince.mockResolvedValue([mtRow(ASKED, "pool-ask:m1", POOL_NOTICE)]);
    const r = await ask("yes", "approve", { poolEnv: ENV });
    expect(hqPool.askPoolFromWords).toHaveBeenCalledWith({ orgId: "org-fnf", matchId: "m1", userId: "u-admin", via: "notice", lang: "en", now: NOW, env: ENV });
    expect(r?.outcome).toBe("hq-pool-asked");
  });

  it("YES quoting the notice, later: the same", async () => {
    dbMock.adminTeamProposal.findFirst.mockResolvedValue(null);
    hqPool.poolNoticesAwaiting.mockResolvedValue([poolWaiting]);
    hqLog.hqLogSince.mockResolvedValue([mtRow(ASKED, "pool-ask:m1", POOL_NOTICE), orgRow(new Date(ASKED.getTime() + 60_000))]);
    const r = await ask("go on then", "approve", { quoted: { text: POOL_NOTICE, fromMatchTime: true } });
    expect(r?.outcome).toBe("hq-pool-asked");
  });

  it("YES after other talk: MatchTime asks once whether it is about the pool, logged as that question", async () => {
    dbMock.adminTeamProposal.findFirst.mockResolvedValue(null);
    hqPool.poolNoticesAwaiting.mockResolvedValue([poolWaiting]);
    hqLog.hqLogSince.mockResolvedValue([mtRow(ASKED, "pool-ask:m1", POOL_NOTICE), orgRow(new Date(ASKED.getTime() + 60_000))]);
    const r = await ask("yes", "approve");
    expect(r).toEqual({ route: "approve", outcome: "hq-confirm-asked", replyText: "Is that YES to asking nearby players from the MatchTime player pool for Fri 16 Oct?" });
    expect(hqLog.recordMatchTimeQuestion).toHaveBeenCalledWith(expect.objectContaining({ askRef: "pool-ask:m1", confirm: true }));
    expect(hqPool.askPoolFromWords).not.toHaveBeenCalled();
  });

  it("the pool notice and the teams both waiting, after talk: asks which, asks nothing of the pool", async () => {
    hqPool.poolNoticesAwaiting.mockResolvedValue([poolWaiting]);
    hqLog.hqLogSince.mockResolvedValue([mtRow(ASKED, "teams:m1"), mtRow(ASKED, "pool-ask:m1", POOL_NOTICE), orgRow(new Date(ASKED.getTime() + 60_000))]);
    const r = await ask("yes", "approve");
    expect(r?.outcome).toBe("hq-confirm-asked");
    expect(hqLog.recordMatchTimeQuestion).toHaveBeenCalledWith(expect.objectContaining({ askRef: "which" }));
    expect(hqPool.askPoolFromWords).not.toHaveBeenCalled();
    expect(teams.answerTeamsYes).not.toHaveBeenCalled();
  });

  it("a YES to the pool notice from someone who is not an organiser: the one line, nothing asked", async () => {
    dbMock.adminTeamProposal.findFirst.mockResolvedValue(null);
    hqPool.poolNoticesAwaiting.mockResolvedValue([poolWaiting]);
    hqLog.hqLogSince.mockResolvedValue([mtRow(ASKED, "pool-ask:m1", POOL_NOTICE)]);
    const r = await ask("yes", "approve", { organiser: false, member: true, senderUserId: "u-pete" });
    expect(r?.outcome).toBe("hq-only-organisers");
    expect(hqPool.askPoolFromWords).not.toHaveBeenCalled();
  });

  it("the pool's waiting items never fail HQ: a read error is nothing waiting", async () => {
    hqPool.poolNoticesAwaiting.mockRejectedValue(new Error("down"));
    expect((await ask("looks good, go", "approve"))?.outcome).toBe("teams-final");
  });
});

describe("L10 follow-up: YES to a guest who wants to join (L8's notice)", () => {
  const NOTICE = "🙋 Sam K played with you on Tue 27 Oct as a guest and wants to join your group. Reply YES here to send them the group's invite link, or tap Send the invite link on their card: https://matchtime.ai/admin/guests?tab=history";
  const join = { ref: "join-request:inv1", kind: "join-request" as const, day: null, names: "Sam K", askedAt: ASKED };
  beforeEach(() => {
    dbMock.adminTeamProposal.findFirst.mockResolvedValue(null);
    hqPool.joinRequestsAwaiting.mockResolvedValue([join]);
    hqLog.hqLogSince.mockResolvedValue([mtRow(ASKED, "join-request:inv1", NOTICE)]);
  });

  it("the router is shown it as waiting", async () => {
    await ask("who has the bibs?", "none");
    expect(hqPool.joinRequestsAwaiting).toHaveBeenCalledWith("org-fnf", NOW);
    expect(requests[0].user).toContain("WAITING: YES to send Sam K, a guest who played here and wants to join, the players' group's invite link");
  });

  it("YES right after the notice: the card's own Send the invite link, by the organiser", async () => {
    const env = { MT_POOL_OPEN: "1" };
    const r = await ask("yes", "approve", { poolEnv: env });
    expect(hqPool.answerJoinRequestInHq).toHaveBeenCalledWith({ orgId: "org-fnf", invitationId: "inv1", actorId: "u-admin", lang: "en", now: NOW, env });
    expect(r).toEqual({ route: "approve", outcome: "hq-join-link-sent", replyText: "✅ Sending Sam K the players' group's invite link." });
  });

  it("answered on the card meanwhile: nothing waiting", async () => {
    hqPool.answerJoinRequestInHq.mockResolvedValue(null);
    expect((await ask("yes", "approve"))?.outcome).toBe("hq-nothing-waiting");
  });

  it("a player's YES: the one line, nothing sent", async () => {
    expect((await ask("yes", "approve", { organiser: false, member: true, senderUserId: "u-pete" }))?.outcome).toBe("hq-only-organisers");
    expect(hqPool.answerJoinRequestInHq).not.toHaveBeenCalled();
  });

  it("with the pool notice waiting too, after talk: asks which, naming both", async () => {
    hqPool.poolNoticesAwaiting.mockResolvedValue([{ ref: "pool-ask:m1", kind: "pool-ask", day: "Fri 16 Oct, 20:00", askedAt: ASKED }]);
    hqLog.hqLogSince.mockResolvedValue([mtRow(ASKED, "pool-ask:m1"), mtRow(ASKED, "join-request:inv1", NOTICE), orgRow(new Date(ASKED.getTime() + 60_000))]);
    const r = await ask("yes", "approve");
    expect(r?.replyText).toBe(
      "Which one is that YES for: asking nearby players from the MatchTime player pool for Fri 16 Oct, 20:00, or sending Sam K the players' group's invite link? Reply YES to that message.",
    );
    expect(hqPool.answerJoinRequestInHq).not.toHaveBeenCalled();
    expect(hqPool.askPoolFromWords).not.toHaveBeenCalled();
  });

  it("never fails HQ: a read error is nothing waiting", async () => {
    hqPool.joinRequestsAwaiting.mockRejectedValue(new Error("down"));
    hqLog.hqLogSince.mockResolvedValue([mtRow(ASKED, "teams:m1")]);
    dbMock.adminTeamProposal.findFirst.mockResolvedValue({ matchId: "m1", askedAt: ASKED, state: "proposed" });
    expect((await ask("looks good, go", "approve"))?.outcome).toBe("teams-final");
  });
});

// 2026-10-28 (Kemal): "try again" after a refusal, and "set the pitch", in
// HQ, by an organiser asking MatchTime. Through the same doors as the
// players' group: the stored ask (refused-ask-retry.ts), the venue lookup
// (venue-from-words.ts). Nothing parsed from the words by code.
describe("try again, and set the pitch, from HQ", () => {
  const STORED: StoredAsk = { facts: { kind: "admin", action: "recruit", partnerClubs: true, pool: true, toMatchTime: true }, at: new Date(NOW.getTime() - 120_000) };
  const hqDeps = (facts: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    routerModel: routeTo("admin_ops"),
    extractorModel: adminFacts(facts),
    latestAskForRetry: vi.fn(async (): Promise<StoredAsk | null> => STORED),
    setVenueFromWords: vi.fn(async () => ({ outcome: "venue-set" as const, replyText: "📍 Done, your pitch is *Goals Sutton*.", set: true })),
    ...over,
  });
  beforeEach(() => {
    dbMock.adminTeamProposal.findFirst.mockResolvedValue(null);
    hqLog.hqLogSince.mockResolvedValue([]);
    partnerWords.activePartnerChoices.mockResolvedValue([{ partnershipId: "p1", partnerOrgId: "o2", name: "Sutton" }]);
    partnerWords.askPartnersFromWords.mockResolvedValue({ outcome: "xask-words-asked", replyText: "Asked Sutton.", asked: 1 });
    hqPool.askPoolFromWords.mockResolvedValue({ outcome: "hq-pool-asked", replyText: "Asked the pool." });
  });

  it("an organiser's tagged try again: the stored ask is made again, partners then the pool", async () => {
    const deps = hqDeps({ action: "retry_ask", toMatchTime: true });
    const r = await ask("@Match Time added the venue location", "admin_ops", { deps });
    expect(deps.latestAskForRetry).toHaveBeenCalledWith({ orgId: "org-fnf", where: "hq", now: NOW });
    expect(partnerWords.askPartnersFromWords).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-fnf", via: "hq", clubRef: null }));
    expect(hqPool.askPoolFromWords).toHaveBeenCalled();
    expect(r?.replyText).toContain("Asked Sutton.");
    expect(r?.replyText).toContain("Asked the pool.");
  });

  it("nothing stored to repeat: one short line, nobody asked", async () => {
    const deps = hqDeps({ action: "retry_ask", toMatchTime: true }, { latestAskForRetry: vi.fn(async (): Promise<StoredAsk | null> => null) });
    const r = await ask("@Match Time done, try again", "admin_ops", { deps });
    expect(r).toEqual({ route: "admin_ops", outcome: "hq-retry-nothing", replyText: "👍 Thanks. There's nothing of mine waiting to try again." });
    expect(partnerWords.askPartnersFromWords).not.toHaveBeenCalled();
    expect(hqPool.askPoolFromWords).not.toHaveBeenCalled();
  });

  it("an organiser names the pitch: set, and the reply names it", async () => {
    const deps = hqDeps({ action: "set_venue", venueName: "Goals Sutton", toMatchTime: true });
    const r = await ask("@Match Time our pitch is Goals Sutton", "admin_ops", { deps });
    expect(deps.setVenueFromWords).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-fnf", userId: "u-admin", words: "Goals Sutton", choice: null, lang: "en" }));
    expect(r).toEqual({ route: "admin_ops", outcome: "hq-venue-set", replyText: "📍 Done, your pitch is *Goals Sutton*." });
  });

  it("a member of HQ who is not an organiser, tagged: the one line naming who can, nothing done", async () => {
    const deps = hqDeps({ action: "set_venue", venueName: "Goals Sutton", toMatchTime: true });
    const r = await ask("@Match Time our pitch is Goals Sutton", "admin_ops", { deps, organiser: false, senderUserId: "u-2" });
    expect(r?.outcome).toBe("hq-only-organisers");
    expect(deps.setVenueFromWords).not.toHaveBeenCalled();
  });

  it("routed ask_group (as the router did for the live case): the stored ask, never a post in the players' group", async () => {
    const deps = { ...hqDeps({ action: "retry_ask", toMatchTime: true }), routerModel: routeTo("ask_group") };
    const r = await ask("@Match Time added the venue location", "ask_group", { deps });
    expect(groupAsk.askPlayersGroup).not.toHaveBeenCalled();
    expect(hqPool.askPoolFromWords).toHaveBeenCalled();
    expect(r?.replyText).toContain("Asked the pool.");
  });

  it("an untagged \"2\" right after MatchTime's list of places: that place of the list's own words, whatever the route", async () => {
    hqLog.hqLogSince.mockResolvedValue([
      { waMessageId: "mt:venue-pick:1", fromMatchTime: true, senderUserId: null, text: "I found more than one place for *Goals Sutton*. Which one is it?", askRef: "venue-pick:Goals Sutton", createdAt: new Date(NOW.getTime() - 60_000) },
    ]);
    const deps = { ...hqDeps({ action: "set_venue", venueName: "", venueChoice: 2, toMatchTime: true }), routerModel: routeTo("none") };
    const r = await ask("2", "none", { deps });
    expect(deps.setVenueFromWords).toHaveBeenCalledWith(expect.objectContaining({ words: "Goals Sutton", choice: 2 }));
    expect(r?.outcome).toBe("hq-venue-set");
  });

  it("routed none, tagged, minutes after the organisers' ask: still the stored ask again", async () => {
    const deps = { ...hqDeps({ action: "retry_ask", toMatchTime: true }), routerModel: routeTo("none") };
    const r = await ask("@Match Time added the venue location", "none", { deps });
    expect(hqPool.askPoolFromWords).toHaveBeenCalled();
    expect(r?.replyText).toContain("Asked the pool.");
  });

  it("routed none with no recent ask: no extra read, the organisers' own conversation as before", async () => {
    const deps = { ...hqDeps({ action: "retry_ask", toMatchTime: true }, { latestAskForRetry: vi.fn(async (): Promise<StoredAsk | null> => null) }), routerModel: routeTo("none") };
    const r = await ask("@Match Time added the venue location", "none", { deps });
    expect(r).toBeNull();
    expect(requests.filter((q) => q.label === "extractor:admin")).toHaveLength(0);
  });

  it("spoken to the others, untagged: their conversation, nothing done or said", async () => {
    const deps = hqDeps({ action: "retry_ask", toMatchTime: false });
    const r = await ask("try again tomorrow lads", "admin_ops", { deps });
    expect(r).toBeNull();
    expect(deps.latestAskForRetry).not.toHaveBeenCalled();
  });
});

// 2026-10-29: a monthly club's organiser pasting the COMING month's list in
// HQ. Read by the monthly reader (a model) here, inside the door, before
// the router; its proposal is the reply.
describe("a monthly club's coming-month list, read inside the door", () => {
  it("an organiser's paste is offered to start the coming month, and its proposal is the reply", async () => {
    monthSeedRead.proposeMonthSeedPaste.mockResolvedValueOnce({ outcome: "month-seed-proposed", replyText: "📋 I read your list for November" });
    const r = await ask("List for November\n1. A\n2. B", "none", { org: { ...ORG, squadMode: "monthly" } });
    expect(monthSeedRead.proposeMonthSeedPaste).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-fnf", text: "List for November\n1. A\n2. B" }));
    expect(r).toEqual({ route: null, outcome: "month-seed-proposed", replyText: "📋 I read your list for November" });
    expect(requests).toEqual([]);
  });

  it("a weekly club, or a member who is not an organiser, is never offered it", async () => {
    monthSeedRead.proposeMonthSeedPaste.mockClear();
    await ask("List for November\n1. A\n2. B", "none");
    expect(monthSeedRead.proposeMonthSeedPaste).not.toHaveBeenCalled();
  });
});

describe("a monthly club's collector answering the paid-claims list, inside the door", () => {
  it("his answer is read here (by the model), and its reply is HQ's", async () => {
    monthPayment.handleCollectorPaidReply.mockResolvedValueOnce({ handled: "month-paid-confirmed", orgId: "org-fnf", replyText: "✅ Confirmed for November: Alex." });
    const r = await ask("1 and 3 are in", "none", { org: { ...ORG, squadMode: "monthly" } });
    expect(monthPayment.handleCollectorPaidReply).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-fnf", text: "1 and 3 are in" }));
    expect(r).toEqual({ route: null, outcome: "month-paid-confirmed", replyText: "✅ Confirmed for November: Alex." });
  });
});
