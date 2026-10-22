/**
 * Asking partner clubs for a CHOSEN number of players, the pure rules
 * (partner discovery P4, 2026-10-22). Plan:
 * MDs/partner-discovery-plan-2026-10-21.md, section 4 and D-5.
 *
 *   - the organiser picks 1 (the default) up to the open places;
 *   - the number covers the whole ROUND (the asks sent together), not each
 *     partner;
 *   - a round closes as filled at its number, or when the match has no
 *     open place left, however it went;
 *   - an organiser can cancel a round by hand: each partner group that saw
 *     the ask hears "no longer needed";
 *   - a dormant or billing-paused partner is held: never offered, skipped
 *     by "all partners".
 */
import { describe, expect, it } from "vitest";
import {
  askWindows,
  canAsk,
  closeReason,
  closeTells,
  closedStatus,
  isPartnerPaused,
  roundKey,
  roundPartners,
  type CanAskInput,
  type CloseInput,
} from "../partner-ask-rules";

const KICKOFF = new Date("2026-10-16T19:30:00Z");
const H = 3600_000;
const { postBy, closesAt } = askWindows(KICKOFF, 4);

const ask = (over: Partial<CanAskInput> = {}): CanAskInput => ({
  partnershipStatus: "active",
  askWhen: "on-request",
  via: "button",
  requesterRole: "ADMIN",
  isNextMatch: true,
  matchStatus: "UPCOMING",
  matchHistorical: false,
  placesOpen: 4,
  places: 1,
  now: new Date(KICKOFF.getTime() - 6 * H),
  postBy,
  openAskForPair: false,
  partnerAsksToday: 0,
  ...over,
});

describe("canAsk: the chosen number (D-5)", () => {
  it("1 up to the open places", () => {
    expect(canAsk(ask({ places: 1 }))).toEqual({ ok: true });
    expect(canAsk(ask({ places: 3 }))).toEqual({ ok: true });
    expect(canAsk(ask({ places: 4 }))).toEqual({ ok: true });
  });
  it("0, a negative, more than the open places, or not a whole number is refused", () => {
    for (const places of [0, -1, 5, 1.5, Number.NaN]) {
      expect(canAsk(ask({ places }))).toEqual({ ok: false, refusal: "bad-number" });
    }
  });
  it("no open place at all is still 'no places', whatever the number", () => {
    expect(canAsk(ask({ placesOpen: 0, places: 1 }))).toEqual({ ok: false, refusal: "no-places" });
  });
});

describe("closeReason: the round's number", () => {
  const c = (over: Partial<CloseInput> = {}): CloseInput => ({
    status: "posted",
    now: new Date(KICKOFF.getTime() - 2 * H),
    postBy,
    closesAt,
    matchDate: KICKOFF,
    matchStatus: "UPCOMING",
    partnershipStatus: "active",
    placesOpen: 3,
    roundPlaced: 0,
    roundWanted: 1,
    ...over,
  });
  it("below the number with places open: stays open", () => {
    expect(closeReason(c({ roundPlaced: 0, roundWanted: 2 }))).toBeNull();
    expect(closeReason(c({ roundPlaced: 1, roundWanted: 2 }))).toBeNull();
  });
  it("the round reaches its number: filled, though places are still open", () => {
    expect(closeReason(c({ roundPlaced: 1, roundWanted: 1 }))).toBe("filled");
    expect(closeReason(c({ roundPlaced: 2, roundWanted: 2, placesOpen: 5 }))).toBe("filled");
  });
  it("the match has no open place left, however it went: filled, below the number too", () => {
    expect(closeReason(c({ placesOpen: 0, roundPlaced: 0, roundWanted: 3 }))).toBe("filled");
  });
  it("an ask still waiting for approval in a filled round is cancelled, never 'filled'", () => {
    expect(closeReason(c({ status: "awaiting-approval", roundPlaced: 1 }))).toBe("filled");
    expect(closedStatus("filled", "awaiting-approval")).toBe("cancelled");
  });
});

describe("an organiser cancels a round by hand (Kemal, 2026-10-22)", () => {
  it("closes as cancelled", () => {
    expect(closedStatus("organiser-cancelled", "posted")).toBe("cancelled");
    expect(closedStatus("organiser-cancelled", "awaiting-approval")).toBe("cancelled");
  });
  it("a partner group that saw the ask hears 'no longer needed'; one still waiting for approval hears nothing", () => {
    expect(closeTells("organiser-cancelled", "posted", 2)).toEqual({ partnerGroup: "not-needed", asker: null });
    expect(closeTells("organiser-cancelled", "awaiting-approval", 0)).toEqual({ partnerGroup: null, asker: null });
  });
});

describe("roundKey", () => {
  it("asks sent together share their round id; an ask without one is a round of its own", () => {
    expect(roundKey({ id: "a1", roundId: "r1" })).toBe("r1");
    expect(roundKey({ id: "a1", roundId: null })).toBe("a1");
  });
});

describe("a paused partner is held (plan 2.1)", () => {
  it("dormant or billing-paused", () => {
    expect(isPartnerPaused({ dormantAt: new Date(), billingPaused: false })).toBe(true);
    expect(isPartnerPaused({ dormantAt: null, billingPaused: true })).toBe(true);
    expect(isPartnerPaused({ dormantAt: null, billingPaused: false })).toBe(false);
  });

  const partners = [
    { partnershipId: "p1", name: "Sutton FC", paused: false },
    { partnershipId: "p2", name: "Cheam", paused: true },
    { partnershipId: "p3", name: "Carshalton", paused: false },
  ];
  it("'all partners' asks every active partner but the paused ones, and names those", () => {
    expect(roundPartners(partners, "all")).toEqual({
      ask: [partners[0], partners[2]],
      skippedPaused: [partners[1]],
    });
  });
  it("a ticked list asks only those; a paused one ticked anyway is skipped and named", () => {
    expect(roundPartners(partners, ["p1"])).toEqual({ ask: [partners[0]], skippedPaused: [] });
    expect(roundPartners(partners, ["p2", "p3"])).toEqual({ ask: [partners[2]], skippedPaused: [partners[1]] });
  });
  it("an id that is not an active partner is ignored", () => {
    expect(roundPartners(partners, ["nope"])).toEqual({ ask: [], skippedPaused: [] });
  });
});
