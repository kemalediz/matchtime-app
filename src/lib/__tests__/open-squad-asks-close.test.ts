/**
 * PARTNER AND POOL ASKS FOR AN OPEN SQUAD (review of #623, item 6). The ask
 * is for the shortfall below the minimum, but every yes confirms: so an
 * open squad's ask never closes as "filled" (which would tell the next
 * volunteer the place has gone). It still closes for kickoff, a called-off
 * game, a pairing ended or the pool switched off.
 */
import { describe, expect, it } from "vitest";
import { closeReason } from "../partner-ask-rules";
import { poolAskCloseReason } from "../pool/round-rules";

const NOW = new Date("2026-11-20T12:00:00Z");
const KICKOFF = new Date("2026-11-23T20:15:00Z");

describe("a partner ask", () => {
  const base = {
    status: "posted",
    now: NOW,
    postBy: KICKOFF,
    closesAt: KICKOFF,
    matchDate: KICKOFF,
    matchStatus: "UPCOMING",
    partnershipStatus: "active",
    placesOpen: 0,
    roundPlaced: 2,
    roundWanted: 2,
  } as Parameters<typeof closeReason>[0];

  it("open squad: the round's number reached, or the minimum reached, is not 'filled'", () => {
    expect(closeReason({ ...base, openSquad: true })).toBeNull();
  });
  it("open squad: still closes at kickoff and for a cancelled game", () => {
    expect(closeReason({ ...base, openSquad: true, now: KICKOFF })).toBe("kickoff");
    expect(closeReason({ ...base, openSquad: true, matchStatus: "CANCELLED" })).toBe("match-cancelled");
  });
  it("off: 'filled', as before", () => {
    expect(closeReason(base)).toBe("filled");
  });
});

describe("a pool ask", () => {
  const base = { now: NOW, kickoff: KICKOFF, matchLive: true, poolOpen: true, roundPlaced: 1, roundWanted: 1, placesOpen: 0 };
  it("open squad: never 'filled'; off: as before", () => {
    expect(poolAskCloseReason({ ...base, openSquad: true })).toBeNull();
    expect(poolAskCloseReason(base)).toBe("filled");
  });
  it("open squad: the pool switched off still closes it", () => {
    expect(poolAskCloseReason({ ...base, openSquad: true, poolOpen: false })).toBe("switched-off");
  });
});
