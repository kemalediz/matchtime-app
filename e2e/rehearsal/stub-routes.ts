/**
 * WHAT THE STUBS ANSWER IN A STUBBED REHEARSAL, and what a live pass would
 * cost. Pure.
 *
 * The honest stub for replayed real chat is NO ROUTE ("none"): the run then
 * shows what MatchTime does when the model correctly ignores banter, and says
 * nothing about whether the real model would. Only a plain "in" / "out" gets
 * the obvious route without being told. Anything else a scenario wants
 * routed it says on the step: `route` + raw `facts`, or a `stub` shorthand:
 *
 *   self-in | self-out                the sender, about themselves
 *   other-in:Name | other-out:Name | other-bench:Name
 *   score:7-4                         first label 7, second label 4
 *
 * The fact shapes are the extractor's raw JSON, the same ones
 * `e2e/helpers/stub.ts` builds, so `parseFacts` still runs for real.
 */
import { facts, otherFacts, selfIn, selfOut } from "../helpers/stub";

export interface StubAnswer {
  route: string;
  facts?: Record<string, unknown>;
}

const PLAIN_IN = /^\s*(i'?m\s+|im\s+)?in(\s+please|\s+pls)?\s*[!.👍✅]*\s*$/iu;
const PLAIN_OUT =
  /^\s*((i'?m\s+|im\s+)?out(\s+this\s+week)?|can'?t\s+make\s+it(\s+this\s+week)?)(\s+sorry)?\s*[!.😪😔]*\s*$/iu;

export function stubRouting(
  step: { body: string; route?: string; facts?: Record<string, unknown>; stub?: string },
  teamLabels: [string, string] = ["Red", "Yellow"],
): StubAnswer {
  if (step.stub) return shorthand(step.stub, teamLabels);
  if (step.route) return step.facts ? { route: step.route, facts: step.facts } : { route: step.route };
  if (PLAIN_IN.test(step.body)) return { route: "self_att", facts: selfIn() };
  if (PLAIN_OUT.test(step.body)) return { route: "self_att", facts: selfOut() };
  return { route: "none" };
}

function shorthand(stub: string, labels: [string, string]): StubAnswer {
  if (stub === "self-in") return { route: "self_att", facts: selfIn() };
  if (stub === "self-out") return { route: "self_att", facts: selfOut() };
  if (stub === "none") return { route: "none" };
  const other = /^other-(in|out|bench):(.+)$/.exec(stub);
  if (other) return { route: "other_att", facts: otherFacts(other[2].trim(), other[1] as "in" | "out" | "bench") };
  const score = /^score:(\d+)-(\d+)$/.exec(stub);
  if (score)
    return {
      route: "score",
      facts: {
        hasScore: true,
        first: Number(score[1]),
        second: Number(score[2]),
        firstTeam: labels[0],
        secondTeam: labels[1],
        winner: "",
        loser: "",
        correction: false,
        swapped: false,
        otherGame: false,
      },
    };
  if (stub === "no-claims") return { route: "self_att", facts: facts([]) };
  throw new Error(`unknown stub "${stub}" (self-in, self-out, other-out:Name, score:7-4, none)`);
}

// ── What one live pass would cost ─────────────────────────────────────

/**
 * Per-call price assumptions, USD. Rates from src/lib/pipeline/llm.ts
 * (Haiku 4.5 $1/$5 per MTok, Sonnet 5 $2/$10, cache reads at 10% of input).
 * Token sizes from MDs/llm-spend-september-2026.md (router: ~3,200 input
 * tokens, uncached, ~60 out) and the cache probe in llm.ts (attendance
 * extractor: 1,778 cached prompt tokens). Estimates, not measurements: a
 * live run meters the real figure (e2e/run.ts).
 */
export const CALL_PRICES: Record<string, { usd: number; basis: string }> = {
  router: { usd: 3_400 * 1e-6 + 60 * 5e-6, basis: "Haiku 4.5, ~3,400 input tokens uncached + ~60 output" },
  extractor: {
    usd: 1_778 * 0.2e-6 + 400 * 2e-6 + 150 * 10e-6,
    basis: "Sonnet 5, ~1,778 cached + ~400 fresh input, ~150 output",
  },
  "rating adjuster": { usd: 2_000 * 2e-6 + 1_600 * 10e-6, basis: "Sonnet 5, ~2,000 input + up to ~1,600 output for 18 players" },
  "DM classifier": { usd: 1_000 * 1e-6 + 30 * 5e-6, basis: "Haiku 4.5, ~1,000 input + ~30 output" },
};

export interface LiveEstimate {
  lines: Array<{ kind: string; calls: number; usd: number; basis: string }>;
  totalCalls: number;
  totalUsd: number;
}

export function estimateLiveCost(counts: {
  routerCalls: number;
  extractorCalls: number;
  otherCalls?: Record<string, number>;
}): LiveEstimate {
  const rows: Array<[string, number]> = [
    ["router", counts.routerCalls],
    ["extractor", counts.extractorCalls],
    ...Object.entries(counts.otherCalls ?? {}),
  ];
  const lines = rows.map(([kind, calls]) => {
    const price = CALL_PRICES[kind] ?? { usd: 0.01, basis: "unpriced kind, assumed $0.01 a call" };
    return { kind, calls, usd: calls * price.usd, basis: price.basis };
  });
  return {
    lines,
    totalCalls: lines.reduce((a, l) => a + l.calls, 0),
    totalUsd: lines.reduce((a, l) => a + l.usd, 0),
  };
}
