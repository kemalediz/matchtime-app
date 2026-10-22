/**
 * Asking partner clubs for a CHOSEN number of players, the writer
 * (partner discovery P4, 2026-10-22). Plan:
 * MDs/partner-discovery-plan-2026-10-21.md, section 4, 3.4 and 2.1.
 *
 *   - `requestPartnerAsk` stores the organiser's number and the round;
 *   - `requestPartnerRound` asks several partners at once, one round, one
 *     number for all of them, and skips a paused partner, naming it;
 *   - the sweep closes EVERY ask in a round once its number is reached
 *     (counted across the round's asks), or once the match has no open
 *     place, with each partner group's one "place is filled" line;
 *   - an organiser cancels a round by hand: "no longer needed" to each
 *     partner group that saw it, volunteers stood down;
 *   - the automatic ask still asks for every open place.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
  const m = {
    clubPartnership: { findUnique: vi.fn(), findMany: vi.fn() },
    organisation: { findUnique: vi.fn(), findMany: vi.fn() },
    match: { findUnique: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
    attendance: { count: vi.fn(), findMany: vi.fn() },
    membership: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    user: { findMany: vi.fn() },
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
vi.mock("../admin-group-log", () => ({ recordMatchTimeQuestion: vi.fn() }));
vi.mock("../group-postability-store", () => ({ isGroupPostable: vi.fn().mockResolvedValue(true) }));
const settingsMock = vi.hoisted(() => ({ loadPartnerAskSettings: vi.fn() }));
vi.mock("../club-partnership", () => settingsMock);
const attMock = vi.hoisted(() => ({ registerAttendance: vi.fn(), cancelAttendance: vi.fn() }));
vi.mock("../attendance", () => attMock);

import { cancelPartnerRound, approvePartnerAsk, loadPartnerAskPanel, requestPartnerAsk, requestPartnerRound, sweepPartnerAsks } from "../partner-ask";

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
const live = { whatsappBotEnabled: true, dormantAt: null, approvalStatus: "approved", billingStatus: "exempt", setupStage: "live" };
const SUTTON = { id: "sutton", name: "Sutton FC", language: "en", whatsappGroupId: "sutton@g.us", ...live };
const CHEAM = { id: "cheam", name: "Cheam", language: "tr", whatsappGroupId: "cheam@g.us", ...live };
const ORGS: Record<string, unknown> = { fnf: FNF, sutton: SUTTON, cheam: CHEAM };
const PAIRS: Record<string, { id: string; askerOrgId: string; partnerOrgId: string; status: string; partnerApproval: string }> = {
  p1: { id: "p1", askerOrgId: "fnf", partnerOrgId: "sutton", status: "active", partnerApproval: "each-ask" },
  p2: { id: "p2", askerOrgId: "fnf", partnerOrgId: "cheam", status: "active", partnerApproval: "each-ask" },
};
/** Home players CONFIRMED on the match: 14 of 18, so 4 places are open. */
let confirmedHome = 14;
/** Volunteers (by user id) with a CONFIRMED row on the match. */
let confirmedVolunteers = new Set<string>();

beforeEach(() => {
  vi.clearAllMocks();
  confirmedHome = 14;
  confirmedVolunteers = new Set();
  dbMock.$transaction.mockImplementation((cb: (tx: typeof dbMock) => unknown) => cb(dbMock));
  dbMock.clubPartnership.findUnique.mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve(PAIRS[where.id] ?? null));
  dbMock.clubPartnership.findMany.mockResolvedValue([
    { id: "p1", partnerOrgId: "sutton", partnerOrg: { name: "Sutton FC", dormantAt: null, billingStatus: "exempt" } },
    { id: "p2", partnerOrgId: "cheam", partnerOrg: { name: "Cheam", dormantAt: null, billingStatus: "exempt" } },
  ]);
  dbMock.organisation.findUnique.mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve(ORGS[where.id] ?? null));
  dbMock.match.findUnique.mockResolvedValue(MATCH);
  dbMock.match.findMany.mockResolvedValue([MATCH]);
  dbMock.match.findFirst.mockResolvedValue(null);
  dbMock.attendance.count.mockImplementation(({ where }: { where: { userId?: { in: string[] }; status?: string } }) => {
    if (where.userId) return Promise.resolve(where.userId.in.filter((u) => confirmedVolunteers.has(u)).length);
    return Promise.resolve(confirmedHome + confirmedVolunteers.size);
  });
  dbMock.attendance.findMany.mockImplementation(({ where }: { where: { userId: { in: string[] } } }) =>
    Promise.resolve(where.userId.in.map((u) => ({ userId: u, status: confirmedVolunteers.has(u) ? "CONFIRMED" : "BENCH" }))),
  );
  dbMock.membership.findUnique.mockResolvedValue({ role: "ADMIN", leftAt: null });
  dbMock.membership.findMany.mockImplementation(({ where }: { where: { userId: { in: string[] } } }) =>
    Promise.resolve(where.userId.in.map((u) => ({ userId: u, guestFromOrgId: "sutton", guestMatchId: "m1", leftAt: null }))),
  );
  dbMock.membership.updateMany.mockResolvedValue({ count: 1 });
  dbMock.user.findMany.mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
    Promise.resolve(where.id.in.map((id) => ({ id, phoneNumber: `+44${id}` }))),
  );
  dbMock.partnerAsk.count.mockResolvedValue(0);
  let n = 0;
  dbMock.partnerAsk.create.mockImplementation(() => Promise.resolve({ id: `ask${++n}` }));
  dbMock.partnerAsk.updateMany.mockResolvedValue({ count: 1 });
  dbMock.botJob.create.mockResolvedValue({ id: "job1" });
  noticeMock.sendAdminNotice.mockResolvedValue({ channel: "dm", queued: 1 });
  settingsMock.loadPartnerAskSettings.mockResolvedValue({ when: "on-request", time: null, cutoffHours: 4 });
});

const createdData = () => dbMock.partnerAsk.create.mock.calls.map((c) => c[0].data);
const groupLines = () => dbMock.botJob.create.mock.calls.map((c) => c[0].data).filter((d) => d.kind === "group");

describe("requestPartnerAsk: the chosen number and the round", () => {
  it("asks for the organiser's number, not every open place, and carries the round", async () => {
    const r = await requestPartnerAsk({ askerOrgId: "fnf", matchId: "m1", partnershipId: "p1", requestedByUserId: "admin", via: "button", places: 1, roundId: "r1", now: NOW });
    expect(r).toMatchObject({ ok: true, status: "awaiting-approval", places: 1 });
    expect(createdData()[0]).toMatchObject({ places: 1, roundId: "r1" });
    // The partner's organisers are asked for ONE player.
    expect(noticeMock.sendAdminNotice.mock.calls[0][0].text("L", "dm")).toContain("ask if one of your players can play");
  });

  it("more than the open places is refused and nothing is written", async () => {
    const r = await requestPartnerAsk({ askerOrgId: "fnf", matchId: "m1", partnershipId: "p1", requestedByUserId: "admin", via: "button", places: 5, now: NOW });
    expect(r).toMatchObject({ ok: false, refusal: "bad-number" });
    expect(dbMock.partnerAsk.create).not.toHaveBeenCalled();
  });

  it("the automatic ask (no number) still asks for every open place", async () => {
    settingsMock.loadPartnerAskSettings.mockResolvedValue({ when: "auto", time: null, cutoffHours: 4 });
    const r = await requestPartnerAsk({ askerOrgId: "fnf", matchId: "m1", partnershipId: "p1", requestedByUserId: null, via: "auto", now: NOW });
    expect(r).toMatchObject({ ok: true, places: 4 });
    expect(createdData()[0]).toMatchObject({ places: 4, roundId: null });
  });

  it("standing permission: the post asks for the organiser's number, never rewritten to the open places", async () => {
    dbMock.clubPartnership.findUnique.mockResolvedValue({ ...PAIRS.p1, partnerApproval: "standing" });
    dbMock.partnerAsk.findUnique.mockResolvedValue({ id: "ask1", status: "awaiting-approval", askerOrgId: "fnf", partnerOrgId: "sutton", matchId: "m1", places: 1, roundId: "r1", volunteerUserIds: [], pickedUserIds: [] });
    await requestPartnerAsk({ askerOrgId: "fnf", matchId: "m1", partnershipId: "p1", requestedByUserId: "admin", via: "button", places: 1, roundId: "r1", now: NOW });
    expect(groupLines()[0].text).toContain("*FNF* need 1 player");
    const posted = dbMock.partnerAsk.updateMany.mock.calls.find((c) => c[0].data.status === "posted");
    expect(posted?.[0].data.places).toBeUndefined();
  });
});

describe("requestPartnerRound: several partners, one number for all", () => {
  it("asking 2 partners for 1 player: two asks, one shared round, each carrying 1", async () => {
    const r = await requestPartnerRound({ askerOrgId: "fnf", matchId: "m1", partnershipIds: ["p1", "p2"], places: 1, requestedByUserId: "admin", via: "button", now: NOW });
    expect(r.asked).toBe(2);
    expect(r.skippedPaused).toEqual([]);
    const [a, b] = createdData();
    expect(a).toMatchObject({ partnerOrgId: "sutton", places: 1 });
    expect(b).toMatchObject({ partnerOrgId: "cheam", places: 1 });
    expect(a.roundId).toBeTruthy();
    expect(b.roundId).toBe(a.roundId);
    expect(r.roundId).toBe(a.roundId);
  });

  it("'all partners' skips a paused partner, writes nothing for it, and names it", async () => {
    dbMock.clubPartnership.findMany.mockResolvedValue([
      { id: "p1", partnerOrgId: "sutton", partnerOrg: { name: "Sutton FC", dormantAt: null, billingStatus: "exempt" } },
      { id: "p2", partnerOrgId: "cheam", partnerOrg: { name: "Cheam", dormantAt: new Date("2026-10-01"), billingStatus: "exempt" } },
    ]);
    const r = await requestPartnerRound({ askerOrgId: "fnf", matchId: "m1", partnershipIds: "all", places: 1, requestedByUserId: "admin", via: "button", now: NOW });
    expect(r.asked).toBe(1);
    expect(r.skippedPaused).toEqual(["Cheam"]);
    expect(createdData().map((d) => d.partnerOrgId)).toEqual(["sutton"]);
    // Nothing reaches the paused club at all.
    expect(noticeMock.sendAdminNotice.mock.calls.map((c) => c[0].orgId)).not.toContain("cheam");
    expect(groupLines().map((d) => d.orgId)).not.toContain("cheam");
  });

  it("a billing-paused partner is held the same way (BILLING_ENABLED on)", async () => {
    vi.stubEnv("BILLING_ENABLED", "1");
    try {
      dbMock.clubPartnership.findMany.mockResolvedValue([
        { id: "p1", partnerOrgId: "sutton", partnerOrg: { name: "Sutton FC", dormantAt: null, billingStatus: "paused" } },
      ]);
      const r = await requestPartnerRound({ askerOrgId: "fnf", matchId: "m1", partnershipIds: "all", places: 1, requestedByUserId: "admin", via: "button", now: NOW });
      expect(r).toMatchObject({ asked: 0, skippedPaused: ["Sutton FC"] });
      expect(dbMock.partnerAsk.create).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the round's fill, in the sweep", () => {
  const ask = (id: string, partnerOrgId: string, over: Record<string, unknown> = {}) => ({
    id,
    roundId: "r1",
    places: 1,
    status: "posted",
    askerOrgId: "fnf",
    partnerOrgId,
    matchId: "m1",
    postBy: new Date(KICKOFF.getTime() - 4 * H),
    closesAt: KICKOFF,
    postedAt: new Date(NOW.getTime() - 60_000),
    postWaMessageId: "wamid",
    postJobId: "job",
    volunteerUserIds: [] as string[],
    pickedUserIds: [] as string[],
    partnership: { status: "active" },
    match: MATCH,
    ...over,
  });
  const useAsks = (asks: Array<ReturnType<typeof ask>>) => {
    dbMock.partnerAsk.findMany.mockImplementation(({ where }: { where: { roundId?: string; OR?: unknown } }) =>
      Promise.resolve(where.roundId ? asks.filter((a) => a.roundId === where.roundId) : asks.filter((a) => a.status === "posted" || a.status === "awaiting-approval")),
    );
    dbMock.partnerAsk.findUnique.mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve(asks.find((a) => a.id === where.id) ?? null));
  };

  it("one player wanted from two clubs: Sutton's volunteer has the place, so BOTH asks close as filled, each group hears its one line", async () => {
    confirmedVolunteers = new Set(["v1"]);
    useAsks([ask("a1", "sutton", { volunteerUserIds: ["v1"] }), ask("a2", "cheam")]);
    expect(await sweepPartnerAsks("fnf", NOW)).toEqual({ closed: 2 });
    for (const id of ["a1", "a2"]) {
      expect(dbMock.partnerAsk.updateMany).toHaveBeenCalledWith({ where: { id, status: "posted" }, data: { status: "filled", reason: "filled", closedAt: NOW } });
    }
    expect(groupLines()).toEqual([
      { orgId: "sutton", kind: "group", text: "✅ *FNF*'s place is filled, thanks all 🙌" },
      { orgId: "cheam", kind: "group", text: "✅ *FNF* için yer doldu, herkese teşekkürler 🙌" },
    ]);
  });

  it("two wanted, one placed: the round stays open", async () => {
    confirmedVolunteers = new Set(["v1"]);
    useAsks([ask("a1", "sutton", { places: 2, volunteerUserIds: ["v1"] }), ask("a2", "cheam", { places: 2 })]);
    expect(await sweepPartnerAsks("fnf", NOW)).toEqual({ closed: 0 });
  });

  it("organiser pick: volunteers on the bench do not count; once the organisers have picked the number, the round closes and the rest are stood down", async () => {
    useAsks([ask("a1", "sutton", { places: 1, volunteerUserIds: ["v1", "v2"] }), ask("a2", "cheam", { places: 1 })]);
    expect(await sweepPartnerAsks("fnf", NOW)).toEqual({ closed: 0 });
    // The organisers pick v1 from the bench.
    confirmedVolunteers = new Set(["v1"]);
    expect(await sweepPartnerAsks("fnf", NOW)).toEqual({ closed: 2 });
    // v2, still on the bench, is stood down and thanked; v1 keeps his place.
    expect(attMock.cancelAttendance).toHaveBeenCalledTimes(1);
    expect(attMock.cancelAttendance).toHaveBeenCalledWith("v2", "m1", expect.objectContaining({ cause: "partner-ask" }));
    const dms = dbMock.botJob.create.mock.calls.map((c) => c[0].data).filter((d) => d.kind === "dm");
    expect(dms).toEqual([{ orgId: "sutton", kind: "dm", phone: "44v2", text: "*FNF* have their player now. Thanks for offering 🙏" }]);
  });

  it("the squad fills by a home IN or a manual add, below the round's number: every ask closes as filled", async () => {
    confirmedHome = 18;
    useAsks([ask("a1", "sutton", { places: 2 }), ask("a2", "cheam", { places: 2, status: "awaiting-approval", postedAt: null, postWaMessageId: null })]);
    expect(await sweepPartnerAsks("fnf", NOW)).toEqual({ closed: 2 });
    expect(dbMock.partnerAsk.updateMany).toHaveBeenCalledWith({ where: { id: "a1", status: "posted" }, data: { status: "filled", reason: "filled", closedAt: NOW } });
    // The one still waiting for approval never reached the group: cancelled, no line there.
    expect(dbMock.partnerAsk.updateMany).toHaveBeenCalledWith({ where: { id: "a2", status: "awaiting-approval" }, data: { status: "cancelled", reason: "filled", closedAt: NOW } });
    expect(groupLines().map((d) => d.orgId)).toEqual(["sutton"]);
  });

  it("a partner paused since the ask went out: nothing is queued in its group, not even the closing line", async () => {
    ORGS.cheam = { ...CHEAM, dormantAt: new Date("2026-10-15") };
    try {
      confirmedVolunteers = new Set(["v1"]);
      useAsks([ask("a1", "sutton", { volunteerUserIds: ["v1"] }), ask("a2", "cheam")]);
      expect(await sweepPartnerAsks("fnf", NOW)).toEqual({ closed: 2 });
      expect(groupLines().map((d) => d.orgId)).toEqual(["sutton"]);
    } finally {
      ORGS.cheam = CHEAM;
    }
  });

  it("an approval in a round already filled posts nothing", async () => {
    confirmedVolunteers = new Set(["v1"]);
    const asks = [ask("a1", "sutton", { volunteerUserIds: ["v1"] }), ask("a2", "cheam", { status: "awaiting-approval", partnershipId: "p2" })];
    useAsks(asks);
    expect(await approvePartnerAsk({ askId: "a2", userId: "cheamAdmin", now: NOW })).toEqual({ ok: false, outcome: "no-places" });
    expect(groupLines()).toEqual([]);
  });
});

describe("cancelPartnerRound: an organiser cancels by hand (Kemal, 2026-10-22)", () => {
  const asks = [
    { id: "a1", roundId: "r1", places: 1, status: "posted", askerOrgId: "fnf", partnerOrgId: "sutton", matchId: "m1", volunteerUserIds: ["v1"], pickedUserIds: [] },
    { id: "a2", roundId: "r1", places: 1, status: "awaiting-approval", askerOrgId: "fnf", partnerOrgId: "cheam", matchId: "m1", volunteerUserIds: [], pickedUserIds: [] },
  ];
  beforeEach(() => {
    dbMock.partnerAsk.findMany.mockResolvedValue(asks);
    dbMock.partnerAsk.findUnique.mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve(asks.find((a) => a.id === where.id) ?? null));
  });

  it("every open ask in the round closes; the group that saw it hears 'no longer needed'; volunteers are stood down", async () => {
    const r = await cancelPartnerRound({ askerOrgId: "fnf", matchId: "m1", roundKey: "r1", userId: "admin", now: NOW });
    expect(r).toEqual({ ok: true, cancelled: 2 });
    expect(dbMock.partnerAsk.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ matchId: "m1", askerOrgId: "fnf", status: { in: ["awaiting-approval", "posted"] }, OR: [{ roundId: "r1" }, { id: "r1" }] }) }),
    );
    expect(dbMock.partnerAsk.updateMany).toHaveBeenCalledWith({ where: { id: "a1", status: "posted" }, data: { status: "cancelled", reason: "organiser-cancelled", closedAt: NOW } });
    expect(dbMock.partnerAsk.updateMany).toHaveBeenCalledWith({ where: { id: "a2", status: "awaiting-approval" }, data: { status: "cancelled", reason: "organiser-cancelled", closedAt: NOW } });
    // Only the group that saw the ask hears about it.
    expect(groupLines()).toEqual([{ orgId: "sutton", kind: "group", text: "*FNF* no longer need a player, thanks all." }]);
    // v1 was on the bench: stood down, told he is not needed.
    expect(attMock.cancelAttendance).toHaveBeenCalledWith("v1", "m1", expect.objectContaining({ cause: "partner-ask" }));
    const dms = dbMock.botJob.create.mock.calls.map((c) => c[0].data).filter((d) => d.kind === "dm");
    expect(dms).toEqual([{ orgId: "sutton", kind: "dm", phone: "44v1", text: "*FNF* no longer need a player, so you're not needed after all. Thanks for offering 🙏" }]);
  });

  it("a player cannot cancel: nothing changes", async () => {
    dbMock.membership.findUnique.mockResolvedValue({ role: "PLAYER", leftAt: null });
    expect(await cancelPartnerRound({ askerOrgId: "fnf", matchId: "m1", roundKey: "r1", userId: "p", now: NOW })).toEqual({ ok: false, cancelled: 0 });
    expect(dbMock.partnerAsk.updateMany).not.toHaveBeenCalled();
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });
});

describe("loadPartnerAskPanel", () => {
  it("the open places, each partner (a paused one marked and not offered), and each open round with its number and fill", async () => {
    vi.stubEnv("BILLING_ENABLED", "1");
    try {
      dbMock.clubPartnership.findMany.mockResolvedValue([
        { id: "p1", partnerOrgId: "sutton", partnerOrg: { name: "Sutton FC", dormantAt: null, billingStatus: "exempt" } },
        { id: "p2", partnerOrgId: "cheam", partnerOrg: { name: "Cheam", dormantAt: null, billingStatus: "paused" } },
      ]);
      confirmedVolunteers = new Set(["v1"]);
      confirmedHome = 13; // 13 + v1 of 18: 4 open
      dbMock.partnerAsk.findMany.mockResolvedValue([
        { id: "a1", roundId: "r1", places: 2, partnerOrgId: "sutton", status: "posted", volunteerUserIds: ["v1", "v2"], pickedUserIds: [] },
      ]);
      const panel = await loadPartnerAskPanel("m1", "fnf");
      expect(panel).toEqual({
        placesOpen: 4,
        rows: [
          { partnershipId: "p1", partnerName: "Sutton FC", status: "posted", volunteers: 2, paused: false, roundKey: "r1" },
          { partnershipId: "p2", partnerName: "Cheam", status: null, volunteers: 0, paused: true, roundKey: null },
        ],
        rounds: [{ roundKey: "r1", wanted: 2, placed: 1, partners: ["Sutton FC"] }],
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
