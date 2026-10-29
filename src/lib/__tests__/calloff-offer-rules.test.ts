/**
 * AN ORGANISER CALLING THE GAME OFF WITHOUT A TAG (Vets MNF, 2026-10-26):
 * the facts code gates on, before the model is asked anything. Never the
 * words: only who sent it, how, and whether a game is coming.
 */
import { describe, expect, it } from "vitest";
import {
  CALLOFF_OFFER_KIND,
  CALLOFF_OFFER_CLOSED_KIND,
  calloffOfferKey,
  isCalloffCandidate,
  nextGameForCalloff,
  calloffOfferOpen,
} from "../calloff-offer-rules";

const NOW = new Date("2026-10-26T17:00:00Z");
const h = (n: number) => new Date(NOW.getTime() + n * 3600_000);

const base = { tagged: false, senderKnown: true, organiser: true, late: false, capped: false };

describe("who may be asked about a call-off", () => {
  it("an organiser, untagged, known, on time, under the cap", () => {
    expect(isCalloffCandidate(base)).toBe(true);
  });
  it("tagged: the tagged cancel path owns it", () => {
    expect(isCalloffCandidate({ ...base, tagged: true })).toBe(false);
  });
  it("a player who is not an organiser: nothing", () => {
    expect(isCalloffCandidate({ ...base, organiser: false })).toBe(false);
  });
  it("an unknown sender, a late message, or a club at its AI cap: nothing", () => {
    expect(isCalloffCandidate({ ...base, senderKnown: false })).toBe(false);
    expect(isCalloffCandidate({ ...base, late: true })).toBe(false);
    expect(isCalloffCandidate({ ...base, capped: true })).toBe(false);
  });
});

describe("the game a call-off is about", () => {
  const m = (id: string, at: Date, status = "UPCOMING") => ({ id, date: at, status });

  it("the soonest game still on, inside the next 7 days", () => {
    expect(nextGameForCalloff([m("b", h(48)), m("a", h(3))], NOW)?.id).toBe("a");
  });
  it("a game that kicked off in the last 6 hours still counts (it's off at kickoff)", () => {
    expect(nextGameForCalloff([m("a", h(-2))], NOW)?.id).toBe("a");
    expect(nextGameForCalloff([m("a", h(-7))], NOW)).toBeNull();
  });
  it("nothing more than 7 days away, and nothing cancelled or completed", () => {
    expect(nextGameForCalloff([m("a", h(24 * 8))], NOW)).toBeNull();
    expect(nextGameForCalloff([m("a", h(3), "CANCELLED"), m("b", h(5), "COMPLETED")], NOW)).toBeNull();
    expect(nextGameForCalloff([m("a", h(3), "TEAMS_PUBLISHED")], NOW)?.id).toBe("a");
  });
});

describe("the offer", () => {
  it("one key per organiser per game", () => {
    expect(calloffOfferKey("m1", "u1")).toBe("m1:calloff-offer:u1");
    expect(CALLOFF_OFFER_KIND).not.toBe(CALLOFF_OFFER_CLOSED_KIND);
  });
  it("open for a day after it was sent, while the game is not cancelled or completed", () => {
    const at = h(-1);
    expect(calloffOfferOpen({ offeredAt: at, matchStatus: "UPCOMING", now: NOW })).toBe(true);
    expect(calloffOfferOpen({ offeredAt: h(-25), matchStatus: "UPCOMING", now: NOW })).toBe(false);
    expect(calloffOfferOpen({ offeredAt: at, matchStatus: "CANCELLED", now: NOW })).toBe(false);
    expect(calloffOfferOpen({ offeredAt: at, matchStatus: "COMPLETED", now: NOW })).toBe(false);
  });
});
