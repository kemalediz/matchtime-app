/**
 * Asking a partner club for a player, the writer (slice S2).
 * `src/lib/partner-ask.ts`: request (approval or standing), approve,
 * decline, the post's WhatsApp id, and the sweep that closes asks with
 * one line to each side. Every status change is a compare-and-set, so a
 * second poll or a second press never acts twice.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
  const m = {
    clubPartnership: { findUnique: vi.fn(), findMany: vi.fn() },
    organisation: { findUnique: vi.fn(), findMany: vi.fn() },
    match: { findUnique: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
    attendance: { count: vi.fn() },
    membership: { findUnique: vi.fn() },
    partnerAsk: { count: vi.fn(), create: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    botJob: { create: vi.fn(), delete: vi.fn() },
    sentNotification: { create: vi.fn() },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  };
  return m;
});
vi.mock("../db", () => ({ db: dbMock }));
const noticeMock = vi.hoisted(() => ({ sendAdminNotice: vi.fn() }));
vi.mock("../admin-channel", () => noticeMock);
const logMock = vi.hoisted(() => ({ recordMatchTimeQuestion: vi.fn() }));
vi.mock("../admin-group-log", () => logMock);
const postableMock = vi.hoisted(() => ({ isGroupPostable: vi.fn() }));
vi.mock("../group-postability-store", () => postableMock);
const settingsMock = vi.hoisted(() => ({ loadPartnerAskSettings: vi.fn() }));
vi.mock("../club-partnership", () => settingsMock);

import {
  approvePartnerAsk,
  declinePartnerAsk,
  requestPartnerAsk,
  stampPartnerAskPost,
  sweepPartnerAsks,
} from "../partner-ask";

const H = 3600_000;
const KICKOFF = new Date("2026-10-16T19:30:00Z");
const NOW = new Date(KICKOFF.getTime() - 6 * H);
const MATCH = {
  id: "m1",
  date: KICKOFF,
  status: "UPCOMING",
  isHistorical: false,
  maxPlayers: 18,
  activityId: "act-fnf",
  feePerPlayer: null,
  activity: { orgId: "fnf", venue: "Goals Sutton", dayOfWeek: 5, feePerPlayer: 8, feeSplitTotal: false, sport: { playersPerTeam: 9 } },
};
const FNF = { id: "fnf", name: "FNF", language: "en" };
const SUTTON = {
  id: "sutton",
  name: "Sutton FC",
  language: "en",
  whatsappGroupId: "sutton@g.us",
  whatsappBotEnabled: true,
  dormantAt: null,
  approvalStatus: "approved",
  billingStatus: "exempt",
  setupStage: "live",
};
const PARTNERSHIP = { id: "p1", askerOrgId: "fnf", partnerOrgId: "sutton", status: "active", partnerApproval: "each-ask" };

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.$transaction.mockImplementation((cb: (tx: typeof dbMock) => unknown) => cb(dbMock));
  dbMock.clubPartnership.findUnique.mockResolvedValue(PARTNERSHIP);
  dbMock.organisation.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(where.id === "fnf" ? FNF : where.id === "sutton" ? SUTTON : null),
  );
  dbMock.match.findUnique.mockResolvedValue(MATCH);
  dbMock.match.findMany.mockResolvedValue([MATCH]);
  dbMock.match.findFirst.mockResolvedValue(null);
  dbMock.attendance.count.mockResolvedValue(17);
  dbMock.membership.findUnique.mockResolvedValue({ role: "ADMIN", leftAt: null });
  dbMock.partnerAsk.count.mockResolvedValue(0);
  dbMock.partnerAsk.create.mockResolvedValue({ id: "ask1" });
  dbMock.partnerAsk.updateMany.mockResolvedValue({ count: 1 });
  dbMock.botJob.create.mockResolvedValue({ id: "job1" });
  noticeMock.sendAdminNotice.mockResolvedValue({ channel: "dm", queued: 1 });
  postableMock.isGroupPostable.mockResolvedValue(true);
  settingsMock.loadPartnerAskSettings.mockResolvedValue({ when: "on-request", time: null, cutoffHours: 4 });
});

const request = (over: Partial<Parameters<typeof requestPartnerAsk>[0]> = {}) =>
  requestPartnerAsk({ askerOrgId: "fnf", matchId: "m1", partnershipId: "p1", requestedByUserId: "admin1", via: "button", now: NOW, ...over });

describe("requestPartnerAsk", () => {
  it("each ask: one row waiting for approval, and the partner's organisers are asked with a link to the approve page", async () => {
    const r = await request();
    expect(r).toEqual({ ok: true, askId: "ask1", status: "awaiting-approval", partnerName: "Sutton FC" });
    expect(dbMock.partnerAsk.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        partnershipId: "p1",
        askerOrgId: "fnf",
        partnerOrgId: "sutton",
        matchId: "m1",
        places: 1,
        requestedVia: "button",
        postBy: new Date(KICKOFF.getTime() - 4 * H),
        closesAt: KICKOFF,
      }),
      select: { id: true },
    });
    expect(noticeMock.sendAdminNotice).toHaveBeenCalledTimes(1);
    const notice = noticeMock.sendAdminNotice.mock.calls[0][0];
    expect(notice.orgId).toBe("sutton");
    expect(notice.nextPath).toBe("/partner-asks/ask1");
    const dm = notice.text("https://L", "dm");
    expect(dm).toContain("*FNF* ask if one of your players can play for them");
    expect(dm).toContain("Goals Sutton (9-a-side, £8)");
    expect(dm).toContain("https://L");
    // Nothing posted in the partner group before a YES.
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
    // Not an admin group: no HQ question recorded.
    expect(logMock.recordMatchTimeQuestion).not.toHaveBeenCalled();
  });

  it("the partner uses an admin group: the question is logged with the ask's ref for the safe-YES rule", async () => {
    noticeMock.sendAdminNotice.mockResolvedValue({ channel: "admin-group", queued: 1 });
    await request();
    expect(logMock.recordMatchTimeQuestion).toHaveBeenCalledWith(expect.objectContaining({ orgId: "sutton", askRef: "xask:ask1" }));
  });

  it("the partner's own game that day is shown to its organisers", async () => {
    dbMock.match.findFirst.mockResolvedValue({ id: "own", maxPlayers: 14 });
    dbMock.attendance.count.mockImplementation(({ where }: { where: { matchId: string } }) => Promise.resolve(where.matchId === "own" ? 12 : 17));
    await request();
    expect(noticeMock.sendAdminNotice.mock.calls[0][0].text("L", "dm")).toContain("Your own game that day is 12 of 14.");
  });

  it("standing permission: posted at once as a BotJob of the PARTNER club, and both sides told", async () => {
    dbMock.clubPartnership.findUnique.mockResolvedValue({ ...PARTNERSHIP, partnerApproval: "standing" });
    dbMock.partnerAsk.findUnique.mockResolvedValue({ id: "ask1", status: "awaiting-approval", askerOrgId: "fnf", partnerOrgId: "sutton", matchId: "m1" });
    const r = await request();
    expect(r).toMatchObject({ ok: true, status: "posted" });
    expect(dbMock.botJob.create).toHaveBeenCalledWith({ data: { orgId: "sutton", kind: "group", text: expect.stringContaining("*Reply to this message* with *IN*") }, select: { id: true } });
    expect(dbMock.partnerAsk.updateMany).toHaveBeenCalledWith({
      where: { id: "ask1", status: "awaiting-approval" },
      data: expect.objectContaining({ status: "posted", postJobId: "job1", postedAt: NOW }),
    });
    const told = noticeMock.sendAdminNotice.mock.calls.map((c) => c[0].orgId).sort();
    expect(told).toEqual(["fnf", "sutton"]);
  });

  it("after the cut-off: refused, nothing written, nobody told", async () => {
    const r = await request({ now: new Date(KICKOFF.getTime() - 3 * H) });
    expect(r).toEqual({ ok: false, refusal: "too-late", partnerName: "Sutton FC" });
    expect(dbMock.partnerAsk.create).not.toHaveBeenCalled();
    expect(noticeMock.sendAdminNotice).not.toHaveBeenCalled();
  });

  it("the club's own cut-off is used", async () => {
    settingsMock.loadPartnerAskSettings.mockResolvedValue({ when: "on-request", time: null, cutoffHours: 2 });
    expect(await request({ now: new Date(KICKOFF.getTime() - 3 * H) })).toMatchObject({ ok: true });
  });

  it("the partner club is muted: refused in plain words, nothing written", async () => {
    dbMock.organisation.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(where.id === "fnf" ? FNF : { ...SUTTON, whatsappBotEnabled: false }),
    );
    expect(await request()).toEqual({ ok: false, refusal: "partner-muted", partnerName: "Sutton FC" });
    expect(dbMock.partnerAsk.create).not.toHaveBeenCalled();
  });

  it("a PLAYER cannot ask; asking Off refuses; the squad full refuses", async () => {
    dbMock.membership.findUnique.mockResolvedValue({ role: "PLAYER", leftAt: null });
    expect(await request()).toMatchObject({ ok: false, refusal: "not-admin" });
    dbMock.membership.findUnique.mockResolvedValue({ role: "ADMIN", leftAt: null });
    settingsMock.loadPartnerAskSettings.mockResolvedValue({ when: "off", time: null, cutoffHours: 4 });
    expect(await request()).toMatchObject({ ok: false, refusal: "asking-off" });
    settingsMock.loadPartnerAskSettings.mockResolvedValue({ when: "on-request", time: null, cutoffHours: 4 });
    dbMock.attendance.count.mockResolvedValue(18);
    expect(await request()).toMatchObject({ ok: false, refusal: "no-places" });
    expect(dbMock.partnerAsk.create).not.toHaveBeenCalled();
  });

  it("L2 (review): the daily cap is counted and the ask created under one lock per partner club", async () => {
    await request();
    expect(dbMock.$transaction).toHaveBeenCalled();
    expect(dbMock.$executeRaw).toHaveBeenCalled();
    const lockOrder = dbMock.$executeRaw.mock.invocationCallOrder[0];
    const createOrder = dbMock.partnerAsk.create.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(createOrder);
  });

  it("two asks into the partner group today already: refused", async () => {
    dbMock.partnerAsk.count.mockImplementation(({ where }: { where: { OR?: unknown } }) => Promise.resolve(where.OR ? 2 : 0));
    expect(await request()).toMatchObject({ ok: false, refusal: "daily-cap" });
  });

  it("another press won the race (the one-open-ask index): already open", async () => {
    dbMock.partnerAsk.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    expect(await request()).toMatchObject({ ok: false, refusal: "already-open" });
    expect(noticeMock.sendAdminNotice).not.toHaveBeenCalled();
  });

  it("a partnership of another club, or a match of another club: not found", async () => {
    dbMock.clubPartnership.findUnique.mockResolvedValue({ ...PARTNERSHIP, askerOrgId: "other" });
    expect(await request()).toMatchObject({ ok: false, refusal: "not-found" });
  });
});

describe("approvePartnerAsk and declinePartnerAsk", () => {
  const ASK = {
    id: "ask1",
    partnershipId: "p1",
    askerOrgId: "fnf",
    partnerOrgId: "sutton",
    matchId: "m1",
    status: "awaiting-approval",
    places: 1,
    postBy: new Date(KICKOFF.getTime() - 4 * H),
  };
  beforeEach(() => {
    dbMock.partnerAsk.findUnique.mockResolvedValue(ASK);
  });

  it("an admin of the PARTNER club approves: posted once, the asking club told", async () => {
    expect(await approvePartnerAsk({ askId: "ask1", userId: "suttonAdmin", now: NOW })).toEqual({ ok: true, outcome: "posted" });
    expect(dbMock.membership.findUnique).toHaveBeenCalledWith({ where: { userId_orgId: { userId: "suttonAdmin", orgId: "sutton" } }, select: { role: true, leftAt: true } });
    expect(dbMock.botJob.create).toHaveBeenCalledTimes(1);
    expect(noticeMock.sendAdminNotice).toHaveBeenCalledWith(expect.objectContaining({ orgId: "fnf" }));
  });

  it("a player cannot approve", async () => {
    dbMock.membership.findUnique.mockResolvedValue({ role: "PLAYER", leftAt: null });
    expect(await approvePartnerAsk({ askId: "ask1", userId: "x", now: NOW })).toEqual({ ok: false, outcome: "not-admin" });
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });

  it("after the cut-off an approval posts nothing", async () => {
    expect(await approvePartnerAsk({ askId: "ask1", userId: "a", now: ASK.postBy })).toEqual({ ok: false, outcome: "too-late" });
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });

  it("approved twice: the second finds it posted and posts nothing", async () => {
    dbMock.partnerAsk.findUnique.mockResolvedValue({ ...ASK, status: "posted" });
    expect(await approvePartnerAsk({ askId: "ask1", userId: "a", now: NOW })).toEqual({ ok: false, outcome: "closed" });
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });

  it("the place filled meanwhile: nothing posted", async () => {
    dbMock.attendance.count.mockResolvedValue(18);
    expect(await approvePartnerAsk({ askId: "ask1", userId: "a", now: NOW })).toEqual({ ok: false, outcome: "no-places" });
  });

  it("a lost compare-and-set takes its BotJob back", async () => {
    dbMock.partnerAsk.updateMany.mockResolvedValue({ count: 0 });
    expect(await approvePartnerAsk({ askId: "ask1", userId: "a", now: NOW })).toEqual({ ok: false, outcome: "closed" });
    expect(dbMock.botJob.delete).toHaveBeenCalledWith({ where: { id: "job1" } });
  });

  it("no thanks: declined, the asking club told", async () => {
    expect(await declinePartnerAsk({ askId: "ask1", userId: "a", now: NOW })).toEqual({ ok: true, outcome: "declined" });
    expect(dbMock.partnerAsk.updateMany).toHaveBeenCalledWith({ where: { id: "ask1", status: "awaiting-approval" }, data: { status: "declined", reason: "declined", closedAt: NOW } });
    expect(noticeMock.sendAdminNotice.mock.calls[0][0].text).toContain("said no");
  });
});

describe("stampPartnerAskPost", () => {
  it("the post's WhatsApp id lands on the ask once", async () => {
    await stampPartnerAskPost("job1", "wamid-1");
    expect(dbMock.partnerAsk.updateMany).toHaveBeenCalledWith({ where: { postJobId: "job1", postWaMessageId: null }, data: { postWaMessageId: "wamid-1" } });
  });
  it("an ack with no id stamps nothing", async () => {
    await stampPartnerAskPost("job1", undefined);
    expect(dbMock.partnerAsk.updateMany).not.toHaveBeenCalled();
  });
});

describe("sweepPartnerAsks", () => {
  const posted = {
    id: "ask1",
    status: "posted",
    askerOrgId: "fnf",
    partnerOrgId: "sutton",
    matchId: "m1",
    postBy: new Date(KICKOFF.getTime() - 4 * H),
    closesAt: KICKOFF,
    postedAt: new Date(NOW.getTime() - 60_000),
    postWaMessageId: "wamid-1",
    postJobId: "job1",
    volunteerUserIds: [] as string[],
    partnership: { status: "active" },
    match: MATCH,
  };
  beforeEach(() => {
    dbMock.partnerAsk.findUnique.mockResolvedValue(posted);
  });

  it("an open ask with a place open stays open: nothing written, nobody told", async () => {
    dbMock.partnerAsk.findMany.mockResolvedValue([posted]);
    expect(await sweepPartnerAsks("fnf", NOW)).toEqual({ closed: 0 });
    expect(dbMock.partnerAsk.updateMany).not.toHaveBeenCalled();
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });

  it("filled by the club's own player: filled, and ONE line in the partner group", async () => {
    dbMock.partnerAsk.findMany.mockResolvedValue([posted]);
    dbMock.attendance.count.mockResolvedValue(18);
    expect(await sweepPartnerAsks("fnf", NOW)).toEqual({ closed: 1 });
    expect(dbMock.partnerAsk.updateMany).toHaveBeenCalledWith({ where: { id: "ask1", status: "posted" }, data: { status: "filled", reason: "filled", closedAt: NOW } });
    expect(dbMock.botJob.create).toHaveBeenCalledWith({ data: { orgId: "sutton", kind: "group", text: "✅ *FNF*'s place is filled, thanks all 🙌" } });
  });

  it("a second poll lost the compare-and-set: nobody told twice", async () => {
    dbMock.partnerAsk.findMany.mockResolvedValue([posted]);
    dbMock.attendance.count.mockResolvedValue(18);
    dbMock.partnerAsk.updateMany.mockResolvedValue({ count: 0 });
    expect(await sweepPartnerAsks("sutton", NOW)).toEqual({ closed: 0 });
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });

  it("an approval still waiting at the cut-off expires and the asking club is told", async () => {
    const waiting = { ...posted, status: "awaiting-approval", postedAt: null, postWaMessageId: null };
    dbMock.partnerAsk.findMany.mockResolvedValue([waiting]);
    dbMock.partnerAsk.findUnique.mockResolvedValue(waiting);
    await sweepPartnerAsks("fnf", waiting.postBy);
    expect(dbMock.partnerAsk.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "expired", reason: "approval-expired" }) }));
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
    expect(noticeMock.sendAdminNotice).toHaveBeenCalledWith(expect.objectContaining({ orgId: "fnf", text: expect.stringContaining("didn't answer in time") }));
  });

  it("kickoff with nobody: the asking club is told nobody came; the partner group hears nothing more", async () => {
    dbMock.partnerAsk.findMany.mockResolvedValue([posted]);
    await sweepPartnerAsks("fnf", KICKOFF);
    expect(noticeMock.sendAdminNotice).toHaveBeenCalledWith(expect.objectContaining({ orgId: "fnf", text: expect.stringContaining("Nobody from *Sutton FC*") }));
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });

  it("the game is cancelled: cancelled, and the partner group is told the ask is closed", async () => {
    const cancelled = { ...posted, match: { ...MATCH, status: "CANCELLED" } };
    dbMock.partnerAsk.findMany.mockResolvedValue([cancelled]);
    await sweepPartnerAsks("fnf", NOW);
    expect(dbMock.partnerAsk.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "cancelled", reason: "match-cancelled" }) }));
    expect(dbMock.botJob.create.mock.calls[0][0].data.text).toContain("is closed now");
  });

  it("H3 (review): the game moved: the ask follows the new kickoff, nothing is closed, nobody is told it is off", async () => {
    const moved = new Date(KICKOFF.getTime() + 2 * H);
    dbMock.partnerAsk.findMany.mockResolvedValue([{ ...posted, match: { ...MATCH, date: moved } }]);
    await sweepPartnerAsks("fnf", NOW);
    expect(dbMock.partnerAsk.updateMany).toHaveBeenCalledWith({
      where: { id: "ask1", status: "posted", closesAt: KICKOFF },
      data: { closesAt: moved, postBy: new Date(moved.getTime() - 4 * H) },
    });
    expect(dbMock.partnerAsk.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "cancelled" }) }));
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });

  it("the pairing paused: open asks are cancelled", async () => {
    dbMock.partnerAsk.findMany.mockResolvedValue([{ ...posted, partnership: { status: "paused" } }]);
    await sweepPartnerAsks("sutton", NOW);
    expect(dbMock.partnerAsk.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "cancelled", reason: "partnership-inactive" }) }));
  });

  it("no WhatsApp id 10 minutes after posting: the asking club is told, once", async () => {
    const noId = { ...posted, postWaMessageId: null, postedAt: new Date(NOW.getTime() - 11 * 60_000) };
    dbMock.partnerAsk.findMany.mockResolvedValue([noId]);
    dbMock.partnerAsk.findUnique.mockResolvedValue(noId);
    await sweepPartnerAsks("fnf", NOW);
    expect(dbMock.sentNotification.create).toHaveBeenCalledWith({ data: { key: "xask:ask1:no-post-id", kind: "xask-no-post-id", matchId: "m1" } });
    expect(noticeMock.sendAdminNotice).toHaveBeenCalledWith(expect.objectContaining({ orgId: "fnf", text: expect.stringContaining("can't confirm") }));
    noticeMock.sendAdminNotice.mockClear();
    dbMock.sentNotification.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    await sweepPartnerAsks("fnf", NOW);
    expect(noticeMock.sendAdminNotice).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    dbMock.partnerAsk.findMany.mockRejectedValue(new Error("db down"));
    await expect(sweepPartnerAsks("fnf", NOW)).resolves.toEqual({ closed: 0 });
  });
});
