/**
 * The automatic ask and the organisers' line, with the database (slice S5).
 * `sweepAutoPartnerAsks` asks through `requestPartnerAsk`, so every rule of
 * a button press applies, and tells the asking club's organisers;
 * `partnerOfferFor` names the partners its organisers could still ask, or
 * nothing, which leaves their notice exactly as it was.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
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
}));
vi.mock("../db", () => ({ db: dbMock }));
const noticeMock = vi.hoisted(() => ({ sendAdminNotice: vi.fn() }));
vi.mock("../admin-channel", () => noticeMock);
vi.mock("../admin-group-log", () => ({ recordMatchTimeQuestion: vi.fn() }));
vi.mock("../group-postability-store", () => ({ isGroupPostable: vi.fn().mockResolvedValue(true) }));
const settingsMock = vi.hoisted(() => ({ loadPartnerAskSettings: vi.fn() }));
vi.mock("../club-partnership", () => settingsMock);

import { partnerOfferFor, sweepAutoPartnerAsks } from "../partner-ask";

const KICKOFF = new Date("2026-10-30T20:30:00Z"); // Fri 30 Oct 20:30 London (GMT)
const AT_1601 = new Date("2026-10-30T16:01:00Z");
const MATCH = {
  id: "m1",
  date: KICKOFF,
  status: "UPCOMING",
  isHistorical: false,
  maxPlayers: 18,
  activityId: "act",
  feePerPlayer: null,
  activity: { orgId: "fnf", venue: "Goals Sutton", dayOfWeek: 5, feePerPlayer: 8, feeSplitTotal: false, matchDurationMins: 60, sport: { playersPerTeam: 9 } },
};
const SUTTON = {
  id: "sutton",
  name: "Sutton FC",
  language: "en",
  whatsappGroupId: "s@g.us",
  whatsappBotEnabled: true,
  dormantAt: null,
  approvalStatus: "approved",
  billingStatus: "exempt",
  setupStage: "live",
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.$transaction.mockImplementation((cb: (tx: typeof dbMock) => unknown) => cb(dbMock));
  settingsMock.loadPartnerAskSettings.mockResolvedValue({ when: "auto", time: "16:00", cutoffHours: 4 });
  dbMock.clubPartnership.findMany.mockResolvedValue([{ id: "p1", partnerOrgId: "sutton", partnerOrg: { name: "Sutton FC" } }]);
  dbMock.clubPartnership.findUnique.mockResolvedValue({ id: "p1", askerOrgId: "fnf", partnerOrgId: "sutton", status: "active", partnerApproval: "each-ask" });
  dbMock.organisation.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(where.id === "fnf" ? { id: "fnf", name: "FNF", language: "en" } : SUTTON),
  );
  dbMock.match.findMany.mockImplementation(({ where }: { where: { activity: { orgId: string } } }) =>
    Promise.resolve(where.activity.orgId === "fnf" ? [MATCH] : []),
  );
  dbMock.match.findUnique.mockResolvedValue(MATCH);
  dbMock.match.findFirst.mockResolvedValue(null);
  dbMock.attendance.count.mockImplementation(({ where }: { where: { status: string } }) => Promise.resolve(where.status === "BENCH" ? 0 : 17));
  dbMock.partnerAsk.count.mockResolvedValue(0);
  dbMock.partnerAsk.create.mockResolvedValue({ id: "ask1" });
  dbMock.partnerAsk.findMany.mockResolvedValue([]);
  noticeMock.sendAdminNotice.mockResolvedValue({ channel: "dm", queued: 1 });
});

describe("sweepAutoPartnerAsks", () => {
  it("at the club's time on match day, a place open and nobody on the bench: asks, and tells the organisers", async () => {
    expect(await sweepAutoPartnerAsks("fnf", AT_1601)).toEqual({ asked: 1 });
    expect(dbMock.partnerAsk.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ requestedVia: "auto", requestedByUserId: null }) }));
    const toFnf = noticeMock.sendAdminNotice.mock.calls.map((c) => c[0]).filter((n) => n.orgId === "fnf");
    expect(toFnf).toHaveLength(1);
    expect(toFnf[0].text).toContain("Your automatic ask");
  });

  it("before the time: nothing", async () => {
    expect(await sweepAutoPartnerAsks("fnf", new Date("2026-10-30T15:59:00Z"))).toEqual({ asked: 0 });
    expect(dbMock.partnerAsk.create).not.toHaveBeenCalled();
  });

  it("someone on the club's own bench: nothing (its own members first)", async () => {
    dbMock.attendance.count.mockImplementation(({ where }: { where: { status: string } }) => Promise.resolve(where.status === "BENCH" ? 1 : 17));
    expect(await sweepAutoPartnerAsks("fnf", AT_1601)).toEqual({ asked: 0 });
  });

  it("this partner already asked for this match, open or closed: never again", async () => {
    dbMock.partnerAsk.count.mockResolvedValue(1);
    expect(await sweepAutoPartnerAsks("fnf", AT_1601)).toEqual({ asked: 0 });
  });

  it("the partner's own game at an overlapping time is short: not asked", async () => {
    dbMock.match.findMany.mockImplementation(({ where }: { where: { activity: { orgId: string } } }) =>
      Promise.resolve(
        where.activity.orgId === "fnf"
          ? [MATCH]
          : [{ id: "own", date: new Date("2026-10-30T21:00:00Z"), maxPlayers: 14, activity: { matchDurationMins: 60 } }],
      ),
    );
    dbMock.attendance.count.mockImplementation(({ where }: { where: { status: string; matchId: string } }) =>
      Promise.resolve(where.status === "BENCH" ? 0 : where.matchId === "own" ? 12 : 17),
    );
    expect(await sweepAutoPartnerAsks("fnf", AT_1601)).toEqual({ asked: 0 });
  });

  it("a club not on Automatically makes one read and asks nothing", async () => {
    settingsMock.loadPartnerAskSettings.mockResolvedValue({ when: "on-request", time: null, cutoffHours: 4 });
    expect(await sweepAutoPartnerAsks("fnf", AT_1601)).toEqual({ asked: 0 });
    expect(dbMock.clubPartnership.findMany).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    settingsMock.loadPartnerAskSettings.mockRejectedValue(new Error("down"));
    await expect(sweepAutoPartnerAsks("fnf", AT_1601)).resolves.toEqual({ asked: 0 });
  });
});

describe("partnerOfferFor: the organisers' line", () => {
  it("names the partners they could still ask", async () => {
    expect(await partnerOfferFor("fnf", MATCH, new Date("2026-10-30T09:00:00Z"))).toEqual(["Sutton FC"]);
  });
  it("nothing when asking is Off, past the cut-off, or an ask to each is already open", async () => {
    settingsMock.loadPartnerAskSettings.mockResolvedValue({ when: "off", time: null, cutoffHours: 4 });
    expect(await partnerOfferFor("fnf", MATCH, new Date("2026-10-30T09:00:00Z"))).toBeNull();
    settingsMock.loadPartnerAskSettings.mockResolvedValue({ when: "on-request", time: null, cutoffHours: 4 });
    expect(await partnerOfferFor("fnf", MATCH, new Date("2026-10-30T16:30:00Z"))).toBeNull();
    dbMock.partnerAsk.findMany.mockResolvedValue([{ partnerOrgId: "sutton" }]);
    expect(await partnerOfferFor("fnf", MATCH, new Date("2026-10-30T09:00:00Z"))).toBeNull();
  });
  it("no partner club (every club today): nothing", async () => {
    settingsMock.loadPartnerAskSettings.mockResolvedValue({ when: "on-request", time: null, cutoffHours: 4 });
    dbMock.clubPartnership.findMany.mockResolvedValue([]);
    expect(await partnerOfferFor("fnf", MATCH, new Date("2026-10-30T09:00:00Z"))).toBeNull();
  });
});
