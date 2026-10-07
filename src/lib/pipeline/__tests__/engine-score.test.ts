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
import { parseFacts } from "../extractors";
import { SCORE_ANSWER_UNTAGGED_MS, SCORE_ASK_TTL_MS } from "../score-ask";
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

describe("the question is asked ONCE, and a NARROW answer completes the result", () => {
  // Second review of PR #214, H1 and M2. The question used to stay open
  // for a day and take a bare team name from anybody, which is how a
  // conversation about bibs hours later could record a result.
  const MIN = 60_000;
  const asked = (agoMs = MIN, over: Partial<Completed> = {}) =>
    played({
      pendingScore: {
        first: 10,
        second: 7,
        askedAt: new Date(NOW.getTime() - agoMs).toISOString(),
        askerUserId: "u-elvin",
      },
      ...over,
    });
  const answer = (from: string | null, o: { tagged?: boolean; body?: string } = {}) => ({
    from,
    tagged: o.tagged ?? false,
    body: o.body ?? "Yellow",
    route: "score" as const,
    facts: noNumbers({ winner: "Yellow" }),
  });

  it("the question records who posted the scoreline", () => {
    const { asks } = run(played(), { from: "elvin", body: "10-7", route: "score", facts: score(10, 7) });
    expect(asks).toEqual([expect.objectContaining({ first: 10, second: 7, askerUserId: "u-elvin" })]);
  });

  it('"Yellow" from the person who posted the scoreline records Yellow 10, Red 7', () => {
    const { writes, replies, r } = run(asked(), answer("elvin"));
    expect(writes).toEqual([expect.objectContaining({ matchId: "done-1", red: 7, yellow: 10 })]);
    expect(replies).toEqual(["Got it 👍 *Yellow* won 10 - 7 against Red. Recorded."]);
    expect(r.nextState.completedMatch?.pendingScore).toBeUndefined();
  });

  it("an admin may answer for them, untagged", () => {
    expect(run(asked(), answer("kemal")).writes[0]).toMatchObject({ red: 7, yellow: 10 });
  });

  it("ANOTHER player's bare team name is not an answer", () => {
    const { writes, replies } = run(asked(), answer("sait"));
    expect(writes).toHaveLength(0);
    expect(replies).toEqual([]);
  });

  it("...unless they tag the bot", () => {
    expect(run(asked(), answer("sait", { tagged: true, body: "@Match Time Yellow" })).writes[0]).toMatchObject({
      red: 7,
      yellow: 10,
    });
  });

  it("untagged, the answer is good for 30 minutes", () => {
    expect(run(asked(SCORE_ANSWER_UNTAGGED_MS - MIN), answer("elvin")).writes).toHaveLength(1);
    expect(run(asked(SCORE_ANSWER_UNTAGGED_MS + MIN), answer("elvin")).writes).toHaveLength(0);
    expect(run(asked(SCORE_ANSWER_UNTAGGED_MS + MIN), answer("kemal")).writes).toHaveLength(0);
  });

  it("tagged, for as long as the question is open: two hours", () => {
    const tagged = { tagged: true, body: "@Match Time Yellow" };
    expect(SCORE_ASK_TTL_MS).toBe(2 * HOURS);
    expect(run(asked(SCORE_ASK_TTL_MS - MIN), answer("elvin", tagged)).writes).toHaveLength(1);
    expect(run(asked(SCORE_ASK_TTL_MS + MIN), answer("elvin", tagged)).writes).toHaveLength(0);
  });

  it('"Yellow?" is a question, not an answer', () => {
    expect(run(asked(), answer("elvin", { body: "Yellow?" })).writes).toHaveLength(0);
    expect(run(asked(), answer("kemal", { tagged: true, body: "@Match Time yellow??" })).writes).toHaveLength(0);
  });

  it("a sender WhatsApp did not identify can answer only by tagging the bot", () => {
    expect(run(asked(), answer(null)).writes).toHaveLength(0);
    expect(run(asked(), answer(null, { tagged: true, body: "@Match Time Yellow" })).writes).toHaveLength(1);
  });

  it("somebody who may not report a result cannot answer, tagged or not", () => {
    expect(run(asked(), answer("zair", { tagged: true, body: "@Match Time Yellow" })).writes).toHaveLength(0);
  });

  it("an answer that names nobody we know records nothing", () => {
    const { writes } = run(asked(), { from: "elvin", body: "Arsenal", route: "score", facts: noNumbers({ winner: "Arsenal" }) });
    expect(writes).toHaveLength(0);
  });

  it("the same scoreline again is not asked about again", () => {
    const { writes, asks, replies, reasons } = run(asked(), { from: "sait", body: "7-10", route: "score", facts: score(7, 10) });
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
    expect(asks).toEqual([expect.objectContaining({ first: 10, second: 6, askerUserId: "u-sait" })]);
    expect(replies[0]).toMatch(/^10 - 6: which team won\?/);
  });

  it("a full result while a question is open records it and closes the question", () => {
    const { writes, r } = run(asked(), { from: "kemal", body: "10-7 to reds", route: "score", facts: score(10, 7, { winner: "reds" }) });
    expect(writes[0]).toMatchObject({ red: 10, yellow: 7 });
    expect(r.nextState.completedMatch?.pendingScore).toBeUndefined();
  });

  it('H1: "10-7" then "10-7 to reds" in ONE batch: the result, and no question asked or stored', () => {
    const { writes, asks, replies, r } = run(
      played(),
      { from: "sait", body: "10-7", route: "score", facts: score(10, 7) },
      { from: "kemal", body: "10-7 to reds", route: "score", facts: score(10, 7, { winner: "reds" }) },
    );
    expect(writes).toEqual([expect.objectContaining({ red: 10, yellow: 7 })]);
    expect(asks).toEqual([]);
    expect(replies).toEqual(["Got it 👍 *Red* won 10 - 7 against Yellow. Recorded."]);
    expect(r.nextState.completedMatch?.pendingScore).toBeUndefined();
  });

  it("H1: a question is NEVER valid for a match that has a result", () => {
    // A row left behind by anything at all. The bare "Yellow" used to
    // complete it as a "correction" and overwrite the recorded result.
    const stale = asked(MIN, { redScore: 10, yellowScore: 6, status: "COMPLETED" });
    for (const m of [answer("elvin"), answer("kemal"), answer("kemal", { tagged: true, body: "@Match Time Yellow" })]) {
      const { writes, asks } = run(stale, m);
      expect(writes).toHaveLength(0);
      expect(asks).toHaveLength(0);
    }
  });
});

describe("a message with no numbers never becomes a score", () => {
  it("writes nothing when there is no question open", () => {
    for (const facts of [noNumbers(), noNumbers({ winner: "yellows" }), noNumbers({ correction: true })]) {
      const { writes, asks, r } = run(played(), { from: "kemal", body: "yellows", route: "score", facts });
      expect(writes).toHaveLength(0);
      expect(asks).toHaveLength(0);
      expect(r.nextState.completedMatch).toMatchObject({ redScore: null, yellowScore: null });
    }
  });

  it('"@Match Time yellows won" with nothing recorded and no question open is asked for the score', () => {
    const { writes, replies } = run(played(), {
      from: "kemal",
      tagged: true,
      body: "@Match Time yellows won",
      route: "score",
      facts: noNumbers({ winner: "yellows" }),
    });
    expect(writes).toHaveLength(0);
    expect(replies).toEqual(["What was the final score? Tell me both numbers and the team that won."]);
  });

  it("...and untagged it is left alone", () => {
    const { replies } = run(played(), { from: "kemal", body: "yellows won", route: "score", facts: noNumbers({ winner: "yellows" }) });
    expect(replies).toEqual([]);
  });

  // M1. `hasScore: true` with zeros is what a model that ignores the
  // instruction sends for a message with no scoreline. The flag is not
  // trusted: the MESSAGE has to contain two numbers.
  const through = (body: string, wire: Record<string, unknown>, tagged = false) => {
    const { facts } = parseFacts(
      "score",
      JSON.stringify({ firstTeam: "", secondTeam: "", winner: "", loser: "", correction: false, swapped: false, otherGame: false, ...wire }),
      "wa-1",
    );
    return run(played(), { from: "kemal", tagged, body, route: "score", facts });
  };

  it("M1: never 0-0 from a message with no numbers, even when the model says hasScore true and sends zeros", () => {
    for (const body of ["good game lads", "yellows won", "@Match Time what a match"]) {
      const { writes, r } = through(body, { hasScore: true, first: 0, second: 0 });
      expect(writes, body).toHaveLength(0);
      expect(r.nextState.completedMatch).toMatchObject({ redScore: null, yellowScore: null });
    }
  });

  it("M1: nor any other score the text does not contain", () => {
    expect(through("yellows battered them", { hasScore: true, first: 5, second: 0, winner: "yellows" }).writes).toHaveLength(0);
    // One number is not a scoreline.
    expect(through("yellows got 9", { hasScore: true, first: 9, second: 0, winner: "yellows" }).writes).toHaveLength(0);
    // A phone number in a mention is not a score.
    expect(through("@447700900123 @447700900456 good game", { hasScore: true, first: 0, second: 0 }).writes).toHaveLength(0);
  });

  it('M1: a real "0-0" is still a draw', () => {
    const { writes, replies } = through("0-0, dreadful", { hasScore: true, first: 0, second: 0 });
    expect(writes[0]).toMatchObject({ red: 0, yellow: 0 });
    expect(replies).toEqual(["Got it 👍 a draw, Red 0 - 0 Yellow. Recorded."]);
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

  it("a player from the match may correct it too, by tagging the bot", () => {
    const { writes } = run(wrong(), {
      from: "wasim",
      tagged: true,
      body: "@Match Time no it was 9-6 to yellow",
      route: "score",
      facts: score(9, 6, { winner: "yellow", correction: true }),
    });
    expect(writes[0]).toMatchObject({ red: 6, yellow: 9, previous: { red: 9, yellow: 6 } });
  });

  it("H2: WITHOUT a tag a correction changes nothing and says nothing, whoever sends it", () => {
    // "no, reds won 3-1" about Liverpool, from a player, was flagged a
    // correction and overwrote the club's result. A flag from a model is
    // not enough to change a record; the sender has to address the bot.
    for (const from of ["kemal", "wasim", "zair", null]) {
      for (const facts of [
        score(3, 1, { winner: "reds", correction: true }),
        fix,
        noNumbers({ correction: true, swapped: true }),
        noNumbers({ correction: true, winner: "yellows" }),
        score(9, 7, { correction: true }),
      ]) {
        const { writes, asks, replies } = run(wrong(), { from, body: "no, reds won 3-1", route: "score", facts });
        expect(writes).toHaveLength(0);
        expect(asks).toHaveLength(0);
        expect(replies).toEqual([]);
      }
    }
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

  it("a correction that does not say which team is told how to correct it: NO question about a recorded match", () => {
    // It used to ask "9 - 7: which team won?", and a bare "Red" from
    // anybody then overwrote the result (H2, the two-step variant).
    const { writes, asks, replies, r } = run(wrong(), {
      from: "kemal",
      tagged: true,
      body: "@Match Time no it was 9-7",
      route: "score",
      facts: score(9, 7, { correction: true }),
    });
    expect(writes).toHaveLength(0);
    expect(asks).toHaveLength(0);
    expect(replies).toEqual([RECORDED_9_6_HINT]);
    expect(r.nextState.completedMatch?.pendingScore).toBeUndefined();
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

describe('"wrong way round": a tagged correction with no numbers', () => {
  const wrong = (over: Partial<Completed> = {}) => played({ redScore: 9, yellowScore: 6, status: "COMPLETED", ...over });
  const tagged = (body: string, facts: ScoreFacts, from: string | null = "kemal") => ({
    from,
    tagged: true,
    body: `@Match Time ${body}`,
    route: "score" as const,
    facts,
  });

  it('"@Match Time wrong way round, yellows won" swaps the recorded result to Yellow', () => {
    const { writes, replies } = run(
      wrong(),
      tagged("wrong way round, yellows won", noNumbers({ correction: true, swapped: true, winner: "yellows" })),
    );
    expect(writes).toEqual([expect.objectContaining({ red: 6, yellow: 9, previous: { red: 9, yellow: 6 } })]);
    expect(replies).toEqual(["Corrected 👍 It was Red 9 - 6 Yellow. Now *Yellow* won 9 - 6 against Red."]);
  });

  it('"other way round", naming nobody, swaps it', () => {
    const { writes } = run(wrong(), tagged("other way round", noNumbers({ correction: true, swapped: true }), "wasim"));
    expect(writes[0]).toMatchObject({ red: 6, yellow: 9, previous: { red: 9, yellow: 6 } });
  });

  it('"no, yellows won" without the word swapped is the same correction', () => {
    const { writes } = run(wrong(), tagged("no, yellows won", noNumbers({ correction: true, winner: "yellows" })));
    expect(writes[0]).toMatchObject({ red: 6, yellow: 9 });
  });

  it("M4: a question left open never supplies the numbers for a swap", () => {
    const withStale = wrong({
      pendingScore: { first: 12, second: 3, askedAt: new Date(NOW.getTime() - 60_000).toISOString(), askerUserId: "u-kemal" },
    });
    const { writes } = run(withStale, tagged("no, yellows won", noNumbers({ correction: true, winner: "yellows" })));
    expect(writes).toEqual([expect.objectContaining({ red: 6, yellow: 9 })]);
  });

  it('"wrong way round, reds won" when Red is already recorded as the winner changes nothing', () => {
    const { writes, replies, reasons } = run(
      wrong(),
      tagged("wrong way round, reds won", noNumbers({ correction: true, swapped: true, winner: "reds" })),
    );
    expect(writes).toHaveLength(0);
    expect(replies).toEqual([]);
    expect(reasons).toMatch(/same result/);
  });

  it("a numberless correction the bot cannot read is answered with what is recorded and how to correct it", () => {
    for (const facts of [noNumbers({ correction: true }), noNumbers({ correction: true, winner: "Arsenal" })]) {
      const { writes, replies } = run(wrong(), tagged("wrong", facts));
      expect(writes).toHaveLength(0);
      expect(replies).toEqual([RECORDED_9_6_HINT]);
    }
  });

  it("a recorded DRAW cannot be swapped: it is answered, not changed", () => {
    const { writes, replies } = run(
      wrong({ redScore: 7, yellowScore: 7 }),
      tagged("wrong, yellows won", noNumbers({ correction: true, winner: "yellows" })),
    );
    expect(writes).toHaveLength(0);
    expect(replies[0]).toMatch(/^That match is already recorded: a draw, Red 7 - 7 Yellow\. If that is wrong/);
  });

  it("is refused for somebody who may not correct, like any correction", () => {
    const { writes, replies } = run(wrong(), tagged("wrong way round", noNumbers({ correction: true, swapped: true }), "zair"));
    expect(writes).toHaveLength(0);
    expect(replies).toEqual([RECORDED_9_6_ADMIN]);
  });
});

describe("a tag is not a correction, and no tag means no reply (M3)", () => {
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

  it("M3: once a result is recorded, NOTHING untagged gets a reply", () => {
    // Every "already recorded" reply this PR added, sent without a tag.
    const cases: Array<[string | null, ScoreFacts, Partial<Completed>]> = [
      ["kemal", score(9, 2, { winner: "yellows" }), {}], // not a correction
      ["zair", score(9, 6, { winner: "yellow", correction: true }), {}], // may not correct
      [null, score(9, 6, { winner: "yellow", correction: true }), {}], // unidentified
      ["kemal", score(9, 6, { winner: "yellow", correction: true }), { kickoffAt: new Date(NOW.getTime() - 60 * HOURS).toISOString() }], // too late
      ["kemal", noNumbers({ correction: true }), {}], // unreadable correction
      ["kemal", noNumbers({ winner: "yellows" }), {}], // a bare claim
    ];
    for (const [from, facts, over] of cases) {
      const { writes, asks, replies } = run(recorded(over), { from, body: "9-2 to yellows", route: "score", facts });
      expect(writes).toHaveLength(0);
      expect(asks).toHaveLength(0);
      expect(replies).toEqual([]);
    }
  });
});

describe("two matches inside 48 hours", () => {
  const corr = score(9, 6, { winner: "yellow", correction: true });

  it('"@Match Time no it was 9-6 to yellow" is NOT recorded against a newer match that has no result yet', () => {
    // Monday's match is recorded. Tuesday's has just been played and has
    // no result. The correction is about Monday, and the engine only
    // ever holds the latest match.
    const { writes, replies } = run(played({ earlierRecentResult: true, kickoffLabel: "Tue 21:30" }), {
      from: "kemal",
      tagged: true,
      body: "@Match Time no it was 9-6 to yellow",
      route: "score",
      facts: corr,
    });
    expect(writes).toHaveLength(0);
    expect(replies).toEqual([
      "I can't tell which match that corrects. For Tue 21:30, just tell me the score and the team that won. An admin can change an earlier result on its match page.",
    ]);
  });

  it("M3: untagged, the same message is not recorded and gets no reply", () => {
    const { writes, replies } = run(played({ earlierRecentResult: true }), {
      from: "kemal",
      body: "no it was 9-6 to yellow",
      route: "score",
      facts: corr,
    });
    expect(writes).toHaveLength(0);
    expect(replies).toEqual([]);
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

  it('with no other recent result, "no it was 10-7 to red" on an unscored match is simply its result', () => {
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
