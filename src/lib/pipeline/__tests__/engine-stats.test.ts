/**
 * The engine and the composer on a `stats` question with a TABLE
 * (2026-09-23). The model classifies; these decide and render.
 */
import { describe, expect, it } from "vitest";
import { decide } from "../engine";
import { compose } from "../compose";
import { NOW, member, msg, world } from "./helpers";
import type { QuestionFacts, SquadState, StatsSnapshot } from "../types";

const SNAP: StatsSnapshot = {
  fullTableUrl: "https://matchtime.ai/profile/stats",
  ratings: [
    { userId: "u-mustafa", name: "Mustafa Kaya", avg: 8.1, games: 9, rank: 1, delta: 0 },
    { userId: "u-habib", name: "Habib Rahman", avg: 7.6, games: 5, rank: 2, delta: 3 },
  ],
  mom: [{ userId: "u-sait", name: "Sait Demir", wins: 3 }],
  elo: [{ userId: "u-kemal", name: "Kemal Ediz", rating: 1042, matches: 12 }],
  teamOfSeason: null,
  mrReliable: [],
  aliases: [{ alias: "abi", userId: "u-abid" }],
  chemistry: {
    "u-idris": {
      userId: "u-idris",
      name: "Idris Bello",
      bestByWinRate: { name: "Kemal Ediz", gamesTogether: 7, wins: 5, winRate: 5 / 7 },
      bestByRating: null,
      nemesis: { name: "Zeeshan Khan", gamesAgainst: 5, wins: 1 },
    },
  },
  generic: { "wa-gen": { text: "Mustafa Kaya leads on 8.1." }, "wa-bad": { rejected: "number 9.9 is not in the tables" } },
};

const stats = (over: Partial<QuestionFacts>): QuestionFacts => ({
  kind: "question",
  topic: "stats",
  personRef: null,
  statedCount: null,
  table: null,
  listSize: null,
  listEnd: "top",
  ...over,
});

function run(facts: QuestionFacts, opts: { id?: string; from?: string | null; state?: Partial<SquadState> } = {}) {
  const id = opts.id ?? "wa-q";
  const state: SquadState = {
    ...world({
      confirmed: ["kemal"],
      appearances: [
        { userId: "u-kemal", matches: 4 },
        { userId: "u-elvin", matches: 3 },
        { userId: "u-sait", matches: 2 },
        { userId: "u-abid", matches: 1 },
      ],
    }),
    stats: SNAP,
    ...opts.state,
  };
  const r = decide({
    now: NOW,
    state,
    messages: [msg({ id, from: opts.from === undefined ? "kemal" : opts.from, tagged: true, route: "question", facts })],
  });
  const out = compose(r);
  return {
    r,
    outcome: r.outcomes.find((o) => o.messageId === id)!,
    text: out.utterances.filter((u) => u.messageId === id).map((u) => u.text).join("\n\n"),
  };
}

describe("the incident, end to end through the engine and composer", () => {
  it("'leaderboard of ratings, top 10' is the ratings table, not appearances", () => {
    const { text } = run(stats({ table: "ratings", listSize: 10 }));
    expect(text).toContain("club ratings");
    expect(text).toContain("1. Mustafa Kaya: 8.1 (9 matches)");
    expect(text).not.toContain("appearances");
  });
});

describe("what did not change", () => {
  it("a stats question with no table is still the appearances top three, byte for byte", () => {
    const { text } = run(stats({ table: null }));
    expect(text).toBe(
      "Most appearances in the last 30 days:\n1. Kemal Ediz — 4 matches\n2. Elvin Aliyev — 3 matches\n3. Sait Demir — 2 matches",
    );
  });
  it("an appearances question with a size serves that many", () => {
    const { text } = run(stats({ table: "appearances", listSize: 4 }));
    expect(text.split("\n")).toHaveLength(5);
  });
  it("stats Q&A switched off still answers nothing", () => {
    const { text, outcome } = run(stats({ table: "ratings" }), {
      state: { features: { ...world().features, statsQa: false } },
    });
    expect(text).toBe("");
    expect(outcome.disposition).toBe("noop");
  });
});

describe("bottom and over-cap", () => {
  it("'who's the worst' names nobody and links the site", () => {
    const { text } = run(stats({ table: "ratings", listEnd: "bottom" }));
    expect(text).toContain("https://matchtime.ai/profile/stats");
    expect(text).not.toMatch(/Mustafa|Habib/);
  });
  it("'top 20' is served as ten, and says so", () => {
    const { r } = run(stats({ table: "ratings", listSize: 20 }));
    expect(r.speech).toContainEqual(expect.objectContaining({ kind: "answer_stats_table", size: 10, requested: 20 }));
  });
});

describe("asking instead of guessing", () => {
  it("an unknown name asks the poster, by name, and flags the outcome", () => {
    const { text, outcome } = run(stats({ table: "chemistry", personRef: "Zork" }));
    expect(text).toBe("Kemal, I don't have a Zork in the squad. Who do you mean?");
    expect(outcome.statsClarificationAsked).toBe(true);
  });
  it("an ambiguous name names the candidates", () => {
    const players = world().roster.concat(member("idris2", { name: "Idris Musa" }));
    const { text } = run(stats({ table: "chemistry", personRef: "Idris" }), { state: { roster: players } });
    expect(text).toBe("Kemal, do you mean Idris Bello or Idris Musa?");
  });
  it("one clear name answers directly, with no question", () => {
    const { text, outcome } = run(stats({ table: "chemistry", personRef: "Idris" }));
    expect(text).toContain("Idris Bello's best team-mates:");
    expect(outcome.statsClarificationAsked ?? false).toBe(false);
  });
  it("an admin alias resolves without asking", () => {
    const { r } = run(stats({ table: "ratings", personRef: "Abi" }), { id: "wa-gen" });
    expect(r.speech).toContainEqual(expect.objectContaining({ kind: "answer_stats_generic" }));
  });
});

describe("the generic path", () => {
  it("a grounded answer is said as written", () => {
    expect(run(stats({ table: "other" }), { id: "wa-gen" }).text).toBe("Mustafa Kaya leads on 8.1.");
  });
  it("a rejected answer is replaced by the safe line, and never asks the user about it", () => {
    const { text } = run(stats({ table: "other" }), { id: "wa-bad" });
    expect(text).toContain("https://matchtime.ai/profile/stats");
    expect(text).not.toContain("9.9");
    expect(text).not.toMatch(/\?/);
  });
  it("not loaded says nothing, so the batch disowns it with a receipt", () => {
    const { text, r } = run(stats({ table: "ratings" }), { state: { stats: null } });
    expect(text).toBe("");
    expect(compose(r).operatorNotes.join(" ")).toMatch(/no stats snapshot/);
  });
});
