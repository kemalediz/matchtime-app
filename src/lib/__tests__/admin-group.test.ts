/**
 * A message in a club's admin group: which reader gets it (2026-10-16).
 *
 *   PAID digest answer -> pick reply (round open) -> pasted list ->
 *   everything else through the shared pipeline (`admin-group-understand.ts`)
 *
 * and who never gets past the door: a non-admin, a duplicate, a club that
 * is not live. Every collaborator is mocked at its module boundary. No
 * database, no model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  organisation: { findFirst: vi.fn() },
  organiserPickRound: { findFirst: vi.fn() },
  membership: { findMany: vi.fn() },
  sentNotification: { create: vi.fn() },
  user: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
const link = vi.hoisted(() => ({ resolveSenderUserIds: vi.fn() }));
vi.mock("@/lib/admin-group-link", () => link);
const pick = vi.hoisted(() => ({ handlePickReply: vi.fn() }));
vi.mock("@/lib/organiser-pick", () => pick);
const paste = vi.hoisted(() => ({ proposeSquadPaste: vi.fn() }));
vi.mock("@/lib/admin-group-paste", () => paste);
const pay = vi.hoisted(() => ({ handleCollectorPaidReply: vi.fn() }));
vi.mock("@/lib/month-payment", () => pay);
const teams = vi.hoisted(() => ({ setAsideTeamProposal: vi.fn() }));
vi.mock("@/lib/team-proposal", () => teams);
const hqLog = vi.hoisted(() => ({
  recordHqMessage: vi.fn(),
  recordMatchTimeQuestion: vi.fn(),
  listAskRef: (id: string) => `list:${id}`,
}));
vi.mock("@/lib/admin-group-log", () => hqLog);
const understand = vi.hoisted(() => ({ understandAdminMessage: vi.fn() }));
vi.mock("@/lib/admin-group-understand", () => understand);

import { handleAdminGroupMessage } from "../admin-group";

const HQ = "120363777000000001@g.us";
const NOW = new Date("2026-10-14T12:00:00Z");
const LIVE_ORG = { id: "org-fnf", billingStatus: null, whatsappBotEnabled: true, squadMode: "weekly", language: "en", benchPickMode: null };
const msg = (text: string, over: Record<string, unknown> = {}) => ({
  groupId: HQ,
  messageId: "wa-1",
  text,
  senderPhone: "447700900001",
  timestamp: "1760443200",
  now: NOW,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.organisation.findFirst.mockResolvedValue(LIVE_ORG);
  dbMock.organiserPickRound.findFirst.mockResolvedValue(null);
  dbMock.membership.findMany.mockResolvedValue([{ userId: "u-admin", role: "ADMIN" }]);
  dbMock.sentNotification.create.mockResolvedValue({});
  dbMock.user.findUnique.mockResolvedValue({ name: "Raihan" });
  link.resolveSenderUserIds.mockResolvedValue(["u-admin"]);
  paste.proposeSquadPaste.mockResolvedValue(null);
  teams.setAsideTeamProposal.mockResolvedValue(0);
  understand.understandAdminMessage.mockResolvedValue(null);
});

describe("everything that is not structured data goes through the shared pipeline", () => {
  it("an admin's words go to the shared pipeline with the club, the sender and the quoted message, and its answer is the route's", async () => {
    understand.understandAdminMessage.mockResolvedValue({ route: "poster", outcome: "graphic-queued", replyText: null });
    const r = await handleAdminGroupMessage(
      msg("can you do the poster for this week", { mentionNames: [{ jid: "1@lid" }], quotedText: undefined, quoted: { text: "Teams?", fromMatchTime: true } }),
    );
    expect(r).toEqual({ handled: true, orgId: "org-fnf", outcome: "graphic-queued", replyText: null, react: "✅" });
    expect(understand.understandAdminMessage).toHaveBeenCalledWith({
      org: LIVE_ORG,
      messageId: "wa-1",
      text: "can you do the poster for this week",
      mentionNames: [{ jid: "1@lid" }],
      quoted: { text: "Teams?", fromMatchTime: true },
      senderUserId: "u-admin",
      organiser: true,
      senderName: "Raihan",
      sentAt: new Date(1760443200 * 1000),
      now: NOW,
    });
  });

  it("the organisers' own conversation: ignored, no reply", async () => {
    const r = await handleAdminGroupMessage(msg("who is bringing the bibs?"));
    expect(r).toEqual({ handled: false, ignored: "no-open-pick", orgId: "org-fnf", replyText: null });
  });

  it("a monthly club is read too (help, the graphics)", async () => {
    dbMock.organisation.findFirst.mockResolvedValue({ ...LIVE_ORG, squadMode: "monthly" });
    understand.understandAdminMessage.mockResolvedValue({ route: "help", outcome: "hq-help", replyText: "🛠️" });
    expect(await handleAdminGroupMessage(msg("what can you do?"))).toMatchObject({ handled: true, outcome: "hq-help" });
    expect(paste.proposeSquadPaste).not.toHaveBeenCalled();
  });
});

// "It should put a tick if it recognises a command" (Kemal, 2026-10-16):
// the Pi reacts ✅ to the admin's message, as it does to a player's IN in
// the players' group. Not on chat it ignores, and not on the one line that
// says MatchTime could not do or could not read what was asked.
describe("the ✅ on a message MatchTime acted on", () => {
  it.each([
    ["graphic-queued", null],
    ["hq-help", "🛠️"],
    ["squad-changed", "Done: Bilal is in."],
    ["teams-swapped", "✅ *Final teams*"],
    ["teams-final", "Teams are final."],
  ])("%s: ✅", async (outcome, replyText) => {
    understand.understandAdminMessage.mockResolvedValue({ route: "balancer", outcome, replyText });
    expect(await handleAdminGroupMessage(msg("@Match Time do it"))).toMatchObject({ handled: true, react: "✅" });
  });

  // Owner rule 3 (2026-10-17): a tick only when something was done or a
  // real answer given. These lines change nothing: how to make a change,
  // a list that is not set yet.
  it.each(["hq-not-here", "hq-not-understood", "squad-question", "squad-not-set"])("%s: no tick, the line is the answer", async (outcome) => {
    understand.understandAdminMessage.mockResolvedValue({ route: "unsure", outcome, replyText: "I didn't catch that." });
    expect(await handleAdminGroupMessage(msg("@Match Time hmm"))).toMatchObject({ handled: true, react: null });
  });

  it("ignored chat: no tick", async () => {
    expect(await handleAdminGroupMessage(msg("who is bringing the bibs?"))).not.toHaveProperty("react");
  });

  it("a pick and a pasted list: ✅", async () => {
    dbMock.organiserPickRound.findFirst.mockResolvedValue({ id: "round-1" });
    pick.handlePickReply.mockResolvedValue({ handled: true, outcome: "filled", replyText: "Done: Wasim is in." });
    expect(await handleAdminGroupMessage(msg("1"))).toMatchObject({ react: "✅" });
    dbMock.organiserPickRound.findFirst.mockResolvedValue(null);
    paste.proposeSquadPaste.mockResolvedValue({ outcome: "paste-proposed", replyText: "Adding: Bilal. Reply YES to apply." });
    expect(await handleAdminGroupMessage(msg("1. Bilal\n2. Ali", { messageId: "wa-2" }))).toMatchObject({ react: "✅" });
  });
});

describe("the door", () => {
  it("the sender is found by phone or a stored LID, never a pushname", async () => {
    await handleAdminGroupMessage(msg("Shehryar out", { senderLid: "999@lid", senderAltPhone: "447700900002", pushname: "Raihan" }));
    expect(link.resolveSenderUserIds).toHaveBeenCalledWith({ phones: ["447700900001", "447700900002"], lid: "999@lid" });
  });

  it("an admin's message is recorded with who sent it", async () => {
    await handleAdminGroupMessage(msg("Shehryar out"));
    expect(hqLog.recordHqMessage).toHaveBeenCalledWith({ orgId: "org-fnf", waMessageId: "wa-1", senderUserId: "u-admin", text: "Shehryar out", now: NOW });
  });

  it("idempotent per WhatsApp message id: a Pi retry is never applied twice", async () => {
    dbMock.sentNotification.create.mockRejectedValueOnce(new Error("unique"));
    const r = await handleAdminGroupMessage(msg("Shehryar out"));
    expect(r).toEqual({ handled: false, ignored: "duplicate", orgId: "org-fnf", replyText: null });
    expect(understand.understandAdminMessage).not.toHaveBeenCalled();
    expect(dbMock.sentNotification.create).toHaveBeenCalledWith({ data: { key: "admin-group-msg:wa-1", kind: "admin-notice" } });
  });

  it("a club that is not live (bot off, still setting up): nothing is read or recorded", async () => {
    dbMock.organisation.findFirst.mockResolvedValue({ ...LIVE_ORG, whatsappBotEnabled: false });
    const r = await handleAdminGroupMessage(msg("Shehryar out"));
    expect(r).toMatchObject({ handled: false, ignored: "no-open-pick" });
    expect(link.resolveSenderUserIds).not.toHaveBeenCalled();
    expect(hqLog.recordHqMessage).not.toHaveBeenCalled();
    expect(understand.understandAdminMessage).not.toHaveBeenCalled();
  });

  it("a club paused for the club fee: nothing", async () => {
    vi.stubEnv("BILLING_ENABLED", "1");
    try {
      dbMock.organisation.findFirst.mockResolvedValue({ ...LIVE_ORG, billingStatus: "paused" });
      expect(await handleAdminGroupMessage(msg("poster"))).toMatchObject({ ignored: "club-billing-paused" });
      expect(understand.understandAdminMessage).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("structured data first, deterministically", () => {
  it("a pick reply to MatchTime's numbered list is the pick round's, and nothing else runs", async () => {
    dbMock.organiserPickRound.findFirst.mockResolvedValue({ id: "round" });
    pick.handlePickReply.mockResolvedValue({ handled: true, outcome: "filled", replyText: "Done: Wasim is in." });
    const r = await handleAdminGroupMessage(msg("2"));
    expect(r).toEqual({ handled: true, orgId: "org-fnf", outcome: "filled", replyText: "Done: Wasim is in.", react: "✅" });
    expect(understand.understandAdminMessage).not.toHaveBeenCalled();
  });

  it("not a pick: the shared pipeline reads it, and the old answer stands when it says nothing", async () => {
    dbMock.organiserPickRound.findFirst.mockResolvedValue({ id: "round" });
    pick.handlePickReply.mockResolvedValue({ handled: false });
    expect(await handleAdminGroupMessage(msg("Wasim played well last week"))).toEqual({ handled: false, ignored: "not-a-pick", orgId: "org-fnf", replyText: null });
    expect(understand.understandAdminMessage).toHaveBeenCalled();
  });

  it("a non-admin while a round is open: never a pick; their chat is still not-an-admin", async () => {
    dbMock.organiserPickRound.findFirst.mockResolvedValue({ id: "round" });
    dbMock.membership.findMany.mockResolvedValue([{ userId: "u-player", role: "PLAYER" }]);
    expect(await handleAdminGroupMessage(msg("2"))).toMatchObject({ handled: false, ignored: "not-an-admin" });
    expect(pick.handlePickReply).not.toHaveBeenCalled();
  });

  it("a pick round in a club that is not live is still read (its own question)", async () => {
    dbMock.organisation.findFirst.mockResolvedValue({ ...LIVE_ORG, whatsappBotEnabled: false });
    dbMock.organiserPickRound.findFirst.mockResolvedValue({ id: "round" });
    pick.handlePickReply.mockResolvedValue({ handled: false });
    expect(await handleAdminGroupMessage(msg("hello"))).toMatchObject({ ignored: "not-a-pick" });
    expect(understand.understandAdminMessage).not.toHaveBeenCalled();
  });

  it("a pasted list is proposed, recorded as MatchTime's question, and never sent to the model", async () => {
    const LIST = "1. Bilal\n2. Ali\n3. Tom\n4. Sam\n5. Naim";
    paste.proposeSquadPaste.mockResolvedValue({ outcome: "paste-proposed", replyText: "Adding: Bilal. Reply YES to apply." });
    const r = await handleAdminGroupMessage(msg(LIST));
    expect(r).toEqual({ handled: true, orgId: "org-fnf", outcome: "paste-proposed", replyText: "Adding: Bilal. Reply YES to apply.", react: "✅" });
    expect(paste.proposeSquadPaste).toHaveBeenCalledWith({ orgId: "org-fnf", lang: "en", messageId: "wa-1", text: LIST, senderUserId: "u-admin", now: NOW });
    expect(hqLog.recordMatchTimeQuestion).toHaveBeenCalledWith({ orgId: "org-fnf", askRef: "list:wa-1", text: "Adding: Bilal. Reply YES to apply.", now: NOW });
    expect(understand.understandAdminMessage).not.toHaveBeenCalled();
  });

  it("a pasted list asked about while teams wait: the teams are set aside, and the reply says so", async () => {
    paste.proposeSquadPaste.mockResolvedValue({ outcome: "paste-proposed", replyText: "Adding: Bilal. Reply YES to apply." });
    teams.setAsideTeamProposal.mockResolvedValue(1);
    const r = await handleAdminGroupMessage(msg("1. Bilal\n2. Ali\n3. Tom\n4. Sam\n5. Naim"));
    expect(teams.setAsideTeamProposal).toHaveBeenCalledWith("org-fnf");
    expect(r).toMatchObject({
      outcome: "paste-proposed",
      replyText: "Adding: Bilal. Reply YES to apply. The teams still need approving: type *teams* after this.",
    });
  });

  it("a monthly club never has its message read as a pasted list", async () => {
    dbMock.organisation.findFirst.mockResolvedValue({ ...LIVE_ORG, squadMode: "monthly" });
    await handleAdminGroupMessage(msg("1. A\n2. B\n3. C\n4. D\n5. E"));
    expect(paste.proposeSquadPaste).not.toHaveBeenCalled();
  });
});

// "Anyone in that group should be able to ask questions" (Kemal,
// 2026-10-16). FNF HQ, 15:13: Kemal, a PLAYER of FNF, asked "Who are are
// admins?" and got nothing, and his row was recorded with no sender: only
// an owner's or admin's membership was ever looked up, so anyone else was
// recorded as nobody. Every sender in a live club's HQ now reaches the
// shared pipeline, told whether they are an organiser; what changes the
// club stays the organisers' (`admin-group-understand.ts`).
describe("anyone in HQ: questions for all, changes for the organisers", () => {
  const PLAYER = [{ userId: "u-kemal", role: "PLAYER" }];

  it("a player of the club: recorded as who they are, and read by the shared pipeline as a non-organiser", async () => {
    dbMock.membership.findMany.mockResolvedValue(PLAYER);
    dbMock.user.findUnique.mockResolvedValue({ name: "Kemal" });
    link.resolveSenderUserIds.mockResolvedValue(["u-kemal"]);
    understand.understandAdminMessage.mockResolvedValue({ route: "question", outcome: "hq-answered", replyText: "👥 Admins: Hamzah and Raihan" });
    const r = await handleAdminGroupMessage(msg("Who are are admins?"));
    expect(r).toEqual({ handled: true, orgId: "org-fnf", outcome: "hq-answered", replyText: "👥 Admins: Hamzah and Raihan", react: "✅" });
    expect(hqLog.recordHqMessage).toHaveBeenCalledWith({ orgId: "org-fnf", waMessageId: "wa-1", senderUserId: "u-kemal", text: "Who are are admins?", now: NOW });
    expect(understand.understandAdminMessage).toHaveBeenCalledWith(
      expect.objectContaining({ senderUserId: "u-kemal", organiser: false, senderName: "Kemal", text: "Who are are admins?" }),
    );
    // Claimed, so a Pi retry never answers twice.
    expect(dbMock.sentNotification.create).toHaveBeenCalledWith({ data: { key: "admin-group-msg:wa-1", kind: "admin-notice" } });
  });

  it("someone MatchTime does not know at all: still read, with no sender", async () => {
    link.resolveSenderUserIds.mockResolvedValue([]);
    understand.understandAdminMessage.mockResolvedValue({ route: "question", outcome: "hq-answered", replyText: "On the bench: Tom." });
    expect(await handleAdminGroupMessage(msg("who's on the bench?"))).toMatchObject({ handled: true, outcome: "hq-answered", react: "✅" });
    expect(hqLog.recordHqMessage).toHaveBeenCalledWith(expect.objectContaining({ senderUserId: null }));
    expect(understand.understandAdminMessage).toHaveBeenCalledWith(expect.objectContaining({ senderUserId: null, organiser: false, senderName: null }));
  });

  it("a known user who is not in this club: recorded as who they are, not an organiser", async () => {
    link.resolveSenderUserIds.mockResolvedValue(["u-other"]);
    dbMock.membership.findMany.mockResolvedValue([]);
    dbMock.user.findUnique.mockResolvedValue({ name: "Ali" });
    await handleAdminGroupMessage(msg("who's playing tonight?"));
    expect(hqLog.recordHqMessage).toHaveBeenCalledWith(expect.objectContaining({ senderUserId: "u-other" }));
    expect(understand.understandAdminMessage).toHaveBeenCalledWith(expect.objectContaining({ senderUserId: "u-other", organiser: false, senderName: "Ali" }));
  });

  it("two identities, one of them an owner: the owner one acts", async () => {
    link.resolveSenderUserIds.mockResolvedValue(["u-player", "u-owner"]);
    dbMock.membership.findMany.mockResolvedValue([{ userId: "u-player", role: "PLAYER" }, { userId: "u-owner", role: "OWNER" }]);
    await handleAdminGroupMessage(msg("Shehryar out"));
    expect(understand.understandAdminMessage).toHaveBeenCalledWith(expect.objectContaining({ senderUserId: "u-owner", organiser: true }));
  });

  it("a non-admin's chat the pipeline leaves alone: ignored, no reply, no tick", async () => {
    dbMock.membership.findMany.mockResolvedValue(PLAYER);
    expect(await handleAdminGroupMessage(msg("yes"))).toEqual({ handled: false, ignored: "no-open-pick", orgId: "org-fnf", replyText: null });
  });

  it("a non-admin never reaches the structured readers that change things (a pasted list)", async () => {
    dbMock.membership.findMany.mockResolvedValue(PLAYER);
    await handleAdminGroupMessage(msg("1. Bilal\n2. Ali\n3. Tom\n4. Sam\n5. Naim"));
    expect(paste.proposeSquadPaste).not.toHaveBeenCalled();
  });

  it("the line saying only the organisers can change that: no tick", async () => {
    dbMock.membership.findMany.mockResolvedValue(PLAYER);
    understand.understandAdminMessage.mockResolvedValue({ route: "balancer", outcome: "hq-only-organisers", replyText: "Only Hamzah or Raihan can change that." });
    expect(await handleAdminGroupMessage(msg("@Match Time swap Maj and Kieran"))).toEqual({
      handled: true,
      orgId: "org-fnf",
      outcome: "hq-only-organisers",
      replyText: "Only Hamzah or Raihan can change that.",
      react: null,
    });
  });

  it("a club that is not live: a non-admin is still ignored, nothing read", async () => {
    dbMock.organisation.findFirst.mockResolvedValue({ ...LIVE_ORG, whatsappBotEnabled: false });
    dbMock.organiserPickRound.findFirst.mockResolvedValue({ id: "round" });
    dbMock.membership.findMany.mockResolvedValue(PLAYER);
    expect(await handleAdminGroupMessage(msg("who are the admins?"))).toMatchObject({ handled: false, ignored: "not-an-admin" });
    expect(understand.understandAdminMessage).not.toHaveBeenCalled();
  });
});
