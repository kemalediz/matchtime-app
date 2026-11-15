/**
 * THE SQUAD-COPY GUARD (`reproducesSquad`, review of #595, 2026-11-15).
 *
 * In a club whose organisers post the list, the players' group's unified
 * answer is exempt from the organisers-list net and relies on this check.
 * Before this fix it returned false as soon as the reply named anyone
 * outside the squad and the bench, never counted the bench, and needed two
 * thirds of the squad. So a copy of the squad plus one more name, a copy of
 * the bench, and half the squad all went to the group.
 *
 * The rule now: a member the reply names is explained by a stats table the
 * players' group is shown when the reply names at least two of its entries
 * and at least two thirds of that table from its top down to the deepest
 * entry it names (a "top 10" answer, a
 * "last 3 Man of the Match" answer). Of the members left, the squad players
 * are a copy from a third of the squad (at least 3, or the whole squad when it
 * is smaller), and the bench players from two thirds of the bench (at least
 * 2). Made-up people only.
 */
import { describe, expect, it } from "vitest";
import { answerUnified, reproducesSquad, tablesShownToPlayers } from "../unified-answer";
import type { PipelineModel } from "../llm";
import { NOW } from "./helpers";
import type { Member, SquadState, StatsSnapshot } from "../types";
import { world } from "./helpers";

const SQUAD = ["Alfie Brook", "Bruno Carr", "Cosmo Dale", "Dario Ewing", "Ezra Finch", "Felix Grant", "Gideon Hale", "Hector Irwin", "Ivo Jarvis", "Jasper Knox", "Kit Lowe", "Leon Marsh"];
const BENCH = ["Milo North", "Nico Oakes", "Otto Pryce"];
const OUTSIDE = ["Pablo Quinn", "Quentin Rhodes", "Rufus Stone", "Silas Thorne", "Tobias Upton", "Ulric Vance", "Xavier Wren"];
const ALL = [...SQUAD, ...BENCH, ...OUTSIDE];
const id = (name: string) => `u-${name.split(" ")[0].toLowerCase()}`;

function state(): SquadState {
  const base = world({ players: [] });
  const roster: Member[] = ALL.map((name) => ({ userId: id(name), name, isAdmin: false, hasPhone: true }));
  let pos = 0;
  const rows: SquadState["rows"] = [
    ...SQUAD.map((n) => ({ userId: id(n), status: "CONFIRMED" as const, position: ++pos })),
    ...BENCH.map((n) => ({ userId: id(n), status: "BENCH" as const, position: ++pos })),
    { userId: id("Xavier Wren"), status: "DROPPED", position: ++pos },
  ];
  return { ...base, roster, rows, maxPlayers: 14, features: { ...base.features, listAnnouncer: "organisers" } };
}

// The ratings table's top 10: 5 from the squad, 1 from the bench, 4 from outside.
const TOP10 = ["Alfie Brook", "Pablo Quinn", "Bruno Carr", "Milo North", "Quentin Rhodes", "Cosmo Dale", "Rufus Stone", "Dario Ewing", "Silas Thorne", "Ezra Finch"];
const STATS: StatsSnapshot = {
  fullTableUrl: "https://matchtime.ai/profile/stats",
  ratings: TOP10.map((name, i) => ({ userId: id(name), name, avg: 8 - i * 0.1, games: 5, rank: i + 1, delta: 0 })),
  mom: [{ userId: id("Leon Marsh"), name: "Leon Marsh", wins: 3 }],
  elo: [],
  teamOfSeason: null,
  mrReliable: [],
  aliases: [],
  chemistry: {},
  appearances: [],
  recordsStart: { matches: null, mom: null },
  generic: {},
  periods: {},
};
const tables = tablesShownToPlayers(STATS, []);
const copies = (reply: string) => reproducesSquad(reply, state(), tables);

describe("reproducesSquad: list copies are caught", () => {
  it("the whole squad plus one name from outside it ('... Xavier is out')", () => {
    expect(copies(`In: ${SQUAD.join(", ")}. Xavier Wren is out.`)).toBe(true);
  });

  it("a copy of the bench", () => {
    expect(copies(`On the bench: ${BENCH.join(", ")}.`)).toBe(true);
  });

  it("half the squad", () => {
    expect(copies(`So far: ${SQUAD.slice(0, 6).join(", ")}.`)).toBe(true);
  });

  it("a small squad named in full (3 of 3)", () => {
    const st = state();
    const small = { ...st, rows: st.rows.filter((r) => ["u-alfie", "u-bruno", "u-cosmo"].includes(r.userId)) };
    expect(reproducesSquad("In: Alfie Brook, Bruno Carr and Cosmo Dale.", small, tables)).toBe(true);
  });
});

describe("reproducesSquad: legitimate answers pass", () => {
  it("the ratings table's top 10, players inside and outside the squad", () => {
    const table = TOP10.map((n, i) => `${i + 1}. ${n} ${(8 - i * 0.1).toFixed(1)}`).join("\n");
    expect(copies(`Top 10 ratings:\n${table}`)).toBe(false);
  });

  it("a count", () => {
    expect(copies("12 in, 2 places left, and 3 on the bench.")).toBe(false);
  });

  it("a short answer naming one player", () => {
    expect(copies("Alfie Brook has the most Man of the Match wins this year.")).toBe(false);
  });

  it("a short answer naming two players (one in the squad, one not)", () => {
    expect(copies("Gideon Hale and Tobias Upton are the admins to ask.")).toBe(false);
  });

  it("a short answer naming two squad players", () => {
    expect(copies("Gideon Hale and Hector Irwin said they would bring the bibs.")).toBe(false);
  });

  it("nobody named at all", () => {
    expect(copies("The organisers will post the list.")).toBe(false);
  });
});

describe("tablesShownToPlayers: the tables the players' group sees, each its shown top", () => {
  it("the ratings table is cut to the top the group is shown", () => {
    const many: StatsSnapshot = { ...STATS, ratings: ALL.map((name, i) => ({ userId: id(name), name, avg: 9 - i * 0.1, games: 5, rank: i + 1, delta: 0 })) };
    const [ratings] = tablesShownToPlayers(many, []);
    expect(ratings).toHaveLength(10);
    expect(ratings[0]).toBe(id(ALL[0]));
  });

  it("no stats: no tables", () => {
    expect(tablesShownToPlayers(null, [])).toEqual([]);
  });
});

describe("answerUnified hands the group's tables to the guard", () => {
  const model = (answer: string): PipelineModel => ({
    name: "stub",
    complete: async () => ({ text: JSON.stringify({ answer }), stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 1 }),
  });
  const run = (answer: string) =>
    answerUnified({
      model: model(answer),
      audience: "players",
      state: state(),
      squadKnown: true,
      stats: STATS,
      history: [],
      lastBotPost: null,
      reply: null,
      now: NOW,
      question: "@Match Time question",
      askerUserId: id("Tobias Upton"),
      askerName: "Tobias Upton",
    });

  it("the top 10 ratings stand", async () => {
    const table = TOP10.map((n, i) => `${i + 1}. ${n} ${(8 - i * 0.1).toFixed(1)}`).join("\n");
    expect((await run(table)).result).toEqual({ text: table });
  });

  it("a copy of the bench becomes the organisers' line", async () => {
    expect((await run(`On the bench: ${BENCH.join(", ")}.`)).result).toEqual({ text: "The organisers will post the list." });
  });
});
