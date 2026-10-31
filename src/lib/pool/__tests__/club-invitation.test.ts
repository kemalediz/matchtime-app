/**
 * The joining flow's I/O decisions (pool L8, review of #406), with the
 * database and the senders mocked. The scenarios in e2e/sim/pool/invites-*
 * play the same paths for real.
 *
 *   L1  MatchTime is admin but the invite-code job cannot even be queued:
 *       the organisers hear "paste the link", never "make MatchTime admin".
 *   L2  an organiser's tap racing the after-game question (the unique open
 *       index): the tap is stored as the club's yes on the open one.
 *   L6  Join from someone who is already a member: refused.
 *   M3  a stopped or deleted profile: no link DM, no closing DM.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  organisation: { findUnique: vi.fn() },
  clubInvitation: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
  user: { findUnique: vi.fn() },
  poolProfile: { findUnique: vi.fn() },
  membership: { findUnique: vi.fn() },
  guestPlace: { findFirst: vi.fn() },
  platformJob: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  sentNotification: { create: vi.fn() },
  match: { findUnique: vi.fn(), findMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("../../db", () => ({ db }));
const notice = vi.hoisted(() => ({ sendAdminNotice: vi.fn() }));
vi.mock("../../admin-channel", () => notice);
const hqLog = vi.hoisted(() => ({ recordMatchTimeQuestion: vi.fn() }));
vi.mock("../../admin-group-log", () => hqLog);
const jobs = vi.hoisted(() => ({ queuePlatformDm: vi.fn(), queuePlatformInviteCode: vi.fn(), cancelQueuedPlatformDms: vi.fn() }));
vi.mock("../../platform-jobs", () => jobs);
vi.mock("../../group-postability-store", () => ({ readPostState: vi.fn(async () => ({ botIsAdmin: true })) }));
vi.mock("../../partner-guest", () => ({ keepGuestAsMember: vi.fn() }));
vi.mock("../links", () => ({ buildPoolInvitationsLink: vi.fn(async () => "https://mt.test/r/x") }));
const facts = vi.hoisted(() => ({ state: "available" as string }));
vi.mock("../guest-report-loader", () => ({ loadGuestFacts: vi.fn(async () => ({ games: [], people: [] })) }));
vi.mock("../guest-report", async (orig) => ({
  ...(await orig<typeof import("../guest-report")>()),
  buildGuestPlayers: vi.fn(() => ({ cards: { u1: { invite: facts.state } } })),
}));

import { answerAsClub, answerAsPlayer, deliverInviteLink, onInviteCodeReported, sweepClubInvitations } from "../club-invitation";

const NOW = new Date("2026-10-27T12:00:00Z");
/** The platform switch on, as a request resolves it (2026-10-28). */
const ENV = { GROUP_INVITE_CODE_JOBS: "1", MT_POOL_OPEN: "1" };
/** The platform switch OFF (or never resolved): invitations HOLD. */
const OFF = { GROUP_INVITE_CODE_JOBS: "1", MT_POOL_OPEN: "0" };
const OPEN = { id: "inv1", orgId: "o1", userId: "u1", matchId: null, status: "open", origin: "after-game", clubYesAt: null, playerYesAt: null, declinedBy: null, closedAt: null, linkSentAt: null, createdAt: NOW };

beforeEach(() => {
  vi.clearAllMocks();
  facts.state = "available";
  db.organisation.findUnique.mockResolvedValue({ name: "FNF", language: "en", whatsappGroupId: "g@g.us", groupInviteLink: null, featurePlayerPool: true });
  db.user.findUnique.mockResolvedValue({ phoneNumber: "+447700900123", name: "Sam Kerr" });
  db.poolProfile.findUnique.mockResolvedValue({ language: "en", status: "active" });
  db.membership.findUnique.mockResolvedValue(null);
  db.guestPlace.findFirst.mockResolvedValue(null);
  db.sentNotification.create.mockResolvedValue({});
  db.clubInvitation.updateMany.mockResolvedValue({ count: 1 });
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
});

describe("L1: the Pi job cannot be queued although MatchTime is admin", () => {
  it("tells the organisers to paste the link, not to make MatchTime an admin", async () => {
    db.clubInvitation.findUnique.mockResolvedValue({ ...OPEN, status: "accepted" });
    jobs.queuePlatformInviteCode.mockResolvedValue({ refused: "not-a-club-group" });
    expect(await deliverInviteLink("inv1", NOW, ENV)).toBe("no-link");
    const text = notice.sendAdminNotice.mock.calls[0][0].text("https://mt.test/admin/settings");
    expect(text).toMatch(/^I could not get your group's invite link for Sam K\. Paste the link in Settings/);
    expect(text).not.toMatch(/admin of your WhatsApp group/);
  });
});

describe("L2: the organiser's tap races the after-game question", () => {
  it("stores the tap as the club's yes on the invitation that won", async () => {
    db.clubInvitation.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(OPEN);
    db.$transaction.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    const r = await answerAsClub({ orgId: "o1", userId: "u1", actorId: "org1", answer: "yes", now: NOW, env: ENV });
    expect(r.ok).toBe(true);
    expect(db.clubInvitation.updateMany).toHaveBeenCalledWith({
      where: { id: "inv1", status: "open", clubYesAt: null, playerYesAt: null },
      data: { clubYesAt: NOW, clubYesById: "org1" },
    });
  });
});

describe("M4: Invite to club only where the pool is on", () => {
  it("refuses for a club with the pool off", async () => {
    db.organisation.findUnique.mockResolvedValue({ name: "FNF", language: "en", whatsappGroupId: "g@g.us", groupInviteLink: "https://chat.whatsapp.com/AbCdEfGhIjKl", featurePlayerPool: false });
    expect(await answerAsClub({ orgId: "o1", userId: "u1", actorId: "org1", answer: "yes", now: NOW, env: ENV })).toEqual({ ok: false, reason: "not-allowed" });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe("L6: Join from someone already in the club", () => {
  it("is refused and changes nothing", async () => {
    db.clubInvitation.findUnique.mockResolvedValue(OPEN);
    db.membership.findUnique.mockResolvedValue({ leftAt: null, guestMatchId: null, guestFromOrgId: null, guestVia: null });
    expect(await answerAsPlayer({ invitationId: "inv1", userId: "u1", answer: "join", now: NOW, env: ENV })).toBe("member");
    expect(db.clubInvitation.updateMany).not.toHaveBeenCalled();
  });
});

describe("M3: a stopped or deleted profile gets no link and no closing line", () => {
  it("stopped: the link is not queued", async () => {
    db.organisation.findUnique.mockResolvedValue({ name: "FNF", language: "en", whatsappGroupId: null, groupInviteLink: "https://chat.whatsapp.com/AbCdEfGhIjKl", featurePlayerPool: true });
    db.clubInvitation.findUnique.mockResolvedValue({ ...OPEN, status: "accepted", playerYesAt: NOW });
    db.poolProfile.findUnique.mockResolvedValue({ language: "en", status: "stopped" });
    expect(await deliverInviteLink("inv1", NOW, ENV)).toBe("nothing");
    expect(jobs.queuePlatformDm).not.toHaveBeenCalled();
  });

  it("deleted (he came through the pool, no profile now): the link is not queued", async () => {
    db.organisation.findUnique.mockResolvedValue({ name: "FNF", language: "en", whatsappGroupId: null, groupInviteLink: "https://chat.whatsapp.com/AbCdEfGhIjKl", featurePlayerPool: true });
    db.clubInvitation.findUnique.mockResolvedValue({ ...OPEN, status: "accepted", playerYesAt: NOW });
    db.poolProfile.findUnique.mockResolvedValue(null);
    db.guestPlace.findFirst.mockResolvedValue({ id: "gp1" });
    expect(await deliverInviteLink("inv1", NOW, ENV)).toBe("nothing");
    expect(jobs.queuePlatformDm).not.toHaveBeenCalled();
  });
});

describe("L10: his yes, told to the organisers in HQ, is a question a YES answers", () => {
  it("in the admin group: the notice invites a YES there, and is logged as MatchTime's question about this invitation", async () => {
    db.clubInvitation.findUnique.mockResolvedValue(OPEN);
    db.organisation.findUnique.mockResolvedValue({ name: "FNF", language: "en", whatsappGroupId: "g@g.us", groupInviteLink: "https://chat.whatsapp.com/AbCdEfGhIjKl", featurePlayerPool: true });
    notice.sendAdminNotice.mockImplementation(async (req: { text: (l: string, a: string) => string }) => ({ channel: "admin-group", queued: 1, groupText: req.text("https://mt.test/admin/guests?tab=history", "group") }));
    expect(await answerAsPlayer({ invitationId: "inv1", userId: "u1", answer: "join", now: NOW, env: ENV })).toBe("waiting-club");
    const req = notice.sendAdminNotice.mock.calls[0][0];
    const inHq = req.text("https://mt.test/admin/guests?tab=history", "group");
    expect(inHq).toBe(
      "🙋 Sam K played with you on  as a guest and wants to join your group. Say *@Match Time YES* here to send them the group's invite link, or tap Send the invite link on their card: https://mt.test/admin/guests?tab=history",
    );
    expect(hqLog.recordMatchTimeQuestion).toHaveBeenCalledWith({ orgId: "o1", askRef: "join-request:inv1", text: inHq, now: NOW });
  });

  it("by DM (no admin group): the notice is today's, and nothing is logged", async () => {
    db.clubInvitation.findUnique.mockResolvedValue(OPEN);
    db.organisation.findUnique.mockResolvedValue({ name: "FNF", language: "en", whatsappGroupId: "g@g.us", groupInviteLink: "https://chat.whatsapp.com/AbCdEfGhIjKl", featurePlayerPool: true });
    notice.sendAdminNotice.mockResolvedValue({ channel: "dm", queued: 1 });
    await answerAsPlayer({ invitationId: "inv1", userId: "u1", answer: "join", now: NOW, env: ENV });
    expect(notice.sendAdminNotice.mock.calls[0][0].text("https://mt.test/r/x", "dm")).toMatch(/To send them the group's invite link, tap Send the invite link on their card: https:\/\/mt\.test\/r\/x$/);
    expect(hqLog.recordMatchTimeQuestion).not.toHaveBeenCalled();
  });
});

describe("the platform switch OFF stops new invitations and link DMs, and only holds them (review of #430)", () => {
  it("Invite to club (and HQ YES, the same door) is refused with nothing written, even with the club's flag on", async () => {
    for (const env of [OFF, { GROUP_INVITE_CODE_JOBS: "1" }]) {
      expect(await answerAsClub({ orgId: "o1", userId: "u1", actorId: "org1", answer: "yes", now: NOW, env })).toEqual({ ok: false, reason: "not-allowed" });
    }
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(jobs.queuePlatformDm).not.toHaveBeenCalled();
  });

  it("an accepted invitation's link is held: no DM, no Pi job, no notice, and it stays waiting", async () => {
    db.organisation.findUnique.mockResolvedValue({ name: "FNF", language: "en", whatsappGroupId: null, groupInviteLink: "https://chat.whatsapp.com/AbCdEfGhIjKl", featurePlayerPool: true });
    db.clubInvitation.findUnique.mockResolvedValue({ ...OPEN, status: "accepted", playerYesAt: NOW });
    expect(await deliverInviteLink("inv1", NOW, OFF)).toBe("held");
    expect(jobs.queuePlatformDm).not.toHaveBeenCalled();
    expect(jobs.queuePlatformInviteCode).not.toHaveBeenCalled();
    expect(notice.sendAdminNotice).not.toHaveBeenCalled();
    expect(db.clubInvitation.updateMany).not.toHaveBeenCalled();
    // Back on: the same invitation gets its link.
    expect(await deliverInviteLink("inv1", NOW, ENV)).toBe("queued");
  });

  it("the Pi's invite code arriving while OFF: the link is not sent (the sweep retries once it is on)", async () => {
    db.platformJob.findUnique.mockResolvedValue({ kind: "invite-code", refId: "inv1" });
    await onInviteCodeReported("job1", { outcome: "sent", inviteCode: "AbCdEfGhIjKl" } as never, NOW, OFF);
    expect(jobs.queuePlatformDm).not.toHaveBeenCalled();
    expect(db.clubInvitation.updateMany).not.toHaveBeenCalled();
  });

  it("the sweep asks no guest after a game and retries no link while OFF", async () => {
    db.clubInvitation.findMany.mockResolvedValue([]);
    db.platformJob.findMany.mockResolvedValue([]);
    await sweepClubInvitations(NOW, OFF);
    expect(db.match.findMany).not.toHaveBeenCalled();
    for (const [arg] of db.clubInvitation.findMany.mock.calls) expect(arg.where.status).not.toBe("accepted");
  });
});
