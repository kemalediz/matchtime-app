/**
 * THE SCORE BATCH AND THE CLUB'S NAMES FOR ITS SIDES (2026-11-17, Vets).
 *
 * "@Match Time bibs 9, no bibs 4", the night the sides were only "Red"
 * and "Yellow" in MatchTime's data: one question, the answer records the
 * result and is remembered, and the next week the same words record
 * straight away. Run end to end through the real batch, parser, engine
 * and composer, with a stubbed model and a recording apply layer. Every
 * name is made up.
 */
import { describe, it, expect } from "vitest";
import type { ModelRequest, ModelResponse, PipelineModel } from "../pipeline/llm";
import type { SquadState } from "../pipeline/types";
import { NOW, world } from "../pipeline/__tests__/helpers";
import { runScoreBatch, type ScoreBatchDeps, type ScoreBatchMessage } from "../score-engine-batch";

const PLAYERS = ["ava", "ben", "cal", "dan"];

function played(over: Partial<NonNullable<SquadState["completedMatch"]>> = {}): SquadState {
  return world({
    players: PLAYERS,
    admins: ["ava"],
    completedMatch: {
      id: "game-1",
      participantUserIds: PLAYERS.map((k) => `u-${k}`),
      status: "TEAMS_PUBLISHED",
      teams: [
        { userId: "u-ava", team: "RED" },
        { userId: "u-ben", team: "RED" },
        { userId: "u-cal", team: "YELLOW" },
        { userId: "u-dan", team: "YELLOW" },
      ],
      teamLabels: ["Red", "Yellow"],
      ...over,
    },
  });
}

const score = (o: Record<string, unknown>) => ({
  hasScore: true,
  first: 0,
  second: 0,
  firstTeam: "",
  secondTeam: "",
  winner: "",
  loser: "",
  teamSides: [],
  momRef: "",
  correction: false,
  swapped: false,
  otherGame: false,
  ...o,
});

function stub(table: Record<string, unknown>) {
  const turns: string[] = [];
  const model: PipelineModel = {
    name: "stub",
    async complete(req: ModelRequest): Promise<ModelResponse> {
      turns.push(req.user);
      const body = req.user.split("\n").slice(-1)[0];
      const payload = table[body];
      if (payload === undefined) throw new Error(`no stub for "${body}"`);
      return {
        text: JSON.stringify(payload),
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
        ms: 0,
      };
    },
  };
  return { model, turns };
}

function deps(model: PipelineModel, state: SquadState, over: Partial<ScoreBatchDeps> = {}) {
  const recorded: Array<{ red: number; yellow: number }> = [];
  const asked: Array<Record<string, unknown>> = [];
  const names: Array<{ matchId: string; names: { red: string[]; yellow: string[] } }> = [];
  const d: ScoreBatchDeps = {
    model,
    loadState: async () => state,
    recordScore: async (a) => void recorded.push({ red: a.red, yellow: a.yellow }),
    reconcileElo: async () => ({ moved: 0 }),
    recordScoreAsk: async (a) => void asked.push({ ...a }),
    recordSideNames: async (a) => void names.push(a),
    ...over,
  };
  return { d, recorded, asked, names };
}

const msg = (body: string, over: Partial<ScoreBatchMessage> = {}): ScoreBatchMessage => ({
  waMessageId: `wa-${body.slice(0, 16)}`,
  body,
  authorName: "ava",
  senderUserId: "u-ava",
  senderName: "ava",
  tagged: true,
  taggedExplicitly: true,
  route: "score",
  gated: false,
  ...over,
});

async function run(state: SquadState, table: Record<string, unknown>, m: ScoreBatchMessage, over: Partial<ScoreBatchDeps> = {}) {
  const { model, turns } = stub(table);
  const rec = deps(model, state, over);
  const res = await runScoreBatch({
    orgId: "org-1",
    now: NOW,
    messages: [m],
    history: [],
    enabled: new Set(["score"]),
    deps: rec.d,
  });
  return { ...rec, turns, res, outcome: res.outcomes.get(m.waMessageId) };
}

const BIBS_BODY = "@Match Time bibs 9, no bibs 4";
const BIBS_FACTS = score({ first: 9, second: 4, firstTeam: "bibs", secondTeam: "no bibs" });

describe("the first time: one question, then the answer records and is remembered", () => {
  it('"bibs 9, no bibs 4" with no stored names asks which team was bibs, and records nothing', async () => {
    const r = await run(played(), { [BIBS_BODY]: BIBS_FACTS }, msg(BIBS_BODY));
    expect(r.recorded).toEqual([]);
    expect(r.outcome?.reply).toBe('9 - 4, thanks. Which team was "bibs": Red or Yellow? I\'ll remember it for next time.');
    expect(r.outcome?.reply).not.toMatch(/can't/i);
    expect(r.asked).toEqual([{ matchId: "game-1", first: 9, second: 4, askerUserId: "u-ava", name: "bibs", other: "no bibs" }]);
    expect(r.names).toEqual([]);
  });

  it("the question is in Turkish for a Turkish club", async () => {
    const state = played({ teamLabels: ["Kırmızı", "Sarı"] });
    state.features.language = "tr";
    const body = "@Match Time yelekliler 9 yeleksizler 4";
    const r = await run(state, { [body]: score({ first: 9, second: 4, firstTeam: "yelekliler", secondTeam: "yeleksizler" }) }, msg(body));
    expect(r.outcome?.reply).toBe('9 - 4, teşekkürler. "yelekliler" hangi takımdı: Kırmızı mı, Sarı mı? Bir dahaki sefere hatırlarım.');
  });

  const answered = (over: Partial<NonNullable<SquadState["completedMatch"]>> = {}) =>
    played({
      pendingScore: {
        first: 9,
        second: 4,
        askedAt: new Date(NOW.getTime() - 60_000).toISOString(),
        askerUserId: "u-ava",
        name: "bibs",
        other: "no bibs",
      },
      ...over,
    });

  it('the answer "red" (the side the model read for bibs) records Red 9 Yellow 4 and remembers both names', async () => {
    const body = "@Match Time red";
    const r = await run(answered(), { [body]: score({ hasScore: false, teamSides: [{ team: "bibs", side: "red" }] }) }, msg(body));
    expect(r.recorded).toEqual([{ red: 9, yellow: 4 }]);
    expect(r.names).toEqual([{ matchId: "game-1", names: { red: ["bibs"], yellow: ["no bibs"] } }]);
    expect(r.outcome?.reply).toBe("Got it 👍 *Red (bibs)* won 9 - 4 against Yellow (no bibs). Recorded.");
  });

  it('the answer read as the winner ("red" as winner) records the same', async () => {
    const body = "@Match Time red";
    const r = await run(answered(), { [body]: score({ hasScore: false, winner: "red" }) }, msg(body));
    expect(r.recorded).toEqual([{ red: 9, yellow: 4 }]);
    expect(r.names[0]?.names).toEqual({ red: ["bibs"], yellow: ["no bibs"] });
  });

  it('an answer that places the other name ("no bibs were yellow") records the same', async () => {
    const body = "@Match Time no bibs were yellow";
    const r = await run(answered(), { [body]: score({ hasScore: false, teamSides: [{ team: "no bibs", side: "yellow" }] }) }, msg(body));
    expect(r.recorded).toEqual([{ red: 9, yellow: 4 }]);
  });

  it("a failed write of the names is reported; the score stands", async () => {
    const body = "@Match Time red";
    const r = await run(
      answered(),
      { [body]: score({ hasScore: false, winner: "red" }) },
      msg(body),
      { recordSideNames: async () => { throw new Error("db down"); } },
    );
    expect(r.recorded).toEqual([{ red: 9, yellow: 4 }]);
    expect(r.res.degradations.join("\n")).toMatch(/could not be remembered/);
  });
});

describe("the next week: the same words record straight away", () => {
  const nextWeek = () => played({ id: "game-2", sideNames: { red: ["bibs"], yellow: ["no bibs"] } });

  it("records Red 9 Yellow 4 with no question, and THE GAME showed the names", async () => {
    const r = await run(nextWeek(), { [BIBS_BODY]: BIBS_FACTS }, msg(BIBS_BODY));
    expect(r.recorded).toEqual([{ red: 9, yellow: 4 }]);
    expect(r.asked).toEqual([]);
    expect(r.turns[0]).toContain('red: MatchTime calls it "Red"; this club also calls it "bibs"; players ava, ben');
    expect(r.turns[0]).toContain('yellow: MatchTime calls it "Yellow"; this club also calls it "no bibs"; players cal, dan');
    expect(r.outcome?.reasoning).toMatch(/the club's name for it/);
  });

  it('untagged, from a player, it records too: a score never needed the tag', async () => {
    const body = "bibs 9, no bibs 4";
    const r = await run(nextWeek(), { [body]: score({ first: 9, second: 4, firstTeam: "bibs", secondTeam: "no bibs" }) }, msg(body, { tagged: false, taggedExplicitly: false, senderUserId: "u-ben", authorName: "ben" }));
    expect(r.recorded).toEqual([{ red: 9, yellow: 4 }]);
  });
});

describe("a captain's team, and what was already working", () => {
  it('"Dan\'s team won 5-3" records using Dan\'s side', async () => {
    const body = "@Match Time Dan's team won 5-3";
    const r = await run(played(), { [body]: score({ first: 5, second: 3, winner: "Dan's team", teamSides: [{ team: "Dan's team", side: "yellow" }] }) }, msg(body));
    expect(r.recorded).toEqual([{ red: 3, yellow: 5 }]);
    expect(r.asked).toEqual([]);
    expect(r.turns[0]).toMatch(/yellow: [^\n]*players cal, dan/);
  });

  it('"Dan\'s team won 5-3" with no side read asks which team Dan\'s team was', async () => {
    const body = "@Match Time Dan's team won 5-3";
    const r = await run(played(), { [body]: score({ first: 5, second: 3, winner: "Dan's team" }) }, msg(body));
    expect(r.recorded).toEqual([]);
    expect(r.outcome?.reply).toContain('Which team was "Dan\'s team": Red or Yellow?');
  });

  it('"Red 9 Yellow 4" is unchanged: recorded, nothing learned, the plain acknowledgement', async () => {
    const body = "@Match Time Red 9 Yellow 4";
    const r = await run(played(), { [body]: score({ first: 9, second: 4, firstTeam: "Red", secondTeam: "Yellow" }) }, msg(body));
    expect(r.recorded).toEqual([{ red: 9, yellow: 4 }]);
    expect(r.names).toEqual([]);
    expect(r.outcome?.reply).toBe("Got it 👍 *Red* won 9 - 4 against Yellow. Recorded.");
  });

  it('"10-7" with no team is still the plain "which team won?"', async () => {
    const body = "@Match Time 10-7";
    const r = await run(played(), { [body]: score({ first: 10, second: 7 }) }, msg(body));
    expect(r.outcome?.reply).toBe("10 - 7: which team won? Reply with the winning team: Red or Yellow.");
    expect(r.asked).toEqual([{ matchId: "game-1", first: 10, second: 7, askerUserId: "u-ava" }]);
  });
});
