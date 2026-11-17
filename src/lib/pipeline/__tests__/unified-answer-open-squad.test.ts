/**
 * THE UNIFIED ANSWER'S RECORDS FOR AN OPEN SQUAD (review of #623, item 5).
 * "How the club is run" says no limit, no bench, the minimum, and that the
 * 17:00 post goes out only below it; no bench line, no "while places are
 * open", no format. A monthly club's rules say the same. Every other club
 * reads as before.
 */
import { describe, expect, it } from "vitest";
import { buildUnifiedContext, type UnifiedAnswerInput } from "../unified-answer";
import { NOW, fullName, world } from "./helpers";

function input(over: { openSquad?: boolean; squadMode?: "weekly" | "monthly" } = {}): UnifiedAnswerInput {
  const st = world({ confirmed: ["kemal", "sait", "idris"], features: over.openSquad ? { openSquad: true } : {} });
  return {
    audience: "players",
    state: { ...st, ...(over.openSquad ? { openSquadMinimum: 12, maxPlayers: 12 } : {}) },
    squadKnown: true,
    stats: null,
    results: null,
    payments: null,
    ratingProgress: null,
    history: [],
    lastBotPost: null,
    reply: null,
    now: NOW,
    question: "@Match Time what happens if not enough come?",
    askerUserId: "u-sait",
    askerName: fullName("sait"),
    ...(over.squadMode ? { squadMode: over.squadMode } : {}),
  } as UnifiedAnswerInput;
}

describe("how the club is run, no squad limit", () => {
  it("weekly: no limit, no bench, the minimum, and the 17:00 post only below it", () => {
    const text = buildUnifiedContext(input({ openSquad: true })).text;
    expect(text).toContain("- Squad limit: none. Everyone who says IN plays; there is no bench and no number a side. The fewest to play is 12.");
    expect(text).toContain("- Only while fewer than 12 are in, MatchTime posts the squad with a call for players at 17:00 in the players' group, until the drop-out deadline.");
    expect(text).not.toContain("Who fills an open place");
    expect(text).not.toContain("While places are open");
  });

  it("monthly: the month's rules with no bench and no open place", () => {
    const text = buildUnifiedContext(input({ openSquad: true, squadMode: "monthly" })).text;
    expect(text).toContain("- A pay as you go player says IN to play a game and pays for that game only; there is no limit and no bench.");
    expect(text).not.toContain("An open place goes to the bench first");
    expect(text).not.toContain("their place opens");
  });

  it("off: as before", () => {
    const text = buildUnifiedContext(input()).text;
    expect(text).toContain("- Who fills an open place: the first on the bench moves up");
    expect(text).toContain("- While places are open, MatchTime posts the squad with a call for players at 17:00");
  });
});
