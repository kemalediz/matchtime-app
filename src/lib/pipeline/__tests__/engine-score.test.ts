/**
 * THE SCORE ROUTE: WHOSE NUMBER IS WHOSE, AND CHANGING A RECORDED RESULT
 * (2026-10-07).
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
import type { ScoreFacts, SquadState } from "../types";
import { NOW, msg, world } from "./helpers";

const RED_SIDE = ["kemal", "elvin", "sait"];
const YELLOW_SIDE = ["mustafa", "najib", "wasim"];
const TEAMS = [
  ...RED_SIDE.map((k) => ({ userId: `u-${k}`, team: "RED" as const })),
  ...YELLOW_SIDE.map((k) => ({ userId: `u-${k}`, team: "YELLOW" as const })),
];
const HOURS = 60 * 60 * 1000;

function played(over: Partial<NonNullable<SquadState["completedMatch"]>> = {}): SquadState {
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

function run(state: SquadState, ...messages: Parameters<typeof msg>[0][]) {
  const r = decide({ now: NOW, state, messages: messages.map((m) => msg(m)) });
  const out = compose(r);
  return {
    r,
    writes: r.writes.filter((w) => w.kind === "score"),
    replies: out.utterances.map((u) => u.text),
    reasons: r.outcomes.map((o) => o.reasons.join("; ")).join(" | "),
  };
}

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
    const { writes, replies } = run(played(), {
      from: "kemal",
      body: "7-7",
      route: "score",
      facts: score(7, 7),
    });
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
  it('"10-7" records nothing and asks which team', () => {
    const { writes, replies, r } = run(played(), {
      from: "kemal",
      body: "10-7 :))",
      route: "score",
      facts: score(10, 7),
    });
    expect(writes).toHaveLength(0);
    expect(r.nextState.completedMatch).toMatchObject({ redScore: null, yellowScore: null });
    expect(replies).toEqual([
      '10 - 7 to which team, Red or Yellow? Tell me like this: "10 - 7 to Yellow".',
    ]);
  });

  it('"we won 5-3" from somebody who was on neither side asks too', () => {
    const { writes, replies } = run(played(), {
      from: null,
      body: "we won 5-3",
      route: "score",
      facts: score(5, 3, { winner: "us" }),
    });
    expect(writes).toHaveLength(0);
    expect(replies[0]).toMatch(/^5 - 3 to which team, Red or Yellow\?/);
  });

  it("a member who may not report a result is still told nothing", () => {
    const { writes, replies } = run(played(), {
      from: "zair",
      body: "10-7",
      route: "score",
      facts: score(10, 7),
    });
    expect(writes).toHaveLength(0);
    expect(replies).toEqual([]);
  });
});

describe("the incident, message 2: correcting a recorded result", () => {
  const wrong = () => played({ redScore: 9, yellowScore: 6, status: "COMPLETED" });
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
    expect(replies).toEqual([
      "Corrected 👍 It was Red 9 - 6 Yellow. Now *Yellow* won 9 - 6 against Red.",
    ]);
  });

  it("a player from the match may correct it too", () => {
    const { writes } = run(wrong(), {
      from: "wasim",
      tagged: true,
      body: "@Match Time it was 9-6 to yellow",
      route: "score",
      facts: score(9, 6, { winner: "yellow" }),
    });
    expect(writes[0]).toMatchObject({ red: 6, yellow: 9, previous: { red: 9, yellow: 6 } });
  });

  it("an explicit correction needs no tag", () => {
    const { writes } = run(wrong(), {
      from: "kemal",
      body: "no, Yellow 9 - 6 Red",
      route: "score",
      facts: fix,
    });
    expect(writes).toHaveLength(1);
  });

  it("a later score message that is neither tagged nor a correction changes nothing and says nothing", () => {
    // Why the overwrite guard exists: anything the router calls `score`
    // after the result is in ("remember when we lost 9-2").
    const { writes, replies, reasons } = run(wrong(), {
      from: "kemal",
      body: "9-2 to yellows last month, that was worse",
      route: "score",
      facts: score(9, 2, { winner: "yellows" }),
    });
    expect(writes).toHaveLength(0);
    expect(replies).toEqual([]);
    expect(reasons).toMatch(/already recorded 9-6/);
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
      body: "@Match Time it was 9-6 to yellow",
      route: "score",
      facts: score(9, 6, { winner: "yellow" }),
    });
    expect(writes).toHaveLength(0);
    expect(replies).toEqual([
      "That match is already recorded: *Red* won 9 - 6 against Yellow. An admin can change it on the match page.",
    ]);
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
    expect(replies[0]).toMatch(/already recorded/);
  });

  it("after the window even an admin is pointed at the match page", () => {
    const old = played({
      redScore: 9,
      yellowScore: 6,
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
    expect(replies[0]).toMatch(/already recorded.*match page/);
  });

  it("the window is 48 hours from kickoff", () => {
    expect(SCORE_CORRECTION_WINDOW_MS).toBe(48 * HOURS);
  });

  it("a correction that does not say which team is asked, not applied", () => {
    const { writes, replies } = run(wrong(), {
      from: "kemal",
      tagged: true,
      body: "@Match Time no it was 9-7",
      route: "score",
      facts: score(9, 7, { correction: true }),
    });
    expect(writes).toHaveLength(0);
    expect(replies[0]).toMatch(/^9 - 7 to which team/);
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

describe("Turkish", () => {
  const tr = (over: Partial<NonNullable<SquadState["completedMatch"]>> = {}) => {
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

  it("asks in Turkish", () => {
    const { replies } = run(tr(), { from: "kemal", body: "10-7", route: "score", facts: score(10, 7) });
    expect(replies).toEqual([
      '10 - 7 hangi takımın lehine, Kırmızı mı Sarı mı? Şöyle yazın: "Sarı 10 - 7 kazandı".',
    ]);
  });
});
