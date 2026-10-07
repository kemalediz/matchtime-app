/**
 * THE THIRD REVIEW OF PR #214 (head aacbb3d), as permanent tests.
 *
 * Each `it` below is a sequence the reviewer ran in a probe script and
 * got a wrong result from. They are kept together, in the reviewer's
 * own words where possible, so the next person to touch `handleScore`
 * can see the four ways the narrow rules were still too wide:
 *
 *   1. any two numbers in the text passed for a scoreline;
 *   2. a qualified sender's CHATTER completed the open question;
 *   3. a bare "wrong way round" flipped the result back and forth;
 *   4. two scorelines in one batch asked two questions.
 */
import { describe, it, expect } from "vitest";
import { decide } from "../engine";
import { compose } from "../compose";
import type { ScoreFacts, SquadState } from "../types";
import { NOW, msg, world, type MsgOpts } from "./helpers";

const HOURS = 60 * 60 * 1000;
const TEAMS = [
  ...["kemal", "elvin", "sait"].map((k) => ({ userId: `u-${k}`, team: "RED" as const })),
  ...["mustafa", "najib", "wasim"].map((k) => ({ userId: `u-${k}`, team: "YELLOW" as const })),
];
type Completed = NonNullable<SquadState["completedMatch"]>;
const played = (over: Partial<Completed> = {}): SquadState =>
  world({
    admins: ["kemal"],
    completedMatch: {
      id: "done-1",
      participantUserIds: TEAMS.map((t) => t.userId),
      teams: TEAMS,
      kickoffAt: new Date(NOW.getTime() - 2 * HOURS).toISOString(),
      ...over,
    },
  });
const rec = (over: Partial<Completed> = {}) => played({ redScore: 9, yellowScore: 6, status: "COMPLETED", ...over });
const pend = (minsAgo: number, asker: string | null = "u-elvin", over: Partial<Completed> = {}) =>
  played({
    pendingScore: {
      first: 10,
      second: 7,
      askedAt: new Date(NOW.getTime() - minsAgo * 60_000).toISOString(),
      askerUserId: asker,
    },
    ...over,
  });
const S = (first: number | null, second: number | null, over: Partial<ScoreFacts> = {}): ScoreFacts => ({
  kind: "score",
  first,
  second,
  ...over,
});

function run(state: SquadState, ...messages: Array<Omit<MsgOpts, "route">>) {
  const r = decide({ now: NOW, state, messages: messages.map((m) => msg({ ...m, route: "score" })) });
  return {
    r,
    scores: r.writes.filter((w) => w.kind === "score"),
    asks: r.writes.filter((w) => w.kind === "score_ask"),
    replies: compose(r).utterances.map((u) => u.text),
  };
}
const HINT_9_6 =
  'That match is already recorded: *Red* won 9 - 6 against Yellow. If that is wrong, tell me "no, it was" with the right score and the team that won.';

describe("1. the extractor's two numbers must BE in the text, each as its own number", () => {
  it('M1a: "good game lads, same time next week 21:30" with zeros is not 0-0', () => {
    const { scores, asks, replies } = run(played(), {
      from: "elvin",
      body: "good game lads, same time next week 21:30",
      facts: S(0, 0),
    });
    expect(scores).toEqual([]);
    expect(asks).toEqual([]);
    expect(replies).toEqual([]);
  });

  it('M1b: "great 7 a side tonight, 14 turned up" with zeros is not 0-0', () => {
    expect(run(played(), { from: "elvin", body: "great 7 a side tonight, 14 turned up", facts: S(0, 0) }).scores).toEqual([]);
  });

  it('M1c: "see you at 21:30" with 3-3 from the model is not 3-3', () => {
    expect(run(played(), { from: "elvin", body: "see you at 21:30", facts: S(3, 3) }).scores).toEqual([]);
  });

  it("M1d: a tagged admin \"that's wrong, look again at 21:30\" with zeros and a correction flag does NOT overwrite 9-6 with 0-0", () => {
    const { scores, replies, r } = run(rec(), {
      from: "kemal",
      tagged: true,
      body: "@Match Time that's wrong, look again at 21:30",
      facts: S(0, 0, { correction: true }),
    });
    expect(scores).toEqual([]);
    expect(r.nextState.completedMatch).toMatchObject({ redScore: 9, yellowScore: 6 });
    // A correction the bot could not read: told how to say it.
    expect(replies).toEqual([HINT_9_6]);
  });

  it('"3-3" needs two threes: "we had 3 subs" with 3-3 is not a draw', () => {
    expect(run(played(), { from: "elvin", body: "we had 3 subs", facts: S(3, 3) }).scores).toEqual([]);
  });

  it("one of the two numbers in the text is not enough", () => {
    expect(run(played(), { from: "elvin", body: "9 of us and a great game", facts: S(9, 6, { winner: "yellows" }) }).scores).toEqual([]);
  });

  it.each([
    ["5-3 to Yellows", S(5, 3, { winner: "Yellows" }), { red: 3, yellow: 5 }],
    ["final score was 8 8", S(8, 8), { red: 8, yellow: 8 }],
    ["9:6 sarı kazandı", S(9, 6, { winner: "sarı" }), { red: 6, yellow: 9 }],
    ["5 3 to reds", S(5, 3, { winner: "reds" }), { red: 5, yellow: 3 }],
    ["5/3 reds won", S(5, 3, { winner: "reds" }), { red: 5, yellow: 3 }],
    ["0-0, dreadful", S(0, 0), { red: 0, yellow: 0 }],
    ["3-3", S(3, 3), { red: 3, yellow: 3 }],
    [
      "it was 6-6 until 15 minutes then suddenly it turned to 9-6 to yellows",
      S(9, 6, { winner: "yellows" }),
      { red: 6, yellow: 9 },
    ],
    ["@447700900123 it finished 10 - 7 to red", S(10, 7, { winner: "red" }), { red: 10, yellow: 7 }],
  ] as const)("a real result still records: %s", (body, facts, want) => {
    expect(run(played(), { from: "kemal", body, facts }).scores).toEqual([expect.objectContaining(want)]);
  });

  it('"10 - 7" with no team still asks', () => {
    const { asks } = run(played(), { from: "kemal", body: "10 - 7", facts: S(10, 7) });
    expect(asks).toEqual([expect.objectContaining({ first: 10, second: 7 })]);
  });
});

describe("2. only a BARE team answer completes the open question", () => {
  it("M2i: the asker's untagged chatter that happens to name a winner records nothing", () => {
    const { scores, replies } = run(pend(5), {
      from: "elvin",
      body: "yellow bibs stink mate, whoever takes them home wash them. reds deserved it anyway",
      facts: S(null, null, { winner: "reds" }),
    });
    expect(scores).toEqual([]);
    expect(replies).toEqual([]);
  });

  it("M2j: nor an admin's, twenty minutes later", () => {
    const { scores } = run(pend(20), {
      from: "kemal",
      body: "honestly yellows always win when Najib plays",
      facts: S(null, null, { winner: "yellows" }),
    });
    expect(scores).toEqual([]);
  });

  it("M2k: nor a TAGGED message about something else that mentions who won", () => {
    const { scores } = run(pend(110), {
      from: "wasim",
      tagged: true,
      body: "@Match Time can you put me on yellow next week, reds won again",
      facts: S(null, null, { winner: "reds" }),
    });
    expect(scores).toEqual([]);
  });

  it("the side comes from the TEXT, not from what the model said won", () => {
    // The body says Yellow. A model that reports "reds" is ignored.
    const { scores } = run(pend(5), { from: "elvin", body: "Yellow", facts: S(null, null, { winner: "reds" }) });
    expect(scores).toEqual([expect.objectContaining({ red: 7, yellow: 10 })]);
    // And with no winner in the facts at all, the text is still enough.
    expect(run(pend(5), { from: "elvin", body: "reds won", facts: S(null, null) }).scores).toEqual([
      expect.objectContaining({ red: 10, yellow: 7 }),
    ]);
  });

  it('"us" is not a team name in the text, so it completes nothing', () => {
    expect(run(pend(5), { from: "elvin", body: "us", facts: S(null, null, { winner: "us" }) }).scores).toEqual([]);
  });

  it('M2l / M2m: restating the SAME pair with one team is an answer: "Yellow 10-7", "Yellow 7-10", "10-7 yellow"', () => {
    for (const [body, facts] of [
      ["Yellow 10-7", S(10, 7, { firstTeam: "Yellow" })],
      ["Yellow 7-10", S(7, 10, { firstTeam: "Yellow" })],
      ["10-7 yellow", S(10, 7, { secondTeam: "yellow" })],
      ["7 - 10 yellows", S(7, 10, { secondTeam: "yellows" })],
    ] as const) {
      const { scores, asks, replies } = run(pend(5), { from: "elvin", body, facts });
      expect(scores, body).toEqual([expect.objectContaining({ red: 7, yellow: 10 })]);
      expect(asks).toEqual([]);
      expect(replies).toEqual(["Got it 👍 *Yellow* won 10 - 7 against Red. Recorded."]);
    }
  });

  it("...but only from somebody who could have answered with the bare name", () => {
    // Another player, untagged: still "already asked", still silent.
    const other = run(pend(5), { from: "sait", body: "Yellow 7-10", facts: S(7, 10, { firstTeam: "Yellow" }) });
    expect(other.scores).toEqual([]);
    expect(other.replies).toEqual([]);
    // The asker, after thirty minutes, untagged.
    expect(run(pend(31), { from: "elvin", body: "Yellow 7-10", facts: S(7, 10, { firstTeam: "Yellow" }) }).scores).toEqual([]);
    // Tagged, anybody who may report.
    expect(
      run(pend(31), { from: "sait", tagged: true, body: "@Match Time Yellow 7-10", facts: S(7, 10, { firstTeam: "Yellow" }) }).scores,
    ).toEqual([expect.objectContaining({ red: 7, yellow: 10 })]);
  });

  it("...and only for the pair that was asked about, with nothing else in the message", () => {
    // A different pair is a different scoreline: asked about afresh.
    const diff = run(pend(5), { from: "elvin", body: "Yellow 7-9", facts: S(7, 9, { firstTeam: "Yellow" }) });
    expect(diff.scores).toEqual([]);
    expect(diff.asks).toEqual([expect.objectContaining({ first: 7, second: 9 })]);
    // The same pair inside a sentence is not a bare answer.
    const chat = run(pend(5), {
      from: "elvin",
      body: "yellow were 7-10 down at one point you know",
      facts: S(7, 10, { firstTeam: "yellow" }),
    });
    expect(chat.scores).toEqual([]);
    // Both teams named decides it the ordinary way, whoever sends it.
    expect(
      run(pend(5), { from: "sait", body: "Yellow 7 Red 10", facts: S(7, 10, { firstTeam: "Yellow", secondTeam: "Red" }) }).scores,
    ).toEqual([expect.objectContaining({ red: 10, yellow: 7 })]);
  });
});

describe('3. a bare "wrong way round" is honoured ONCE per match', () => {
  const swap = (from: string) => ({
    from,
    tagged: true,
    body: "@Match Time wrong way round",
    facts: S(null, null, { correction: true, swapped: true }),
  });

  it("H2j: two of them in one batch swap the result once, with one 'Corrected'", () => {
    const { scores, replies, r } = run(rec(), swap("kemal"), swap("mustafa"));
    expect(scores).toEqual([expect.objectContaining({ red: 6, yellow: 9, previous: { red: 9, yellow: 6 }, bareSwap: true })]);
    expect(r.nextState.completedMatch).toMatchObject({ redScore: 6, yellowScore: 9, swapUsed: true });
    expect(replies).toEqual([
      "Corrected 👍 It was Red 9 - 6 Yellow. Now *Yellow* won 9 - 6 against Red.",
      'That match is already recorded: *Yellow* won 9 - 6 against Red. If that is wrong, tell me "no, it was" with the right score and the team that won.',
    ]);
  });

  it("a second player repeating it LATER changes nothing and is told how to correct it", () => {
    const swappedAlready = rec({ redScore: 6, yellowScore: 9, swapUsed: true });
    const { scores, replies } = run(swappedAlready, swap("mustafa"));
    expect(scores).toEqual([]);
    expect(replies).toEqual([
      'That match is already recorded: *Yellow* won 9 - 6 against Red. If that is wrong, tell me "no, it was" with the right score and the team that won.',
    ]);
  });

  it("a correction that SAYS who won is not a toggle, and is not used up by one", () => {
    const named = {
      from: "kemal",
      tagged: true,
      body: "@Match Time wrong way round, yellows won",
      facts: S(null, null, { correction: true, swapped: true, winner: "yellows" }),
    };
    // After a bare swap has been used, naming the winner still works...
    const after = run(rec({ swapUsed: true }), named);
    expect(after.scores).toEqual([expect.objectContaining({ red: 6, yellow: 9 })]);
    expect(after.scores[0]).not.toHaveProperty("bareSwap");
    // ...and saying it twice is naturally idempotent.
    const twice = run(rec(), named, { ...named, from: "wasim" });
    expect(twice.scores).toHaveLength(1);
    expect(twice.replies).toHaveLength(1);
  });

  it("within one batch, two DIFFERENT corrections collapse to the first that changes anything", () => {
    const { scores, replies } = run(
      rec(),
      { from: "kemal", tagged: true, body: "@Match Time no it was 9-7 to red", facts: S(9, 7, { winner: "red", correction: true }) },
      { from: "wasim", tagged: true, body: "@Match Time no it was 9-8 to red", facts: S(9, 8, { winner: "red", correction: true }) },
    );
    expect(scores).toEqual([expect.objectContaining({ red: 9, yellow: 7, previous: { red: 9, yellow: 6 } })]);
    expect(replies).toEqual([
      "Corrected 👍 It was Red 9 - 6 Yellow. Now *Red* won 9 - 7 against Yellow.",
      'That match is already recorded: *Red* won 9 - 7 against Yellow. If that is wrong, tell me "no, it was" with the right score and the team that won.',
    ]);
  });

  it("a first result and ONE correction of it in the same batch still both land", () => {
    const { scores } = run(
      played(),
      { from: "kemal", body: "9-6 to reds", facts: S(9, 6, { winner: "reds" }) },
      { from: "kemal", tagged: true, body: "@Match Time no Yellow 9 - 6 Red", facts: S(9, 6, { firstTeam: "Yellow", secondTeam: "Red", correction: true }) },
    );
    expect(scores).toHaveLength(2);
  });
});

describe("4. one question per match per batch", () => {
  it('H1b: "10-7" then "9-7" in one batch asks ONCE, about the last scoreline', () => {
    const { asks, replies, r } = run(
      played(),
      { from: "kemal", body: "10-7", facts: S(10, 7) },
      { from: "elvin", body: "9-7", facts: S(9, 7) },
    );
    expect(asks).toEqual([expect.objectContaining({ first: 9, second: 7, askerUserId: "u-elvin" })]);
    expect(replies).toEqual(["9 - 7: which team won? Reply with the winning team: Red or Yellow."]);
    expect(r.nextState.completedMatch?.pendingScore).toMatchObject({ first: 9, second: 7 });
  });

  it("the 2 June shape: three people, three scorelines, one question", () => {
    const { asks, replies } = run(
      played(),
      { from: "sait", body: "10-6", facts: S(10, 6) },
      { from: "kemal", body: "10-7 :))", facts: S(10, 7) },
      { from: "elvin", body: "10-7", facts: S(10, 7) },
    );
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ first: 10, second: 7 });
    expect(replies).toHaveLength(1);
  });

  it("a question already open from an earlier batch is replaced by one question, not two", () => {
    const { asks, replies } = run(
      pend(5),
      { from: "kemal", body: "9-7", facts: S(9, 7) },
      { from: "sait", body: "9-8", facts: S(9, 8) },
    );
    expect(asks).toEqual([expect.objectContaining({ first: 9, second: 8 })]);
    expect(replies).toHaveLength(1);
  });
});
