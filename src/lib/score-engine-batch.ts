/**
 * §10 STEP 7 PART 2 — THE `score` ROUTE, END TO END.
 *
 *   router → score extractor → engine → APPLY → composer
 *
 * The first of step 7's four routes that WRITES, and the reason part 1
 * left it behind. `answer-batch.ts`'s header names the three things that
 * had to move with it, and all three are here:
 *
 *   1. it writes `Match.redScore` / `yellowScore` and runs the Elo
 *      deltas → `score-engine.ts`, an apply layer outside `pipeline/`;
 *   2. it accepts a score from an UNRESOLVED sender, because "losing the
 *      score entirely is a worse failure mode" (`route.ts:3457-3462`),
 *      where the engine used to refuse one → `engine.ts`'s `handleScore`,
 *      with the §9 authorisation seatbelt for RESOLVED members intact;
 *   3. it selects its target from `TEAMS_PUBLISHED | TEAMS_GENERATED |
 *      COMPLETED`, where `SquadState.completedMatch` only ever held a
 *      `COMPLETED` one → both loaders widened, documented on the field.
 *
 * ─────────────────────────────────────────────────────────────────────
 * IT OWNS NOTHING RATHER THAN GUESSING, AND SINCE 2026-09-06 THAT MEANS
 * THE SCORE IS SIMPLY NOT RECORDED
 * ─────────────────────────────────────────────────────────────────────
 * This table used to sit under "FAIL OPEN, ALWAYS — the same rule as
 * steps 6 and 7 part 1", and every row ended "the analyzer decides this
 * message, which is today's behaviour and therefore cannot be a
 * regression". §10 step 8 deleted `analyzeBatch`, the 19,850-token
 * `SYSTEM_PROMPT` and `executeVerdict`. Nothing decides these now.
 *
 * A `score` message this module declines reaches `route.ts`'s "NOBODY OWNED IT" branch
 * unowned: SILENCE in the group, an `AnalyzedMessage` row, and one line
 * on the deduped operator DM (`lib/operator-note.ts`). THAT IS A REAL
 * BEHAVIOUR CHANGE, and it is the one this file should be read most
 * carefully about, because `route.ts:3457-3462` already named the cost
 * in its own words: *"losing the score entirely is a worse failure
 * mode"*. A lost score is a match with no result, no Elo movement and no
 * MoM — and unlike a lost question, nobody in the group can tell by
 * looking. The operator note is the only thing that says so.
 *
 * §11.5 accepted the loss in advance: "a router with nine routes and an
 * engine with explicit rules will do nothing instead… the club will
 * experience it as 'the bot got dumber' before they experience it as
 * 'the bot stopped being wrong'."
 *
 *   • `SCORE_ENGINE_ENABLED` is off        → owns nothing → SILENCE +
 *                                            operator note. The flag is
 *                                            KEPT and now defaults ON;
 *                                            only 0/false/no/off turn it
 *                                            off (`route-flags.ts`).
 *   • step 5's gate skipped it             → owns nothing, and NO note:
 *                                            `composeOperatorNote` drops
 *                                            every `none` route
 *   • the router never mentioned the id    → owns nothing → SILENCE +
 *                                            note
 *   • no match has been played yet         → owns nothing → SILENCE +
 *                                            note
 *   • the state load threw                 → owns nothing → SILENCE +
 *                                            note
 *   • the extractor call threw             → THAT message goes SILENT
 *                                            and onto the note. ONE
 *                                            attempt only: `extractors.ts`
 *                                            retries the four attendance
 *                                            routes and not this one.
 *   • the extracted shape is not a score   → SILENCE + note
 *   • the engine threw                     → owns nothing → SILENCE +
 *                                            note, and no retry
 *                                            (`decide()` is pure)
 *   • the engine proposed a write that is
 *     not a score                          → owns nothing, loudly →
 *                                            SILENCE + note
 *   • the score write itself threw         → owned, but SILENT, and the
 *                                            failure is reported (see
 *                                            "an ack must not outrun the
 *                                            write" below). NOTE: owned
 *                                            means `operator-note.ts`
 *                                            does NOT see it — an owner
 *                                            claimed the id. The
 *                                            degradation still reaches
 *                                            the log through
 *                                            `describeScoreBatch`.
 *
 * ─────────────────────────────────────────────────────────────────────
 * NO TAG IS REQUIRED, AND THAT IS THE CONTRACT, NOT AN OVERSIGHT
 * ─────────────────────────────────────────────────────────────────────
 * `answer-batch.ts` demands `m.tagged` unconditionally, which is safe
 * there because `question` and both team intents are in
 * `ACTIONY_INTENTS`. `score` is DELIBERATELY EXCLUDED from that set, and
 * `interaction-contract.ts:125-129` says why in its own words: *"a
 * match-result report ('we won 5-2') is a genuine state change MT
 * records (feeds MoM/ratings), closer to self-attendance than to an
 * answer; it stays tag-free (and is separately permission-gated to
 * participants/admins by the score path)."*
 *
 * Requiring a tag here would therefore be a REGRESSION rather than
 * caution: every "we won 5-3" in a real group is untagged, and the flag
 * would look enabled while owning nothing. The permission gate the
 * contract is relying on is `handleScore`'s, and it is still there.
 *
 * ─────────────────────────────────────────────────────────────────────
 * TWO GATES THE OTHER RUNNERS APPLY AND THIS ONE DOES NOT
 * ─────────────────────────────────────────────────────────────────────
 *   • `features.attendance`. `route.ts:3109-3111`: *"Score stays
 *     ungated — it's infrastructure that feeds MoM + ratings, not a
 *     user-facing toggle."* A MoM-and-ratings-only org (Sutton Lads,
 *     `featureAttendance` off) still needs its results recorded; that is
 *     the ONLY thing it needs. Gating on attendance here would silently
 *     switch off the one feature such an org has.
 *   • `expectedMatchId`. Steps 6 and 7-part-1 own nothing when the
 *     route's registration match and the engine's disagree, because
 *     everything they do is ABOUT that match. A score is about a match
 *     that has already been played, so the upcoming match is not part of
 *     the decision — and the common case right after a game is that
 *     there is no upcoming match at all. Gating on it would refuse most
 *     real score reports.
 *
 * ─────────────────────────────────────────────────────────────────────
 * AN ACK MUST NOT OUTRUN THE WRITE
 * ─────────────────────────────────────────────────────────────────────
 * Composition happens AFTER the apply, and a write that threw takes its
 * utterance with it. "Got it 👍 Red 5 - 3 Yellow, recorded" over a
 * failed update is §3.2 S7 exactly — the 2026-05-15 Erdal incident,
 * where the bot announced a change the database never made and the group
 * believed it.
 */
import { compose } from "./pipeline/compose";
import { decide as decideDefault } from "./pipeline/engine";
// Traced: the extractor's facts are kept on the message's AnalyzedMessage
// row (`pipelineTrace`). Identical to `extractForRoute` outside a request.
import { extractForRouteTraced } from "./pipeline/trace";
import { extractorStubFromEnv } from "./pipeline/extractor-stub";
import { anthropicModel, type PipelineModel } from "./pipeline/llm";
import { SCORE_ENGINE_ROUTES, stepSevenOwnsRoute } from "./pipeline/route-flags";
import type {
  EngineInput,
  EngineMessage,
  EngineResult,
  Facts,
  Route,
  SquadState,
} from "./pipeline/types";
import {
  SCORE_APPLY_DEGRADED_PREFIX,
  SCORE_HANDLED_BY,
  applyScoreWrites,
  type EngineScoreWrite,
  type ScoreApplyDeps,
} from "./score-engine";

export { SCORE_APPLY_DEGRADED_PREFIX, SCORE_HANDLED_BY };

/** The routes this module can own. From `route-flags.ts`, so the flag
 *  and the owner cannot disagree about the list. */
export const SCORE_ROUTES = SCORE_ENGINE_ROUTES;

export interface ScoreBatchMessage {
  waMessageId: string;
  body: string;
  authorName: string | null;
  /** Resolved sender, or null for an unknown pushname / opaque @lid.
   *  NULL IS NOT A DISQUALIFIER on this route — see the header. */
  senderUserId: string | null;
  senderName: string | null;
  tagged: boolean;
  /** From the router. `undefined` when it never mentioned this id. */
  route: Route | undefined;
  /** Did step 5's gate skip this message? Then this never sees it. */
  gated: boolean;
}

export interface ScoreMessageOutcome {
  waMessageId: string;
  route: Route;
  reply: string | null;
  react: string | null;
  /** `AnalyzedMessage.intent`, in the vocabulary the admin log already
   *  speaks. `score` is what the shipped verdict calls it. */
  intent: string;
  /** `AnalyzedMessage.action`. */
  action: string;
  /** Machine reasons, one per rule that fired. Never prose for a regex
   *  to parse — nothing in this codebase parses it. */
  reasoning: string;
  /** The match the result landed on, for the audit trail. */
  matchId: string | null;
  /** How many player ratings the Elo pass moved. */
  eloApplied: number;
  /** The write threw. The caller must not say anything cheerful. */
  writeFailed: boolean;
}

export interface ScoreBatchResult {
  ownedIds: Set<string>;
  outcomes: Map<string, ScoreMessageOutcome>;
  /** The match a score landed on, or null. */
  scoredMatchId: string | null;
  degradations: string[];
  cost: { usd: number; calls: number; ms: number };
}

export interface ScoreBatchDeps extends ScoreApplyDeps {
  /** Injected so tests can drive the whole batch without a key. */
  model?: PipelineModel;
  /** Injected so tests can load a state without a database. */
  loadState?: (orgId: string, now: Date) => Promise<SquadState>;
  /** Injected so a test can prove the write assertion and the
   *  throw-safety without a fabricated rule in the real engine. */
  decide?: (input: EngineInput) => EngineResult;
}

/**
 * "This module owns nothing." It used to say "; the analyzer keeps the
 * batch", which named where the score went. Since §10 step 8 it goes
 * nowhere: the message reaches `route.ts`'s "NOBODY OWNED IT" branch unowned and the result is
 * never recorded.
 *
 * A FUNCTION, not a shared const, for the reason step 6's is: the result
 * carries a `Set` and a `Map`, and one frozen-by-convention instance
 * handed to every caller is one `.add()` away from leaking one request's
 * state into the next. It takes the accumulated degradations so a
 * decline never loses the reason it happened — those lines are now
 * `composeOperatorNote`'s only source for the "why" beside each lost
 * message, and for a score they are the only notice anybody gets.
 */
function empty(degradations: string[] = []): ScoreBatchResult {
  return {
    ownedIds: new Set(),
    outcomes: new Map(),
    scoredMatchId: null,
    degradations,
    cost: { usd: 0, calls: 0, ms: 0 },
  };
}

export async function runScoreBatch(args: {
  orgId: string;
  now: Date;
  messages: ScoreBatchMessage[];
  history: Array<{ author: string | null; body: string }>;
  /** The routes this request has enabled, resolved by the caller (which
   *  also knows about the test-only per-request override). */
  enabled: Set<Route>;
  deps: ScoreBatchDeps;
}): Promise<ScoreBatchResult> {
  const { orgId, now, messages, history, enabled, deps } = args;
  const t0 = Date.now();

  // ── Ownership, part 1: everything knowable without a model ─────────
  const candidates = messages.filter(
    (m) => !m.gated && stepSevenOwnsRoute(m.route, enabled, SCORE_ROUTES),
  );
  if (candidates.length === 0) return empty();

  const degradations: string[] = [];

  let state: SquadState;
  try {
    state = deps.loadState
      ? await deps.loadState(orgId, now)
      : await (await import("./pipeline/load-state")).loadSquadState(orgId, now);
  } catch (err) {
    // Owning nothing. That used to be a fail-OPEN — "the analyzer
    // decides, which is what happens today" — and since §10 step 8 it is
    // a fail-QUIET: any result reported in this window is not recorded,
    // and the only notice is the line below.
    const detail = `${SCORE_APPLY_DEGRADED_PREFIX} state load failed (${
      err instanceof Error ? err.message : String(err)
    }); nobody records these scores — they go silent and onto this note`;
    console.error("[score-engine] state load failed:", err);
    return empty([detail]);
  }

  // Nothing has been played, so there is nothing a result could be
  // about. The engine would say the same ("no completed match to record
  // a score against") but it would cost an extractor call to hear it.
  if (!state.completedMatch) return empty();

  // ── Stage 2: extractors, in parallel ───────────────────────────────
  const model = deps.model ?? extractorStubFromEnv() ?? anthropicModel();
  const lastBotPost =
    [...history].reverse().find((h) => (h.author ?? "").toLowerCase() === "matchtime")?.body ??
    state.lastBotPost ??
    null;
  state = { ...state, lastBotPost };

  let cost = { usd: 0, calls: 0, ms: 0 };
  const factsById = new Map<string, Facts>();
  await Promise.all(
    candidates.map(async (m) => {
      const res = await extractForRouteTraced("score", model, m.route as Route, {
        id: m.waMessageId,
        body: m.body,
        authorName: m.authorName,
        tagged: m.tagged,
        history,
        lastBotPost,
      });
      for (const d of res.degradations) {
        degradations.push(`extractor ${m.waMessageId}: ${d.detail}`);
      }
      if (res.usage) {
        cost = {
          usd: cost.usd + (res.usage.costUsd ?? 0),
          calls: cost.calls + 1,
          // Extractors fan out, so the batch's model time is the slowest
          // of them, not the sum.
          ms: Math.max(cost.ms, res.usage.ms),
        };
      }
      const failure = res.degradations.find((d) => /failed|could not be parsed/i.test(d.detail));
      if (failure) {
        // §11.4 says "fail closed and surface it". Closed here means
        // LOSING THE SCORE, which `route.ts:3462` calls the worse
        // failure mode by name.
        //
        // WHAT USED TO STAND HERE: "so the message goes back to the
        // analyzer, which still has the mega-prompt and still records
        // it. That is this step's own revert, applied per message and
        // automatically, and it costs one analyzer call." §10 step 8
        // deleted the mega-prompt. There is no revert and no second
        // recorder: a failed score extraction means the match keeps no
        // result until a human notices. The line below is what makes
        // "until a human notices" bounded — it is printed on the
        // operator DM beside the message that was lost.
        //
        // ONE ATTEMPT. `extractors.ts` retries only the four attendance
        // routes, where silence costs a player their slot within hours.
        // A score can be re-reported the next day; that is the whole of
        // the asymmetry, and it is a judgement, not an oversight.
        degradations.push(
          `${SCORE_APPLY_DEGRADED_PREFIX} ${m.waMessageId}: ${failure.detail} — ` +
            `nobody records this score: no reply in the group, and it is on this note`,
        );
        return;
      }
      factsById.set(m.waMessageId, res.facts);
    }),
  );

  // ── Ownership, part 2: shapes only visible after extraction ────────
  //
  // ON THE `continue`s. Three defects in one week came from a terminal
  // `continue` silently skipping every guard below it, so, explicitly:
  // the ONLY effect of a full pass through this loop body is
  // `ownedIds.add(...)`. There is no write, no send, no state mutation
  // and no later guard inside it, so a `continue` can skip exactly one
  // thing — ownership — which is the intent. Everything a skipped
  // message still needs happens OUTSIDE the loop: it reaches `decide()`
  // with `facts: {kind:"none"}` (so `assertCoverage` still sees one
  // outcome per input id and the window is intact for its neighbours),
  // it gets no entry in `outcomes` (so the analyze route finds no owner
  // and records it as unowned — silence plus the operator note, since
  // §10 step 8 deleted the verdict it used to leave alone), and its
  // reason is already in `degradations` before the `continue` runs.
  const ownedIds = new Set<string>();
  for (const m of candidates) {
    const facts = factsById.get(m.waMessageId);
    if (!facts) continue; // extraction failed; already reported above.
    if (facts.kind !== "score") {
      degradations.push(
        `${SCORE_APPLY_DEGRADED_PREFIX} ${m.waMessageId}: the score extractor returned ` +
          `"${facts.kind}" facts — nobody records this score: no reply in the group, ` +
          `and it is on this note`,
      );
      continue;
    }
    ownedIds.add(m.waMessageId);
  }
  if (ownedIds.size === 0) return empty(degradations);

  // ── Stage 3: the engine, over the WHOLE window ─────────────────────
  //
  // Only owned messages are extracted, but every message in the batch
  // reaches `decide()`, for the reason steps 6 and 7 part 1 do it:
  // taking a message OUT of the window changes what the rest of the
  // pipeline concludes about its neighbours, and `assertCoverage`
  // requires exactly one outcome per input id.
  const engineMessages: EngineMessage[] = messages.map((m) => ({
    id: m.waMessageId,
    body: m.body,
    senderUserId: m.senderUserId,
    senderName: m.senderName ?? m.authorName,
    tagged: m.tagged,
    route: m.route ?? "none",
    facts: ownedIds.has(m.waMessageId)
      ? (factsById.get(m.waMessageId) ?? { kind: "none" })
      : { kind: "none" },
    degraded: null,
  }));

  let result: EngineResult;
  try {
    result = (deps.decide ?? decideDefault)({ messages: engineMessages, state, now });
  } catch (err) {
    // `decide` throws on a coverage violation, which is right — that is
    // a bug in the engine, not a bad model day. It must not 500 the
    // analyze request: nothing has been written yet, so owning nothing
    // costs the batch its score and costs the database no corruption.
    //
    // It used to call that "a complete fail-open", because "the analyzer
    // batch has not been decided". There is no analyzer batch since §10
    // step 8, so this is a fail-quiet with a receipt. No retry:
    // `decide()` is pure, so the same input throws the same way.
    const detail = `${SCORE_APPLY_DEGRADED_PREFIX} the engine threw (${
      err instanceof Error ? err.message : String(err)
    }); nobody records these scores — they go silent and onto this note`;
    console.error("[score-engine] the engine threw:", err);
    return empty([...degradations, detail]);
  }
  for (const d of result.degradations) {
    degradations.push(`[${d.stage}${d.messageId ? ` ${d.messageId}` : ""}] ${d.detail}`);
  }

  // ── THE WRITE ASSERTION ────────────────────────────────────────────
  //
  // This path has ONE apply layer and it knows one kind of write. A
  // `score`-routed message cannot produce an attendance write today —
  // `handleScore` contains no other `emit()` — which is exactly why it
  // is asserted rather than assumed. A write of another kind reaching
  // here would have no authorisation pass, no `AttendanceEvent` and
  // nowhere to land, and it would be LOST rather than refused. Four
  // seatbelts were found dead on 2026-08-31, all with comments claiming
  // they worked; this one refuses the whole batch and says so.
  const scoreWrites: EngineScoreWrite[] = [];
  const foreign: string[] = [];
  for (const w of result.writes) {
    if (w.kind !== "score") {
      foreign.push(w.kind);
    } else if (!ownedIds.has(w.sourceMessageId)) {
      // Belt and braces: the engine cannot produce a write from a
      // message it was given no facts for. Belt and braces is the right
      // amount for a path that moves every player's rating.
      foreign.push(`${w.kind} (from an unowned message)`);
    } else {
      scoreWrites.push(w);
    }
  }
  if (foreign.length > 0) {
    const detail =
      `${SCORE_APPLY_DEGRADED_PREFIX} the engine proposed ${foreign.length} write(s) this ` +
      `path cannot apply (${[...new Set(foreign)].join(", ")}); owning nothing — these ` +
      `messages go silent and onto this note`;
    console.error(`[score-engine] ${detail}`);
    return empty([...degradations, detail]);
  }

  // ── Stage 3b: APPLY ────────────────────────────────────────────────
  const applied = await applyScoreWrites({ writes: scoreWrites, deps });
  const resultByMessage = new Map(applied.map((a) => [a.write.sourceMessageId, a]));
  for (const a of applied) {
    if (!a.ok) {
      degradations.push(
        `${SCORE_APPLY_DEGRADED_PREFIX} ${a.write.sourceMessageId}: recording ` +
          `${a.write.red}-${a.write.yellow} on match ${a.write.matchId} failed (${a.error})`,
      );
    } else if (a.eloError) {
      degradations.push(
        `${SCORE_APPLY_DEGRADED_PREFIX} ${a.write.sourceMessageId}: the score landed but the ` +
          `Elo update failed (${a.eloError}); ratings did not move`,
      );
    }
  }

  // ── Stage 4: composition, AFTER the apply ──────────────────────────
  const composed = compose(result);
  const utteranceByMessageId = new Map<string, string[]>();
  for (const u of composed.utterances) {
    if (u.messageId === null) {
      // A batch-level post is the squad post, which only a squad CHANGE
      // produces — and this path makes none. If one ever appeared it
      // would be a SECOND squad post in the same batch, beside the
      // attendance engine's. (It used to say "beside the analyzer's";
      // since §10 step 8 the attendance engine is the only thing that
      // composes one.) So it is dropped and recorded rather than sent.
      degradations.push(
        `${SCORE_APPLY_DEGRADED_PREFIX} a batch-level post was composed on the score path; dropped`,
      );
      continue;
    }
    if (!ownedIds.has(u.messageId)) continue;
    const list = utteranceByMessageId.get(u.messageId) ?? [];
    list.push(u.text);
    utteranceByMessageId.set(u.messageId, list);
  }
  const reactByMessageId = new Map(composed.reacts.map((r) => [r.messageId, r.emoji]));
  for (const n of composed.operatorNotes) {
    if (!degradations.includes(n)) degradations.push(n);
  }

  // ── Per-message outcomes ───────────────────────────────────────────
  const outcomes = new Map<string, ScoreMessageOutcome>();
  let scoredMatchId: string | null = null;
  for (const m of messages) {
    if (!ownedIds.has(m.waMessageId)) continue;
    const engineOutcome = result.outcomes.find((o) => o.messageId === m.waMessageId);
    const write = resultByMessage.get(m.waMessageId);
    const machineReasons = (engineOutcome?.reasons ?? []).join("; ");
    const failed = !!write && !write.ok;

    // ONE reply per message, and NOTHING when the write threw. §3.2 S7:
    // the words must match the action.
    const reply = failed ? null : (utteranceByMessageId.get(m.waMessageId) ?? []).join("\n\n") || null;
    const react = failed ? null : (reactByMessageId.get(m.waMessageId) ?? null);
    if (write?.ok) scoredMatchId = write.write.matchId;

    outcomes.set(m.waMessageId, {
      waMessageId: m.waMessageId,
      route: m.route as Route,
      reply,
      react,
      intent: "score",
      // Derived exactly as `route.ts:2197-2200` derives it. "none" would
      // make every recorded score look like a no-op to anything
      // filtering the admin log, including the nightly sweep.
      action: write?.ok ? "score" : react ? "react" : reply ? "reply" : "none",
      reasoning:
        `${SCORE_HANDLED_BY} (${m.route}): ${machineReasons || "no rule fired"}` +
        (failed ? `; the score write FAILED (${write?.error})` : ""),
      matchId: write?.write.matchId ?? null,
      eloApplied: write?.eloApplied ?? 0,
      writeFailed: failed,
    });
  }

  return {
    ownedIds,
    outcomes,
    scoredMatchId,
    degradations,
    cost: { ...cost, ms: Date.now() - t0 },
  };
}

/**
 * WHAT THE SCORE ENGINE DID, AND WHAT IT LOST, as lines for the operator.
 *
 * Pure and exported for the reason `describeEngineBatch` is: the same
 * lines were once composed behind `if (ownedIds.size > 0)`, which
 * silences them in exactly the case they exist for — a batch where every
 * extraction failed ends with `ownedIds` empty, and `empty(degradations)`
 * goes out of its way to carry the reasons through that early return
 * precisely so they could be printed.
 */
export function describeScoreBatch(
  batch: ScoreBatchResult,
  batchSize: number,
): { warns: string[]; info: string | null } {
  const warns = batch.degradations.map((d) => `[analyze] score-engine degraded: ${d}`);
  const info =
    batch.ownedIds.size > 0 || batch.degradations.length > 0
      ? `[analyze] score-engine: decided ${batch.ownedIds.size}/${batchSize} message(s), ` +
        `scored match ${batch.scoredMatchId ?? "(none)"}, ` +
        `$${batch.cost.usd.toFixed(5)} across ${batch.cost.calls} extractor call(s) ` +
        `in ${batch.cost.ms}ms`
      : null;
  return { warns, info };
}
