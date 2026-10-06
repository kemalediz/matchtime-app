/**
 * THE SCORE ROUTE: WHOSE NUMBER IS WHOSE, AND CHANGING A RECORDED RESULT
 * (2026-10-07, and the review of PR #214 the same day).
 *
 * Sutton FC, Tuesday 6 October 2026. Red and Yellow.
 *
 *   1. "it was 6-6 until 15 minutes then suddenly it turned to 9-6 to
 *      yellows. Let's see if you can understand this @Match Time"
 *      was recorded Red 9, Yellow 6, and the bot said so.
 *   2. "@Match Time no Yellow 9 - 6 Red", from the same admin a minute
 *      later, was dropped in silence: a result was already recorded.
 *
 * The facts below are what the rewritten extractor is asked to return
 * for those messages. Whether the real model returns them is the
 * prepared live check's job (`scripts/live-check-score-extractor.ts`),
 * never this file's: a stub only proves what the engine does with them.
 */
import { describe, it, expect } from "vitest";
import { decide, SCORE_CORRECTION_WINDOW_MS } from "../engine";
import { compose } from "../compose";
import { SCORE_ASK_TTL_MS } from "../score-ask";
import type { ScoreFacts, SquadState } from "../types";
import { NOW, msg, world } from "./helpers";

const RED_SIDE = ["kemal", "elvin", "sait"];
const YELLOW_SIDE = ["mustafa", "najib", "wasim"];
const TEAMS = [
  ...RED_SIDE.map((k) => ({ userId: `u-${k}`, team: "RED" as const })),
  ...YELLOW_SIDE.map((k) => ({ userId: `u-${k}`, team: "YELLOW" as const })),
];
const HOURS = 60 * 60 * 1000;
type Completed = NonNullable<SquadState["completedMatch"]>;

function played(over: Partial<Completed> = {}): SquadState {
  return world({
    admins: ["kemal"],
    completedMatch: {
      id: "done-1",
      participantUserIds: TEAMS.map((t) => t.userId),
      teams: TEAMS,
      kickoffAt: new Date(NOW.getTime() - 2 * HOURS).toISOString(),
      ...over,
    },
  });
}

const score = (first: number, second: number, over: Partial<ScoreFacts> = {}): ScoreFacts => ({
  kind: "score",
  first,
  second,
  ...over,
});
/** A message with no scoreline in it. */
const noNumbers = (over: Partial<ScoreFacts> = {}): ScoreFacts => ({
  kind: "score",
  first: null,
  second: null,
  ...over,
});

function run(state: SquadState, ...messages: Parameters<typeof msg>[0][]) {
  const r = decide({ now: NOW, state, messages: messages.map((m) => msg(m)) });
  const out = compose(r);
  return {
    r,
    writes: r.writes.filter((w) => w.kind === "score"),
    asks: r.writes.filter((w) => w.kind === "score_ask"),
    replies: out.utterances.map((u) => u.text),
    reasons: r.outcomes.map((o) => o.reasons.join("; ")).join(" | "),
  };
}

const ASK_10_7 = "10 - 7: which team won? Reply with the winning team: Red or Yellow.";
const RECORDED_9_6_HINT =
  'That match is already recorded: *Red* won 9 - 6 against Yellow. If that is wrong, tell me "no, it was" with the right score and the team that won.';
const RECORDED_9_6_ADMIN =
  "That match is already recorded: *Red* won 9 - 6 against Yellow. An admin can change it on the match page.";

describe("the incident, message 1: a result that names the winner", () => {
  it('"9-6 to yellows" is recorded Red 6, Yellow 9', () => {
    const { writes, replies } = run(played(), {
      from: "kemal",
      tagged: true,
      body: "it was 6-6 until 15 minutes then suddenly it turned to 9-6 to yellows",
      route: "score",
      facts: score(9, 6, { winner: "yellows" }),
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ red: 6, yellow: 9 });
    expect(writes[0]).not.toHaveProperty("previous");
    // The reply names the winner first, so the group can check it at a
    // glance. "Red 9 - 6 Yellow" took a second look to get wrong.
    expect(replies).toEqual(["Got it 👍 *Yellow* won 9 - 6 against Red. Recorded."]);
  });

  it('"5-4 to reds" still records Red 5, Yellow 4', () => {
    const { writes, replies } = run(played(), {
      from: "elvin",
      body: "5-4 to reds",
      route: "score",
      facts: score(5, 4, { winner: "reds" }),
    });
    expect(writes[0]).toMatchObject({ red: 5, yellow: 4 });
    expect(replies).toEqual(["Got it 👍 *Red* won 5 - 4 against Yellow. Recorded."]);
  });

  it("a draw needs no team and says it is a draw", () => {
    const { writes, replies } = run(played(), { from: "kemal", body: "7-7", route: "score", facts: score(7, 7) });
    expect(writes[0]).toMatchObject({ red: 7, yellow: 7 });
    expect(replies).toEqual(["Got it 👍 a draw, Red 7 - 7 Yellow. Recorded."]);
  });

  it('"we won 5-3" is read from the side the sender played on', () => {
    const { writes } = run(played(), {
      from: "najib",
      body: "we won 5-3",
      route: "score",
      facts: score(5, 3, { winner: "us" }),
    });
    expect(writes[0]).toMatchObject({ red: 3, yellow: 5 });
  });

  it("names the teams as the PLAYED match called them, not the upcoming one", () => {
    const { replies } = run(played({ teamLabels: ["Lions", "Tigers"] }), {
      from: "kemal",
      body: "4-2 to the tigers",
      route: "score",
      facts: score(4, 2, { winner: "the tigers" }),
    });
    expect(replies).toEqual(["Got it 👍 *Tigers* won 4 - 2 against Lions. Recorded."]);
  });
});

describe("two different numbers and nobody named: it asks, it does not guess", () => {
  it('"10-7" records no result, asks which team won, and remembers that it asked', () => {
    const { writes, asks, replies, r } = run(played(), {
      from: "kemal",
      body: "10-7 :))",
      route: "score",
      facts: score(10, 7),
    });
    expect(writes).toHaveLength(0);
    expect(r.nextState.completedMatch).toMatchObject({ redScore: null, yellowScore: null });
    expect(replies).toEqual([ASK_10_7]);
    expect(asks).toEqual([expect.objectContaining({ matchId: "done-1", first: 10, second: 7 })]);
  });

  it("the question names both teams and suggests neither (review item 4)", () => {
    // The first wording ended: Tell me like this: "10 - 7 to Yellow".
    // An example that names a winner is a suggestion.
    expect(ASK_10_7).not.toMatch(/to Yellow|to Red|like this/);
    expect(ASK_10_7).toMatch(/Red or Yellow/);
  });

  it('"we won 5-3" from somebody who was on neither side asks too', () => {
    const { writes, replies } = run(played(), {
      from: null,
      body: "we won 5-3",
      route: "score",
      facts: score(5, 3, { winner: "us" }),
    });
    expect(writes).toHaveLength(0);
    expect(replies[0]).toMatch(/^5 - 3: which team won\?/);
  });

  it('"Reds 3-5": one name beside the LOWER number is asked about (review item 5)', () => {
    const { writes, replies } = run(played(), {
      from: "kemal",
      body: "Reds 3-5",
      route: "score",
      facts: score(3, 5, { firstTeam: "Reds" }),
    });
    expect(writes).toHaveLength(0);
    expect(replies[0]).toMatch(/^3 - 5: which team won\?/);
  });

  it("a member who may not report a result is still told nothing", () => {
    const { writes, asks, replies } = run(played(), {
      from: "zair",
      body: "10-7",
      route: "score",
      facts: score(10, 7),
    });
    expect(writes).toHaveLength(0);
    expect(asks).toHaveLength(0);
    expect(replies).toEqual([]);
  });
});

describe("the question is asked ONCE, and its answer completes the result (review item 4)", () => {
  const asked = (over: Partial<Completed> = {}) =>
    played({
      pendingScore: { first: 10, second: 7, askedAt: new Date(NOW.getTime() - 60_000).toISOString() },
      ...over,
    });

  it('"Yellow" after the question records Yellow 10, Red 7', () => {
    const { writes, replies, r } = run(asked(), {
      from: "elvin",
      body: "Yellow",
      route: "score",
      facts: noNumbers({ winner: "Yellow" }),
    });
    expect(writes).toEqual([expect.objectContaining({ matchId: "done-1", red: 7, yellow: 10 })]);
    expect(replies).toEqual(["Got it 👍 *Yellow* won 10 - 7 against Red. Recorded."]);
    expect(r.nextState.completedMatch?.pendingScore).toBeUndefined();
  });

  it('"reds won" records Red 10, Yellow 7', () => {
    const { writes } = run(asked(), {
      from: "kemal",
      body: "reds won",
      route: "score",
      facts: noNumbers({ winner: "reds" }),
    });
    expect(writes[0]).toMatchObject({ red: 10, yellow: 7 });
  });

  it("the same scoreline again is not asked about again", () => {
    const { writes, asks, replies, reasons } = run(asked(), {
      from: "sait",
      body: "7-10",
      route: "score",
      facts: score(7, 10),
    });
    expect(writes).toHaveLength(0);
    expect(asks).toHaveLength(0);
    expect(replies).toEqual([]);
    expect(reasons).toMatch(/already asked/);
  });

  it("twice in ONE batch is asked once", () => {
    const { asks, replies } = run(
      played(),
      { from: "kemal", body: "10-7", route: "score", facts: score(10, 7) },
      { from: "sait", body: "10-7", route: "score", facts: score(10, 7) },
    );
    expect(asks).toHaveLength(1);
    expect(replies).toEqual([ASK_10_7]);
  });

  it("a DIFFERENT scoreline replaces the one being asked about", () => {
    const { asks, replies } = run(asked(), { from: "sait", body: "10-6", route: "score", facts: score(10, 6) });
    expect(asks).toEqual([expect.objectContaining({ first: 10, second: 6 })]);
    expect(replies[0]).toMatch(/^10 - 6: which team won\?/);
  });

  it("an answer from somebody who may not report a result records nothing", () => {
    const { writes, replies } = run(asked(), {
      from: "zair",
      body: "Yellow",
      route: "score",
      facts: noNumbers({ winner: "Yellow" }),
    });
    expect(writes).toHaveLength(0);
    expect(replies).toEqual([]);
  });

  it("an answer that names nobody we know records nothing", () => {
    const { writes } = run(asked(), {
      from: "kemal",
      body: "Arsenal",
      route: "score",
      facts: noNumbers({ winner: "Arsenal" }),
    });
    expect(writes).toHaveLength(0);
  });

  it("a question older than a day is no longer open", () => {
    const stale = played({
      pendingScore: { first: 10, second: 7, askedAt: new Date(NOW.getTime() - SCORE_ASK_TTL_MS - 1).toISOString() },
    });
    const { writes } = run(stale, { from: "kemal", body: "Yellow", route: "score", facts: noNumbers({ winner: "Yellow" }) });
    expect(writes).toHaveLength(0);
  });

  it("a full result while a question is open records it and closes the question", () => {
    const { writes, r } = run(asked(), {
      from: "kemal",
      body: "10-7 to reds",
      route: "score",
      facts: score(10, 7, { winner: "reds" }),
    });
    expect(writes[0]).toMatchObject({ red: 10, yellow: 7 });
    expect(r.nextState.completedMatch?.pendingScore).toBeUndefined();
  });
});

describe("a message with no numbers never becomes a score (review item 3)", () => {
  it("writes nothing and says nothing when there is no question open", () => {
    for (const facts of [noNumbers(), noNumbers({ winner: "yellows" }), noNumbers({ correction: true })]) {
      const { writes, asks, replies, r } = run(played(), {
        from: "kemal",
        tagged: true,
        body: "@Match Time yellows",
        route: "score",
        facts,
      });
      expect(writes).toHaveLength(0);
      expect(asks).toHaveLength(0);
      expect(replies).toEqual([]);
      expect(r.nextState.completedMatch).toMatchObject({ redScore: null, yellowScore: null });
    }
  });

  it("never 0-0, even when the model is told there is no score and sends zeros anyway", () => {
    // What the parser hands the engine for hasScore false is nulls. This
    // pins the engine's half: nulls write nothing.
    const { r } = run(played(), { from: "kemal", body: "good game", route: "score", facts: noNumbers() });
    expect(r.writes).toHaveLength(0);
  });
});

describe("the incident, message 2: correcting a recorded result", () => {
  const wrong = (over: Partial<Completed> = {}) => played({ redScore: 9, yellowScore: 6, status: "COMPLETED", ...over });
  const fix = score(9, 6, { firstTeam: "Yellow", secondTeam: "Red", correction: true });

  it('"@Match Time no Yellow 9 - 6 Red" from an admin changes it and says both results', () => {
    const { writes, replies, r } = run(wrong(), {
      from: "kemal",
      tagged: true,
      body: "@Match Time no Yellow 9 - 6 Red",
      route: "score",
      facts: fix,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ red: 6, yellow: 9, previous: { red: 9, yellow: 6 } });
    expect(r.nextState.completedMatch).toMatchObject({ redScore: 6, yellowScore: 9 });
    expect(replies).toEqual(["Corrected 👍 It was Red 9 - 6 Yellow. Now *Yellow* won 9 - 6 against Red."]);
  });

  it("a player from the match may correct it too, and needs no tag", () => {
    const { writes } = run(wrong(), {
      from: "wasim",
      body: "no it was 9-6 to yellow",
      route: "score",
      facts: score(9, 6, { winner: "yellow", correction: true }),
    });
    expect(writes[0]).toMatchObject({ red: 6, yellow: 9, previous: { red: 9, yellow: 6 } });
  });

  it("repeating the recorded result changes nothing and says nothing", () => {
    const { writes, replies, reasons } = run(wrong(), {
      from: "kemal",
      tagged: true,
      body: "@Match Time 9-6 to reds",
      route: "score",
      facts: score(9, 6, { winner: "reds" }),
    });
    expect(writes).toHaveLength(0);
    expect(replies).toEqual([]);
    expect(reasons).toMatch(/same result/);
  });

  it("somebody who neither played nor is an admin is told it is recorded, and where to change it", () => {
    const { writes, replies } = run(wrong(), {
      from: "zair",
      tagged: true,
      body: "@Match Time no it was 9-6 to yellow",
      route: "score",
      facts: score(9, 6, { winner: "yellow", correction: true }),
    });
    expect(writes).toHaveLength(0);
    expect(replies).toEqual([RECORDED_9_6_ADMIN]);
  });

  it("a sender WhatsApp did not identify cannot change a recorded result", () => {
    // An unknown sender may report a FIRST result, because losing it is
    // worse. That argument does not reach a result that already exists.
    const { writes, replies } = run(wrong(), {
      from: null,
      tagged: true,
      body: "@Match Time no Yellow 9 - 6 Red",
      route: "score",
      facts: fix,
    });
    expect(writes).toHaveLength(0);
    expect(replies).toEqual([RECORDED_9_6_ADMIN]);
  });

  it("after the window even an admin is pointed at the match page", () => {
    const old = wrong({
      kickoffAt: new Date(NOW.getTime() - SCORE_CORRECTION_WINDOW_MS - HOURS).toISOString(),
    });
    const { writes, replies } = run(old, {
      from: "kemal",
      tagged: true,
      body: "@Match Time no Yellow 9 - 6 Red",
      route: "score",
      facts: fix,
    });
    expect(writes).toHaveLength(0);
    expect(replies).toEqual([RECORDED_9_6_ADMIN]);
  });

  it("the window is 48 hours from kickoff", () => {
    expect(SCORE_CORRECTION_WINDOW_MS).toBe(48 * HOURS);
  });

  it("a correction that does not say which team is asked about, and the question is remembered", () => {
    const { writes, asks, replies } = run(wrong(), {
      from: "kemal",
      tagged: true,
      body: "@Match Time no it was 9-7",
      route: "score",
      facts: score(9, 7, { correction: true }),
    });
    expect(writes).toHaveLength(0);
    expect(asks).toEqual([expect.objectContaining({ first: 9, second: 7 })]);
    expect(replies[0]).toMatch(/^9 - 7: which team won\?/);
  });

  it('...and "Yellow" then completes the correction', () => {
    const state = wrong({
      pendingScore: { first: 9, second: 7, askedAt: new Date(NOW.getTime() - 60_000).toISOString() },
    });
    const { writes, replies } = run(state, {
      from: "kemal",
      body: "Yellow",
      route: "score",
      facts: noNumbers({ winner: "Yellow" }),
    });
    expect(writes[0]).toMatchObject({ red: 7, yellow: 9, previous: { red: 9, yellow: 6 } });
    expect(replies).toEqual(["Corrected 👍 It was Red 9 - 6 Yellow. Now *Yellow* won 9 - 7 against Red."]);
  });

  it("a correcting DRAW needs no team", () => {
    const { writes, replies } = run(wrong(), {
      from: "kemal",
      tagged: true,
      body: "@Match Time no it finished 9-9",
      route: "score",
      facts: score(9, 9, { correction: true }),
    });
    expect(writes[0]).toMatchObject({ red: 9, yellow: 9, previous: { red: 9, yellow: 6 } });
    expect(replies).toEqual(["Corrected 👍 It was Red 9 - 6 Yellow. Now a draw, Red 9 - 9 Yellow."]);
  });

  it("a result and its correction in ONE batch: two writes, the second knows the first", () => {
    const { writes } = run(
      played(),
      { from: "kemal", body: "9-6 to reds", route: "score", facts: score(9, 6, { winner: "reds" }) },
      { from: "kemal", tagged: true, body: "@Match Time no Yellow 9 - 6 Red", route: "score", facts: fix },
    );
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ red: 9, yellow: 6 });
    expect(writes[1]).toMatchObject({ red: 6, yellow: 9, previous: { red: 9, yellow: 6 } });
  });
});

describe('"wrong way round": a correction with no numbers (review item 3)', () => {
  const wrong = (over: Partial<Completed> = {}) => played({ redScore: 9, yellowScore: 6, status: "COMPLETED", ...over });

  it('"@Match Time wrong way round, yellows won" swaps the recorded result to Yellow', () => {
    const { writes, replies } = run(wrong(), {
      from: "kemal",
      tagged: true,
      body: "@Match Time wrong way round, yellows won",
      route: "score",
      facts: noNumbers({ correction: true, swapped: true, winner: "yellows" }),
    });
    expect(writes).toEqual([expect.objectContaining({ red: 6, yellow: 9, previous: { red: 9, yellow: 6 } })]);
    expect(replies).toEqual(["Corrected 👍 It was Red 9 - 6 Yellow. Now *Yellow* won 9 - 6 against Red."]);
  });

  it('"other way round", naming nobody, swaps it', () => {
    const { writes } = run(wrong(), {
      from: "wasim",
      body: "other way round",
      route: "score",
      facts: noNumbers({ correction: true, swapped: true }),
    });
    expect(writes[0]).toMatchObject({ red: 6, yellow: 9, previous: { red: 9, yellow: 6 } });
  });

  it('"no, yellows won" without the word swapped is the same correction', () => {
    const { writes } = run(wrong(), {
      from: "kemal",
      body: "no, yellows won",
      route: "score",
      facts: noNumbers({ correction: true, winner: "yellows" }),
    });
    expect(writes[0]).toMatchObject({ red: 6, yellow: 9 });
  });

  it('"wrong way round, reds won" when Red is already recorded as the winner changes nothing', () => {
    // The winner named is the winner recorded. Swapping would make the
    // message's own words false.
    const { writes, replies, reasons } = run(wrong(), {
      from: "kemal",
      tagged: true,
      body: "@Match Time wrong way round, reds won",
      route: "score",
      facts: noNumbers({ correction: true, swapped: true, winner: "reds" }),
    });
    expect(writes).toHaveLength(0);
    expect(replies).toEqual([]);
    expect(reasons).toMatch(/same result/);
  });

  it("a numberless correction the bot cannot read is answered with what is recorded and how to correct it", () => {
    for (const facts of [
      noNumbers({ correction: true }),
      noNumbers({ correction: true, winner: "Arsenal" }),
    ]) {
      const { writes, replies } = run(wrong(), { from: "kemal", tagged: true, body: "@Match Time wrong", route: "score", facts });
      expect(writes).toHaveLength(0);
      expect(replies).toEqual([RECORDED_9_6_HINT]);
    }
  });

  it("a recorded DRAW cannot be swapped: it is answered, not changed", () => {
    const { writes, replies } = run(wrong({ redScore: 7, yellowScore: 7 }), {
      from: "kemal",
      tagged: true,
      body: "@Match Time wrong, yellows won",
      route: "score",
      facts: noNumbers({ correction: true, winner: "yellows" }),
    });
    expect(writes).toHaveLength(0);
    expect(replies[0]).toMatch(/^That match is already recorded: a draw, Red 7 - 7 Yellow\. If that is wrong/);
  });

  it("is refused for somebody who may not correct, like any correction", () => {
    const { writes, replies } = run(wrong(), {
      from: "zair",
      tagged: true,
      body: "@Match Time wrong way round",
      route: "score",
      facts: noNumbers({ correction: true, swapped: true }),
    });
    expect(writes).toHaveLength(0);
    expect(replies).toEqual([RECORDED_9_6_ADMIN]);
  });
});

describe("a tag is not a correction (review item 6)", () => {
  const recorded = (over: Partial<Completed> = {}) => played({ redScore: 9, yellowScore: 6, status: "COMPLETED", ...over });

  it("a tagged score that is NOT a correction never replaces the recorded result", () => {
    const { writes, replies } = run(recorded(), {
      from: "wasim",
      tagged: true,
      body: "@Match Time it was 9-2 to yellow",
      route: "score",
      facts: score(9, 2, { winner: "yellow" }),
    });
    expect(writes).toHaveLength(0);
    expect(replies).toEqual([RECORDED_9_6_HINT]);
  });

  it('"@Match Time last week we lost 9-2" changes nothing and says nothing', () => {
    const { writes, asks, replies, reasons } = run(recorded(), {
      from: "wasim",
      tagged: true,
      body: "@Match Time last week we lost 9-2",
      route: "score",
      facts: score(9, 2, { loser: "us", otherGame: true }),
    });
    expect(writes).toHaveLength(0);
    expect(asks).toHaveLength(0);
    expect(replies).toEqual([]);
    expect(reasons).toMatch(/another game/);
  });

  it("talk about another game is not recorded against an UNSCORED match either", () => {
    const { writes, replies } = run(played(), {
      from: "wasim",
      tagged: true,
      body: "@Match Time last week we lost 9-2",
      route: "score",
      facts: score(9, 2, { loser: "us", otherGame: true }),
    });
    expect(writes).toHaveLength(0);
    expect(replies).toEqual([]);
  });

  it("an untagged score message that is not a correction still changes nothing and says nothing", () => {
    const { writes, replies, reasons } = run(recorded(), {
      from: "kemal",
      body: "9-2 to yellows, what a night",
      route: "score",
      facts: score(9, 2, { winner: "yellows" }),
    });
    expect(writes).toHaveLength(0);
    expect(replies).toEqual([]);
    expect(reasons).toMatch(/already recorded 9-6/);
  });
});

describe("two matches inside 48 hours (review item 6)", () => {
  it('"no, it was 9-6 to yellow" is NOT recorded against a newer match that has no result yet', () => {
    // Monday's match is recorded. Tuesday's has just been played and has
    // no result. The correction is about Monday, and the engine only
    // ever holds the latest match.
    const { writes, replies } = run(played({ earlierRecentResult: true, kickoffLabel: "Tue 21:30" }), {
      from: "kemal",
      tagged: true,
      body: "@Match Time no it was 9-6 to yellow",
      route: "score",
      facts: score(9, 6, { winner: "yellow", correction: true }),
    });
    expect(writes).toHaveLength(0);
    expect(replies).toEqual([
      "I can't tell which match that corrects. For Tue 21:30, just tell me the score and the team that won. An admin can change an earlier result on its match page.",
    ]);
  });

  it("a plain first report still lands on the newer match", () => {
    const { writes } = run(played({ earlierRecentResult: true }), {
      from: "kemal",
      body: "9-6 to yellow",
      route: "score",
      facts: score(9, 6, { winner: "yellow" }),
    });
    expect(writes[0]).toMatchObject({ matchId: "done-1", red: 6, yellow: 9 });
  });

  it('with no other recent result, "no, it was 10-7 to red" on an unscored match is simply its result', () => {
    // Two players disagreeing about tonight's score before anything is
    // recorded. There is nothing else it could be correcting.
    const { writes } = run(played(), {
      from: "kemal",
      body: "no it was 10-7 to red",
      route: "score",
      facts: score(10, 7, { winner: "red", correction: true }),
    });
    expect(writes[0]).toMatchObject({ red: 10, yellow: 7 });
    expect(writes[0]).not.toHaveProperty("previous");
  });
});

describe("Turkish", () => {
  const tr = (over: Partial<Completed> = {}) => {
    const s = played({ teamLabels: ["Kırmızı", "Sarı"], ...over });
    return { ...s, features: { ...s.features, language: "tr" as const } };
  };

  it('"sarılar 9-6 kazandı"', () => {
    const { writes, replies } = run(tr(), {
      from: "kemal",
      body: "sarılar 9-6 kazandı",
      route: "score",
      facts: score(9, 6, { winner: "sarılar" }),
    });
    expect(writes[0]).toMatchObject({ red: 6, yellow: 9 });
    expect(replies).toEqual(["Tamam 👍 *Sarı* 9 - 6 kazandı, rakip Kırmızı. Kaydettim."]);
  });

  it('"kırmızı 6 sarı 9" as a correction', () => {
    const { writes, replies } = run(tr({ redScore: 9, yellowScore: 6 }), {
      from: "kemal",
      tagged: true,
      body: "@Match Time yanlış, kırmızı 6 sarı 9",
      route: "score",
      facts: score(6, 9, { firstTeam: "kırmızı", secondTeam: "sarı", correction: true }),
    });
    expect(writes[0]).toMatchObject({ red: 6, yellow: 9, previous: { red: 9, yellow: 6 } });
    expect(replies).toEqual([
      "Düzelttim 👍 Önceki kayıt Kırmızı 9 - 6 Sarı idi. Şimdi *Sarı* 9 - 6 kazandı, rakip Kırmızı.",
    ]);
  });

  it('"tam tersi, sarılar kazandı"', () => {
    const { writes } = run(tr({ redScore: 9, yellowScore: 6 }), {
      from: "kemal",
      tagged: true,
      body: "@Match Time tam tersi, sarılar kazandı",
      route: "score",
      facts: noNumbers({ correction: true, swapped: true, winner: "sarılar" }),
    });
    expect(writes[0]).toMatchObject({ red: 6, yellow: 9, previous: { red: 9, yellow: 6 } });
  });

  it("asks in Turkish, naming both teams and suggesting neither", () => {
    const { replies } = run(tr(), { from: "kemal", body: "10-7", route: "score", facts: score(10, 7) });
    expect(replies).toEqual(["10 - 7: hangi takım kazandı? Kazanan takımı yazın: Kırmızı mı, Sarı mı?"]);
  });

  it("the two already-recorded replies", () => {
    const state = tr({ redScore: 9, yellowScore: 6 });
    const hint = run(state, { from: "kemal", tagged: true, body: "@Match Time 9-2 sarı", route: "score", facts: score(9, 2, { winner: "sarı" }) });
    expect(hint.replies).toEqual([
      'Bu maçın sonucu zaten kayıtlı: *Kırmızı* 9 - 6 kazandı, rakip Sarı. Yanlışsa "hayır" diye başlayıp doğru skoru ve kazanan takımı yazın.',
    ]);
    const admin = run(state, { from: "zair", tagged: true, body: "@Match Time hayır 9-6 sarı", route: "score", facts: score(9, 6, { winner: "sarı", correction: true }) });
    expect(admin.replies).toEqual([
      "Bu maçın sonucu zaten kayıtlı: *Kırmızı* 9 - 6 kazandı, rakip Sarı. Bir yönetici maç sayfasından değiştirebilir.",
    ]);
  });
});
