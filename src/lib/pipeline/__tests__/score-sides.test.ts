/**
 * WHAT A CLUB CALLS ITS TWO SIDES (2026-11-17, Vets).
 *
 * Monday night vets, 16 Nov 22:14: "@Match Time bibs 9, no bibs 4". The
 * sides were "Red" and "Yellow" in MatchTime's data and "bibs" and "no
 * bibs" in the club's mouth; nothing told the router a score was awaited,
 * nothing told the score extractor what the club calls its sides, and
 * the message got "I can't do that", twice. Every case below is a way
 * that message, its answer and next week's message are read. All names
 * are made up.
 */
import { describe, it, expect } from "vitest";
import {
  awaitedScoreLine,
  encodeSideNames,
  gameContextLines,
  hintSide,
  labelsWithSideNames,
  learnedSideNames,
  mergeSideNames,
  normaliseScoreFacts,
  parseScoreAskNames,
  parseSideNames,
  scoreAskNamesText,
  sideByNames,
  sideNamesAfterCorrection,
  sideQuestion,
  type SideNames,
} from "../score-sides";
import { resolveScoreResult } from "../score-teams";
import type { ScoreFacts } from "../types";

const EN: [string, string] = ["Red", "Yellow"];
const NONE: SideNames = { red: [], yellow: [] };
const BIBS: SideNames = { red: ["bibs"], yellow: ["no bibs"] };

const f = (first: number | null, second: number | null, over: Partial<ScoreFacts> = {}): ScoreFacts => ({
  kind: "score",
  first,
  second,
  ...over,
});

describe("the stored names: read, written and merged", () => {
  it("round-trips through the row's text", () => {
    expect(parseSideNames(encodeSideNames(BIBS))).toEqual(BIBS);
  });

  it("anything unreadable is no names, never a throw", () => {
    for (const bad of [null, undefined, "", "not json", "[]", '{"red":"bibs"}', '{"red":[1,2]}']) {
      expect(parseSideNames(bad as string | null | undefined)).toEqual(NONE);
    }
  });

  it("a name learned for one side leaves the other side", () => {
    expect(mergeSideNames(BIBS, { red: ["No Bibs"], yellow: ["Bibs"] })).toEqual({ red: ["No Bibs"], yellow: ["Bibs"] });
  });

  it("merging adds, and keeps one copy of a name", () => {
    expect(mergeSideNames({ red: ["bibs"], yellow: [] }, { red: ["Bibs"], yellow: ["skins"] })).toEqual({
      red: ["Bibs"],
      yellow: ["skins"],
    });
  });

  it("the score question's names round-trip, and a question with none has no text", () => {
    expect(scoreAskNamesText(null)).toBeNull();
    expect(parseScoreAskNames(scoreAskNamesText({ name: "bibs", other: "no bibs" }))).toEqual({ name: "bibs", other: "no bibs" });
    expect(parseScoreAskNames(scoreAskNamesText({ name: "bibs" }))).toEqual({ name: "bibs" });
    expect(parseScoreAskNames("garbage")).toBeNull();
    expect(parseScoreAskNames(null)).toBeNull();
  });
});

describe("which side a name means, by the club's names", () => {
  it('"bibs" is the side called bibs, "no bibs" the side called no bibs', () => {
    expect(sideByNames("bibs", BIBS)).toBe("RED");
    expect(sideByNames("Bibs", BIBS)).toBe("RED");
    expect(sideByNames("no bibs", BIBS)).toBe("YELLOW");
  });

  it("the other way round, by the stronger match, not the first", () => {
    const flipped: SideNames = { red: ["no bibs"], yellow: ["bibs"] };
    expect(sideByNames("bibs", flipped)).toBe("YELLOW");
    expect(sideByNames("no bibs", flipped)).toBe("RED");
  });

  it("nobody's name, and no names at all, mean no side", () => {
    expect(sideByNames("skins", BIBS)).toBeNull();
    expect(sideByNames("bibs", NONE)).toBeNull();
    expect(sideByNames("", BIBS)).toBeNull();
  });
});

describe("normalising the facts before the engine reads them", () => {
  it("the club's names turn into MatchTime's names, so the engine resolves the result", () => {
    const { facts, mapped } = normaliseScoreFacts(f(9, 4, { firstTeam: "bibs", secondTeam: "no bibs" }), {
      labels: EN,
      names: BIBS,
      senderTeam: null,
    });
    expect(facts).toMatchObject({ firstTeam: "Red", secondTeam: "Yellow" });
    expect(mapped).toHaveLength(2);
    const r = resolveScoreResult({ facts: { ...facts, first: 9, second: 4 }, labels: EN, senderTeam: null });
    expect(r).toEqual({ kind: "resolved", red: 9, yellow: 4 });
  });

  // REVIEW OF #620, 2: a player's team is placed by CODE from THE GAME's
  // line-ups, by the player the extractor names; never by the side it says.
  const LINEUPS = { red: ["Ava Stone", "Ben Cole"], yellow: ["Cal Dunn", "Dan Hale"] };

  it("a captain's team maps through the line-up the player is on, whatever side the model said", () => {
    const { facts } = normaliseScoreFacts(
      f(5, 3, { winner: "Dan's team", teamSides: [{ team: "Dan's team", side: "RED", player: "Dan Hale" }] }),
      { labels: EN, names: NONE, senderTeam: null, lineups: LINEUPS },
    );
    expect(facts.winner).toBe("Yellow");
    const r = resolveScoreResult({ facts: { ...facts, first: 5, second: 3 }, labels: EN, senderTeam: null });
    expect(r).toEqual({ kind: "resolved", red: 3, yellow: 5 });
  });

  it("the same display name on both sides: not placed, so MatchTime asks", () => {
    const { facts, mapped } = normaliseScoreFacts(
      f(5, 3, { winner: "Dan's team", teamSides: [{ team: "Dan's team", side: "YELLOW", player: "Dan Hale" }] }),
      { labels: EN, names: NONE, senderTeam: null, lineups: { red: ["Dan Hale", "Ava Stone"], yellow: ["Dan Hale", "Cal Dunn"] } },
    );
    expect(facts.winner).toBe("Dan's team");
    expect(mapped).toEqual([]);
  });

  it("a player in neither line-up, or no player named: not placed, whatever side the model said", () => {
    for (const entry of [
      { team: "Dan's team", side: "YELLOW" as const, player: "Dan Smith" },
      { team: "Dan's team", side: "YELLOW" as const },
      { team: "Dan's team", side: "YELLOW" as const, player: "" },
    ]) {
      const { facts } = normaliseScoreFacts(f(5, 3, { winner: "Dan's team", teamSides: [entry] }), {
        labels: EN,
        names: NONE,
        senderTeam: null,
        lineups: LINEUPS,
      });
      expect(facts.winner).toBe("Dan's team");
    }
  });

  it("REVIEW OF #620, 1: the model's side never places a club name (bibs); only this match's own names do", () => {
    const { facts, mapped } = normaliseScoreFacts(
      f(9, 4, { firstTeam: "bibs", secondTeam: "no bibs", teamSides: [{ team: "bibs", side: "RED" }, { team: "no bibs", side: "YELLOW" }] }),
      { labels: EN, names: NONE, senderTeam: null, lineups: LINEUPS },
    );
    expect(facts).toMatchObject({ firstTeam: "bibs", secondTeam: "no bibs" });
    expect(mapped).toEqual([]);
  });

  it("a name the code already resolves is left as written, whatever the model said", () => {
    const { facts, mapped } = normaliseScoreFacts(
      f(9, 4, { firstTeam: "Red", secondTeam: "Yellow", teamSides: [{ team: "Red", side: "YELLOW" }] }),
      { labels: EN, names: NONE, senderTeam: null },
    );
    expect(facts).toMatchObject({ firstTeam: "Red", secondTeam: "Yellow" });
    expect(mapped).toEqual([]);
  });

  it('"us" and "them" stay for the engine, which knows the sender\'s side', () => {
    const { facts } = normaliseScoreFacts(f(5, 3, { winner: "us", teamSides: [{ team: "us", side: "RED" }] }), {
      labels: EN,
      names: NONE,
      senderTeam: null,
    });
    expect(facts.winner).toBe("us");
  });

  it("no names and no model side: the words stay, and the engine asks", () => {
    const { facts, mapped } = normaliseScoreFacts(f(9, 4, { firstTeam: "bibs", secondTeam: "no bibs" }), {
      labels: EN,
      names: NONE,
      senderTeam: null,
    });
    expect(facts).toMatchObject({ firstTeam: "bibs", secondTeam: "no bibs" });
    expect(mapped).toEqual([]);
  });

  it("the answer to \"Which team was bibs?\" is the winner's side", () => {
    const { facts } = normaliseScoreFacts(f(null, null, { teamSides: [{ team: "bibs", side: "RED" }] }), {
      labels: EN,
      names: NONE,
      senderTeam: null,
      asked: { name: "bibs", other: "no bibs" },
    });
    expect(facts.winner).toBe("Red");
  });

  it("an answer that places the OTHER name gives the opposite side as the winner", () => {
    const { facts } = normaliseScoreFacts(f(null, null, { teamSides: [{ team: "no bibs", side: "YELLOW" }] }), {
      labels: EN,
      names: NONE,
      senderTeam: null,
      asked: { name: "bibs", other: "no bibs" },
    });
    expect(facts.winner).toBe("Red");
  });

  it("an answer that already names the winner keeps it", () => {
    const { facts } = normaliseScoreFacts(f(null, null, { winner: "yellow" }), {
      labels: EN,
      names: NONE,
      senderTeam: null,
      asked: { name: "bibs" },
    });
    expect(facts.winner).toBe("yellow");
  });
});

describe("the question to ask when a name means no side yet", () => {
  const ctx = { labels: EN, names: NONE, senderTeam: null };

  it('"bibs 9, no bibs 4": asks about bibs, the name beside the higher number', () => {
    expect(sideQuestion(f(9, 4, { firstTeam: "bibs", secondTeam: "no bibs" }), ctx)).toEqual({ name: "bibs", other: "no bibs" });
  });

  it('"bibs 4, no bibs 9": asks about no bibs, so the answer is still the winner', () => {
    expect(sideQuestion(f(4, 9, { firstTeam: "bibs", secondTeam: "no bibs" }), ctx)).toEqual({ name: "no bibs", other: "bibs" });
  });

  it('"9-4 to the bibs": the winner word decides the name', () => {
    expect(sideQuestion(f(9, 4, { winner: "the bibs" }), ctx)).toEqual({ name: "the bibs" });
  });

  it("nothing to ask about a name when the result has no unknown winner name", () => {
    expect(sideQuestion(f(9, 4), ctx)).toBeNull();
    expect(sideQuestion(f(9, 4, { winner: "us" }), ctx)).toBeNull();
    expect(sideQuestion(f(5, 5, { firstTeam: "bibs", secondTeam: "no bibs" }), ctx)).toBeNull();
    expect(sideQuestion(f(9, 4, { firstTeam: "Red", secondTeam: "bibs" }), ctx)).toBeNull();
    // Only the loser is unknown: "which team won?" is the right question.
    expect(sideQuestion(f(4, 9, { loser: "the bibs" }), ctx)).toBeNull();
    expect(sideQuestion(f(null, null, { winner: "bibs" }), ctx)).toBeNull();
  });

  it("a name the club already uses is not asked about", () => {
    expect(sideQuestion(f(9, 4, { firstTeam: "bibs", secondTeam: "no bibs" }), { ...ctx, names: BIBS })).toBeNull();
  });
});

describe("REVIEW OF #620, 1: an earlier game's names are a hint, never an answer", () => {
  it("names a hint side for the asked name from an earlier game", () => {
    expect(hintSide("bibs", BIBS)).toBe("RED");
    expect(hintSide("no bibs", BIBS)).toBe("YELLOW");
    expect(hintSide("skins", BIBS)).toBeNull();
    expect(hintSide("bibs", null)).toBeNull();
  });

  it("a player's team is never stored: the question says so, and nothing is learned from it", () => {
    const facts = f(5, 3, { winner: "Dan's team", loser: "bibs", teamSides: [{ team: "Dan's team", side: "YELLOW", player: "Dan Hale" }] });
    const q = sideQuestion(facts, { labels: EN, names: NONE, senderTeam: null, lineups: { red: [], yellow: [] } });
    expect(q).toEqual({ name: "Dan's team", other: "bibs", noStore: ["Dan's team"] });
    expect(learnedSideNames({ first: 5, second: 3, ...q! }, { red: 3, yellow: 5 })).toEqual({ red: ["bibs"], yellow: [] });
    expect(learnedSideNames({ first: 5, second: 3, name: "Dan's team", noStore: ["Dan's team"] }, { red: 3, yellow: 5 })).toBeNull();
  });

  it("the question's stored text carries what is not to be stored", () => {
    expect(parseScoreAskNames(scoreAskNamesText({ name: "Dan's team", noStore: ["Dan's team"] }))).toEqual({ name: "Dan's team", noStore: ["Dan's team"] });
  });
});

describe("REVIEW OF #620, 1: a corrected result rewrites or deletes this match's names", () => {
  it('"wrong way round" (the same pair, the other winner): the names swap sides', () => {
    expect(sideNamesAfterCorrection(BIBS, { red: 9, yellow: 4 }, { red: 4, yellow: 9 })).toEqual({
      kind: "rewrite",
      names: { red: ["no bibs"], yellow: ["bibs"] },
    });
  });

  it("the same winner with other numbers: the names stand", () => {
    expect(sideNamesAfterCorrection(BIBS, { red: 9, yellow: 4 }, { red: 9, yellow: 7 })).toEqual({ kind: "keep" });
  });

  it("anything else (other numbers and another winner, or a draw): the names are deleted", () => {
    expect(sideNamesAfterCorrection(BIBS, { red: 9, yellow: 4 }, { red: 3, yellow: 8 })).toEqual({ kind: "delete" });
    expect(sideNamesAfterCorrection(BIBS, { red: 9, yellow: 4 }, { red: 5, yellow: 5 })).toEqual({ kind: "delete" });
  });

  it("no names: nothing to do", () => {
    expect(sideNamesAfterCorrection(NONE, { red: 9, yellow: 4 }, { red: 4, yellow: 9 })).toEqual({ kind: "keep" });
    expect(sideNamesAfterCorrection(null, { red: 9, yellow: 4 }, { red: 4, yellow: 9 })).toEqual({ kind: "keep" });
  });
});

describe("what the answer teaches MatchTime", () => {
  it("bibs had the 9, Red got the 9: bibs is Red, no bibs Yellow", () => {
    expect(learnedSideNames({ first: 9, second: 4, name: "bibs", other: "no bibs" }, { red: 9, yellow: 4 })).toEqual(BIBS);
  });

  it("Yellow got the 9: bibs is Yellow", () => {
    expect(learnedSideNames({ first: 9, second: 4, name: "bibs" }, { red: 4, yellow: 9 })).toEqual({ red: [], yellow: ["bibs"] });
  });

  it("nothing is learned from another result, a draw or a question with no name", () => {
    expect(learnedSideNames({ first: 9, second: 4, name: "bibs" }, { red: 8, yellow: 4 })).toBeNull();
    expect(learnedSideNames({ first: 4, second: 4, name: "bibs" }, { red: 4, yellow: 4 })).toBeNull();
    expect(learnedSideNames({ first: 9, second: 4 }, { red: 9, yellow: 4 })).toBeNull();
  });
});

describe("the context lines", () => {
  const game = {
    when: "Mon 16 Nov 20:15",
    labels: EN,
    names: BIBS,
    players: { red: ["Ava Stone", "Ben Cole"], yellow: ["Dan Hale"] },
    awaiting: true,
  };

  it("THE GAME for the score extractor: waiting, both sides, the club's names and the players", () => {
    const lines = gameContextLines(game).join("\n");
    expect(lines).toContain("THE GAME");
    expect(lines).toContain("waiting for its score");
    expect(lines).toMatch(/red: MatchTime calls it "Red"; this club called it "bibs" in this game; players Ava Stone, Ben Cole/);
    expect(lines).toMatch(/yellow: MatchTime calls it "Yellow"; this club called it "no bibs" in this game; players Dan Hale/);
  });

  it("a recorded result is NOT said (it made the model read fresh claims as corrections), and a side with no names or players says so", () => {
    const lines = gameContextLines({ ...game, names: NONE, players: { red: [], yellow: [] }, awaiting: false }).join("\n");
    expect(lines).not.toMatch(/recorded|waiting/);
    expect(lines).not.toMatch(/Red \d/);
    expect(lines).not.toContain("also calls");
    expect(lines).toMatch(/red: MatchTime calls it "Red"; no players on record/);
  });

  it("the router's line names the sides and, when known, the club's names for them", () => {
    expect(awaitedScoreLine({ when: "Mon 16 Nov 20:15", labels: EN, names: BIBS })).toBe(
      'MATCHTIME IS WAITING for the score of the club\'s last game (Mon 16 Nov 20:15), which has finished. ' +
        'Its two sides are Red and Yellow; this club also calls Red "bibs" and Yellow "no bibs".',
    );
    expect(awaitedScoreLine({ when: "Mon 16 Nov 20:15", labels: EN, names: NONE })).toBe(
      "MATCHTIME IS WAITING for the score of the club's last game (Mon 16 Nov 20:15), which has finished. " +
        "Its two sides are Red and Yellow.",
    );
  });

  it("the acknowledgement names a side with the club's name beside MatchTime's", () => {
    expect(labelsWithSideNames(EN, BIBS)).toEqual(["Red (bibs)", "Yellow (no bibs)"]);
    expect(labelsWithSideNames(EN, NONE)).toEqual(EN);
    expect(labelsWithSideNames(["Bibs", "Skins"], { red: ["bibs"], yellow: [] })).toEqual(["Bibs", "Skins"]);
  });
});
