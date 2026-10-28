/**
 * WHERE THE PLAYERS COME FROM, IN HQ (Kemal, 2026-10-28): "Only if the
 * admin specifically asks for players from the pool, in their own words,
 * can MatchTime do that. If MatchTime ... is in limbo between those two
 * features, MatchTime can ask the admin what they mean."
 *
 * The same harness as `admin-group-understand.test.ts` (the real gate,
 * router parser and admin extractor parser, a STUBBED model behind each,
 * every owner mocked at its boundary), with `ask-source.ts` mocked: what
 * the club has, and MatchTime's logged question.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRequest, PipelineModel } from "../pipeline/llm";
import type { HqLogRow } from "../admin-group-log";
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

// Where the players come from (2026-10-28): what the club has besides its
// own players' group, and MatchTime's question. Neither by default.
const source = vi.hoisted(() => ({
  sourcesAvailable: vi.fn(),
  askWhichSource: vi.fn(),
}));
vi.mock("@/lib/ask-source", () => source);

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
  source.sourcesAvailable.mockResolvedValue({ partners: false, pool: false });
  source.askWhichSource.mockImplementation(async (a: { options: string[] }) => `Who shall I ask for players: ${a.options.join(", ")}?`);
  hqPool.askPoolFromWords.mockResolvedValue({ outcome: "hq-pool-asked", replyText: "🔎 Asking nearby players from the MatchTime player pool for 1 place on Fri 16 Oct, 20:00." });
});


const unsaid = (f: Record<string, unknown> = {}) =>
  adminFacts({ action: "recruit", undo: false, matchDay: "", playersFrom: "unsaid", clubRef: "", toMatchTime: true, ...f });
const from = (playersFrom: string, f: Record<string, unknown> = {}) =>
  adminFacts({ action: "recruit", undo: false, matchDay: "", playersFrom, clubRef: "", toMatchTime: true, ...f });
const BOTH = { partners: true, pool: true };

describe("an ask that does not say where from", () => {
  beforeEach(() => {
    dbMock.adminTeamProposal.findFirst.mockResolvedValue(null);
    hqLog.hqLogSince.mockResolvedValue([]);
  });

  it("partners and the pool: ONE question naming the group, the partners and the pool; nothing asked", async () => {
    source.sourcesAvailable.mockResolvedValue(BOTH);
    const r = await ask("@Match Time we need 2 players for Thursday", "ask_group", { deps: { routerModel: routeTo("ask_group"), extractorModel: unsaid() } });
    expect(r).toEqual({ route: "ask_group", outcome: "hq-ask-source", replyText: "Who shall I ask for players: club, partners, pool?" });
    expect(source.askWhichSource).toHaveBeenCalledWith({ orgId: "org-fnf", lang: "en", options: ["club", "partners", "pool"], now: NOW });
    expect(groupAsk.askPlayersGroup).not.toHaveBeenCalled();
    expect(partnerWords.askPartnersFromWords).not.toHaveBeenCalled();
    expect(hqPool.askPoolFromWords).not.toHaveBeenCalled();
  });

  it("the request read the pool switch as HQ did", async () => {
    source.sourcesAvailable.mockResolvedValue(BOTH);
    const poolEnv = { MT_POOL_OPEN: "1" };
    await ask("@Match Time find us someone", "ask_group", { poolEnv, deps: { routerModel: routeTo("ask_group"), extractorModel: unsaid() } });
    expect(source.sourcesAvailable).toHaveBeenCalledWith("org-fnf", poolEnv);
  });

  it("partners only: the group or the partners, never the pool", async () => {
    source.sourcesAvailable.mockResolvedValue({ partners: true, pool: false });
    await ask("@Match Time 2 kişi lazım", "ask_group", { deps: { routerModel: routeTo("ask_group"), extractorModel: unsaid() } });
    expect(source.askWhichSource.mock.calls[0][0].options).toEqual(["club", "partners"]);
  });

  it("the pool only: the group or the pool, never the partners", async () => {
    source.sourcesAvailable.mockResolvedValue({ partners: false, pool: true });
    await ask("@Match Time bize oyuncu bul", "ask_group", { deps: { routerModel: routeTo("ask_group"), extractorModel: unsaid() } });
    expect(source.askWhichSource.mock.calls[0][0].options).toEqual(["club", "pool"]);
  });

  it("neither: the players' group, as before; no question", async () => {
    const r = await ask("@Match Time find us someone", "ask_group", { deps: { routerModel: routeTo("ask_group"), extractorModel: unsaid() } });
    expect(r?.outcome).toBe("group-asked");
    expect(source.askWhichSource).not.toHaveBeenCalled();
  });

  it("admin_ops: the same question; with neither, the one line as before", async () => {
    source.sourcesAvailable.mockResolvedValue(BOTH);
    const r = await ask("@Match Time we need 2 players for Thursday", "admin_ops", { deps: { routerModel: routeTo("admin_ops"), extractorModel: unsaid() } });
    expect(r?.outcome).toBe("hq-ask-source");
    source.sourcesAvailable.mockResolvedValue({ partners: false, pool: false });
    const none = await ask("@Match Time we need 2 players for Thursday", "admin_ops", { deps: { routerModel: routeTo("admin_ops"), extractorModel: unsaid() } });
    expect(none?.outcome).toBe("hq-not-here");
  });

  it("admin_ops: the money collector who is not an organiser is not asked anything", async () => {
    source.sourcesAvailable.mockResolvedValue(BOTH);
    const r = await ask("@Match Time we need 2 players", "admin_ops", {
      organiser: false,
      member: true,
      senderUserId: "u-col",
      org: { ...ORG, paymentHolderId: "u-col" },
      deps: { routerModel: routeTo("admin_ops"), extractorModel: unsaid() },
    });
    expect(r?.outcome).toBe("hq-only-organisers");
    expect(source.askWhichSource).not.toHaveBeenCalled();
  });

  it("untagged and spoken to the others: nothing asked, nothing said", async () => {
    source.sourcesAvailable.mockResolvedValue(BOTH);
    expect(await ask("we need 2 players for Thursday", "ask_group", { deps: { routerModel: routeTo("ask_group"), extractorModel: unsaid({ toMatchTime: false }) } })).toBeNull();
    expect(source.askWhichSource).not.toHaveBeenCalled();
  });

  it("a source the words named is that source, with no question", async () => {
    source.sourcesAvailable.mockResolvedValue(BOTH);
    partnerWords.activePartnerChoices.mockResolvedValue([{ partnershipId: "p1", partnerOrgId: "sutton", name: "Sutton FC" }]);
    await ask("@Match Time ask the pool", "ask_group", { deps: { routerModel: routeTo("ask_group"), extractorModel: from("pool") } });
    expect(hqPool.askPoolFromWords).toHaveBeenCalledTimes(1);
    await ask("@Match Time ask our partner clubs", "ask_group", { deps: { routerModel: routeTo("ask_group"), extractorModel: from("partners") } });
    expect(partnerWords.askPartnersFromWords).toHaveBeenCalledTimes(1);
    await ask("@Match Time chase the lads", "ask_group", { deps: { routerModel: routeTo("ask_group"), extractorModel: from("club") } });
    expect(groupAsk.askPlayersGroup).toHaveBeenCalledTimes(1);
    expect(source.askWhichSource).not.toHaveBeenCalled();
  });
});

describe("the organiser's answer to MatchTime's question", () => {
  const ASKED_AT = new Date(NOW.getTime() - 2 * 60_000);
  const Q = "Who shall I ask for players: your players' group, your partner clubs, or the MatchTime player pool?";
  const question: HqLogRow = { waMessageId: "mt:ask-source:club+partners+pool:1", fromMatchTime: true, senderUserId: null, text: Q, askRef: "ask-source:club+partners+pool", createdAt: ASKED_AT };
  const theAsk: HqLogRow = { waMessageId: "wa-ask", fromMatchTime: false, senderUserId: "u-admin", text: "@Match Time we need 2 players", askRef: null, createdAt: ASKED_AT };
  beforeEach(() => {
    dbMock.adminTeamProposal.findFirst.mockResolvedValue(null);
    hqLog.hqLogSince.mockResolvedValue([theAsk, question]);
    source.sourcesAvailable.mockResolvedValue(BOTH);
  });

  it("'the pool', the next message: the model reads it against the question, and the pool is asked", async () => {
    const r = await ask("the pool", "none", { deps: { routerModel: routeTo("none"), extractorModel: from("pool") } });
    expect(r?.outcome).toBe("hq-pool-asked");
    expect(hqPool.askPoolFromWords).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-fnf", userId: "u-admin", via: "words" }));
    // The question is what the admin extractor was shown as MatchTime's last post.
    const ex = requests.find((q) => q.label === "extractor:admin");
    expect(ex?.user).toContain(Q);
    expect(source.askWhichSource).not.toHaveBeenCalled();
  });

  it("'partners', whatever the router called it: every partner is asked", async () => {
    const r = await ask("partners", "approve", { deps: { routerModel: routeTo("approve"), extractorModel: from("partners") } });
    expect(r?.outcome).toBe("xask-words-asked");
    expect(partnerWords.askPartnersFromWords).toHaveBeenCalledWith(expect.objectContaining({ via: "hq", clubRef: null, requestedByUserId: "u-admin" }));
  });

  it("'ask Sutton': that partner club only", async () => {
    await ask("ask Sutton", "ask_group", { deps: { routerModel: routeTo("ask_group"), extractorModel: from("partners", { clubRef: "Sutton" }) } });
    expect(partnerWords.askPartnersFromWords).toHaveBeenCalledWith(expect.objectContaining({ clubRef: "Sutton" }));
  });

  it("'the group': the players' group", async () => {
    const r = await ask("gruba sor", "none", { deps: { routerModel: routeTo("none"), extractorModel: from("club") } });
    expect(r?.outcome).toBe("group-asked");
  });

  it("a WhatsApp reply quoting the question, after other chat: still the answer", async () => {
    hqLog.hqLogSince.mockResolvedValue([theAsk, question, { ...theAsk, waMessageId: "wa-x", text: "bibs?", createdAt: new Date(NOW.getTime() - 60_000) }]);
    const r = await ask("havuza", "none", { quoted: { messageId: question.waMessageId, fromMatchTime: true, text: Q }, deps: { routerModel: routeTo("none"), extractorModel: from("pool") } });
    expect(r?.outcome).toBe("hq-pool-asked");
  });

  it("not an answer (a squad change): handled as it always was", async () => {
    const r = await ask("Tom out", "other_att", { deps: { routerModel: routeTo("other_att"), extractorModel: adminFacts({ action: "other" }) } });
    expect(r?.outcome).toBe("squad-changed");
    expect(hqPool.askPoolFromWords).not.toHaveBeenCalled();
  });

  it("somebody spoke in between, not quoting it: not an answer, the organisers' own chat", async () => {
    hqLog.hqLogSince.mockResolvedValue([theAsk, question, { ...theAsk, waMessageId: "wa-x", text: "bibs?", createdAt: new Date(NOW.getTime() - 60_000) }]);
    expect(await ask("the pool", "none", { deps: { routerModel: routeTo("none"), extractorModel: from("pool") } })).toBeNull();
    expect(hqPool.askPoolFromWords).not.toHaveBeenCalled();
  });

  it("someone who is not an organiser: not taken as the answer", async () => {
    expect(await ask("the pool", "none", { organiser: false, member: true, senderUserId: "u-player", deps: { routerModel: routeTo("none"), extractorModel: from("pool") } })).toBeNull();
    expect(hqPool.askPoolFromWords).not.toHaveBeenCalled();
  });

  it("past the window: not an answer", async () => {
    hqLog.hqLogSince.mockResolvedValue([{ ...theAsk, createdAt: new Date(NOW.getTime() - 20 * 60_000) }, { ...question, createdAt: new Date(NOW.getTime() - 20 * 60_000) }]);
    expect(await ask("the pool", "none", { deps: { routerModel: routeTo("none"), extractorModel: from("pool") } })).toBeNull();
  });

  it("still not saying where (\"just find someone\"): the same question again, nothing asked", async () => {
    const r = await ask("just find someone", "ask_group", { deps: { routerModel: routeTo("ask_group"), extractorModel: unsaid() } });
    expect(r?.outcome).toBe("hq-ask-source");
    expect(hqPool.askPoolFromWords).not.toHaveBeenCalled();
    expect(partnerWords.askPartnersFromWords).not.toHaveBeenCalled();
  });
});

describe("several places in one ask (2026-10-28, Friday MT Community)", () => {
  const places = (list: string[], f: Record<string, unknown> = {}) =>
    adminFacts({ action: "recruit", undo: false, matchDay: "", playersFrom: list, clubRef: "", toMatchTime: true, ...f });
  const order: string[] = [];
  beforeEach(() => {
    dbMock.adminTeamProposal.findFirst.mockResolvedValue(null);
    hqLog.hqLogSince.mockResolvedValue([]);
    source.sourcesAvailable.mockResolvedValue(BOTH);
    partnerWords.activePartnerChoices.mockResolvedValue([{ partnershipId: "p1", partnerOrgId: "sutton", name: "Sutton FC" }]);
    order.length = 0;
    partnerWords.askPartnersFromWords.mockImplementation(async () => {
      order.push("partners");
      return { outcome: "xask-words-asked", replyText: "I've asked *Sutton FC*'s organisers.", asked: 1 };
    });
    hqPool.askPoolFromWords.mockImplementation(async () => {
      order.push("pool");
      return { outcome: "hq-pool-asked", replyText: "🔎 The pool joins once the partner clubs have had their hour." };
    });
    groupAsk.askPlayersGroup.mockImplementation(async () => {
      order.push("club");
      return { outcome: "group-asked", replyText: "Asked in the main chat for 1 player." };
    });
  });

  it.each(["admin_ops", "ask_group"])("partner clubs and the pool (%s): the partners first, then the pool, in ONE reply; no question", async (route) => {
    const r = await ask("@Match Time find me players feom partner clubs and player pool", route, { deps: { routerModel: routeTo(route), extractorModel: places(["partners", "pool"]) } });
    expect(order).toEqual(["partners", "pool"]);
    expect(r).toEqual({
      route,
      outcome: "xask-words-asked+hq-pool-asked",
      replyText: "I've asked *Sutton FC*'s organisers.\n\n🔎 The pool joins once the partner clubs have had their hour.",
    });
    expect(source.askWhichSource).not.toHaveBeenCalled();
  });

  it("everywhere: the players' group as well, then the partners, then the pool", async () => {
    const r = await ask("@Match Time her yerden oyuncu bul", "admin_ops", { deps: { routerModel: routeTo("admin_ops"), extractorModel: places(["club", "partners", "pool"]) } });
    expect(order).toEqual(["club", "partners", "pool"]);
    expect(r?.replyText?.split("\n\n")).toHaveLength(3);
  });

  it("a place the club does not have says so through its own door, in the same reply", async () => {
    partnerWords.askPartnersFromWords.mockImplementation(async () => {
      order.push("partners");
      return { outcome: "xask-words-no-partners", replyText: "Your club has no partner clubs yet.", asked: 0 };
    });
    const r = await ask("@Match Time partnerlere ve havuza sor", "admin_ops", { deps: { routerModel: routeTo("admin_ops"), extractorModel: places(["partners", "pool"]) } });
    expect(r?.replyText).toContain("Your club has no partner clubs yet.");
    expect(r?.replyText).toContain("🔎");
  });

  it("an answer \"both\" to the question: the partners, then the pool", async () => {
    const at = new Date(NOW.getTime() - 60_000);
    hqLog.hqLogSince.mockResolvedValue([
      { waMessageId: "mt:ask-source:1", fromMatchTime: true, senderUserId: null, text: "Who shall I ask for players: your players' group, your partner clubs, or the MatchTime player pool?", askRef: "ask-source:club+partners+pool", createdAt: at },
    ]);
    const r = await ask("both", "approve", { deps: { routerModel: routeTo("approve"), extractorModel: places(["partners", "pool"]) } });
    expect(order).toEqual(["partners", "pool"]);
    expect(r?.outcome).toBe("xask-words-asked+hq-pool-asked");
  });

  it("the money collector who is not an organiser: the one line, nothing asked", async () => {
    const r = await ask("@Match Time partners and the pool", "admin_ops", {
      organiser: false,
      member: true,
      senderUserId: "u-col",
      org: { ...ORG, paymentHolderId: "u-col" },
      deps: { routerModel: routeTo("admin_ops"), extractorModel: places(["partners", "pool"]) },
    });
    expect(r?.outcome).toBe("hq-only-organisers");
    expect(order).toEqual([]);
  });
});
