/**
 * The automatic ask includes the pool (slice L9): the thin adapter. It reads
 * the club's pool switches and what the match already has, asks the pure
 * rule, and makes the ask through the organiser tap's own function
 * (`requestPoolAsk`, via "auto"), so every cap, quiet hours, the cut-off and
 * partners-first are that function's. The organisers hear one line.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  organisation: { findUnique: vi.fn() },
  poolAsk: { count: vi.fn() },
  partnerAsk: { findFirst: vi.fn() },
}));
vi.mock("../../db", () => ({ db: dbMock }));
const roundMock = vi.hoisted(() => ({ requestPoolAsk: vi.fn() }));
vi.mock("../round", () => roundMock);
const noticeMock = vi.hoisted(() => ({ sendAdminNotice: vi.fn() }));
vi.mock("../../admin-channel", () => noticeMock);

import { autoAskPool, poolAutoAskClub } from "../auto-ask";

const OPEN = { MT_POOL_OPEN: "1" };
const NOW = new Date("2026-10-30T12:05:00Z");
const KICKOFF = new Date("2026-10-30T20:00:00Z");
const base = {
  orgId: "fnf",
  match: { id: "m1", date: KICKOFF },
  now: NOW,
  askAt: new Date("2026-10-30T12:00:00Z"),
  postBy: new Date("2026-10-30T16:00:00Z"),
  placesOpen: 2,
  waitingCount: 0,
  hasPartners: false,
  partnersWhen: "off",
  askedNowRoundId: null as string | null,
  club: { poolOpen: true, poolAutoAsk: true, language: "en" as string | null },
  env: OPEN,
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.poolAsk.count.mockResolvedValue(0);
  dbMock.partnerAsk.findFirst.mockResolvedValue(null);
  roundMock.requestPoolAsk.mockResolvedValue({ ok: true, askId: "pa1", waveSent: true });
  noticeMock.sendAdminNotice.mockResolvedValue({ channel: "dm", queued: 1 });
});

describe("poolAutoAskClub: the club's switches", () => {
  it("open only with the club's flag AND the global switch; the automatic pool ask as stored", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ featurePlayerPool: true, poolAutoAsk: true, language: "tr" });
    expect(await poolAutoAskClub("fnf", OPEN)).toEqual({ poolOpen: true, poolAutoAsk: true, language: "tr" });
    expect(await poolAutoAskClub("fnf", {})).toEqual({ poolOpen: false, poolAutoAsk: true, language: "tr" });
    dbMock.organisation.findUnique.mockResolvedValue({ featurePlayerPool: false, poolAutoAsk: true, language: "en" });
    expect((await poolAutoAskClub("fnf", OPEN)).poolOpen).toBe(false);
    dbMock.organisation.findUnique.mockResolvedValue(null);
    expect(await poolAutoAskClub("fnf", OPEN)).toEqual({ poolOpen: false, poolAutoAsk: false, language: null });
  });
});

describe("autoAskPool", () => {
  it("no partner: a round of its own for every open place, through the tap's function, and one line to the organisers", async () => {
    expect(await autoAskPool(base)).toMatchObject({ ok: true });
    expect(roundMock.requestPoolAsk).toHaveBeenCalledWith({
      orgId: "fnf",
      matchId: "m1",
      places: 2,
      roundId: null,
      approvedByUserId: null,
      via: "auto",
      now: NOW,
      env: OPEN,
    });
    expect(noticeMock.sendAdminNotice).toHaveBeenCalledTimes(1);
    const n = noticeMock.sendAdminNotice.mock.calls[0][0];
    expect(n).toMatchObject({ orgId: "fnf", now: NOW, holdOvernight: false });
    expect(n.text).toContain("Your automatic ask");
    expect(n.text).toContain("MatchTime player pool");
    expect(n.text).not.toMatch(/partner/i);
  });

  it("partners asked in the same pass: the pool joins their round, and the line says the partners go first", async () => {
    roundMock.requestPoolAsk.mockResolvedValue({ ok: true, askId: "pa1", waveSent: false });
    await autoAskPool({ ...base, hasPartners: true, partnersWhen: "auto", askedNowRoundId: "r1" });
    expect(roundMock.requestPoolAsk).toHaveBeenCalledWith(expect.objectContaining({ roundId: "r1", places: 2, via: "auto" }));
    expect(noticeMock.sendAdminNotice.mock.calls[0][0].text).toMatch(/partner clubs/);
  });

  it("a partner round still open on the match (an organiser's tap, an earlier pass): the pool joins it, for its number", async () => {
    dbMock.partnerAsk.findFirst.mockResolvedValue({ roundId: "r-tap", places: 1 });
    await autoAskPool({ ...base, hasPartners: true, partnersWhen: "auto" });
    expect(dbMock.partnerAsk.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ matchId: "m1", askerOrgId: "fnf", roundId: { not: null } }) }),
    );
    expect(roundMock.requestPoolAsk).toHaveBeenCalledWith(expect.objectContaining({ roundId: "r-tap", places: 1 }));
  });

  it("the pool already asked for this match: nothing, no ask, no line", async () => {
    dbMock.poolAsk.count.mockResolvedValue(1);
    expect(await autoAskPool(base)).toBeNull();
    expect(dbMock.poolAsk.count).toHaveBeenCalledWith({ where: { orgId: "fnf", matchId: "m1" } });
    expect(roundMock.requestPoolAsk).not.toHaveBeenCalled();
    expect(noticeMock.sendAdminNotice).not.toHaveBeenCalled();
  });

  it("the rule says no (bench, switch off, partners on When we ask): nothing is read or asked", async () => {
    for (const over of [{ waitingCount: 1 }, { club: { ...base.club, poolAutoAsk: false } }, { club: { ...base.club, poolOpen: false } }, { hasPartners: true, partnersWhen: "on-request" }]) {
      expect(await autoAskPool({ ...base, ...over })).toBeNull();
    }
    expect(roundMock.requestPoolAsk).not.toHaveBeenCalled();
    expect(noticeMock.sendAdminNotice).not.toHaveBeenCalled();
  });

  it("the tap's function refuses (nobody near, the club's weekly cap...): no line, and the refusal is returned", async () => {
    roundMock.requestPoolAsk.mockResolvedValue({ ok: false, refusal: "none-near" });
    expect(await autoAskPool(base)).toEqual({ ok: false, refusal: "none-near" });
    expect(noticeMock.sendAdminNotice).not.toHaveBeenCalled();
  });

  it("the line is in the club's language", async () => {
    await autoAskPool({ ...base, club: { ...base.club, language: "tr" } });
    expect(noticeMock.sendAdminNotice.mock.calls[0][0].text).toContain("Otomatik isteğiniz");
  });

  it("never throws", async () => {
    roundMock.requestPoolAsk.mockRejectedValue(new Error("down"));
    await expect(autoAskPool(base)).resolves.toBeNull();
  });
});
