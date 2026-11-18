/**
 * AN EDIT PURGES THE TEXT AND KEEPS THE FACTS (2026-11-16, PR #606 round
 * 8): what is left of a stored pipeline trace once its author edits the
 * message. The structured reading that later features act on stays; every
 * free-text field goes. Made-up content.
 */
import { describe, it, expect } from "vitest";
import { isTextFree, sameJson, textFreeTrace } from "../message-change-trace";

const SECRET = "my door code is 4321";

const TRACE = {
  v: 1,
  router: { route: "admin", source: "model", overrodeRoute: "none", model: "haiku", floor: false, degradations: [`router m1: could not read "${SECRET}"`] },
  extractions: [
    {
      owner: "admin_ops",
      route: "admin",
      extractor: "admin",
      model: "haiku",
      client: "anthropic",
      facts: { kind: "admin", action: "recruit", partnerClubs: true, clubRef: "Sutton Lads", pool: true, note: `bring ${SECRET}`, phrase: "on Monday", remindAt: "2026-11-17 18:00" },
      degradations: [`extractor m1: ${SECRET}`],
      calls: [{ ms: 812, stopReason: "end_turn", inputTokens: 3000, cacheReadTokens: 2000, cacheWriteTokens: 0, outputTokens: 90, costUsd: 0.001, raw: `{"note":"${SECRET}"}`, error: `bad JSON: ${SECRET}` }],
      sharedWith: ["team_ops"],
    },
    {
      owner: "team_ops",
      route: "team",
      extractor: "team",
      model: "haiku",
      client: "anthropic",
      facts: { kind: "team", includeRefs: ["Ali"], form: [{ personRef: "Ali", delta: -1, reason: SECRET }] },
      degradations: [],
      calls: [],
    },
  ],
  hqSquadReader: { names: ["Ali"], raw: SECRET },
  truncated: true,
};

describe("textFreeTrace", () => {
  it("keeps the structured reading features act on, and no free text anywhere", () => {
    const out = textFreeTrace(TRACE);
    expect(JSON.stringify(out)).not.toContain("4321");
    expect(out).toEqual({
      v: 1,
      router: { route: "admin", source: "model", overrodeRoute: "none", model: "haiku", floor: false, degradations: [] },
      extractions: [
        {
          owner: "admin_ops",
          route: "admin",
          extractor: "admin",
          model: "haiku",
          client: "anthropic",
          // The refused-ask retry reads kind, action, partnerClubs, clubRef and pool.
          facts: { kind: "admin", action: "recruit", partnerClubs: true, clubRef: "Sutton Lads", pool: true, note: "", phrase: "", remindAt: "2026-11-17 18:00" },
          degradations: [],
          calls: [{ ms: 812, stopReason: "end_turn", inputTokens: 3000, cacheReadTokens: 2000, cacheWriteTokens: 0, outputTokens: 90, costUsd: 0.001 }],
          sharedWith: ["team_ops"],
        },
        {
          owner: "team_ops",
          route: "team",
          extractor: "team",
          model: "haiku",
          client: "anthropic",
          // Names are words: blanked. Only enums, numbers, booleans and checked formats stay.
          facts: { kind: "team", includeRefs: [""], form: [{ personRef: "", delta: -1, reason: "" }] },
          degradations: [],
          calls: [],
        },
      ],
      truncated: true,
    });
  });

  it("EVERY fact shape the extractors produce: no free-text string survives, only enums, ids-free formats, numbers and booleans", () => {
    const S = "my door code is 4321";
    const shapes: unknown[] = [
      {
        kind: "attendance",
        claims: [{ subject: "other", personRef: S, personNamed: true, personKind: "named", benchAsked: false, polarity: "in", contingent: false, conditionOn: "none", tense: "present", reported: false, confidence: 0.9, replaces: S }],
        affirmation: "yes",
        sideRequests: ["recruit", "question"],
      },
      { kind: "question", topic: "stats", answersClarification: true, personRef: S, statedCount: 3, table: "goals", listSize: 10, listEnd: "top", period: { kind: "last", count: 5, unit: "week" }, feature: "find_players", badge: "first-game" },
      {
        kind: "teams",
        action: "swap",
        includeRefs: [S],
        teamNames: [S, S],
        swaps: [{ personRef: S, team: "RED" }],
        moves: [S],
        swapSides: true,
        pairings: [[S, S]],
        sides: { red: [S], yellow: [S] },
        toMatchTime: true,
        form: [{ personRef: S, delta: 1, reason: S }],
      },
      { kind: "score", first: 3, second: 2, firstTeam: S, secondTeam: S, winner: S, loser: S, momRef: S, correction: false, swapped: false, otherGame: false },
      { kind: "admin", action: "fee_waiver", payerRef: S, count: 2, coveredRefs: [S], undo: false, matchDay: S, pastGame: true },
      { kind: "admin", action: "reminder", phrase: S, remindAt: "2026-11-17 18:00", note: S },
      { kind: "admin", action: "reminder", remindAt: S },
      { kind: "admin", action: "set_venue", venueName: S, venueChoice: 2 },
      { kind: "admin", action: "quiet_hours", quietFrom: "22:00", quietTo: S, quietOff: true },
      { kind: "admin", action: "move_game", newDay: 3, newTime: "19:30", everyWeek: true, game: 1, size: 7, aSide: true, minPlayers: 10, maxPlayers: 14, fullTeams: true },
      { kind: "admin", action: "season_break", breakMonths: ["2026-12", S], playMonths: ["2027-01"] },
      { kind: "admin", action: "recruit", partnerClubs: true, clubRef: "Sutton Lads", pool: true, lookbackMatches: 5, namedPeople: true, ownClub: true, sourceUnsaid: true },
      { kind: "admin", action: "recruit", pool: true, clubRef: S },
      { kind: "admin", action: "other", clubRef: S },
      { kind: "none" },
      { kind: S, action: S },
    ];
    const out = textFreeTrace({ v: 1, extractions: shapes.map((facts) => ({ extractor: "x", facts })) });
    const kept = (out!.extractions as Array<{ facts: unknown }>).map((e) => e.facts);
    expect(JSON.stringify(kept)).not.toContain("4321");
    // What later features act on stays.
    expect(kept[0]).toMatchObject({ kind: "attendance", affirmation: "yes", sideRequests: ["recruit", "question"], claims: [{ subject: "other", personNamed: true, personKind: "named", polarity: "in", conditionOn: "none", tense: "present", confidence: 0.9 }] });
    expect(kept[1]).toMatchObject({ kind: "question", topic: "stats", table: "goals", listEnd: "top", period: { kind: "last", count: 5, unit: "week" }, feature: "find_players", badge: "first-game" });
    expect(kept[2]).toMatchObject({ kind: "teams", action: "swap", swaps: [{ team: "RED" }], swapSides: true, form: [{ delta: 1 }] });
    expect(kept[3]).toMatchObject({ kind: "score", first: 3, second: 2 });
    expect(kept[5]).toMatchObject({ action: "reminder", remindAt: "2026-11-17 18:00" });
    expect(kept[8]).toMatchObject({ quietFrom: "22:00", quietTo: "" });
    expect(kept[9]).toMatchObject({ newTime: "19:30", newDay: 3 });
    expect(kept[10]).toMatchObject({ breakMonths: ["2026-12", ""], playMonths: ["2027-01"] });
    // clubRef is the club's name as the message wrote it: kept ONLY where the
    // "try again" retry needs it (a recruit from partner clubs), blanked elsewhere.
    expect(kept[11]).toMatchObject({ action: "recruit", partnerClubs: true, clubRef: "Sutton Lads", pool: true });
    expect(kept[12]).toMatchObject({ clubRef: "" });
    expect(kept[13]).toMatchObject({ clubRef: "" });
    // An "enum" that is not one (spaces, punctuation) is blanked too.
    expect(kept[15]).toEqual({ kind: "", action: "" });
  });

  it("is idempotent, and null stays null; something that is no trace keeps nothing", () => {
    const once = textFreeTrace(TRACE);
    expect(textFreeTrace(once)).toEqual(once);
    expect(isTextFree(once)).toBe(true);
    expect(isTextFree(TRACE)).toBe(false);
    expect(textFreeTrace(null)).toBeNull();
    expect(isTextFree(null)).toBe(true);
    expect(textFreeTrace("a string")).toEqual({ v: 1, extractions: [] });
  });

  it("a trace read back from Postgres (JSONB orders keys its own way) is still seen as already text-free", () => {
    const once = textFreeTrace(TRACE) as Record<string, unknown>;
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(once).reverse())));
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(once));
    expect(sameJson(reordered, once)).toBe(true);
    expect(isTextFree(reordered)).toBe(true);
  });
});
