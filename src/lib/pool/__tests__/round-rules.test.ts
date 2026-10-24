/**
 * A pool round's rules (slice L5a): may the club ask now, when do the
 * first offers go (partners first: an hour after the partner clubs, at
 * once with none open), when does the ask close, how does an offer end,
 * and who may say yes.
 */
import { describe, expect, it } from "vitest";
import {
  POOL_AFTER_PARTNERS_MINS,
  acceptRefusal,
  askStatusFor,
  offerOutcomeOnClose,
  ownTimeRanOut,
  poolAskCloseReason,
  poolAskRefusal,
  pullOutResult,
  wave1DueAt,
} from "../round-rules";

const NOW = new Date("2026-10-27T12:00:00Z");
const CUTOFF = new Date("2026-10-27T16:30:00Z");
const MIN = 60_000;

describe("poolAskRefusal: the organiser's ask, in order", () => {
  const ok = {
    poolOpen: true,
    organiser: true,
    gate: null,
    now: NOW,
    cutoff: CUTOFF,
    placesOpen: 3,
    places: 1,
    clubAsks: [],
    matchId: "m1",
    eligible: 4,
  } as const;
  it("passes a good ask", () => expect(poolAskRefusal(ok)).toBeNull());
  const table: Array<[string, Partial<Parameters<typeof poolAskRefusal>[0]>, string]> = [
    ["the switch or the club's flag off", { poolOpen: false }, "pool-closed"],
    ["a gate that is the switch", { gate: "pool-closed" }, "pool-closed"],
    ["not an owner or admin", { organiser: false }, "not-organiser"],
    ["the match is not open", { gate: "match-not-open" }, "match-not-open"],
    ["no venue position", { gate: "no-venue" }, "no-venue"],
    ["a sport the pool does not have", { gate: "no-sport" }, "no-sport"],
    ["at the cut-off", { now: CUTOFF }, "too-late"],
    ["no place open", { placesOpen: 0 }, "no-places"],
    ["more than the open places", { places: 4 }, "bad-number"],
    ["zero", { places: 0 }, "bad-number"],
    ["not a whole number", { places: 1.5 }, "bad-number"],
    ["a round already open", { clubAsks: [{ matchId: "m1", status: "open", createdAt: NOW }] }, "round-open"],
    [
      "three rounds this week",
      { clubAsks: [1, 2, 3].map((d) => ({ matchId: `x${d}`, status: "filled", createdAt: new Date(NOW.getTime() - d * 24 * 60 * MIN) })) },
      "club-week-cap",
    ],
    ["nobody near", { eligible: 0 }, "none-near"],
  ];
  for (const [name, change, want] of table) it(name, () => expect(poolAskRefusal({ ...ok, ...change })).toBe(want));
});

describe("wave1DueAt: partners first", () => {
  it("an hour after the ask while a partner ask of the round is open", () => {
    expect(wave1DueAt({ createdAt: NOW, partnerAsksOpen: 2 })).toEqual(new Date(NOW.getTime() + POOL_AFTER_PARTNERS_MINS * MIN));
  });
  it("at once with no partner, or once every partner ask has closed", () => {
    expect(wave1DueAt({ createdAt: NOW, partnerAsksOpen: 0 })).toEqual(NOW);
  });
  it("is an hour", () => expect(POOL_AFTER_PARTNERS_MINS).toBe(60));
});

describe("poolAskCloseReason", () => {
  const open = { now: NOW, cutoff: CUTOFF, matchLive: true, poolOpen: true, roundPlaced: 0, roundWanted: 1, placesOpen: 2 };
  it("stays open", () => expect(poolAskCloseReason(open)).toBeNull());
  it("switched off first", () => expect(poolAskCloseReason({ ...open, poolOpen: false, matchLive: false })).toBe("switched-off"));
  it("the game is off", () => expect(poolAskCloseReason({ ...open, matchLive: false })).toBe("match-off"));
  it("the round has its number (partners and pool together)", () => expect(poolAskCloseReason({ ...open, roundPlaced: 1 })).toBe("filled"));
  it("no open place left (own players came back)", () => expect(poolAskCloseReason({ ...open, placesOpen: 0 })).toBe("filled"));
  it("the cut-off", () => expect(poolAskCloseReason({ ...open, now: CUTOFF })).toBe("cut-off"));
  it("status for each", () => {
    expect(askStatusFor("filled")).toBe("filled");
    expect(askStatusFor("organiser-cancelled")).toBe("cancelled");
    expect(askStatusFor("cut-off")).toBe("closed");
    expect(askStatusFor("match-off")).toBe("closed");
    expect(askStatusFor("switched-off")).toBe("closed");
  });
});

describe("how an offer ends (decision #8)", () => {
  it("an offer that never went is cancelled; one that went and is unanswered expired", () => {
    expect(offerOutcomeOnClose({ sentAt: null })).toBe("cancelled");
    expect(offerOutcomeOnClose({ sentAt: NOW })).toBe("expired");
  });
  it("ignored only when its OWN six hours ran out before the cut-off", () => {
    const sent = NOW;
    expect(ownTimeRanOut({ sentAt: sent, expiresAt: new Date(sent.getTime() + 6 * 60 * MIN), cutoff: CUTOFF, now: new Date(sent.getTime() + 6 * 60 * MIN) })).toBe(false);
    const early = new Date("2026-10-27T08:30:00Z");
    const exp = new Date(early.getTime() + 6 * 60 * MIN);
    expect(ownTimeRanOut({ sentAt: early, expiresAt: exp, cutoff: CUTOFF, now: exp })).toBe(true);
    expect(ownTimeRanOut({ sentAt: early, expiresAt: exp, cutoff: CUTOFF, now: new Date(exp.getTime() - 1) })).toBe(false);
    expect(ownTimeRanOut({ sentAt: null, expiresAt: exp, cutoff: CUTOFF, now: exp })).toBe(false);
  });
});

describe("acceptRefusal: who may say yes", () => {
  const offer = { outcome: null, sentAt: NOW, expiresAt: new Date(NOW.getTime() + 60 * MIN), askStatus: "open", matchLive: true, kickoff: CUTOFF, profileActive: true, now: new Date(NOW.getTime() + 5 * MIN) };
  it("yes while open", () => expect(acceptRefusal(offer)).toBeNull());
  it("answered already", () => expect(acceptRefusal({ ...offer, outcome: "declined" })).toBe("answered"));
  it("never reached him", () => expect(acceptRefusal({ ...offer, sentAt: null })).toBe("not-sent"));
  it("the game is off", () => expect(acceptRefusal({ ...offer, matchLive: false })).toBe("match-off"));
  it("kicked off", () => expect(acceptRefusal({ ...offer, now: CUTOFF })).toBe("match-off"));
  it("the round closed (filled by others)", () => expect(acceptRefusal({ ...offer, askStatus: "filled" })).toBe("gone"));
  it("after its expiry", () => expect(acceptRefusal({ ...offer, now: offer.expiresAt })).toBe("expired"));
  it("he stopped his profile meanwhile", () => expect(acceptRefusal({ ...offer, profileActive: false })).toBe("profile-off"));
});

describe("pullOutResult", () => {
  it("before the club's cut-off: withdrawn; after: late cancel", () => {
    expect(pullOutResult({ now: new Date(CUTOFF.getTime() - 1), cutoff: CUTOFF })).toBe("withdrawn");
    expect(pullOutResult({ now: CUTOFF, cutoff: CUTOFF })).toBe("late-cancel");
  });
});
