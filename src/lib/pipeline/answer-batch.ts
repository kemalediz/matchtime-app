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
 * WHY THESE TWO ROUTES, AND WHERE THE OTHER TWO WENT
 * ─────────────────────────────────────────────────────────────────────
 * §10 step 7 names four: `question`, `team_ops`, `score`, `admin_ops`,
 * "one per week". Two of them arrive here. The other two arrived one
 * change later, in PART 2, and they are NOT here because they WRITE:
 *
 *   • `score`     → `score-engine-batch.ts` + `score-engine.ts`
 *   • `admin_ops` → `admin-ops-engine-batch.ts` + `admin-ops-engine.ts`
 *
 * Part 1's reasons for holding them back were measured rather than
 * assumed, and each one names the change part 2 had to make:
 *
 *   • `score` writes `Match.redScore/yellowScore` AND runs the Elo
 *     deltas (`route.ts:3505-3523`, `elo.ts:34`) — now `score-engine.ts`,
 *     an apply layer outside this directory. Two behaviours moved with
 *     it: the shipped path deliberately accepts a score from an
 *     UNRESOLVED sender ("losing the score entirely is a worse failure
 *     mode", `route.ts:3450-3457`) where the engine refused one, and it
 *     selects its target from `TEAMS_PUBLISHED | TEAMS_GENERATED |
 *     COMPLETED` where `SquadState.completedMatch` only held a
 *     `COMPLETED` one. Both are done; see that field's own comment.
 *   • `admin_ops` is real money on a live club (S21 — `PaymentCredit`,
 *     `Attendance.paidAt`) plus a reminder whose time phrase had to
 *     become a datetime. `reminder-time.ts` is that resolver, pure and
 *     fed an injected `now`. Of the four guards the engine did not
 *     carry, two are now IN the engine (the `reminders` feature gate and
 *     the 60-day window) and two are carve-outs that DECLINE the message
 *     (the `subReminderDm` opt-out and the missing-phone branch). Those
 *     two used to hand it back "so the analyzer says the shipped
 *     sentence"; §10 step 8 deleted the analyzer, so nobody says the
 *     shipped sentence any more and both are now silence plus an
 *     operator note. That module's header has the table and the
 *     correction.
 *
 * What has NOT changed is the rule that kept them apart: THIS module
 * still has no apply layer and still must not acquire one. Its whole
 * safety argument is structural — `__tests__/zero-writes.test.ts` scans
 * every file in this directory on every build, and `runAnswerBatch`
 * refuses to own anything at all if the engine ever hands it a write.
 *
 * ─────────────────────────────────────────────────────────────────────
 * IT OWNS NOTHING RATHER THAN GUESSING — AND SINCE 2026-09-06 "OWNS
 * NOTHING" MEANS SILENCE
 * ─────────────────────────────────────────────────────────────────────
 * This table used to sit under "FAIL OPEN, ALWAYS — the same rule as
 * step 6", and every row of it ended "the analyzer decides this message,
 * which is today's behaviour and therefore cannot be a regression".
 * §10 step 8 deleted `analyzeBatch`, the 19,850-token `SYSTEM_PROMPT`
 * and `executeVerdict`. Nothing decides these messages now.
 *
 * A message this module declines reaches `route.ts`'s "NOBODY OWNED IT" branch unowned and
 * gets three things: SILENCE in the group, an `AnalyzedMessage` row, and
 * one line on a deduped operator DM (`lib/operator-note.ts`). That is a
 * REAL BEHAVIOUR CHANGE and it is worth being blunt about here, because
 * this module owns the routes where the loss is most VISIBLE: every
 * unanswered question is a question a human watched go unanswered.
 *
 * §11.5 accepted it in advance and in these words: "a router with nine
 * routes and an engine with explicit rules will do nothing instead… the
 * club will experience it as 'the bot got dumber' before they experience
 * it as 'the bot stopped being wrong'." That is precisely this module's
 * failure mode, named a month before it shipped.
 *
 *   • the route's flag is off                 → owns nothing → SILENCE
 *                                               + operator note. The
 *                                               flag is KEPT and now
 *                                               defaults ON; "off" is a
 *                                               survivable degradation
 *                                               and a genuinely useful
 *                                               2am lever
 *                                               (`pipeline/route-flags.ts`).
 *   • the message is untagged                 → owns nothing (see below).
 *                                               The interaction contract
 *                                               refuses an untagged
 *                                               `question` upstream too,
 *                                               so this is not the only
 *                                               thing keeping MatchTime
 *                                               quiet there.
 *   • step 5's gate skipped it                → owns nothing, and NO
 *                                               note: `composeOperatorNote`
 *                                               drops every `none` route,
 *                                               which is 69.3% of traffic
 *   • the router never mentioned the id       → owns nothing → SILENCE
 *                                               + note
 *   • no active registration match            → owns nothing → SILENCE
 *                                               + note
 *   • attendance is off for the org           → owns nothing → SILENCE
 *   • team balancing is off for the org       → owns no team post →
 *                                               SILENCE. The club said
 *                                               no; nothing failed.
 *   • the state load threw                    → owns nothing → SILENCE
 *                                               + note
 *   • the extractor call threw                → THAT message goes SILENT
 *                                               and onto the note.
 *                                               NOTE THE ASYMMETRY:
 *                                               `extractors.ts` retries
 *                                               once on the four
 *                                               ATTENDANCE routes only,
 *                                               so a `question` or
 *                                               `balancer` extraction
 *                                               gets ONE attempt. That
 *                                               is deliberate — a lost
 *                                               question costs an
 *                                               answer, a lost IN costs
 *                                               a player their slot.
 *   • the extracted shape is one the composer
 *     cannot answer well                      → SILENCE + note
 *   • the targeted PAYMENT read threw         → that ONE message goes
 *                                               silent + note. The rest
 *                                               of the batch is
 *                                               unaffected: a fixture
 *                                               question beside a
 *                                               payment question still
 *                                               gets its answer. See
 *                                               stage 2b.
 *   • the engine threw, or proposed a write   → owns nothing → SILENCE
 *                                               + note
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
import {
  ANSWER_ENGINE_ROUTES,
  ANSWER_TEAM_ACTIONS,
  TEAM_OPS_TEAM_ACTIONS,
  stepSevenOwnsRoute,
} from "./route-flags";
import type {
  EngineInput,
  EngineMessage,
  EngineResult,
  Facts,
  PaymentSnapshot,
  ProposedWrite,
  QuestionTopic,
  RatingProgress,
  Route,
  SquadState,
} from "./types";

/**
 * The routes this module can own. Re-exported from `route-flags.ts` so
 * the flags and the owner cannot disagree about the list.
 *
 * It was `STEP_SEVEN_ROUTES` until part 2 gave `score` and `admin_ops`
 * owners of their own. Step 7 is now three modules, not one, and this
 * one owns only the READS — so it names the read list explicitly rather
 * than "everything step 7 can own", which would silently start pulling
 * score messages through this extractor the moment another flag went on.
 */
export const ANSWER_ROUTES = ANSWER_ENGINE_ROUTES;

/**
 * The question topics answered from the database, and nothing else.
 *
 * §6 of the redesign says it in one sentence: *"squad/bench/phone
 * answers become deterministic and only free-form stats need a model
 * call."* This constant is that sentence.
 *
 * ─────────────────────────────────────────────────────────────────────
 * `stats` AND `options` JOINED THE LIST ON 2026-09-09, AND THE REASON
 * THEY WERE MISSING WAS NEVER THE ANSWER
 * ─────────────────────────────────────────────────────────────────────
 * Both have been fully implemented since §10 step 7: `engine.ts` emits
 * them, `compose.ts` renders them deterministically, `SquadState`
 * carries `appearances` and `smallerFormats`, and the format-switch
 * arithmetic is `format-switch.ts`'s rather than a model's. What kept
 * them out of this list was what happened to the answer AFTER it was
 * composed.
 *
 * Every reply this module produces reaches `results` with
 * `handledBy: "llm"` (`route.ts:2126` — the AUDIT field says
 * "answer-engine", the WIRE field says "llm"), and `route.ts:2480`
 * runs `composeSquadStateReply` over every such reply. Anything
 * `displaysSquadState` recognises is REPLACED by a squad post composed
 * from a fresh snapshot. Both answers were recognised:
 *
 *   • the stats answer rendered `1. Kemal Ediz (24)` lines — a numbered
 *     run of 2+ lines, which is rule (a). `isLeaderboardLine`
 *     (`group-copy.ts:129`) exempts a leaderboard, but only when it
 *     carries an em dash, a percentage, "wins/votes/matches" or an
 *     "N/M (" pattern, and that shape carried none of them. So "who's
 *     been most consistent this season?" would have come back as the
 *     upcoming-squad roster: the 2026-05-14 incident §3.2 S16 exists
 *     for, reproduced by the replacement for the code that caused it.
 *   • the options answer led with "We're 8/14, need 6 more" — an "N/M"
 *     beside squad vocabulary, which is rule (c). `composeSquadStateReply`
 *     keeps a lead only when it makes no claim of its own, so the whole
 *     answer including the format-switch arithmetic would have been
 *     dropped rather than appended to.
 *
 * That is a defect in the FORMAT of two answers, and it was fixed as
 * one: the stats rows now use the house leaderboard shape
 * (`1. Kemal Ediz — 24 matches`, `match-history.ts:336`) which carries
 * two of `isLeaderboardLine`'s four markers, and the options lead spells
 * its count out ("8 of 14") so there is no slash for rule (c) to find.
 * Both are pinned by `__tests__/answer-batch.test.ts` section 6 and
 * `__tests__/compose.test.ts`, which assert `displaysSquadState` is
 * FALSE for each — the tests fail the day the punctuation regresses,
 * which is the only warning this class of defect gives.
 *
 * WHAT THE DELAY COST. Between §10 step 8 (which deleted the analyzer)
 * and this change, a tagged stats or options question was answered by
 * NOBODY: silence in the group plus a line on the operator DM. The data
 * gap named in the old version of this comment — MoM winners, an
 * all-time leaderboard and Elo, which `SquadState.appearances` does not
 * hold — is real and unchanged: this answers "most consistent by
 * appearances" and not those. That is a narrower answer than the
 * mega-prompt gave, and a narrower answer that is always right is the
 * trade §6.4 asks for. (The deterministic stats-link and stats-blast
 * peels in `route.ts` are a separate path and were never affected.)
 *
 * ─────────────────────────────────────────────────────────────────────
 * `score` JOINED ON 2026-09-09, AND IT COST NO NEW I/O
 * ─────────────────────────────────────────────────────────────────────
 * "@Match Time what was the score last week" landed on `other` and was
 * refused, while `SquadState.completedMatch` was already carrying
 * `redScore`, `yellowScore` and `status` for the score-REPORTING route.
 * The read cost a topic, a composer branch and one extra field on the
 * loader (`kickoffLabel`, so the answer names the night it is about).
 *
 * ⚠️ ADMITTING `stats` OPENED A WRONG ANSWER BEFORE `score` CLOSED IT,
 * and it is worth recording because only a live run could see it. With
 * `stats` newly answerable and no `score` topic to reach, "did we win
 * on tuesday?" extracted as `stats` 3/3 and was answered with an
 * appearances leaderboard — a confident non sequitur. While `stats` was
 * refused this was invisible: both topics went to silence. The
 * extractor's stats line now says what stats is NOT, and `score` gives
 * the result questions somewhere correct to go. Measured after: the four
 * unambiguous result phrasings answer 10/10, 10/10, 10/10 and 8/10 (the
 * two misses are the ROUTER calling "how did we get on last night"
 * banter, not the extractor).
 *
 * THE AMBIGUOUS ONE WAS SETTLED BY MEASUREMENT, NOT BY ARGUMENT.
 * "whats the score situation" is a real message and reads two ways. Ten
 * live runs BEFORE this topic existed: `count` 8/10, `other` 2/10, no
 * drift toward a result. Ten AFTER, with `score` on the menu so the
 * model had somewhere else to go: `count` 10/10. The model is
 * consistent, so this follows it rather than overriding it — "score
 * SITUATION" is the tally, "what was the score" is the result. See
 * `QuestionTopic`'s own note.
 *
 * ─────────────────────────────────────────────────────────────────────
 * `payments` JOINED ON 2026-09-09, AND IT IS THE ONLY TOPIC HERE THAT
 * READS SOMETHING `loadSquadState` DOES NOT LOAD
 * ─────────────────────────────────────────────────────────────────────
 * "@Match Time who hasn't paid" was the last question on the 2026-09-06
 * list with no data behind it. It is also the only one where being
 * WRONG costs a person something rather than costing MatchTime
 * credibility, so it has three refusals to its one answer and the whole
 * decision lives in `payment-answer.ts` — which flag really gates it
 * (not the one with "tracking" in its name), why the answer names
 * nobody, and why the match must be COMPLETED.
 *
 * The SHAPE of the extra read is in this file, at stage 2b: one
 * targeted load AFTER extraction, only when a `payments` topic survived
 * ownership, passed down as data. `loadSquadState` runs on every batch
 * including the 69% that are banter, and `compose.ts` cannot import
 * Prisma, so neither "put it in the loader" nor "make it a lazy
 * accessor" was available. Measured live: the four payment phrasings
 * answer 40/40, and the negative control "how much do we pay each"
 * (the FEE, which nothing here holds) stays on `other` 10/10.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT THE THREE ADDITIONS MOVED, MEASURED THE SAME WAY EACH TIME
 * ─────────────────────────────────────────────────────────────────────
 * The Q1-Q24 table, twice, against the live Sutton squad:
 *
 *   before   38 of 48 answered · 10 handed back · 0 silent
 *   after    46 of 48 answered ·  2 handed back · 0 silent
 *
 * Both remaining hand-backs are Q20, "is my mate down for tuesday" —
 * a `person_status` that names nobody, which nothing in the system can
 * answer and which SHOULD hand back. See §14.3 and `identity.ts`.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY `other` IS STILL ABSENT
 * ─────────────────────────────────────────────────────────────────────
 * A topic the extractor could not place is exactly the case §14.3 calls
 * "the least designed part of this document". A silent shrug is the
 * failure this design exists to remove — and the honest correction is
 * that `other` PRODUCES one. It used to end "so it goes back to the
 * prompt that can still try"; §10 step 8 deleted that prompt, so `other`
 * is silence plus an operator note. The note is the thin difference
 * between this and the shrug §14.3 objects to: a human is told, once an
 * hour, that a question went unanswered and what it said.
 */
export const ANSWERABLE_TOPICS: readonly QuestionTopic[] = [
  "count",
  "squad",
  "bench",
  "person_status",
  "phones",
  "fixture",
  "payments",
  "score",
  "stats",
  "options",
  // 2026-09-11. The SECOND topic that reads something `loadSquadState`
  // does not load, and it is on this list because a regex came off it:
  // `looksLikeRatingProgressRequest` (a rating word AND a progress word,
  // anywhere in the body) used to claim this ask in a clause-peeled fast
  // path. Measured `question` 60/60 on the live router, which is why it
  // is a topic here rather than an `admin_ops` action like the stats
  // blast. See `lib/rating-progress-answer.ts`.
  "rating_progress",
];

/**
 * `squad` AND `fixture` JOINED THAT LIST ON 2026-09-06, and both were
 * measured rather than argued for.
 *
 * Twelve tagged questions, replayed through the live pipeline against
 * the real Sutton squad (6/14, Tue 21:30, Goals North Cheam). The router
 * caught 12 of 12 — router recall was NOT the problem — and then:
 *
 *   • FOUR asked about the fixture ("what time is kickoff", "where are
 *     we playing", "are we playing tuesday?", "is the game still on")
 *     and every one of them landed on topic `other`, which reaches
 *     `engine.ts`'s `default:` branch and degrades. An operator note,
 *     and not one word to the group. The mega-prompt answers all four
 *     today (`message-analyzer.ts:455-457`), so leaving them here would
 *     have made the flag a regression on the most ordinary question a
 *     Sunday-league group asks. `fixture` is now a topic and
 *     `answer_fixture` reads `kickoffLabel` and `venue`.
 *   • THREE asked for the roster ("who's in?", "list the players",
 *     "show me the squad") and got "We're 6/14 for Tue 21:30, need 8
 *     more 🙏" — not one name in it. `engine.ts` sent `squad` and
 *     `count` to the same `answer_count` intent. It read correctly in
 *     production only because that string trips `displaysSquadState` and
 *     `route.ts:2393` swaps it for the roster post; lean on that and the
 *     answer degrades to a bare count on two real paths, the composition
 *     pass being inside a `try/catch` and its `if (nextMatchForReply)`
 *     guard using a different match selector from this module's. Relying
 *     on a regex in another module to turn a count into a roster is the
 *     opposite of §6.4, so `answer_squad` renders
 *     `composeSquadStatusPost` directly.
 *
 * The other three silences in that sweep were not one shape, and none of
 * them is fixed here:
 *
 *   • "who hasn't paid" routes `admin_ops`, not `question` — there is no
 *     payment data in `SquadState` at all, and none in the mega-prompt's
 *     Match Context either, so nothing is lost by leaving it.
 *   • "how many do we need?" and "whats the score situation" were TOPIC
 *     INSTABILITY rather than a missing topic: both extract as `count`
 *     on a re-run and both are answered. `stats` and `options` stayed
 *     handed back on that date for the composed-format reasons above;
 *     both were fixed and admitted on 2026-09-09, and the format defect
 *     that kept them out is written up on `ANSWERABLE_TOPICS`.
 *
 * WHAT THAT SWEEP'S CONCLUSION SAID, AND WHY IT NO LONGER HOLDS. It
 * ended: "Every non-answer here is a hand-back carrying a reason, never
 * silence: the analyzer is still standing beside this path and still
 * answers all of them." Nothing stands beside this path since §10 step 8.
 * Every non-answer here still carries a reason — the reason is what the
 * operator DM prints — but it IS silence in the group now, and the
 * measurement above is the reason `fixture` and `squad` were not left
 * for later: four fixture questions and three roster questions per
 * twelve is what "the bot got dumber" would have looked like on the most
 * ordinary thing a Sunday-league group asks.
 */

/**
 * Could ANY other message in this batch change the squad before the
 * answer is read?
 *
 * Every answer this module composes is rendered from the state loaded at
 * the top of the batch. It used to say "and this module runs BEFORE
 * `analyzeBatch` and before `executeVerdict`" — both deleted in §10
 * step 8 — but the hazard is unchanged and so is the ordering that
 * creates it: the analyze route runs the owners in SEQUENCE
 * (`route.ts`: attendance, then this, then score, admin_ops, team_ops),
 * so a write from ANOTHER OWNER later in the same batch still lands
 * after this answer is composed. The neighbour that can contradict us
 * is now `score-engine-batch.ts` or `admin-ops-engine-batch.ts` rather
 * than `executeVerdict`; nothing else about the argument moves.
 * §3.2 S36's single-post rule stops two
 * SQUAD POSTS contradicting each other, and `composeSquadStateReply`
 * catches a reply that displays squad state. Neither catches
 * "Yes, Idris has a slot for Tue 21:30" sent in the same window as
 * Idris's own "sorry lads can't make it": it is a squad CLAIM, not a
 * squad post, and no shape in `MOVE_CLAIM_PATTERNS` matches it.
 *
 * So no question is owned in a batch that carries anything else. The
 * test is the ROUTE, not the content: anything not on one of step 7's
 * own routes might write, including a `none` the gate did not skip and
 * an id the router never mentioned. Conservative on purpose — and the
 * cost of that conservatism CHANGED on 2026-09-06. It used to cost one
 * extractor call on a mixed batch, because the analyzer answered the
 * question instead. With `analyzeBatch` deleted, a tagged question that
 * shares a window with an "I'm in" is not answered by anybody: it goes
 * silent and onto the operator note. The rule is still right — a wrong
 * answer about who has a slot is worse than a late one — but it is now
 * paid for in unanswered questions rather than in pennies, and this is
 * where that is recorded.
 *
 * It also used to say: "step 7 is designed to run BEHIND step 5: with
 * `ROUTER_GATE_ENABLED` off, ordinary banter counts as 'anything else'
 * and questions are rarely owned". That flag is DELETED (§10 step 8 —
 * `pipeline/gate.ts` carries the argument) and the router now ALWAYS
 * runs (`routerIsNeeded()` takes no arguments and returns true), so
 * banter reliably routes `none`, `gated` is reliably set, and this
 * predicate reliably ignores it. The pessimistic case the old sentence
 * warned about cannot occur any more.
 */
function batchCarriesAnythingElse(messages: AnswerBatchMessage[]): boolean {
  return messages.some(
    (m) => !m.gated && m.route !== "question" && m.route !== "balancer",
  );
}

/**
 * The routes whose owner has ALREADY WRITTEN by the time this module
 * loads its state.
 *
 * `route.ts` awaits `runAttendanceEngineBatch` — extraction, `decide()`,
 * `applyEngineWrites`, all of it — at `:1360`, and only then calls
 * `runAnswerBatch` at `:1512`, which does its own `loadSquadState`. So
 * for these four routes the snapshot this module answers from is the
 * POST-write one. They are the only routes in the system that can move
 * an attendance row from a group message.
 *
 * Kept as a list rather than reusing `ENGINE_ROUTES` from `gate.ts`: the
 * property that matters here is the ORDERING in `route.ts`, not
 * ownership, and a future owner could share the routes without sharing
 * the sequence. If that ordering ever changes, this constant is what has
 * to change with it — and `__tests__/answer-batch.test.ts` pins both
 * directions.
 */
const ROUTES_THAT_WRITE_BEFORE_THIS_STEP: ReadonlyArray<Route> = [
  "self_att",
  "other_att",
  "offer",
  "unsure",
];

/**
 * The narrower question: could another message in this batch change the
 * squad AFTER this answer is composed?
 *
 * `batchCarriesAnythingElse` asks whether anything else is in the batch
 * at all. This asks whether anything else is in the batch whose WRITES
 * HAVE NOT LANDED YET — `score` and `admin_ops` run after this module
 * (`route.ts:1528`, `:1540`), an ungated `none` has no owner, and an id
 * the router never mentioned is a coverage hole rather than a decision.
 * All of those still block. Attendance does not.
 */
function batchCarriesAnUnsettledWriter(messages: AnswerBatchMessage[]): boolean {
  return messages.some(
    (m) =>
      !m.gated &&
      m.route !== "question" &&
      m.route !== "balancer" &&
      !(m.route !== undefined && ROUTES_THAT_WRITE_BEFORE_THIS_STEP.includes(m.route)),
  );
}

/**
 * The two topics the attendance engine used to answer BY ACCIDENT.
 *
 * Until 2026-09-09 `engine.ts` posted the whole roster on any batch that
 * moved a row, so a tagged "how many are we?" or "who's playing?" beside
 * an "I'm in" was answered — not by this module, which handed it back,
 * but by a post that happened to contain the count and the names. That
 * post is gone (it was overmessaging: one per IN), and with it the
 * accident. These two topics are carved out of the hand-back so the
 * questions keep their answer; every other topic keeps the behaviour it
 * has today, which for a mixed batch is silence plus an operator note.
 *
 * These are exactly the topics `engine.ts` defers into `squad_status`
 * (`deferredSquadQuestions`). The two lists are one decision and must
 * not drift apart.
 */
const SQUAD_SHAPED_TOPICS: ReadonlySet<string> = new Set(["squad", "count"]);

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
  /** The one targeted read that does NOT happen on every batch. Injected
   *  so a test can prove both that it is called for a `payments` topic
   *  and that it is NOT called for anything else. */
  loadPayments?: (
    orgId: string,
    completedMatch: SquadState["completedMatch"],
  ) => Promise<PaymentSnapshot>;
  /** The OTHER targeted read that does not happen on every batch (2026-
   *  09-11). Injected for the same reason: a test must be able to prove
   *  it is called for a `rating_progress` topic and for nothing else. */
  loadRatingProgress?: (orgId: string) => Promise<RatingProgress>;
  /** Injected so a test can prove the write assertion and the
   *  throw-safety without a fabricated engine rule in the real engine. */
  decide?: (input: EngineInput) => EngineResult;
}

/**
 * "This module owns nothing." It used to say "; the analyzer keeps the
 * batch", which named where those messages went. Since §10 step 8 they
 * go nowhere: each reaches `route.ts`'s "NOBODY OWNED IT" branch unowned and becomes silence
 * plus a line on the operator DM.
 *
 * A FUNCTION, not a shared const, for the same reason step 6's is: the
 * result carries a `Set` and a `Map`, and one frozen-by-convention
 * instance handed to every caller is one `.add()` away from leaking one
 * request's state into the next. It takes the accumulated degradations
 * so a decline never loses the reason it happened — and that matters
 * MORE now, because those lines are `composeOperatorNote`'s only source
 * for the "why" clause it prints beside each lost message.
 */
/** Is this message the rating-progress ask? Used twice: to decide
 *  whether the targeted read happens, and to keep the intent label the
 *  deleted fast path wrote. */
function isRatingProgress(f: Facts | undefined): boolean {
  return f?.kind === "question" && f.topic === "rating_progress";
}

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
    (m) => !m.gated && stepSevenOwnsRoute(m.route, enabled, ANSWER_ROUTES) && m.tagged,
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
    // Owning nothing. That used to be a fail-OPEN — "the analyzer
    // decides, which is what happens today" — and since §10 step 8 it is
    // a fail-QUIET: every question and team ask in this window goes
    // unanswered and lands on the operator note. Still right (an answer
    // rendered from a state we could not read is worse than no answer)
    // but no longer free, so the degradation says what actually happens.
    const detail = `${ANSWER_DEGRADED_PREFIX} state load failed (${
      err instanceof Error ? err.message : String(err)
    }); nobody handles these messages — they go unanswered and onto this note`;
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
    }); nobody handles these messages — they go unanswered and onto this note`;
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

  // A MoM-and-ratings-only org (`featureAttendance` off) must say
  // NOTHING about the squad — because MatchTime once told Sutton Lads
  // "0/14 — need 14 players" for a group that does not track one
  // (Kemal, 2026-06-08). A composer that answered from `rows` would be
  // that incident again.
  //
  // WHERE THE RULE USED TO LIVE. This said the org "gets
  // `ATTENDANCE_OFF_OVERRIDE` appended to the mega-prompt
  // (`message-analyzer.ts:923`), which orders total silence on every
  // squad question", and the danger was "a path that never read the
  // override". §10 step 8 deleted the mega-prompt and the override with
  // it. This line is now the WHOLE of the rule rather than a second copy
  // of it: delete it and there is no override anywhere to fall back on.
  //
  // `empty()` with NO degradation, deliberately. The club turned
  // attendance off; nothing failed, so nothing should page anybody.
  // (`operator-note.ts` names that case in its "what does NOT reach
  // here" list. Read the note on `attendance-engine-batch.ts`'s own
  // attendance-off row before relying on that: the filtering it
  // describes is not implemented for this axis, so an
  // attendance-off-but-stats-Q&A-on org can still produce a note.)
  if (!state.features.attendance) return empty();

  // Every answer this module composes divides by, or prints, the format
  // total. A `Match` with `maxPlayers` 0 would produce "We're 11/0" and
  // "need 0 more" — the same shape as the 2026-06-08 "0/14" the check
  // above exists for, arrived at from the other direction. It should be
  // impossible; the answer to something that should be impossible is to
  // say nothing and tell an operator, not to print it. (It used to read
  // "hand it to the path that already handles it" — since §10 step 8
  // there is no such path, so the degradation below is the whole of the
  // handling.)
  if (state.maxPlayers <= 0) {
    return empty([
      `${ANSWER_DEGRADED_PREFIX} match ${state.matchId} has maxPlayers=${state.maxPlayers}; ` +
        `owning nothing rather than composing an answer around it`,
    ]);
  }

  const matchId = state.matchId;

  // See `batchCarriesAnythingElse`. Two batch runners each calling
  // `decide()` cannot enforce §3.2 S36's single squad post between
  // them, and — the sharper half — an answer composed here may be
  // composed from a PRE-WRITE snapshot, so a question answered beside a
  // squad change is a claim about a squad that no longer exists.
  const otherTraffic = batchCarriesAnythingElse(messages);
  // …and the narrower one, for the two SQUAD-SHAPED topics only. Both
  // halves above are settled for attendance traffic: its writes have
  // landed before this module loads its state, and since 2026-09-09
  // `engine.ts` composes no unprompted squad post for them to collide
  // with. See `batchCarriesAnUnsettledWriter` and `SQUAD_SHAPED_TOPICS`.
  const unsettledTraffic = batchCarriesAnUnsettledWriter(messages);

  const eligible = candidates.filter((m) => {
    if (m.route === "balancer" && !features.teamBalancing) {
      degradations.push(
        `${ANSWER_DEGRADED_PREFIX} ${m.waMessageId}: team balancing is off for this org; ` +
          `nobody answers this message — the club has the feature switched off`,
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
        // §11.4 says "fail closed and surface it". Closed here means
        // SILENT — a question asked and no answer given, which §9 calls
        // this product's signature failure.
        //
        // This block used to continue: "The analyzer is still standing
        // beside this path and nothing has been written or sent, so the
        // message simply goes back to it. That is the step's own revert,
        // applied per message and automatically." §10 step 8 deleted
        // `analyzeBatch`; there is no second answerer and no automatic
        // revert. The message goes silent, and the only thing standing
        // between that and §9's signature failure is the line below
        // reaching an admin's phone.
        //
        // No retry here, unlike the attendance routes: `extractors.ts`
        // retries only where silence costs a squad place. A question is
        // asked again by the human who asked it.
        degradations.push(
          `${ANSWER_DEGRADED_PREFIX} ${m.waMessageId}: ${failure.detail} — ` +
            `nobody answers this message: no reply in the group, and it is on this note`,
        );
        return;
      }
      factsById.set(m.waMessageId, res.facts);
    }),
  );

  // ── Ownership, part 2: shapes only visible after extraction ────────
  //
  // Each rejection below used to be "the analyzer answers this one",
  // never "the bot says nothing". Since §10 step 8 it IS "the bot says
  // nothing", plus one line on the operator DM. Enumerated rather than
  // folded into one condition so the reason survives into the log —
  // which is now the only place it survives at all.
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
  // no entry in `outcomes` (so the analyze route finds no owner for it
  // and records it as unowned — silence plus the operator note, since
  // §10 step 8 deleted the verdict it used to leave alone), and its
  // reason is already in `degradations` before the `continue` runs.
  const ownedIds = new Set<string>();
  for (const m of eligible) {
    const facts = factsById.get(m.waMessageId);
    if (!facts) continue; // extraction failed; already reported above.
    // NAMED `hand` FOR A HAND-BACK IT NO LONGER PERFORMS. The name is
    // kept because every call site below reads `hand("why")` and
    // renaming a helper in a documentation-correction pass is how such a
    // pass acquires a bug. The SENTENCE it emits is corrected, because
    // an operator reads that sentence on their phone during an incident
    // and "handing this message back to the analyzer" told them a
    // message was safe at the moment it was lost.
    const hand = (why: string) =>
      degradations.push(
        `${ANSWER_DEGRADED_PREFIX} ${m.waMessageId}: ${why} — ` +
          `nobody answers this message: no reply in the group, and it is on this note`,
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
      // ── THE MIXED-BATCH HAND-BACK, AND ITS ONE CARVE-OUT ──────────
      //
      // For every topic but two: an answer here is composed from a
      // snapshot that another owner's writes may land after, and "Yes,
      // Idris has a slot for Tue 21:30" beside Idris's own "sorry lads
      // can't make it" is a claim about a squad that no longer exists —
      // invisible to `composeSquadStateReply`, which only recognises
      // squad POSTS and the `MOVE_CLAIM_PATTERNS` phrasings.
      //
      // For `squad` and `count`, the same test is applied to a smaller
      // set of neighbours: attendance traffic is EXCLUDED because its
      // writes have already landed (`route.ts` awaits the attendance
      // owner at `:1360`, this module runs at `:1512` and loads its own
      // state) and because `engine.ts` no longer composes an unprompted
      // roster post to collide with. That post is what used to answer
      // these two questions in a mixed batch — by accident, at the price
      // of one roster per IN — and removing it without this carve-out
      // would turn a tagged "how many are we?" into silence, which is
      // §9's signature failure wearing the other hat.
      //
      // ⚠️ TERMINAL BRANCH. The `continue` skips the `person_status`
      // resolution guard below and `ownedIds.add`, which is the whole
      // intent: an unowned message is answered by nobody. It skips no
      // write, no send and no state mutation — there are none in this
      // loop (see the `continue`s note above it) — and the reason is
      // already on `degradations` before it runs.
      if (SQUAD_SHAPED_TOPICS.has(facts.topic) ? unsettledTraffic : otherTraffic) {
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
      if (!ANSWER_TEAM_ACTIONS.includes(facts.action)) {
        // 2026-06-18 (`c408649`): "show the teams again" re-ran the
        // balancer and destroyed an admin's manual swap. SHOWING is a
        // read and there is no branch here that can write; GENERATING
        // rewrites `TeamAssignment`, force-includes named players into
        // the squad, moves `Match.status` and runs the rating adjuster
        // (a second model call). None of that belongs on a read path.
        //
        // WHERE IT GOES INSTEAD CHANGED IN §10 STEP 8. It used to go to
        // the mega-prompt, which still ran the balancer. `generate` now
        // has a deterministic owner — `team-ops-engine-batch.ts`, on
        // this same route, selected by this same FACT — and the two
        // action lists live in `route-flags.ts` so they cannot drift
        // into overlapping. `rename` and `swap` are owned by neither;
        // that module's header says why for each.
        const owner = TEAM_OPS_TEAM_ACTIONS.includes(facts.action)
          ? "team-ops-engine-batch.ts owns it on this route"
          : "no module owns it; see team-ops-engine-batch.ts's header";
        hand(`team action "${facts.action}" is not a read (${owner})`);
        continue;
      }
      // NO CARVE-OUT FOR AN EMPTY `state.teams` ANY MORE, and that is a
      // fix rather than a loosening. It used to hand the message back,
      // because `formatTeamsPost` over two empty lists composes a team
      // sheet with nobody on it — the 2026-09-06 sweep produced exactly
      // that and sent it. `engine.ts` now emits `teams_not_generated`
      // for that state instead, carrying the shipped path's own sentence
      // (`route.ts:3711-3714`), so the wrong post cannot be composed on
      // ANY path rather than being refused on this one.
      //
      // The old reason for dropping the carve-out was that "refusing
      // here as well would mean the analyzer answers a question this
      // module can now answer correctly". Since §10 step 8 the
      // alternative is worse than that, not better: refusing here would
      // mean NOBODY answers it. The fix is the same fix; its stakes went
      // up.
      ownedIds.add(m.waMessageId);
      continue;
    }
  }

  if (ownedIds.size === 0) return empty(degradations);

  // ── Stage 2b: ONE TARGETED EXTRA READ, and only when asked ─────────
  //
  // `loadSquadState` runs on every batch, including the 69% that are
  // banter, so payment rows do not belong in it: nobody should pay two
  // queries for a "haha". And a lazy accessor on state is not available
  // either — `compose.ts` must stay free of Prisma (its header says
  // why), so a function on `SquadState` that reaches the database would
  // put Prisma back on the composer's path.
  //
  // This is where the third option lives. Ownership is settled by the
  // line above, so the topics in this window are KNOWN; load once if one
  // of them needs it, and hand it down as data. The engine stays a pure
  // function of one value and the common path is unchanged.
  //
  // FAILS OPEN. A payment load that throws leaves `state.payments` null,
  // the composer says nothing under `answer_payments`, and the silent-id
  // check below disowns the message — a hand-back with a receipt. It does
  // NOT take the rest of the batch down: a fixture question beside a
  // payment question still gets its answer.
  const wantsPayments = [...ownedIds].some(
    (id) => {
      const f = factsById.get(id);
      return f?.kind === "question" && f.topic === "payments";
    },
  );
  if (wantsPayments) {
    try {
      const load =
        deps.loadPayments ??
        (async (o: string, cm: SquadState["completedMatch"]) => {
          const m = await import("./load-state");
          return m.loadPaymentSnapshot(o, cm);
        });
      state = { ...state, payments: await load(orgId, state.completedMatch) };
    } catch (err) {
      const detail =
        `${ANSWER_DEGRADED_PREFIX} the payment read failed (${
          err instanceof Error ? err.message : String(err)
        }); the payment question in this batch goes unanswered and onto this note`;
      console.error("[answer-engine] payment load failed:", err);
      degradations.push(detail);
    }
  }

  // ── Stage 2c: the OTHER targeted read — rating progress ────────────
  //
  // Identical in every respect to the payment load above, including the
  // fail-open: a rating read that throws leaves `state.ratingProgress`
  // null, the composer says nothing under `answer_rating_progress`, and
  // the silent-id check below disowns the message. A fixture question
  // beside it still gets its answer.
  //
  // It is here because `looksLikeRatingProgressRequest` is deleted
  // (2026-09-11). That regex was two keyword tests ANDed over a whole
  // body — the shape that matched half a sentence on 2026-09-01 and
  // queued 69 mass DMs on 2026-09-10 — and it sat in a clause-peeled
  // fast path ahead of the router. Now the model says which messages are
  // this ask, and this is the one place the data behind the answer is
  // read.
  const wantsRatingProgress = [...ownedIds].some((id) => {
    const f = factsById.get(id);
    return f?.kind === "question" && f.topic === "rating_progress";
  });
  if (wantsRatingProgress) {
    try {
      const load =
        deps.loadRatingProgress ??
        (async (o: string) => {
          const m = await import("./load-state");
          return m.loadRatingProgressSnapshot(o);
        });
      state = { ...state, ratingProgress: await load(orgId) };
    } catch (err) {
      const detail =
        `${ANSWER_DEGRADED_PREFIX} the rating-progress read failed (${
          err instanceof Error ? err.message : String(err)
        }); the rating question in this batch goes unanswered and onto this note`;
      console.error("[answer-engine] rating-progress load failed:", err);
      degradations.push(detail);
    }
  }

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
    // analyze request: nothing has been written, so owning nothing costs
    // the batch its answers and costs the squad nothing.
    //
    // It used to call that "a complete fail-open", on the grounds that
    // "the analyzer batch has not been decided". There is no analyzer
    // batch since §10 step 8, so this is a fail-quiet with a receipt.
    // Deliberately no retry: `decide()` is pure, so the same input
    // throws the same way.
    const detail = `${ANSWER_DEGRADED_PREFIX} the engine threw (${
      err instanceof Error ? err.message : String(err)
    }); nobody handles these messages — they go unanswered and onto this note`;
    console.error("[answer-engine] the engine threw:", err);
    return empty([...degradations, detail]);
  }
  // Pushed HERE rather than left to the composer, because the write
  // assertion below can return before `compose()` ever runs and a
  // decline must never lose the reason it happened. `compose()` folds
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
      `nothing — these messages go unanswered and onto this note`;
    console.error(`[answer-engine] ${detail}`);
    return empty([...degradations, detail]);
  }

  // ── Stage 4: composition ───────────────────────────────────────────
  const composed = compose(result);
  const utteranceByMessageId = new Map<string, string[]>();
  for (const u of composed.utterances) {
    // A batch-level post (`messageId: null`) is the squad post, which
    // only a squad CHANGE produces — and this path makes none. If one
    // ever appeared it would be a SECOND squad post in the same batch,
    // beside the attendance engine's. (It used to say "beside the
    // analyzer's"; since §10 step 8 the attendance engine is the only
    // thing that composes one.) So it is dropped and recorded rather
    // than sent.
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
    // The old line ended "handing this message back to the analyzer
    // rather than going silent". After §10 step 8 that is the exact
    // inverse of what happens: disowning the id here IS going silent.
    //
    // What the disowning still buys is the SIGNAL. An id with no owner
    // is the typed fact `lib/operator-note.ts` selects on, whereas an
    // owned id with an empty reply would be recorded as a decision and
    // told nobody — §9's signature failure exactly. So the assertion is
    // kept and its sentence corrected: silence with a receipt, rather
    // than silence dressed as an answer.
    degradations.push(
      `${ANSWER_DEGRADED_PREFIX} ${id}: owned but composed nothing to say — ` +
        `disowned so it reaches the operator note rather than passing as an answer`,
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
    // produces none. The shipped show-teams path reacts 👀 on a real
    // post (`route.ts:3746`) and 🤔 when there are no teams to show
    // (`route.ts:3714`, `route.ts:3734`), and losing either would be a
    // visible change on a flag advertised as a like-for-like move — so
    // both are carried here rather than added to the engine. Read from
    // `state`, not authored: the same condition the engine branched on.
    const react =
      reactByMessageId.get(m.waMessageId) ??
      (m.route === "balancer" ? (state.teams.length === 0 ? "🤔" : "👀") : null);
    outcomes.set(m.waMessageId, {
      waMessageId: m.waMessageId,
      route: m.route as Route,
      reply,
      react,
      // `rating_progress` keeps the label the deleted fast path wrote,
      // so the admin log's vocabulary — and every sweep over it,
      // including `e2e/replay/router-recall.ts`'s severity map — is
      // unchanged by the move from regex to model. Same decision #72
      // took for `stats_blast`.
      intent:
        m.route === "balancer"
          ? "show_teams_request"
          : isRatingProgress(factsById.get(m.waMessageId))
            ? "rating_progress"
            : "question",
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
    // The ids that both survived ownership AND produced an answer.
    // There is exactly one outcome per id in here. An id in neither used
    // to be "one the analyzer decides"; since §10 step 8 it is one
    // NOBODY decides — silence in the group plus a line on the operator
    // DM, with its reason taken from `degradations` above.
    ownedIds: spokenIds,
    outcomes,
    writes: [],
    matchId,
    degradations,
    cost: { ...cost, ms: Date.now() - t0 },
  };
}
