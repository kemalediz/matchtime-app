/**
 * §10 STEP 8 — THE `balancer` ROUTE'S `generate` ACTION, END TO END.
 *
 *   router → teams extractor → engine → APPLY → the balancer's own post
 *
 * The last hole in the plan to delete the 19,850-token `SYSTEM_PROMPT`.
 * Measured over 120 days of production `AnalyzedMessage` rows on Sutton
 * FC, `generate_teams_request` occurred **23 times** — the single most
 * common tagged command to MatchTime, more common than every question
 * shape put together. Real bodies, verbatim:
 *
 *   "@Match Time generate the teams"                        ×8
 *   "@Match Time generate the teams, put me and <X> to the same team"
 *   "@Match Time regenerate the teams once more with Erdal's rating updated"
 *   "now setup the teams again @Match Time"
 *   "Make the teams"
 *   "@Match Time some are not happy with the teams, could you please
 *    come with an alternative?"
 *
 * `answer-batch.ts` owned only `show` and handed everything else back
 * with, in its own words, *"team action \"generate\" still belongs to
 * the balancer"*. After step 8 there is no balancer to hand it back to:
 * an unowned message falls through to `route.ts`'s catch-all, which is
 * SILENT to the group plus one deduped operator note. So every
 * "handed back" string in this file is written for a human reading a
 * DM, not for a fallback classifier.
 *
 * ─────────────────────────────────────────────────────────────────────
 * ONE ROUTE, TWO OWNERS, SPLIT ON A FACT — NOT ON A FLAG
 * ─────────────────────────────────────────────────────────────────────
 * Two owners for one route is the thing this codebase most fears, so the
 * split is stated in one place (`route-flags.ts`'s
 * `TEAM_ACTION_OWNERSHIP` block) and imported by both modules, rather
 * than written as an `if` in each:
 *
 *   • `show`     → `answer-batch.ts`  (`ANSWER_TEAM_ACTIONS`)
 *   • `generate` → HERE              (`TEAM_OPS_TEAM_ACTIONS`)
 *   • `rename`, `swap` → neither; both are handed back, see below.
 *
 * `__tests__/route-flags.test.ts` asserts the two lists are DISJOINT,
 * which is the property that makes two owners safe rather than merely
 * intended. The router cannot make this split itself: "show me the
 * teams" and "generate the teams" are both `balancer` and the difference
 * is not knowable until the teams extractor has run.
 *
 * AND THERE IS NO FIFTH FLAG. `enabledStepSevenRoutes` returns a
 * `Set<Route>` and `stepSevenOwnsRoute` answers from it, so a
 * `TEAM_OPS_ENGINE_ENABLED` that added `balancer` to that set would turn
 * `answer-batch.ts` on as well — the opposite of an independent revert.
 * `route-flags.ts`'s `TEAM_OPS_FLAG` carries the full argument and what
 * it costs (reverting `generate` reverts `show` with it).
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT IS HANDED BACK, AND WHY EACH ONE
 * ─────────────────────────────────────────────────────────────────────
 *   • `swap` — IT ALREADY HAS AN OWNER. `route.ts`'s
 *     `handleTeamSwapIfApplicable` / `handleColorSwapIfApplicable` is a
 *     deterministic pre-peel that runs on the RAW BODY with no verdict
 *     at all, so it survives the mega-prompt's deletion untouched.
 *     Owning `swap` here would put two deciders on one message.
 *
 *     ⚠️ 2026-09-08 RE-EXAMINED AND UPHELD, after this hand-back was
 *     the visible symptom of a real incident. "@Match Time do not
 *     regenerate the teams. Instead swap Elvin with Raihan and share us
 *     the teams" produced the operator note
 *     `team action "swap" is not a read (no module owns it)` and a
 *     stale team sheet on a match night. The note was accurate and this
 *     module was not the bug: the pre-peel had ALREADY matched the
 *     sentence and then declined it on its own rule ("both must be
 *     CONFIRMED"), and Elvin was DROPPED. The fix belongs where the
 *     decision was made, so `lib/team-slot-swap.ts` now carries the
 *     full state matrix and the pre-peel also owns the REPLACEMENT
 *     case: a stale slot moves from a player who is not coming to a
 *     confirmed player who has none.
 *
 *     Giving `balancer` a `swap` owner here was considered and
 *     REFUSED, for the reason above and one more: this path's only
 *     apply layer re-runs the balancer, and re-running the balancer is
 *     the precise thing the message asked it not to do. A `swap` owner
 *     here would need a second, non-generating apply layer — a
 *     `TeamAssignment` mover that ignores the extractor's team facts —
 *     which is the pre-peel, written twice.
 *   • `rename` — IT IS NOT A GENERATE. §10 step 8's brief allowed
 *     mapping it onto generate-with-`teamNames`, and it is refused:
 *     re-running the balancer over line-ups an admin has hand-swapped is
 *     2026-06-18 (`c408649`) exactly, the incident that split `show`
 *     from `generate` in the first place. Renaming WITHOUT reshuffling
 *     is a `Match.teamLabels` write this path does not model. Losing a
 *     rename costs one message; the alternative costs the teams.
 *     Note that this loses very little in practice: "@Match Time
 *     generate the teams now, come up with fun team names" extracts as
 *     `generate` (the line-ups have to be worked out again), so it is
 *     OWNED — see "what did not come across" below for the one thing it
 *     does lose.
 *
 * ─────────────────────────────────────────────────────────────────────
 * IT OWNS NOTHING RATHER THAN GUESSING — AND THIS FILE NEVER GOT TO
 * CALL THAT "FAIL OPEN"
 * ─────────────────────────────────────────────────────────────────────
 * Its siblings' tables were headed "FAIL OPEN, ALWAYS" and every row of
 * them ended "the analyzer decides this message, which is today's
 * behaviour and therefore cannot be a regression". This module was
 * written in §10 step 8 itself — the change that deleted `analyzeBatch`,
 * the 19,850-token `SYSTEM_PROMPT` and `executeVerdict` — so it has
 * never had an analyzer to fall open onto, and the heading is corrected
 * rather than inherited.
 *
 * "Owns nothing" here means what it means everywhere else after step 8:
 * the message reaches `route.ts`'s "NOBODY OWNED IT" branch unowned, MatchTime says NOTHING to
 * the group, an `AnalyzedMessage` row records it, and one line goes onto
 * a deduped operator DM (`lib/operator-note.ts`). §11.5 accepted that
 * loss in advance: "a router with nine routes and an engine with
 * explicit rules will do nothing instead… the club will experience it as
 * 'the bot got dumber' before they experience it as 'the bot stopped
 * being wrong'."
 *
 *   • `BALANCER_ENGINE_ENABLED` is off      → owns nothing → SILENCE +
 *                                             operator note. KEPT and
 *                                             now defaulting ON; only
 *                                             0/false/no/off turn it off
 *                                             (`route-flags.ts`).
 *   • step 5's gate skipped it              → owns nothing, and NO note:
 *                                             `composeOperatorNote`
 *                                             drops every `none` route
 *   • the router never mentioned the id     → owns nothing → SILENCE +
 *                                             note
 *   • the message is UNTAGGED               → owns nothing (see below) →
 *                                             SILENCE + note
 *   • the state load threw                  → owns nothing → SILENCE +
 *                                             note
 *   • the feature load threw                → owns nothing → SILENCE +
 *                                             note
 *   • team balancing is OFF for the org     → owned, and SILENT, which
 *                                             is the shipped org gate
 *                                             (`route.ts:3128`). OWNED
 *                                             is the point: an owner
 *                                             claimed the id, so no note
 *                                             fires for a feature an
 *                                             admin switched off.
 *   • the extractor call threw              → THAT message goes SILENT
 *                                             and onto the note. ONE
 *                                             attempt: `extractors.ts`
 *                                             retries the four
 *                                             attendance routes only.
 *   • the facts are not team facts          → SILENCE + note
 *   • the action is not `generate`          → SILENCE + note (`show`
 *                                             belongs to
 *                                             `answer-batch.ts`;
 *                                             `swap` to the
 *                                             deterministic pre-peel;
 *                                             `rename` to nobody, on
 *                                             purpose — see above)
 *   • the engine threw                      → owns nothing → SILENCE +
 *                                             note, and no retry
 *                                             (`decide()` is pure)
 *   • the engine proposed a write this path
 *     cannot apply                          → owns nothing, loudly →
 *                                             SILENCE + note
 *   • no match qualifies                    → owned; the shipped
 *                                             sentence, the shipped 🤔
 *   • the balancer declined                 → owned; the shipped
 *                                             sentence, the shipped 🤔
 *   • the apply threw                       → owned, but SILENT, and
 *                                             the failure is reported.
 *                                             Owned means no note — the
 *                                             log line from
 *                                             `describeTeamOpsBatch` is
 *                                             the signal.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE TAG IS REQUIRED, UNCONDITIONALLY
 * ─────────────────────────────────────────────────────────────────────
 * Exactly as `answer-batch.ts` does it and for the same stated reason:
 * `generate_teams_request` and `show_teams_request` are both in
 * `ACTIONY_INTENTS` (`interaction-contract.ts:148-156`), so the shipped
 * gate already refuses an untagged one before any of this could matter.
 * Requiring `m.tagged` here means there is nothing that could drift away
 * from that policy if it changes — the worst this can do is own less —
 * and it saves an extractor call on every untagged mention of the teams
 * in the group, which is most of them.
 *
 * ─────────────────────────────────────────────────────────────────────
 * ONE GENERATE PER BATCH, AND IT IS THE LAST ONE
 * ─────────────────────────────────────────────────────────────────────
 * `route.ts:2084-2100` already does this and it is reproduced here: when
 * a window carries several generate requests, only the LAST fires; the
 * earlier ones get a ⚽ react and no reply. Two team posts one line
 * apart, from two different balancer runs with two different line-ups,
 * is the worst possible answer to "generate the teams" asked twice.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY THERE IS NO "THE BATCH ALSO CARRIES SOMETHING ELSE" CARVE-OUT
 * ─────────────────────────────────────────────────────────────────────
 * `answer-batch.ts` refuses to answer a question in a batch that carries
 * anything else, because its answers are COMPOSED FROM `SquadState` — a
 * pre-write snapshot — and "Yes, Idris has a slot" beside Idris's own
 * "can't make it" is a claim about a squad that no longer exists.
 *
 * That argument does not transfer, and saying so is not a loosening.
 * `generateTeamsForMatch` re-reads the CONFIRMED attendance rows FROM
 * THE DATABASE when it runs; it never sees `SquadState` at all. The only
 * exposure left is an attendance write that lands LATER in the same
 * batch, and that is precisely the shipped path's exposure whenever the
 * generate message happens to come first in the window. Refusing here
 * would trade a hazard the shipped path already has for silence on the
 * club's most-used command, which is a worse trade. Where the caller can
 * run this after the batch's attendance writes have landed — the way
 * `route.ts:2436` already sequences the recruit blast — it should.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT DID NOT COME ACROSS FROM `route.ts:3546-3691`
 * ─────────────────────────────────────────────────────────────────────
 *   • MODEL-INVENTED TEAM NAMES. "come up with fun team names" reached
 *     `generateTeamsForMatch` as `verdict.teamNames`, which the
 *     mega-prompt authored and `sanitiseTeamNames` cleaned. The teams
 *     extractor is told it never picks anything, so it returns the names
 *     the message SUPPLIES and no others. The request is still owned and
 *     the teams are still generated — under the standard Red/Yellow
 *     labels. Restoring the invented names needs a generator of its own,
 *     not a facts field, and that is a separate change.
 *   • FUZZY-MATCH TIE-BREAKING. The shipped path takes the FIRST roster
 *     row whose normalised name matches; `engine.ts` uses
 *     `resolvePerson`, which refuses an ambiguous first name instead of
 *     force-confirming whichever of two Amirs sorted first. Owning less,
 *     on purpose, and the unresolved name is reported to the group in
 *     the shipped "couldn't find … — ignored" wording rather than
 *     silently guessed.
 */
import type { OrgFeatures } from "./org-features";
import { compose } from "./pipeline/compose";
import { decide as decideDefault } from "./pipeline/engine";
// Traced: the extractor's facts are kept on the message's AnalyzedMessage
// row (`pipelineTrace`). Identical to `extractForRoute` outside a request.
import { extractForRouteTraced } from "./pipeline/trace";
import { extractorStubFromEnv } from "./pipeline/extractor-stub";
import { anthropicModel, type PipelineModel } from "./pipeline/llm";
import {
  TEAM_OPS_ENGINE_ROUTES,
  TEAM_OPS_TEAM_ACTIONS,
  stepSevenOwnsRoute,
} from "./pipeline/route-flags";
import type {
  EngineInput,
  EngineMessage,
  EngineResult,
  Facts,
  Route,
  SquadState,
} from "./pipeline/types";
import {
  TEAM_OPS_APPLY_DEGRADED_PREFIX,
  TEAM_OPS_HANDLED_BY,
  applyGenerateTeams,
  type EngineGenerateTeamsWrite,
  type TeamOpsApplyDeps,
} from "./team-ops-engine";

export { TEAM_OPS_APPLY_DEGRADED_PREFIX, TEAM_OPS_HANDLED_BY };

/** The routes this module can own. From `route-flags.ts`, so the flag
 *  and the owner cannot disagree about the list. */
export const TEAM_OPS_ROUTES = TEAM_OPS_ENGINE_ROUTES;

/** The team ACTIONS this module owns, from the same file, so the split
 *  with `answer-batch.ts` lives in one place and cannot drift. */
export const TEAM_OPS_ACTIONS = TEAM_OPS_TEAM_ACTIONS;

export interface TeamOpsBatchMessage {
  waMessageId: string;
  body: string;
  authorName: string | null;
  /** Resolved sender, or null for an unknown pushname / opaque @lid.
   *  Used for `AttendanceEvent.actorUserId` and for "me"/"myself"
   *  rebinding in the engine; null is not a disqualifier. */
  senderUserId: string | null;
  senderName: string | null;
  /** Did this message @-mention the bot? The interaction-contract signal. */
  tagged: boolean;
  /** From the router. `undefined` when it never mentioned this id. */
  route: Route | undefined;
  /** Did step 5's gate skip this message? Then this never sees it. */
  gated: boolean;
}

export interface TeamOpsMessageOutcome {
  waMessageId: string;
  route: Route;
  reply: string | null;
  react: string | null;
  /**
   * `AnalyzedMessage.intent`, in the vocabulary the admin log already
   * speaks — AND a cross-module contract: `route.ts:2357` skips exactly
   * `generate_teams_request` and `show_teams_request` when composing the
   * squad post over a reply. A team post labelled anything else would
   * have its two numbered lists read as a roster and be REPLACED by the
   * squad roster.
   */
  intent: string;
  /** `AnalyzedMessage.action`. */
  action: string;
  /** Machine reasons, one per rule that fired. Never prose for a regex
   *  to parse — nothing in this codebase parses it. */
  reasoning: string;
  /** The match the balancer ran against, for the audit trail. */
  matchId: string | null;
  /** The `TeamAssignment` rows were actually written. */
  teamsGenerated: boolean;
  /** The write threw. The caller must not say anything cheerful. */
  writeFailed: boolean;
}

export interface TeamOpsBatchResult {
  ownedIds: Set<string>;
  outcomes: Map<string, TeamOpsMessageOutcome>;
  /** The match teams were generated for, or null. */
  generatedMatchId: string | null;
  degradations: string[];
  cost: { usd: number; calls: number; ms: number };
}

export interface TeamOpsBatchDeps extends TeamOpsApplyDeps {
  /** Injected so tests can drive the whole batch without a key. */
  model?: PipelineModel;
  /** Injected so tests can load a state without a database. */
  loadState?: (orgId: string, now: Date) => Promise<SquadState>;
  /** `SquadState.features` carries attendance / paymentTracking /
   *  statsQa / reminders; the team post needs `teamBalancing`, which
   *  lives here — the same seam `answer-batch.ts` uses. */
  loadFeatures?: (orgId: string) => Promise<OrgFeatures>;
  /** Injected so a test can prove the write assertion and the
   *  throw-safety without a fabricated rule in the real engine. */
  decide?: (input: EngineInput) => EngineResult;
}

/**
 * "This module owns nothing; nothing else in the request will speak for
 * these messages either."
 *
 * A FUNCTION, not a shared const, for the reason steps 6 and 7's are:
 * the result carries a `Set` and a `Map`, and one frozen-by-convention
 * instance handed to every caller is one `.add()` away from leaking one
 * request's state into the next. It takes the accumulated degradations
 * so a decline never loses the reason it happened — and after §10 step 8
 * those lines are `composeOperatorNote`'s only source for the "why" it
 * prints beside each lost message, so losing them would leave an admin
 * told that something went wrong and not what.
 */
function empty(degradations: string[] = []): TeamOpsBatchResult {
  return {
    ownedIds: new Set(),
    outcomes: new Map(),
    generatedMatchId: null,
    degradations,
    cost: { usd: 0, calls: 0, ms: 0 },
  };
}

export async function runTeamOpsBatch(args: {
  orgId: string;
  now: Date;
  messages: TeamOpsBatchMessage[];
  history: Array<{ author: string | null; body: string }>;
  /** The routes this request has enabled, resolved by the caller (which
   *  also knows about the test-only per-request override). */
  enabled: Set<Route>;
  deps: TeamOpsBatchDeps;
}): Promise<TeamOpsBatchResult> {
  const { orgId, now, messages, history, enabled, deps } = args;
  const t0 = Date.now();

  // ── Ownership, part 1: everything knowable without a model ─────────
  const candidates = messages.filter(
    (m) => !m.gated && stepSevenOwnsRoute(m.route, enabled, TEAM_OPS_ROUTES) && m.tagged,
  );
  if (candidates.length === 0) return empty();

  const degradations: string[] = [];

  let state: SquadState;
  try {
    state = deps.loadState
      ? await deps.loadState(orgId, now)
      : await (await import("./pipeline/load-state")).loadSquadState(orgId, now);
  } catch (err) {
    const detail = `${TEAM_OPS_APPLY_DEGRADED_PREFIX} state load failed (${
      err instanceof Error ? err.message : String(err)
    }); nothing was said about the teams`;
    console.error("[team-ops-engine] state load failed:", err);
    return empty([detail]);
  }

  let features: OrgFeatures;
  try {
    features = deps.loadFeatures
      ? await deps.loadFeatures(orgId)
      : await (await import("./org-features")).getOrgFeatures(orgId);
  } catch (err) {
    const detail = `${TEAM_OPS_APPLY_DEGRADED_PREFIX} feature load failed (${
      err instanceof Error ? err.message : String(err)
    }); nothing was said about the teams`;
    console.error("[team-ops-engine] feature load failed:", err);
    return empty([detail]);
  }

  // ── THE ORG GATE, OWNED RATHER THAN HANDED BACK ────────────────────
  //
  // `route.ts:3113-3128` maps BOTH team intents onto the `teamBalancing`
  // FeatureKey and, when it is off, returns `{react: null, reply: null}`
  // — the bot is completely silent on that capability, which is how a
  // MoM-and-ratings-only group runs. This module owns that silence
  // rather than handing the message on, for two reasons: with the
  // mega-prompt gone, "handed back" means an operator DM about a feature
  // an admin deliberately turned OFF, which is noise; and the gate is
  // ACTION-BLIND, so distinguishing `show` from `generate` first would
  // cost an extractor call on a message guaranteed to say nothing.
  //
  // This is therefore the ONE case in which this module owns a `show`.
  // It is also the one case in which owning it changes nothing: the
  // outcome is silence either way.
  if (!features.teamBalancing) {
    const outcomes = new Map<string, TeamOpsMessageOutcome>();
    for (const m of candidates) {
      outcomes.set(m.waMessageId, {
        waMessageId: m.waMessageId,
        route: m.route as Route,
        reply: null,
        react: null,
        intent: "noise",
        action: "none",
        reasoning: `${TEAM_OPS_HANDLED_BY} (${m.route}): team balancing is off for this org; ` +
          `MatchTime is deliberately silent on this capability`,
        matchId: null,
        teamsGenerated: false,
        writeFailed: false,
      });
    }
    return {
      ownedIds: new Set(candidates.map((m) => m.waMessageId)),
      outcomes,
      generatedMatchId: null,
      degradations,
      cost: { usd: 0, calls: 0, ms: Date.now() - t0 },
    };
  }

  // ── Stage 2: extractors, in parallel ───────────────────────────────
  //
  // MatchTime's own last post comes from the HISTORY the Pi forwards,
  // falling back to the last queued group `BotJob` the state loader
  // read — the precedence step 6 established, for a measured reason.
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
      const res = await extractForRouteTraced("team_ops", model, m.route as Route, {
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
        degradations.push(
          `${TEAM_OPS_APPLY_DEGRADED_PREFIX} ${m.waMessageId}: ${failure.detail} — ` +
            `no teams were generated and nothing was said`,
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
  // it gets no entry in `outcomes`, and its reason is already in
  // `degradations` before the `continue` runs.
  const ownedIds = new Set<string>();
  for (const m of candidates) {
    const facts = factsById.get(m.waMessageId);
    if (!facts) continue; // extraction failed; already reported above.
    const hand = (why: string) =>
      degradations.push(
        `${TEAM_OPS_APPLY_DEGRADED_PREFIX} ${m.waMessageId}: ${why} — ` +
          `this module said nothing about it`,
      );

    if (facts.kind !== "teams") {
      hand(`the teams extractor returned "${facts.kind}" facts`);
      continue;
    }
    if (!TEAM_OPS_ACTIONS.includes(facts.action)) {
      // `show` is `answer-batch.ts`'s and is expected here on every
      // "show the teams again"; `rename` and `swap` are nobody's, for
      // the reasons in the header. All three are one line in the log
      // rather than three shapes of silence.
      hand(
        `team action "${facts.action}" is not owned here ` +
          `(${facts.action === "show" ? "answer-batch.ts owns show" : "see this module's header"})`,
      );
      continue;
    }
    ownedIds.add(m.waMessageId);
  }
  if (ownedIds.size === 0) return empty(degradations);

  // ── ONE GENERATE PER BATCH, AND IT IS THE LAST ONE ─────────────────
  //
  // `route.ts:2084-2100`, reproduced: the earlier requests are OWNED
  // (so nothing else speaks for them) but produce a ⚽ react and no
  // reply, and only the last one reaches the engine with real facts.
  // Giving the earlier ones `{kind:"none"}` is what stops the engine
  // proposing a second `generate_teams` write — two balancer runs one
  // line apart, with two different line-ups, is the worst possible
  // answer to "generate the teams" asked twice.
  const orderedOwned = messages.filter((m) => ownedIds.has(m.waMessageId));
  const firingId = orderedOwned[orderedOwned.length - 1]?.waMessageId ?? null;
  const supersededIds = new Set(
    orderedOwned.slice(0, -1).map((m) => m.waMessageId),
  );

  // ── Stage 3: the engine, over the WHOLE window ─────────────────────
  //
  // Only owned messages are extracted, but every message in the batch
  // reaches `decide()`, for the reason steps 6 and 7 do it: taking a
  // message OUT of the window changes what the rest of the pipeline
  // concludes about its neighbours, and `assertCoverage` requires
  // exactly one outcome per input id.
  const engineMessages: EngineMessage[] = messages.map((m) => ({
    id: m.waMessageId,
    body: m.body,
    senderUserId: m.senderUserId,
    senderName: m.senderName ?? m.authorName,
    tagged: m.tagged,
    route: m.route ?? "none",
    facts:
      m.waMessageId === firingId
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
    // analyze request: nothing has been written, so owning nothing costs
    // the batch its teams and costs the database no corruption.
    //
    // NOT a "fail-open" — the word its siblings used while there was an
    // analyzer to fall open onto. Every `balancer`-generate message in
    // this window goes silent and onto the operator note. No retry
    // either: `decide()` is pure, so the same input throws the same way.
    const detail = `${TEAM_OPS_APPLY_DEGRADED_PREFIX} the engine threw (${
      err instanceof Error ? err.message : String(err)
    }); no teams were generated`;
    console.error("[team-ops-engine] the engine threw:", err);
    return empty([...degradations, detail]);
  }
  for (const d of result.degradations) {
    degradations.push(`[${d.stage}${d.messageId ? ` ${d.messageId}` : ""}] ${d.detail}`);
  }

  // ── THE WRITE ASSERTION ────────────────────────────────────────────
  //
  // This path has ONE apply layer and it knows one kind of write. A
  // `balancer`-routed message cannot produce an attendance write today —
  // `handleTeams` contains no other `emit()` — which is exactly why it
  // is asserted rather than assumed. A write of another kind reaching
  // here would have no authorisation pass, no `AttendanceEvent` and
  // nowhere to land, and it would be LOST rather than refused. Four
  // seatbelts were found dead on 2026-08-31, all with comments claiming
  // they worked; this one refuses the whole batch and says so.
  const teamWrites: EngineGenerateTeamsWrite[] = [];
  const foreign: string[] = [];
  for (const w of result.writes) {
    if (w.kind !== "generate_teams") {
      foreign.push(w.kind);
    } else if (w.sourceMessageId !== firingId) {
      // Belt and braces: only the firing message was given facts, so
      // only it can produce a write. Belt and braces is the right amount
      // for a path that rewrites every `TeamAssignment` on the match.
      foreign.push(`${w.kind} (from a message that was not the firing one)`);
    } else {
      teamWrites.push(w);
    }
  }
  if (foreign.length > 0) {
    const detail =
      `${TEAM_OPS_APPLY_DEGRADED_PREFIX} the engine proposed ${foreign.length} write(s) this ` +
      `path cannot apply (${[...new Set(foreign)].join(", ")}); owning nothing and saying nothing`;
    console.error(`[team-ops-engine] ${detail}`);
    return empty([...degradations, detail]);
  }

  // ── Stage 3b: THE TARGET MATCH, then APPLY ─────────────────────────
  //
  // Resolved through the injected selector, which is the SHIPPED query
  // (`route.ts:3553-3560`) and NOT `SquadState.matchId` — see
  // `TeamOpsApplyDeps.selectTeamsMatch` for why the two are kept apart.
  // Asked for only when there is a write, so a batch that owns a
  // superseded duplicate and nothing else costs no query.
  const replyByMessage = new Map<string, string>();
  const reactByMessage = new Map<string, string>();
  const failedIds = new Set<string>();
  const generatedIds = new Set<string>();
  let generatedMatchId: string | null = null;
  let targetMatchId: string | null = null;

  // ── AN OWNED MESSAGE THAT DOES NOTHING IS NOT OWNED ────────────────
  //
  // The firing message reached `decide()` with real `teams` facts,
  // `action === "generate"` and `tagged === true`, and `handleTeams`
  // emits unconditionally on that combination — so a firing id with no
  // write is unreachable today. It is asserted anyway, for the reason
  // the write assertion above is: "unreachable" is what the comments on
  // four dead seatbelts said, and the failure it would produce is
  // "message understood, action silently not taken" (§9), which is this
  // product's signature failure rather than a visible bug.
  if (firingId !== null && teamWrites.length === 0) {
    const detail =
      `${TEAM_OPS_APPLY_DEGRADED_PREFIX} ${firingId}: owned as a generate request but the ` +
      `engine proposed no write; owning nothing rather than going silent`;
    console.error(`[team-ops-engine] ${detail}`);
    return empty([...degradations, detail]);
  }

  if (teamWrites.length > 0) {
    try {
      targetMatchId = (await deps.selectTeamsMatch(orgId, now))?.id ?? null;
    } catch (err) {
      // A selector that threw is not "no match lined up" — saying the
      // shipped no-match sentence over a database error would be a
      // confident claim nothing checked. Silence, and the operator hears
      // why.
      const detail = `${TEAM_OPS_APPLY_DEGRADED_PREFIX} the match lookup failed (${
        err instanceof Error ? err.message : String(err)
      }); no teams were generated and nothing was said`;
      console.error("[team-ops-engine] match lookup failed:", err);
      return empty([...degradations, detail]);
    }
  }

  for (const w of teamWrites) {
    const sender = messages.find((m) => m.waMessageId === w.sourceMessageId);
    const applied = await applyGenerateTeams({
      matchId: targetMatchId,
      write: w,
      actorUserId: sender?.senderUserId ?? null,
      deps,
      lang: state.features.language,
    });
    if (applied.failed) {
      degradations.push(
        `${TEAM_OPS_APPLY_DEGRADED_PREFIX} ${w.sourceMessageId}: generating the teams on ` +
          `match ${targetMatchId ?? "(none)"} failed (${applied.error}); NOTHING was posted`,
      );
      failedIds.add(w.sourceMessageId);
      continue;
    }
    if (applied.reply) replyByMessage.set(w.sourceMessageId, applied.reply);
    if (applied.react) reactByMessage.set(w.sourceMessageId, applied.react);
    if (applied.generated) {
      generatedIds.add(w.sourceMessageId);
      generatedMatchId = applied.matchId;
    }
    if (applied.unmatchedNoted.length > 0) {
      // In the group post AND in the operator log: a name MatchTime
      // could not place is the shape a human has to fix by hand.
      degradations.push(
        `${TEAM_OPS_APPLY_DEGRADED_PREFIX} ${w.sourceMessageId}: could not place ` +
          `${applied.unmatchedNoted.join(", ")}; they were reported to the group and ignored`,
      );
    }
  }

  // ── Stage 4: composition, AFTER the apply ──────────────────────────
  //
  // `handleTeams`'s generate branch pushes NO speech intent — the group
  // post is the balancer's own output and the composer cannot render it
  // from `SquadState`, because the line-ups do not exist until the write
  // has run. `compose()` is still called, for its operator notes and so
  // that a batch-level post appearing on this path is DROPPED and
  // RECORDED rather than sent beside the team sheet.
  const composed = compose(result);
  for (const u of composed.utterances) {
    if (u.messageId === null) {
      degradations.push(
        `${TEAM_OPS_APPLY_DEGRADED_PREFIX} a batch-level post was composed on the team path; dropped`,
      );
      continue;
    }
    if (!ownedIds.has(u.messageId)) continue;
    // An utterance for an owned id means `handleTeams` grew a speech
    // intent this module does not know how to place beside the team
    // post. Recorded rather than appended: two posts for one message is
    // §3.2 S36.
    degradations.push(
      `${TEAM_OPS_APPLY_DEGRADED_PREFIX} ${u.messageId}: the composer produced an utterance on ` +
        `the team path; dropped in favour of the balancer's own post`,
    );
  }
  for (const n of composed.operatorNotes) {
    if (!degradations.includes(n)) degradations.push(n);
  }

  // ── Per-message outcomes ───────────────────────────────────────────
  const outcomes = new Map<string, TeamOpsMessageOutcome>();
  for (const m of messages) {
    if (!ownedIds.has(m.waMessageId)) continue;
    const engineOutcome = result.outcomes.find((o) => o.messageId === m.waMessageId);
    const machineReasons = (engineOutcome?.reasons ?? []).join("; ");
    const superseded = supersededIds.has(m.waMessageId);
    const failed = failedIds.has(m.waMessageId);

    if (superseded) {
      // `route.ts:2088-2100` verbatim: intent `noise`, react ⚽, no
      // reply, and every team field cleared.
      outcomes.set(m.waMessageId, {
        waMessageId: m.waMessageId,
        route: m.route as Route,
        reply: null,
        react: "⚽",
        intent: "noise",
        action: "react",
        reasoning:
          `${TEAM_OPS_HANDLED_BY} (${m.route}): an earlier duplicate generate-teams request; ` +
          `the last one in the batch generates for everyone`,
        matchId: null,
        teamsGenerated: false,
        writeFailed: false,
      });
      continue;
    }

    // §3.2 S7: a write that threw says NOTHING at all. Not the shipped
    // refusal sentence either — that sentence is a statement about the
    // squad, and a failed apply knows nothing about the squad.
    const reply = failed ? null : (replyByMessage.get(m.waMessageId) ?? null);
    const react = failed ? null : (reactByMessage.get(m.waMessageId) ?? null);
    const generated = generatedIds.has(m.waMessageId);

    outcomes.set(m.waMessageId, {
      waMessageId: m.waMessageId,
      route: m.route as Route,
      reply,
      react,
      // The cross-module contract: `route.ts:2357` must recognise this
      // as a team post so the squad composer leaves its two numbered
      // lists alone.
      intent: "generate_teams_request",
      // Derived exactly as `route.ts:2197-2200` derives it. "none" would
      // make every generated line-up look like a no-op to anything
      // filtering the admin log, including the nightly sweep.
      action: generated ? "generate_teams" : react ? "react" : reply ? "reply" : "none",
      reasoning:
        `${TEAM_OPS_HANDLED_BY} (${m.route}): ${machineReasons || "no rule fired"}` +
        (failed ? "; the team generation FAILED and nothing was posted" : ""),
      matchId: targetMatchId,
      teamsGenerated: generated,
      writeFailed: failed,
    });
  }

  return {
    ownedIds,
    outcomes,
    generatedMatchId,
    degradations,
    cost: { ...cost, ms: Date.now() - t0 },
  };
}

/**
 * WHAT THE TEAM-OPS ENGINE DID, AND WHAT IT LOST, as lines for the
 * operator.
 *
 * Pure and exported for the reason `describeScoreBatch` is: the same
 * lines were once composed behind `if (ownedIds.size > 0)`, which
 * silences them in exactly the case they exist for — a batch where every
 * extraction failed ends with `ownedIds` empty, and `empty(degradations)`
 * goes out of its way to carry the reasons through that early return
 * precisely so they could be printed.
 */
export function describeTeamOpsBatch(
  batch: TeamOpsBatchResult,
  batchSize: number,
): { warns: string[]; info: string | null } {
  const warns = batch.degradations.map((d) => `[analyze] team-ops-engine degraded: ${d}`);
  const info =
    batch.ownedIds.size > 0 || batch.degradations.length > 0
      ? `[analyze] team-ops-engine: decided ${batch.ownedIds.size}/${batchSize} message(s), ` +
        `generated teams for match ${batch.generatedMatchId ?? "(none)"}, ` +
        `$${batch.cost.usd.toFixed(5)} across ${batch.cost.calls} extractor call(s) ` +
        `in ${batch.cost.ms}ms`
      : null;
  return { warns, info };
}
