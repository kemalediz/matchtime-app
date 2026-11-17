/**
 * THE ROUTER IS TOLD A SCORE IS DUE (2026-11-17, Vets).
 *
 * 16 Nov, 22:14: "@Match Time bibs 9, no bibs 4" routed admin_ops and
 * got "can't do that", twice. Nothing in the turn said the club's game
 * had finished with no score, or what the club calls its sides. Now a
 * line under NOW says so, while it is true (a day after the game ends),
 * and the prompt says what the line means. A fact, not a rule: nothing
 * forces the route. Every name is made up.
 */
import { describe, it, expect } from "vitest";
import { ROUTER_SYSTEM_PROMPT, renderRouterTurn, routeBatch, type RouterMessage } from "../router";
import { gateBatch } from "../gate";
import { isScoreAwaited } from "../load-awaiting-answer";
import { awaitedScoreLine } from "../score-sides";
import { organisersContext } from "../../admin-group-context";
import type { ModelRequest, ModelResponse, PipelineModel } from "../llm";

const NOW = new Date("2026-11-16T22:14:00.000Z");
const LINE = awaitedScoreLine({ when: "Mon 16 Nov 20:15", labels: ["Red", "Yellow"], names: null });

function recording() {
  const seen: ModelRequest[] = [];
  const model: PipelineModel = {
    name: "rec",
    async complete(req): Promise<ModelResponse> {
      seen.push(req);
      const ids = [...req.user.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]);
      return {
        text: JSON.stringify({ routes: ids.map((id) => ({ id, route: "score", also: [], to_bot: true, pasted_list: false })) }),
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
        ms: 0,
      };
    },
  };
  return { model, seen };
}

const MSGS: RouterMessage[] = [
  { id: "a", authorName: "Ava", body: "great game lads" },
  { id: "b", authorName: "Ben", body: "@Match Time bibs 9, no bibs 4" },
];

describe("the line in the turn", () => {
  it("sits under NOW, once for the batch, above every message", () => {
    const turn = renderRouterTurn(MSGS, NOW, [LINE]).split("\n");
    expect(turn[1]).toBe(LINE);
    expect(turn.filter((l) => l === LINE)).toHaveLength(1);
    expect(turn[2]).toBe("[a] Ava: great game lads");
  });

  it("routeBatch shows it when given, and the turn is unchanged without it", async () => {
    const withIt = recording();
    await routeBatch(withIt.model, MSGS, { awaitedScoreLine: LINE, now: NOW });
    expect(withIt.seen[0].user).toContain(LINE);

    const without = recording();
    await routeBatch(without.model, MSGS, { now: NOW });
    expect(without.seen[0].user).toBe(renderRouterTurn(MSGS.map((m, i) => ({ ...m, id: `m${i + 1}` })), NOW));
    expect(without.seen[0].user).not.toContain("WAITING for the score");
  });

  it("the gate passes it through to the router", async () => {
    const r = recording();
    await gateBatch(
      MSGS.map((m) => ({ waMessageId: m.id, body: m.body, authorName: m.authorName })),
      { model: r.model, awaitedScoreLine: LINE, now: NOW },
    );
    expect(r.seen[0].user).toContain(LINE);
  });
});

describe("when a score is awaited: from the end of the game, for a day", () => {
  const ends = new Date("2026-11-16T21:15:00.000Z");
  it.each([
    ["before the game ends", new Date("2026-11-16T21:00:00.000Z"), false],
    ["the moment it ends", ends, true],
    ["an hour later", new Date("2026-11-16T22:15:00.000Z"), true],
    ["23 hours later", new Date("2026-11-17T20:15:00.000Z"), true],
    ["25 hours later", new Date("2026-11-17T22:15:00.000Z"), false],
  ])("%s", (_l, now, want) => expect(isScoreAwaited({ endsAt: ends, now })).toBe(want));
});

describe("the prompt says what the line means, once, and what a result looks like", () => {
  const p = ROUTER_SYSTEM_PROMPT;
  it("defines the waiting-for-the-score line where it defines what the model is shown", () => {
    expect(p.match(/"MATCHTIME IS WAITING for the score" line/g)).toHaveLength(1);
    const shown = p.slice(p.indexOf("WHAT YOU ARE SHOWN"), p.indexOf("REPLIES."));
    expect(shown).toContain('"MATCHTIME IS WAITING for the score" line under NOW');
  });

  it("score covers any names for the sides, the name question, and leaves chat about the game alone", () => {
    const def = p.slice(p.indexOf("\nscore "), p.indexOf("\nadmin_ops "));
    expect(def).toMatch(/bibs and no bibs/);
    expect(def).toMatch(/a player's team/);
    expect(def).toMatch(/which team a name was/);
    expect(def).toMatch(/"great game lads"/);
  });

  it("the incident's words are held out of the examples, and there are no long dashes", () => {
    expect(p).not.toContain("bibs 9, no bibs 4");
    expect(p).not.toContain("Dan's team");
    expect(p).not.toMatch(/[–—]/);
  });

  it("the results examples are grouped, English and Turkish side by side", () => {
    expect(p).toMatch(/"@Match Time bibs won 7-5" \/ "@Match Time yelekliler 7-5 kazandı" -> score/);
    expect(p).toMatch(/"what a game, well played all" \/ "harika maçtı, eline sağlık herkesin" \(MatchTime waiting for the score\) -> none/);
  });
});

describe("the organisers' group says the club's names too", () => {
  it("with names", () => {
    const lines = organisersContext({
      pending: [],
      recent: [],
      score: { kind: "result", day: "Mon 16 Nov", labels: ["Red", "Yellow"], names: { red: ["bibs"], yellow: ["no bibs"] } },
    });
    expect(lines[0]).toBe(
      'WAITING: the final score of Mon 16 Nov\'s match, Red against Yellow. This club also calls Red "bibs" and Yellow "no bibs".',
    );
  });

  it("without names, byte for byte as before", () => {
    const lines = organisersContext({ pending: [], recent: [], score: { kind: "result", day: "Mon 16 Nov", labels: ["Red", "Yellow"] } });
    expect(lines[0]).toBe("WAITING: the final score of Mon 16 Nov's match, Red against Yellow.");
  });
});
