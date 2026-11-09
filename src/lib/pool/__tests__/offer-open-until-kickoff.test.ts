/**
 * A POOL OFFER STAYS OPEN UNTIL KICKOFF (Kemal, 2026-11-09: "it shouldn't
 * expire until the match start time").
 *
 * The real case: Monday night vets asked for 2 players on Sunday 8 Nov at
 * 20:38 for a game at 20:30 on Monday 9 Nov. Four offers went at 20:38 and,
 * under the old six-hour clock, ended at 02:38 overnight as "ignored"; one
 * player was paused after his third. Now the sweep (`round.ts` `sweepPool`)
 * leaves a sent offer open through the night and past the club's cut-off;
 * it ends at kickoff ("ignored": it was his to answer), unless the round
 * fills first ("expired", never counted against him). The cut-off still
 * stops anything NEW going out.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const KICKOFF = new Date("2026-11-09T20:30:00Z");
const SENT = new Date("2026-11-08T20:38:00Z");
const CUTOFF_HOURS = 2;
const CUTOFF = new Date(KICKOFF.getTime() - CUTOFF_HOURS * 3600_000);

const dbMock = vi.hoisted(() => ({
  poolAsk: { findMany: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
  poolOffer: { findMany: vi.fn(), updateMany: vi.fn() },
  poolProfile: { findUnique: vi.fn(), updateMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("../../db", () => ({ db: dbMock }));
vi.mock("../dispatch", () => ({ stampUnreportedDeliveries: vi.fn(async () => 0), POOL_OFFER_PURPOSE: "pool-offer" }));
vi.mock("../../club-partnership", () => ({ loadPartnerAskSettings: vi.fn(async () => ({ cutoffHours: CUTOFF_HOURS })) }));
const fill = vi.hoisted(() => ({ placed: 0, wanted: 2, placesOpen: 2 }));
vi.mock("../../partner-ask-round", () => ({ loadRoundFill: vi.fn(async () => ({ placed: fill.placed, wanted: fill.wanted })) }));
vi.mock("../../monthly-week-asks", () => ({ askPlacesOpen: vi.fn(async () => fill.placesOpen) }));
const jobs = vi.hoisted(() => ({ queuePlatformDm: vi.fn(async () => ({ id: "job1" })), cancelQueuedPlatformDms: vi.fn(async () => 0) }));
vi.mock("../../platform-jobs", () => jobs);
vi.mock("../flags", async (orig) => ({
  ...(await orig<typeof import("../flags")>()),
  poolOffersOpenForClub: () => true,
  poolSwitchUnread: () => false,
  isPoolOffersEnabled: () => true,
}));
const candidates = vi.hoisted(() => ({ findPoolCandidates: vi.fn() }));
vi.mock("../candidates", () => candidates);
vi.mock("../offer-facts", () => ({ loadMatchOfferFacts: vi.fn(async () => ({ club: "Vets" })) }));
vi.mock("../offer-copy", () => ({ poolOfferText: vi.fn(() => "offer"), poolPausedText: vi.fn(() => "paused") }));
vi.mock("../links", () => ({ buildPoolManageLink: vi.fn(async () => "https://x/m") }));

import { sweepPool } from "../round";

const ASK = {
  id: "ask1",
  matchId: "m1",
  orgId: "vets",
  roundId: null,
  places: 2,
  via: "words",
  createdAt: SENT,
  org: { featurePlayerPool: true },
  match: { date: KICKOFF, status: "UPCOMING", isHistorical: false },
};

/** Four sent in wave 1 (one never delivered), and wave 2 already out. */
const OPEN_OFFERS = [
  { id: "o1", userId: "u1", sentAt: SENT },
  { id: "o2", userId: "u2", sentAt: SENT },
  { id: "o3", userId: "u3", sentAt: SENT },
  { id: "o4", userId: "u4", sentAt: null },
];
let waves: Array<{ wave: number; sentAt: Date | null }> = [];

const offerWrites = () => dbMock.poolOffer.updateMany.mock.calls.map((c) => ({ id: c[0].where.id, outcome: c[0].data.outcome }));
const askWrites = () => dbMock.poolAsk.updateMany.mock.calls.map((c) => c[0].data);

beforeEach(() => {
  vi.clearAllMocks();
  fill.placed = 0;
  fill.wanted = 2;
  fill.placesOpen = 2;
  waves = [...OPEN_OFFERS.map(() => ({ wave: 1, sentAt: SENT })), { wave: 2, sentAt: SENT }];
  dbMock.poolAsk.findMany.mockResolvedValue([ASK]);
  dbMock.poolAsk.updateMany.mockResolvedValue({ count: 1 });
  dbMock.poolOffer.updateMany.mockResolvedValue({ count: 1 });
  dbMock.poolOffer.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    if (where.userId) return []; // his ledger: nothing ignored before
    if (where.outcome === null) return OPEN_OFFERS; // closePoolAsk: the open ones
    return waves; // the sweep's wave check
  });
  dbMock.poolProfile.findUnique.mockResolvedValue({ status: "active", language: "en", lastActiveAt: null, user: { phoneNumber: "+447700900111" } });
  dbMock.poolProfile.updateMany.mockResolvedValue({ count: 1 });
});

describe("before kickoff nothing ends on its own", () => {
  for (const [label, now] of [
    ["six hours after sending (02:38, the old expiry)", new Date(SENT.getTime() + 6 * 3600_000)],
    ["the morning of the game", new Date("2026-11-09T09:00:00Z")],
    ["at the club's cut-off", CUTOFF],
    ["past the cut-off, a minute before kickoff", new Date(KICKOFF.getTime() - 60_000)],
  ] as const) {
    it(`${label}: the ask stays open and every offer stays open`, async () => {
      expect(await sweepPool(now, {})).toEqual({ closed: 0, queued: 0 });
      expect(dbMock.poolAsk.updateMany).not.toHaveBeenCalled();
      expect(dbMock.poolOffer.updateMany).not.toHaveBeenCalled();
      expect(dbMock.poolProfile.updateMany).not.toHaveBeenCalled();
    });
  }
});

describe("at kickoff", () => {
  it("unanswered offers that reached him end ignored; the one that never went is cancelled; the ask closes at kickoff", async () => {
    expect(await sweepPool(KICKOFF, {})).toMatchObject({ closed: 1 });
    expect(askWrites()).toEqual([expect.objectContaining({ status: "closed", closeReason: "kickoff" })]);
    expect(offerWrites()).toEqual([
      { id: "o1", outcome: "ignored" },
      { id: "o2", outcome: "ignored" },
      { id: "o3", outcome: "ignored" },
      { id: "o4", outcome: "cancelled" },
    ]);
    // The pause rule looks at each person whose offer he ignored, and only them.
    expect(dbMock.poolProfile.findUnique.mock.calls.map((c) => c[0].where.userId)).toEqual(["u1", "u2", "u3"]);
    expect(jobs.cancelQueuedPlatformDms).toHaveBeenCalledWith(expect.objectContaining({ refIds: ["o4"] }));
  });

  it("the third ignored offer in a row pauses him, as before", async () => {
    const earlier = (d: string) => ({ userId: "u1", matchId: `old-${d}`, orgId: "c", sentAt: new Date(d), createdAt: new Date(d), outcome: "ignored", resolvedAt: new Date(d) });
    dbMock.poolOffer.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      if (where.userId === "u1") return [earlier("2026-10-25T12:00:00Z"), earlier("2026-11-01T12:00:00Z"), { ...earlier("2026-11-08T20:38:00Z"), matchId: "m1" }];
      if (where.userId) return [];
      if (where.outcome === null) return OPEN_OFFERS;
      return waves;
    });
    await sweepPool(KICKOFF, {});
    expect(dbMock.poolProfile.updateMany).toHaveBeenCalledTimes(1);
    expect(dbMock.poolProfile.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "u1", status: "active" }, data: expect.objectContaining({ status: "paused", pausedReason: "ignored" }) }));
  });
});

describe("a round that filled is nobody's fault", () => {
  it("filled before kickoff: its open offers end expired, nobody is checked for ignoring", async () => {
    fill.placed = 2;
    expect(await sweepPool(new Date(KICKOFF.getTime() - 3 * 3600_000), {})).toMatchObject({ closed: 1 });
    expect(askWrites()).toEqual([expect.objectContaining({ status: "filled", closeReason: "filled" })]);
    expect(offerWrites().filter((w) => w.outcome === "ignored")).toEqual([]);
    expect(offerWrites().map((w) => w.outcome)).toEqual(["expired", "expired", "expired", "cancelled"]);
    expect(dbMock.poolProfile.findUnique).not.toHaveBeenCalled();
  });

  it("filled and only swept after kickoff (a late poll): still expired, never ignored", async () => {
    fill.placesOpen = 0;
    await sweepPool(new Date(KICKOFF.getTime() + 10 * 60_000), {});
    expect(askWrites()).toEqual([expect.objectContaining({ closeReason: "filled" })]);
    expect(offerWrites().filter((w) => w.outcome === "ignored")).toEqual([]);
    expect(dbMock.poolProfile.findUnique).not.toHaveBeenCalled();
  });

  it("the game called off at kickoff: expired, never ignored", async () => {
    dbMock.poolAsk.findMany.mockResolvedValue([{ ...ASK, match: { ...ASK.match, status: "CANCELLED" } }]);
    await sweepPool(KICKOFF, {});
    expect(askWrites()).toEqual([expect.objectContaining({ closeReason: "match-off" })]);
    expect(offerWrites().filter((w) => w.outcome === "ignored")).toEqual([]);
  });
});

describe("the cut-off still stops anything new", () => {
  it("an ask past the cut-off whose first wave never went sends none now, and stays open", async () => {
    waves = [];
    expect(await sweepPool(new Date(CUTOFF.getTime() + 60_000), {})).toEqual({ closed: 0, queued: 0 });
    expect(candidates.findPoolCandidates).not.toHaveBeenCalled();
    expect(dbMock.$transaction).not.toHaveBeenCalled();
    expect(dbMock.poolAsk.updateMany).not.toHaveBeenCalled();
  });
});
