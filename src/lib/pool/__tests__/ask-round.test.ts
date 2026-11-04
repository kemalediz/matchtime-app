/**
 * THE MATCH PAGE'S ONE PRESS (Kemal, 2026-10-29): MatchTime asks exactly
 * the places the organiser ticked, now. Partner clubs alone: no pool ask.
 * The pool alone: no partner ask, a round of its own. Both: one round,
 * the pool asked by the press (via "page"), which never waits for the
 * partners (`round-rules.ts` `poolWaitsForPartners`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const partner = vi.hoisted(() => ({ requestPartnerRound: vi.fn() }));
vi.mock("../../partner-ask", () => partner);
const round = vi.hoisted(() => ({ requestPoolAsk: vi.fn() }));
vi.mock("../round", () => round);
const dbMock = vi.hoisted(() => ({ organisation: { findUnique: vi.fn() } }));
vi.mock("../../db", () => ({ db: dbMock }));

import { requestAskRound } from "../ask-round";

const NOW = new Date("2026-10-27T12:00:00Z");
const base = { orgId: "o1", matchId: "m1", places: 1, userId: "u-owner", now: NOW };

beforeEach(() => {
  vi.clearAllMocks();
  partner.requestPartnerRound.mockResolvedValue({ roundId: "r1", asked: 1 });
  round.requestPoolAsk.mockResolvedValue({ ok: true, askId: "a1", waveSent: true });
  dbMock.organisation.findUnique.mockResolvedValue({ approvalStatus: "approved", dormantAt: null, whatsappBotEnabled: true });
});

describe("requestAskRound: the places the organiser ticked, now", () => {
  it("partner clubs only: the partners are asked, the pool is not", async () => {
    const r = await requestAskRound({ ...base, partnershipIds: ["p1"], pool: false });
    expect(partner.requestPartnerRound).toHaveBeenCalledTimes(1);
    expect(round.requestPoolAsk).not.toHaveBeenCalled();
    expect(r.pool).toBeNull();
  });

  it("the pool only: no partner ask, the pool a round of its own, via the page", async () => {
    await requestAskRound({ ...base, partnershipIds: [], pool: true });
    expect(partner.requestPartnerRound).not.toHaveBeenCalled();
    expect(round.requestPoolAsk).toHaveBeenCalledWith(expect.objectContaining({ roundId: null, via: "page" }));
  });

  it("both: one round, the pool asked by the press (via page, so its first offers go at once)", async () => {
    const r = await requestAskRound({ ...base, partnershipIds: ["p1"], pool: true });
    expect(partner.requestPartnerRound).toHaveBeenCalledTimes(1);
    expect(round.requestPoolAsk).toHaveBeenCalledWith(expect.objectContaining({ roundId: "r1", via: "page" }));
    expect(r.pool).toMatchObject({ ok: true, waveSent: true });
  });
});

// The one rule (club summary B6, club-voice.ts): partner clubs and the pool
// are asked on the club's behalf, and every reply comes back to it, so a
// club MatchTime does not speak for asks nobody. Before B6 the press asked
// for a muted or dormant club (the partners' replies then waited, or went
// to a club that is gone).
describe("requestAskRound: only for a club MatchTime speaks for", () => {
  it.each([
    ["muted", { approvalStatus: "approved", dormantAt: null, whatsappBotEnabled: false }],
    ["dormant", { approvalStatus: "approved", dormantAt: new Date("2026-10-01T00:00:00Z"), whatsappBotEnabled: true }],
  ])("a %s club: nobody asked, and the press is told why", async (_label, row) => {
    dbMock.organisation.findUnique.mockResolvedValue(row);
    const r = await requestAskRound({ ...base, partnershipIds: ["p1"], pool: true });
    expect(partner.requestPartnerRound).not.toHaveBeenCalled();
    expect(round.requestPoolAsk).not.toHaveBeenCalled();
    expect(r).toEqual({ partner: null, pool: null, clubQuiet: true });
  });
});
