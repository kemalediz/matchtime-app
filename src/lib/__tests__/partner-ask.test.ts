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
    sentNotification: { create: vi.fn(), findUnique: vi.fn() },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  };
  return m;
});
vi.mock("../db", () => ({ db: dbMock }));
const noticeMock = vi.hoisted(() => ({ sendAdminNotice: vi.fn() }));
vi.mock("../admin-channel", () => noticeMock);
const logMock = vi.hoisted(() => ({ recordMatchTimeQuestion: vi.fn(), recordMatchTimeLine: vi.fn() }));
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
  answerClosedPartnerAskYes,
  cancelPartnerRound,
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
  dbMock.sentNotification.create.mockResolvedValue({ id: "sn1" });
  dbMock.sentNotification.findUnique.mockResolvedValue(null);
  noticeMock.sendAdminNotice.mockResolvedValue({ channel: "dm", queued: 1 });
  postableMock.isGroupPostable.mockResolvedValue(true);
  settingsMock.loadPartnerAskSettings.mockResolvedValue({ cutoffHours: 4 });
});

const request = (over: Partial<Parameters<typeof requestPartnerAsk>[0]> = {}) =>
  requestPartnerAsk({ askerOrgId: "fnf", matchId: "m1", partnershipId: "p1", requestedByUserId: "admin1", via: "button", now: NOW, ...over });

describe("requestPartnerAsk", () => {
  it("each ask: one row waiting for approval, and the partner's organisers are asked with a link to the approve page", async () => {
    const r = await request();
    expect(r).toEqual({ ok: true, askId: "ask1", status: "awaiting-approval", partnerName: "Sutton FC", places: 1 });
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
    expect(dbMock.botJob.create).toHaveBeenCalledWith({ data: { orgId: "sutton", kind: "group", text: expect.any(String) }, select: { id: true } });
    expect(dbMock.partnerAsk.updateMany).toHaveBeenCalledWith({
      where: { id: "ask1", status: "awaiting-approval" },
      data: expect.objectContaining({ status: "posted", postJobId: "job1", postedAt: NOW }),
    });
    const told = noticeMock.sendAdminNotice.mock.calls.map((c) => c[0].orgId).sort();
    expect(told).toEqual(["fnf", "sutton"]);
  });

  it("2026-10-21 (Kemal): the post asks for a PRIVATE message to MatchTime, with a tap-to-DM link carrying the ask's code; his number is not shared", async () => {
    vi.stubEnv("MATCHTIME_WA_NUMBER", "447700900555");
    try {
      dbMock.clubPartnership.findUnique.mockResolvedValue({ ...PARTNERSHIP, partnerApproval: "standing" });
      dbMock.partnerAsk.findUnique.mockResolvedValue({ id: "ask1", status: "awaiting-approval", askerOrgId: "fnf", partnerOrgId: "sutton", matchId: "m1" });
      await request();
      const text: string = dbMock.botJob.create.mock.calls[0][0].data.text;
      const { askRefCode } = await import("../partner-ask-ref");
      expect(text).toContain(`https://wa.me/447700900555?text=${encodeURIComponent(`IN (ref ${askRefCode("ask1")})`)}`);
      expect(text).toContain("MatchTime will confirm with you by private message. Your number is not shared with FNF.");
      // Never the old wording: no reply in the group, no organiser messaging him.
      expect(text).not.toMatch(/Reply to this message|their organisers will confirm/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("without MatchTime's number configured, the post says what to send privately instead", async () => {
    vi.stubEnv("MATCHTIME_WA_NUMBER", "");
    try {
      dbMock.clubPartnership.findUnique.mockResolvedValue({ ...PARTNERSHIP, partnerApproval: "standing" });
      dbMock.partnerAsk.findUnique.mockResolvedValue({ id: "ask1", status: "awaiting-approval", askerOrgId: "fnf", partnerOrgId: "sutton", matchId: "m1" });
      await request();
      const text: string = dbMock.botJob.create.mock.calls[0][0].data.text;
      const { askRefCode } = await import("../partner-ask-ref");
      expect(text).toContain(`Send MatchTime a private message: *IN (ref ${askRefCode("ask1")})*`);
      expect(text).not.toContain("wa.me");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("after the cut-off: refused, nothing written, nobody told", async () => {
    const r = await request({ now: new Date(KICKOFF.getTime() - 3 * H) });
    expect(r).toEqual({ ok: false, refusal: "too-late", partnerName: "Sutton FC" });
    expect(dbMock.partnerAsk.create).not.toHaveBeenCalled();
    expect(noticeMock.sendAdminNotice).not.toHaveBeenCalled();
  });

  it("the club's own cut-off is used", async () => {
    settingsMock.loadPartnerAskSettings.mockResolvedValue({ cutoffHours: 2 });
    expect(await request({ now: new Date(KICKOFF.getTime() - 3 * H) })).toMatchObject({ ok: true });
  });

  it("an active pairing is the switch (Kemal, 2026-11-08): the button asks with no asking setting at all", async () => {
    settingsMock.loadPartnerAskSettings.mockResolvedValue({ cutoffHours: 4 });
    expect(await request()).toMatchObject({ ok: true, partnerName: "Sutton FC" });
    expect(dbMock.partnerAsk.create).toHaveBeenCalledTimes(1);
    expect(dbMock.organisation.findUnique.mock.calls.every(([a]) => !("partnerAskWhen" in (a?.select ?? {})))).toBe(true);
  });

  it("the partner club is muted: refused in plain words, nothing written", async () => {
    dbMock.organisation.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(where.id === "fnf" ? FNF : { ...SUTTON, whatsappBotEnabled: false }),
    );
    expect(await request()).toEqual({ ok: false, refusal: "partner-muted", partnerName: "Sutton FC" });
    expect(dbMock.partnerAsk.create).not.toHaveBeenCalled();
  });

  it("a PLAYER cannot ask; the squad full refuses", async () => {
    dbMock.membership.findUnique.mockResolvedValue({ role: "PLAYER", leftAt: null });
    expect(await request()).toMatchObject({ ok: false, refusal: "not-admin" });
    dbMock.membership.findUnique.mockResolvedValue({ role: "ADMIN", leftAt: null });
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

// Monday night vets, 2026-11-09 (match cmvzw1o9a000208l6pb9xe31n): two
// partner clubs were asked for players. Sutton FC (standing approval) had
// the ask posted and heard "filled" when the round filled. FNF (approval
// each time) had only been asked in HQ; the ask closed "cancelled, filled"
// and FNF HQ was told nothing, so the approval sat there unanswered for a
// game that no longer needed anyone. Now the partner's ADMINS hear one line,
// on the channel they were asked on, keyed once per ask; the players' group
// never hears about an ask it never saw.
describe("an ask waiting for the partner's approval closes: the partner's admins are told", () => {
  const waiting = {
    id: "ask1",
    roundId: null,
    places: 2,
    status: "awaiting-approval",
    askerOrgId: "fnf",
    partnerOrgId: "sutton",
    matchId: "m1",
    postBy: new Date(KICKOFF.getTime() - 4 * H),
    closesAt: KICKOFF,
    postedAt: null,
    postWaMessageId: null,
    postJobId: null,
    volunteerUserIds: [] as string[],
    pickedUserIds: [] as string[],
    partnership: { status: "active" },
    match: MATCH,
  };
  const askedKey = { where: { key: "xask:ask1:approval-asked" }, select: { id: true } };
  const toPartner = () => noticeMock.sendAdminNotice.mock.calls.map((c) => c[0]).filter((n) => n.orgId === "sutton");
  const groupPosts = () => dbMock.botJob.create.mock.calls.map((c) => c[0].data).filter((d) => d.kind === "group");
  beforeEach(() => {
    dbMock.partnerAsk.findMany.mockResolvedValue([waiting]);
    dbMock.partnerAsk.findUnique.mockResolvedValue(waiting);
    // The partner's admins WERE asked to approve.
    dbMock.sentNotification.findUnique.mockImplementation((q: { where: { key: string } }) =>
      Promise.resolve(q.where.key === "xask:ask1:approval-asked" ? { id: "asked" } : null),
    );
  });

  it("asking for approval is recorded, once per ask, only when the notice was queued", async () => {
    await request();
    expect(dbMock.sentNotification.create).toHaveBeenCalledWith({ data: { key: "xask:ask1:approval-asked", kind: "xask-approval-asked", matchId: "m1" } });
    dbMock.sentNotification.create.mockClear();
    noticeMock.sendAdminNotice.mockResolvedValue({ channel: "none", queued: 0 });
    await request();
    expect(dbMock.sentNotification.create).not.toHaveBeenCalled();
  });

  it("filled: one line to the partner's admins, keyed once, and nothing in its players' group", async () => {
    dbMock.attendance.count.mockResolvedValue(18);
    expect(await sweepPartnerAsks("fnf", NOW)).toEqual({ closed: 1 });
    expect(dbMock.partnerAsk.updateMany).toHaveBeenCalledWith({ where: { id: "ask1", status: "awaiting-approval" }, data: { status: "cancelled", reason: "filled", closedAt: NOW } });
    expect(dbMock.sentNotification.findUnique).toHaveBeenCalledWith(askedKey);
    expect(dbMock.sentNotification.create).toHaveBeenCalledWith({ data: { key: "xask:ask1:approval-closed", kind: "xask-approval-closed", matchId: "m1" } });
    expect(toPartner()).toHaveLength(1);
    expect(toPartner()[0].text).toBe("✅ No longer needed: *FNF* have filled their places for Fri 16 Oct. Thanks, nothing to do.");
    expect(groupPosts()).toEqual([]);
  });

  it("in the partner's HQ the line is logged as MatchTime's, so a YES quoting it is read in context", async () => {
    dbMock.attendance.count.mockResolvedValue(18);
    noticeMock.sendAdminNotice.mockResolvedValue({ channel: "admin-group", queued: 1, groupText: "x" });
    await sweepPartnerAsks("fnf", NOW);
    expect(logMock.recordMatchTimeLine).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "sutton", text: "✅ No longer needed: *FNF* have filled their places for Fri 16 Oct. Thanks, nothing to do." }),
    );
  });

  it("told once: a second close of the same ask (the claim is taken) tells nobody again", async () => {
    dbMock.attendance.count.mockResolvedValue(18);
    dbMock.sentNotification.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    await sweepPartnerAsks("fnf", NOW);
    expect(toPartner()).toEqual([]);
  });

  it("never asked (the approval notice reached nobody): nothing to take back, nobody told", async () => {
    dbMock.attendance.count.mockResolvedValue(18);
    dbMock.sentNotification.findUnique.mockResolvedValue(null);
    await sweepPartnerAsks("fnf", NOW);
    expect(toPartner()).toEqual([]);
    expect(dbMock.sentNotification.create).not.toHaveBeenCalled();
  });

  it("the approval ran out at the cut-off: the partner's admins hear it expired, the asking club is told as before", async () => {
    await sweepPartnerAsks("fnf", waiting.postBy);
    expect(toPartner().map((n) => n.text)).toEqual([
      "No longer needed: the time to answer *FNF*'s ask for Fri 16 Oct has passed, so I didn't post it. Nothing to do.",
    ]);
    expect(noticeMock.sendAdminNotice).toHaveBeenCalledWith(expect.objectContaining({ orgId: "fnf", text: expect.stringContaining("didn't answer in time") }));
    expect(groupPosts()).toEqual([]);
  });

  it("the game is off: the partner's admins hear the game is off", async () => {
    dbMock.partnerAsk.findMany.mockResolvedValue([{ ...waiting, match: { ...MATCH, status: "CANCELLED" } }]);
    dbMock.match.findUnique.mockResolvedValue({ ...MATCH, status: "CANCELLED" });
    await sweepPartnerAsks("fnf", NOW);
    expect(toPartner().map((n) => n.text)).toEqual(["No longer needed: *FNF*'s game on Fri 16 Oct is off. Nothing to do."]);
    expect(groupPosts()).toEqual([]);
  });

  it("the pairing is no longer active: the partner's admins hear the ask is closed", async () => {
    dbMock.partnerAsk.findMany.mockResolvedValue([{ ...waiting, partnership: { status: "paused" } }]);
    await sweepPartnerAsks("sutton", NOW);
    expect(toPartner().map((n) => n.text)).toEqual(["No longer needed: *FNF*'s ask for Fri 16 Oct is closed. Nothing to do."]);
  });

  it("the asking organiser cancels the round: the partner's admins hear it was cancelled", async () => {
    await cancelPartnerRound({ askerOrgId: "fnf", matchId: "m1", roundKey: "ask1", userId: "admin1", now: NOW });
    expect(toPartner().map((n) => n.text)).toEqual(["No longer needed: *FNF* cancelled their ask for Fri 16 Oct. Nothing to do."]);
    expect(groupPosts()).toEqual([]);
  });

  it("a partner paused on MatchTime is told nothing (MatchTime is off in its groups)", async () => {
    dbMock.attendance.count.mockResolvedValue(18);
    dbMock.organisation.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(where.id === "fnf" ? FNF : where.id === "sutton" ? { ...SUTTON, dormantAt: new Date("2026-10-01") } : null),
    );
    await sweepPartnerAsks("fnf", NOW);
    expect(toPartner()).toEqual([]);
  });

  it("a POSTED ask's close is unchanged: the players' group's one line, and no second line to the admins", async () => {
    const posted = { ...waiting, status: "posted", postedAt: NOW, postWaMessageId: "wamid-1", postJobId: "job1" };
    dbMock.partnerAsk.findMany.mockResolvedValue([posted]);
    dbMock.partnerAsk.findUnique.mockResolvedValue(posted);
    dbMock.attendance.count.mockResolvedValue(18);
    await sweepPartnerAsks("fnf", NOW);
    expect(groupPosts()).toEqual([{ orgId: "sutton", kind: "group", text: "✅ *FNF*'s place is filled, thanks all 🙌" }]);
    expect(toPartner()).toEqual([]);
  });
});

// A late "@Match Time YES" to the old approval (2026-11-09): it posts
// nothing anywhere, and says the ask is no longer needed.
describe("answerClosedPartnerAskYes", () => {
  const base = { id: "ask1", askerOrgId: "fnf", partnerOrgId: "sutton", matchId: "m1", postBy: new Date(KICKOFF.getTime() - 4 * H), postedAt: null };

  it("an ask that closed before anyone approved it (cancelled or expired): one short line, nothing posted", async () => {
    for (const status of ["cancelled", "expired"]) {
      dbMock.partnerAsk.findUnique.mockResolvedValue({ ...base, status });
      expect(await answerClosedPartnerAskYes({ orgId: "sutton", askId: "ask1", lang: "en", now: NOW })).toEqual({
        outcome: "xask-no-longer-needed",
        replyText: "No longer needed: *FNF*'s ask for Fri 16 Oct has closed, so I haven't posted anything. Nothing to do.",
      });
    }
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
    expect(dbMock.partnerAsk.updateMany).not.toHaveBeenCalled();
  });

  it("still waiting but past its cut-off (the sweep has not run yet): the same line", async () => {
    dbMock.partnerAsk.findUnique.mockResolvedValue({ ...base, status: "awaiting-approval" });
    expect((await answerClosedPartnerAskYes({ orgId: "sutton", askId: "ask1", lang: "en", now: base.postBy }))?.outcome).toBe("xask-no-longer-needed");
  });

  it("an ask still open, approved and posted (even if closed since), declined, or another club's: not this answer's (null)", async () => {
    for (const status of ["posted", "declined"]) {
      dbMock.partnerAsk.findUnique.mockResolvedValue({ ...base, status });
      expect(await answerClosedPartnerAskYes({ orgId: "sutton", askId: "ask1", lang: "en", now: NOW })).toBeNull();
    }
    for (const status of ["filled", "cancelled"]) {
      dbMock.partnerAsk.findUnique.mockResolvedValue({ ...base, status, postedAt: NOW });
      expect(await answerClosedPartnerAskYes({ orgId: "sutton", askId: "ask1", lang: "en", now: NOW })).toBeNull();
    }
    dbMock.partnerAsk.findUnique.mockResolvedValue({ ...base, status: "awaiting-approval" });
    expect(await answerClosedPartnerAskYes({ orgId: "sutton", askId: "ask1", lang: "en", now: NOW })).toBeNull();
    dbMock.partnerAsk.findUnique.mockResolvedValue({ ...base, status: "cancelled" });
    expect(await answerClosedPartnerAskYes({ orgId: "other", askId: "ask1", lang: "en", now: NOW })).toBeNull();
  });
});
