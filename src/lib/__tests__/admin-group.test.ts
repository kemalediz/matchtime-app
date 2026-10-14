/**
 * A message in a club's admin group (2026-10-14): which reader gets it.
 *
 *   PAID reply -> pick reply (round open) -> YES to a pasted list ->
 *   a pasted list -> one squad change (the only path with a model)
 *
 * and who never gets past the door: a non-admin, a duplicate, a club that
 * is not live, a monthly club. Every collaborator is mocked at its module
 * boundary. No database, no model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  organisation: { findFirst: vi.fn() },
  organiserPickRound: { findFirst: vi.fn() },
  membership: { findFirst: vi.fn() },
  sentNotification: { create: vi.fn() },
  user: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
const link = vi.hoisted(() => ({ resolveSenderUserIds: vi.fn() }));
vi.mock("@/lib/admin-group-link", () => link);
const pick = vi.hoisted(() => ({ handlePickReply: vi.fn() }));
vi.mock("@/lib/organiser-pick", () => pick);
const paste = vi.hoisted(() => ({ proposeSquadPaste: vi.fn(), answerSquadPasteYes: vi.fn() }));
vi.mock("@/lib/admin-group-paste", () => paste);
const change = vi.hoisted(() => ({ handleAdminSquadChange: vi.fn() }));
vi.mock("@/lib/admin-group-squad-change", () => change);
const pay = vi.hoisted(() => ({ handleCollectorPaidReply: vi.fn() }));
vi.mock("@/lib/month-payment", () => pay);
const teams = vi.hoisted(() => ({ handleTeamCommand: vi.fn(), answerTeamsYes: vi.fn(), setAsideTeamProposal: vi.fn() }));
vi.mock("@/lib/team-proposal", () => teams);

import { handleAdminGroupMessage } from "../admin-group";

const HQ = "120363777000000001@g.us";
const LIVE_ORG = { id: "org-fnf", billingStatus: null, whatsappBotEnabled: true, squadMode: "weekly", language: "en" };
const msg = (text: string, over: Record<string, unknown> = {}) => ({
  groupId: HQ,
  messageId: "wa-1",
  text,
  senderPhone: "447700900001",
  timestamp: "1760443200",
  now: new Date("2026-10-14T12:00:00Z"),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.organisation.findFirst.mockResolvedValue(LIVE_ORG);
  dbMock.organiserPickRound.findFirst.mockResolvedValue(null);
  dbMock.membership.findFirst.mockResolvedValue({ userId: "u-admin" });
  dbMock.sentNotification.create.mockResolvedValue({});
  dbMock.user.findUnique.mockResolvedValue({ name: "Raihan" });
  link.resolveSenderUserIds.mockResolvedValue(["u-admin"]);
  paste.proposeSquadPaste.mockResolvedValue(null);
  paste.answerSquadPasteYes.mockResolvedValue(null);
  change.handleAdminSquadChange.mockResolvedValue({ handled: false, why: "not-a-squad-change" });
  teams.handleTeamCommand.mockResolvedValue(null);
  teams.answerTeamsYes.mockResolvedValue(null);
  teams.setAsideTeamProposal.mockResolvedValue(0);
});

describe("handleAdminGroupMessage: one squad change", () => {
  it("an admin's 'Shehryar out' goes to the squad change, and its reply comes back", async () => {
    change.handleAdminSquadChange.mockResolvedValue({ handled: true, outcome: "squad-changed", replyText: "Done: Shehryar out. 17 of 18." });
    const r = await handleAdminGroupMessage(msg("Shehryar out", { mentionNames: [{ jid: "1@lid", phone: "447" }] }));
    expect(r).toEqual({ handled: true, orgId: "org-fnf", outcome: "squad-changed", replyText: "Done: Shehryar out. 17 of 18." });
    expect(change.handleAdminSquadChange).toHaveBeenCalledWith({
      orgId: "org-fnf",
      lang: "en",
      messageId: "wa-1",
      text: "Shehryar out",
      mentionNames: [{ jid: "1@lid", phone: "447" }],
      senderUserId: "u-admin",
      senderName: "Raihan",
      sentAt: new Date(1760443200 * 1000),
      now: new Date("2026-10-14T12:00:00Z"),
    });
  });

  it("the sender is found by phone or a stored LID, never a pushname", async () => {
    await handleAdminGroupMessage(msg("Shehryar out", { senderLid: "999@lid", senderAltPhone: "447700900002", pushname: "Raihan" }));
    expect(link.resolveSenderUserIds).toHaveBeenCalledWith({ phones: ["447700900001", "447700900002"], lid: "999@lid" });
  });

  it("a NON-admin's 'Shehryar out' is ignored: no model, no claim, no reply", async () => {
    dbMock.membership.findFirst.mockResolvedValue(null);
    const r = await handleAdminGroupMessage(msg("Shehryar out"));
    expect(r).toEqual({ handled: false, ignored: "no-open-pick", orgId: "org-fnf", replyText: null });
    expect(change.handleAdminSquadChange).not.toHaveBeenCalled();
    expect(paste.proposeSquadPaste).not.toHaveBeenCalled();
    expect(dbMock.sentNotification.create).not.toHaveBeenCalled();
  });

  it("a sender nobody knows: ignored the same way", async () => {
    link.resolveSenderUserIds.mockResolvedValue([]);
    const r = await handleAdminGroupMessage(msg("Shehryar out"));
    expect(r).toMatchObject({ handled: false, ignored: "no-open-pick", replyText: null });
    expect(change.handleAdminSquadChange).not.toHaveBeenCalled();
  });

  it("chat the squad change does not claim: ignored, no reply", async () => {
    const r = await handleAdminGroupMessage(msg("Wasim played well last week"));
    expect(r).toEqual({ handled: false, ignored: "no-open-pick", orgId: "org-fnf", replyText: null });
  });

  it("idempotent per WhatsApp message id: a Pi retry is never applied twice", async () => {
    dbMock.sentNotification.create.mockRejectedValueOnce(new Error("unique"));
    const r = await handleAdminGroupMessage(msg("Shehryar out"));
    expect(r).toEqual({ handled: false, ignored: "duplicate", orgId: "org-fnf", replyText: null });
    expect(change.handleAdminSquadChange).not.toHaveBeenCalled();
    expect(dbMock.sentNotification.create).toHaveBeenCalledWith({ data: { key: "admin-group-msg:wa-1", kind: "admin-notice" } });
  });

  it("a club that is not live (bot off, still setting up): nothing is read", async () => {
    dbMock.organisation.findFirst.mockResolvedValue({ ...LIVE_ORG, whatsappBotEnabled: false });
    const r = await handleAdminGroupMessage(msg("Shehryar out"));
    expect(r).toMatchObject({ handled: false, ignored: "no-open-pick" });
    expect(link.resolveSenderUserIds).not.toHaveBeenCalled();
    expect(change.handleAdminSquadChange).not.toHaveBeenCalled();
  });

  it("a monthly club: today's behaviour, no squad change and no paste", async () => {
    dbMock.organisation.findFirst.mockResolvedValue({ ...LIVE_ORG, squadMode: "monthly" });
    const r = await handleAdminGroupMessage(msg("1. A\n2. B\n3. C\n4. D\n5. E"));
    expect(r).toMatchObject({ handled: false, ignored: "no-open-pick", replyText: null });
    expect(change.handleAdminSquadChange).not.toHaveBeenCalled();
    expect(paste.proposeSquadPaste).not.toHaveBeenCalled();
  });
});

describe("handleAdminGroupMessage: a pick round open", () => {
  beforeEach(() => dbMock.organiserPickRound.findFirst.mockResolvedValue({ id: "round" }));

  it("a pick reply is still the pick round's, and nothing else runs", async () => {
    pick.handlePickReply.mockResolvedValue({ handled: true, outcome: "filled", replyText: "Done: Wasim is in." });
    const r = await handleAdminGroupMessage(msg("2"));
    expect(r).toEqual({ handled: true, orgId: "org-fnf", outcome: "filled", replyText: "Done: Wasim is in." });
    expect(change.handleAdminSquadChange).not.toHaveBeenCalled();
  });

  it("not a pick: a squad change is still read", async () => {
    pick.handlePickReply.mockResolvedValue({ handled: false });
    change.handleAdminSquadChange.mockResolvedValue({ handled: true, outcome: "squad-changed", replyText: "Done: Bilal in. 18 of 18." });
    const r = await handleAdminGroupMessage(msg("put Bilal in"));
    expect(r).toMatchObject({ handled: true, outcome: "squad-changed" });
  });

  it("not a pick and not a change: the old answer, not-a-pick", async () => {
    pick.handlePickReply.mockResolvedValue({ handled: false });
    const r = await handleAdminGroupMessage(msg("Wasim played well last week"));
    expect(r).toEqual({ handled: false, ignored: "not-a-pick", orgId: "org-fnf", replyText: null });
  });

  it("a non-admin while a round is open: not-an-admin, as before", async () => {
    dbMock.membership.findFirst.mockResolvedValue(null);
    const r = await handleAdminGroupMessage(msg("2"));
    expect(r).toMatchObject({ handled: false, ignored: "not-an-admin" });
  });
});

describe("handleAdminGroupMessage: pasted lists and YES", () => {
  const LIST = "1. Bilal\n2. Ali\n3. Tom\n4. Sam\n5. Naim";

  it("a pasted list is proposed, never sent to the model", async () => {
    paste.proposeSquadPaste.mockResolvedValue({ outcome: "paste-proposed", replyText: "Adding: Bilal. Reply YES to apply." });
    const r = await handleAdminGroupMessage(msg(LIST));
    expect(r).toEqual({ handled: true, orgId: "org-fnf", outcome: "paste-proposed", replyText: "Adding: Bilal. Reply YES to apply." });
    expect(paste.proposeSquadPaste).toHaveBeenCalledWith({
      orgId: "org-fnf",
      lang: "en",
      messageId: "wa-1",
      text: LIST,
      senderUserId: "u-admin",
      now: new Date("2026-10-14T12:00:00Z"),
    });
    expect(change.handleAdminSquadChange).not.toHaveBeenCalled();
  });

  it("an admin's YES applies the waiting list", async () => {
    paste.answerSquadPasteYes.mockResolvedValue({ outcome: "paste-applied", replyText: "Done: Bilal in. 18 of 18." });
    const r = await handleAdminGroupMessage(msg("YES", { messageId: "wa-2" }));
    expect(r).toMatchObject({ handled: true, outcome: "paste-applied", replyText: "Done: Bilal in. 18 of 18." });
    expect(paste.answerSquadPasteYes).toHaveBeenCalledWith({
      orgId: "org-fnf",
      lang: "en",
      messageId: "wa-2",
      senderUserId: "u-admin",
      now: new Date("2026-10-14T12:00:00Z"),
    });
  });

  it("YES with nothing waiting: silent, and never sent to the model", async () => {
    const r = await handleAdminGroupMessage(msg("yes"));
    expect(r).toMatchObject({ handled: false, ignored: "no-open-pick", replyText: null });
    expect(change.handleAdminSquadChange).not.toHaveBeenCalled();
  });

  it("a non-admin's YES applies nothing", async () => {
    dbMock.membership.findFirst.mockResolvedValue(null);
    await handleAdminGroupMessage(msg("YES"));
    expect(paste.answerSquadPasteYes).not.toHaveBeenCalled();
  });

  it("a YES while a pick question is pending is the pick round's first", async () => {
    dbMock.organiserPickRound.findFirst.mockResolvedValue({ id: "round" });
    pick.handlePickReply.mockResolvedValue({ handled: true, outcome: "filled", replyText: "Done." });
    await handleAdminGroupMessage(msg("YES"));
    expect(paste.answerSquadPasteYes).not.toHaveBeenCalled();
    expect(teams.answerTeamsYes).not.toHaveBeenCalled();
  });
});

describe("handleAdminGroupMessage: the team commands (2026-10-14)", () => {
  it("a team command is read before a pasted list or a squad change, never sent to the model", async () => {
    teams.handleTeamCommand.mockResolvedValue({ outcome: "teams-swapped", replyText: "📝 *Proposed teams* ..." });
    const r = await handleAdminGroupMessage(msg("swap Ali Bilal"));
    expect(r).toEqual({ handled: true, orgId: "org-fnf", outcome: "teams-swapped", replyText: "📝 *Proposed teams* ..." });
    expect(teams.handleTeamCommand).toHaveBeenCalledWith({
      orgId: "org-fnf",
      lang: "en",
      messageId: "wa-1",
      text: "swap Ali Bilal",
      senderUserId: "u-admin",
      now: new Date("2026-10-14T12:00:00Z"),
    });
    expect(paste.proposeSquadPaste).not.toHaveBeenCalled();
    expect(change.handleAdminSquadChange).not.toHaveBeenCalled();
  });

  it("a non-admin's 'teams' is never read", async () => {
    dbMock.membership.findFirst.mockResolvedValue(null);
    const r = await handleAdminGroupMessage(msg("teams"));
    expect(r).toMatchObject({ handled: false, replyText: null });
    expect(teams.handleTeamCommand).not.toHaveBeenCalled();
  });

  it("a monthly club: no team commands either (today's behaviour)", async () => {
    dbMock.organisation.findFirst.mockResolvedValue({ ...LIVE_ORG, squadMode: "monthly" });
    await handleAdminGroupMessage(msg("teams"));
    expect(teams.handleTeamCommand).not.toHaveBeenCalled();
  });

  it("YES with teams waiting makes them final, and the list's YES is not asked", async () => {
    teams.answerTeamsYes.mockResolvedValue({ outcome: "teams-final", replyText: "Teams are final." });
    const r = await handleAdminGroupMessage(msg("EVET"));
    expect(r).toEqual({ handled: true, orgId: "org-fnf", outcome: "teams-final", replyText: "Teams are final." });
    expect(paste.answerSquadPasteYes).not.toHaveBeenCalled();
  });

  it("YES with no teams waiting goes on to a pasted list's YES", async () => {
    paste.answerSquadPasteYes.mockResolvedValue({ outcome: "paste-applied", replyText: "Done: Bilal in. 18 of 18." });
    const r = await handleAdminGroupMessage(msg("YES"));
    expect(teams.answerTeamsYes).toHaveBeenCalled();
    expect(r).toMatchObject({ outcome: "paste-applied" });
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

  it("a pasted list with no teams waiting: the reply is unchanged", async () => {
    paste.proposeSquadPaste.mockResolvedValue({ outcome: "paste-proposed", replyText: "Adding: Bilal. Reply YES to apply." });
    const r = await handleAdminGroupMessage(msg("1. Bilal\n2. Ali\n3. Tom\n4. Sam\n5. Naim"));
    expect(r).toMatchObject({ replyText: "Adding: Bilal. Reply YES to apply." });
  });
});
