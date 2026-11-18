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
import type { SilenceFacts } from "../tagged-silence";
import type { QuotedGroupMessage } from "../reply-context";
import type { OrgFeatures } from "../org-features";
import { compose } from "./compose";
import { UNIFIED_ANSWER_INTENT } from "../group-copy";
import { decide as decideDefault } from "./engine";
// Traced: the extractor's facts are kept on the message's AnalyzedMessage
// row (`pipelineTrace`). Identical to `extractForRoute` outside a request.
import { extractForRouteTraced } from "./trace";
import { extractorStubFromEnv } from "./extractor-stub";
import { resolvePerson } from "./identity";
import { identifyFacts, personPickerFor } from "./identify-batch";
import type { PersonPicker } from "./who-is-who";
import { anthropicModel, type PipelineModel } from "./llm";
import { periodSince } from "./stats-period";
import { answerUnified, type DeadEndFacts, type LastMatchRatings, type UnifiedPeriod } from "./unified-answer";
import type { HelpClubFacts } from "../help-club-facts";
import {
  ANSWER_ENGINE_ROUTES,
  ANSWER_TEAM_ACTIONS,
  TEAM_OPS_TEAM_ACTIONS,
  stepSevenOwnsRoute,
} from "./route-flags";
import type {
  ClubSnapshot,
  EngineInput,
  EngineMessage,
  EngineResult,
  Facts,
  HelpRequest,
  PaymentSnapshot,
  ProposedWrite,
  QuestionTopic,
  RatingProgress,
  RecentResults,
  Route,
  SquadState,
  StatsChemistry,
  StatsPeriod,
  StatsPeriodTables,
  StatsSnapshot,
} from "./types";
import { extractorCacheKey, fanOutWarmFirst } from "./fan-out";

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

/** The shorter spans the unified answer is shown beside the whole record,
 *  so "most games this year" needs no period from the model. */
const UNIFIED_PERIODS: ReadonlyArray<readonly [string, StatsPeriod]> = [
  ["the last 30 days", { kind: "last", count: 30, unit: "day" }],
  ["this year", { kind: "this", unit: "year" }],
];

/**
 * THE QUESTIONS THIS MODULE ANSWERS (2026-11-18). Three things code does
 * itself, and everything else:
 *
 *   squad         the squad list post (`composeSquadStatusPost`)
 *   how_it_works  the help explainer for this club (`deps.helpReply`)
 *   my_stats      the asker's own stats link, which the route DMs
 *   other         THE UNIFIED ANSWER: one model call over the club's
 *                 records, filtered by audience (`unified-answer.ts`)
 *
 * The fifteen-topic list before it (count, bench, person_status, phones,
 * fixture, payments, score, rating_progress, stats, options, club), each
 * with its own composed answer and its own targeted read, ran only with
 * UNIFIED_ANSWERS off and was deleted with that flag on 2026-11-18, after
 * a week live (#595) with nothing harmful found. Kemal's rule: never add a
 * topic; widen the data the one answer sees instead.
 */
export const ANSWERABLE_TOPICS: readonly QuestionTopic[] = ["squad", "how_it_works", "my_stats", "other"];

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
 * Could another message in this batch change the squad AFTER this answer
 * is composed?
 *
 * Every answer here is rendered from the state loaded at the top of the
 * batch, and the analyze route runs the owners in SEQUENCE, so a write
 * from an owner that runs after this one (score, admin_ops) lands after
 * the answer. "Yes, Idris has a slot" beside Idris's own "sorry lads
 * can't make it" is a claim about a squad that no longer exists. So the
 * question waits for any message whose WRITES HAVE NOT LANDED YET: score
 * and admin_ops, an ungated `none` nobody owns, and an id the router never
 * mentioned (a coverage hole rather than a decision). Attendance does not
 * block: its writes land before this module loads its state.
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

/** The topic the batch's squad post answers: when a squad change in this
 *  batch posts the squad, it is the list asked for (`tagged-silence.ts`). */
const SQUAD_POST_ANSWERS: ReadonlySet<string> = new Set(["squad"]);

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
  /** Did this message tag the bot? FACTS only (`messageTagsBot`: the Pi's
   *  mention flag, or a reply to MatchTime). */
  tagged: boolean;
  /** May MatchTime ANSWER it (`messageAddressesBot`: the Pi's real
   *  mention flag, Kemal 2026-10-31)? When set it decides alone, for the
   *  question route and showing the teams: a swipe-reply to MatchTime is
   *  `tagged` but not `addressed`, and is not answered. Absent (HQ's door,
   *  which gates on the real tag before it gets here): `tagged`. */
  addressed?: boolean;
  /** From the router. `undefined` when it never mentioned this id. */
  route: Route | undefined;
  /** Did step 5's gate skip this message? Then step 7 never sees it. */
  gated: boolean;
  /** The message this one is a WhatsApp reply to, whoever wrote it
   *  (quoted-reply context, slice S4; replaces the 2026-10-16
   *  `quotedMatchTime`): shown to the extractor above the question,
   *  beside MatchTime's last post. Absent when it is not a reply. */
  reply?: QuotedGroupMessage | null;
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
  /**
   * The engine decided this message's SENDER gets their personal stats
   * link by DM (`QuestionTopic.my_stats`). The analyze route performs it,
   * to the sender of THIS message and nobody else: the flag carries no
   * recipient, so nothing extracted can point it anywhere.
   */
  statsLinkRequest: boolean;
}

export interface AnswerBatchResult {
  ownedIds: Set<string>;
  outcomes: Map<string, AnswerMessageOutcome>;
  /**
   * The answers to the `alsoAsks` messages, kept APART from `ownedIds` and
   * `outcomes`: the attendance engine owns those messages and speaks for
   * them, and the analyze route adds this answer to its reply. Empty when
   * nothing was asked or nothing answered.
   */
  alsoAnswered: Map<string, AnswerMessageOutcome>;
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
  /** Who the names in the facts are (`who-is-who.ts`). Injected by tests;
   *  otherwise `personPickerFor`. */
  identify?: PersonPicker;
  /** Injected so tests can load a state without a database. */
  loadState?: (orgId: string, now: Date) => Promise<SquadState>;
  /** `SquadState.features` carries attendance / paymentTracking /
   *  statsQa; the team post needs `teamBalancing`, which lives here. */
  loadFeatures?: (orgId: string) => Promise<OrgFeatures>;
  /** The reads the unified answer's context is built from, made only when
   *  a question it answers was owned (`loadUnifiedData`), each injected so a
   *  test can drive it without a database. The payment counts of the last
   *  settled match: read for the organisers only. */
  loadPayments?: (
    orgId: string,
    completedMatch: SquadState["completedMatch"],
  ) => Promise<PaymentSnapshot>;
  /** Who has rated the last match: read when the organisers or an admin
   *  ask. */
  loadRatingProgress?: (orgId: string, lang?: string) => Promise<RatingProgress>;
  /** The stats tables, when the club has stats answers on. */
  loadStats?: (orgId: string, now: Date) => Promise<Omit<StatsSnapshot, "chemistry" | "generic" | "periods">>;
  /** One player's chemistry: the one the question names, else the asker. */
  loadChemistry?: (orgId: string, userId: string) => Promise<StatsChemistry | null>;
  /** The tables the data can cut (appearances, ratings, Man of the
   *  Match), cut to the matches since `since`: the shorter spans. */
  loadStatsPeriod?: (orgId: string, since: Date) => Promise<Omit<StatsPeriodTables, "since">>;
  /** The club's recent scored results (`since` null is the whole record). */
  loadResults?: (orgId: string, since: Date | null, now: Date, lang: string) => Promise<RecentResults>;
  /** Injected so a test can prove the write assertion and the
   *  throw-safety without a fabricated engine rule in the real engine. */
  decide?: (input: EngineInput) => EngineResult;
  /** The help explainer for a how-it-works question (2026-10-16), for
   *  this club's settings. Defaults to `buildHelpReply` for the club, with
   *  its pool and partner clubs read (`help-club-facts.ts`); imported
   *  lazily because that module reads the database for other things.
   *  `asker.admin`: the sender is one of the club's organisers, who is
   *  told how to switch each thing (2026-10-28). */
  helpReply?: (req: HelpRequest, features: OrgFeatures, asker: { admin: boolean }) => Promise<string> | string;
  /** The club's setup (2026-10-16), for the unified answer's HOW THE CLUB
   *  IS RUN. `matchId` is the upcoming match the fee is read from, or null. */
  loadClub?: (orgId: string, matchId: string | null) => Promise<ClubSnapshot>;
  /** The pool and the partner clubs (2026-11-10), for
   *  the unified answer's context. Defaults to `loadHelpClubFacts`. */
  loadClubFacts?: (orgId: string) => Promise<HelpClubFacts>;
  /** The organisers only (2026-11-11): the ratings each
   *  player got in the last rated match. Defaults to `loadLastMatchRatings`. */
  loadLastMatchRatings?: (orgId: string, now: Date) => Promise<LastMatchRatings | null>;
  /** The organisers only (2026-11-11): the asker's own
   *  stats block, for "what is my rating?" in HQ. Defaults to
   *  `loadAskerOwnStats` (`unified-dm.ts`). Null: no stats for them. */
  loadOwnStats?: (orgId: string, userId: string) => Promise<string | null>;
}

/**
 * WHO IS ASKING (2026-10-16, FNF HQ). The players' group by default. The
 * club's admin group (HQ) asks the same questions through this same batch
 * (`admin-group-question.ts`), and two things differ there, both here so
 * there is one answering path:
 *
 *   - a `club` answer's wording: the teams-ready line is the organisers'
 *     setting in HQ, and plain words for the players (`ClubSnapshot.
 *     forOrganisers`); the facts are the same in both groups;
 *   - the squad and the bench are shown to the organisers even when they,
 *     not MatchTime, announce the list to the players (the organisers-
 *     announce net in `compose.ts` is for the players' group).
 */
export type AnswerAudience = "players" | "organisers";

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
/** The help reply for this club, in a group: public links only. An
 *  organiser is told how to switch each thing; anybody else gets the
 *  players' group's answer (help-answer.ts). */
function defaultHelpReply(orgId: string, poolEnv: () => Promise<Record<string, string | undefined>>) {
  return async (req: HelpRequest, features: OrgFeatures, asker: { admin: boolean }): Promise<string> => {
    const { clubHelpReply } = await import("../help-answer");
    return clubHelpReply({ orgId, req, features, audience: asker.admin ? "admin" : "group", poolEnv });
  };
}

function empty(degradations: string[] = []): AnswerBatchResult {
  return {
    ownedIds: new Set(),
    outcomes: new Map(),
    alsoAnswered: new Map(),
    writes: [],
    matchId: null,
    degradations,
    cost: { usd: 0, calls: 0, ms: 0 },
  };
}

/**
 * May MatchTime answer this message? `addressed` when the caller set it
 * (the players' group: the real tag, `messageAddressesBot`), else `tagged`
 * (HQ's door, already gated on the real tag). Every ownership and extractor
 * check in this module reads it, so the rule lives in one place.
 */
function asksMatchTime(m: AnswerBatchMessage): boolean {
  return m.addressed ?? m.tagged;
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
  /** See `AnswerAudience`. Absent is the players' group. */
  audience?: AnswerAudience;
  /**
   * ATTENDANCE MESSAGES THAT ALSO ASK MATCHTIME SOMETHING (#392 follow-up).
   * The ids of messages the attendance engine owns whose extractor read a
   * "question" side request ("@Match Time I'm out, what's the list?"). Each
   * is read here as the `question` it also is, under every gate a
   * standalone question meets (the tag, the route's flag, the carve-outs),
   * from the state loaded after the engine's writes landed. Its own
   * attendance route does not count as other traffic against it: that
   * write has landed and its reply is the one this answer joins. The
   * answer comes back in `alsoAnswered`, never in `ownedIds`. The analyze
   * route passes none for a club whose organisers announce the list.
   */
  alsoAsks?: ReadonlySet<string>;
  /** Resolves the pool switch as the request does (`pool/switch-env.ts`),
   *  for the help's pool answer; called only when a help question is
   *  answered. Absent: the pool reads as closed. */
  poolEnv?: () => Promise<Record<string, string | undefined>>;
  /** Where this batch reports the silences it chose (`tagged-silence.ts`),
   *  so the route does not call them "not understood". Absent: unreported. */
  silence?: SilenceFacts;
  /**
   * A MONTHLY CLUB WHOSE MONTH IS NOT STARTED (`month-not-started.ts`, the
   * same fact the attendance engine is given). The squad starts from the
   * month's list, so a count of whoever said IN is not the squad; the
   * unified answer is told so (Vets sandbox, 2026-11-03). Absent: false.
   */
  monthNotStarted?: boolean;
  /**
   * THE GROUP'S WEEK OF CHAT, for the unified answer (Kemal, 2026-11-10:
   * "recent chat should be all messages since last 1 week"). Read only
   * when an open question is owned, from THE GROUP THIS BATCH IS IN (the
   * caller's loader: `week-chat.ts` `playersWeekChat` or `hqWeekChat`), so
   * the two groups never mix. Absent, or a read that fails: the open
   * answer reads `history`, the extractors' few recent lines, and is told
   * so.
   */
  weekChat?: () => Promise<Array<{ author: string | null; body: string; at: Date | null }>>;
  /**
   * DEAD ENDS (2026-11-17, `dead-end-answer.ts`): the TAGGED messages
   * MatchTime took no action on (no handler for what was asked, or nothing
   * came of it), each with why its path stopped when the path said
   * (`DeadEndFacts.why`: the names a swap could not find, an action no path
   * has). Each is read as a `question` whose topic is `other`, with NO
   * extractor call (its owner's extractor already read it), and answered by
   * the unified answer, told NOT DONE and why, and shown this group's help
   * menu. A failed or refused answer is not owned, so the caller keeps its
   * line.
   */
  deadEnds?: ReadonlyMap<string, { why: string | null }>;
  /**
   * WHAT THE OTHER PARTS OF THE SAME MESSAGE DID (2026-11-18, Sutton 17 Nov
   * 12:53: "@Match Time switch the match to 7aside and tell us the current
   * list" was switched, then its question was answered "I can't switch the
   * match from this message"). For an `alsoAsks` message: the replies the
   * other owners already sent for it, by message id. The unified answer is
   * shown them as done, answers only the question, and never contradicts
   * them. Absent: nothing else was done.
   */
  alsoDone?: ReadonlyMap<string, readonly string[]>;
}): Promise<AnswerBatchResult> {
  const { orgId, now, history, expectedMatchId, enabled, deps } = args;
  const alsoAsks: ReadonlySet<string> = args.alsoAsks ?? new Set<string>();
  const deadEnds: ReadonlyMap<string, { why: string | null }> = args.deadEnds ?? new Map();
  const messages: AnswerBatchMessage[] = args.messages.map((m) =>
    (alsoAsks.has(m.waMessageId) || deadEnds.has(m.waMessageId)) && !m.gated ? { ...m, route: "question" as Route } : m,
  );
  const organisers = args.audience === "organisers";
  const t0 = Date.now();

  // ── Ownership, part 1: everything knowable without a model ─────────
  const candidates = messages.filter(
    (m) =>
      !m.gated &&
      (deadEnds.has(m.waMessageId) || stepSevenOwnsRoute(m.route, enabled, ANSWER_ROUTES)) &&
      asksMatchTime(m),
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
  // The organisers are who the list is FOR when they announce it: they see
  // it as a club whose list MatchTime announces would. See `AnswerAudience`.
  // Their list also always says who is on the bench (`forOrganisers`).
  // Who really posts the club's list, kept for the unified answer before
  // the organisers' view hides it (round 3, 2026-11-12: FNF HQ was told
  // MatchTime posts the list, and so where the 17:00 post goes, wrongly).
  const clubListAnnouncer = state.features.listAnnouncer ?? "matchtime";
  if (organisers) state = { ...state, forOrganisers: true, features: { ...state.features, listAnnouncer: "matchtime" } };

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
  //
  // ONE TOPIC IS EXEMPT FROM ALL FOUR, AND THAT IS WHY THEY NO LONGER
  // RETURN (2026-09-17). `my_stats` (the asker's own stats link, by DM)
  // is not an answer about the upcoming match, and the regex fast path it
  // replaced (`STATS_REQUEST`) ran before any of these existed for it: it
  // worked with no match scheduled, which is exactly when "wrapped" is
  // asked. So each carve-out records its decision in `squadBlock` instead
  // of returning. When one fired, only `question` messages are extracted,
  // only `my_stats` is owned, and a window with no such ask returns
  // `empty(squadBlock)`: the same result, reason for reason, as the
  // early return that stood here. The one cost is an extractor call on a
  // tagged question in a group with no usable match.
  let squadBlock: string[] | null = null;

  // Every answer this module composes is about the upcoming match — a
  // count, a bench, a person's place, the two line-ups. With no match
  // to describe, the composer would answer "0/0" from an empty state.
  if (!state.matchId) squadBlock = [];

  // `!== null` is NOT enough, and this differs from step 6 deliberately.
  // A null expectation means the ROUTE found no registration match while
  // this module found one — a disagreement, not an absence, and the one
  // that matters most: `route.ts:2353`'s squad-status composition is
  // guarded by `if (nextMatchForReply)`, so with the route seeing no
  // match nothing downstream would re-compose whatever is said here.
  if (squadBlock === null && state.matchId !== expectedMatchId) {
    const detail =
      `${ANSWER_DEGRADED_PREFIX} the route's registration match (${expectedMatchId ?? "none"}) ` +
      `and the engine's (${state.matchId}) disagree; owning nothing`;
    console.warn(`[answer-engine] ${detail}`);
    squadBlock = [detail];
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
  if (squadBlock === null && !state.features.attendance) squadBlock = [];

  // Every answer this module composes divides by, or prints, the format
  // total. A `Match` with `maxPlayers` 0 would produce "We're 11/0" and
  // "need 0 more" — the same shape as the 2026-06-08 "0/14" the check
  // above exists for, arrived at from the other direction. It should be
  // impossible; the answer to something that should be impossible is to
  // say nothing and tell an operator, not to print it. (It used to read
  // "hand it to the path that already handles it" — since §10 step 8
  // there is no such path, so the degradation below is the whole of the
  // handling.)
  if (squadBlock === null && state.maxPlayers <= 0) {
    squadBlock = [
      `${ANSWER_DEGRADED_PREFIX} match ${state.matchId} has maxPlayers=${state.maxPlayers}; ` +
        `owning nothing rather than composing an answer around it`,
    ];
  }

  // Blocked: only a question can be the stats-link ask, so nothing else
  // is extracted (and a window with no question costs nothing, as before).
  const unblockedCandidates = squadBlock === null ? candidates : candidates.filter((m) => m.route === "question");
  if (squadBlock !== null && unblockedCandidates.length === 0) return empty(squadBlock);

  const matchId = state.matchId;

  // See `batchCarriesAnUnsettledWriter`.
  const unsettledTraffic = batchCarriesAnUnsettledWriter(messages);

  const eligible = unblockedCandidates.filter((m) => {
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

  // ── Stage 2: extractors: the cache warmed first, then in parallel ──
  // (`pipeline/fan-out.ts`: one call per cacheable prompt runs alone so
  // the rest READ the prompt cache rather than all writing it)
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
  await fanOutWarmFirst(
    eligible,
    (m) => extractorCacheKey(m.route as Route),
    async (m) => {
      // A dead end is not read again: its owner's extractor found nothing
      // to do, and the unified answer reads the message itself.
      if (deadEnds.has(m.waMessageId)) {
        factsById.set(m.waMessageId, { kind: "question", topic: "other", personRef: null });
        return;
      }
      const res = await extractForRouteTraced("answer", model, m.route as Route, {
        id: m.waMessageId,
        body: m.body,
        authorName: m.authorName,
        tagged: m.tagged || asksMatchTime(m),
        history,
        lastBotPost,
        // A reply is about the message it quotes, whoever wrote it, shown
        // as it is; team-ops shows the same, so a balancer message's two
        // owners send one input and share one call (`trace.ts`, #340).
        reply: m.reply ?? null,
        now,
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
        args.silence?.readFailed.add(m.waMessageId);
        return;
      }
      factsById.set(m.waMessageId, res.facts);
    },
  );

  // ── WHO IS WHO (2026-11-09) ─────────────────────────────────────────
  // Every name the questions quote ("is Ali in?", "Sait's rating"), put
  // to the model in one call with the club's members
  // (`who-is-who.ts`). Ownership, the stats plans and the engine below all
  // read these picks; no name is matched by spelling.
  const identified = await identifyFacts({
    picker: personPickerFor({ identify: deps.identify, model }),
    roster: state.roster,
    where: "the players' group",
    items: eligible
      .filter((m) => factsById.has(m.waMessageId))
      .map((m) => ({
        id: m.waMessageId,
        body: m.body,
        author: m.senderName ?? m.authorName,
        senderUserId: m.senderUserId,
        facts: factsById.get(m.waMessageId)!,
      })),
  });
  if (identified.calls > 0) cost = { usd: cost.usd + identified.costUsd, calls: cost.calls + identified.calls, ms: cost.ms };
  degradations.push(...identified.degradations);
  const peopleById = identified.people;

  // The list asked for when there is no list to post (no match, a club
  // with no squad, a match nobody vouched for) is answered by the unified
  // answer, which says so, rather than by silence.
  if (squadBlock !== null) {
    for (const [id, f] of factsById) {
      if (f.kind === "question" && f.topic === "squad") factsById.set(id, { ...f, topic: "other" });
    }
  }
  // "what is my rating?" in HQ (2026-11-11) is answered there by the
  // unified answer, from the asker's own stats (`loadOwnStats`): HQ is the
  // organisers, who see every rating already, and HQ sends no stats link.
  // The players' group keeps the private link.
  if (organisers) {
    for (const [id, f] of factsById) {
      if (f.kind === "question" && f.topic === "my_stats") factsById.set(id, { ...f, topic: "other", personRef: "me" });
    }
  }

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
      // ── THE PERSONAL STATS LINK (2026-09-17) ───────────────────────
      //
      // Owned here, ahead of the mixed-batch hand-back and regardless of
      // `squadBlock`, because neither is about it: the link is a DM to
      // the asker with their own page, not a claim about the squad, so a
      // neighbour's write cannot contradict it and no upcoming match is
      // needed. The engine applies its gates (tag, resolved sender).
      //
      // ⚠️ TERMINAL BRANCH. The `continue` skips the mixed-batch check
      // and the `person_status` resolution below, neither of which
      // applies to this topic; like every `continue` in this loop it
      // skips no write, no send and no state mutation.
      if (facts.topic === "my_stats") {
        ownedIds.add(m.waMessageId);
        continue;
      }
      // ── HOW MATCHTIME WORKS (2026-10-16) ───────────────────────────
      //
      // Owned on the same argument again: the help explainer describes
      // the club's settings, not the upcoming squad, so no match is
      // needed and no neighbour's write can contradict it.
      //
      // ⚠️ TERMINAL BRANCH, like the two above.
      if (facts.topic === "how_it_works") {
        ownedIds.add(m.waMessageId);
        continue;
      }
      // A carve-out above fired: only the stats link, the help and the
      // unified answer are owned. No `hand()`, so the degradations are the
      // ones the early return that stood there produced. The unified answer
      // is not only about the upcoming squad, so it is answered with the
      // squad left out of its context (`squadKnown` below), never from a
      // squad nobody vouched for.
      if (squadBlock !== null && facts.topic !== "other") continue;
      // ── THE MIXED-BATCH HAND-BACK ──────────────────────────────────
      //
      // An answer here is composed from a snapshot that another owner's
      // writes may land after (score, admin_ops, an ungated message nobody
      // owns), and a claim about a squad that no longer exists is worse
      // than no answer. Attendance traffic does not count: its writes have
      // landed before this module loads its state.
      //
      // ⚠️ TERMINAL BRANCH. The `continue` skips `ownedIds.add`, which is
      // the whole intent. It skips no write, no send and no state mutation
      // (there are none in this loop), and the reason is already on
      // `degradations` before it runs.
      if (unsettledTraffic) {
        hand(
          `the batch also carries messages this step does not own, which may change the ` +
            `squad after this answer is composed (S36, and the pre-write snapshot)`,
        );
        // The batch's squad post, built after every write, lists the squad
        // and the bench: when it goes out it is this question's answer.
        if (SQUAD_POST_ANSWERS.has(facts.topic)) args.silence?.squadPostAnswers.add(m.waMessageId);
        continue;
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

  if (squadBlock !== null) {
    // Exactly what the early return produced, when there is no stats ask.
    if (ownedIds.size === 0) return empty(squadBlock);
    // Otherwise the carve-out's reason still travels with the batch, for
    // every other message in it that goes unanswered.
    degradations.push(...squadBlock);
  }
  if (ownedIds.size === 0) return empty(degradations);

  // ── Stage 2b: THE CLUB'S SETUP, for the unified answer ───────────
  //
  // Not on every batch: `loadSquadState` runs on the 69% that are banter.
  // Only when a question the unified answer answers was owned, and fails
  // soft: a throw leaves `state.club` unloaded, and the answer's HOW THE
  // CLUB IS RUN then has no money or teams lines.
  const openIds = [...ownedIds].filter((id) => {
    const f = factsById.get(id);
    return f?.kind === "question" && f.topic === "other";
  });
  const wantsClub = openIds.length > 0;
  if (wantsClub) {
    try {
      const load =
        deps.loadClub ??
        (async (o: string, matchId: string | null) => {
          const mod = await import("./load-state");
          return mod.loadClubSnapshot(o, matchId);
        });
      state = { ...state, club: { ...(await load(orgId, state.matchId)), forOrganisers: organisers } };
    } catch (err) {
      const detail =
        `${ANSWER_DEGRADED_PREFIX} the club read failed (${
          err instanceof Error ? err.message : String(err)
        }); the unified answer goes without the club's setup`;
      console.error("[answer-engine] club load failed:", err);
      degradations.push(detail);
    }
  }

  // ── Stage 2c: THE UNIFIED ANSWER (2026-11-10) ─────────────────────
  //
  // A tagged question whose topic is `other`: ONE model call per message
  // (`unified-answer.ts`) over everything this audience may see, read once
  // per batch (`loadUnifiedData`). Fails soft: a read that throws is left
  // out of the context; a call that fails or a reply that is refused
  // composes nothing, and the silent-id check below disowns the message,
  // which keeps the caller's line.
  if (openIds.length > 0) {
    const u = await loadUnifiedData();
    const byId = new Map(messages.map((m) => [m.waMessageId, m]));
    const openAnswers: NonNullable<SquadState["openAnswers"]> = {};
    for (const id of openIds) {
      const m = byId.get(id);
      const f = factsById.get(id);
      // Whose pairings the tables show: the member the question names
      // (who-is-who, never spelling), else the asker.
      let person: { userId: string; self: boolean } | null = m?.senderUserId ? { userId: m.senderUserId, self: true } : null;
      if (f?.kind === "question" && f.personRef && f.personRef.toLowerCase() !== "me") {
        const r = resolvePerson(f.personRef, state.roster, peopleById.get(id));
        if (r.kind === "resolved") person = { userId: r.member.userId, self: r.member.userId === m?.senderUserId };
      }
      if (person && u.stats && !u.stats.chemistry[person.userId]) {
        const load = deps.loadChemistry ?? (async (o: string, uid: string) => (await import("./load-stats")).loadStatsChemistry(o, uid));
        try {
          const c = await load(orgId, person.userId);
          if (c) u.stats.chemistry[person.userId] = c;
        } catch (err) {
          console.error("[answer-engine] unified chemistry read failed:", err);
        }
      }
      const asker = m?.senderUserId ? state.roster.find((r) => r.userId === m.senderUserId) : undefined;
      // The asker's own stats, in HQ only, when the question is about them.
      const own: string[] = [];
      if (organisers && m?.senderUserId && f?.kind === "question" && f.personRef?.toLowerCase() === "me") {
        const loadOwn = deps.loadOwnStats ?? (async (o: string, uid: string) => (await import("../unified-dm")).loadAskerOwnStats(o, uid));
        try {
          const block = await loadOwn(orgId, m.senderUserId);
          if (block) own.push(block);
        } catch (err) {
          console.error("[answer-engine] unified own stats read failed:", err);
        }
      }
      // A dead end is told why its path stopped, when the path said, and
      // shown this group's help menu, worded for who asks: what MatchTime
      // CAN do instead. A menu that cannot be read is left out.
      const askerIsOrganiser = organisers || !!asker?.isAdmin;
      let deadEnd: DeadEndFacts | null = null;
      const stopped = deadEnds.get(id);
      if (stopped) {
        let capabilities: string | null = null;
        try {
          const help = deps.helpReply ?? defaultHelpReply(orgId, args.poolEnv ?? (async () => ({})));
          capabilities = await help({ topic: null }, features, { admin: askerIsOrganiser });
        } catch (err) {
          console.error(`[answer-engine] ${id}: the help menu for a dead end was not read:`, err);
        }
        deadEnd = { capabilities, why: stopped.why?.trim() || null, askerIsOrganiser };
      }
      // What the other parts of this same message already did (an
      // `alsoAsks` message): shown as done, so the answer never says it
      // cannot do what was just done.
      const done = (args.alsoDone?.get(id) ?? []).map((r) => r.trim()).filter(Boolean);
      const g = await answerUnified({
        model,
        ...(deadEnd ? { deadEnd } : {}),
        ...(done.length ? { alsoDone: done } : {}),
        audience: organisers ? "organisers" : "players",
        state,
        squadKnown: squadBlock === null,
        stats: u.stats,
        periods: u.periods,
        person,
        results: u.results,
        payments: organisers ? u.payments : null,
        ratingProgress: organisers || asker?.isAdmin ? u.ratingProgress : null,
        clubFacts: u.clubFacts,
        squadMode: features.squadMode === "monthly" ? "monthly" : "weekly",
        listAnnouncer: clubListAnnouncer,
        lastMatchRatings: organisers ? u.lastMatchRatings : null,
        ...(own.length ? { own } : {}),
        monthNotStarted: args.monthNotStarted === true,
        history: u.chat,
        chatWindow: u.chatWindow,
        lastBotPost,
        reply: m?.reply ?? null,
        now,
        question: m?.body ?? "",
        askerUserId: m?.senderUserId ?? null,
        askerName: m?.senderName ?? m?.authorName ?? null,
      });
      openAnswers[id] = g.result;
      if (g.called) cost = { usd: cost.usd + g.costUsd, calls: cost.calls + g.calls, ms: Math.max(cost.ms, g.ms) };
      // Ids and counts only (Kemal's logging rule): never the words.
      console.log(
        `[answer-engine] ${id}: unified answer ${"text" in g.result ? "answered" : "rejected"}, ${g.inputTokens} input tokens, $${g.costUsd.toFixed(5)}, ${g.ms} ms`,
      );
      if ("rejected" in g.result) {
        degradations.push(`${ANSWER_DEGRADED_PREFIX} ${id}: unified answer not used (${g.result.rejected}); the caller's line instead`);
      }
    }
    state = { ...state, openAnswers };
  }

  /**
   * Every read the unified answer's context is built from, once per
   * batch. Each fails soft: a read that throws is left out of the
   * context (the model then says it does not know) and noted here.
   */
  async function loadUnifiedData() {
    const soft = async <T>(what: string, read: () => Promise<T>): Promise<T | null> => {
      try {
        return await read();
      } catch (err) {
        console.error(`[answer-engine] unified ${what} read failed:`, err);
        degradations.push(
          `${ANSWER_DEGRADED_PREFIX} the ${what} read for the unified answer failed (${err instanceof Error ? err.message : String(err)}); answered without it`,
        );
        return null;
      }
    };
    const loadStats = deps.loadStats ?? (async (o: string, at: Date) => (await import("./load-stats")).loadStatsTables(o, at));
    const loadPeriod = deps.loadStatsPeriod ?? (async (o: string, since: Date) => (await import("./load-stats")).loadStatsPeriod(o, since));
    let stats: StatsSnapshot | null = null;
    const periods: UnifiedPeriod[] = [];
    if (state.features.statsQa) {
      stats = state.stats ?? (await soft("stats", async () => ({ ...(await loadStats(orgId, now)), chemistry: {}, generic: {}, periods: {} })));
      if (stats) stats = { ...stats, chemistry: { ...stats.chemistry } };
      for (const [label, p] of UNIFIED_PERIODS) {
        const since = periodSince(p, now);
        if (!since || !stats) continue;
        const t = await soft(`stats (${label})`, () => loadPeriod(orgId, since));
        if (t) periods.push({ label, tables: { since, ...t } });
      }
    }
    const loadResults =
      deps.loadResults ??
      (async (o: string, since: Date | null, n: Date, lang: string) => (await import("./load-results")).loadRecentResults(o, since, n, lang));
    const results = await soft("results", () => loadResults(orgId, null, now, state.features.language));
    const loadPayments =
      deps.loadPayments ?? (async (o: string, cm: SquadState["completedMatch"]) => (await import("./load-state")).loadPaymentSnapshot(o, cm));
    // Payments are read for the organisers only: the players' context never
    // has them to leak (`unified-answer.ts`).
    const payments = organisers ? await soft("payment", () => loadPayments(orgId, state.completedMatch)) : null;
    const anyAdminAsks =
      organisers || messages.some((m) => !!m.senderUserId && state.roster.some((r) => r.userId === m.senderUserId && r.isAdmin));
    const loadRating =
      deps.loadRatingProgress ?? (async (o: string, l?: string) => (await import("./load-state")).loadRatingProgressSnapshot(o, l));
    const ratingProgress = anyAdminAsks ? await soft("rating-progress", () => loadRating(orgId, state.features.language)) : null;
    const clubFacts = await soft("club facts", async () =>
      deps.loadClubFacts
        ? deps.loadClubFacts(orgId)
        : (await import("../help-club-facts")).loadHelpClubFacts(orgId, args.poolEnv ? await args.poolEnv() : {}),
    );
    let chat: Array<{ author: string | null; body: string; at?: Date | null }> = history;
    let chatWindow: "week" | "recent" = "recent";
    if (args.weekChat) {
      const week = await soft("week of chat", () => args.weekChat!());
      if (week) {
        chat = week;
        chatWindow = "week";
      }
    }
    // The ratings each player got in the last match: the organisers only,
    // and the read is not made for the players' group.
    const loadLmr =
      deps.loadLastMatchRatings ?? (async (o: string, n: Date) => (await import("./load-stats")).loadLastMatchRatings(o, n));
    const lastMatchRatings = organisers && state.features.statsQa ? await soft("last match ratings", () => loadLmr(orgId, now)) : null;
    return { stats, periods, results, payments, ratingProgress, clubFacts, chat, chatWindow, lastMatchRatings };
  }

  // ── Stage 3: the engine, over the WHOLE window ─────────────────────
  const engineMessages: EngineMessage[] = messages.map((m) => ({
    id: m.waMessageId,
    body: m.body,
    senderUserId: m.senderUserId,
    senderName: m.senderName ?? m.authorName,
    tagged: asksMatchTime(m),
    // A message this module does not own still carries its real route so
    // its outcome says why nothing happened. `none` is honest for an id
    // the router never mentioned.
    route: m.route ?? "none",
    facts: ownedIds.has(m.waMessageId)
      ? (factsById.get(m.waMessageId) ?? { kind: "none" })
      : { kind: "none" },
    degraded: null, ...(peopleById.has(m.waMessageId) ? { people: peopleById.get(m.waMessageId) } : {}),
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

  // ── HOW MATCHTIME WORKS (2026-10-16) ───────────────────────────────
  //
  // The engine decided THAT the asker gets the help explainer; the words
  // are the help copy "@Match Time help <topic>" sends, for this club's
  // settings, which is why they are attached here (the composer has no
  // features and cannot import the module that writes them). A failure
  // leaves the message with nothing to say, and the assertion below
  // disowns it with this reason on the note.
  const helpIds = new Set<string>();
  for (const o of result.outcomes) {
    if (!o.helpRequested || !ownedIds.has(o.messageId)) continue;
    try {
      const sender = messages.find((x) => x.waMessageId === o.messageId)?.senderUserId ?? null;
      const admin = organisers || (!!sender && state.roster.some((r) => r.userId === sender && r.isAdmin));
      const text = await (deps.helpReply ?? defaultHelpReply(orgId, args.poolEnv ?? (async () => ({}))))(o.helpRequested, features, { admin });
      utteranceByMessageId.set(o.messageId, [...(utteranceByMessageId.get(o.messageId) ?? []), text]);
      helpIds.add(o.messageId);
    } catch (err) {
      degradations.push(
        `${ANSWER_DEGRADED_PREFIX} ${o.messageId}: the help explainer failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
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
  // A stats-link request composes nothing HERE by design: the link is
  // the DM, and the group's line ("Erdal, I'm sending your stats to you
  // privately by DM", which replaced a 📊 react on 2026-09-23) is posted
  // by the route once the DM is queued. It is an action, not a silence,
  // so it is not disowned. An owned `my_stats` the engine refused (an
  // unresolved sender) has no flag, and IS disowned below.
  const statsLinkIds = new Set(
    result.outcomes
      .filter((o) => o.statsLinkRequested === true && ownedIds.has(o.messageId))
      .map((o) => o.messageId),
  );
  const silentIds = [...ownedIds].filter(
    (id) => !statsLinkIds.has(id) && (utteranceByMessageId.get(id) ?? []).length === 0,
  );
  for (const id of silentIds) {
    // An admin-only ask from a player, refused on purpose: silence is the
    // answer, and the route must not call it "not understood".
    if (result.outcomes.find((o) => o.messageId === id)?.refused) args.silence?.refused.add(id);
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
    const statsLink = statsLinkIds.has(m.waMessageId);
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
      // `stats_link` / `dm-stats-link`: the labels the deleted
      // `STATS_REQUEST` fast path wrote (2026-09-17), kept so the admin
      // log's vocabulary is unchanged.
      // `help` (2026-10-16): the label the "@Match Time help" fast path
      // writes, and what keeps the organisers-mode net and the squad
      // composition pass off the explainer (`skipsSquadComposition`).
      intent:
        m.route === "balancer"
          ? "show_teams_request"
          : statsLink
            ? "stats_link"
            : helpIds.has(m.waMessageId)
              ? "help"
              : questionIntent(m.waMessageId),
      // `AnalyzedMessage.action`, derived exactly as `route.ts:2197-2200`
      // derives it for a message with no attendance write. "none" would
      // make every step-7 answer look like a no-op to anything filtering
      // the admin log — including the nightly `none`-bucket sweep.
      action: statsLink ? "dm-stats-link" : react ? "react" : reply ? "reply" : "none",
      reasoning: `${ANSWER_HANDLED_BY} (${m.route}): ${machineReasons || "no rule fired"}`,
      statsLinkRequest: statsLink,
    });
  }

  /** The unified answer's own intent (`UNIFIED_ANSWER_INTENT`): the route's
   *  squad-composition pass and the organisers-mode net skip it by intent.
   *  The squad list is "question", as it always was. */
  function questionIntent(id: string): string {
    const f = factsById.get(id);
    return f?.kind === "question" && f.topic === "other" ? UNIFIED_ANSWER_INTENT : "question";
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

  // The `alsoAsks` answers leave the module's own outcomes (a new map
  // each, never a removal: see the `.delete(` note above `silentIds`).
  const alsoAnswered = new Map([...outcomes].filter(([id]) => alsoAsks.has(id)));
  return {
    // The ids that both survived ownership AND produced an answer.
    // There is exactly one outcome per id in here. An id in neither used
    // to be "one the analyzer decides"; since §10 step 8 it is one
    // NOBODY decides — silence in the group plus a line on the operator
    // DM, with its reason taken from `degradations` above.
    ownedIds: new Set([...spokenIds].filter((id) => !alsoAsks.has(id))),
    outcomes: new Map([...outcomes].filter(([id]) => !alsoAsks.has(id))),
    alsoAnswered,
    writes: [],
    matchId,
    degradations,
    cost: { ...cost, ms: Date.now() - t0 },
  };
}
