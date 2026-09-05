/**
 * §10 STEP 7 — `question` AND `balancer`, END TO END.
 *
 *   router → extractor → engine → composer
 *
 * and, deliberately, no fifth box. Step 6's chain ends in APPLY because
 * an attendance message changes the squad. These two routes do not:
 * answering "how many are we?" and re-posting the teams that already
 * exist are READS. That is the whole safety argument for this step and
 * it is structural rather than promised — `__tests__/zero-writes.test.ts`
 * scans every file in this directory for a mutation on every build, and
 * `runAnswerBatch` additionally refuses to own anything at all if the
 * engine ever hands it a write (see THE WRITE ASSERTION below).
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY THESE TWO ROUTES, AND NOT ALL FOUR
 * ─────────────────────────────────────────────────────────────────────
 * §10 step 7 names four: `question`, `team_ops`, `score`, `admin_ops`,
 * "one per week". Two of them arrive here and two do not, for reasons
 * that were measured rather than assumed:
 *
 *   • `score` writes `Match.redScore/yellowScore` AND runs the Elo
 *     deltas (`route.ts:3505-3523`, `elo.ts:34`). Two behaviours would
 *     also have to move with it: the shipped path deliberately accepts
 *     a score from an UNRESOLVED sender ("losing the score entirely is
 *     a worse failure mode", `route.ts:3450-3457`) where the engine
 *     refuses one, and it selects its target from `TEAMS_PUBLISHED |
 *     TEAMS_GENERATED | COMPLETED` where `SquadState.completedMatch`
 *     only ever holds a `COMPLETED` one. Neither is hard; both are
 *     write-path changes and belong beside their own apply layer.
 *   • `admin_ops` is real money on a live club (S21 — `PaymentCredit`,
 *     `Attendance.paidAt`) plus a reminder whose time phrase still has
 *     to become a datetime. The engine models the phrase exactly as
 *     §3.2 S22 asks and hands it on; nothing resolves it yet, and
 *     `date-fns-tz` doing that resolution is new code on a path that
 *     queues a DM. It also has four guards the engine does not carry —
 *     the `reminders` feature gate, the `subReminderDm` opt-out, the
 *     missing-phone branch and the 60-day window (`route.ts:3925-3995`).
 *
 * Shipping those two here would mean an apply layer, an authorisation
 * pass and a calendar resolver landing in the same change as the read
 * paths, and §10's own ordering rationale is "free wins, then evidence,
 * then TEXT, then reads, then the write". These are the reads.
 *
 * ─────────────────────────────────────────────────────────────────────
 * FAIL OPEN, ALWAYS — the same rule as step 6
 * ─────────────────────────────────────────────────────────────────────
 * Every failure mode lands on "the analyzer decides this message",
 * which is today's behaviour and therefore cannot be a regression:
 *
 *   • the route's flag is off                 → owns nothing
 *   • the message is untagged                 → owns nothing (see below)
 *   • step 5's gate skipped it                → owns nothing
 *   • the router never mentioned the id       → owns nothing
 *   • no active registration match            → owns nothing
 *   • attendance is off for the org           → owns nothing
 *   • team balancing is off for the org       → owns no team post
 *   • the state load threw                    → owns nothing
 *   • the extractor call threw                → THAT message is handed
 *                                               back to the analyzer
 *   • the extracted shape is one the composer
 *     cannot answer well                      → handed back
 *   • the engine threw, or proposed a write   → owns nothing
 *
 * THE TAG GATE IS NOT REIMPLEMENTED HERE — this module requires a tag
 * unconditionally rather than calling `actionRequiresTag`. That is
 * strictly MORE conservative than the contract for these two routes,
 * not a second copy of it: `question` and both team intents are in
 * `ACTIONY_INTENTS` (`interaction-contract.ts:149-156`), so the shipped
 * gate at `route.ts:1553-1592` already refuses an untagged one before
 * any of this could matter. Requiring `m.tagged` means there is nothing
 * here that could drift away from that policy if it changes — the worst
 * this can do is own less — and it saves an extractor call on every
 * untagged question in the group, which is most of them.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE ENGINE SEES THE WHOLE WINDOW
 * ─────────────────────────────────────────────────────────────────────
 * Only owned messages are extracted, but every message in the batch
 * reaches `decide()`, for the same reason step 6 does it: taking a
 * message OUT of the window changes what the rest of the pipeline
 * concludes about its neighbours, and `assertCoverage` requires exactly
 * one outcome per input id. A message this module does not own arrives
 * with `facts: {kind:"none"}` and produces a `noop` with a reason.
 */
// ── ONE IMPORT RULE, AND IT IS LOAD-BEARING ──────────────────────────
//
// Nothing that reaches the Prisma client may be imported STATICALLY
// here. `compose.ts`'s header records why: the Playwright worker never
// loads Prisma (`e2e/sim/group.ts` talks plain SQL), and the corpus
// judges this module from that worker. A static
// `import { getOrgFeatures } from "../org-features"` pulls in
// `src/lib/db.ts` → the generated client, and the whole spec file dies
// at load with "exports is not defined in ES module scope" — before a
// single model call, so the sweep reports "no tests found" rather than
// a failure anyone can read. Measured here on 2026-09-05.
//
// So the two database-backed defaults are `await import`ed inside the
// function, and only when the caller did not inject them. The analyze
// route (which has Prisma) gets the real loaders; the corpus injects
// its SQL ones and never touches Prisma at all.
import type { OrgFeatures } from "../org-features";
import { compose } from "./compose";
import { decide as decideDefault } from "./engine";
import { extractForRoute } from "./extractors";
import { extractorStubFromEnv } from "./extractor-stub";
import { resolvePerson } from "./identity";
import { anthropicModel, type PipelineModel } from "./llm";
import { STEP_SEVEN_ROUTES, stepSevenOwnsRoute } from "./route-flags";
import type {
  EngineInput,
  EngineMessage,
  EngineResult,
  Facts,
  ProposedWrite,
  QuestionTopic,
  Route,
  SquadState,
} from "./types";

/** The routes this module can own. Re-exported from `route-flags.ts` so
 *  the flags and the owner cannot disagree about the list. */
export const ANSWER_ROUTES = STEP_SEVEN_ROUTES;

/**
 * The question topics answered from the database, and nothing else.
 *
 * §6 of the redesign says it in one sentence: *"squad/bench/phone
 * answers become deterministic and only free-form stats need a model
 * call."* This constant is that sentence.
 *
 * `stats` and `options` are absent for a MEASURED reason, not a
 * cautious one, and `__tests__/answer-batch.test.ts` pins both:
 *
 *   • `compose.ts`'s stats answer renders `1. Kemal Ediz (24)` lines.
 *     `isLeaderboardLine` (`group-copy.ts:129`) recognises a leaderboard
 *     by an em dash, a percentage, "wins/votes/matches" or an "N/M ("
 *     pattern, and that shape carries none of them — so
 *     `displaysSquadState` sees a numbered run and the shipped step-4
 *     composer would REPLACE a "most consistent" answer with the
 *     upcoming-squad roster. That is precisely the 2026-05-14 incident
 *     §3.2 S16 was written for. It is a defect in the composer's
 *     FORMAT, worth its own change; until then the analyzer keeps
 *     stats, where the Recent History block gives it MoM winners, an
 *     all-time leaderboard and Elo that `SquadState.appearances` does
 *     not hold at all.
 *   • the options answer leads with "We're 8/14, need 6 more", which is
 *     rule (c) of `displaysSquadState`. `composeSquadStateReply` keeps a
 *     lead only when it makes no claim of its own, so the whole
 *     answer — including the arithmetic `format-switch.ts` computed —
 *     would be dropped rather than appended to.
 *
 * `other` is absent because a topic the extractor could not place is
 * exactly the case §14.3 calls "the least designed part of this
 * document". A silent shrug is the failure this design exists to
 * remove, so it goes back to the prompt that can still try.
 */
export const ANSWERABLE_TOPICS: readonly QuestionTopic[] = [
  "count",
  "bench",
  "person_status",
  "phones",
];

/**
 * `squad` — "who's playing / show me the list" — is NOT in that set, and
 * this is the one place §6's sentence is not honoured in full.
 *
 * `engine.ts:701-716` sends `squad` and `count` to the same
 * `answer_count` speech intent, which renders "We're 11/14 for Tue
 * 21:30, need 3 more". That is the right answer to "how many are we?"
 * and a poor one to "who's playing?" — nobody is named. In the wired
 * system it READS correctly only because that string trips
 * `displaysSquadState` and `route.ts:2393` swaps it for the roster post;
 * lean on that and the answer degrades to a bare count on two real
 * paths, the composition pass being inside a `try/catch` and its
 * `if (nextMatchForReply)` guard using a different match selector from
 * this module's.
 *
 * Relying on a regex in another module to turn a count into a roster is
 * the opposite of §6.4. The fix is an `answer_squad` intent rendering
 * `composeSquadStatusPost` directly — a composer change, and it belongs
 * with the `stats` and `options` format fixes above rather than being
 * smuggled into an ownership layer.
 */

/**
 * Could ANY other message in this batch change the squad before the
 * answer is read?
 *
 * Every answer this module composes is rendered from the state loaded at
 * the top of the batch, and this module runs BEFORE `analyzeBatch` and
 * before `executeVerdict` — so a write later in the same batch lands
 * after the answer is composed. §3.2 S36's single-post rule stops two
 * SQUAD POSTS contradicting each other, and `composeSquadStateReply`
 * catches a reply that displays squad state. Neither catches
 * "Yes, Idris has a slot for Tue 21:30" sent in the same window as
 * Idris's own "sorry lads can't make it": it is a squad CLAIM, not a
 * squad post, and no shape in `MOVE_CLAIM_PATTERNS` matches it.
 *
 * So no question is owned in a batch that carries anything else. The
 * test is the ROUTE, not the content: anything not on one of step 7's
 * own routes might write, including a `none` the gate did not skip (the
 * gate is off, so the analyzer still sees it) and an id the router never
 * mentioned. Conservative on purpose — it costs one extractor call on a
 * mixed batch and it removes a whole class of contradiction.
 *
 * It also means step 7 is designed to run BEHIND step 5: with
 * `ROUTER_GATE_ENABLED` off, ordinary banter counts as "anything else"
 * and questions are rarely owned. That is stated rather than hidden.
 */
function batchCarriesAnythingElse(messages: AnswerBatchMessage[]): boolean {
  return messages.some(
    (m) => !m.gated && m.route !== "question" && m.route !== "balancer",
  );
}

/**
 * Prefix on every degradation this module reports.
 *
 * ⚠️ LOG-ONLY TODAY, and saying so matters: step 6's equivalent
 * (`ENGINE_APPLY_DEGRADED_PREFIX`) is in `OFFLINE_REASON_PREFIXES`
 * (`route.ts:957-972`) and reaches the partial-response admin DM,
 * because `route.ts:919` puts it into a placeholder verdict's
 * `reasoning`. Nothing does that for this prefix yet — it has no
 * consumer outside this file. §9 asks for a TYPED marker instead of
 * prefix-matched prose and this is the marker; the wiring commit is what
 * makes it load-bearing, by adding it to that list. Until then this
 * comment describes an intention, not a mechanism, which is the only
 * honest thing a comment about a guard can say when the guard is not
 * connected.
 */
export const ANSWER_DEGRADED_PREFIX = "answer-engine: degraded —";

/** `AnalyzedMessage.handledBy` for a message this module decided. The
 *  AUDIT field, not the wire field — same split step 5 made for
 *  `router-gate` and step 6 for `attendance-engine`. */
export const ANSWER_HANDLED_BY = "answer-engine";

export interface AnswerBatchMessage {
  waMessageId: string;
  body: string;
  authorName: string | null;
  /** Resolved sender, or null for an unknown pushname / opaque @lid. */
  senderUserId: string | null;
  senderName: string | null;
  /** Did this message @-mention the bot? The interaction-contract signal. */
  tagged: boolean;
  /** From the router. `undefined` when it never mentioned this id. */
  route: Route | undefined;
  /** Did step 5's gate skip this message? Then step 7 never sees it. */
  gated: boolean;
}

/** What the analyze route needs in order to turn one owned message into
 *  exactly one `ActionForBot` and one `AnalyzedMessage` row. */
export interface AnswerMessageOutcome {
  waMessageId: string;
  route: Route;
  reply: string | null;
  react: string | null;
  /**
   * `AnalyzedMessage.intent`, in the vocabulary the admin log already
   * speaks — AND a cross-module contract: `route.ts:2357` skips exactly
   * `generate_teams_request` and `show_teams_request` when composing
   * the squad post over a reply. A team post labelled anything else
   * would have its two numbered lists read as a roster and be replaced
   * by the squad roster.
   */
  intent: string;
  /** `AnalyzedMessage.action`. Always "none": this path never writes. */
  action: string;
  /** Machine reasons, one per rule that fired. Never prose for a regex
   *  to parse — nothing in this codebase parses it. */
  reasoning: string;
}

export interface AnswerBatchResult {
  ownedIds: Set<string>;
  outcomes: Map<string, AnswerMessageOutcome>;
  /** Always empty. Present so a caller can assert it rather than trust
   *  this comment, and so the shape matches the attendance batch. */
  writes: ProposedWrite[];
  matchId: string | null;
  degradations: string[];
  cost: { usd: number; calls: number; ms: number };
}

export interface AnswerBatchDeps {
  /** Injected so tests can drive the whole batch without a key. */
  model?: PipelineModel;
  /** Injected so tests can load a state without a database. */
  loadState?: (orgId: string, now: Date) => Promise<SquadState>;
  /** `SquadState.features` carries attendance / paymentTracking /
   *  statsQa; the team post needs `teamBalancing`, which lives here. */
  loadFeatures?: (orgId: string) => Promise<OrgFeatures>;
  /** Injected so a test can prove the write assertion and the
   *  throw-safety without a fabricated engine rule in the real engine. */
  decide?: (input: EngineInput) => EngineResult;
}

/**
 * "This module owns nothing; the analyzer keeps the batch."
 *
 * A FUNCTION, not a shared const, for the same reason step 6's is: the
 * result carries a `Set` and a `Map`, and one frozen-by-convention
 * instance handed to every caller is one `.add()` away from leaking one
 * request's state into the next. It takes the accumulated degradations
 * so a fail-open never loses the reason it happened.
 */
function empty(degradations: string[] = []): AnswerBatchResult {
  return {
    ownedIds: new Set(),
    outcomes: new Map(),
    writes: [],
    matchId: null,
    degradations,
    cost: { usd: 0, calls: 0, ms: 0 },
  };
}

export async function runAnswerBatch(args: {
  orgId: string;
  now: Date;
  messages: AnswerBatchMessage[];
  history: Array<{ author: string | null; body: string }>;
  /**
   * The match the ROUTE believes registration lands on. Same contract
   * as step 6: if the two selectors ever disagree, this module owns
   * nothing rather than describing a different match than the rest of
   * the request.
   */
  expectedMatchId: string | null;
  /** The routes this request has enabled, resolved by the caller (which
   *  also knows about the test-only per-request override). */
  enabled: Set<Route>;
  deps: AnswerBatchDeps;
}): Promise<AnswerBatchResult> {
  const { orgId, now, messages, history, expectedMatchId, enabled, deps } = args;
  const t0 = Date.now();

  // ── Ownership, part 1: everything knowable without a model ─────────
  const candidates = messages.filter(
    (m) => !m.gated && stepSevenOwnsRoute(m.route, enabled) && m.tagged,
  );
  if (candidates.length === 0) return empty();

  const degradations: string[] = [];

  let state: SquadState;
  try {
    if (deps.loadState) {
      state = await deps.loadState(orgId, now);
    } else {
      const m = await import("./load-state");
      state = await m.loadSquadState(orgId, now);
    }
  } catch (err) {
    // Fail open. Owning nothing means the analyzer decides, which is
    // what happens today.
    const detail = `${ANSWER_DEGRADED_PREFIX} state load failed (${
      err instanceof Error ? err.message : String(err)
    }); the analyzer keeps the batch`;
    console.error("[answer-engine] state load failed:", err);
    return empty([detail]);
  }

  let features: OrgFeatures;
  try {
    if (deps.loadFeatures) {
      features = await deps.loadFeatures(orgId);
    } else {
      const m = await import("../org-features");
      features = await m.getOrgFeatures(orgId);
    }
  } catch (err) {
    const detail = `${ANSWER_DEGRADED_PREFIX} feature load failed (${
      err instanceof Error ? err.message : String(err)
    }); the analyzer keeps the batch`;
    console.error("[answer-engine] feature load failed:", err);
    return empty([detail]);
  }

  // ── The carve-outs, all in the "own nothing" direction ─────────────

  // Every answer this module composes is about the upcoming match — a
  // count, a bench, a person's place, the two line-ups. With no match
  // to describe, the composer would answer "0/0" from an empty state.
  if (!state.matchId) return empty();

  // `!== null` is NOT enough, and this differs from step 6 deliberately.
  // A null expectation means the ROUTE found no registration match while
  // this module found one — a disagreement, not an absence, and the one
  // that matters most: `route.ts:2353`'s squad-status composition is
  // guarded by `if (nextMatchForReply)`, so with the route seeing no
  // match nothing downstream would re-compose whatever is said here.
  if (state.matchId !== expectedMatchId) {
    const detail =
      `${ANSWER_DEGRADED_PREFIX} the route's registration match (${expectedMatchId ?? "none"}) ` +
      `and the engine's (${state.matchId}) disagree; owning nothing`;
    console.warn(`[answer-engine] ${detail}`);
    return empty([detail]);
  }

  // A MoM-and-ratings-only org (`featureAttendance` off) gets
  // `ATTENDANCE_OFF_OVERRIDE` appended to the mega-prompt
  // (`message-analyzer.ts:923`), which orders total silence on every
  // squad question — because MatchTime once told Sutton Lads "0/14 —
  // need 14 players" for a group that does not track a squad (Kemal,
  // 2026-06-08). A composer that answered from `rows` would be that
  // incident again, reached by a path that never read the override.
  if (!state.features.attendance) return empty();

  // Every answer this module composes divides by, or prints, the format
  // total. A `Match` with `maxPlayers` 0 would produce "We're 11/0" and
  // "need 0 more" — the same shape as the 2026-06-08 "0/14" the check
  // above exists for, arrived at from the other direction. It should be
  // impossible; the answer to something that should be impossible is to
  // hand it to the path that already handles it, not to print it.
  if (state.maxPlayers <= 0) {
    return empty([
      `${ANSWER_DEGRADED_PREFIX} match ${state.matchId} has maxPlayers=${state.maxPlayers}; ` +
        `owning nothing rather than composing an answer around it`,
    ]);
  }

  const matchId = state.matchId;

  // See `batchCarriesAnythingElse`. Two batch runners each calling
  // `decide()` cannot enforce §3.2 S36's single squad post between
  // them, and — the sharper half — an answer composed here is composed
  // from a PRE-WRITE snapshot, so a question answered beside an
  // attendance change is a claim about a squad that no longer exists.
  const otherTraffic = batchCarriesAnythingElse(messages);

  const eligible = candidates.filter((m) => {
    if (m.route === "balancer" && !features.teamBalancing) {
      degradations.push(
        `${ANSWER_DEGRADED_PREFIX} ${m.waMessageId}: team balancing is off for this org; ` +
          `handing this message back to the analyzer`,
      );
      return false;
    }
    return true;
  });
  if (eligible.length === 0) return empty(degradations);

  // ── Stage 2: extractors, in parallel ───────────────────────────────
  //
  // MatchTime's own last post comes from the HISTORY the Pi forwards,
  // falling back to the last queued group `BotJob` the state loader
  // read — the same precedence step 6 established, and for the same
  // measured reason (a corpus case went 3/3 → 0/3 when the two
  // disagreed).
  const model = deps.model ?? extractorStubFromEnv() ?? anthropicModel();
  const lastBotPost =
    [...history].reverse().find((h) => (h.author ?? "").toLowerCase() === "matchtime")?.body ??
    state.lastBotPost ??
    null;
  state = { ...state, lastBotPost };

  let cost = { usd: 0, calls: 0, ms: 0 };
  const factsById = new Map<string, Facts>();
  await Promise.all(
    eligible.map(async (m) => {
      const res = await extractForRoute(model, m.route as Route, {
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
        // §11.4 says "fail closed and surface it". Closed here would
        // mean SILENT — a question asked and no answer given, which is
        // this product's signature failure. The analyzer is still
        // standing beside this path and nothing has been written or
        // sent, so the message simply goes back to it. That is the
        // step's own revert, applied per message and automatically.
        degradations.push(
          `${ANSWER_DEGRADED_PREFIX} ${m.waMessageId}: ${failure.detail} — ` +
            `handing this message back to the analyzer`,
        );
        return;
      }
      factsById.set(m.waMessageId, res.facts);
    }),
  );

  // ── Ownership, part 2: shapes only visible after extraction ────────
  //
  // Each rejection below is "the analyzer answers this one", never "the
  // bot says nothing". Enumerated rather than folded into one condition
  // so the reason survives into the log.
  //
  // ON THE `continue`s. Three defects this week came from a terminal
  // `continue` silently skipping every guard below it, so: the ONLY
  // effect of a full pass through this loop body is `ownedIds.add(...)`.
  // There is no write, no send, no state mutation and no later guard
  // inside it, so a `continue` can skip exactly one thing — ownership —
  // which is the intent. Everything a skipped message still needs
  // happens OUTSIDE the loop: it reaches `decide()` with
  // `facts: {kind:"none"}` (so `assertCoverage` still sees one outcome
  // per input id and the window is intact for its neighbours), it gets
  // no entry in `outcomes` (so the analyze route leaves its verdict
  // alone and the analyzer decides it), and its reason is already in
  // `degradations` before the `continue` runs.
  const ownedIds = new Set<string>();
  for (const m of eligible) {
    const facts = factsById.get(m.waMessageId);
    if (!facts) continue; // extraction failed; already reported above.
    const hand = (why: string) =>
      degradations.push(
        `${ANSWER_DEGRADED_PREFIX} ${m.waMessageId}: ${why} — ` +
          `handing this message back to the analyzer`,
      );

    if (m.route === "question") {
      if (facts.kind !== "question") {
        hand(`the question extractor returned "${facts.kind}" facts`);
        continue;
      }
      if (!ANSWERABLE_TOPICS.includes(facts.topic)) {
        hand(`question topic "${facts.topic}" is not answered from the database`);
        continue;
      }
      if (otherTraffic) {
        // EVERY topic, not just the squad-shaped ones. An answer here is
        // composed from a pre-write snapshot, and "Yes, Idris has a slot
        // for Tue 21:30" beside Idris's own "sorry lads can't make it"
        // is a claim about a squad that no longer exists — invisible to
        // `composeSquadStateReply`, which only recognises squad POSTS
        // and the `MOVE_CLAIM_PATTERNS` phrasings.
        hand(
          `the batch also carries messages this step does not own, which may change the ` +
            `squad after this answer is composed (S36, and the pre-write snapshot)`,
        );
        continue;
      }
      if (facts.topic === "person_status") {
        // "X isn't down for Tuesday yet" about somebody the roster
        // cannot identify — or about either of two people with the same
        // first name — is a confident claim about squad state that
        // nothing checked. That is the §3.2 S16 failure class, and
        // `identity.ts` already bails on exactly these two shapes.
        const r = resolvePerson(facts.personRef ?? "", state.roster);
        if (r.kind !== "resolved") {
          hand(`"${facts.personRef}" does not resolve to one member (${r.kind})`);
          continue;
        }
      }
      ownedIds.add(m.waMessageId);
      continue;
    }

    if (m.route === "balancer") {
      if (facts.kind !== "teams") {
        hand(`the teams extractor returned "${facts.kind}" facts`);
        continue;
      }
      if (facts.action !== "show") {
        // 2026-06-18 (`c408649`): "show the teams again" re-ran the
        // balancer and destroyed an admin's manual swap. SHOWING is a
        // read and there is no branch here that can write; GENERATING
        // rewrites `TeamAssignment`, force-includes named players into
        // the squad, moves `Match.status` and runs the rating adjuster
        // (a second model call). None of that belongs on a read path.
        hand(`team action "${facts.action}" still belongs to the balancer`);
        continue;
      }
      if (state.teams.length === 0) {
        // The shipped path answers "No teams generated yet — say
        // 'generate the teams' and I'll sort them." and its comment says
        // "do NOT auto-generate" (`route.ts:3728-3731`). `formatTeamsPost`
        // over two empty lists renders a teams post with no players in
        // it, so the shape is handed back rather than answered wrongly.
        hand("no teams have been generated for this match yet");
        continue;
      }
      ownedIds.add(m.waMessageId);
      continue;
    }
  }

  if (ownedIds.size === 0) return empty(degradations);

  // ── Stage 3: the engine, over the WHOLE window ─────────────────────
  const engineMessages: EngineMessage[] = messages.map((m) => ({
    id: m.waMessageId,
    body: m.body,
    senderUserId: m.senderUserId,
    senderName: m.senderName ?? m.authorName,
    tagged: m.tagged,
    // A message this module does not own still carries its real route so
    // its outcome says why nothing happened. `none` is honest for an id
    // the router never mentioned.
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
    // analyze request: nothing has been written and the analyzer batch
    // has not been decided, so owning nothing is a complete fail-open.
    const detail = `${ANSWER_DEGRADED_PREFIX} the engine threw (${
      err instanceof Error ? err.message : String(err)
    }); the analyzer keeps the batch`;
    console.error("[answer-engine] the engine threw:", err);
    return empty([...degradations, detail]);
  }
  // Pushed HERE rather than left to the composer, because the write
  // assertion below can return before `compose()` ever runs and a
  // fail-open must never lose the reason it happened. `compose()` folds
  // the same list into its `operatorNotes` (`compose.ts:328-330`), so
  // the fold below de-duplicates rather than reporting each one twice.
  for (const d of result.degradations) {
    degradations.push(`[${d.stage}${d.messageId ? ` ${d.messageId}` : ""}] ${d.detail}`);
  }

  // ── THE WRITE ASSERTION ────────────────────────────────────────────
  //
  // `handleQuestion` and `handleTeams` contain no `emit()`, so this
  // cannot fire today — which is exactly why it is asserted and not
  // assumed. There is no apply layer on this path: a write reaching
  // here would have no authorisation pass, no `AttendanceEvent` and
  // nowhere to land, and it would be LOST rather than refused. Four
  // seatbelts were found dead on 2026-08-31, all with comments claiming
  // they worked; this one refuses the whole batch and says so.
  if (result.writes.length > 0) {
    const kinds = [...new Set(result.writes.map((w) => w.kind))].join(", ");
    const detail =
      `${ANSWER_DEGRADED_PREFIX} the engine proposed ${result.writes.length} write(s) ` +
      `(${kinds}) from a read-only route; this path has no apply layer, so it owns ` +
      `nothing and the analyzer keeps the batch`;
    console.error(`[answer-engine] ${detail}`);
    return empty([...degradations, detail]);
  }

  // ── Stage 4: composition ───────────────────────────────────────────
  const composed = compose(result);
  const utteranceByMessageId = new Map<string, string[]>();
  for (const u of composed.utterances) {
    // A batch-level post (`messageId: null`) is the squad post, which
    // only a squad CHANGE produces — and this path makes none. If one
    // ever appeared it would be a second post beside the analyzer's, so
    // it is dropped and recorded rather than sent.
    if (u.messageId === null) {
      degradations.push(
        `${ANSWER_DEGRADED_PREFIX} a batch-level post was composed on a read-only path; dropped`,
      );
      continue;
    }
    if (!ownedIds.has(u.messageId)) continue;
    const list = utteranceByMessageId.get(u.messageId) ?? [];
    list.push(u.text);
    utteranceByMessageId.set(u.messageId, list);
  }
  const reactByMessageId = new Map(composed.reacts.map((r) => [r.messageId, r.emoji]));
  // De-duplicated: `compose()` re-emits `result.degradations` verbatim
  // in the same format they were pushed in above.
  for (const n of composed.operatorNotes) {
    if (!degradations.includes(n)) degradations.push(n);
  }

  // ── AN OWNED MESSAGE THAT SAYS NOTHING IS NOT OWNED ────────────────
  //
  // Ownership is decided before `decide()` runs, so an owned id that
  // produces no utterance would return a completely silent outcome —
  // "message understood, action silently not taken", the failure §9
  // calls this product's signature. Every owned topic speaks today, so
  // this is unreachable; it is asserted for the same reason the write
  // assertion is, and because the coincidence is fragile:
  // `engine.ts:923-931` drops the deferred question speech entirely
  // whenever a squad change is in the same `decide()` call, which is
  // exactly what a hybrid pipeline would produce.
  //
  // Built as a NEW set rather than by removing from `ownedIds`:
  // `__tests__/zero-writes.test.ts` scans this directory for
  // `.delete(`, and a `Set.delete` is indistinguishable from a Prisma
  // one to a source scanner. The scanner is right to be blunt — the
  // shape it is looking for is the one that can change a squad — so the
  // shape is avoided here rather than the scanner taught an exception.
  const silentIds = [...ownedIds].filter(
    (id) => (utteranceByMessageId.get(id) ?? []).length === 0,
  );
  for (const id of silentIds) {
    degradations.push(
      `${ANSWER_DEGRADED_PREFIX} ${id}: owned but composed nothing to say — ` +
        `handing this message back to the analyzer rather than going silent`,
    );
  }
  const spokenIds = new Set([...ownedIds].filter((id) => !silentIds.includes(id)));
  if (spokenIds.size === 0) return empty(degradations);

  // ── Per-message outcomes ───────────────────────────────────────────
  const outcomes = new Map<string, AnswerMessageOutcome>();
  for (const m of messages) {
    if (!spokenIds.has(m.waMessageId)) continue;
    const engineOutcome = result.outcomes.find((o) => o.messageId === m.waMessageId);
    const utterances = utteranceByMessageId.get(m.waMessageId) ?? [];
    const machineReasons = (engineOutcome?.reasons ?? []).join("; ");
    // ONE reply per message. Several speech intents for the same message
    // join into one send; they never become two results.
    const reply = utterances.length > 0 ? utterances.join("\n\n") : null;
    // `handleQuestion` and `handleTeams` set no react, so the composer
    // produces none. The shipped show-teams path reacts 👀
    // (`route.ts:3746`), and losing it would be a visible change on a
    // flag advertised as a like-for-like move — so it is carried here
    // rather than added to the engine.
    const react = reactByMessageId.get(m.waMessageId) ?? (m.route === "balancer" ? "👀" : null);
    outcomes.set(m.waMessageId, {
      waMessageId: m.waMessageId,
      route: m.route as Route,
      reply,
      react,
      intent: m.route === "balancer" ? "show_teams_request" : "question",
      // `AnalyzedMessage.action`, derived exactly as `route.ts:2197-2200`
      // derives it for a message with no attendance write. "none" would
      // make every step-7 answer look like a no-op to anything filtering
      // the admin log — including the nightly `none`-bucket sweep.
      action: react ? "react" : reply ? "reply" : "none",
      reasoning: `${ANSWER_HANDLED_BY} (${m.route}): ${machineReasons || "no rule fired"}`,
    });
  }

  // §3.2 S36/S37 — de-duplicate replies within a batch. Two people
  // asking the same question in one ten-minute window would otherwise
  // get two group messages carrying the same number. The LAST occurrence
  // keeps the answer, so it sits next to the most recent question
  // rather than scrolled away above it.
  const lastByText = new Map<string, string>();
  for (const [id, o] of outcomes) if (o.reply) lastByText.set(o.reply, id);
  for (const [id, o] of outcomes) {
    if (!o.reply) continue;
    if (lastByText.get(o.reply) === id) continue;
    outcomes.set(id, {
      ...o,
      reply: null,
      reasoning: `${o.reasoning}; identical answer already sent for this batch`,
    });
  }

  return {
    // The ids that both survived ownership AND produced an answer. An
    // id in neither is one the analyzer decides, and there is exactly
    // one outcome per id in here.
    ownedIds: spokenIds,
    outcomes,
    writes: [],
    matchId,
    degradations,
    cost: { ...cost, ms: Date.now() - t0 },
  };
}
