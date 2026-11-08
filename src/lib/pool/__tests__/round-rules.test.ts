/**
 * A pool round's rules (slice L5a): may the club ask now, which round a
 * pool ask joins (its first offers go at once either way: nothing asks by
 * itself, Kemal 2026-11-08), when does the ask close, how does an offer
 * end, and who may say yes.
 */
import { describe, expect, it } from "vitest";
import * as RULES from "../round-rules";
import {
  acceptRefusal,
  askStatusFor,
  offerNeverReachedHim,
  offerOutcomeOnClose,
  ownTimeRanOut,
  poolAskCloseReason,
  poolAskRefusal,
  poolRoundToJoin,
  pullOutResult,
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

describe("poolRoundToJoin: which round an organiser's pool ask joins, and for how many", () => {
  it("a round of partner asks still open on the match: that round, for its number (never more than is open)", () => {
    expect(poolRoundToJoin({ openRound: { roundId: "r-old", places: 1 }, placesOpen: 3 })).toEqual({ roundId: "r-old", places: 1 });
    expect(poolRoundToJoin({ openRound: { roundId: "r-old", places: 4 }, placesOpen: 2 })).toEqual({ roundId: "r-old", places: 2 });
  });
  it("no partner round open: a round of its own, every open place", () => {
    expect(poolRoundToJoin({ openRound: null, placesOpen: 2 })).toEqual({ roundId: null, places: 2 });
  });
});

describe("nothing asks by itself (Kemal, 2026-11-08)", () => {
  it("the partners-first hour and its switch, which only the automatic ask used, are gone", () => {
    for (const k of ["wave1DueAt", "poolWaitsForPartners", "POOL_WAITS_FOR_PARTNERS_VIA", "POOL_AFTER_PARTNERS_MINS"]) expect(k in RULES, k).toBe(false);
  });
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
  const offer = { outcome: null, sentAt: NOW, expiresAt: new Date(NOW.getTime() + 60 * MIN), askStatus: "open", matchLive: true, kickoff: CUTOFF, profileActive: true, poolOpen: true, now: new Date(NOW.getTime() + 5 * MIN) };
  it("yes while open", () => expect(acceptRefusal(offer)).toBeNull());
  it("answered already", () => expect(acceptRefusal({ ...offer, outcome: "declined" })).toBe("answered"));
  it("never reached him", () => expect(acceptRefusal({ ...offer, sentAt: null })).toBe("not-sent"));
  it("the switch or the club's flag is off at tap time (review minor 2)", () => expect(acceptRefusal({ ...offer, poolOpen: false })).toBe("pool-closed"));
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

describe("offerNeverReachedHim", () => {
  it("unsent and cancelled: it never reached him; sent, or still open: it did or may", () => {
    const at = new Date("2026-10-29T10:00:00Z");
    expect(offerNeverReachedHim({ sentAt: null, outcome: "cancelled" })).toBe(true);
    expect(offerNeverReachedHim({ sentAt: at, outcome: "cancelled" })).toBe(false);
    expect(offerNeverReachedHim({ sentAt: at, outcome: "expired" })).toBe(false);
    expect(offerNeverReachedHim({ sentAt: null, outcome: null })).toBe(false);
    expect(offerNeverReachedHim({ sentAt: null, outcome: "expired" })).toBe(false);
  });
});
