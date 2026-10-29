/**
 * A MONTHLY CLUB'S WEEK and the partner ask (Vets MNF, 2026-10-29). The
 * monthly week's own reads (`monthly-week-asks.ts`) are stubbed here; their
 * rules are `monthly-week-asks-rules.test.ts`, and the whole path runs in
 * `e2e/sim/pool/monthly-week.spec.ts`.
 *
 *   - the automatic ask waits while the club's own bench and PAYG players
 *     have the place (`clubFillsFirstFor`), and asks once they have had it;
 *   - the places asked for are the monthly week's (`askPlacesOpen`);
 *   - the partner club is told the club's PAYG price as the fee.
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
// The pool's part of the automatic ask (slice L9) is its own module, tested
// in pool/__tests__/auto-ask.test.ts; here only the wiring.
const poolAutoMock = vi.hoisted(() => ({ poolAutoAskClub: vi.fn(), autoAskPool: vi.fn() }));
vi.mock("../pool/auto-ask", () => poolAutoMock);
const weekMock = vi.hoisted(() => ({ askPlacesOpen: vi.fn(), clubFillsFirstFor: vi.fn(), guestPaygPence: vi.fn() }));
vi.mock("../monthly-week-asks", () => weekMock);

import { requestPartnerAsk, sweepAutoPartnerAsks } from "../partner-ask";

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
  activity: { orgId: "fnf", venue: "Goals Sutton", dayOfWeek: 5, feePerPlayer: 6, feeSplitTotal: false, matchDurationMins: 60, sport: { playersPerTeam: 9 } },
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
  poolAutoMock.poolAutoAskClub.mockResolvedValue({ poolOpen: false, poolAutoAsk: false, language: "en" });
  poolAutoMock.autoAskPool.mockResolvedValue(null);
  weekMock.askPlacesOpen.mockResolvedValue(1);
  weekMock.clubFillsFirstFor.mockResolvedValue(false);
  weekMock.guestPaygPence.mockResolvedValue(null);
});

describe("the automatic ask in a monthly club's week", () => {
  const POOL_ON = { poolOpen: true, poolAutoAsk: true, language: "en" };

  it("the club's own PAYG players still have the place: neither the partners nor the pool are asked", async () => {
    poolAutoMock.poolAutoAskClub.mockResolvedValue(POOL_ON);
    weekMock.clubFillsFirstFor.mockResolvedValue(true);
    expect(await sweepAutoPartnerAsks("fnf", AT_1601)).toEqual({ asked: 0 });
    expect(weekMock.clubFillsFirstFor).toHaveBeenCalledWith("m1", AT_1601);
    expect(dbMock.partnerAsk.create).not.toHaveBeenCalled();
    expect(poolAutoMock.autoAskPool).not.toHaveBeenCalled();
  });

  it("their hour is up: the partner is asked, and the pool offered the monthly week's places", async () => {
    poolAutoMock.poolAutoAskClub.mockResolvedValue(POOL_ON);
    weekMock.askPlacesOpen.mockResolvedValue(2);
    expect(await sweepAutoPartnerAsks("fnf", AT_1601)).toEqual({ asked: 1 });
    expect(dbMock.partnerAsk.create.mock.calls[0][0].data).toMatchObject({ places: 2 });
    expect(poolAutoMock.autoAskPool.mock.calls[0][0]).toMatchObject({ placesOpen: 2, waitingCount: 0 });
  });

  it("outside the club's window, or with no place open: the monthly week is not even read", async () => {
    await sweepAutoPartnerAsks("fnf", new Date("2026-10-30T15:59:00Z"));
    weekMock.askPlacesOpen.mockResolvedValue(0);
    await sweepAutoPartnerAsks("fnf", AT_1601);
    expect(weekMock.clubFillsFirstFor).not.toHaveBeenCalled();
  });
});

describe("the fee a partner club is shown", () => {
  const ask = () => requestPartnerAsk({ askerOrgId: "fnf", matchId: "m1", partnershipId: "p1", requestedByUserId: null, via: "auto", now: AT_1601 });

  it("a monthly week: the club's PAYG price, what a guest is charged there", async () => {
    weekMock.guestPaygPence.mockResolvedValue(800);
    await ask();
    const toSutton = noticeMock.sendAdminNotice.mock.calls.map((c) => c[0]).find((n) => n.orgId === "sutton");
    const text = typeof toSutton.text === "function" ? toSutton.text("L", "dm") : toSutton.text;
    expect(text).toContain("£8");
    expect(text).not.toContain("£6");
  });

  it("a weekly club: the activity's fee, as before", async () => {
    await ask();
    const toSutton = noticeMock.sendAdminNotice.mock.calls.map((c) => c[0]).find((n) => n.orgId === "sutton");
    const text = typeof toSutton.text === "function" ? toSutton.text("L", "dm") : toSutton.text;
    expect(text).toContain("£6");
  });
});
