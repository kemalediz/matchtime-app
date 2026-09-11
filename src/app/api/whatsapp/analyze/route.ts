/**
 * Smart-analysis entry point. Called by the bot once per flush cycle
 * (every ~10 min, or immediately on urgency). Accepts a batch of EVERY
 * message the group posted in that window — the bot has had no regex
 * pre-filter since 2026-04-21 — decides each one, and returns
 * per-message actions for the bot to perform on the WhatsApp side.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THIS FILE STOPPED CALLING ONE BIG PROMPT ON 2026-09-06 (§10 step 8)
 * ─────────────────────────────────────────────────────────────────────
 *
 * Until this change the middle of this function was a single
 * `analyzeBatch()` call — one 19,850-token `SYSTEM_PROMPT` asked to
 * understand English, decide what the database should say, do
 * arithmetic and write the group's public message, all at once — plus
 * roughly 1,200 lines correcting what came back. §5 counted fifty-four
 * distinct guards over that output, two of which decided whether to drop
 * a player from a paid match by running regular expressions over the
 * model's English prose.
 *
 * `analyzeBatch` and `SYSTEM_PROMPT` are deleted. What replaced them:
 *
 *   0. DETERMINISTIC PEELS — no model at all. Personal stats link,
 *      group→DM Q&A, help, the colour swap, the team swap, a
 *      bench-prompt answer, a pasted roster. Each is a database row or a
 *      whole-message match, and each is peeled before the router so
 *      nothing else can claim it.
 *
 *      TWO OF THEM WERE NOT WHOLE-MESSAGE MATCHES AT ALL AND ARE GONE.
 *
 *      THE ADMIN STATS BLAST (2026-09-10). Recognised by three keyword
 *      tests ANDed together, which is a "whole-message match" only in
 *      the sense that the three words could be anywhere in the message:
 *      an owner's reminder to his players satisfied all three from three
 *      unrelated fragments and MatchTime queued 69 mass DMs. Now an
 *      extracted fact on the `admin_ops` route, gated by the engine and
 *      fired by this route after the batch — see the tombstone in
 *      section 0 and `lib/stats-blast.ts`.
 *
 *      ADMIN RATING PROGRESS (2026-09-11). Two keyword tests ANDed — a
 *      rating word and a progress word, anywhere in the body — which
 *      this file's own comment called "the WIDEST trigger of the six
 *      peels". Now `QuestionFacts.topic = "rating_progress"` on the
 *      `question` route, where the live router puts these phrasings
 *      60 of 60. See the tombstone in section 0 and
 *      `lib/rating-progress-answer.ts`.
 *   1. ROUTER — `claude-haiku-4-5`, ~360 tokens, nine routes. Banter
 *      exits here and costs nothing further. (`pipeline/gate.ts`)
 *   2. EXTRACTORS — one small specialist per route, strict JSON schema,
 *      returning FACTS about the text only. No intent, no reply, no
 *      reasoning: there is no field in which the model can express a
 *      decision, and no prose for a regex to parse.
 *   3. ENGINES — pure TypeScript. Facts plus squad state decide every
 *      write. One owner per route, asserted below, because two deciders
 *      for one message would mean two replies for one message.
 *   4. COMPOSERS — every number and every name the bot says is read from
 *      the database, after the write landed.
 *
 * A message no owner claims produces SILENCE in the group and one
 * deduped operator DM (`lib/operator-note.ts`). That is the honest cost
 * of the change and §11.5 named it in advance: "the club will experience
 * it as 'the bot got dumber' before they experience it as 'the bot
 * stopped being wrong'."
 *
 * Flow:
 *   1. Dedupe: skip any waMessageId already in AnalyzedMessage
 *      (covers bot restarts + retries).
 *   2. Resolve each author → User (phone, then fallback by pushname).
 *   3. Peel the deterministic paths; route the rest; run each owner.
 *   4. Render one reply and one AnalyzedMessage row per message.
 *   5. Return the bot the per-message actions (react, reply) + the
 *      next-kickoff timestamp it needs to decide urgency.
 *
 * Request:
 *   {
 *     groupId: "xxx@g.us",
 *     history: [{authorName, body, timestamp}],
 *     messages: [{waMessageId, body, authorPhone, authorName, timestamp}]
 *   }
 *
 * Response:
 *   {
 *     ok: true,
 *     orgId: "...",
 *     nextKickoffMs: number | null,   // ms since epoch of the next match,
 *                                     // so the bot knows when to urgency-
 *                                     // flush without an extra round trip
 *     results: [
 *       { waMessageId, handledBy, intent, react, reply, reasoning? }
 *     ]
 *   }
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { signMagicLinkToken, MAGIC_LINK_TTL } from "@/lib/magic-link";
import { buildShortMagicLinkUrl } from "@/lib/short-link";
import { answerScopedQuestion } from "@/lib/dm-qa";
// §10 step 8: `analyzeBatch`, `AnalysisVerdict` and `BatchInputMessage`
// were imported here until this change. They no longer exist.
// `enforceProximity` does, and stays: it rewrites "tonight" → "Tue 8 Sep"
// and the 20:30/21:30 BST-vs-UTC slips, and it is applied to every
// outgoing reply whatever composed it — it was never about the model.
import { enforceProximity } from "@/lib/message-analyzer";
import {
  composeSquadStateReply,
  stripSquadPostMarker,
  SQUAD_POST_MARKER,
  type SquadTruth,
} from "@/lib/group-copy";
import {
  composeOperatorNote,
  OPERATOR_NOTE_MARKER,
  type OwnedMessage,
  type UnownedMessage,
} from "@/lib/operator-note";
import {
  gateBatch,
  routerIsNeeded,
  GATED_HANDLED_BY,
} from "@/lib/pipeline/gate";
import {
  enabledStepSevenRoutes,
  routesHeaderOverride,
  STEP_SEVEN_HEADER,
} from "@/lib/pipeline/route-flags";
import { runAnswerBatch, ANSWER_HANDLED_BY } from "@/lib/pipeline/answer-batch";
import { runScoreBatch } from "@/lib/score-engine-batch";
import { SCORE_HANDLED_BY } from "@/lib/score-engine";
import { runAdminOpsBatch } from "@/lib/admin-ops-engine-batch";
import { ADMIN_OPS_HANDLED_BY } from "@/lib/admin-ops-engine";
import { runTeamOpsBatch } from "@/lib/team-ops-engine-batch";
import { TEAM_OPS_HANDLED_BY } from "@/lib/team-ops-engine";
import {
  buildScoreApplyDeps,
  buildAdminOpsApplyDeps,
  buildTeamOpsApplyDeps,
  buildClaimGuestNameAsk,
} from "@/lib/owner-deps";
import { loadOpenQuestion } from "@/lib/pipeline/load-awaiting-answer";
import { ENGINE_HANDLED_BY } from "@/lib/attendance-engine";
import { describeEngineBatch, runAttendanceEngineBatch } from "@/lib/attendance-engine-batch";
import { resolveBenchConfirmation } from "@/lib/bench-confirmation";
import { getOrgFeatures } from "@/lib/org-features";
// ── SEVENTEEN IMPORTS LEFT THIS FILE WITH THE MEGA-PROMPT (§10 step 8) ─
//
//   Each was the input to, or the correction of, a field on
//   `AnalysisVerdict`. Listed here rather than silently dropped, because
//   "we deleted a guard" and "we deleted a guard whose failure is now
//   unrepresentable" are different claims and only the second one is
//   allowed in this codebase:
//
//     shouldForceSenderOut       the OUT net's regexes over the model's
//                                English prose (`out-safety-net.ts`,
//                                still exported and still tested). §9's
//                                first "no longer possible": one
//                                `polarity` cannot contradict itself and
//                                there is no `reasoning` to parse. The
//                                per-player attribution it could never
//                                have is now one claim per person.
//     looksLikeHypotheticalOrPast  → the facts schema's `tense`
//     offerIsAboutSomeoneElse      → `subject`, a field rather than an
//                                    inference
//     actionRequiresTag            still the policy, applied inside each
//                                    owner (`engine.ts`, `answer-batch`)
//                                    rather than over a verdict here
//     isVagueGuestOfferVerdict,
//     stripPlaceholderGuests       DEAD, and the entry above was wrong
//                                    to file them with the ask. Both
//                                    take a `GuestOfferVerdict` and are
//                                    called by nothing but each other
//                                    and their tests; `personNamed` on
//                                    the claim replaced them, which is
//                                    what the `→` was pointing at. Kept
//                                    and tested like
//                                    `buildBenchUpgradeReply` below,
//                                    called by nothing.
//     shouldAskForGuestName,
//     renderGuestNameAsk           live: `engine.ts:476` decides and
//                                    `compose.ts:321` renders the SAME
//                                    copy from the same module
//     guestNameAskKey,
//     GUEST_NAME_ASK_KIND          ⚠️ THIS ENTRY SAID "moved intact" AND
//                                    WAS FALSE FOR A DAY. `load-state.ts`
//                                    READ the once-per-player dedupe row
//                                    and NOTHING WROTE IT, so
//                                    `alreadyAsked` was permanently
//                                    false and MatchTime asked for a
//                                    guest's name on every single offer.
//                                    Fixed 2026-09-07: the writer is
//                                    `buildClaimGuestNameAsk`
//                                    (`owner-deps.ts`), injected into
//                                    the engine batch below and called
//                                    between `decide()` and `compose()`
//                                    so the slot is claimed before
//                                    anything says the words.
//                                    A READER WITH NO WRITER IS THE
//                                    FAILURE SHAPE THIS WHOLE LIST
//                                    EXISTS TO CATCH: "we deleted a
//                                    guard" and "we deleted a guard
//                                    whose failure is now
//                                    unrepresentable" are different
//                                    claims — and so is "we kept a guard
//                                    and unplugged its input".
//     clampRosterDerivedWrites     DEAD by construction, and documented
//                                    as such in
//                                    `pasted-roster-registration.ts`'s
//                                    header: with no model there are no
//                                    list-derived writes to clamp. It
//                                    and `rosterMentions` are called
//                                    only from `pasted-roster.ts` and
//                                    the tests.
//     parsePastedRoster,
//     reconcilePastedRoster,
//     sameName                     → `pasted-roster-registration.ts`.
//                                    The LIST is reconciled above,
//                                    before the router; since 2026-09-07
//                                    the MESSAGE is not peeled with it,
//                                    so its sender's own drop still
//                                    reaches the engine. See section 4.
//     isPromoteFromBenchAuthorized  → `engine.ts`, unchanged in meaning
//     computeEloDeltas,
//     generateTeamsForMatch,
//     formatTeamsPost,
//     londonDateTimeToUtc,
//     formatLondon,
//     recordAttendanceEvent        → the apply layers in
//                                    `owner-deps.ts`, `score-engine.ts`,
//                                    `team-ops-engine.ts`
//     buildBenchUpgradeReply       DEAD, and worth one sentence: it
//                                    rewrote a reply that said "putting
//                                    you on the bench" when the write had
//                                    actually confirmed the player. The
//                                    composer renders from the PROJECTED
//                                    state after the engine decides, so a
//                                    reply cannot describe a write that
//                                    did not happen. The module and its
//                                    tests are kept — they are pure, and
//                                    the rule they encode is still the
//                                    house rule — but nothing calls it.
//     ENGINE_APPLY_DEGRADED_PREFIX  the partial-response net matched it
//                                    as a seventh prose prefix; the note
//                                    now matches ownership.
//     FeatureKey, normaliseName     used only by `executeVerdict`.
import {
  handleOnboardingTurn,
  buildHelpReply,
  parseHelpTopic,
} from "@/lib/onboarding-conversation";
import { registerAttendance, cancelAttendance } from "@/lib/attendance";
import { currentAnalyzeBatchId, withAnalyzeBatch } from "@/lib/analyze-batch-context";
import {
  resolveAttendanceAck,
  attendanceFailureAction,
  attendanceFailureLog,
} from "@/lib/attendance-write-outcome";
import { recordTentative, resolveTentative } from "@/lib/tentative-store";
import { resolveTeamLabels } from "@/lib/team-labels";
import { selectRegistrationMatch } from "@/lib/registration-match-select";
import { messageMentionsBotExplicitly, messageTagsBot } from "@/lib/interaction-contract";
import { mergeRecruitReply } from "@/lib/recruit-request";
import { readBenchPromptAnswer } from "@/lib/bench-prompt-answer";
import {
  peelClause,
  applyClauseReports,
  mergeOneReply,
  type ClausePeel,
  type ClauseReport,
} from "@/lib/pipeline/clause-peel";
import {
  decideSwap,
  parseSwapNames,
  resolveSwapSide,
  type SwapCandidate,
} from "@/lib/team-slot-swap";
import { decidePastedRosterRegistration } from "@/lib/pasted-roster-registration";
import {
  describeMentionOutcomes,
  resolveMentionNames,
} from "@/lib/pipeline/mention-names";
// Sender resolution moved OUT of this file on 2026-09-09. It could not be
// tested here — a Next.js route module may export only its HTTP handlers,
// so nothing in it can be imported by a test — and the 2026-08-30 audit
// named that as the reason its attribution hole survived review. Behaviour
// is unchanged by the move; see `lib/resolve-sender.ts` and its tests.
import {
  createProvisionalByName,
  resolveSender,
  restoreMembership,
  type ResolvedSender,
} from "@/lib/resolve-sender";
import { planUnresolvedNudge } from "@/lib/unresolved-nudge";
import { recordGroupSightings, sightedUserIds } from "@/lib/group-sighting";

interface InboundMessage {
  waMessageId: string;
  body: string;
  authorPhone: string;
  authorName: string | null;
  timestamp: string;
  /** Raw WhatsApp mention JIDs (e.g. "447700900123@c.us", "…@lid"),
   *  forwarded UNCHANGED for the onboarding admin parser. */
  mentions?: string[];
  /**
   * The display name the Pi's contact lookup saw for each mentioned JID.
   * UNVERIFIED — it is the mentioned person's own WhatsApp pushname, not
   * the club's name for them, and it is a string that person controls.
   * Used ONLY as a lookup key against the org roster by
   * `nameMentionsFromRoster` below; it never becomes body text on its
   * own. Absent from Pi builds before 2026-09-08 (which pasted the
   * pushname into `body` themselves — see that function's header).
   */
  mentionNames?: Array<{ jid: string; name: string }>;
  /** Did this message @-mention the bot's own JID? Computed on the Pi
   *  (only it knows the bot's selfId) and forwarded as a structured
   *  signal. PRIMARY input to the @Match Time interaction-contract gate;
   *  `undefined` from older Pi builds falls back to body text matching. */
  botMentioned?: boolean;
}

interface InboundHistory {
  authorName: string | null;
  body: string;
  timestamp: string;
}

interface InboundBody {
  groupId: string;
  history?: InboundHistory[];
  messages: InboundMessage[];
  /** Optional stored chat history for the onboarding ENRICHMENT pass.
   *  DISTINCT from `history` above: that field is the LLM-context history
   *  the main analyzer consumes ({authorName, body, timestamp}). This one
   *  is the {author, authorPhone?, text, timestamp} shape consumed by
   *  runOnboardingEnrichment via handleOnboardingTurn. Named separately
   *  to avoid clobbering the existing `history` field; forwarded only to
   *  the onboarding turn. Absent → no enrichment, behaviour unchanged. */
  enrichmentHistory?: Array<{
    author: string;
    authorPhone?: string | null;
    text: string;
    timestamp: string | number;
  }>;
}

type ActionForBot = {
  waMessageId: string;
  handledBy: "fast-path" | "llm" | "ignored" | "error" | "deduped";
  intent: string | null;
  react: string | null;
  reply: string | null;
  reasoning?: string;
};

/**
 * One HTTP request = one analyze BATCH = one `batchId`.
 *
 * The Pi flushes a WINDOW of buffered messages here and the route
 * reasons over all of it at once, so the batch is the unit any replay
 * of this history has to reconstruct. Stamping it (via
 * `lib/analyze-batch-context.ts`, read in `recordAnalysis`) replaces
 * the timing heuristic `e2e/replay/reconstruct.ts` had to use, which
 * threw away 62 batches whose write gaps were genuinely ambiguous.
 * Purely additive: the column is nullable and nothing branches on it.
 */
export async function POST(request: Request) {
  return withAnalyzeBatch(() => handleAnalyzeRequest(request));
}

async function handleAnalyzeRequest(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as InboundBody | null;
  if (!body?.groupId || !Array.isArray(body?.messages)) {
    return NextResponse.json({ error: "groupId and messages[] required" }, { status: 400 });
  }

  // ── Phase 2: autonomous onboarding ───────────────────────────────
  //   Runs BEFORE the bot-enabled-org gate. A group with no org is
  //   normally ignored; here it can bootstrap itself via an explicit
  //   "@MatchTime setup" trigger, then a multi-turn in-group Q&A.
  //   While a session is active every batch routes here (not the
  //   normal analyzer) until it completes/abandons.
  {
    const onb = await handleOnboardingIfApplicable(body);
    if (onb) return NextResponse.json(onb);
  }

  const org = await db.organisation.findFirst({
    where: { whatsappGroupId: body.groupId, whatsappBotEnabled: true },
    select: { id: true, name: true },
  });
  if (!org) {
    return NextResponse.json({ ok: true, ignored: "unknown-or-disabled-group", results: [] });
  }

  // Name every @-mention the roster can vouch for BEFORE anything reads a
  // body: the squad-from-list archive, the dedupe's empty-body check, the
  // stats fast path, the router, the extractor and the `AnalyzedMessage`
  // row then all see the SAME text. An unresolvable mention keeps its raw
  // "@<digits>" token — nothing here invents a name.
  body.messages = await nameMentionsFromRoster(org.id, body.messages);

  // ── Skip the LLM entirely when no message-driven feature is on ───
  //   MoM + player-rating are post-match / poll / scheduler driven —
  //   they never need per-message analysis. Only attendance, bench,
  //   team-balancing, reminders and stats-Q&A read chat. If none of
  //   those are enabled for this org there is nothing for the
  //   analyzer to do, so we return BEFORE the (now Sonnet, ~3×)
  //   LLM call. Takes such a group's analyzer bill to ~£0, which is the
  //   whole claim; the "~£10/mo" it used to say it saved was a
  //   pre-shadow-analyzer, pre-cache-buster guess. See
  //   analyzer-redesign-2026-08-31.md §8.4 for the modelled range and
  //   for why even that is not a measurement. (Onboarding
  //   already returned above when its session is active, so a
  //   mid-setup group still gets handled.)
  //
  //   ALSO: when this org has `featureSquadFromList` on (paste-list
  //   groups like Amir's Thursday — MoM/ratings only, attendance off),
  //   archive each fresh inbound message into GroupMessage so the
  //   squad-extraction cron has data to read. STILL no per-batch LLM
  //   call. The archive write is idempotent on waMessageId (unique).
  {
    const f = await getOrgFeatures(org.id);
    // Squad-from-list orgs ALWAYS archive inbound messages so the
    // squad-extraction cron has raw data to diff — INDEPENDENT of whether
    // the per-batch analyzer also runs below.
    //
    // Regression fix (2026-06-05): this archive used to live inside the
    // `if (!needsAnalyzer)` block. When featureStatsQa was flipped on for
    // every org (commit 3917f00, 29 May), `needsAnalyzer` became always
    // true, so this block stopped running and squad extraction silently
    // broke for squad-from-list groups (Sutton Lads' 4 Jun match
    // registered 0 players → no rating DMs). Archiving must not depend on
    // the analyzer gate.
    //
    // (No inline LLM extraction here — keeps the analyze response fast and
    // never times out. Extraction runs via the daily generate-teams cron
    // backstop plus manual triggers via /api/cron/extract-squads.)
    if (f.squadFromList) {
      await storeMessagesForSquadFromList(org.id, body.groupId, body.messages);
    }
    const needsAnalyzer =
      f.attendance || f.bench || f.teamBalancing || f.reminders || f.statsQa;
    if (!needsAnalyzer) {
      return NextResponse.json({
        ok: true,
        ignored: "no-message-driven-features",
        results: [],
      });
    }
  }

  // 1. Dedupe.
  const all = body.messages;
  const ids = all.map((m) => m.waMessageId);
  const seen = await db.analyzedMessage.findMany({
    where: { waMessageId: { in: ids } },
    select: { waMessageId: true, intent: true, handledBy: true },
  });
  const seenMap = new Map(seen.map((s) => [s.waMessageId, s]));

  const fresh: InboundMessage[] = [];
  const results: ActionForBot[] = [];

  for (const msg of all) {
    const prior = seenMap.get(msg.waMessageId);
    if (prior) {
      results.push({
        waMessageId: msg.waMessageId,
        handledBy: "deduped",
        intent: prior.intent,
        react: null,
        reply: null,
      });
      continue;
    }
    const trimmed = msg.body.trim();
    if (trimmed.length === 0) {
      await recordAnalysis({
        orgId: org.id,
        groupId: body.groupId,
        msg,
        handledBy: "ignored",
        intent: "noise",
        action: null,
        confidence: 1,
        reasoning: "empty body",
      });
      results.push({
        waMessageId: msg.waMessageId,
        handledBy: "ignored",
        intent: "noise",
        react: null,
        reply: null,
      });
      continue;
    }
    fresh.push(msg);
  }

  // 2. Resolve senders + hand the whole fresh batch to Claude in one call.
  const senderById = new Map<string, ResolvedSender>();
  for (const m of fresh) {
    senderById.set(m.waMessageId, await resolveSender(org.id, m));
  }

  // ── SIGNAL 1: THESE PEOPLE ARE IN THE GROUP ────────────────────────
  //
  // Every message in `fresh` came from this org's monitored WhatsApp
  // group, so every resolved sender is PROVABLY a participant right now.
  // That is the one presence signal that needs nothing from
  // whatsapp-web.js's injected layer, which is what the startup
  // participant sweep depends on and what has been broken since
  // 2026-07-07 — leaving `Membership.lastSeenInGroupAt` frozen and the
  // web app telling real players they are not in a group they are
  // sitting in.
  //
  // ONE batched write, HERE, deliberately:
  //   - OUTSIDE the per-message loop. `analyze/route.ts` is ~4,000 lines
  //     of fast paths and this file's defining bug class is a `continue`
  //     silently deleting the guards beneath it (six incidents; see the
  //     clause-peel block below). A per-message write down there would
  //     be deleted by the next fast path somebody adds, and nobody would
  //     notice for weeks.
  //   - BEFORE every branch, short-circuit and early return below, so no
  //     future one can skip it.
  //   - AFTER resolution, because an unresolved sender proves somebody
  //     is in the group but not WHO, and there is no row to refresh.
  //
  // It skips NOTHING and decides NOTHING: it neither reads nor writes
  // anything the rest of this handler touches, and it cannot throw (see
  // `recordGroupSightings`). Deduped and empty-body messages are not in
  // `fresh` and so contribute no sighting — a conservative under-count,
  // which is the safe side of "presence is provable, absence is not".
  // `fromMe` never reaches here at all: the Pi drops the bot's own
  // messages in its `message` handler and in the 2h recovery replay.
  // A synthetic or reconstructed `waMessageId` is irrelevant to this
  // write — identity comes from the author, not the id, and a message
  // replayed under a fresh id lands inside the throttle window anyway.
  await recordGroupSightings(org.id, sightedUserIds(senderById.values()));

  // ═══════════════════════════════════════════════════════════════════
  // A FAST PATH CLAIMS A CLAUSE, NOT A MESSAGE (2026-09-09)
  // ═══════════════════════════════════════════════════════════════════
  //
  // THE BUG CLASS, SIX INCIDENTS. Every fast path below used to do this:
  //
  //     fastPathHandledIds.add(m.waMessageId);   // the WHOLE message
  //     continue;                                // skip every guard below
  //
  // and the one splice further down removed the message from `fresh`. So
  // whichever fast path matched FIRST owned the entire message and every
  // other clause in it was destroyed. The recruit regex (2026-09-01),
  // PR #29's guest-name ask, step 6's engine short-circuit, the pasted
  // list (2026-09-06), the BENCH clause (2026-09-08) and the swap peel
  // are one defect wearing six hats. `lib/pipeline/clause-peel.ts` has
  // the full roll-call and the argument.
  //
  // THE FIX IS THE SAME MOVE `registerForEntryRequiresTag` MADE ONE
  // LAYER DOWN on 2026-09-08: ask the question PER CLAUSE. A fast path
  // takes the clause it recognises; what is left carries on.
  //
  // ── THE THREE SETS, AND WHY THEY ARE THREE ─────────────────────────
  //
  //   `fastPathHandledIds`   "a fast path has dealt with this message"
  //                          — read by every LATER fast path so two
  //                          cannot claim one message. It was called
  //                          `statsRequestIds` and was doing this job
  //                          AND the splice's, which is how "handled"
  //                          and "gone from the pipeline" became the
  //                          same fact. They are not the same fact.
  //   `clauseResidualById`   the message is handled but NOT gone: this
  //                          is the body the rest of the pipeline sees.
  //                          Its presence is exactly what spares the
  //                          message from the splice.
  //   `clauseReports`        the fast path's own row + words, DEFERRED
  //                          so they can be merged into the ONE result
  //                          the loop produces for that message. Same
  //                          shape as `pastedRosterReports` below and
  //                          the recruit blast's merge above.
  //
  // ── WHAT A RESIDUAL IS EXPOSED TO, AND WHAT IT IS NOT ──────────────
  //
  //   THE ROUTER GATE       YES. It labels, it does not decide. One
  //                         extra line in a batched Haiku call.
  //   THE ATTENDANCE ENGINE YES, AND THIS IS THE WHOLE POINT. The
  //                         residual is where "and I'm out" lives, and
  //                         losing an attendance change is the worst
  //                         thing this file does.
  //   THE FOUR STEP-7       NO. Excluded from `ownerBase`, exactly as a
  //   OWNERS                pasted roster is and for the same reason: a
  //                         fragment left over from "…and share us the
  //                         teams" must not be answered as a question or
  //                         taken as a team instruction. That exposure
  //                         would be NEW with this change, so it is
  //                         closed here rather than argued about. THE
  //                         COST, stated: "@Match Time swap A with B.
  //                         What time is kickoff?" still answers only
  //                         the swap.
  //   THE OPERATOR NOTE     NO. `unowned` skips a residual. The message
  //                         WAS handled — its `AnalyzedMessage` row
  //                         carries both halves via `augmentAnalysis` —
  //                         and paging a human on every "…and share us
  //                         the teams" would be a regression dressed as
  //                         observability. This is the pasted roster's
  //                         own argument, unchanged.
  //
  // ── THE ONE-REPLY INVARIANT ────────────────────────────────────────
  //
  // Two owners may now WRITE for one message; only one SPEAKS. The
  // fast path's words are merged into the loop's single result by
  // `mergeOneReply` — never pushed as a second result — which is
  // `mergeRecruitReply`'s rule generalised (it now delegates to the same
  // function). `applyClauseReports` below is the only place that merges,
  // and the duplicate-result backstop at the end of this function still
  // says so out loud.
  const fastPathHandledIds = new Set<string>();
  const clauseResidualById = new Map<string, string>();
  const clauseReports = new Map<string, ClauseReport>();

  /** The body the REST of the pipeline sees. The ORIGINAL body for
   *  everything a fast path did not touch; the residual for anything it
   *  peeled a clause off. `messageTagsBot` is deliberately NOT computed
   *  from this — the tag is a property of what the sender WROTE, and a
   *  peel must not be able to change what the contract permits. */
  const pipelineBody = (m: InboundMessage): string =>
    clauseResidualById.get(m.waMessageId) ?? m.body;

  /**
   * ONE fast path has decided one message. Called by every peel below
   * instead of the old `add(id)` + `recordAnalysis` + `results.push`.
   *
   * With NO residual it does exactly what shipped: the row and the
   * result are written here and the splice removes the message. With a
   * residual it writes neither — both are deferred into `clauseReports`
   * and merged into whatever the pipeline concludes about the rest of
   * the message, so the batch still ends with one result and one row per
   * waMessageId.
   */
  const claimFastPath = async (
    m: InboundMessage,
    peel: ClausePeel | null,
    report: ClauseReport,
  ) => {
    fastPathHandledIds.add(m.waMessageId);
    const sender = senderById.get(m.waMessageId);
    if (peel && peel.residual) {
      clauseResidualById.set(m.waMessageId, peel.residual);
      clauseReports.set(m.waMessageId, report);
      console.log(
        `[analyze] clause peel (${report.intent}) on ${m.waMessageId}: took ` +
          `"${peel.consumed.slice(0, 60)}", the pipeline still sees ` +
          `"${peel.residual.slice(0, 60)}"`,
      );
      return;
    }
    await recordAnalysis({
      orgId: org.id,
      groupId: body.groupId,
      msg: m,
      handledBy: report.handledBy,
      intent: report.intent,
      action: report.action,
      confidence: 1,
      reasoning: report.reasoning,
      authorUserId: sender?.userId,
      authorName: m.authorName ?? null,
    });
    results.push({
      waMessageId: m.waMessageId,
      handledBy: report.handledBy,
      intent: report.intent,
      react: report.react,
      reply: report.reply,
    });
  };

  // ── Fast-path: "my stats" / "wrapped" personal-stats request ────────
  //   Deterministic (NO LLM cost — Kemal is cost-conscious about
  //   per-message LLM use). When a resolved sender asks for THEIR OWN
  //   stats, DM them a 48h magic link straight to /profile/stats and
  //   react 📊. Peeled off the batch so the LLM never sees it. Requires
  //   the possessive ("my stats/season/ratings/form/card") or the word
  //   "wrapped" so it never collides with group-level stats questions
  //   ("who's most consistent?") which the LLM still answers from the
  //   Recent History block.
  //
  //   CLAUSE-PEELED. The DM is composed from the SENDER, never from the
  //   body, so which clause carried "my stats" changes nothing about
  //   what is sent — only about what is left over. "@Match Time my
  //   stats. Also put me down for Thursday" now DMs the link AND
  //   registers him.
  const STATS_REQUEST = /\bwrapped\b|\bmy\s+(stats|season|ratings?|performance|form|card)\b/i;
  for (const m of fresh) {
    // Interaction contract: a stats request is an ANSWER-y action MT
    // performs for a player → requires an @Match Time tag. Untagged
    // "my stats" is ordinary chat; stay silent (don't DM, don't peel).
    if (!messageTagsBot(m)) continue;
    const statsPeel = peelClause(m.body, (c) => STATS_REQUEST.test(c));
    if (!statsPeel) continue;
    const sender = senderById.get(m.waMessageId)!;
    const phone = (sender.phone || m.authorPhone || "").replace(/^\+/, "");
    if (!sender.userId || !phone) continue; // can't DM an unresolved sender
    try {
      const token = signMagicLinkToken({
        userId: sender.userId,
        purpose: "sign-in",
        nextPath: "/profile/stats",
        ttlSeconds: MAGIC_LINK_TTL.actionNudge,
      });
      const first = sender.name?.split(" ")[0] ?? "there";
      await db.botJob.create({
        data: {
          orgId: org.id,
          kind: "dm",
          phone,
          text:
            `📊 Hey ${first} — here are your MatchTime stats: ratings over time, your ` +
            `Man-of-the-Match games, how you compare to the squad, your badges, and a ` +
            `shareable season card.\n\n${await buildShortMagicLinkUrl(token)}\n\nLink works for 48h.`,
        },
      });
    } catch (err) {
      console.error("[analyze] my-stats DM queue failed:", err);
    }
    await claimFastPath(m, statsPeel, {
      handledBy: "fast-path",
      intent: "stats_link",
      action: "dm-stats-link",
      reasoning: "personal stats request — DM'd a magic link to /profile/stats",
      react: "📊",
      reply: null,
    });
  }
  // ── DELETED 2026-09-10: the stats-blast REGEX fast path ────────────
  //   It lived here, and it was the last bulk-DM command in the product
  //   still classified by a pattern. The trigger was three keyword tests
  //   ANDed together over the whole body:
  //
  //     /\b(dm|send|share|message)\b/  AND
  //     /\b(stats|ratings?)\b/         AND
  //     /\b(everyone|all|active|players|squad|the team|the group)\b/
  //
  //   At 18:38 on 2026-09-10 Kemal posted an ordinary reminder to his
  //   players in the live Sutton FC group:
  //
  //     "please do not forget to rate the players via the link from
  //      Matchtime DM'ed to you. the more accurate ratings, the more
  //      balanced teams next time"
  //
  //   Each test matched a different, unrelated fragment of that one
  //   sentence — "DM'ed to you", "the more accurate ratings", "rate the
  //   players" — and MatchTime recorded `by=fast-path intent=stats_blast
  //   action=dm-stats-blast:69` and queued 69 personal stats-link DMs.
  //   One was delivered before the queue was killed; 68 were deleted
  //   unsent. The sentence is an instruction to the PLAYERS and means
  //   roughly the opposite of what fired.
  //
  //   THE FIX IS A DELETION, for the third time in this codebase
  //   (2026-04-21 `handlers.ts:7-10`; 2026-09-01 `looksLikeRecruitRequest`,
  //   the tombstone 60 lines below). A fourth keyword test or an
  //   exclusion list would be a fourth thing to get wrong in front of
  //   the widest mass DM the product has — 69 people, from an unofficial
  //   WhatsApp client, which `recruit-lookback.ts` calls the way the
  //   account gets banned and the whole product goes down.
  //
  //   The stats blast is now an extracted FACT (`AdminFacts.action =
  //   "stats_blast"` on the `admin_ops` route), GATED by the engine
  //   (admin, plus an EXPLICIT @-mention — `lib/stats-blast.ts` explains
  //   why `messageTagsBot` is not a gate here: the incident sentence
  //   contains the bare word "Matchtime" and is therefore "tagged"), and
  //   PERFORMED by this route in the batch-final pass beside the recruit
  //   blast. The action, the recipients and the copy are unchanged; only
  //   the classification moved from regex to model, and the decision
  //   from this loop to the engine.
  //
  //   ── TWO THINGS WENT WITH IT, STATED RATHER THAN DISCOVERED ───────
  //
  //   THE 🔒 DENIAL. A non-admin's ask was answered with a 🔒 react and
  //   an `stats_blast_denied` row. Nothing recognises a non-admin's ask
  //   any more, so it is silence plus one line on the operator note —
  //   the same trade the recruit deletion made on 2026-09-01.
  //
  //   THE CLAUSE PEEL. "@Match Time send everyone their stats. Also I'm
  //   out" used to blast AND drop the sender. `admin_ops` is a
  //   whole-message route and a step-7 owner never sees a residual, so
  //   the attendance half of a compound bulk-DM command is now lost —
  //   exactly as it already is for a payment credit, a reminder and the
  //   recruit blast on that route. A peel needs a deterministic
  //   predicate over language, and a deterministic predicate over
  //   language is what caused this incident. The follow-up, if it is
  //   worth one, is a `sideRequests` entry on the ATTENDANCE extractor,
  //   which is how a recruit ask survives beside a drop.

  // ── Group → DM: "@MT DM me <question>" ──────────────────────────────
  //   When someone in the group explicitly asks to be DM'd an answer
  //   ("dm me the fixtures", "@Match Time message me when's the next
  //   game"), answer them PRIVATELY via the scoped Q&A engine instead
  //   of cluttering the group. Same no-leak guardrails as direct DMs
  //   (dm-qa.ts: only group-public + the asker's own data). React 📩 in
  //   the group so it's clear it was handled. Personal stats requests
  //   are already handled above (they DM a stats link), so skip those.
  //
  //   CLAUSE-PEELED, AND THIS IS THE ONE WHERE THE CONSUMED CLAUSE IS
  //   LOAD-BEARING. Every other peel ignores the body once it has
  //   matched; this one FEEDS it to `answerScopedQuestion`, so what gets
  //   answered is the clause that asked, not the whole message. That is
  //   why the splitter refuses to break on a bare "and": "dm me who's in
  //   and who's out" is ONE question and must stay one
  //   (`clause-peel.ts` pins it). "@Match Time dm me the fixtures. Also
  //   I'm out" answers the fixtures privately AND drops him.
  const DM_ME = /\b(dm|pm|message)\s+me\b/i;
  for (const m of fresh) {
    if (fastPathHandledIds.has(m.waMessageId)) continue;
    // Interaction contract: "DM me <question>" is an answer MT gives →
    // requires an @Match Time tag. Untagged → ordinary chat, stay silent.
    if (!messageTagsBot(m)) continue;
    const dmPeel = peelClause(m.body, (c) => DM_ME.test(c));
    if (!dmPeel) continue;
    const sender = senderById.get(m.waMessageId)!;
    const phone = (sender.phone || m.authorPhone || "").replace(/^\+/, "");
    if (!sender.userId || !phone) continue; // can't DM an unresolved sender
    try {
      const result = await answerScopedQuestion({
        userId: sender.userId,
        orgId: org.id,
        question: dmPeel.consumed,
        askerName: sender.name,
      });
      if (result) {
        await db.botJob.create({
          data: { orgId: org.id, kind: "dm", phone, text: result.answer },
        });
      }
    } catch (err) {
      console.error("[analyze] group→DM Q&A failed:", err);
    }
    await claimFastPath(m, dmPeel, {
      handledBy: "fast-path",
      intent: "dm-qa",
      action: "dm-scoped-answer",
      reasoning: "group request to be DM'd — answered privately via scoped Q&A",
      react: "📩",
      reply: null,
    });
  }

  // ── DELETED 2026-09-01: the recruit REGEX fast path ─────────────────
  //   It lived here, matched `looksLikeRecruitRequest(m.body)`, and then
  //   peeled the message off the LLM batch UNCONDITIONALLY. On 2026-09-01
  //   the owner wrote "Najib is out. We need one more player." — the
  //   regex matched the second sentence and the third-party OUT was never
  //   analysed by anything. Najib stayed in, the recruit action saw 10/10,
  //   and MatchTime told the owner his squad was full.
  //
  //   Recruit is now an extracted verdict FACT (`verdict.recruitRequest`,
  //   a flag rather than an intent, because one message carries both a
  //   drop and an ask). It is applied AFTER every attendance write in the
  //   batch, so the blast sees the corrected squad — see "VERDICT-DRIVEN
  //   RECRUIT" further down. The deterministic action and the admin gate
  //   are unchanged; only the classification moved from regex to model.
  //
  //   `looksLikeRecruitRequest` still exists for ONE remaining caller,
  //   api/whatsapp/dm-reply/route.ts — a 1:1 DM surface with no verdict
  //   pipeline. Converting that is the next step, not this PR's.

  // ── DELETED 2026-09-11: the rating-progress REGEX fast path ────────
  //   It lived here, matched `looksLikeRatingProgressRequest(m.body)`,
  //   and was CLAUSE-PEELED. The trigger was two keyword tests ANDed
  //   over the whole body:
  //
  //     /\b(rate|rated|rating|ratings|mom|motm|…|voted|vote)\b/  AND
  //     /\b(so far|remaining|left|pending|yet|hasn'?t|not yet|…)\b/
  //
  //   The comment that stood here called it, correctly, "the WIDEST
  //   trigger of the six peels": "I haven't rated yet and I'm out
  //   Thursday" satisfies both halves and addresses nobody. It is the
  //   same conjunction shape that matched the second sentence of "Najib
  //   is out. We need one more player." on 2026-09-01 and that queued 69
  //   personal stats-link DMs on 2026-09-10 — the two deletions whose
  //   tombstones sit above this one.
  //
  //   THE FIX IS A DELETION, for the fourth time in this codebase
  //   (2026-04-21 `handlers.ts:7-10`; 2026-09-01 `looksLikeRecruitRequest`;
  //   2026-09-10 the stats blast; now this and the DM surface's last
  //   caller). A third keyword test or an exclusion list would be a third
  //   thing to get wrong.
  //
  //   The ask is now an extracted FACT — `QuestionFacts.topic =
  //   "rating_progress"` on the `question` route — gated by the engine
  //   (admin, plus the question route's own @Match Time tag) and
  //   answered by `pipeline/compose.ts` from a targeted database read
  //   that `pipeline/answer-batch.ts` performs only when such a topic
  //   survived ownership. The answer, its copy and the admin gate are
  //   unchanged; only the classification moved from regex to model.
  //
  //   ── WHY `question` AND NOT `admin_ops`, WHICH IS WHERE THE STATS
  //      BLAST WENT. Measured on the live router, 2026-09-11, 15 calls
  //      a phrasing: "@Match Time who hasn't rated yet?", "how many have
  //      rated so far?", "who hasn't picked a MoM yet?" and "who is
  //      still to rate from tuesday" all come back `question` 15/15 —
  //      60 of 60. The router's own rule 8 says why: "ASKING is
  //      question; INSTRUCTING is admin_ops." Putting the fact on
  //      `admin_ops` would have shipped a feature the router never
  //      routes to.
  //
  //   ── THREE THINGS WENT WITH IT, STATED RATHER THAN DISCOVERED ─────
  //
  //   THE CLAUSE PEEL. "@Match Time who hasn't rated yet? Also I'm out"
  //   used to answer AND drop the sender. `question` is a whole-message
  //   route, so the attendance half of a compound rating question is now
  //   lost — exactly as it already is for the stats blast, the recruit
  //   blast, a payment credit and a reminder. A peel needs a
  //   deterministic predicate over language, and a deterministic
  //   predicate over language is what caused the two incidents above.
  //
  //   THE UNTAGGED ANSWER. This peel was not tag-gated at all. The
  //   `question` route requires a tag, so "who hasn't rated yet?" with
  //   no tag is now silence. That is the ordinary bar every other answer
  //   has had since 2026-09-08; `RATING_PROGRESS_TAG_MUST_BE_EXPLICIT`
  //   records why it is not raised any higher than that.
  //
  //   THE 📋 REACT and the `rating_progress_denied` row. A non-admin's
  //   ask now gets the same silence every other unowned message gets,
  //   plus one line on the operator note.

  // ── Fast-path: "@Match Time help [topic]" → usage / topic explainer ─
  //   Tag-gated (honours the interaction contract — only when the bot is
  //   addressed). Feature-aware via the org's live flags. Deterministic;
  //   peeled off the LLM batch so the model never sees it. An OPTIONAL
  //   trailing topic word ("help teams", "help ratings", …) routes into
  //   buildHelpReply for a detailed explainer; bare "help" prints the
  //   topic menu + the how-to block. The regex still REQUIRES the help
  //   keyword and stays single-token-anchored (no mid-sentence "help"
  //   triggers), allowing only an optional topic token after it.
  //
  //   ── NOT CLAUSE-PEELED, AND THAT IS ARGUED, NOT DEFERRED ──────────
  //   `HELP_RE` is anchored `^…$` over the WHOLE body and allows only a
  //   single optional topic token after the keyword. A message it
  //   matches is STRUCTURALLY incapable of carrying a second clause:
  //   there is no compound "@Match Time help, and I'm out" that this
  //   regex accepts, because the comma alone fails the anchor. So this
  //   peel legitimately owns the whole message and `peelClause` would
  //   return `{consumed: body, residual: ""}` on every input it sees —
  //   the same behaviour with an extra call. The one below it, the
  //   bench-prompt answer, is left terminal for the same kind of reason
  //   (a whole-message allowlist); see its own header.
  const HELP_RE =
    /^\s*(?:@?\s*match\s*time|@mt|matchtime)?\s*\bhelp\b(?:\s+[\w &]+?)?\s*$/i;
  for (const m of fresh) {
    if (fastPathHandledIds.has(m.waMessageId)) continue;
    if (!HELP_RE.test(m.body)) continue;
    if (!messageTagsBot(m)) continue;
    fastPathHandledIds.add(m.waMessageId); // peel off the LLM batch
    const feats = await getOrgFeatures(org.id);
    const topic = parseHelpTopic(m.body);
    const reply = buildHelpReply(topic, {
      attendance: feats.attendance,
      teamBalancing: feats.teamBalancing,
      momVoting: feats.momVoting,
      playerRating: feats.playerRating,
      statsQa: feats.statsQa,
      reminders: feats.reminders,
      bench: feats.bench,
      paymentTracking: feats.paymentTracking,
    });
    const sender = senderById.get(m.waMessageId)!;
    await recordAnalysis({
      orgId: org.id, groupId: body.groupId, msg: m,
      handledBy: "fast-path", intent: "help", action: "help",
      confidence: 1, reasoning: "usage help requested",
      authorUserId: sender.userId, authorName: m.authorName ?? null,
    });
    results.push({ waMessageId: m.waMessageId, handledBy: "fast-path", intent: "help", react: "👋", reply });
  }

  // Pre-load the ACTIVE registration match. Every attendance WRITE in
  // this request lands on it, every reply is proximity-checked against
  // it, and the four deterministic peels below read it.
  //
  // UNIFIED with findRegistrationMatch (2026-06-18 rollover fix): this
  // MUST be the exact same match every attendance write lands on, picked
  // by the shared pure selector (soonest upcoming, regardless of fullness
  // or attendanceDeadline). Previously this used an attendanceDeadline
  // filter, so once tonight's deadline passed it silently drifted to next
  // week's match — the reply/reconciliation passes then described a
  // different match than the one the write touched.
  const activeMatchForReply = await findRegistrationMatch(org.id);
  const nextMatchForReply = activeMatchForReply
    ? await db.match.findFirst({
        where: { id: activeMatchForReply.id },
        include: {
          attendances: {
            where: { status: "CONFIRMED" },
            include: { user: { select: { name: true } } },
            orderBy: { position: "asc" },
          },
        },
      })
    : null;

  // ═══════════════════════════════════════════════════════════════════
  // §10 STEP 8 — FOUR DETERMINISTIC PEELS, NONE OF WHICH NEEDS A MODEL
  // ═══════════════════════════════════════════════════════════════════
  //
  // Each of these was already deterministic. What made them look like
  // model work was only that they hung off a field the model populated,
  // and deleting the model would have deleted them by accident.
  //
  // They run BEFORE the router, on the raw body and on database rows, so
  // no owner can also claim them and there is exactly one decider per
  // message — the same invariant `claim()` asserts for the owners.
  //
  // Every one requires an `@Match Time` tag except the bench-prompt
  // answer, which is a player answering a direct question MatchTime
  // asked them about their own slot — the purest self-attendance there
  // is, and `interaction-contract.ts` exempts exactly that. Requiring a
  // tag there would mean ignoring the answer to our own question.
  //
  // ═════════════════════════════════════════════════════════════════
  // WHAT A PEEL SKIPS. ASK THIS, NOT "IS MY NEW CODE CORRECT?"
  // ═════════════════════════════════════════════════════════════════
  //
  // This file's worst bug class is a terminal branch that silently
  // deletes every guard beneath it — three incidents in two days. A peel
  // is terminal by construction: it pushes a result and adds the id to
  // `fastPathHandledIds`, which the ONE splice below removes from `fresh`.
  // So the message skips EVERYTHING after this point. Enumerated, with
  // why each is covered, subsumed or inapplicable:
  //
  //   the router                    Inapplicable. The peel already knows
  //                                 what the message is, from a database
  //                                 row or a whole-message match. Paying
  //                                 Haiku to label it would be paying for
  //                                 an answer we have.
  //   all five owners               COVERED, and this is the POINT. Two
  //                                 deciders for one message is two
  //                                 replies for one message. The engine
  //                                 independently refuses a pasted roster
  //                                 (its `parsePastedRoster` carve-out)
  //                                 and a sender with an open bench
  //                                 prompt (its `promptedUserIds` carve-out), so those two are
  //                                 belt AND braces; the swaps are peeled
  //                                 only because nothing else models a
  //                                 `TeamAssignment` move.
  //   the operator note             SUBSUMED. The note is for a message
  //                                 NOBODY handled. A peel handled it,
  //                                 and its `AnalyzedMessage` row records
  //                                 what it did.
  //   the unresolved-sender nudge   Inapplicable to three of the four
  //                                 (they need no sender), and for the
  //                                 bench answer the trigger IS a
  //                                 resolved `senderUserId` — an
  //                                 unresolved sender cannot be on the
  //                                 `PendingBenchConfirmation` list, so
  //                                 the peel never fires for one.
  //   the react/status audit        Inapplicable: no peel emits a
  //                                 registration react (✅/🪑/👋).
  //   the batch-final squad post    NOT skipped for the one peel that
  //                                 changes the squad. The pasted-roster
  //                                 ack is `SQUAD_POST_MARKER`, and the
  //                                 composer's candidate filter admits it
  //                                 by name. The first draft did not, and
  //                                 a paste that had just registered four
  //                                 players said NOTHING — see the note
  //                                 on `pastedRosterAck` below.
  //
  // ⚠️ THE ONE REAL COST, stated rather than discovered later: a peeled
  // message is spliced out of `fresh`, so it is absent from the WINDOW
  // the owners reason over. §10 step 6 is emphatic that this matters —
  // "taking a message OUT of the batch changed what the mega-prompt
  // concluded about the message NEXT to it". The splice is not new (the
  // stats link, the blast, group→DM and help have always been spliced),
  // but this change adds four shapes to it, and one of them —
  // a bench-prompt answer — is attendance-shaped. If a batch ever
  // contained both a bench answer and a third-party claim about that
  // same player, the corroboration policy would not see the answer.
  // Judged acceptable because the corroboration policy looks for a
  // SELF-DROP, and a bench answer is neither, but it is a genuine
  // narrowing and it is written down here rather than left to be found.

  // ── 1 + 2. COLOUR SWAP and TEAM SWAP ───────────────────────────────
  //
  //   Both shipped, both already pure functions of `(orgId, body)`, and
  //   both used to sit INSIDE the per-message loop after the tag gate —
  //   which meant they were reached only when the model's verdict had
  //   survived that far. They are moved up rather than rewritten.
  //
  //   The tag requirement is now EXPLICIT instead of being inherited
  //   from `actionRequiresTag(verdict)`. That is the same policy stated
  //   directly: both team intents are in `ACTIONY_INTENTS`, so an
  //   untagged one was already refused. Measured on 120 days of real
  //   traffic, every colour/team swap in the group carries the tag
  //   ("@Match Time swap the colors and keep the same squad").
  //
  //   Order matters and is preserved from the loop: COLOUR first, so
  //   "swap the colours" can never be read as a player swap.
  for (const m of fresh) {
    if (fastPathHandledIds.has(m.waMessageId)) continue;
    if (!messageTagsBot(m)) continue;
    // CLAUSE-PEELED. `looksLikeColourSwapPhrase` is the handler's own
    // literal-colour detection, lifted out so the clause can be chosen
    // WITHOUT a database read. It is deliberately the label-free half:
    // when it finds nothing, the WHOLE body still goes to the handler,
    // so the custom-team-label branch (which needs the match row to know
    // what this org calls its sides) is reached exactly as it is today.
    const colourPeel = peelClause(m.body, looksLikeColourSwapPhrase);
    const colourResult = await handleColorSwapIfApplicable(
      org.id,
      colourPeel?.consumed ?? m.body,
    );
    if (colourResult) {
      await claimFastPath(m, colourPeel, {
        handledBy: "fast-path",
        intent: "team_colour_swap",
        action: "colour-swap",
        reasoning: colourResult.logReason,
        react: "✅",
        reply: colourResult.reply,
      });
      continue;
    }
    // "swap A with B" is a TEAM-SHEET edit, never a drop. This guard
    // exists because the mega-prompt had a forceful "swap X with Y =
    // X OUT" rule that wrongly dropped Elvin on 2026-05-19. The prompt
    // is gone, so the rule that misfired is gone — but the FEATURE is
    // not, and it is the reason this stays: "swap Mustafa and Idris" is
    // a team change the group asks for every few weeks (5 in the last
    // 90 days), and it is a `TeamAssignment` move that no attendance
    // extractor models.
    //
    // ⚠️ WIDENED 2026-09-08 — THE PEEL NOW SWALLOWS MORE. WHAT, AND
    //    WHAT THOSE MESSAGES LOSE:
    //
    // It used to own a swap only when BOTH named players were
    // CONFIRMED. It now also owns the REPLACEMENT — one side CONFIRMED
    // holding no slot, the other holding a slot but NOT CONFIRMED —
    // because that is the state the Elvin/Raihan message was in and
    // declining it left a stale team sheet on a match night.
    //
    // The widening is one DATABASE STATE, not one message shape. The
    // sentence matched is byte-identical, and the PARSE actually got
    // stricter: `parseSwapNames` can no longer backtrack inside a word,
    // so "no swap needed" (which used to yield `need` + `ed` and was
    // saved only by neither half resolving) now matches nothing at all.
    //
    // ✅ FIXED 2026-09-09 — WHAT THAT WIDENING COST, AND WHAT PAID IT.
    //
    // The paragraph that stood here said: "a peel is terminal — the id
    // goes into `fastPathHandledIds` and the one splice below removes
    // the message from `fresh` — so '@Match Time swap Elvin with
    // Raihan, and I'm out' now applies the slot move and drops the
    // sender's own OUT on the floor", and accepted it. That was the
    // SIXTH instance of this file's worst bug class, and it is the
    // headline case the clause peel exists for.
    //
    // The peel now takes the SWAP CLAUSE. "and I'm out" stays in the
    // batch, reaches the router and the attendance engine, and the
    // sender is dropped in the same request that moves the slot. Both
    // halves land; one message is sent. `e2e/api/clause-peel.spec.ts`
    // is that sentence, verbatim.
    //
    // THE LIMIT, STATED: the splitter refuses to break on a bare "and",
    // because "swap the reds and yellows" is one request and splitting
    // it would break the colour peel above. So "swap A with B and I'm
    // out", with NO comma, is still peeled whole and still loses the
    // OUT. Half the incident's phrasings, not all of them, and the
    // reason is written down in `clause-peel.ts` rather than left to be
    // rediscovered.
    //
    // AND THE ALTERNATIVE IS MEASURED, not assumed: before this change
    // a replacement-shaped swap fell through to the router, reached
    // `balancer`, and `team-ops-engine-batch.ts` handed `swap` back —
    // SILENCE plus one operator note. That is exactly what the owner
    // got at 16:47 on 2026-09-08. Nothing useful is being taken from
    // the pipeline; the pipeline had nothing to give this shape.
    //
    // EVERY REFUSAL STILL FALLS THROUGH. `handleTeamSwapIfApplicable`
    // returns null for all five refusal reasons in `team-slot-swap.ts`,
    // so an ambiguous state reaches the router and the owners exactly
    // as it does today, and the peel owns no message it cannot act on.
    //
    // AND THE PEEL SELECTS ITS CLAUSE WITH THE HANDLER'S OWN PARSER.
    // `peelClause` applies `parseSwapNames` to the whole body FIRST and
    // returns null if it finds nothing — which is precisely when
    // `handleTeamSwapIfApplicable` would have returned null on its first
    // line. The two are equivalent, so this owns not one message more
    // than it did; only the residual is new.
    const swapPeel = peelClause(m.body, (c) => parseSwapNames(c) !== null);
    if (!swapPeel) continue;
    const swapResult = await handleTeamSwapIfApplicable(org.id, swapPeel.consumed);
    if (swapResult) {
      await claimFastPath(m, swapPeel, {
        handledBy: "fast-path",
        intent: "team_swap",
        action: "team-swap",
        reasoning: swapResult.logReason,
        react: "✅",
        reply: swapResult.reply,
      });
    }
  }

  // ── 3. THE BENCH-PROMPT ANSWER ─────────────────────────────────────
  //
  //   A bench player answering MatchTime's own "do you want the slot?"
  //   in the GROUP instead of reacting to the DM. `executeVerdict` used
  //   to reach `resolveBenchConfirmation` through
  //   `verdict.benchConfirmation`, and `attendance-engine-batch.ts`
  //   refuses the message for exactly that reason: "a bare 'yes' from
  //   someone with a prompt open stays with the analyzer."
  //
  //   There is no analyzer. But there was never anything to classify
  //   either: the TRIGGER is a `PendingBenchConfirmation` row for this
  //   exact sender, so by the time the text is read the prior is
  //   overwhelming and only a yes/no has to be told apart.
  //   `lib/bench-prompt-answer.ts` does that on a whole-message
  //   allowlist, never a substring, so "no idea what time we're playing"
  //   and "yes but I can only do the first half" both come back null and
  //   fall through to the ordinary pipeline.
  //
  //   ⚠️ ONE SHIPPED BEHAVIOUR IS PRESERVED THAT I WOULD QUESTION IF
  //   THIS WERE NOT A DELETION PR. A bench player who writes "I'm out"
  //   meaning "drop me from the match entirely" is read as DECLINING the
  //   slot, which `resolveBenchConfirmation` treats as a no-op — they
  //   stay on the bench rather than being dropped. That is exactly what
  //   ships today: `route.ts:3186-3190`'s own comment said
  //   "bench-confirmation outranks generic IN/OUT for users on the
  //   open-prompt list". Changing it here would be inventing new product
  //   semantics inside a change that is meant to preserve them, so it is
  //   preserved and flagged instead.
  //
  //   ── NOT CLAUSE-PEELED, AND THAT IS ARGUED, NOT DEFERRED ──────────
  //   `readBenchPromptAnswer` is a WHOLE-MESSAGE allowlist, never a
  //   substring: this section's own header says so, and it is why "yes
  //   but I can only do the first half" comes back null and falls
  //   through. A message it accepts is a bare "yes"/"no" and has no
  //   second clause to lose — `peelClause` would return
  //   `{consumed: body, residual: ""}` for every input it can see.
  //   Adding the call would be ceremony, not a guard.
  if (nextMatchForReply) {
    const openPrompts = await db.pendingBenchConfirmation.findMany({
      where: { matchId: nextMatchForReply.id, resolvedAt: null },
      select: { userId: true },
    });
    const prompted = new Set(openPrompts.map((p) => p.userId));
    if (prompted.size > 0) {
      for (const m of fresh) {
        if (fastPathHandledIds.has(m.waMessageId)) continue;
        const sender = senderById.get(m.waMessageId)!;
        if (!sender.userId || !prompted.has(sender.userId)) continue;
        const answer = readBenchPromptAnswer(m.body);
        if (!answer) continue;
        fastPathHandledIds.add(m.waMessageId);
        // The server posts its own group announcement on a confirm, so
        // the reply here is null in every branch and only the react
        // speaks — byte-identical to `route.ts:3199-3206`.
        let react: string | null = null;
        try {
          const result = await resolveBenchConfirmation({
            matchId: nextMatchForReply.id,
            userId: sender.userId,
            decision: answer === "yes",
          });
          if (result.kind === "confirmed") react = "✅";
          else if (result.kind === "declined") react = "👋";
          // "ignored" — the prompt was resolved between the read above
          // and here. Say nothing; there is nothing true to say.
        } catch (err) {
          console.error("[analyze] bench-prompt answer failed:", err);
        }
        await recordAnalysis({
          orgId: org.id, groupId: body.groupId, msg: m,
          handledBy: "fast-path", intent: "bench_confirmation",
          action: react ? `bench-${answer}` : "none",
          confidence: 1,
          reasoning: `bench prompt open for this sender; answer read as "${answer}"`,
          authorUserId: sender.userId, authorName: m.authorName ?? null,
        });
        results.push({
          waMessageId: m.waMessageId, handledBy: "fast-path",
          intent: "bench_confirmation", react, reply: null,
        });
      }
    }
  }

  // ── 4. THE PASTED ROSTER — THIS BRANCH OWNS THE LIST, NOT THE MESSAGE ─
  //
  //   THE ARITHMETIC WAS NEVER THE MODEL'S. `reconcilePastedRoster`
  //   decides whether the paste restates our own roster post in Match
  //   Context order and, if it does, COMPUTES which lines are new. The
  //   old code took the model's picks off the list and threw all of them
  //   away, replacing them with that computation. So this branch loses
  //   only the residue — names the model found that the LIST does not
  //   mention, i.e. prose travelling alongside a paste ("here's the
  //   list, also adding Kieran"). Kieran needs one more message, which
  //   is §13's stated trade: "a missed add is recoverable in one
  //   message; a wrong registration on a paid match is not."
  //
  //   Anything that is NOT of record registers NOBODY — the clamp's
  //   outcome, reached by construction rather than by subtraction, since
  //   with no model there are no list-derived writes to clamp.
  //
  //   ═════════════════════════════════════════════════════════════════
  //   IT IS NO LONGER TERMINAL (2026-09-07) — AND THAT IS THE FIX
  //   ═════════════════════════════════════════════════════════════════
  //
  //   It used to do `fastPathHandledIds.add(m.waMessageId)`, which peels
  //   the WHOLE message out of `fresh` before the router runs. So a
  //   message that was BOTH a list and its sender's own drop lost the
  //   drop: Pat writes "can't make it lads, someone take my spot" above
  //   the list, and stays CONFIRMED. The squad reads full, the vacated
  //   slot is never offered to the bench, and the club is a player short
  //   on the night. It is the FOURTH instance of one bug class in this
  //   file — a terminal branch that silently deletes every guard below
  //   it — after the recruit fast path (2026-09-01), PR #29's
  //   guest-name-ask branch, and step 6's engine short-circuit.
  //
  //   The message now stays in the batch. This branch still applies the
  //   arithmetic, and `attendance-engine-batch.ts`'s clamp
  //   (`clampPastedRosterFacts`) lets the engine take exactly one thing
  //   off a roster-shaped message: THE SENDER'S OWN DROP. Nothing about
  //   drop handling is reimplemented here — the drop goes to the owner
  //   whose rules already cover it, which is what MEMORY.md's note on
  //   this bug class asks for ("prefer NOT OWNING a shape over
  //   reimplementing a shipped guard inside the new branch").
  //
  //   WHAT NOT PEELING EXPOSES THE MESSAGE TO, and what covers each:
  //
  //     • THE ROUTER. It now costs one line of a batched Haiku call and
  //       one attendance-extractor call per paste. Real money, a few
  //       times a week, and the clamp above discards everything the
  //       extractor reads off the list.
  //     • THE ATTENDANCE ENGINE. Clamped to the sender's own OUT, per
  //       above. It can no longer read fourteen third-party INs off a
  //       list, which was the original reason for refusing the shape.
  //     • THE FOUR STEP-7 OWNERS (`question`, `balancer`, `score`,
  //       `admin_ops`). Explicitly excluded — `ownerBase` filters
  //       `pastedRosterIds` out. A misrouted list must not be answered
  //       as a question or read as a score, and that exposure is new
  //       with this change, so it is closed here rather than argued
  //       about.
  //     • THE "NOBODY OWNED IT" BRANCH. A paste the engine does not own
  //       would otherwise land there: an `ignored`/`noise` row and a
  //       line on the operator DM, replacing this branch's own
  //       `pasted_roster` row. So the row and the reply are DEFERRED
  //       into `pastedRosterReports` and emitted in that same loop, one
  //       result per message, only when no owner spoke.
  //
  //   ONE OWNER PER MESSAGE STILL HOLDS. Two things can WRITE for one
  //   paste (this branch registers the appended names; the engine drops
  //   the sender), which is the same shape as PR #33's "a recruit ask
  //   alongside a drop must do BOTH". Only one of them ever SPEAKS:
  //   whoever owns the message in the loop below.
  const pastedRosterIds = new Set<string>();
  const pastedRosterReports = new Map<
    string,
    {
      handledBy: ActionForBot["handledBy"];
      action: string;
      reasoning: string;
      react: string | null;
      reply: string | null;
    }
  >();
  if (nextMatchForReply) {
    const confirmedNames = nextMatchForReply.attendances.map((a) => a.user.name ?? "");
    for (const m of fresh) {
      if (fastPathHandledIds.has(m.waMessageId)) continue;
      const sender = senderById.get(m.waMessageId)!;
      const decision = decidePastedRosterRegistration({
        body: m.body,
        confirmedNames,
        senderNames: [sender.name, m.authorName],
      });
      if (decision.kind === "not_a_roster") continue;
      // NOT `fastPathHandledIds` — that set is what the splice below reads,
      // and peeling the message is the defect this section's header is
      // about. This one only says "the list has been dealt with".
      pastedRosterIds.add(m.waMessageId);

      if (decision.kind === "not_of_record") {
        console.warn(
          `[analyze] pasted-roster: "${(m.body || "").slice(0, 60)}" (${m.waMessageId}) is a ` +
            `pasted list that does not restate the squad (${decision.reason}) — registering nobody. ` +
            `A re-paste is a restatement, not a registration; org ${org.id} should use ` +
            `featureSquadFromList if it maintains its squad this way.`,
        );
        pastedRosterReports.set(m.waMessageId, {
          handledBy: "fast-path",
          action: "none",
          reasoning: `pasted roster, not of record (${decision.reason}) — nobody registered`,
          react: null,
          reply: null,
        });
        continue;
      }

      // Of record. The appended names are new, arithmetically.
      const failures: string[] = [];
      const registered: string[] = [];
      for (const name of decision.additions) {
        const isSender = name === decision.senderAddition;
        try {
          const target =
            isSender && sender.userId
              ? { userId: sender.userId, name: sender.name }
              : await resolveOrProvisionByName(org.id, name);
          if (!target) {
            failures.push(name);
            continue;
          }
          await registerAttendance(target.userId, nextMatchForReply.id, {
            // The `pasted-roster` cause already exists in
            // `attendance-events.ts` for the `featureSquadFromList`
            // pipeline. This is the same event for the same reason on a
            // different door, so it reuses the cause rather than
            // inventing a synonym nobody would think to query for.
            event: {
              cause: "pasted-roster",
              actorKind: isSender ? "player" : "member",
              actorUserId: sender.userId ?? null,
              sourceRef: m.waMessageId,
              note: "appended to a pasted roster that restates the squad (S26)",
            },
          });
          registered.push(target.name ?? name);
        } catch (err) {
          console.error(`[analyze] pasted-roster register failed for ${name}:`, err);
          failures.push(name);
        }
      }
      console.warn(
        `[analyze] pasted-roster reconcile: "${(m.body || "").slice(0, 60)}" (${m.waMessageId}) ` +
          `restates the confirmed squad in order, so the ${decision.additions.length} appended ` +
          `name(s) [${decision.additions.join(", ")}] are new. Computed from the squad, not from ` +
          `anyone's reading of the list.`,
      );
      // The honest ack: nothing cheerful is said about a write that
      // threw, and the squad post below is composed from the DATABASE
      // after every write in this request has landed, so it shows what
      // actually happened either way (9f19040, §3.2 S7).
      pastedRosterReports.set(m.waMessageId, {
        handledBy: failures.length > 0 ? "error" : "fast-path",
        action: registered.length > 0 ? `register:${registered.length}` : "none",
        reasoning:
          `pasted roster of record — registered [${registered.join(", ")}]` +
          (failures.length > 0 ? `; FAILED for [${failures.join(", ")}]` : ""),
        react: failures.length > 0 ? null : registered.length > 0 ? "✅" : null,
        reply: registered.length > 0 ? SQUAD_POST_MARKER : null,
      });
    }
  }

  // Drop every FULLY peeled message from the batch the pipeline sees.
  // ONE splice for all of them, after the last peel, so a peel added
  // later cannot leave its message in the batch for an owner to claim as
  // well.
  //
  // "FULLY" is the 2026-09-09 change and it is the whole mechanism in
  // one line. A fast path that took a CLAUSE registers a residual, and a
  // message with a residual is NOT spliced: it stays in `fresh` with the
  // rest of its body, so the router labels it and the attendance engine
  // can act on the half nobody claimed. Being handled and being gone
  // stopped being the same fact.
  for (let i = fresh.length - 1; i >= 0; i--) {
    const id = fresh[i].waMessageId;
    if (fastPathHandledIds.has(id) && !clauseResidualById.has(id)) fresh.splice(i, 1);
  }

  const history = (body.history ?? []).map((h) => ({
    authorName: h.authorName,
    body: h.body,
    timestamp: new Date(h.timestamp),
  }));

  // ── §10 STEP 5 — THE ROUTER GATE, NO LONGER BEHIND A FLAG ──────────
  //
  //   "`none`-routed messages skip the analyzer; everything else hits
  //    the existing prompt unchanged."
  //
  // 69.3% of real traffic is banter (measured over 1,723 production
  // messages, PR #35). A cheap Haiku router decides which messages the
  // rest of the pipeline is spent on.
  //
  // ─────────────────────────────────────────────────────────────────
  // `ROUTER_GATE_ENABLED` AND `ATTENDANCE_ENGINE_ENABLED` ARE GONE
  // ─────────────────────────────────────────────────────────────────
  //
  // Both were reverts, and the thing they reverted TO was `analyzeBatch`.
  // Step 8 deletes it, so their "off" positions stopped being reverts and
  // became something much worse:
  //
  //   • `ATTENDANCE_ENGINE_ENABLED=0` would leave NOBODY handling
  //     `self_att` / `other_att` / `offer` / `unsure`. Every "IN", every
  //     "sorry lads can't make it", every admin demote would be silence
  //     plus an operator note. That is not a lever, it is a kill switch
  //     for the product's core write path with a name that reads like a
  //     tuning flag.
  //   • `ROUTER_GATE_ENABLED=0` used to mean "the analyzer sees the
  //     banter too". With no analyzer it means only that `gatedIds` is
  //     empty, and every owner already refuses a `none` route on its own
  //     — so the flag is inert, and an inert flag is `gate.ts:227`'s
  //     "worst kind of flag" seen from the other side.
  //
  // A flag whose off position has no implementation is worse than no
  // flag, so both are deleted rather than defaulted ON. **The revert for
  // step 8 is `git revert`, and that is worth saying plainly rather than
  // leaving a switch that looks like one.** The four STEP-7 route flags
  // are kept and default ON, because THEIR off position is a survivable
  // degradation — see `pipeline/route-flags.ts`.
  //
  // THREE THINGS THE GATE DELIBERATELY DOES NOT DO, unchanged:
  //
  //   1. It does not remove skipped messages from `fresh`. Later passes
  //      scan the whole batch, and a `none` message vanishing would
  //      change what they conclude about its neighbours.
  //   2. It does not decide anything. It labels.
  //   3. It does not go silent. A skipped message still gets its
  //      `AnalyzedMessage` row, tagged `router-gate` — §11.1's complaint
  //      about the `none` bucket is that the message disappears with "no
  //      `AnalyzedMessage.action`", and this is what makes "did the gate
  //      eat an IN?" a query. That row matters MORE now that it is the
  //      nightly `none`-bucket sweep's only input.
  const gate =
    fresh.length > 0 && routerIsNeeded()
      ? await gateBatch(
          fresh.map((m) => ({
            waMessageId: m.waMessageId,
            // `pipelineBody`, not `m.body`: a message a fast path peeled
            // a clause off is routed on WHAT IS LEFT. Routing the whole
            // body would label the message by the half that has already
            // been dealt with — "swap Elvin with Raihan, and I'm out"
            // routes `balancer`, and the drop is never seen.
            body: pipelineBody(m),
            authorName: m.authorName,
          })),
          // The ONE thing the router was missing, and the reason PR #42
          // would not turn this flag on: a bare `👍` answering a slot
          // MatchTime had left open routes `none`, and the write is
          // lost. Both of the two real cases in 1,695 production
          // messages are that. It is not a pattern — the `👍` is banter
          // far more often than it is a registration — so the fix is a
          // ROW: is there an unanswered `BenchSlotOffer` /
          // `PendingBenchConfirmation` / `TentativeAvailability` on the
          // board right now? See `src/lib/pipeline/awaiting-answer.ts`.
          // Null 99% of the time, and with it nothing changes at all.
          { awaiting: await loadOpenQuestion(org.id) },
        )
      : null;
  const gatedIds = new Set(gate?.skipped ?? []);
  const gateRouteById = new Map((gate?.routes ?? []).map((r) => [r.messageId, r.route]));
  if (gate) {
    for (const d of gate.degradations) {
      console.warn(`[analyze] router-gate degraded (${d.messageId ?? "batch"}): ${d.detail}`);
    }
    console.log(
      `[analyze] router: ${gate.routes.length}/${fresh.length} routed, ` +
        `${gatedIds.size} banter, ${gate.floorForced.length} floor-forced, ` +
        `${gate.awaitingForced.length} forced by an open question ` +
        `(floor ${gate.floorEnabled ? "ON" : "OFF"})` +
        (gate.usage
          ? `, router $${(gate.usage.costUsd ?? 0).toFixed(5)} in ${gate.usage.ms}ms`
          : ", no router call"),
    );
  }

  // ── §10 STEP 6 — THE ATTENDANCE ENGINE, NOW THE ONLY DECIDER ───────
  //
  //   "Swap the attendance path to extractor + engine. `self_att`,
  //    `other_att`, `offer` only — the three routes covering every
  //    incident in the archive."
  //
  // FOUR routes since step 8: `unsure` joined them, because the thing
  // it used to fall back to no longer exists. See the essay on
  // `ENGINE_ROUTES` in `pipeline/gate.ts` — it also makes `router.ts`'s
  // router-failure comment true, which is the whole of §11.4's
  // containment.
  //
  // It still runs FIRST, and the reason is unchanged even though what it
  // runs ahead of has changed: two deciders for one message would mean
  // two replies for one message, and "MatchTime replies once or not at
  // all" is the invariant the whole tail of this function protects.
  //
  // It fails open on every axis it always did — no match, attendance off
  // for the org, an unroutable id, a bench prompt open for the sender, a
  // pasted roster, a state load that threw. What "fails open" MEANS has
  // changed and that is step 8's whole risk: those messages used to go
  // to the analyzer and now go to silence plus an operator note. Each
  // one is enumerated in `lib/attendance-engine-batch.ts`'s header, and
  // the two that carried real traffic got deterministic owners of their
  // own rather than being left to the note — a bench-prompt answer
  // (`lib/bench-prompt-answer.ts`) and a pasted roster
  // (`lib/pasted-roster-registration.ts`), both peeled before the router
  // runs.
  //
  // REVERT: `git revert`. The flag that used to sit here is gone — see
  // the essay above the router gate for why a switch whose off position
  // is "nobody handles attendance" is not a revert.
  const engineAdminIds = new Set(
    (
      await db.membership.findMany({
        where: { orgId: org.id, role: { in: ["OWNER", "ADMIN"] }, leftAt: null },
        select: { userId: true },
      })
    ).map((m) => m.userId),
  );
  const engineBatch =
    fresh.length > 0
      ? await runAttendanceEngineBatch({
          orgId: org.id,
          now: new Date(),
          expectedMatchId: activeMatchForReply?.id ?? null,
          enabled: true,
          history: history.map((h) => ({ author: h.authorName, body: h.body })),
          messages: fresh.map((m) => {
            const s = senderById.get(m.waMessageId)!;
            return {
              waMessageId: m.waMessageId,
              // The RESIDUAL for a clause-peeled message. This is the
              // line that rescues "and I'm out" from a swap message.
              body: pipelineBody(m),
              authorName: m.authorName,
              senderUserId: s.userId,
              senderName: s.name,
              senderIsAdmin: !!s.userId && engineAdminIds.has(s.userId),
              // NOT from the residual. The tag is a property of what the
              // sender WROTE, and peeling the clause that carried
              // "@Match Time" must not be able to change what the
              // interaction contract permits — in either direction.
              tagged: messageTagsBot(m),
              route: gateRouteById.get(m.waMessageId),
              gated: gatedIds.has(m.waMessageId),
            };
          }),
          deps: {
            registerAttendance,
            cancelAttendance,
            resolveOrProvision: (name) => resolveOrProvisionByName(org.id, name),
            openBenchPromptUserIds: async (matchId) =>
              (
                await db.pendingBenchConfirmation.findMany({
                  where: { matchId, resolvedAt: null },
                  select: { userId: true },
                })
              ).map((p) => p.userId),
            // The once-per-player-per-match guest-name-ask row. Its
            // READER (`pipeline/load-state.ts`) and its DECIDER
            // (`pipeline/engine.ts`) both moved out of this file in §10
            // step 8 and the WRITER did not arrive anywhere — see the
            // tombstone comment at the top of this file, now corrected.
            claimGuestNameAsk: buildClaimGuestNameAsk(),
          },
        })
      : null;
  const engineOwnedIds = engineBatch?.ownedIds ?? new Set<string>();
  // WHAT THE ENGINE DID, AND WHAT IT LOST — the lines are composed by a
  // pure function so the SELECTION of them is unit-testable.
  //
  // They used to be composed here behind `if (engineOwnedIds.size > 0)`,
  // which silenced them in exactly the case they exist for. A batch
  // where EVERY extraction failed — the total-overload edge — ends with
  // `ownedIds` empty, and `attendance-engine-batch.ts` goes out of its
  // way to carry the degradations through that early return precisely so
  // they could be printed ("returning the bare empty result would throw
  // away the only record of why the engine went quiet"). The gate threw
  // them away one layer up, and a batch that had just lost its whole
  // extraction became indistinguishable from one where the flag was
  // simply off. Found by asking what the fail-open path looks like at
  // its WORST, rather than whether it works at all.
  if (engineBatch) {
    const report = describeEngineBatch(engineBatch, fresh.length);
    for (const w of report.warns) console.warn(w);
    if (report.info) console.log(report.info);
  }

  // ── §10 STEP 8 — THE LAST FOUR OWNERS, AND THE END OF THE PROMPT ───
  //
  //   "Migrate the rest — `question`, `balancer`, `score`, `admin_ops`,
  //    one per week. RETIRE THE MEGA-PROMPT WHEN THE LAST ROUTE LEAVES."
  //
  // They have left. What stood between this comment and the loop below
  // — the `BatchInputMessage[]`, the single `analyzeBatch` call, the
  // re-expansion into one `AnalysisVerdict` per message, and the
  // partial-response net that prefix-matched six strings against
  // `verdict.reasoning` — is deleted in this change, along with
  // `analyzeBatch` and the 19,850-token `SYSTEM_PROMPT` themselves.
  //
  // ─────────────────────────────────────────────────────────────────
  // WHAT REPLACED THE PARTIAL-RESPONSE NET
  // ─────────────────────────────────────────────────────────────────
  // §9 lists it among the twenty-two seatbelts that SURVIVE, with one
  // instruction: "Keep, but fix the mechanism: today it prefix-matches
  // free-text `reasoning`; under the new design it matches a typed
  // error, which is what it always wanted to be."
  //
  // This is that fix, and the typed fact is ownership. A message that
  // reached the end of the batch with no owner is exactly the event the
  // old net was reaching for — "understood by a human, silently not
  // acted on by the bot" — stated as a property of the request rather
  // than reconstructed from a sentence the model wrote. It is composed
  // after the loop by `lib/operator-note.ts`, sent to the same admins,
  // on the same one-hour dedupe.
  //
  // ─────────────────────────────────────────────────────────────────
  // WHY THEY RUN HERE, AND IN SEQUENCE
  // ─────────────────────────────────────────────────────────────────
  // Before anything speaks, for the reason step 6 gives above: "two
  // deciders for one message would mean two replies for one message,
  // and 'MatchTime replies once or not at all' is the invariant the
  // whole tail of this function protects."
  //
  // In SEQUENCE rather than `Promise.all`, because `score`, `admin_ops`
  // and `balancer`-generate all write, and three write paths racing
  // against the same match is a hazard bought for nothing: each runner
  // makes ZERO model calls for a batch carrying none of its routes
  // (every one of them filters candidates by route before loading state
  // — `answer-batch.ts:388`, `score-engine-batch.ts:198`,
  // `admin-ops-engine-batch.ts:198`), so the ordering costs latency only
  // on the rare batch that genuinely carries two of them.
  //
  // ─────────────────────────────────────────────────────────────────
  // OWNERSHIP IS DISJOINT, AND IT IS ASSERTED
  // ─────────────────────────────────────────────────────────────────
  // Each runner claims a fixed, non-overlapping set of routes
  // (`ANSWER_ENGINE_ROUTES`, `SCORE_ENGINE_ROUTES`,
  // `ADMIN_OPS_ENGINE_ROUTES`, plus step 6's `ENGINE_ROUTES`), so two
  // owners cannot claim one id. `assertOneOwnerPerMessage` says so out
  // loud anyway: a double claim is the one defect whose symptom is the
  // bot replying twice in a customer's group, and it must not be
  // something only a code reading can rule out.
  //
  // AND ONE EXCLUSION, added 2026-09-07 with the pasted-roster change
  // above. A list is no longer peeled out of `fresh`, so for the first
  // time a step-7 owner could see one. None of them should: a misrouted
  // fourteen-line list must not be answered as a question, read as a
  // score, or taken as a team instruction. The attendance engine sees it
  // (clamped to the sender's own drop) because that is the whole point
  // of not peeling; the other four do not.
  //
  // AND A SECOND EXCLUSION, added 2026-09-09 with the clause peel. A
  // message a fast path took a clause off is not spliced any more, so a
  // step-7 owner could see its RESIDUAL — and a residual is a fragment,
  // torn out of the sentence that gave it meaning. "…and share us the
  // teams", left over from a swap, must not reach `balancer`; "the
  // ratings", left over from a stats blast, must not be answered as a
  // question. The attendance engine sees it (that is the entire point of
  // not splicing); the other four do not. THE COST, stated: "@Match Time
  // swap A with B. What time is kickoff?" still answers only the swap.
  const ownerBase = fresh
    .filter(
      (m) => !pastedRosterIds.has(m.waMessageId) && !clauseResidualById.has(m.waMessageId),
    )
    .map((m) => {
      const s = senderById.get(m.waMessageId)!;
      return {
        waMessageId: m.waMessageId,
        body: m.body,
        authorName: m.authorName,
        senderUserId: s.userId,
        senderName: s.name,
        tagged: messageTagsBot(m),
        // The STRICTER tag, read only by the bulk-DM commands. Same
        // rule as `tagged` about which body it is computed from: what
        // the sender WROTE, never a residual.
        taggedExplicitly: messageMentionsBotExplicitly(m),
        route: gateRouteById.get(m.waMessageId),
        gated: gatedIds.has(m.waMessageId),
      };
    });
  const ownerHistory = history.map((h) => ({ author: h.authorName, body: h.body }));
  const now = new Date();

  // The step-7 routes live for this request. The test-only per-request
  // header still works (it is inert unless MT_TEST_MODE is "1"), which
  // is what lets a live A/B move one route at a time without a deploy.
  const stepSevenEnabled = enabledStepSevenRoutes(
    process.env,
    routesHeaderOverride(request.headers.get(STEP_SEVEN_HEADER)),
  );

  const answerBatch =
    fresh.length > 0
      ? await runAnswerBatch({
          orgId: org.id,
          now,
          messages: ownerBase,
          history: ownerHistory,
          // Same contract as step 6: if the route's registration match
          // and the owner's state load ever disagree, the owner takes
          // nothing rather than answer about a different match.
          expectedMatchId: activeMatchForReply?.id ?? null,
          enabled: stepSevenEnabled,
          deps: {},
        })
      : null;

  const scoreBatch =
    fresh.length > 0
      ? await runScoreBatch({
          orgId: org.id,
          now,
          messages: ownerBase,
          history: ownerHistory,
          enabled: stepSevenEnabled,
          deps: buildScoreApplyDeps(),
        })
      : null;

  const adminOpsBatch =
    fresh.length > 0
      ? await runAdminOpsBatch({
          orgId: org.id,
          now,
          messages: ownerBase,
          history: ownerHistory,
          enabled: stepSevenEnabled,
          deps: {
            ...buildAdminOpsApplyDeps({ orgId: org.id }),
            // The per-category opt-out (`Membership.subReminderDm`), which
            // `route.ts:3959` read one row at a time. Loaded once per
            // batch here; the engine does the rest.
            reminderMutedUserIds: async () =>
              (
                await db.membership.findMany({
                  where: { orgId: org.id, leftAt: null, subReminderDm: false },
                  select: { userId: true },
                })
              ).map((r) => r.userId),
          },
        })
      : null;

  // `balancer`, action `generate`. The other half of the route
  // `runAnswerBatch` owns: that one answers `show` and has no apply
  // layer at all, this one runs the balancer and writes every
  // `TeamAssignment`. Split on a FACT the extractor returns
  // (`facts.action`) rather than on a flag, so ONE route keeps ONE flag
  // and the two handlers cannot both claim a message —
  // `route-flags.test.ts` asserts the predicates are disjoint.
  //
  // It is not optional in the way the others are: 23 of the last 120
  // days' tagged commands to MatchTime were "generate the teams", more
  // than every question shape combined. Silence here would not be a
  // conservative default, it would be the feature going dark.
  const teamOpsBatch =
    fresh.length > 0
      ? await runTeamOpsBatch({
          orgId: org.id,
          now,
          messages: ownerBase,
          history: ownerHistory,
          enabled: stepSevenEnabled,
          deps: buildTeamOpsApplyDeps({ orgId: org.id }),
        })
      : null;

  const ownerDegradations = [
    ...(answerBatch?.degradations ?? []),
    ...(scoreBatch?.degradations ?? []),
    ...(adminOpsBatch?.degradations ?? []),
    ...(teamOpsBatch?.degradations ?? []),
    ...(engineBatch?.degradations ?? []),
  ];
  for (const d of ownerDegradations) console.warn(`[analyze] ${d}`);

  // ── ONE OWNER PER MESSAGE, ASSERTED ────────────────────────────────
  //   The invariant that used to be bought by there being exactly one
  //   decider. There are five now, so it is checked. A double claim is
  //   logged as an error and the LATER claim is dropped, in the same
  //   shape as the duplicate-result backstop at the end of this
  //   function: a violated invariant must degrade to "reply once",
  //   never to "throw and lose the batch".
  const ownerOf = new Map<string, string>();
  const claim = (label: string, ids: Iterable<string>) => {
    for (const id of ids) {
      const prior = ownerOf.get(id);
      if (prior) {
        console.error(
          `[analyze] INVARIANT VIOLATION: ${id} claimed by BOTH ${prior} and ${label} — ` +
            `keeping ${prior} so MatchTime replies once`,
        );
        continue;
      }
      ownerOf.set(id, label);
    }
  };
  // Two things about these five lines.
  //
  // The labels are each module's OWN `*_HANDLED_BY` constant, not a
  // string typed here. They are written to `AnalyzedMessage.handledBy`
  // below, so a hand-typed copy would mean the admin log said
  // "answer-batch" while the module that decided it called itself
  // "answer-engine" — which is exactly what the first draft of this line
  // did.
  //
  // And the ORDER is the same order the loop below resolves an outcome
  // in. `claim()` keeps the FIRST claimant and the loop's `??` chain
  // takes the FIRST hit, so under a double claim — which cannot happen,
  // the route sets are disjoint — the two would still agree about who
  // decided the message. The first draft had `admin_ops` third here and
  // fourth there, which would have made the audit row name one owner
  // while another one's words went to the group. That is a smaller bug
  // than the one this assertion exists for, and it is exactly the kind
  // that survives because nobody looks at the impossible branch.
  claim(ENGINE_HANDLED_BY, engineOwnedIds);
  claim(ANSWER_HANDLED_BY, answerBatch?.ownedIds ?? []);
  claim(SCORE_HANDLED_BY, scoreBatch?.ownedIds ?? []);
  claim(TEAM_OPS_HANDLED_BY, teamOpsBatch?.ownedIds ?? []);
  claim(ADMIN_OPS_HANDLED_BY, adminOpsBatch?.ownedIds ?? []);

  // ── 3. TURN EACH OWNER'S OUTCOME INTO ONE REPLY AND ONE ROW ────────
  //
  //   This loop used to be 1,180 lines. Almost all of it was the model's
  //   output being corrected: the hypothetical/past-tense seatbelt, the
  //   third-party-subject seatbelt, the placeholder-guest strip, the
  //   pasted-roster reconcile and clamp, the guest-name ask, the tag
  //   gate, the attendance-off gate, the conditional-drop hold, the IN
  //   net, the OUT net, the bench-demote net, the banter-drop guard, the
  //   generate-teams dedupe, and `executeVerdict` itself.
  //
  //   Every one of them read `verdict.intent`, `verdict.reasoning`,
  //   `verdict.reply`, `verdict.registerAttendance` or
  //   `verdict.registerFor`. There is no verdict any more, so their
  //   input does not exist — which is §9's "no longer possible: the
  //   error class becomes unrepresentable, so the guard has nothing to
  //   guard", spent rather than promised. The per-guard proofs live in
  //   the commit that deleted them and in `MDs/`.
  //
  //   What survives is what §9 said would: the honest ack, the
  //   unresolved-sender nudge, the react/status reconciliation, the one
  //   composed squad post, the deferred recruit blast, and the
  //   one-result-per-message backstop. Not one of those was ever about
  //   the model.
  //
  //   So the loop now does exactly three things per message: find the
  //   owner, render its outcome, or record that nobody owned it.

  // Sender-registration reacts to audit AFTER the whole batch has been
  // applied (see the reaction ↔ status reconciliation pass below). Only
  // outcomes where the react describes the SENDER's own attendance row
  // qualify.
  const REGISTRATION_STATUS_REACTS = new Set(["✅", "🪑", "👋"]);
  const senderReactAudit: Array<{ idx: number; userId: string }> = [];

  // ── THE RECRUIT BLAST STILL RUNS LAST ───────────────────────────────
  //   Collected here, fired once after every write in the batch has
  //   landed — see "RUN THE RECRUIT" below. The deferral is the fix for
  //   2026-09-01, where a blast ran BEFORE the batch's writes and told
  //   the owner his squad was full one line after he said Najib was out.
  //   Two owners can report one: step 6's engine (`sideRequests`
  //   carrying "recruit" from an admin) and step 7's `admin_ops` (an
  //   explicit "DM the lads from the last 5 games", with a clamped
  //   lookback). They share this list so the "only the last one fires"
  //   rule holds across both.
  const recruitRequests: Array<{
    msg: InboundMessage;
    sender: ResolvedSender;
    lookbackMatches: number | null;
  }> = [];

  // ── AND SO DOES THE STATS BLAST (2026-09-10) ────────────────────────
  //   The other mass DM, collected the same way and fired in the same
  //   batch-final pass. It has no ordering argument of its own — it
  //   reads no squad state — but it goes down the same road so there is
  //   ONE place in this file where a bulk DM is performed.
  //
  //   ONE owner reports it, not two: `admin_ops`. Until today a regex in
  //   the fast-path loop above classified it, and on 2026-09-10 that
  //   regex assembled a bot command out of three scattered words in an
  //   owner's reminder to his players and queued 69 DMs. See the
  //   tombstone at the top of this file's fast-path section and
  //   `lib/stats-blast.ts`.
  const statsBlastRequests: Array<{ msg: InboundMessage }> = [];

  // ── EVERY MESSAGE NOBODY OWNED ─────────────────────────────────────
  //   The input to `lib/operator-note.ts`, which is what replaces "fall
  //   back to the analyzer". A `none`-routed message lands here too and
  //   is filtered out there, deliberately: the decision about what is
  //   worth a human's attention is made in ONE place, and it is made on
  //   the route rather than on the message text.
  const unowned: UnownedMessage[] = [];

  // ── EVERY MESSAGE THE ATTENDANCE ENGINE *DID* OWN ──────────────────
  //   The second input to `lib/operator-note.ts`, added 2026-09-09 after
  //   two players' "In" was claimed by the engine, written nowhere and
  //   reported to nobody. `unowned` answers "did anything CLAIM this?";
  //   this answers "did anything HAPPEN?".
  //
  //   EVERY engine-owned message is pushed, the ones it acted on
  //   included, and the selection is `composeOperatorNote`'s
  //   `silentDiscard`. Same argument as `none` being filtered there
  //   rather than here: the decision about what is worth a human's
  //   attention is made in ONE place.
  //
  //   Only the ATTENDANCE engine feeds this. The predicate reads
  //   extractor claim counts, which the other four owners do not
  //   produce, and a lost attendance change is the failure this product
  //   is named for. Widening it to `answer` / `score` / `balancer` /
  //   `admin_ops` needs its own predicate and its own production table.
  const ownedByEngine: OwnedMessage[] = [];

  for (const msg of fresh) {
    const sender = senderById.get(msg.waMessageId)!;

    // ── §10 STEP 6 — THE ATTENDANCE ENGINE DECIDED THIS MESSAGE ──────
    //
    // The extractor read it, the engine decided it, `attendance.ts`
    // wrote it and the composer said it. Unchanged by step 8 except
    // that there is no longer anything below it to skip.
    const engineOutcome = engineBatch?.outcomes.get(msg.waMessageId);
    if (engineOutcome) {
      if (engineOutcome.recruitRequest) {
        recruitRequests.push({ msg, sender, lookbackMatches: null });
      }
      if (engineOutcome.recordTentativeForUserId && engineBatch?.matchId && nextMatchForReply) {
        // conditional_in flavour (b) — personal uncertainty. The engine
        // declines the write; the 24h chase is a shipped product
        // behaviour and step 6 must not lose it. Best-effort.
        await recordTentative({
          matchId: engineBatch.matchId,
          userId: engineOutcome.recordTentativeForUserId,
          kickoff: nextMatchForReply.date,
        }).catch((err) => console.error("[analyze] engine recordTentative failed:", err));
      }
      if (engineOutcome.resolveTentativeForUserId && engineBatch?.matchId) {
        await resolveTentative({
          matchId: engineBatch.matchId,
          userId: engineOutcome.resolveTentativeForUserId,
        }).catch((err) => console.error("[analyze] engine resolveTentative failed:", err));
      }

      // The honest ack: a confirmation is NEVER sent for a write that
      // did not land (9f19040).
      const ack = resolveAttendanceAck({
        failures: engineOutcome.failures,
        react: engineOutcome.react,
        reply: engineOutcome.reply,
        senderName: sender.name ?? msg.authorName ?? null,
      });
      if (ack.failed) {
        console.error(attendanceFailureLog(engineOutcome.failures), "for", msg.waMessageId);
        await recordAnalysis({
          orgId: org.id,
          groupId: body.groupId,
          msg,
          handledBy: "error",
          intent: engineOutcome.intent,
          action: attendanceFailureAction(engineOutcome.failures),
          confidence: 1,
          reasoning: attendanceFailureLog(engineOutcome.failures).slice(0, 2000),
          authorUserId: sender.userId,
          authorName: msg.authorName ?? null,
        });
        results.push({
          waMessageId: msg.waMessageId,
          handledBy: "error",
          intent: engineOutcome.intent,
          react: null,
          reply: ack.reply,
          reasoning: engineOutcome.reasoning,
        });
        continue;
      }

      let engineReply = ack.reply;
      // NOTE: the batch's squad post is NOT attached here. It is
      // attached after the whole loop, to whichever message ends up
      // speaking last — see "THE BATCH'S ONE SQUAD POST" below.
      if (engineReply && nextMatchForReply) {
        engineReply = enforceProximity(engineReply, nextMatchForReply.date);
      }
      const engineNudge = await unresolvedSenderNudge({
        senderResolved: !!sender.userId,
        attendanceRelevant: engineOutcome.action !== "none",
        matchId: nextMatchForReply?.id ?? null,
        authorName: msg.authorName,
        dropping: engineOutcome.intent === "out",
      });
      if (engineNudge.applies) engineReply = engineNudge.reply;

      await recordAnalysis({
        orgId: org.id,
        groupId: body.groupId,
        msg,
        handledBy: ENGINE_HANDLED_BY,
        intent: engineOutcome.intent,
        action: engineOutcome.action,
        confidence: 1,
        reasoning: engineOutcome.reasoning,
        authorUserId: sender.userId,
        authorName: msg.authorName ?? null,
      });
      if (
        sender.userId &&
        nextMatchForReply &&
        ack.react !== null &&
        REGISTRATION_STATUS_REACTS.has(ack.react) &&
        engineOutcome.senderOwnRowMoved
      ) {
        senderReactAudit.push({ idx: results.length, userId: sender.userId });
      }
      // ── DID ANYTHING ACTUALLY HAPPEN? (2026-09-09) ────────────────
      //
      // Recorded for every engine-owned message; `silentDiscard` picks
      // the suspicious ones out. `spoke` is computed HERE rather than
      // read off the outcome because two things above can add words the
      // engine never flagged — the honest ack and the unresolved-sender
      // nudge — and a player who was told something is not a silent
      // discard.
      //
      // ⚠️ NOT REACHED BY THE `ack.failed` BRANCH ABOVE, which
      // `continue`s past this. Deliberate, and not a hole: a write that
      // threw already gets `handledBy: "error"` on its
      // `AnalyzedMessage` row, a `console.error`, and an honest reply to
      // the group saying it did not land. It is the loudest path in this
      // function, and adding it here would double-report the one failure
      // that is already impossible to miss.
      ownedByEngine.push({
        waMessageId: msg.waMessageId,
        body: msg.body,
        authorName: msg.authorName,
        route: engineOutcome.route,
        disposition: engineOutcome.disposition,
        spoke: engineReply !== null || ack.react !== null,
        senderResolved: !!sender.userId,
        claimCount: engineOutcome.claimCount,
        sideRequestCount: engineOutcome.sideRequestCount,
        // Prose, for the bullet only. The engine writes this same string
        // to `AnalyzedMessage.reasoning`, so the DM and the admin log
        // say the same thing, and neither of them decides anything.
        why: engineOutcome.reasoning,
      });
      results.push({
        waMessageId: msg.waMessageId,
        // The WIRE field, which `whatsapp-bot/src/api.ts:325` types as a
        // closed union the Pi only special-cases for `deduped` and
        // `error`. The AUDIT field on `AnalyzedMessage` above says
        // `attendance-engine`, which is what makes "what did the engine
        // decide?" one query.
        handledBy: "llm",
        intent: engineOutcome.intent,
        react: ack.react,
        reply: engineReply,
        reasoning: engineOutcome.reasoning,
      });
      continue;
    }

    // ── §10 STEP 7 — question, balancer, score, admin_ops ────────────
    //
    // Three runners, one shape. They are looked up with `??` rather
    // than in three branches because their route sets are disjoint
    // (asserted by `claim()` above), so at most one can answer — and
    // writing it once means the ack, the proximity pass and the
    // `AnalyzedMessage` row cannot drift apart between them.
    //
    // WHAT THIS BRANCH DELIBERATELY DOES NOT DO, and each is covered:
    //
    //   • No tag gate. `answer-batch.ts` requires `m.tagged`
    //     unconditionally and `admin-ops-engine-batch.ts` applies the
    //     contract per action; `score` is EXCLUDED from ACTIONY_INTENTS
    //     by name (`interaction-contract.ts:125-129`), so a gate here
    //     would refuse every real "we won 5-3". Re-applying it would be
    //     a second copy of a policy that already ran.
    //   • No feature gate. Each runner reads the org's features out of
    //     its own `SquadState` load and owns nothing when its feature is
    //     off, which is strictly better than this branch checking after
    //     the write.
    //   • No unresolved-sender nudge. That nudge exists for a lost
    //     ATTENDANCE change ("message understood, action silently not
    //     taken") and step 6's branch above still applies it. A question
    //     or a score from an unresolved sender is answered on purpose —
    //     `score-engine-batch.ts`'s header: "losing the score entirely
    //     is a worse failure mode".
    //   • No squad-post marker. Attached after the loop, once, to
    //     whichever result speaks last.
    // `admin_ops` is looked up into its OWN binding rather than being
    // folded into the `??` chain, so the recruit fields keep their real
    // types: a `"recruitRequest" in x` test over a three-way union
    // narrows to "has the key", not to the member that declares it, and
    // `recruitLookbackMatches` comes back as `{}`.
    const adminOutcome = adminOpsBatch?.outcomes.get(msg.waMessageId);
    const stepSeven =
      answerBatch?.outcomes.get(msg.waMessageId) ??
      scoreBatch?.outcomes.get(msg.waMessageId) ??
      teamOpsBatch?.outcomes.get(msg.waMessageId) ??
      adminOutcome;
    if (stepSeven) {
      // An admin's recruit ask, deferred to the batch-final pass with
      // its clamped lookback. `recruitLookbackMatches` is null when the
      // ask did not state a number, and `inviteRecentPlayers` then uses
      // its own default of 5.
      if (adminOutcome?.recruitRequest) {
        recruitRequests.push({
          msg,
          sender,
          lookbackMatches: adminOutcome.recruitLookbackMatches ?? null,
        });
      }
      // An admin's stats blast, deferred the same way. The engine has
      // already applied both gates (admin, and an explicit @-mention);
      // nothing here re-decides, it only defers.
      if (adminOutcome?.statsBlastRequest) {
        statsBlastRequests.push({ msg });
      }
      // A write that threw says nothing at all (§3.2 S7, the 2026-05-15
      // Erdal incident). The runner has already blanked the reply; this
      // only labels the row so the failure is one query away rather than
      // one log line away.
      const writeFailed = "writeFailed" in stepSeven && stepSeven.writeFailed;
      let reply = stepSeven.reply;
      if (reply && nextMatchForReply) {
        reply = enforceProximity(reply, nextMatchForReply.date);
      }
      await recordAnalysis({
        orgId: org.id,
        groupId: body.groupId,
        msg,
        handledBy: writeFailed ? "error" : ownerOf.get(msg.waMessageId) ?? "llm",
        intent: stepSeven.intent,
        action: stepSeven.action,
        confidence: 1,
        reasoning: stepSeven.reasoning,
        authorUserId: sender.userId,
        authorName: msg.authorName ?? null,
      });
      results.push({
        waMessageId: msg.waMessageId,
        handledBy: writeFailed ? "error" : "llm",
        intent: stepSeven.intent,
        react: writeFailed ? null : stepSeven.react,
        reply,
        reasoning: stepSeven.reasoning,
      });
      continue;
    }

    // ── THE PASTED ROSTER, WHEN NO OWNER SPOKE ──────────────────────
    //
    //   Section 4 above applied the list's arithmetic before the router
    //   ran and deferred its row and its reply to here, because it no
    //   longer peels the message out of the batch (read that section's
    //   header for why — a peel loses the sender's own drop).
    //
    //   Reached only when nothing above claimed the message, so the
    //   "one result per message" invariant holds without any
    //   reconciliation: if the engine took the sender's drop it has
    //   already `continue`d with its own row and its own words, and this
    //   report is dropped on the floor. The WRITES from section 4 stand
    //   either way — two owners may write for one message (PR #33's "a
    //   recruit ask alongside a drop must do BOTH"), only one speaks.
    //
    //   Deliberately NOT `unowned.push(...)`: this message was handled,
    //   by arithmetic, and putting a posted squad list on the operator
    //   DM as "nobody handled this" would page a human for the most
    //   ordinary message a football group sends.
    const rosterReport = pastedRosterReports.get(msg.waMessageId);
    if (rosterReport) {
      await recordAnalysis({
        orgId: org.id,
        groupId: body.groupId,
        msg,
        handledBy: rosterReport.handledBy,
        intent: "pasted_roster",
        action: rosterReport.action,
        confidence: 1,
        reasoning: rosterReport.reasoning,
        authorUserId: sender.userId,
        authorName: msg.authorName ?? null,
      });
      results.push({
        waMessageId: msg.waMessageId,
        handledBy: rosterReport.handledBy,
        intent: "pasted_roster",
        react: rosterReport.react,
        reply: rosterReport.reply,
      });
      continue;
    }

    // ── NOBODY OWNED IT ─────────────────────────────────────────────
    //
    // This is where "fall back to the analyzer" used to point, and the
    // whole of §10 step 8's risk lives in these six lines.
    //
    // MatchTime says NOTHING to the group. That is §11.5's accepted
    // loss, named in advance: "a router with nine routes and an engine
    // with explicit rules will do nothing instead… the club will
    // experience it as 'the bot got dumber' before they experience it
    // as 'the bot stopped being wrong'." For a system writing to a paid
    // squad, doing nothing is the right default.
    //
    // But silence with no signal is §9's SIGNATURE failure, so the
    // silence is recorded twice: once as an `AnalyzedMessage` row (so
    // "did the pipeline eat an IN?" is a query, which is §11.1's third
    // containment and §11.2's mitigation), and once — for the routes
    // that were actually going somewhere — as an operator DM composed
    // after the loop. `composeOperatorNote` drops `none` there; it is
    // NOT dropped here, because the row is what makes the nightly
    // `none`-bucket sweep possible.
    //
    // A CLAUSE RESIDUAL IS DELIBERATELY NOT PAGED. This message WAS
    // handled — a fast path took its clause, and `applyClauseReports`
    // below merges that outcome into the row and the reply — so putting
    // "nobody handled this" on the operator DM for the leftover half of
    // "…and share us the teams" would page a human on every swap. That
    // is the pasted roster's own argument twenty lines above, unchanged.
    // It is also NOT a regression: before the clause peel the WHOLE
    // message was spliced out and no note was raised either. The
    // `AnalyzedMessage` row is still written, so the nightly sweep can
    // still see it.
    if (!clauseResidualById.has(msg.waMessageId)) {
      unowned.push({
        waMessageId: msg.waMessageId,
        body: msg.body,
        authorName: msg.authorName,
        route: gateRouteById.get(msg.waMessageId),
      });
    }
    await recordAnalysis({
      orgId: org.id,
      groupId: body.groupId,
      msg,
      handledBy: gatedIds.has(msg.waMessageId) ? GATED_HANDLED_BY : "ignored",
      intent: "noise",
      action: null,
      confidence: 1,
      reasoning:
        `no owner: route=${gateRouteById.get(msg.waMessageId) ?? "(none returned)"}` +
        (ownerDegradations.find((d) => d.includes(msg.waMessageId))
          ? ` — ${ownerDegradations.find((d) => d.includes(msg.waMessageId))!.slice(0, 400)}`
          : ""),
      authorUserId: sender.userId,
      authorName: msg.authorName ?? null,
    });
    results.push({
      waMessageId: msg.waMessageId,
      handledBy: "ignored",
      intent: "noise",
      react: null,
      reply: null,
    });
  }

  // ── THE OPERATOR NOTE — §9's PARTIAL-RESPONSE NET, TYPED ───────────
  //
  //   The successor to the "LLM dropped N messages" DM that stood before
  //   the loop until this change. §9 keeps that seatbelt and says how to
  //   fix it: "today it prefix-matches free-text `reasoning`; under the
  //   new design it matches a typed error, which is what it always
  //   wanted to be." The typed fact is that an id reached the end of the
  //   batch with no owner.
  //
  //   Same audience, same 1-hour dedupe, same "act manually if any were
  //   attendance changes" close. Two things changed and both are
  //   improvements: it can no longer be defeated by the model phrasing
  //   its failure differently, and it no longer fires for banter,
  //   because `composeOperatorNote` drops every `none` route (69.3% of
  //   real traffic — a DM per banter message is an ignored surface,
  //   which is the same silence with extra steps).
  //
  //   Best-effort by construction: the note is the last thing that
  //   happens to a batch that already replied, so a failure here must
  //   never cost the group its reply.
  //
  //   ⚠️ THE OUTER GUARD IS AN `||` SINCE 2026-09-09, and it has to be:
  //   a batch in which the engine owned every message and silently
  //   discarded them has `unowned.length === 0`, so `if (unowned.length
  //   > 0)` would have skipped the composer, the admin lookup and the DM
  //   entirely — the new report dead on arrival in exactly the batch it
  //   exists for. That is `describeEngineBatch`'s own lesson ("one `&&`
  //   upstream threw them away") and this file's terminal-short-circuit
  //   family, arriving one level up as a wrapper condition instead of a
  //   `continue`.
  if (unowned.length > 0 || ownedByEngine.length > 0) {
    try {
      const candidates = {
        orgName: org.name,
        messages: unowned,
        // Every message the attendance engine claimed. Selected by
        // `silentDiscard` inside the composer, never here.
        owned: ownedByEngine,
        degradations: ownerDegradations,
      };
      // ── ASKED TWICE, ON PURPOSE, AND THE FIRST ASK DOES NO I/O ────
      //
      // Absent `features` suppresses NOTHING (the module's documented
      // default), so this call is a strict SUPERSET of the real one: a
      // null text here means no combination of feature flags could have
      // produced a note, and the org lookup below would be a database
      // read for a DM that was never going to be sent. That matters now
      // because the `||` above lets in every batch the engine owned —
      // i.e. most of them — where before it took a stray. Re-composing
      // rather than restating the route test here is deliberate: one
      // predicate, one place.
      if (composeOperatorNote(candidates).text) {
        const note = composeOperatorNote({
          ...candidates,
          // A club that switched attendance off must not be paged about
          // attendance. `attendance-engine-batch.ts` DISOWNS those
          // messages when the feature is off (it returns `empty()`), so
          // without this they would arrive here looking like a failure.
          // This IS an extra `findUnique` — `getOrgFeatures` does no
          // caching, and I checked rather than assumed, having just
          // spent a whole pass deleting comments that asserted things
          // nobody had verified. It is affordable precisely here: the
          // superset above has already said there is something to send,
          // and the block already does a `membership.findMany` plus one
          // `botJob.findFirst` per admin.
          // See `operator-note.ts`'s header — the claim that the caller
          // filtered these out was false until 2026-09-06.
          features: { attendance: (await getOrgFeatures(org.id)).attendance },
        });
        // ⚠️ AND THE FEATURE FILTER CAN STILL EMPTY IT. The superset
        // says only that something MIGHT be worth sending; an
        // attendance-off org has every candidate suppressed here and
        // must send nothing at all. The guard NESTS rather than
        // returning early: this is the middle of the request handler,
        // and an early `return` would take the react ↔ status
        // reconciliation, the batch's squad post, the recruit blast and
        // the response itself with it.
        if (note.text) {
          console.warn(
            `[analyze] ${note.noteIds.length} message(s) in this batch went unanswered: ` +
              note.noteIds.join(", "),
          );
          const admins = await db.membership.findMany({
            where: { orgId: org.id, role: { in: ["ADMIN", "OWNER"] }, leftAt: null },
            include: { user: { select: { id: true, phoneNumber: true, name: true } } },
          });
          const since = new Date(Date.now() - 60 * 60 * 1000); // 1h dedupe window
          for (const m of admins) {
            if (!m.user.phoneNumber) continue;
            const phone = m.user.phoneNumber.replace(/^\+/, "");
            const recentlySent = await db.botJob.findFirst({
              where: {
                orgId: org.id,
                kind: "dm",
                phone,
                text: { contains: OPERATOR_NOTE_MARKER },
                createdAt: { gte: since },
              },
              select: { id: true },
            });
            if (recentlySent) continue; // already told this admin in the last hour
            await db.botJob.create({
              data: { orgId: org.id, kind: "dm", phone, text: note.text },
            });
          }
        }
      }
    } catch (err) {
      console.error("[analyze] failed to dispatch the operator note:", err);
    }
  }

  // 3a-i. Reaction ↔ persisted-status reconciliation ──────────────────
  //   (Zeeshan 2026-06-12: MT reacted 🪑 to his message but his row
  //   ended DROPPED.) A registration react (✅/🪑/👋) on a sender's own
  //   attendance message is a public claim about their FINAL status —
  //   derive it from the DB after ALL of the batch's writes have
  //   landed, not from whatever the verdict guessed mid-batch.
  if (nextMatchForReply && senderReactAudit.length > 0) {
    try {
      const auditUserIds = [...new Set(senderReactAudit.map((a) => a.userId))];
      const rowsNow = await db.attendance.findMany({
        where: { matchId: nextMatchForReply.id, userId: { in: auditUserIds } },
        select: { userId: true, status: true },
      });
      const statusByUser = new Map(rowsNow.map((r) => [r.userId, r.status]));
      const reactForStatus = (s: string | undefined): string | null =>
        s === "CONFIRMED" ? "✅" : s === "BENCH" ? "🪑" : s === "DROPPED" ? "👋" : null;
      for (const { idx, userId } of senderReactAudit) {
        const want = reactForStatus(statusByUser.get(userId));
        const r = results[idx];
        if (
          want &&
          r.react &&
          REGISTRATION_STATUS_REACTS.has(r.react) &&
          r.react !== want
        ) {
          console.warn(
            `[analyze] react/status reconciliation: ${r.waMessageId} react ${r.react} → ${want} (final attendance row wins)`,
          );
          r.react = want;
        }
      }
    } catch (err) {
      console.error("[analyze] react/status reconciliation failed:", err);
    }
  }

  // ── THE BATCH'S ONE SQUAD POST, ACROSS BOTH DECIDERS (§10 step 6) ──
  //
  //   The engine posts the roster whenever the squad changed. The
  //   analyzer answers the questions in the same batch. Attach the
  //   squad post to the message the engine acted on and you get TWO
  //   sends whenever a batch contains both — measured on the first live
  //   sweep of this step, where
  //   `S36-one-authoritative-squad-post-per-batch` produced "📋 Based
  //   on all the messages…" from the engine AND "Quick correction,
  //   @Zair — we're actually…" from the analyzer, and its
  //   `speaksAtMost: 1` caught it.
  //
  //   The incumbent did not have this problem for the wrong reason: a
  //   plain "in" usually got a react and no reply at all, so the
  //   question's answer was the batch's only send. The engine speaking
  //   about every write is the improvement; two sends is the cost, and
  //   it is avoidable.
  //
  //   So the marker goes on the LAST result that is already going to
  //   speak — whichever decider produced it. `composeSquadStateReply`
  //   then renders `lead + roster` into that one message, keeping the
  //   analyzer's answer AND the database's roster in a single send, and
  //   the collapse below still guarantees at most one composed post.
  //   Nothing is lost: the lead survives unless it makes a squad claim
  //   of its own, in which case the roster it would have contradicted
  //   replaces it.
  //
  //   `[SQUAD]` rather than the composer's own text on purpose: the
  //   engine composed from its PROJECTED state, and the writes have
  //   landed since. The database is the later, truer fact, and the
  //   marker is the existing way of saying "put the real post here".
  if (engineBatch?.squadPostForMessageId) {
    const speaks = results.filter((r) => (r.reply ?? "").length > 0);
    const target =
      speaks.length > 0
        ? speaks[speaks.length - 1]
        : results.find((r) => r.waMessageId === engineBatch.squadPostForMessageId);
    if (target) {
      target.reply = target.reply
        ? `${target.reply}\n\n${SQUAD_POST_MARKER}`
        : SQUAD_POST_MARKER;
    }
  }

  // 3a-ii. THE SQUAD POST IS COMPOSED, NOT CHECKED ────────────────────
  //   §10 step 4 (2026-09-01). Every reply that shows squad state, or
  //   that claims a move the database does not support, is REPLACED by
  //   text composed from a FRESH snapshot taken AFTER every attendance
  //   write in the batch has landed. The model's numbers and names
  //   never reach the group, so they cannot be wrong, so nothing
  //   downstream has to check them (§6.4).
  //
  //   This replaces the two-branch collapse that stood here: two or
  //   more squad replies collapsed into one composed post, and a single
  //   one was re-canonicalised in place by `enforceCanonicalRoster`.
  //   The single-post branch was the hole — one reply meant the model
  //   still authored the words and 140 lines of regex tried to correct
  //   them afterwards. Root cause it was written for stands (Sutton
  //   Lads 2026-06-12: four separately-composed squad replies in one
  //   batch, each from a different snapshot, contradicting each other)
  //   and is now closed by construction, since every composed reply in
  //   a batch renders the SAME post and only the last one speaks.
  //
  //   Team posts are excluded: `generate_teams_request` /
  //   `show_teams_request` replies intentionally carry two numbered
  //   lists (Red + Yellow) and are already deterministic. That is the
  //   same exclusion the deleted in-loop pass used.
  if (nextMatchForReply) {
    try {
      const candidates: number[] = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        // `fast-path` is admitted for EXACTLY ONE intent, and narrowly.
        //
        // §10 step 8 moved the pasted-roster registration to a
        // deterministic peel that runs before the router
        // (`pasted-roster-registration.ts`), and its ack is the
        // `[SQUAD]` marker — the same "put the real post here" signal
        // every other squad-changing path uses. Without this clause the
        // filter below dropped it, the last-line-of-defence strip then
        // turned the marker into `null`, and a paste that had just
        // registered four players said NOTHING. Found by asking what
        // renders the marker rather than by assuming the composer sees
        // every reply.
        //
        // Widening the filter to all of `fast-path` would have been the
        // shorter fix and the wrong one: the help reply, the stats-blast
        // ack and the guest-name ask are also `fast-path`, and none of
        // them should be re-composed into a roster.
        const pastedRosterAck = r.handledBy === "fast-path" && r.intent === "pasted_roster";
        if (!r.reply) continue;
        if (r.handledBy !== "llm" && !pastedRosterAck) continue;
        if (r.intent === "generate_teams_request" || r.intent === "show_teams_request") continue;
        candidates.push(i);
      }
      if (candidates.length > 0) {
        const finalAtt = await db.attendance.findMany({
          where: {
            matchId: nextMatchForReply.id,
            status: { in: ["CONFIRMED", "BENCH"] },
          },
          include: { user: { select: { name: true } } },
          orderBy: { position: "asc" },
        });
        // The composer needs one fact the request does not carry: who
        // this group knows. Without it, a claim about someone with NO
        // attendance row — S7's Erdal, the exact incident — is a claim
        // about a stranger and gets waved through. Loaded here rather
        // than taken from the model (§10 step 4: "if the composer needs
        // facts the caller does not have, add a loader").
        const memberships = await db.membership.findMany({
          where: { orgId: org.id, leftAt: null },
          select: { user: { select: { name: true } } },
        });
        const truth: SquadTruth = {
          confirmed: finalAtt
            .filter((a) => a.status === "CONFIRMED")
            .map((a) => a.user.name ?? "(unnamed)"),
          bench: finalAtt
            .filter((a) => a.status === "BENCH")
            .map((a) => a.user.name ?? "(unnamed)"),
          maxPlayers: nextMatchForReply.maxPlayers,
          knownNames: memberships
            .map((m) => m.user.name)
            .filter((n): n is string => !!n),
        };
        const composedIdx: number[] = [];
        for (const i of candidates) {
          const out = composeSquadStateReply(results[i].reply!, truth);
          if (!out.composed) continue;
          results[i].reply = out.text;
          composedIdx.push(i);
        }
        // MatchTime posts ONE squad status per batch. Every composed
        // reply now renders the same post, so the earlier ones would be
        // literal duplicates — silence them, keeping the last (the
        // freshest message), exactly as the collapse did.
        for (const i of composedIdx.slice(0, -1)) results[i].reply = null;
        if (composedIdx.length > 0) {
          console.log(
            `[analyze] composed the squad status from the DB for ${composedIdx.length} repl${composedIdx.length === 1 ? "y" : "ies"}; ${composedIdx.length - 1} silenced`,
          );
        }
      }
    } catch (err) {
      console.error("[analyze] squad-status composition failed:", err);
    }
  }

  // ── RUN THE RECRUIT (verdict-driven, 2026-09-01) ────────────────────
  //   LAST, on purpose, and this ordering IS the fix.
  //
  //   Every attendance write in the batch has landed, and the batch-final
  //   squad-status collapse above has already re-canonicalised the roster
  //   text. Only now does the invite blast run, so it counts the squad
  //   the sender's own message just changed. On 2026-09-01 a regex ran it
  //   FIRST, against 10/10, and MatchTime told the owner his squad was
  //   full one line after he said Najib was out.
  //
  //   The action, its copy and the admin gate are the deleted fast path's,
  //   unchanged. What moved is WHEN it runs and WHO decided it was asked
  //   for. The reply is MERGED into the message's single existing result,
  //   never pushed as a second one: MatchTime replies once or not at all.
  if (recruitRequests.length > 0) {
    // Only the LAST request fires, mirroring the generate_teams_request
    // dedupe above. Two admins asking in one batch must not produce two
    // DM blasts to the same people.
    const { msg: recruitMsg, lookbackMatches } =
      recruitRequests[recruitRequests.length - 1];
    if (recruitRequests.length > 1) {
      console.log(
        `[analyze] ${recruitRequests.length} recruit requests in one batch — firing the last only`,
      );
    }
    try {
      const { inviteRecentPlayers } = await import("@/lib/recruit");
      // §10 step 8: the lookback the ADMIN asked for, already clamped to
      // `[1, 12]` by `admin-ops-engine.ts` against `recruit.ts`'s own
      // ceiling. Null when the ask did not name a number (and always,
      // for step 6's `sideRequests: ["recruit"]` shape, which carries no
      // number), in which case `inviteRecentPlayers` uses its default of
      // 5 — exactly what the shipped call did. A mass DM is how the
      // WhatsApp account gets banned, so the clamp is applied where the
      // number is read and re-applied by `resolveLookbackMatches` here.
      const r = await inviteRecentPlayers(org.id, lookbackMatches ?? undefined);
      const recruitReply = !r.ok
        ? r.reason ?? "Couldn't do that right now."
        : r.invited && r.invited > 0
          ? `📣 On it — DM'd ${r.invited} recent player${r.invited === 1 ? "" : "s"} who hadn't replied, asking them to fill *${r.matchName}*${r.need ? ` (${r.need} spot${r.need === 1 ? "" : "s"} left)` : ""}. I'll add anyone who taps in. 🙏`
          : r.reason
            ? r.reason // full-squad case: no open spots to recruit for.
            : r.alreadyInvited && r.alreadyInvited > 0
              ? // Branch 3: candidates existed but were ALL already pinged on a
                // previous recruit call — they just haven't replied yet.
                `Already pinged the recent players for *${r.matchName}* — just waiting on their replies. 🙏`
              : // Branch 2: genuinely nobody recent left to ask.
                `No new players to ask for *${r.matchName}* right now. 👍`;

      const idx = results.findIndex((x) => x.waMessageId === recruitMsg.waMessageId);
      if (idx >= 0) {
        // ONE reply. If the LLM already answered the attendance half, the
        // recruit line is appended to it; it is never a second send.
        results[idx].reply = mergeRecruitReply(results[idx].reply, recruitReply);
        results[idx].react = results[idx].react ?? "✅";
        if (
          results[idx].handledBy === "ignored" ||
          results[idx].intent === "noise" ||
          results[idx].intent === "unclear"
        ) {
          // The verdict itself carried nothing (a PURE recruit ask), so
          // the blast is the only thing that happened — label it as such.
          // "fast-path" still means "a deterministic server action, not
          // the model's words", which is exactly what this is; keeping the
          // old label leaves the admin log's vocabulary unchanged.
          results[idx].handledBy = "fast-path";
          results[idx].intent = "recruit_recent";
        }
      } else {
        // Defensive: every loop iteration pushes exactly one result, so
        // this is unreachable. Never drop the outcome if it ever isn't.
        results.push({
          waMessageId: recruitMsg.waMessageId,
          handledBy: "fast-path",
          intent: "recruit_recent",
          react: "✅",
          reply: recruitReply,
        });
      }
      await augmentAnalysis({
        waMessageId: recruitMsg.waMessageId,
        action: `recruit:${r.invited ?? 0}`,
        reasoningSuffix: `admin recruit — invited ${r.invited ?? 0} recent players`,
      });
    } catch (err) {
      console.error("[analyze] verdict-driven recruit failed:", err);
    }
  }

  // ── RUN THE STATS BLAST (verdict-driven, 2026-09-10) ────────────────
  //   The 69-DM near-miss, fixed the way the recruit blast was fixed on
  //   2026-09-01: the classification moved to the model and the action
  //   stayed in code. Nothing here decides anything — by the time this
  //   runs the ENGINE has established that the sender is an admin and
  //   that they addressed MatchTime with an explicit @-mention
  //   (`pipeline/engine.ts`'s `stats_blast` branch, `lib/stats-blast.ts`
  //   for the argument). This performs the action and composes the words
  //   from what actually landed.
  //
  //   Beside the recruit blast rather than in the fast-path loop, so the
  //   two mass DMs in this product are performed in one place, under one
  //   set of eyes, after every write in the batch.
  if (statsBlastRequests.length > 0) {
    // Only the LAST one fires. Two admins asking in one batch must not
    // DM the same 69 people twice — the same rule the recruit blast and
    // the generate-teams request follow.
    const { msg: blastMsg } = statsBlastRequests[statsBlastRequests.length - 1];
    if (statsBlastRequests.length > 1) {
      console.log(
        `[analyze] ${statsBlastRequests.length} stats blasts in one batch — firing the last only`,
      );
    }
    try {
      const { runStatsBlast, composeStatsBlastReply } = await import("@/lib/stats-blast");
      const { queued } = await runStatsBlast({
        // Every active member with a phone — the recipient list the
        // deleted fast path used, unchanged, and read from the DATABASE
        // rather than from anything the model said.
        recipients: async () =>
          (
            await db.membership.findMany({
              where: { orgId: org.id, leftAt: null, user: { phoneNumber: { not: null } } },
              select: { user: { select: { id: true, name: true, phoneNumber: true } } },
            })
          ).map((mem) => ({
            userId: mem.user.id,
            name: mem.user.name,
            phone: mem.user.phoneNumber ?? "",
          })),
        linkFor: async (userId) =>
          buildShortMagicLinkUrl(
            signMagicLinkToken({
              userId,
              purpose: "sign-in",
              nextPath: "/profile/stats",
              ttlSeconds: MAGIC_LINK_TTL.bookmark,
            }),
          ),
        queueDm: async ({ phone, text }) => {
          await db.botJob.create({ data: { orgId: org.id, kind: "dm", phone, text } });
        },
      });
      const blastReply = composeStatsBlastReply(queued);
      const idx = results.findIndex((x) => x.waMessageId === blastMsg.waMessageId);
      if (idx >= 0) {
        // ONE reply, merged — never a second send. The same invariant the
        // recruit merge four lines up protects.
        // `mergeOneReply` and not `mergeRecruitReply`: same function,
        // and the name that is not about recruiting.
        results[idx].reply = mergeOneReply(results[idx].reply, blastReply);
        results[idx].react = results[idx].react ?? "✅";
      } else {
        // Defensive: every loop iteration pushes exactly one result, so
        // this is unreachable. Never drop an outcome whose DMs LANDED.
        results.push({
          waMessageId: blastMsg.waMessageId,
          handledBy: "fast-path",
          intent: "stats_blast",
          react: "✅",
          reply: blastReply,
        });
      }
      await augmentAnalysis({
        waMessageId: blastMsg.waMessageId,
        action: `dm-stats-blast:${queued}`,
        reasoningSuffix: `admin stats blast — queued ${queued} personal stats-link DMs`,
      });
    } catch (err) {
      console.error("[analyze] verdict-driven stats blast failed:", err);
    }
  }

  // ── THE CLAUSE A FAST PATH TOOK, MERGED INTO THE ONE REPLY ─────────
  //
  //   The other half of the clause peel. A fast path that owned only
  //   PART of a message deferred its row and its words here rather than
  //   pushing a result of its own, because the loop above has already
  //   pushed one for the residual. Two owners WROTE; exactly one message
  //   is sent. That is `mergeRecruitReply`'s rule (which now delegates to
  //   the same `mergeOneReply`) and it is the invariant the whole tail of
  //   this function protects.
  //
  //   ── WHY IT RUNS HERE, LAST, AND NOT WHERE THE LOOP PUSHED ────────
  //
  //   Every pass between the loop and this point reasons about the
  //   OWNER's reply, and none of them should see the fast path's:
  //
  //     the react/status audit   Indexes into `results` by position and
  //                              rewrites a registration react from the
  //                              final DB row. This merge mutates in
  //                              place and pushes nothing, so those
  //                              indices stay valid — but it must not
  //                              fill a react the audit was about to
  //                              check, so it runs after.
  //     the batch's squad post   Attaches `[SQUAD]` to the LAST result
  //                              already speaking. Unchanged: the choice
  //                              is made over owner replies exactly as
  //                              before this change existed.
  //     the squad COMPOSER       The reason this ordering is not
  //                              cosmetic. It replaces any `llm` reply
  //                              that shows squad state with text
  //                              composed from the database. A swap's
  //                              team sheet merged in BEFORE that pass
  //                              would arrive as part of an `llm` reply
  //                              and be eligible for replacement — the
  //                              composer would silently eat the very
  //                              line-up the message asked for. Merging
  //                              after means the composer only ever sees
  //                              what the owner said.
  //     the recruit merge        Same shape, same rule, and it finds its
  //                              result by id, so order does not matter
  //                              between the two. A message carrying a
  //                              peeled clause AND a recruit ask ends
  //                              with all three sentences in ONE send.
  //
  //   The marker strip and the duplicate-result backstop run AFTER this,
  //   deliberately: a merged reply must still be stripped of `[SQUAD]`,
  //   and the backstop must still be the last word on "reply once".
  await applyClauseReports({
    reports: clauseReports,
    results,
    augment: augmentAnalysis,
  });

  // ── The marker is never posted to a group ───────────────────────────
  //   The prompt asks the model to end a squad-state reply with
  //   `[SQUAD]` and the composer above replaces it. The composer only
  //   runs when there IS a match to compose from, so a group with no
  //   upcoming match would otherwise read a literal "[SQUAD]". Last
  //   line of defence, applied to every result whatever produced it.
  for (const r of results) {
    if (!r.reply) continue;
    const stripped = stripSquadPostMarker(r.reply);
    if (stripped === r.reply) continue;
    r.reply = stripped.length > 0 ? stripped : null;
  }

  // ── INVARIANT: at most ONE result per message ───────────────────────
  //   MatchTime must never reply twice to one message. Every path above
  //   pushes exactly one result per waMessageId and the recruit merges
  //   into an existing one rather than appending; this is the backstop
  //   that says so out loud if a future path forgets.
  {
    const seenIds = new Set<string>();
    for (let i = results.length - 1; i >= 0; i--) {
      const id = results[i].waMessageId;
      if (seenIds.has(id)) {
        console.error(
          `[analyze] INVARIANT VIOLATION: duplicate result for ${id} — dropping the extra so the bot replies once`,
        );
        results.splice(i, 1);
        continue;
      }
      seenIds.add(id);
    }
  }

  // 3b. Backfill the registration-react on earlier duplicate IN messages
  //     from same author. State-collapse: when a player sends "count me
  //     in" then "IN" 30s later, the LLM only registers the latest
  //     (correct — no double-registration). But the earlier message
  //     gets a plain 👍 which looks like "not registered" and confuses
  //     people into retyping. If a later verdict for the same author
  //     registered them as IN (✅ or 🪑), propagate it back to the
  //     earlier IN verdicts so the chat reads cleanly.
  const registrationReacts = new Set(["✅", "🪑"]);
  const latestInReactByUser = new Map<string, string>();
  for (const r of results) {
    const uid = senderById.get(r.waMessageId)?.userId;
    if (!uid || r.intent !== "in" || !r.react) continue;
    if (registrationReacts.has(r.react)) latestInReactByUser.set(uid, r.react);
  }
  for (const r of results) {
    const uid = senderById.get(r.waMessageId)?.userId;
    if (!uid || r.intent !== "in" || !r.react) continue;
    if (registrationReacts.has(r.react)) continue;
    const fill = latestInReactByUser.get(uid);
    if (fill) r.react = fill;
  }

  // 4. Return + include next-kickoff so the bot can urgency-flush.
  const nextMatch = await db.match.findFirst({
    where: {
      activity: { orgId: org.id },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
    },
    orderBy: { date: "asc" },
    select: { date: true },
  });

  // ── THE SHADOW WINDOW-ANALYZER IS RETIRED (§10 step 7) ─────────────
  //
  //   "Migrate the rest… Retire the mega-prompt when the last route
  //    leaves. RETIRE THE SHADOW."
  //
  //   `runShadowAnalysis` fired here via `after()` on every batch: a
  //   second, entirely uncached `claude-sonnet-4-5` call over the same
  //   window, writing a `WindowVerdict` row for `/admin/shadow` to diff
  //   against the live per-message verdicts. §8.1 measured it at ~30% of
  //   the whole analyzer bill.
  //
  //   It was a COMPARISON, and it compared against the mega-prompt. With
  //   the mega-prompt deleted there is nothing on the other side of the
  //   diff: it would spend a Sonnet call per batch to produce a verdict
  //   no live path reads and no dashboard can contrast with anything.
  //   §7.1 is fair to it — "its infrastructure is exactly right and is
  //   the migration harness… building it was not wasted work; it was the
  //   previous step of this same journey" — and this is the journey
  //   arriving.
  //
  //   WHAT IS KEPT, deliberately:
  //     • the `WindowVerdict` TABLE and every historical row in it. Three
  //       months of shadow runs are a record of how this decision was
  //       reached and are not ours to delete.
  //     • `/admin/shadow`, which renders them.
  //     • `api/cron/none-bucket-shadow`, which writes NEW `WindowVerdict`
  //       rows and is a different mechanism entirely — §11.1's fourth
  //       containment, "shadow the `none` bucket forever… the regression
  //       detector the current architecture has never had". That one
  //       matters MORE after this change, not less: it is now the only
  //       thing watching for a real IN routed `none`.

  return NextResponse.json({
    ok: true,
    orgId: org.id,
    nextKickoffMs: nextMatch?.date.getTime() ?? null,
    results,
  });
}

/**
 * §9 "UNRESOLVED-SENDER NUDGE — SURVIVES".
 *
 * "Message understood, action silently not taken" is this product's
 * signature failure and is independent of who decides, so it is now
 * SHARED by both deciders rather than living inside the analyzer's
 * branch. §10 step 6 moves the attendance path to the engine; an
 * engine-decided message whose sender could not be resolved must reach
 * exactly the same nudge, with the same dedupe key, or turning the flag
 * on would quietly delete a guard.
 *
 * The rules are unchanged from the block this was lifted out of: fires
 * only for an unresolved sender on an attendance-relevant message with
 * a match to name; one nudge per pushname per match, forever; never
 * prints a raw numeric id as a name (RC4).
 *
 * `applies: false` means the caller keeps whatever reply it had.
 * `applies: true` with `reply: null` means "already nudged — say
 * nothing", which is deliberately not the same thing.
 */
async function unresolvedSenderNudge(args: {
  senderResolved: boolean;
  attendanceRelevant: boolean;
  matchId: string | null;
  authorName: string | null;
  dropping: boolean;
}): Promise<{ applies: boolean; reply: string | null }> {
  // The RULE (does it fire, what does it say, under what key) is pure and
  // unit-tested in `lib/unresolved-nudge.ts`. That is where the 2026-08-30
  // audit's finding is fixed: this guard used to require
  // `(authorName ?? "").trim().length >= 1`, so the one mechanism written
  // for "a sender we could not identify" was blind to the case where we
  // could not identify the sender AT ALL. This function keeps only the
  // database half.
  const plan = planUnresolvedNudge(args);
  if (!plan.applies || !plan.dedupeKey) return { applies: false, reply: null };

  const already = await db.sentNotification.findUnique({ where: { key: plan.dedupeKey } });
  if (already) {
    // Already nudged for this pushname+match — stay silent, don't
    // repeat. The admin queue still lists it.
    return { applies: true, reply: null };
  }
  // Record the dedupe row immediately. Tiny risk: if the bot fails to
  // post we under-notify — acceptable, the admin queue is the backstop,
  // and re-nudging every batch would spam the group (the failure Kemal
  // hates most).
  await db.sentNotification.create({
    data: { key: plan.dedupeKey, kind: "unresolved-sender-nudge", matchId: args.matchId },
  });
  return { applies: true, reply: plan.reply };
}

/**
 * NAME EVERY @-MENTION THE ORG ROSTER CAN VOUCH FOR — and only those.
 *
 * ── WHY THIS MOVED HERE (prod, measured 2026-09-08) ─────────────────
 *
 * The Pi used to do it. It resolved each mentioned JID with
 * `client.getContactById()` and pasted the contact's pushname straight
 * into the body the analyzer reads. Two real messages from the live
 * Sutton FC group, as the owner typed them versus as stored in
 * `AnalyzedMessage.body`:
 *
 *   "@Shahrokh🐔 Sutton Football Club is out due to unforeseen issue at work"
 *   → "@DÇ  is out due to unforeseen issue at work"
 *
 *   "@David David 67 and @~Najib out"
 *   → "@割::::.̸̢̤̋̃̓̉͗̏̾̃̌̚͘̕.̵͆͂ and @Najib out"
 *
 * Both drops were silently lost, and the owner had been reporting for
 * weeks that MatchTime could not understand his messages.
 *
 * ⚠️ NOTHING WAS CORRUPT AND NO WRONG CONTACT WAS RETURNED. That second
 * string occurs 13 times in this org's `AnalyzedMessage.authorName` — it
 * is David's OWN pushname, reported identically whenever David himself
 * speaks, and `UserAlias["割::::.."] → David` was ALREADY in the
 * database. WhatsApp renders a mention to each reader out of the
 * READER's address book; the bot only ever sees the mentioned person's
 * self-chosen profile name. When the two agree the substitution looks
 * perfect — "@Mojib Jalali" and "@Najib" resolved correctly in the very
 * same message — and when they do not, the model reads a name nobody in
 * the club uses.
 *
 * The pushname is therefore (a) not an identity and (b) a string the
 * mentioned person controls. The roster is neither of those things. So
 * the Pi now forwards the raw "@<digits>" token plus the pushname as
 * explicitly-untrusted `mentionNames`, and the naming happens HERE,
 * against `Membership` and `UserAlias`. See
 * `lib/pipeline/mention-names.ts` for the order of trust.
 *
 * Cost: at most two extra queries per batch, and only for a batch that
 * actually carries an unresolved "@<digits>" token.
 *
 * Compatible in BOTH directions, which matters because the server ships
 * on merge and the Pi is deployed by hand:
 *   • OLD Pi → new server: the body arrives already substituted, so it
 *     holds no "@<digits>" tokens and every replace is a no-op.
 *   • NEW Pi → old server: `mentionNames` is an unread key and the raw
 *     tokens reach the analyzer, which refuses them as people
 *     (`pipeline/identity.ts`). Worse than the fix, better than a
 *     fabricated name.
 */
async function nameMentionsFromRoster(
  orgId: string,
  messages: InboundMessage[],
): Promise<InboundMessage[]> {
  const RAW_TOKEN = /@\d{5,}/;
  const relevant = messages.some(
    (m) => (m?.mentions?.length ?? 0) > 0 && RAW_TOKEN.test(m?.body ?? ""),
  );
  if (!relevant) return messages;

  const [members, aliases] = await Promise.all([
    db.membership.findMany({
      where: { orgId },
      select: { user: { select: { id: true, name: true, phoneNumber: true } } },
    }),
    db.userAlias.findMany({ where: { orgId }, select: { alias: true, userId: true } }),
  ]);
  // Soft-removed members are INCLUDED. Naming someone correctly is not a
  // write, and whether they may actually play is decided later by code
  // that reads `leftAt` for itself.
  const roster = members
    .map((m) => m.user)
    .filter((u) => !!u?.name)
    .map((u) => ({ userId: u.id, name: u.name as string, phone: u.phoneNumber }));

  return messages.map((m) => {
    if (!m?.mentions?.length || !RAW_TOKEN.test(m.body ?? "")) return m;
    const { body, outcomes } = resolveMentionNames({
      body: m.body,
      mentions: m.mentions,
      mentionNames: m.mentionNames,
      roster,
      aliases,
    });
    const described = describeMentionOutcomes(outcomes);
    // One line per message that carried a mention. A run of "LEFT RAW"
    // is the signal that a player's pushname needs a `UserAlias`.
    if (described) console.log(`[analyze] mentions ${m.waMessageId}: ${described}`);
    return body === m.body ? m : { ...m, body };
  });
}

/**
 * Fuzzy-match a free-text name against the org's roster, or create a
 * provisional member if no unique match. Used for:
 *   - the message sender themselves (resolveSender fallback)
 *   - third-party registrations ("my dad Najib is also in" → lookup
 *     "Najib" in org, else provision)
 *
 * Returns null only when the name is empty / obviously not a person.
 */
async function resolveOrProvisionByName(
  orgId: string,
  rawName: string,
): Promise<{ userId: string; name: string | null } | null> {
  const name = rawName.trim();
  if (!name || name.length < 2) return null;

  // 1. Fuzzy lookup against existing members. Soft-removed members are
  //    INCLUDED in the candidate set so we restore them rather than
  //    creating a duplicate ghost when they get re-mentioned in chat.
  const candidates = await db.membership.findMany({
    where: { orgId },
    include: { user: { select: { id: true, name: true } } },
  });
  const norm = (s: string) =>
    s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const pushTokens = norm(name).split(/\s+/).filter(Boolean);
  const pushFirst = pushTokens[0] ?? "";

  const equalsMatches = candidates.filter(
    (c) => c.user.name && norm(c.user.name) === norm(name),
  );
  if (equalsMatches.length === 1) {
    const m = equalsMatches[0];
    if (m.leftAt) await restoreMembership(m.id, m.user.name);
    return { userId: m.user.id, name: m.user.name };
  }

  const firstNameMatches = candidates.filter((c) => {
    if (!c.user.name) return false;
    const dbTokens = norm(c.user.name).split(/\s+/).filter(Boolean);
    const dbFirst = dbTokens[0] ?? "";
    return (
      dbFirst === pushFirst ||
      (dbFirst.length >= 3 &&
        pushFirst.length >= 3 &&
        (dbFirst.startsWith(pushFirst) || pushFirst.startsWith(dbFirst)))
    );
  });
  if (firstNameMatches.length === 1) {
    const m = firstNameMatches[0];
    if (m.leftAt) await restoreMembership(m.id, m.user.name);
    return { userId: m.user.id, name: m.user.name };
  }
  // Ambiguous: multiple players match the given name ("Ibrahim" when
  // there are two). BEFORE bailing out, try the alias table — admin-
  // curated UserAlias rows are unique per (orgId, alias) so an alias
  // hit disambiguates cleanly regardless of fuzzy ambiguity. Same fix
  // as resolveSender (Kemal flagged Baki/"ba" 2026-05-15).
  if (firstNameMatches.length > 1) {
    const aliasKeyEarly = norm(name);
    if (aliasKeyEarly.length >= 2) {
      const alias = await db.userAlias.findUnique({
        where: { orgId_alias: { orgId, alias: aliasKeyEarly } },
      });
      if (alias) {
        const m = candidates.find((c) => c.userId === alias.userId);
        if (m) {
          if (m.leftAt) await restoreMembership(m.id, m.user.name);
          console.log(
            `[analyze] third-party ambiguous "${name}" resolved via UserAlias → ${m.user.name} (${alias.userId})`,
          );
          return { userId: m.user.id, name: m.user.name };
        }
      }
    }
    console.warn(
      `[analyze] third-party name "${name}" is ambiguous in org ${orgId} (${firstNameMatches.length} candidates, no alias to disambiguate). Skipping registration.`,
    );
    return null;
  }

  // 1c. Alias lookup — admin-curated nickname → user mapping. Same
  //     reason as resolveSender: covers "Nunu" → Elnur, "Mike" →
  //     Michael Allen, etc. that fuzzy can't bridge.
  const aliasKey = norm(name);
  if (aliasKey.length >= 2) {
    const alias = await db.userAlias.findUnique({
      where: { orgId_alias: { orgId, alias: aliasKey } },
    });
    if (alias) {
      const m = candidates.find((c) => c.userId === alias.userId);
      if (m) {
        if (m.leftAt) await restoreMembership(m.id, m.user.name);
        return { userId: m.user.id, name: m.user.name };
      }
    }
  }

  // 2. No unique match and no ambiguity → provision. No phone known (third party).
  const provisioned = await createProvisionalByName(orgId, name, null);
  if (provisioned) return { userId: provisioned.userId!, name: provisioned.name };
  return null;
}

// `KEYCAP` is deleted with `executeVerdict` (§10 step 8). The
// slot-number reactions it rendered are composed by
// `pipeline/compose.ts` from the projected position, so the emoji and
// the row it claims to describe are produced by the same pass and
// cannot disagree.

/**
 * Pick the right match for an attendance/bench mutation.
 *
 * Two evolutions of this rule:
 * - 2026-05-06: dropped the `attendanceDeadline > now` filter (was
 *   causing post-deadline cascade to NEXT WEEK silently). Now we
 *   only consider matches with date >= startOfToday.
 * - 2026-05-06 (later): block registrations while the most recent
 *   scheduled match hasn't been COMPLETED yet. Use case: yesterday's
 *   match has ended (~22:30) but the cron hasn't flipped its status
 *   to COMPLETED yet (~01:00 the next morning). During that window
 *   a player saying "in" should NOT silently register for next
 *   week's match — they're almost certainly still talking about
 *   yesterday's match. Registration only opens once the current
 *   match is COMPLETED.
 *
 * Rule:
 *   1. If any non-COMPLETED non-CANCELLED match has date < today,
 *      return null. The current scheduled match is in flight.
 *   2. Otherwise return the soonest non-completed match where
 *      date >= today.
 */
/**
 * The ACTIVE registration match — the single match every attendance WRITE
 * lands on. Delegates the date/state decision to the pure, unit-tested
 * `selectRegistrationMatch` so the rule (soonest upcoming, regardless of
 * fullness or attendanceDeadline; blocked while a previous match is still
 * in flight) is one source of truth shared with the LLM-context + reply
 * selectors below. Fixes the 2026-06-18 Sutton Lads rollover bug where a
 * FULL this-week match let casual "In"s land on next week's empty match.
 */
async function findRegistrationMatch(orgId: string) {
  // Load every non-completed match for the org (always a small set — the
  // cron completes finished matches). The pure selector then decides the
  // active match and the in-flight block deterministically.
  const candidates = await db.match.findMany({
    where: {
      activity: { orgId },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
    },
    orderBy: { date: "asc" },
  });
  const picked = selectRegistrationMatch(candidates);
  return picked ?? null;
}

// ── `executeVerdict` IS DELETED (§10 step 8) ─────────────────────────
//
//   921 lines, and the last thing in this file that took an
//   `AnalysisVerdict`. It was the model's output turned into database
//   writes and English, and §5 counted sixteen distinct overrides inside
//   it correcting that output on the way through.
//
//   Every branch it carried now has an owner that decides from FACTS and
//   composes from the DATABASE, and none of the moves is a
//   reimplementation from memory — each apply layer cites the lines it
//   was lifted from:
//
//     attendance IN/OUT/BENCH   → `lib/attendance-engine.ts` (step 6)
//     bench confirmation        → `lib/bench-prompt-answer.ts` +
//                                 `resolveBenchConfirmation`, peeled
//                                 deterministically before the router
//     conditional_in / tentative→ `pipeline/engine.ts`, from `contingent`
//                                 and `conditionOn` rather than a regex
//                                 that needed a literal "if" and so let
//                                 "happy to drop WHEN you find someone"
//                                 straight through (§9)
//     score + Elo               → `lib/score-engine.ts`, deps in
//                                 `lib/owner-deps.ts`
//     generate / show teams     → `lib/team-ops-engine.ts` and
//                                 `pipeline/answer-batch.ts`
//     bulk payment credit       → `lib/admin-ops-engine.ts`, deps in
//                                 `lib/owner-deps.ts`
//     reminder request          → `lib/admin-ops-engine.ts`, with the
//                                 calendar arithmetic in the pure
//                                 `lib/reminder-time.ts` instead of the
//                                 model's head (§3.2 S22)
//     the per-org feature gate  → each owner reads the org's features
//                                 out of its own `SquadState` load and
//                                 owns nothing when its feature is off,
//                                 which refuses BEFORE the write rather
//                                 than suppressing the reply after it
//
//   `KEYCAP` went with it: the slot-number reactions it rendered are
//   composed by `pipeline/compose.ts` from the projected position now,
//   and §3.2's category-E note records that the prompt rule forbidding
//   them was itself "an instruction whose entire content is the history
//   of a removed feature".

async function recordAnalysis(args: {
  orgId: string;
  groupId: string;
  msg: InboundMessage;
  handledBy: string;
  intent: string | null;
  action: string | null;
  confidence: number | null;
  reasoning: string;
  authorUserId?: string | null;
  /** WhatsApp pushname. Persisted so the admin "unresolved messages"
   *  queue can show WHO ("ba") to link to a player when authorUserId
   *  is null. */
  authorName?: string | null;
}) {
  try {
    await db.analyzedMessage.create({
      data: {
        waMessageId: args.msg.waMessageId,
        orgId: args.orgId,
        groupId: args.groupId,
        authorPhone: args.msg.authorPhone || null,
        authorUserId: args.authorUserId ?? null,
        authorName: args.authorName ?? args.msg.authorName ?? null,
        body: args.msg.body.slice(0, 2000),
        handledBy: args.handledBy,
        intent: args.intent,
        action: args.action,
        confidence: args.confidence,
        reasoning: args.reasoning.slice(0, 2000),
        // The flush this message was reasoned about in. Null outside a
        // batch (nothing else calls this) — see analyze-batch-context.ts.
        batchId: currentAnalyzeBatchId(),
      },
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    if (!/unique/i.test(m)) {
      console.error("[analyze] recordAnalysis failed:", err);
    }
  }
}

/**
 * Add an outcome to an AnalyzedMessage row that already exists.
 *
 * `AnalyzedMessage.waMessageId` is UNIQUE and `recordAnalysis` swallows
 * the unique violation, so a second create for the same message is
 * silently discarded — the first write wins. The verdict-driven recruit
 * runs AFTER the LLM path has already recorded the message, so it must
 * UPDATE rather than create, or the admin log would show the drop and no
 * trace of the invite blast that went out with it.
 *
 * Best-effort: a failure here must never fail the batch.
 */
async function augmentAnalysis(args: {
  waMessageId: string;
  action: string;
  reasoningSuffix: string;
  /**
   * RELABEL the row, not just append to it. Passed by
   * `applyClauseReports` and ONLY when the pipeline recorded nothing for
   * the message — a `noise`/`ignored` row whose residual reached the end
   * of the batch unclaimed. Without it the admin log would say a swap
   * message was `noise` while the team sheet moved, which is exactly the
   * kind of quiet disagreement between the log and the world that makes
   * an incident take a day to read. Omitted → the existing label stands.
   */
  handledBy?: string;
  intent?: string;
}) {
  try {
    const existing = await db.analyzedMessage.findUnique({
      where: { waMessageId: args.waMessageId },
      select: { action: true, reasoning: true },
    });
    if (!existing) return;
    const action = existing.action ? `${existing.action}+${args.action}` : args.action;
    const reasoning = existing.reasoning
      ? `${existing.reasoning} | ${args.reasoningSuffix}`
      : args.reasoningSuffix;
    await db.analyzedMessage.update({
      where: { waMessageId: args.waMessageId },
      data: {
        action: action.slice(0, 2000),
        reasoning: reasoning.slice(0, 2000),
        ...(args.handledBy ? { handledBy: args.handledBy } : {}),
        ...(args.intent ? { intent: args.intent } : {}),
      },
    });
  } catch (err) {
    console.error("[analyze] augmentAnalysis failed:", err);
  }
}

/**
 * Archive inbound messages for a `featureSquadFromList` org so the
 * squad-extraction cron has raw data to diff. Skipped entirely for
 * other orgs (Sutton etc. don't write here). Idempotent on
 * waMessageId (unique). Body trimmed to 4 KB to be safe in case of
 * gigantic copy-pastes.
 */
async function storeMessagesForSquadFromList(
  orgId: string,
  groupId: string,
  messages: InboundMessage[],
): Promise<void> {
  if (!messages.length) return;
  // Filter empty bodies + the bot's own messages (no authorPhone +
  // no authorName) at the edge so we don't pollute the archive.
  const rows = messages
    .filter((m) => m.body.trim().length > 0)
    .map((m) => ({
      orgId,
      waChatId: groupId,
      waMessageId: m.waMessageId,
      senderPhone: m.authorPhone || null,
      senderPushname: m.authorName || null,
      body: m.body.slice(0, 4000),
      timestamp: new Date(m.timestamp),
    }));
  if (!rows.length) return;
  try {
    await db.groupMessage.createMany({ data: rows, skipDuplicates: true });
  } catch (err) {
    // Don't break the analyze response on archive failure — the
    // squad-extraction cron will try again next time the same messages
    // re-arrive (we already dedupe on waMessageId).
    console.error("[analyze] storeMessagesForSquadFromList failed:", err);
  }
}

/**
 * Phase 2 onboarding router. Returns a bot response object when this
 * batch belongs to an onboarding flow (active session, or a fresh
 * "@MatchTime setup" trigger in a group with no bot-enabled org), or
 * null to fall through to normal analysis.
 *
 * Trigger is intentionally tight so it can't fire by accident in a
 * live group: must address MatchTime AND say set up / get started.
 */
const SETUP_TRIGGER =
  /(?:@?\s*match\s*time\b[\s\S]{0,40}\b(?:set\s*up|get\s*started|onboard)\b)|(?:\b(?:set\s*up|onboard)\s+match\s*time\b)/i;

async function handleOnboardingIfApplicable(
  body: InboundBody,
): Promise<{ ok: true; results: ActionForBot[] } | null> {
  const groupId = body.groupId;

  let session = await db.onboardingSession.findFirst({
    // "introduced"/"details" are the Phase 1 group-add stages
    // (2026-06-12 design); they only ever exist when the flag-gated
    // /api/whatsapp/bot-added route created them, so this is inert for
    // every group that never went through a bot-add.
    where: {
      whatsappGroupId: groupId,
      stage: { in: ["collecting", "features", "introduced", "admins", "details"] },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!session) {
    // No active session — only start one on an explicit trigger AND
    // only if this group isn't already a live org (don't hijack a
    // configured group).
    const triggered = body.messages.some((m) => SETUP_TRIGGER.test(m.body || ""));
    if (!triggered) return null;
    const liveOrg = await db.organisation.findFirst({
      where: { whatsappGroupId: groupId, whatsappBotEnabled: true },
      select: { id: true },
    });
    if (liveOrg) return null; // already set up — ignore the trigger
    session = await db.onboardingSession.create({
      data: { whatsappGroupId: groupId, stage: "collecting" },
    });
  }

  // Dedupe: if the last message we already handled is the tail of
  // this batch, a flush re-sent it — stay silent.
  const lastWaId = body.messages[body.messages.length - 1]?.waMessageId ?? null;
  if (lastWaId && session.lastHandledWaId === lastWaId) {
    return { ok: true, results: [] };
  }

  const result = await handleOnboardingTurn({
    session,
    messages: body.messages.map((m) => ({
      waMessageId: m.waMessageId,
      authorName: m.authorName,
      body: m.body,
      // Sender identity — used by the group-add flow to capture the
      // consenting admin (design fix: this used to be dropped, so the
      // flow COULDN'T assign an owner even if it wanted to).
      authorPhone: m.authorPhone ?? null,
      // Raw WhatsApp mention JIDs, forwarded UNCHANGED from the bot. The
      // `admins` stage's parseAdmins() resolves "<digits>@c.us" → phone
      // and treats "<digits>@lid" as a privacy id (no phone).
      mentions: m.mentions,
    })),
    // Forward enrichment history (if any) to the onboarding turn; the
    // turn fires the enrichment pass + admin DM on completion. Absent →
    // no enrichment runs. Already in the HistoryMessage shape.
    history: body.enrichmentHistory,
  });

  const results: ActionForBot[] = [];
  if (result.reply && lastWaId) {
    results.push({
      waMessageId: lastWaId,
      handledBy: "llm",
      intent: "onboarding",
      react: null,
      reply: result.reply,
    });
  }
  return { ok: true, results };
}

/**
 * SEATBELT (2026-05-19, WIDENED 2026-09-08): "swap A with B" /
 * "switch A and B" is a TEAM-SHEET edit, never a drop. It is resolved
 * deterministically from database state, on the RAW BODY, with no model
 * anywhere in the path.
 *
 * TWO SHAPES ARE OWNED. `lib/team-slot-swap.ts` holds the whole rule,
 * the 8x8 state matrix behind it, and the argument for every refusal:
 *
 *   both CONFIRMED           → they exchange sides. The 2026-05-19
 *                              seatbelt, unchanged, including its
 *                              defensive one-sided case.
 *   one CONFIRMED holding no
 *   slot, the other holding a
 *   slot but NOT CONFIRMED   → the slot MOVES. NEW (2026-09-08): the
 *                              Elvin/Raihan replacement, where a
 *                              DROPPED player's stale RED slot had to
 *                              follow the body of the man who replaced
 *                              him, and the shipped both-CONFIRMED rule
 *                              declined the message entirely.
 *
 * Returns:
 *   { reply, logReason }  → handled (the caller peels the message)
 *   null                  → not a shape this owns; the ordinary flow
 *                           decides it, exactly as before. EVERY
 *                           refusal comes back this way on purpose:
 *                           owning a message peels it out of the batch,
 *                           and a refusal that owned it would delete
 *                           every other clause in the same message.
 *
 * It writes `TeamAssignment` and nothing else: never attendance, never
 * the balancer.
 */
/**
 * ── `looksLikeConditionalDrop` IS DELETED (§10 step 8) ───────────────
 *
 * The deterministic HOLD for "happy to drop if you can find someone"
 * (Kemal, 2026-06-09: Erdal was dropped on "If u can make happy to
 * drop"). It fired only when the model had already read the message as
 * a drop, and it decided contingency by looking for a literal `if`.
 *
 * §9 files it under "becomes a schema field", and names the hole the
 * regex had in its own words: it "requires a literal `if`, so 'happy to
 * drop WHEN you find someone' bypasses the hold entirely". The
 * extractor now returns `contingent` and `conditionOn` as FACTS about
 * the sentence, and `engine.ts` refuses to write a contingent claim
 * whatever conjunction it was phrased with. Corpus case
 * `S11-erdal-conditional-drop`.
 */

async function handleTeamSwapIfApplicable(
  orgId: string,
  rawBody: string,
): Promise<{ reply: string; logReason: string } | null> {
  const names = parseSwapNames(rawBody);
  if (!names) return null;

  const match = await db.match.findFirst({
    where: {
      activity: { orgId },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
    },
    orderBy: { date: "asc" },
    include: {
      activity: {
        include: {
          sport: { select: { teamLabels: true } },
          org: { select: { teamLabels: true } },
        },
      },
      // EVERY attendance row, not only the CONFIRMED ones. The shipped
      // query filtered to CONFIRMED, which is the whole reason a DROPPED
      // Elvin could not be FOUND on 2026-09-08, let alone acted on.
      // Widening the query does not widen who a name resolves to:
      // `resolveSwapSide` still gives a unique CONFIRMED match outright
      // priority, so every name that resolved before resolves to the
      // same person.
      attendances: { include: { user: { select: { id: true, name: true } } } },
      teamAssignments: { include: { user: { select: { id: true, name: true } } } },
    },
  });
  if (!match) return null;

  const teamOf = new Map(match.teamAssignments.map((t) => [t.userId, t.team]));
  const roster: SwapCandidate[] = [];
  for (const a of match.attendances) {
    if (!a.user.name) continue;
    roster.push({
      userId: a.user.id,
      name: a.user.name,
      status: a.status,
      team: teamOf.get(a.user.id) ?? null,
    });
  }
  // Anyone holding a slot with NO attendance row at all. The generator
  // cannot produce that state (it builds from CONFIRMED rows only), but
  // a hand-edited or half-cleaned sheet can be left in it, and such a
  // player is exactly the stale occupant a replacement needs to
  // displace. They enter the pool as `NONE`.
  const seen = new Set(roster.map((r) => r.userId));
  for (const t of match.teamAssignments) {
    if (seen.has(t.userId) || !t.user.name) continue;
    roster.push({ userId: t.userId, name: t.user.name, status: "NONE", team: t.team });
  }

  const A = resolveSwapSide(names.a, roster);
  const B = resolveSwapSide(names.b, roster);
  if (!A || !B) return null;

  const decision = decideSwap(A, B);

  // A REFUSAL IS A FALL-THROUGH, NEVER AN OWNED MESSAGE. This is the
  // same `null` the shipped handler returned for everything that was
  // not a both-CONFIRMED pair, so the set of messages the peel swallows
  // grows by exactly one shape (the replacement transfer) and by
  // nothing else. `lib/team-slot-swap.ts` names each refusal and argues
  // it; none of them is safe to ANSWER, because answering peels the
  // message out of `fresh` and deletes every other clause in it.
  if (decision.kind === "refuse") return null;

  const labels = resolveTeamLabels(match, match.activity.org, match.activity.sport);
  const sheet = async () => {
    const rows = await db.teamAssignment.findMany({
      where: { matchId: match.id },
      include: { user: { select: { name: true } } },
    });
    const red = rows.filter((t) => t.team === "RED").map((t) => t.user.name);
    const yel = rows.filter((t) => t.team === "YELLOW").map((t) => t.user.name);
    return (
      `*${labels[0]}*\n${red.map((n, i) => `${i + 1}. ${n}`).join("\n")}\n\n` +
      `*${labels[1]}*\n${yel.map((n, i) => `${i + 1}. ${n}`).join("\n")}`
    );
  };

  if (decision.kind === "defer-no-teams") {
    // Teams not generated yet — nothing to swap, but make ABSOLUTELY
    // sure nobody is dropped. Acknowledge + defer. Unchanged wording.
    return {
      reply:
        `Both *${A.name}* and *${B.name}* are already in — nobody's dropped. ` +
        `Teams aren't generated yet; say *generate teams* and I'll build them (then I can put them on opposite sides).`,
      logReason: `team-swap deferred (no teams yet): ${A.name} <-> ${B.name}`,
    };
  }

  if (decision.kind === "team-swap") {
    await db.$transaction([
      db.teamAssignment.upsert({
        where: { matchId_userId: { matchId: match.id, userId: decision.a.userId } },
        create: { matchId: match.id, userId: decision.a.userId, team: decision.teamForA },
        update: { team: decision.teamForA },
      }),
      db.teamAssignment.upsert({
        where: { matchId_userId: { matchId: match.id, userId: decision.b.userId } },
        create: { matchId: match.id, userId: decision.b.userId, team: decision.teamForB },
        update: { team: decision.teamForB },
      }),
    ]);
    return {
      reply:
        `🔁 Swapped *${decision.a.name}* and *${decision.b.name}* — nobody dropped. Updated teams:\n\n` +
        (await sheet()),
      logReason: `team-swap applied: ${decision.a.name} <-> ${decision.b.name}`,
    };
  }

  // ── THE REPLACEMENT TRANSFER ───────────────────────────────────────
  //
  // One `TeamAssignment` row moves from a player who is not coming to a
  // player who is. Same transaction shape as the bench-promote path in
  // `lib/bench-confirmation.ts:129-138`, which has done exactly this
  // slot transfer since the bench redesign: DELETE the donor's row and
  // UPSERT the receiver's, atomically, so the sheet is never briefly a
  // player short nor briefly holding two people in one seat.
  //
  // NO ATTENDANCE WRITE. Elvin stays DROPPED, Raihan stays CONFIRMED;
  // the only thing that was ever wrong was which of them the team sheet
  // named. And NO BALANCER: the message that caused this said "do not
  // regenerate the teams" in as many words, and re-running it over a
  // hand-made line-up on match night is 2026-06-18 (`c408649`).
  await db.$transaction([
    db.teamAssignment.delete({
      where: { matchId_userId: { matchId: match.id, userId: decision.from.userId } },
    }),
    db.teamAssignment.upsert({
      where: { matchId_userId: { matchId: match.id, userId: decision.to.userId } },
      create: { matchId: match.id, userId: decision.to.userId, team: decision.team },
      update: { team: decision.team },
    }),
  ]);
  const movedTo = decision.team === "RED" ? labels[0] : labels[1];
  return {
    reply:
      `🔁 *${decision.to.name}* takes *${decision.from.name}*'s place on *${movedTo}* — ` +
      `same teams otherwise, nothing regenerated, nobody's attendance changed. Updated teams:\n\n` +
      (await sheet()),
    logReason:
      `team-slot-transfer applied: ${decision.from.name} (${decision.from.status}) ` +
      `-> ${decision.to.name} on ${decision.team}`,
  };
}

/**
 * "swap/switch/flip the colours", "swap colors", "swap red and yellow" —
 * a request to flip the team LABELS while keeping the exact same player
 * groupings. Deterministic guard so it NEVER reaches the LLM's
 * generate_teams_request path, which rebalances into different teams
 * (Kemal 2026-06-09: "swap the colours and keep the same teams" ran a
 * full regen and produced different teams the night of a match). Returns
 * null when it isn't a colour swap or no teams exist yet — caller falls
 * through to normal handling.
 */
/**
 * The LITERAL-colour half of the colour-swap detection: "swap/flip the
 * colours", "swap red and yellow". No database, no org labels, no
 * `await` — which is the whole reason it is a function of its own.
 *
 * The clause peel needs to choose WHICH clause of a message the colour
 * swap belongs to, and it must do that before deciding whether to spend
 * a query at all. Lifted verbatim out of `handleColorSwapIfApplicable`,
 * which still calls it, so there is one definition and the peel can
 * never disagree with the handler about what a colour swap looks like.
 *
 * It is deliberately NOT the whole test: an org with custom team labels
 * ("swap the Bibs and the Skins") is recognised only inside the handler,
 * where the match row says what this org calls its sides. When this
 * returns false the peel hands the handler the WHOLE body, so that
 * branch is reached exactly as it was before clause peeling existed.
 */
function looksLikeColourSwapPhrase(rawBody: string): boolean {
  const body = (rawBody || "").trim();
  return (
    /\b(swap|switch|flip|reverse|invert|change)\b[\s\S]{0,40}\bcolou?rs?\b/i.test(body) ||
    /\bcolou?rs?\b[\s\S]{0,40}\b(swap|switch|flip|reverse|invert|change)\b/i.test(body) ||
    /\bswap\b[\s\S]{0,25}\b(red|yellow|reds|yellows)\b[\s\S]{0,25}\b(red|yellow|reds|yellows)\b/i.test(body)
  );
}

async function handleColorSwapIfApplicable(
  orgId: string,
  rawBody: string,
): Promise<{ reply: string; logReason: string } | null> {
  const body = (rawBody || "").trim();

  // Fast path: "swap/flip the colours" or "swap red and yellow" need no DB
  // lookup — the literal colour words / "colours" keyword are enough.
  const hasSwapVerb = /\b(swap|switch|flip|reverse|invert|change)\b/i.test(body);
  let isColourSwap = looksLikeColourSwapPhrase(body);

  // Cheap pre-gate before touching the DB: only orgs with a swap verb in
  // the message can possibly be a "swap <labelA> and <labelB>" — anything
  // without a swap verb can't be a colour swap at all.
  if (!isColourSwap && !hasSwapVerb) return null;

  const match = await db.match.findFirst({
    where: {
      activity: { orgId },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
    },
    orderBy: { date: "asc" },
    include: {
      activity: {
        include: {
          sport: { select: { teamLabels: true } },
          org: { select: { teamLabels: true } },
        },
      },
      teamAssignments: { include: { user: { select: { name: true } } } },
    },
  });
  // No teams generated yet → nothing to flip; let normal handling decide.
  if (!match || match.teamAssignments.length === 0) return null;

  // Custom-label aware detection: if not already a literal red/yellow or
  // "colours" swap, recognise "swap <labelA> and <labelB>" using THIS org's
  // configured team labels (resolved from Organisation/Sport.teamLabels).
  // Red/Yellow stay covered by the regexes above as a fallback.
  if (!isColourSwap) {
    const cfgLabels = resolveTeamLabels(match, match.activity.org, match.activity.sport);
    const labelAlts = cfgLabels
      .map((l) => l.trim())
      .filter((l) => l && !/^(red|yellow)$/i.test(l))
      .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (labelAlts.length === 2) {
      const alt = `(?:${labelAlts.join("|")})`;
      const labelSwap = new RegExp(
        `\\bswap\\b[\\s\\S]{0,25}${alt}[\\s\\S]{0,25}${alt}`,
        "i",
      );
      if (labelSwap.test(body)) isColourSwap = true;
    }
    if (!isColourSwap) return null;
  }

  // Flip every assignment RED<->YELLOW in one transaction — same rosters,
  // labels swapped. No rebalance, no LLM.
  await db.$transaction(
    match.teamAssignments.map((t) =>
      db.teamAssignment.update({
        where: { id: t.id },
        data: { team: t.team === "RED" ? "YELLOW" : "RED" },
      }),
    ),
  );

  const labels = resolveTeamLabels(match, match.activity.org, match.activity.sport);
  const fresh = await db.teamAssignment.findMany({
    where: { matchId: match.id },
    include: { user: { select: { name: true } } },
  });
  const red = fresh.filter((t) => t.team === "RED").map((t) => t.user.name);
  const yel = fresh.filter((t) => t.team === "YELLOW").map((t) => t.user.name);
  return {
    reply:
      `🎨 Swapped the colours — same teams, sides flipped:\n\n` +
      `*${labels[0]}*\n${red.map((n, i) => `${i + 1}. ${n}`).join("\n")}\n\n` +
      `*${labels[1]}*\n${yel.map((n, i) => `${i + 1}. ${n}`).join("\n")}`,
    logReason: `colour-swap applied (labels flipped, rosters unchanged)`,
  };
}
