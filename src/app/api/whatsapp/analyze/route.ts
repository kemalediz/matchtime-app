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
 *   0. DETERMINISTIC PEELS — no model at all. Group→DM Q&A, help, the
 *      colour swap, the team swap, a bench-prompt answer, a pasted
 *      roster. Each is a database row or a
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
import { ORDINARY_MEMBER_WHERE } from "@/lib/guest-membership";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { REPLY_PRIORITY } from "@/lib/dm-reply-priority";
import { uniqueByWaMessageId } from "@/lib/analyze-batch";
import { billingQuietWhere } from "@/lib/club-billing-rules";
import { signMagicLinkToken, MAGIC_LINK_TTL } from "@/lib/magic-link";
import { buildShortMagicLinkUrl } from "@/lib/short-link";
// §10 step 8: `analyzeBatch`, `AnalysisVerdict` and `BatchInputMessage`
// were imported here until this change. They no longer exist.
// `enforceProximity` does, and stays: it rewrites "tonight" → "Tue 8 Sep"
// and the 20:30/21:30 BST-vs-UTC slips, and it is applied to every
// outgoing reply whatever composed it — it was never about the model.
import { enforceProximity } from "@/lib/message-analyzer";
import {
  RECRUIT_ACK_KIND,
  ROSTER_SHOWN_KIND,
  recruitAckKey,
  rosterShownKey,
  squadFingerprint,
} from "@/lib/roster-shown";
import {
  composeSquadStateReply,
  skipsSquadComposition,
  buildRecruitAckReply,
  teamSheetNames,
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
import { LATE_MESSAGE_KIND, OPERATOR_NOTE_KIND, recordOpsEvent } from "@/lib/ops-alerts";
import {
  composeLateMessageAlert,
  formatDelay,
  LATE_HANDLED_BY,
  parseTimestamp,
  planLateMessages,
  silenceLateResult,
  type LateEntry,
} from "@/lib/late-message";
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
import { alsoTeamsIds } from "@/lib/team-also-signal";
import { TEAM_OPS_HANDLED_BY } from "@/lib/team-ops-engine";
import {
  buildScoreApplyDeps,
  buildAdminOpsApplyDeps,
  buildTeamOpsApplyDeps,
  buildClaimGuestNameAsk,
} from "@/lib/owner-deps";
import {
  loadOpenQuestion,
  loadOpenStatsClarifications,
  scoreRouteOverrides,
} from "@/lib/pipeline/load-awaiting-answer";
import { ENGINE_HANDLED_BY } from "@/lib/attendance-engine";
import { describeEngineBatch, runAttendanceEngineBatch } from "@/lib/attendance-engine-batch";
import { moveNamedSlot } from "@/lib/team-slot-fill";
import { getOrgFeatures } from "@/lib/org-features";
import { organisersAnnounce } from "@/lib/list-announcer";
import { appendAfterComposition, joinAlsoAnswered } from "@/lib/also-asks-reply";
import { organisersGroupReply, passesOrganisersNet } from "@/lib/organisers-list-copy";
import { sendAdminNotice } from "@/lib/admin-channel";
import {
  bindAiBudgetKey,
  claimCapReply,
  getAiBudgetStatus,
  pickCapReplyMessage,
  recordCapSkips,
  withDeferredOrgAiBudget,
} from "@/lib/ai-budget";

/** `AnalyzedMessage.handledBy` for a message the daily AI cap left
 *  unhandled. Distinct from `router-gate` so the nightly none-bucket
 *  sweep and the dashboard can tell "the router called it banter" from
 *  "nobody was allowed to ask". */
const AI_CAP_HANDLED_BY = "ai-daily-cap";
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
import { t as strings } from "@/lib/i18n/t";
import { loadPlayerNames } from "@/lib/player-display-name";
import { registerAttendance, cancelAttendance } from "@/lib/attendance";
import { currentAnalyzeBatchId, withAnalyzeBatch } from "@/lib/analyze-batch-context";
import {
  persistPipelineTraces,
  traceRouting,
  withPipelineTrace,
  type TraceWriter,
} from "@/lib/pipeline/trace";
import {
  resolveAttendanceAck,
  attendanceFailureAction,
  attendanceFailureLog,
} from "@/lib/attendance-write-outcome";
import { recordTentative, resolveTentative } from "@/lib/tentative-store";
import { resolveTeamLabels } from "@/lib/team-labels";
// The SAME kickoff label `pipeline/load-state.ts` puts on `SquadState`,
// so the teams post reads identically whichever composer wrote it — and
// in the same LANGUAGE, which is why this is `i18n/dates`' helper and
// not a raw `formatLondon` pattern. Its English is "EEE HH:mm", byte for
// byte what the loader produced before the string tables existed.
import { dayCommaTimeLabel, dayLabel, kickoffLabel } from "@/lib/i18n/dates";
import { CANCELLED_NOTICE_LOOKBACK_MS, SAME_FIXTURE_MS, cancelledMatchToMention } from "@/lib/cancelled-match-notice";
import { selectRegistrationMatch } from "@/lib/registration-match-select";
import { messageAddressesBot, messageTagsBot, piMentionsBot } from "@/lib/interaction-contract";
import { taggedSilence } from "@/lib/tagged-silence";
import { offerCalloffIfCalled } from "@/lib/calloff-offer";
import { mergeRecruitReply } from "@/lib/recruit-request";
import {
  applyClauseReports,
  mergeOneReply,
  type ClausePeel,
  type ClauseReport,
} from "@/lib/pipeline/clause-peel";
import {
  describeMentionOutcomes,
  resolveMentionNames,
  type KnownLid,
} from "@/lib/pipeline/mention-names";
import { parseParticipantSnapshot } from "@/lib/participant-snapshot";
// Sender resolution moved OUT of this file on 2026-09-09. It could not be
// tested here — a Next.js route module may export only its HTTP handlers,
// so nothing in it can be imported by a test — and the 2026-08-30 audit
// named that as the reason its attribution hole survived review. Behaviour
// is unchanged by the move; see `lib/resolve-sender.ts` and its tests.
import { resolveSender, type ResolvedSender } from "@/lib/resolve-sender";
// Moved out of this file on 2026-10-14 so the admin group's squad changes
// resolve and provision names with the very same code. Unchanged.
import { resolveOrProvisionByName } from "@/lib/resolve-or-provision-name";
import { planUnresolvedNudge } from "@/lib/unresolved-nudge";
import { recordGroupSightings, sightedUserIds } from "@/lib/group-sighting";
import { quotedRefOf } from "@/lib/quoted-message";
import { loadGroupReplyContexts, parseGroupQuote, quoteFromPi, type QuotedGroupMessage } from "@/lib/reply-context";
import { rosterMemberByPhone } from "@/lib/roster-name-by-phone";
import { claimGroupReplies } from "@/lib/group-reply-claims";
import { handlePartnerVolunteer } from "@/lib/partner-guest";
import { askPartnerAfterOwnInByDm, askPartnerWhichByDm } from "@/lib/partner-guest-dm";
import { askPartnersFromWords, partnerClubsForRouter } from "@/lib/partner-ask-words";
import { askPoolFromWords } from "@/lib/pool-ask-words";
import { recruitPlacesFromWords } from "@/lib/recruit-source";
import { groupSourceAnswers } from "@/lib/ask-source-group";
import { groupAdminFollowups } from "@/lib/group-admin-followups";
import { setVenueFromWords } from "@/lib/venue-from-words";
import { recordVenueList } from "@/lib/venue-list-log";
import { askWhichSource, nobodyLeftReply, sourcesAvailable } from "@/lib/ask-source";
import { decideRecruitSource, type RecruitSource } from "@/lib/ask-source-rules";
import { poolEnvForApiRequest } from "@/lib/pool/switch-env";
import { chatAuthorOf, groupChatHistory } from "@/lib/group-chat-history";
import { pastedListIds, type RoutedForListSignal } from "@/lib/pasted-list-signal";
import type { MonthlyReading } from "@/lib/monthly-reader-prompt";

interface InboundMessage {
  waMessageId: string;
  body: string;
  authorPhone: string;
  authorName: string | null;
  timestamp: string;
  /** Raw WhatsApp mention JIDs (e.g. "447700900123@c.us", "…@lid"),
   *  forwarded UNCHANGED. */
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
  /** `phone` (2026-09-30): the phone behind a LID mention, when the Pi
   *  was told it. An entry carries a name, a phone, or both. */
  mentionNames?: Array<{ jid: string; name?: string; phone?: string }>;
  /** The text of the message this one REPLIES to (a WhatsApp quoted
   *  reply), when the Pi forwards it. No Pi build sends it yet (monthly
   *  squad, slice 3): until one does, a bare "IN" in reply to the month's
   *  list is read as it always was, and only "IN FOR NOVEMBER" signs up. */
  quotedBody?: string | null;
  /** Is the quoted message MatchTime's OWN (2026-10-16)? Computed on the Pi,
   *  which alone knows the bot's ids. A reply to MatchTime is addressed to
   *  it, like a tag (`messageTagsBot`), and the router and the question
   *  extractor are shown the post it quotes (`quotedMatchTimeText`). */
  quotedFromMatchTime?: boolean;
  /** The quoted message's WhatsApp id (cross-club ask, S0, 2026-10-16):
   *  which post a reply answers. Absent from older Pi builds. */
  quotedMessageId?: string;
  /** Who wrote the quoted message, from the Pi's contact lookup (slice S4,
   *  2026-10-20): UNVERIFIED (their own WhatsApp name) and their phone,
   *  checked against the roster before the name is used. Absent from older
   *  Pi builds, and for a reply to MatchTime. */
  quotedAuthorName?: string;
  quotedAuthorPhone?: string;
  /** Did this message @-mention the bot's own JID? Computed on the Pi
   *  (only it knows the bot's selfId) and forwarded as a structured
   *  signal. PRIMARY input to the @Match Time interaction-contract gate;
   *  `undefined` from older Pi builds is simply not a tag. */
  botMentioned?: boolean;
  /** Set here after the router has run: the router read the message as
   *  spoken TO MatchTime (`RoutedMessage.toBot`), which `messageTagsBot`
   *  counts as a tag (2026-10-30, no word test on the body). */
  routerAddressed?: boolean;
}

/** The message `m` is a WhatsApp reply to, as `loadGroupReplyContexts`
 *  resolved it, as the optional field the router and every owner read. */
function replyField(replies: ReadonlyMap<string, QuotedGroupMessage>, m: InboundMessage): { reply?: QuotedGroupMessage } {
  const reply = replies.get(m.waMessageId);
  return reply ? { reply } : {};
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
}

type ActionForBot = {
  waMessageId: string;
  handledBy: "fast-path" | "llm" | "ignored" | "error" | "deduped";
  intent: string | null;
  react: string | null;
  reply: string | null;
  reasoning?: string;
  /** The key MatchTime's `reply` was claimed under (review of #341,
   *  finding 3): the Pi acks the sent reply with it, so a reply quoting
   *  MatchTime's reply resolves to its words and match. */
  replyKey?: string;
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
  return withAnalyzeBatch(() =>
    withPipelineTrace(async () => {
      try {
        // THE DAILY AI CAP (2026-09-29): every model call this request
        // makes spends from ONE club's budget, named below as soon as the
        // group resolves (`bindAiBudgetKey`). See `lib/ai-budget.ts`.
        return await withDeferredOrgAiBudget(() => handleAnalyzeRequest(request));
      } finally {
        // What the router and each extractor said about every message,
        // onto its `AnalyzedMessage.pipelineTrace`. Once, at the end, so
        // every row is written by now whichever path wrote it. Never
        // throws: see `pipeline/trace.ts`.
        await persistPipelineTraces(writePipelineTrace);
      }
    }),
  );
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

  // A group with no bot-enabled club is ignored below. The legacy in-group
  // setup ("@MatchTime set up") was deleted on 2026-10-30; new clubs join
  // through self-join (lib/group-add.ts).

  // Club fee billing (B1, plan 4.3 point 4): a billing-paused club's batch
  // is ignored here, before any model call, even if a stale Pi forwarded
  // it. `billingQuietWhere()` is empty while BILLING_ENABLED is off.
  const org = await db.organisation.findFirst({
    where: { whatsappGroupId: body.groupId, whatsappBotEnabled: true, ...billingQuietWhere() },
    // `language`: the squad post composed from the rows below speaks
    // the group's language (Phase 2 of the multi-language design).
    // `squadMode` (monthly squad, slice 5): read once here so a club on
    // "weekly" never runs a monthly query below.
    // `listAnnouncer` (2026-10-14): whether the squad may be posted here.
    select: { id: true, name: true, language: true, squadMode: true, listAnnouncer: true },
  });
  if (!org) {
    // A silent group (a club waiting for approval, rejected or suspended,
    // or a group nobody asked MatchTime into) says so, for the Pi's log.
    const { isSilentGroup } = await import("@/lib/club-approval");
    const ignored = (await isSilentGroup(body.groupId)) ? "silent-group" : "unknown-or-disabled-group";
    return NextResponse.json({ ok: true, ignored, results: [] });
  }
  const organisersMode = organisersAnnounce(org);
  bindAiBudgetKey(org.id);

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

  // 1. Dedupe. First within the batch itself (a pure filter: a batch with
  //    no repeated id is the very same array, `uniqueByWaMessageId`), then
  //    against what is already stored. The stored-rows check below is
  //    check-then-act: two separate batches at the same instant can both
  //    pass it. That is not made atomic here.
  const all = uniqueByWaMessageId(body.messages);
  if (all.length !== body.messages.length) {
    console.log(`[analyze] ${body.groupId}: ${body.messages.length - all.length} repeated message id(s) in one batch, each kept once`);
  }
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

  // ── A MESSAGE THAT ARRIVES LATE IS NOT A REQUEST MADE NOW (2026-09-29) ─
  //
  // Sutton FC: an admin's "generate the teams" could not be decrypted and
  // a readable copy arrived 10.5 hours later, after the match, and was
  // answered as if it had just been sent. `lib/late-message.ts` has the
  // rule and its reasons. In this handler it is FOUR touches, and a new
  // path through it must keep all four true:
  //
  //   1. HERE: a late message overtaken by a kickoff is recorded and
  //      removed. Nothing about it is acted on, attendance included.
  //   2. The remaining late messages are HELD OUT of every deterministic
  //      peel below (they are put back before the router), so no fast
  //      path can execute one.
  //   3. `ownerBase` excludes them, so question / balancer / score /
  //      admin_ops never see one. The attendance engine does, and its
  //      writes land; its words, recruit asks, tentative chases, nudges
  //      and squad post do not.
  //   4. Before the response: `silenceLateResult` on every late result
  //      (the backstop: no reply, a registration react at most), and one
  //      `late-message` ops event for the batch. Never a DM.
  //
  // The age is the ORIGINAL WhatsApp timestamp the Pi forwards on every
  // path (flush, tagged flush, restart catch-up, undecryptable recovery).
  const lateNow = new Date();
  let latePlan = planLateMessages({ messages: fresh, now: lateNow, kickoffs: [] });
  if (latePlan.late.size > 0) {
    const earliest = Math.min(...[...latePlan.late.values()].map((l) => l.sentAt.getTime()));
    const kicked = await db.match.findMany({
      where: {
        activity: { orgId: org.id },
        status: { not: "CANCELLED" },
        date: { gt: new Date(earliest), lte: lateNow },
      },
      select: { date: true },
    });
    latePlan = planLateMessages({
      messages: fresh,
      now: lateNow,
      kickoffs: kicked.map((k) => k.date),
    });
  }
  const lateById = latePlan.late;
  const lateEntries: LateEntry[] = [];
  for (let i = fresh.length - 1; i >= 0; i--) {
    const m = fresh[i];
    const late = lateById.get(m.waMessageId);
    if (!late?.kickedOffAt) continue;
    await recordAnalysis({
      orgId: org.id,
      groupId: body.groupId,
      msg: m,
      handledBy: LATE_HANDLED_BY,
      intent: "late_message",
      action: null,
      confidence: 1,
      reasoning:
        `late message: arrived ${formatDelay(late.ageMs)} after it was sent, and a match ` +
        `kicked off at ${late.kickedOffAt.toISOString()} in between; nothing acted on`,
    });
    results.push({ waMessageId: m.waMessageId, handledBy: "ignored", intent: "late_message", react: null, reply: null });
    lateEntries.unshift({
      waMessageId: m.waMessageId,
      authorName: m.authorName,
      body: m.body,
      ageMs: late.ageMs,
      outcome: "match-kicked-off",
      route: undefined,
    });
    fresh.splice(i, 1);
  }

  // ── THE DAILY AI CAP, DECIDED ONCE, UP FRONT (2026-09-29) ─────────
  //
  // At the cap the whole batch runs WITHOUT A MODEL: the router is not
  // asked (the floor routes a bare IN/OUT, everything else is `none`),
  // the attendance engine decides floor-read messages from the floor's
  // own facts, and a message that TAGS MatchTime gets one polite line, at
  // most once per club per day. Everything deterministic (fast paths,
  // scheduled posts) is untouched. Reading the state fails OPEN.
  //
  // The cap can also be reached PART-WAY through this batch (a concurrent
  // flush spent the rest). Every model call is guarded individually, and
  // the router and the attendance extractor fall back to exactly this
  // behaviour when they are refused; see `pipeline/router.ts` and
  // `attendance-engine-batch.ts`.
  const aiBudget = fresh.length > 0 ? await getAiBudgetStatus(org.id) : null;
  const aiCapped = aiBudget?.capped ?? false;
  if (aiCapped) {
    console.log(
      `[analyze] org ${org.id} is at its daily AI cap ($${aiBudget!.spentUsd.toFixed(4)} of ` +
        `$${aiBudget!.capUsd.toFixed(2)}): this batch runs without a model`,
    );
  }

  // 2. Resolve senders + hand the whole fresh batch to Claude in one call.
  const senderById = new Map<string, ResolvedSender>();
  for (const m of fresh) {
    senderById.set(m.waMessageId, await resolveSender(org.id, m));
  }

  // ── WHAT EACH REPLY QUOTES (quoted-reply context, slice S4) ────────
  //
  // A WhatsApp reply carries the message it quotes, whoever wrote it.
  // Resolved ONCE per batch, by the quoted stanza id first (this batch,
  // MatchTime's own sends, the club's analysed messages), then the Pi's
  // text and author; the router and every owner below read the same
  // answer. Total: a failed read keeps what the Pi said. One indexed read
  // per reply, and nothing at all for a batch with no reply in it.
  const replyById = fresh.some((m) => parseGroupQuote(m))
    ? await loadGroupReplyContexts(db, {
        orgId: org.id,
        channel: "group",
        now: new Date(),
        messages: fresh.map((m) => ({ id: m.waMessageId, quote: parseGroupQuote(m) })),
        // A batch message's author is named only when the route resolved
        // them to a member, by their roster name (never their pushname).
        batch: fresh.map((m) => {
          const s = senderById.get(m.waMessageId);
          return { waMessageId: m.waMessageId, userId: s?.userId ?? null, rosterName: s?.userId ? s.name : null, body: m.body, sentAt: parseTimestamp(m.timestamp) };
        }),
        memberByPhone: (phone) => rosterMemberByPhone(org.id, phone),
      })
    : new Map<string, QuotedGroupMessage>();
  // THE MODEL'S VIEW AND THE TAG AGREE (review of #341, finding 2). A
  // quote shown as MatchTime's is a reply to MatchTime, which the
  // interaction contract reads as a tag (`messageTagsBot`, from the Pi's
  // flag). A quote the Pi did not flag, but whose id is one of MatchTime's
  // own sends on this club, is MatchTime's: the flag is set to match, here,
  // before any tag is read.
  for (const m of fresh) {
    const r = replyById.get(m.waMessageId);
    if (r && r.found && r.author === null && m.quotedFromMatchTime !== true) m.quotedFromMatchTime = true;
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

  // LATE MESSAGES SKIP EVERY PEEL (touch 2 of 4, see the late-message
  // block above). Put back, in arrival order, right before the router.
  const lateHeldOut: InboundMessage[] = [];
  for (let i = fresh.length - 1; i >= 0; i--) {
    if (lateById.has(fresh[i].waMessageId)) lateHeldOut.unshift(...fresh.splice(i, 1));
  }

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

  // ── DELETED 2026-09-17: the personal-stats REGEX fast path ─────────
  //   It lived here, was tag-gated and CLAUSE-PEELED, and matched
  //
  //     /\bwrapped\b|\bmy\s+(stats|season|ratings?|performance|form|card)\b/i
  //
  //   then DM'd the sender a 48h magic link to /profile/stats and reacted
  //   📊. It was English only: the Turkish help (Phase 2) advertises
  //   "@Match Time istatistiklerim", and nothing read it. It was also the
  //   last pattern in this file deciding what a message MEANS for a DM,
  //   the class deleted on 2026-09-01, 2026-09-10 and 2026-09-11 (the
  //   tombstones below). `MDs/router-accuracy-2026-09-11.md` measured it
  //   at 0 matches in 143 days and recommended this conversion (§2.5).
  //
  //   The ask is now an extracted FACT, `QuestionFacts.topic =
  //   "my_stats"` on the `question` route (not `admin_ops`, which guards
  //   the mass-DM doors), gated by the engine (the tag, a resolved
  //   sender), reported by `answer-batch.ts` as `statsLinkRequest`, and
  //   PERFORMED by this route in the owner loop by `sendOwnStatsLink`
  //   (`lib/stats-link-request.ts`). The DM, the link, the 📊 react and
  //   the `stats_link` / `dm-stats-link` labels are unchanged; only the
  //   classification moved from regex to model. (2026-09-23: the 📊
  //   react is gone. The group hears a line saying the stats are coming
  //   by DM instead, `buildStatsLinkSentLine`.)
  //
  //   THE RECIPIENT CANNOT MOVE. The flag is a boolean on the asking
  //   message's outcome; the DM goes to that message's resolved sender.
  //   Nothing a model extracts names who receives it
  //   (`e2e/sim/qa.spec.ts` asserts the BotJob's phone).
  //
  //   ── WHAT WENT WITH IT, STATED RATHER THAN DISCOVERED ─────────────
  //
  //   THE CLAUSE PEEL. "@Match Time my stats. Also I'm out" used to DM
  //   the link AND drop the sender. `question` is a whole-message route,
  //   so the OUT is now lost, as it already is for the rating-progress
  //   ask and the stats blast. Observed in 143 days: zero.
  //
  //   NO LONGER BEFORE THE ROUTER. A tagged "my stats" now costs a router
  //   and an extractor call, and is subject to the router's reading
  //   ("@Match Time wrapped" was `none` 3/3 before its worked example
  //   was added to the router prompt).

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

  // ── AN ANSWER TO "WHO SHALL I ASK FOR PLAYERS?" (2026-10-28) ────────
  //   A club with no admin group is asked which place it means in the
  //   players' group (`ask-source.ts`, below in the recruit pass), and the
  //   organiser's answer is found by the safe-YES rule's positional tests
  //   (a reply quoting the question, or the next organiser message within
  //   15 minutes) and read by the shared admin extractor
  //   (`ask-source-group.ts`). Never a phrase match. An answer is this
  //   message's whole job: claimed here, and the places it picks are asked
  //   in the batch-final pass with every other ask, after the batch's
  //   writes. Not at the AI cap (the reading is a model call). One indexed
  //   read for a batch with no question open.
  const sourceAnswerAsks: Array<{ msg: InboundMessage; sender: ResolvedSender; sources: RecruitSource[]; clubRef: string | null }> = [];
  if (!aiCapped && fresh.length > 0) {
    const answers = await groupSourceAnswers({
      orgId: org.id,
      now: new Date(),
      messages: fresh.map((m) => {
        const sender = senderById.get(m.waMessageId);
        return {
          id: m.waMessageId,
          body: m.body,
          authorName: sender?.name ?? m.authorName ?? null,
          senderUserId: sender?.userId ?? null,
          // MatchTime's question in the group is an inline reply, never
          // acked, so its quote is known by its words (`quotedLogRow`).
          quoted:
            m.quotedFromMatchTime || m.quotedBody || m.quotedMessageId
              ? { fromMatchTime: m.quotedFromMatchTime === true, text: m.quotedBody ?? null, messageId: m.quotedMessageId ?? null }
              : null,
          ...replyField(replyById, m),
          tagged: messageTagsBot(m),
        };
      }),
    });
    for (const m of fresh) {
      const a = answers.get(m.waMessageId);
      const sender = senderById.get(m.waMessageId);
      if (!a || !sender) continue;
      await claimFastPath(m, null, {
        handledBy: "fast-path",
        intent: "recruit_source_answer",
        action: `recruit-from:${a.sources.join("+")}`,
        reasoning: `an organiser's answer to "who shall I ask for players?": ${a.sources.join("+")}`,
        react: null,
        reply: null,
      });
      sourceAnswerAsks.push({ msg: m, sender, sources: a.sources, clubRef: a.clubRef });
    }
  }

  // ── AN ORGANISER FOLLOWING UP MATCHTIME (2026-10-28) ────────────────
  //   A pick from MatchTime's own list of places ("@Match Time 2"), or a
  //   tagged "try again" within 15 minutes of the organisers' ask to the
  //   partner clubs or the pool ("@Match Time added the venue location").
  //   Short words the router often sends elsewhere (the paid check routed
  //   both `question`), so they are read here, as an answer to "who shall
  //   I ask?" is just above: the list's record, or the stored ask, then the
  //   shared admin extractor (`group-admin-followups.ts`). Never a phrase
  //   match. A pick sets the pitch now; a "try again" is the stored ask,
  //   made in the batch-final pass with every other ask. Not at the AI cap.
  //   One indexed read and no model call for a batch with neither waiting.
  if (!aiCapped && fresh.length > 0) {
    const followups = await groupAdminFollowups({
      orgId: org.id,
      now: new Date(),
      messages: fresh
        .filter((m) => !fastPathHandledIds.has(m.waMessageId))
        .map((m) => {
          const sender = senderById.get(m.waMessageId);
          return {
            id: m.waMessageId,
            body: m.body,
            authorName: sender?.name ?? m.authorName ?? null,
            senderUserId: sender?.userId ?? null,
            quoted:
              m.quotedFromMatchTime || m.quotedBody || m.quotedMessageId
                ? { fromMatchTime: m.quotedFromMatchTime === true, text: m.quotedBody ?? null, messageId: m.quotedMessageId ?? null }
                : null,
            ...replyField(replyById, m),
            tagged: piMentionsBot(m),
          };
        }),
    });
    for (const m of fresh) {
      const f = followups.get(m.waMessageId);
      const sender = senderById.get(m.waMessageId);
      if (!f || !sender?.userId) continue;
      if (f.kind === "retry") {
        await claimFastPath(m, null, {
          handledBy: "fast-path",
          intent: "retry_ask",
          action: `retry:${f.sources.join("+")}`,
          reasoning: `an organiser's "try again" after the organisers' ask: ${f.sources.join("+")} asked again`,
          react: null,
          reply: null,
        });
        sourceAnswerAsks.push({ msg: m, sender, sources: f.sources, clubRef: f.clubRef });
        continue;
      }
      const r = await setVenueFromWords({ orgId: org.id, userId: sender.userId, words: f.words, choice: f.choice, lang: org.language, now: new Date() });
      if (r.outcome === "venue-which" && f.words) await recordVenueList({ orgId: org.id, words: f.words, text: r.replyText, now: new Date() });
      await claimFastPath(m, null, {
        handledBy: "fast-path",
        intent: r.outcome,
        action: r.set ? "set_venue" : "reply",
        reasoning: `an organiser named the pitch, or picked it from MatchTime's list: ${r.outcome}`,
        react: null,
        reply: r.replyText,
      });
    }
  }

  // ── DELETED 2026-10-30: the "DM me" REGEX fast path ─────────────────
  //   `/\b(dm|pm|message)\s+me\b/i`, clause-peeled, answered the question by
  //   DM. It never fired in production (0 rows since April), and a recruit
  //   post ending "pls message me" was exactly its shape. A tagged question
  //   is the router's `question` route, answered in the group (Kemal,
  //   2026-10-30: no string parsing).

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
  //   `looksLikeRecruitRequest` is GONE (2026-09-11). It outlived this
  //   tombstone by ten days for one caller, api/whatsapp/dm-reply/route.ts
  //   — a 1:1 DM surface with no verdict pipeline — where it could still
  //   fire a mass DM to 13-27 people off a pattern match. That surface is
  //   now model-classified too (`lib/dm-intent.ts`) and the function was
  //   deleted with its last caller.

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

  // ── "@Match Time help [topic]": NO FAST PATH (2026-10-28) ────────────
  //   Help used to be peeled off here by a regex (`readHelpRequest`) before
  //   the model saw it, with the topic read from a list of keywords. It is
  //   now read like every other question: the router sends it to
  //   `question`, the question extractor's `how_it_works` names the topic
  //   ("how do I turn on the player pool?" has no keyword), and
  //   answer-batch.ts attaches `buildHelpReply`'s words for this club. One
  //   path for the players' group, the admin group and DMs (Kemal's rules:
  //   no string parsing, one architecture for every group). Still tagged:
  //   the `question` route needs a tag, as the fast path did.

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

  // ── DELETED 2026-10-30: three regex fast paths and a dead one ───────
  //   "@Match Time clear the teams" (`isClearTeamsRequest`), the colour
  //   swap (`looksLikeColourSwapPhrase`) and "swap A with B"
  //   (`parseSwapNames`) were read here from the raw words before the
  //   router. The two swaps now go through the pipeline: router `balancer`,
  //   the teams extractor's `swap` facts (`swapSides`, `moves`), applied in
  //   `team-ops-engine-batch.ts` by `team-swap-apply.ts`, the same reading
  //   the admin group uses since #468. A clear is the teams extractor's
  //   `clear` action, done there with `team-clear.ts` (admins only).
  //   The bench-prompt answer (`readBenchPromptAnswer`) was dead: nothing
  //   has created a `PendingBenchConfirmation` since the 2026-05-19 bench
  //   redesign (the last row is from that day, none is open).

  // ── 3b. A MONTHLY CLUB'S PASTED LIST (slice 5, 2026-10-06) ──────────
  //
  //   MDs/monthly-squad-plan-2026-10-05.md, section 6.2. A group that
  //   runs on a monthly list changes it by re-pasting it, and section 4
  //   below registers nobody from those pastes on purpose (it needs the
  //   squad restated as an exact prefix, and this group changes slots in
  //   the middle). So for a club on "monthly" with a RUNNING month, a
  //   message the monthly reader (3a-ter, the model) read as a list is
  //   applied here first, reconciled BY NAME and member
  //   (`lib/monthly-paste.ts`).
  //
  //   ONLY for `squadMode === "monthly"`: a weekly club (Sutton FC, and
  //   every club before this) skips the whole block with no query, and
  //   section 4 sees its pastes exactly as before.
  //   `handleMonthlyPaste` returns null when there is no running month for
  //   the match, and "not this list" for another month's list.
  //
  //   WHERE IT SITS, and what that keeps (the terminal-branch bug class):
  //     - after the club lookup, so a muted or billing-paused club never
  //       gets here;
  //     - after the late-message hold-out: a late paste is not in `fresh`
  //       during the peels, so it changes nothing;
  //     - the reading costs one Haiku call per message (3a-ter); at the
  //       daily AI cap the reading is "none" and nothing monthly changes;
  //     - it claims the LIST through `claimFastPath`, not the message:
  //       whatever the member typed around the list ("can't make it
  //       lads") is the residual, and the router and the attendance
  //       engine still see it. A message that was only a list is fully
  //       handled here.
  //
  //   IT SAYS NOTHING. A ✅ on a paste that changed something, nothing on
  //   one that only restates the list. The list itself is posted by the
  //   scheduler, and only when it differs from what the group last saw.
  /** Monthly club, running month: list-shaped messages that are not the
   *  month's squad list. Section 4 registers nobody from them. */
  const monthlyNotSquadList = new Set<string>();
  //
  // ── 3b-bis. THE MONTH'S SIGN-UP (slice 3, 2026-10-06) ────────────────
  //
  //   Plan sections 4.1 and 6.2. Same place, same guards, same club gate
  //   as 3b (`squadMode === "monthly"` only; a weekly club runs none of
  //   it and makes no query), and no model:
  //     - a pasted list that is the list of a month people can still join
  //       ("List for November", pasted in October) is read by name
  //       (`lib/month-signup.ts`). It changes the SENDER'S own line only,
  //       and never creates a player. The week's list (3b) is tried
  //       first: with a week live, a list with no month in its title is
  //       the week's, never the sign-up list;
  //     - "IN FOR NOVEMBER", "OUT FOR NOVEMBER", "PAYG FOR NOVEMBER 9th",
  //       "Kasım varım": the whole message, in a fixed vocabulary. A
  //       plain "IN" is this week's game, exactly as before.
  //   It says nothing in the group: a ✅ on a message that was read.
  const monthSignup = org.squadMode === "monthly" ? await import("@/lib/month-signup") : null;
  //
  // ── 3a-ter. THE MONTHLY READER (2026-10-29) ─────────────────────────
  //
  //   Kemal: no code reads what people mean, the list's own numbering and
  //   headers included, because people never keep to a format. For a club
  //   on "monthly" with a live month, every fresh message is read ONCE by
  //   the monthly reader (`lib/monthly-reader.ts`, one Haiku call): is it
  //   the month's or a week's list (its lines, blanks, can't-play part,
  //   notes such as "4 only", "PAYG 5th only", "(paid £22.50)", guests,
  //   the game it is for), a sign-up in any words ("November good for
  //   me"), or neither. It sees the club's members, its months and games,
  //   the week's list as MatchTime has it, the recent chat (the extractors'
  //   RECENT CHAT, `groupChatHistory`) and the message replied to. The
  //   doors below act only on that reading.
  //
  //   A failed or capped call is "none": nothing changes for the month,
  //   and the message goes on to the router as any other. Section 4 never
  //   registers names from a message the reader looked at.
  const monthlyReadings = new Map<string, MonthlyReading>();
  if (monthSignup) {
    const reader = await import("@/lib/monthly-reader");
    const ctx = await reader
      .loadMonthlyReaderContext({ orgId: org.id, matchId: nextMatchForReply?.id ?? null })
      .catch((err) => {
        console.error(`[analyze] monthly reader context for ${org.id} failed:`, err);
        return null;
      });
    if (ctx) {
      const chat = await groupChatHistory({
        orgId: org.id,
        groupId: body.groupId,
        pi: body.history ?? [],
        batch: all.map((m) => ({
          waMessageId: m.waMessageId,
          authorName: m.authorName,
          timestamp: m.timestamp,
          author: chatAuthorOf(senderById.get(m.waMessageId)),
          body: m.body,
          stored: seenMap.has(m.waMessageId),
        })),
      }).catch(() => []);
      for (const m of fresh) {
        if (fastPathHandledIds.has(m.waMessageId)) continue;
        const sender = senderById.get(m.waMessageId)!;
        // CLAIMED BEFORE THE MODEL IS ASKED (review of #465): a Pi retry of
        // this message, arriving while the first is still being handled,
        // is not read for the month, so a guest is never created twice; it
        // goes on to the rest of the pipeline exactly as a message did before
        // monthly mode (and section 4 registers nobody from it).
        try {
          await db.sentNotification.create({ data: { key: `monthly-read:${org.id}:${m.waMessageId}`, kind: "monthly-read" } });
        } catch (err) {
          if ((err as { code?: unknown })?.code === "P2002") {
            console.log(`[analyze] ${m.waMessageId}: already read for the month (a retry): not read again`);
            monthlyNotSquadList.add(m.waMessageId);
            continue;
          }
          throw err;
        }
        const reading = await reader.readMonthlyMessage(
          {
            body: m.body,
            sender: {
              userId: sender.userId,
              name: sender.name ?? m.authorName ?? null,
              organiser: !!sender.userId && ctx.members.some((x) => x.userId === sender.userId && x.organiser),
            },
            history: chat.filter((h) => !(h.body === m.body && h.author === chatAuthorOf(sender))),
            reply:
              replyById.get(m.waMessageId) ??
              (() => {
                const q = parseGroupQuote(m);
                return q?.text ? quoteFromPi(q) : null;
              })(),
            now: new Date(),
          },
          ctx,
        );
        monthlyReadings.set(m.waMessageId, reading);
      }
    }
  }
  const listReadingOf = (m: InboundMessage) => {
    const r = monthlyReadings.get(m.waMessageId);
    return r?.kind === "list" ? r : null;
  };
  //
  // ── 3b-bis. THE MONTH'S SIGN-UP (slice 3, 2026-10-06) ────────────────
  //
  //   Plan sections 4.1 and 6.2. Same place, same guards, same club gate
  //   as 3b (`squadMode === "monthly"` only; a weekly club runs none of
  //   it and makes no query), acting on the monthly reader's reading:
  //     - a list that is the list of a month people can still join
  //       ("List for November", pasted in October) is applied by name
  //       (`lib/month-signup.ts`). It changes the SENDER'S own line only
  //       (and its "4 only"; an organiser's for anybody), and never creates
  //       a player. With a week live, a list the reader calls a week's is
  //       the week's, never the sign-up list;
  //     - a newcomer adding themselves to a running month's own list in
  //       the middle of the month joins it for the games left;
  //     - a typed sign-up, in any words ("IN FOR NOVEMBER", "November good
  //       for me", "Kasım varım"). A plain "IN" is this week's game.
  //   It says nothing in the group: a ✅ on a message that was read.
  /** Apply `m`'s list reading as a pasted sign-up list. True when it was one (and is claimed). */
  const trySignupPaste = async (
    m: InboundMessage,
    needHeader: boolean,
    mode: { newcomerOnly?: boolean } = {},
  ): Promise<boolean> => {
    const reading = listReadingOf(m);
    if (!monthSignup || !reading) return false;
    const sender = senderById.get(m.waMessageId)!;
    let res: Awaited<ReturnType<typeof monthSignup.handleSignupPaste>> = null;
    try {
      res = await monthSignup.handleSignupPaste({
        orgId: org.id,
        reading,
        waMessageId: m.waMessageId,
        sender: { userId: sender.userId, name: sender.name ?? m.authorName ?? null },
        senderWhatsAppName: m.authorName ?? null,
        needHeader,
        ...mode,
      });
    } catch (err) {
      // Left for the pipeline, as if this block were not here.
      console.error(`[analyze] sign-up paste ${m.waMessageId} failed:`, err);
    }
    if (!res) return false;
    const notes = [
      res.applied.length > 0 ? `applied [${res.applied.join(", ")}]` : "restates the list, nothing changed",
      res.notAdded.length > 0 ? `not added [${res.notAdded.map((i) => `${i.name}: ${i.reason}`).join(", ")}]` : "",
    ].filter(Boolean);
    await claimFastPath(m, res.residual ? { consumed: m.body, residual: res.residual } : null, {
      handledBy: "fast-path",
      intent: "month_signup_list",
      action: res.applied.length > 0 ? `month-signup:${res.applied.length}` : "none",
      reasoning: `month sign-up list, read by the monthly reader: ${notes.join("; ")}`,
      react: res.changed ? "✅" : null,
      reply: null,
    });
    return true;
  };
  // TWO THINGS ARE THE MONTH'S BEFORE THE WEEK'S READER (3b) SEES A PASTE:
  //   - a list the reader calls the MONTH's (who is on the month: its
  //     sign-up list, MatchTime's own month or priced list), while that
  //     month can still be joined. In a month under way it goes on to 3b,
  //     where it can only restate the week and record paid marks (3b never
  //     brings back a player who dropped, and a missing name changes
  //     nothing), unless a newcomer is joining with it (below);
  //   - a list naming a month, pasted by somebody who is NOT on that month,
  //     with their own name on it. They are signing up for the MONTH (a
  //     regular, or PAYG if their line says so, subject to the cap; for the
  //     games left in a month under way), and must not slip onto one game
  //     as a one-off instead.
  if (monthSignup) {
    for (const m of fresh) {
      if (fastPathHandledIds.has(m.waMessageId)) continue;
      const reading = listReadingOf(m);
      if (!reading) continue;
      // An ORGANISER's list for the coming month, before that month is
      // started: the draft goes to him by DM, with where to say YES (agent
      // A's seed flow). Nothing is said in the group.
      if (reading.listOf === "month") {
        const sender = senderById.get(m.waMessageId)!;
        let proposed = false;
        try {
          const { proposeMonthSeedFromGroup } = await import("@/lib/month-seed-group");
          proposed = await proposeMonthSeedFromGroup({ orgId: org.id, reading, waMessageId: m.waMessageId, senderUserId: sender.userId });
        } catch (err) {
          console.error(`[analyze] month seed from ${m.waMessageId} failed:`, err);
        }
        if (proposed) {
          await claimFastPath(m, reading.residual ? { consumed: m.body, residual: reading.residual } : null, {
            handledBy: "fast-path",
            intent: "month_seed_list",
            action: "month-seed:proposed-by-dm",
            reasoning: "an organiser's list for the coming month, read by the monthly reader: the draft went to him by DM",
            react: null,
            reply: null,
          });
          continue;
        }
      }
      // A list the reader calls the month's is read for a month that can
      // still be joined (or joined part-way by a newcomer). Anything else
      // about it, in a month under way, is the week's (3b), paid marks
      // included.
      await trySignupPaste(m, false, reading.listOf === "month" ? {} : { newcomerOnly: true });
    }
  }
  if (org.squadMode === "monthly" && nextMatchForReply) {
    const { handleMonthlyPaste } = await import("@/lib/monthly-paste");
    for (const m of fresh) {
      if (fastPathHandledIds.has(m.waMessageId) || monthlyNotSquadList.has(m.waMessageId)) continue;
      const reading = listReadingOf(m);
      if (!reading) continue;
      const sender = senderById.get(m.waMessageId)!;
      let res: Awaited<ReturnType<typeof handleMonthlyPaste>> = null;
      try {
        const sentAt = new Date(m.timestamp);
        res = await handleMonthlyPaste({
          orgId: org.id,
          matchId: nextMatchForReply.id,
          reading,
          waMessageId: m.waMessageId,
          sentAt: Number.isNaN(sentAt.getTime()) ? undefined : sentAt,
          sender: { userId: sender.userId, name: sender.name ?? m.authorName ?? null },
          senderWhatsAppName: m.authorName ?? null,
        });
      } catch (err) {
        // Left for the pipeline, as if this block were not here.
        console.error(`[analyze] monthly paste ${m.waMessageId} failed:`, err);
      }
      if (!res) continue;
      if ("notThisList" in res) {
        // Not the WEEK's list. It may be the sign-up list of a month people
        // can still join ("List for November", pasted in October): a week
        // is live, so only with that month in its title.
        if (await trySignupPaste(m, true)) continue;
        // A list that is not this month's squad list (next month's).
        // Nothing is read from it here, and section 4 below must not
        // register its lines either.
        monthlyNotSquadList.add(m.waMessageId);
        continue;
      }
      const notes = [
        res.applied.length > 0 ? `applied [${res.applied.join(", ")}]` : "restates the list, nothing changed",
        res.ignored.length > 0 ? `left alone [${res.ignored.map((i) => `${i.name}: ${i.reason}`).join(", ")}]` : "",
        res.notAdded.length > 0 ? `not added [${res.notAdded.map((i) => `${i.name}: ${i.reason}`).join(", ")}]` : "",
        res.failures.length > 0 ? `FAILED for [${res.failures.join(", ")}]` : "",
      ].filter(Boolean);
      await claimFastPath(m, res.residual ? { consumed: m.body, residual: res.residual } : null, {
        handledBy: res.failures.length > 0 ? "error" : "fast-path",
        intent: "monthly_list",
        action: res.applied.length > 0 ? `monthly-list:${res.applied.length}` : "none",
        reasoning: `monthly list, read by the monthly reader: ${notes.join("; ")}`,
        react: res.changed && res.failures.length === 0 ? "✅" : null,
        reply: null,
      });
    }
  }
  if (monthSignup) {
    for (const m of fresh) {
      if (fastPathHandledIds.has(m.waMessageId)) continue;
      // A list no week's list took (no running month for the next match):
      // the sign-up list, with its month in the title or without.
      if (!monthlyNotSquadList.has(m.waMessageId) && (await trySignupPaste(m, false))) continue;
      const reading = monthlyReadings.get(m.waMessageId);
      if (reading?.kind !== "signup") continue;
      const sender = senderById.get(m.waMessageId)!;
      let res: Awaited<ReturnType<typeof monthSignup.handleSignupMessage>> = null;
      try {
        res = await monthSignup.handleSignupMessage({ orgId: org.id, ask: reading, sender: { userId: sender.userId } });
      } catch (err) {
        console.error(`[analyze] month sign-up ${m.waMessageId} failed:`, err);
      }
      if (!res) continue;
      await claimFastPath(m, null, {
        handledBy: "fast-path",
        intent: "month_signup",
        action: res.changed ? `month-signup:${res.outcome}` : "none",
        reasoning: res.locked
          ? `month sign-up (${res.choice}): not changed, the player says they have paid; they are told by DM`
          : `month sign-up (${res.choice}), read by the monthly reader: ${res.changed ? `now ${res.outcome}` : `already ${res.outcome}`}`,
        react: res.locked ? null : "✅",
        reply: null,
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
  if (lateHeldOut.length > 0) {
    const arrival = new Map(all.map((m, i) => [m.waMessageId, i]));
    fresh.push(...lateHeldOut);
    fresh.sort((a, b) => (arrival.get(a.waMessageId) ?? 0) - (arrival.get(b.waMessageId) ?? 0));
  }

  // THE RECENT CHAT, FROM WHAT THE SERVER STORED (Kemal, 2026-10-20). The
  // group's newest stored lines, then this request's own messages, each
  // under the member's roster name; the Pi's buffer (empty after a
  // restart) only fills lines the server never stored. A batch message's
  // line carries the same author label and words the extractor is handed
  // as THE MESSAGE (`chatAuthorOf` below), so every extractor's own-line
  // filter drops it for its sender. `lib/group-chat-history.ts`.
  const senderLabel = (waMessageId: string) => chatAuthorOf(senderById.get(waMessageId));
  const history = await groupChatHistory({
    orgId: org.id,
    groupId: body.groupId,
    pi: body.history ?? [],
    batch: all.map((m) => ({
      waMessageId: m.waMessageId,
      authorName: m.authorName,
      timestamp: m.timestamp,
      author: senderLabel(m.waMessageId),
      body: m.body,
      stored: seenMap.has(m.waMessageId),
    })),
  });

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
  // The "who do you mean?" questions MatchTime has open about a stats
  // question (2026-09-23). One indexed read, and an empty list on almost
  // every batch. The router lets the asker's reply through as an answer
  // and the answer owner reads it against the original question. See
  // the essay at the foot of `pipeline/awaiting-answer.ts`.
  const statsClarifications =
    fresh.length > 0
      ? await loadOpenStatsClarifications(org.id).catch((err) => {
          console.error("[analyze] stats clarification read failed:", err);
          return [];
        })
      : [];
  // THE ANSWERS TO MATCHTIME'S OPEN "WHICH TEAM WON?" AND A TAGGED
  // CORRECTION OF A RECORDED RESULT (2026-10-07). Decided HERE,
  // deterministically, before any model is asked and whether or not one
  // answers, by the one rule every group shares (`scoreRouteOverrides`,
  // `pipeline/load-awaiting-answer.ts`; the organisers' group uses it
  // too). Null on almost every batch.
  const { scoreAnswerIds, scoreCorrectionIds } = await scoreRouteOverrides(
    org.id,
    fresh.map((m) => ({
      id: m.waMessageId,
      body: pipelineBody(m),
      tagged: messageTagsBot(m),
      senderUserId: senderById.get(m.waMessageId)?.userId ?? null,
      // A reply to one of MatchTime's own posts: the match it was about.
      quotedMatchTimeAbout: (() => {
        const q = replyById.get(m.waMessageId);
        return q && !q.author ? q.matchId : null;
      })(),
    })),
    new Date(),
  );
  // THE CLUB'S PARTNER CLUBS, for an owner's or admin's message (cross-club
  // ask, slice S6, 2026-10-21): shown to the router above it, so "@Match
  // Time ask Sutton if anyone can play" reads as an instruction to
  // MatchTime (admin_ops) and reaches the admin extractor. Null, and the
  // turn byte for byte as before, for a club with no active partner.
  const partnerRouter =
    fresh.length > 0
      ? await partnerClubsForRouter(
          org.id,
          fresh.map((m) => senderById.get(m.waMessageId)?.userId ?? null),
        ).catch((err) => {
          console.error("[analyze] partner clubs read failed:", err instanceof Error ? err.message : "failed");
          return null;
        })
      : null;
  const gate =
    fresh.length > 0 && routerIsNeeded()
      ? await gateBatch(
          fresh.map((m) => ({
            waMessageId: m.waMessageId,
            ...(partnerRouter && partnerRouter.organiserIds.has(senderById.get(m.waMessageId)?.userId ?? "")
              ? { partnerClubs: partnerRouter.names }
              : {}),
            // `pipelineBody`, not `m.body`: a message a fast path peeled
            // a clause off is routed on WHAT IS LEFT. Routing the whole
            // body would label the message by the half that has already
            // been dealt with — "swap Elvin with Raihan, and I'm out"
            // routes `balancer`, and the drop is never seen.
            body: pipelineBody(m),
            authorName: m.authorName,
            // A reply: the message it quotes, whoever wrote it, shown above it.
            ...replyField(replyById, m),
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
          {
            awaiting: await loadOpenQuestion(org.id),
            clarifications: statsClarifications,
            // "Which team won?" (2026-10-07): the messages in this batch
            // that answer it, decided here from who sent each one.
            scoreAnswerIds,
            // A tagged correction of a recorded result, by its words.
            scoreCorrectionIds,
            // At the daily AI cap: floor only, no router call.
            capped: aiCapped,
            now: new Date(),
          },
        )
      : null;
  if (gate) traceRouting(gate);
  // The router's own reading of who each message speaks to is a tag from
  // here on (`messageTagsBot`): "MatchTime who runs this club?" with no
  // real @-mention. P1 of the no-string-parsing sweep, 2026-10-30.
  for (const r of gate?.routes ?? []) {
    if (!r.toBot) continue;
    const m = fresh.find((f) => f.waMessageId === r.messageId);
    if (m) m.routerAddressed = true;
  }
  const gatedIds = new Set(gate?.skipped ?? []);

  // ── WHAT THE CAP COST THIS BATCH, AND THE ONE LINE IT MAY SAY ──────
  //
  // Every message the cap left unhandled (routed `none` with source
  // `capped`: the router was not asked and the floor could not read it)
  // is counted on today's `OrgAiUsage` row. If any of them TAGS
  // MatchTime, the first one gets today's one polite line, claimed
  // atomically so two racing flushes cannot both send it. Untagged ones
  // stay silent, as banter always does. `recordCapSkips` also asks for
  // the club admins' once-a-day notice (`ai-cap-notice.ts`); never to
  // the platform owner, never an email.
  const cappedIds = new Set(
    (gate?.routes ?? []).filter((r) => r.source === "capped").map((r) => r.messageId),
  );
  let capReplyMessageId: string | null = null;
  if (cappedIds.size > 0) {
    await recordCapSkips(org.id, cappedIds.size, new Date(), aiBudget?.capUsd ?? null);
    capReplyMessageId = await pickCapReplyMessage(
      fresh
        .filter(
          (m) =>
            cappedIds.has(m.waMessageId) &&
            !fastPathHandledIds.has(m.waMessageId) &&
            !lateById.has(m.waMessageId),
        )
        .map((m) => ({ waMessageId: m.waMessageId, tagged: messageTagsBot(m) })),
      () => claimCapReply(org.id),
    );
  }
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

  // ── A LIST PASTED IN THE PLAYERS' GROUP OF A WEEKLY CLUB (2026-10-30) ─
  //
  //   People never keep to a format (Kemal: "no string parsing at all"), so
  //   the list is read by the model, with the same reader the admin group
  //   uses (`hq-squad-reader.ts`, `place: "players"`): the members by ref,
  //   the squad and the teams as MatchTime has them, the recent chat and the
  //   message replied to. It replaced `parsePastedRoster` and its
  //   numbering and header regexes. A monthly club has its own reader above.
  //
  //   WHO IS READ, on facts: a message the ROUTER flagged as a pasted
  //   squad list (`pasted-list-signal.ts`), in a weekly club with a next
  //   game, from a resolved member, not at the AI cap, not late. One Haiku
  //   call each (about $0.0004), on those messages only.
  //
  //   WHAT A READING MAY DO, checked against the database, never the words:
  //     - only a "squad" reading counts ("teams" and "other" go on as any
  //       message does);
  //     - the list must restate the squad: every CONFIRMED player is on it
  //       as playing, and the squad is not empty (the rule the arithmetic had, "a
  //       restatement with names added"; anything else registers nobody);
  //     - it ADDS only: a listed member or new person who is not already in
  //       the squad or on the bench is registered (the bench part as bench),
  //       a member who DROPPED is never brought back, and nobody is ever
  //       dropped by a list;
  //     - the message stays in the batch, so its sender's own drop still
  //       reaches the attendance engine, and the step-7 owners skip it.
  //   A failed or unreadable reading is "other": nothing changes.
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
  if (org.squadMode !== "monthly" && nextMatchForReply && !aiCapped) {
    // The router's signal, a fact (`pasted-list-signal.ts`): only a message
    // it flagged as a pasted squad list is read.
    const listIds = pastedListIds(fresh, (gate?.routes ?? []) as unknown as RoutedForListSignal[]);
    const listCandidates = fresh.filter((m) => {
      const sender = senderById.get(m.waMessageId);
      return (
        listIds.has(m.waMessageId) &&
        !!sender?.userId &&
        !lateById.has(m.waMessageId) &&
        !clauseResidualById.has(m.waMessageId)
      );
    });
    if (listCandidates.length > 0) {
      const { loadHqSquadReaderContext, readHqSquadMessage } = await import("@/lib/hq-squad-reader");
      const ctx = await loadHqSquadReaderContext({
        orgId: org.id,
        match: await db.match.findUnique({
          where: { id: nextMatchForReply.id },
          select: { id: true, date: true, maxPlayers: true, activityId: true, teamLabels: true },
        }),
        lang: org.language,
      }).catch((err) => {
        console.error(`[analyze] squad reader context for ${org.id} failed:`, err instanceof Error ? err.message : "failed");
        return null;
      });
      for (const m of ctx ? listCandidates : []) {
        const sender = senderById.get(m.waMessageId)!;
        const reading = await readHqSquadMessage(
          {
            body: m.body,
            sender: { userId: sender.userId, name: sender.name ?? null },
            history: history.filter((h) => !(h.body === m.body && h.author === senderLabel(m.waMessageId))),
            reply:
              replyById.get(m.waMessageId) ??
              (() => {
                const q = parseGroupQuote(m);
                return q?.text ? quoteFromPi(q) : null;
              })(),
            now: new Date(),
            place: "players",
          },
          ctx!,
        );
        if (reading.kind !== "squad") continue;
        pastedRosterIds.add(m.waMessageId);
        const rows = await db.attendance.findMany({
          where: { matchId: nextMatchForReply.id },
          select: { userId: true, status: true },
        });
        const statusOf = new Map(rows.map((r) => [r.userId, r.status]));
        const confirmed = rows.filter((r) => r.status === "CONFIRMED").map((r) => r.userId);
        // Playing on the list, not merely on it: a confirmed player put under
        // a bench or "can't play" part is not restated as playing.
        const listed = new Set(reading.lines.flatMap((l) => (l.userId && l.section === "playing" ? [l.userId] : [])));
        const restates = confirmed.length > 0 && confirmed.every((id) => listed.has(id));
        if (!restates) {
          pastedRosterReports.set(m.waMessageId, {
            handledBy: "fast-path",
            action: "none",
            reasoning: `pasted list read by the squad reader; it does not restate the squad (${confirmed.filter((id) => !listed.has(id)).length} confirmed player(s) not on it): nobody registered`,
            react: null,
            reply: null,
          });
          continue;
        }
        const failures: string[] = [];
        const registered: string[] = [];
        for (const line of reading.lines) {
          if (line.userId && statusOf.has(line.userId)) continue; // in, on the bench, or dropped
          const isSender = line.userId === sender.userId;
          try {
            const target = line.userId
              ? { userId: line.userId, name: line.name }
              : await resolveOrProvisionByName(org.id, line.name);
            if (!target) {
              failures.push(line.name);
              continue;
            }
            if (statusOf.has(target.userId)) continue;
            statusOf.set(target.userId, "CONFIRMED");
            await registerAttendance(target.userId, nextMatchForReply.id, {
              ...(line.section === "bench" ? { benchIntent: "explicit" as const } : {}),
              event: {
                cause: "pasted-roster",
                actorKind: isSender ? "player" : "member",
                actorUserId: sender.userId ?? null,
                sourceRef: m.waMessageId,
                note: "added to a pasted list that restates the squad, read by the squad reader",
              },
            });
            registered.push(target.name ?? line.name);
          } catch (err) {
            console.error(`[analyze] pasted list: register failed for ${line.name}:`, err);
            failures.push(line.name);
          }
        }
        // The honest ack: the squad post is composed from the DATABASE after
        // every write in this request, so it shows what actually happened.
        pastedRosterReports.set(m.waMessageId, {
          handledBy: failures.length > 0 ? "error" : "fast-path",
          action: registered.length > 0 ? `register:${registered.length}` : "none",
          reasoning:
            `pasted list read by the squad reader, restating the squad: registered [${registered.join(", ")}]` +
            (failures.length > 0 ? `; FAILED for [${failures.join(", ")}]` : ""),
          react: failures.length > 0 ? null : registered.length > 0 ? "✅" : null,
          reply: registered.length > 0 ? SQUAD_POST_MARKER : null,
        });
      }
    }
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
        where: { orgId: org.id, role: { in: ["OWNER", "ADMIN"] }, ...ORDINARY_MEMBER_WHERE, leftAt: null },
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
          history,
          messages: fresh.map((m) => {
            const s = senderById.get(m.waMessageId)!;
            return {
              waMessageId: m.waMessageId,
              // The RESIDUAL for a clause-peeled message. This is the
              // line that rescues "and I'm out" from a swap message.
              body: pipelineBody(m),
              // The roster name, as on this message's RECENT CHAT line.
              authorName: senderLabel(m.waMessageId),
              senderUserId: s.userId,
              senderName: s.name,
              senderIsAdmin: !!s.userId && engineAdminIds.has(s.userId),
              // The ORIGINAL send time, for a rolling-squad club's late
              // drop-out (2026-09-30): lateness is judged by when the
              // player sent it, not when it reached us. Unreadable
              // timestamps are left out and mean "now".
              ...(() => {
                const sentAt = parseTimestamp(m.timestamp);
                return sentAt ? { sentAt } : {};
              })(),
              // NOT from the residual. The tag is a property of what the
              // sender WROTE, and peeling the clause that carried
              // "@Match Time" must not be able to change what the
              // interaction contract permits — in either direction.
              tagged: messageTagsBot(m),
              // The STRICT tag (the Pi's mention list, or the "@Match Time"
              // it writes for one; never a swipe-reply): a recruit side
              // request DMs players only with it or an attendance change
              // in the same message (2026-10-22).
              taggedExplicitly: piMentionsBot(m),
              route: gateRouteById.get(m.waMessageId),
              gated: gatedIds.has(m.waMessageId),
              // A WhatsApp reply: which message it quotes (S0). Read by
              // the engine only where a quoted post decides the target.
              ...(() => {
                const quoted = quotedRefOf(m);
                return quoted ? { quoted } : {};
              })(),
              // The message it quotes, for the extractor (slice S4).
              ...replyField(replyById, m),
            };
          }),
          deps: {
            // At the daily AI cap a bare IN/OUT is decided from the
            // floor's facts, with no extractor call.
            aiCapped,
            registerAttendance,
            cancelAttendance,
            // A reply to a partner club's ask (cross-club ask, S3): the one
            // writer onto another club's match.
            partnerVolunteer: (w) => handlePartnerVolunteer(w),
            // D5b (S5b): the one "FNF or ours?" per sender per ask, sent to
            // him by DM (2026-10-21) so the partner group hears nothing.
            claimPartnerAskWhich: ({ askId, userId }) => askPartnerWhichByDm({ askId, userId }),
            // D5b, revised 2026-10-22: his plain IN counted for his own
            // game; then one DM asking whether he meant the partner's.
            askPartnerAfterOwnIn: (a) => askPartnerAfterOwnInByDm(a),
            resolveOrProvision: (name) => resolveOrProvisionByName(org.id, name),
            // THE SLOT A REPLACEMENT INHERITS (2026-09-15). ONE row
            // updated IN PLACE — `load-state.ts` reads the sheet in
            // `id: asc` so the re-post renders the players in the order
            // the balancer wrote them, and a delete-and-create would put
            // the replacement at the bottom instead of in the spot they
            // took. `@@unique([matchId, userId])` is what the composite
            // where clause names.
            //
            // UNDER THE PER-MATCH SLOT LOCK, and re-checked there
            // (2026-09-29). The engine decided this move from a snapshot
            // taken at the start of the request; a bench claim or another
            // batch may have seated somebody in that slot since. A move
            // that is no longer true is refused, the sheet is healed with
            // whatever slot really is free, and the refusal is thrown so
            // `attendance-engine-batch.ts` reports it as a degradation.
            // See `lib/team-slot-fill.ts`.
            moveTeamSlot: async (matchId, fromUserId, toUserId) => {
              const res = await db.$transaction((tx) =>
                moveNamedSlot(tx, matchId, fromUserId, toUserId),
              );
              if (res.kind === "refused") {
                const healed = res.healed.map((m) => `${m.fromUserId}->${m.toUserId}`).join(", ");
                throw new Error(
                  `slot move refused (${res.reason}); sheet healed with [${healed || "nothing"}]`,
                );
              }
            },
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

  // ── The organisers announce: what they are told instead (2026-10-14) ──
  //   A slot opening in a club whose organisers announce the list is not
  //   said in the players' group (compose.ts); the line goes to the
  //   club's admin channel here, the same door the organisers' squad
  //   updates use. Empty for every other club.
  for (const text of engineBatch?.adminNotices ?? []) {
    await sendAdminNotice({ orgId: org.id, text }).catch((err) =>
      console.error("[analyze] organisers' slot notice not queued:", err instanceof Error ? err.message : "failed"),
    );
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
      (m) =>
        !pastedRosterIds.has(m.waMessageId) &&
        !clauseResidualById.has(m.waMessageId) &&
        // A late message executes nothing but attendance (touch 3 of 4).
        !lateById.has(m.waMessageId),
    )
    .map((m) => {
      const s = senderById.get(m.waMessageId)!;
      return {
        waMessageId: m.waMessageId,
        body: m.body,
        authorName: senderLabel(m.waMessageId),
        senderUserId: s.userId,
        senderName: s.name,
        tagged: messageTagsBot(m),
        // For an ANSWER only: a tag, or the router's own to_bot reading
        // (review of #476). Actions read `tagged`, which is facts only.
        addressed: messageAddressesBot(m),
        // The Pi's real mention flag, read by the bulk-DM commands and a
        // score answer that is not a reply.
        taggedExplicitly: piMentionsBot(m),
        // A WhatsApp reply to MatchTime's own post addresses it (the
        // quoted id, a fact the Pi computes): a swipe-replied swap counts.
        repliesToMatchTime: m.quotedFromMatchTime === true,
        route: gateRouteById.get(m.waMessageId),
        gated: gatedIds.has(m.waMessageId),
        // A reply: the message it quotes, whoever wrote it, for every
        // owner's extractor (slice S4).
        ...replyField(replyById, m),
        // The quoted post's id, for the engine: a reply to a partner
        // club's ask never recruits for this club's own match (2026-10-22).
        ...(() => {
          const quoted = quotedRefOf(m);
          return quoted ? { quoted } : {};
        })(),
      };
    });
  const ownerHistory = history;
  const now = new Date();

  // The step-7 routes live for this request. The test-only per-request
  // header still works (it is inert unless MT_TEST_MODE is "1"), which
  // is what lets a live A/B move one route at a time without a deploy.
  const stepSevenEnabled = enabledStepSevenRoutes(
    process.env,
    routesHeaderOverride(request.headers.get(STEP_SEVEN_HEADER)),
  );

  // A CHANGE THAT ALSO ASKS MATCHTIME SOMETHING (#392 follow-up, Kemal
  // 2026-10-24): "@Match Time I'm out, what's the list?". The engine owns
  // the message and has made the change; the question answering below reads
  // its question under a standalone question's gates, from the state after
  // that change, and the engine's reply carries the answer
  // (`also-asks-reply.ts`). Never in a club whose organisers announce the
  // list: those clubs hear exactly what they did before.
  const alsoAsksIds = new Set(
    organisersMode
      ? []
      : [...(engineBatch?.outcomes.values() ?? [])].filter((o) => o.alsoAsksQuestion).map((o) => o.waMessageId),
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
          clarifications: statsClarifications,
          ...(alsoAsksIds.size > 0 ? { alsoAsks: alsoAsksIds } : {}),
          // The help's pool answer reads the switch as this request does,
          // only when a help question is answered.
          poolEnv: () => poolEnvForApiRequest(request),
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
          // The team half of a message the attendance engine owns
          // ("swap X with Y, and I'm out"): the engine's signal, a fact.
          alsoTeams: new Set(
            [...alsoTeamsIds(fresh, engineBatch?.outcomes.values() ?? [])].filter((id) => engineOwnedIds.has(id)),
          ),
        })
      : null;

  // A question inside an attendance message that went unanswered is logged,
  // never put on the operator note: that message is the engine's, and its
  // note reads as it did before (`silentDiscard`, `reasonFor`).
  const isAlsoAsksLine = (d: string) => [...alsoAsksIds].some((id) => d.includes(id));
  for (const d of (answerBatch?.degradations ?? []).filter(isAlsoAsksLine)) console.warn(`[analyze] also asks: ${d}`);
  const ownerDegradations = [
    ...(answerBatch?.degradations ?? []).filter((d) => !isAlsoAsksLine(d)),
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

  /** Replies that are ALREADY a team sheet composed from the database —
   *  the 2026-09-15 replacement post. Excluded from the §10 step 4
   *  composition pass below; see `EngineMessageOutcome.deterministicTeamPost`. */
  const deterministicTeamPostIds = new Set<string>();

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
    /** From the attendance path's bare "recruit" side request (L10: its
     *  source is read before any blast, `recruit-source.ts`). */
    fromAttendance?: boolean;
    /** The words named no place to find players (2026-10-28): the
     *  organiser is asked which, when the club has more than its own. */
    sourceUnsaid?: boolean;
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

  // ── AND AN ASK TO THE PARTNER CLUBS (slice S6, 2026-10-21) ──────────
  //   "@Match Time ask Sutton if anyone can play": decided by the engine
  //   (an admin, tagged), performed in the same batch-final pass after
  //   every write, so the places it asks for count this batch's drops.
  //   It DMs nobody: `askPartnersFromWords` asks each partner through
  //   `requestPartnerAsk`, the match page button's own door.
  const partnerAskRequests: Array<{ msg: InboundMessage; sender: ResolvedSender; clubRef: string | null; matchId: string | null }> = [];
  const poolRequests: Array<{ msg: InboundMessage; userId: string; matchId: string | null }> = [];
  // The places an organiser's answer to "who shall I ask?" picked (the
  // early pass above): asked here with every other ask, partners before the
  // pool so the pool joins their round.
  for (const a of sourceAnswerAsks) {
    if (a.sources.includes("club")) recruitRequests.push({ msg: a.msg, sender: a.sender, lookbackMatches: null });
    if (a.sources.includes("partners")) partnerAskRequests.push({ msg: a.msg, sender: a.sender, clubRef: a.clubRef, matchId: null });
    if (a.sources.includes("pool") && a.sender.userId) poolRequests.push({ msg: a.msg, userId: a.sender.userId, matchId: null });
  }

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

  // The last message whose attendance the engine CHANGED and that is not
  // late: where the batch's squad post goes when the engine's own choice
  // was a late message (a late write is silent, see below).
  let lastFreshActedId: string | null = null;
  // The answers to a change's own question that the squad pass must not
  // touch (a stats table, help, a team post), added after it.
  const alsoAnswerAfterComposition = new Map<string, string>();

  for (const msg of fresh) {
    const sender = senderById.get(msg.waMessageId)!;
    // Touch 3 of 4 (see the late-message block at the top): a late
    // message's attendance is written by the engine, and nothing it would
    // SAY or TRIGGER happens.
    const late = lateById.get(msg.waMessageId) ?? null;
    const lateNote = late
      ? `; late message (arrived ${formatDelay(late.ageMs)} after it was sent): recorded silently`
      : "";

    // ── §10 STEP 6 — THE ATTENDANCE ENGINE DECIDED THIS MESSAGE ──────
    //
    // The extractor read it, the engine decided it, `attendance.ts`
    // wrote it and the composer said it. Unchanged by step 8 except
    // that there is no longer anything below it to skip.
    const engineOutcome = engineBatch?.outcomes.get(msg.waMessageId);
    if (engineOutcome) {
      if (late) {
        lateEntries.push({
          waMessageId: msg.waMessageId,
          authorName: sender.name ?? msg.authorName,
          body: msg.body,
          ageMs: late.ageMs,
          outcome: engineOutcome.action !== "none" ? "attendance-recorded" : "attendance-unchanged",
          route: engineOutcome.route,
        });
      } else if (engineOutcome.action !== "none") {
        lastFreshActedId = msg.waMessageId;
      }
      // A recruit blast is a mass DM: never for a late message.
      if (engineOutcome.recruitRequest && !late) {
        recruitRequests.push({ msg, sender, lookbackMatches: null, fromAttendance: true });
      }
      // The tentative follow-up is a DM 24 hours on: never for a late one.
      if (engineBatch?.matchId && nextMatchForReply && !late) {
        // conditional_in flavour (b) — personal uncertainty. The engine
        // declines the write; the 24h chase is a shipped product
        // behaviour and step 6 must not lose it. Best-effort. Since
        // 2026-09-30 the list also carries members an ADMIN reported as
        // a maybe ("@Sait is a maybe, remind him"): the same row, the
        // same chase.
        for (const userId of engineOutcome.recordTentativeForUserIds) {
          await recordTentative({
            matchId: engineBatch.matchId,
            userId,
            kickoff: nextMatchForReply.date,
          }).catch((err) => console.error("[analyze] engine recordTentative failed:", err));
        }
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
        lang: org.language,
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
          reasoning: (attendanceFailureLog(engineOutcome.failures) + lateNote).slice(0, 2000),
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
        engineReply = enforceProximity(engineReply, nextMatchForReply.date, org.language);
      }
      // Not for a late message: it would claim the once-per-match nudge
      // slot for a reply that is never sent.
      const engineNudge = late
        ? { applies: false, reply: null }
        : await unresolvedSenderNudge({
            senderResolved: !!sender.userId,
            attendanceRelevant: engineOutcome.action !== "none",
            matchId: nextMatchForReply?.id ?? null,
            authorName: msg.authorName,
            dropping: engineOutcome.intent === "out",
            lang: org.language,
          });
      if (engineNudge.applies) engineReply = engineNudge.reply;
      // The question it also asked, answered after the change: one reply.
      const alsoAnswer = late ? undefined : answerBatch?.alsoAnswered.get(msg.waMessageId);
      if (alsoAnswer?.reply) {
        const joined = joinAlsoAnswered(
          engineReply,
          {
            reply: nextMatchForReply ? enforceProximity(alsoAnswer.reply, nextMatchForReply.date, org.language) : alsoAnswer.reply,
            intent: alsoAnswer.intent,
          },
          org.language,
        );
        engineReply = joined.reply;
        if (joined.afterComposition) alsoAnswerAfterComposition.set(msg.waMessageId, joined.afterComposition);
        console.log(`[analyze] ${msg.waMessageId}: also asks MatchTime: answered (${alsoAnswer.intent})`);
      } else if (alsoAsksIds.has(msg.waMessageId)) {
        console.log(`[analyze] ${msg.waMessageId}: also asks MatchTime: nothing answered`);
      }

      await recordAnalysis({
        orgId: org.id,
        groupId: body.groupId,
        msg,
        handledBy: ENGINE_HANDLED_BY,
        intent: engineOutcome.intent,
        action: engineOutcome.action,
        confidence: 1,
        reasoning:
          engineOutcome.reasoning +
          lateNote +
          (alsoAnswer?.reply ? `; also asks: ${alsoAnswer.reasoning}` : ""),
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
      //
      // A LATE message is not pushed: it is silent on purpose, and it is
      // reported on its own `late-message` event instead.
      if (!late) ownedByEngine.push({
        waMessageId: msg.waMessageId,
        body: msg.body,
        authorName: msg.authorName,
        route: engineOutcome.route,
        disposition: engineOutcome.disposition,
        spoke: engineReply !== null || ack.react !== null,
        senderResolved: !!sender.userId,
        claimCount: engineOutcome.claimCount,
        sideRequestCount: engineOutcome.sideRequestCount,
        // 2026-10-29: an organiser's tagged message that ended as noise is
        // noted even with a side request (`silentDiscard`).
        taggedByOrganiser: !!sender.userId && engineAdminIds.has(sender.userId) && piMentionsBot(msg),
        intent: engineOutcome.intent,
        // Prose, for the bullet only. The engine writes this same string
        // to `AnalyzedMessage.reasoning`, so the DM and the admin log
        // say the same thing, and neither of them decides anything.
        why: engineOutcome.reasoning,
      });
      // AN ALREADY-COMPOSED TEAM SHEET (2026-09-15). The §10 step 4 pass
      // below replaces anything `displaysSquadState` recognises, and two
      // numbered lists under two headings is rule (a) — so without this
      // the replacement post loses its lead ("Wasim is out — Shahrokh
      // takes his place") and its regenerate footer, and the group is
      // told the line-ups again with no word about the swap. Same
      // exclusion that pass already makes for the two team intents; see
      // `EngineMessageOutcome.deterministicTeamPost`.
      if (engineOutcome.deterministicTeamPost && !late) {
        deterministicTeamPostIds.add(msg.waMessageId);
      }
      const engineResult: ActionForBot = {
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
      };
      // Late: the registration react stays (it was counted), the words go.
      results.push(late ? silenceLateResult(engineResult) : engineResult);
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
          sourceUnsaid: adminOutcome.recruitSourceUnsaid === true,
        });
      }
      // An admin's stats blast, deferred the same way. The engine has
      // already applied both gates (admin, and an explicit @-mention);
      // nothing here re-decides, it only defers.
      if (adminOutcome?.statsBlastRequest) {
        statsBlastRequests.push({ msg });
      }
      if (adminOutcome?.partnerAskRequest) {
        partnerAskRequests.push({ msg, sender, ...adminOutcome.partnerAskRequest });
      }
      // An admin's tagged ask for the MatchTime player pool (L10), deferred
      // the same way; the engine applied both gates.
      if (adminOutcome?.poolAskRequest && sender.userId) {
        poolRequests.push({ msg, userId: sender.userId, ...adminOutcome.poolAskRequest });
      }
      // The asker's own stats link (2026-09-17, `QuestionTopic.my_stats`).
      // The engine has applied the tag and resolved-sender gates; this
      // performs it, for the SENDER of this message and nobody else.
      // `answerBatch` is the only owner that can report it.
      const answerOutcome = answerBatch?.outcomes.get(msg.waMessageId);
      let statsLinkFailed: string | null = null;
      // The group's line for a queued stats-link DM (2026-09-23; it was
      // a bare 📊 react). Null unless the DM was actually queued.
      let statsLinkLine: string | null = null;
      if (answerOutcome?.statsLinkRequest) {
        const { sendOwnStatsLink } = await import("@/lib/stats-link-request");
        const sent = await sendOwnStatsLink({
          sender: { userId: sender.userId, name: sender.name, phone: sender.phone },
          authorPhone: msg.authorPhone ?? null,
          // The group's org language (the sender asked in that group).
          lang: org.language,
          deps: {
            linkFor: async (userId) =>
              buildShortMagicLinkUrl(
                signMagicLinkToken({
                  userId,
                  purpose: "sign-in",
                  nextPath: "/profile/stats",
                  ttlSeconds: MAGIC_LINK_TTL.actionNudge,
                }),
              ),
            queueDm: async ({ phone, text }) => {
              await db.botJob.create({ data: { orgId: org.id, kind: "dm", phone, text, ...REPLY_PRIORITY } });
            },
          },
        });
        if (!sent.queued) {
          console.error(`[analyze] my-stats DM not queued for ${msg.waMessageId}: ${sent.reason}`);
          statsLinkFailed = sent.reason;
        }
        statsLinkLine = sent.groupLine;
      }
      // A write that threw says nothing at all (§3.2 S7, the 2026-05-15
      // Erdal incident). The runner has already blanked the reply; this
      // only labels the row so the failure is one query away rather than
      // one log line away.
      const writeFailed = "writeFailed" in stepSeven && stepSeven.writeFailed;
      // A swap's reply IS the team sheet it wrote (2026-10-30): never
      // recomposed into the squad post below.
      if (teamOpsBatch?.outcomes.get(msg.waMessageId)?.teamSheetPost) deterministicTeamPostIds.add(msg.waMessageId);
      let reply = stepSeven.reply;
      if (reply && nextMatchForReply) {
        reply = enforceProximity(reply, nextMatchForReply.date, org.language);
      }
      // A stats-link ask composes no reply of its own, so this is the
      // whole of what the group hears for it. When the DM was not queued
      // the line is null and the group hears nothing, as before.
      if (answerOutcome?.statsLinkRequest) reply = statsLinkLine;
      await recordAnalysis({
        orgId: org.id,
        groupId: body.groupId,
        msg,
        handledBy: writeFailed ? "error" : ownerOf.get(msg.waMessageId) ?? "llm",
        intent: stepSeven.intent,
        // A stats link that was not queued is not reported as sent, and
        // its group line is withheld (`statsLinkLine` is null then).
        action: statsLinkFailed ? "none" : stepSeven.action,
        confidence: 1,
        reasoning: statsLinkFailed
          ? `${stepSeven.reasoning}; ${statsLinkFailed}`
          : stepSeven.reasoning,
        authorUserId: sender.userId,
        authorName: msg.authorName ?? null,
      });
      results.push({
        waMessageId: msg.waMessageId,
        handledBy: writeFailed ? "error" : "llm",
        intent: stepSeven.intent,
        react: writeFailed || statsLinkFailed ? null : stepSeven.react,
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
    // ── AT THE DAILY AI CAP: THE ONE POLITE LINE, OR SILENCE ─────────
    //
    // Not an operator note: nothing went wrong, the club spent its
    // allowance. The row says so, and today's usage row counts it.
    // ── A LATE MESSAGE NOBODY OWNED: NOT EXECUTED, NOT PAGED ─────────
    //
    // Every late message on a non-attendance route lands here, because
    // `ownerBase` never showed it to the four step-7 owners. It is not
    // an operator note (nothing went wrong) and not a cap reply (it gets
    // no words at all): one row, and a line on the batch's `late-message`
    // event.
    if (late) {
      const route = gateRouteById.get(msg.waMessageId);
      await recordAnalysis({
        orgId: org.id,
        groupId: body.groupId,
        msg,
        handledBy: LATE_HANDLED_BY,
        intent: "late_message",
        action: null,
        confidence: 1,
        reasoning:
          `late message: arrived ${formatDelay(late.ageMs)} after it was sent; ` +
          `route=${route ?? "(none returned)"} not executed, no reply`,
        authorUserId: sender.userId,
        authorName: msg.authorName ?? null,
      });
      results.push({
        waMessageId: msg.waMessageId,
        handledBy: "ignored",
        intent: "late_message",
        react: null,
        reply: null,
      });
      lateEntries.push({
        waMessageId: msg.waMessageId,
        authorName: sender.name ?? msg.authorName,
        body: msg.body,
        ageMs: late.ageMs,
        outcome: "not-executed",
        route,
      });
      continue;
    }
    if (cappedIds.has(msg.waMessageId)) {
      const capReply =
        capReplyMessageId === msg.waMessageId ? strings(org.language).ai_daily_cap_reached() : null;
      await recordAnalysis({
        orgId: org.id,
        groupId: body.groupId,
        msg,
        handledBy: AI_CAP_HANDLED_BY,
        intent: "noise",
        action: capReply ? "ai-cap-reply" : null,
        confidence: 1,
        reasoning: capReply
          ? "the club is at its daily AI cap; today's one polite line"
          : "the club is at its daily AI cap; not handled",
        authorUserId: sender.userId,
        authorName: msg.authorName ?? null,
      });
      results.push({
        waMessageId: msg.waMessageId,
        handledBy: capReply ? "fast-path" : "ignored",
        intent: "noise",
        react: null,
        reply: capReply,
      });
      continue;
    }
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
  //   ⚠️ SINCE 2026-09-28 THE NOTE IS RECORDED, NOT SENT: it is an
  //   `OpsAlert` event on the owner's /admin/health page and nobody's
  //   phone buzzes. The paragraph below describes the selection, which
  //   is unchanged.
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
          // RECORDED, NOT SENT (2026-09-28). This used to DM every
          // admin of the club, deduped to one an hour. The owner never
          // read them and they buried the messages he does need, so the
          // note now lands on /admin/health and nowhere else. Deduped on
          // the set of message ids, so a re-posted batch records once.
          const n = note.noteIds.length;
          await recordOpsEvent({
            orgId: org.id,
            kind: OPERATOR_NOTE_KIND,
            severity: "warning",
            title: `${n} message${n === 1 ? "" : "s"} ${OPERATOR_NOTE_MARKER} ${n === 1 ? "it" : "them"}`,
            detail: note.text,
            dedupeKey: note.dedupeKey,
          });
        }
      }
    } catch (err) {
      console.error("[analyze] failed to record the operator note:", err);
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
  // A LATE message never carries it (touch 3 of 4). When the engine's
  // choice is a late one, the post goes to the last fresh message whose
  // attendance changed; with none, a batch whose only change was late
  // says nothing, which is the rule.
  const squadPostId =
    engineBatch?.squadPostForMessageId && lateById.has(engineBatch.squadPostForMessageId)
      ? lastFreshActedId
      : (engineBatch?.squadPostForMessageId ?? null);
  // The organisers announce the list (2026-10-14): no batch squad post.
  if (squadPostId && !organisersMode) {
    const speaks = results.filter(
      (r) => (r.reply ?? "").length > 0 && !lateById.has(r.waMessageId),
    );
    const target =
      speaks.length > 0
        ? speaks[speaks.length - 1]
        : results.find((r) => r.waMessageId === squadPostId);
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
        // The two team posts, and since 2026-09-23 every stats answer: a
        // leaderboard is a numbered list of players, which this pass
        // would otherwise replace with the squad. See
        // `STATS_ANSWER_INTENTS` in `group-copy.ts`.
        if (skipsSquadComposition(r.intent)) continue;
        // The 2026-09-15 replacement post — a team sheet with a lead this
        // pass would strip. Excluded on the same argument as the two
        // intents above, on a flag because the message's own intent is
        // still the attendance one that caused it.
        if (deterministicTeamPostIds.has(r.waMessageId)) continue;
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
        // ── THE TEAM SHEET, WHEN THERE IS ONE (2026-09-15) ──────────
        //
        // With the line-ups out, the composed post IS the line-ups. The
        // owner, after the fourteen-name roster went out twice an hour
        // after they were announced: "There is no point listing all the
        // 14 players after the teams were announced."
        //
        // `id: asc` for the same reason `pipeline/load-state.ts` gives:
        // insertion order is the order the balancer wrote them, and
        // Postgres heap order changes after an UPDATE — i.e. after
        // exactly the slot move this change introduces.
        const sheetMatch = await db.match.findUnique({
          where: { id: nextMatchForReply.id },
          select: {
            date: true,
            teamLabels: true,
            activity: {
              select: {
                venue: true,
                org: { select: { teamLabels: true } },
                sport: { select: { teamLabels: true, name: true, playersPerTeam: true } },
              },
            },
            teamAssignments: {
              select: { userId: true, team: true, user: { select: { name: true } } },
              orderBy: { id: "asc" },
            },
          },
        });
        const sheetRows = sheetMatch?.teamAssignments ?? [];
        // THIS WEEK'S MATCH, WHEN IT IS CANCELLED (2026-10-23, FNF): the
        // post names its match and leads with the cancellation, exactly as
        // the pipeline's composer does from `SquadState.cancelledMatch`.
        // Only the rows the window can reach (`cancelled-match-notice.ts`).
        const replyNow = new Date();
        const nearby = await db.match.findMany({
          where: {
            activity: { orgId: org.id },
            date: {
              gte: new Date(replyNow.getTime() - CANCELLED_NOTICE_LOOKBACK_MS - SAME_FIXTURE_MS),
              lte: nextMatchForReply.date,
            },
          },
          select: { id: true, date: true, status: true },
        });
        const cancelledThisWeek = cancelledMatchToMention(
          nearby,
          { id: nextMatchForReply.id, date: nextMatchForReply.date },
          replyNow,
        );
        const teamLabels = sheetMatch
          ? resolveTeamLabels(
              { teamLabels: sheetMatch.teamLabels },
              sheetMatch.activity.org,
              sheetMatch.activity.sport,
            )
          : ["Red", "Yellow"];
        // The printed line per player (player-display-name.ts): the best
        // name MatchTime holds, the group's own word for "unnamed", and a
        // partner guest's club (MT Test, 2026-10-22). `confirmed`/`bench`
        // stay the plain names: the claim checks match on those.
        const shownNames = await loadPlayerNames(
          org.id,
          [...finalAtt.map((a) => a.userId), ...(sheetMatch?.teamAssignments ?? []).map((t) => t.userId)],
          org.language,
        );
        const plainName = (userId: string, raw: string | null) =>
          shownNames.get(userId)?.name ?? raw ?? strings(org.language).unnamed;
        const shownName = (userId: string, raw: string | null) =>
          shownNames.get(userId)?.display ?? raw ?? strings(org.language).unnamed;
        const confirmedAtt = finalAtt.filter((a) => a.status === "CONFIRMED");
        const benchAtt = finalAtt.filter((a) => a.status === "BENCH");
        const truth: SquadTruth = {
          confirmed: confirmedAtt.map((a) => plainName(a.userId, a.user.name)),
          bench: benchAtt.map((a) => plainName(a.userId, a.user.name)),
          confirmedDisplay: confirmedAtt.map((a) => shownName(a.userId, a.user.name)),
          benchDisplay: benchAtt.map((a) => shownName(a.userId, a.user.name)),
          maxPlayers: nextMatchForReply.maxPlayers,
          matchLabel: dayCommaTimeLabel(org.language, nextMatchForReply.date),
          cancelledDayLabel: cancelledThisWeek ? dayLabel(org.language, cancelledThisWeek.date) : null,
          knownNames: memberships
            .map((m) => m.user.name)
            .filter((n): n is string => !!n),
          teams:
            sheetMatch && sheetRows.length > 0
              ? {
                  // A holder who is out is an open slot, never a name
                  // (2026-09-29). See `teamSheetNames`.
                  ...teamSheetNames(
                    sheetRows.map((r) => ({ userId: r.userId, team: r.team, name: shownName(r.userId, r.user.name) })),
                    new Set(finalAtt.filter((a) => a.status === "CONFIRMED").map((a) => a.userId)),
                    org.language,
                  ),
                  labels: [teamLabels[0], teamLabels[1]],
                  kickoff: kickoffLabel(org.language, sheetMatch.date),
                  venue: sheetMatch.activity.venue,
                }
              : null,
        };
        // MONTHLY SQUAD (slice 5, 2026-10-06): for a club on "monthly"
        // whose match belongs to a running month, the squad IS the
        // month's list. A reply that would carry the weekly-shaped squad
        // post carries that list instead, in the group's own format
        // (`currentWeekListPost`; null once the teams are out, when the
        // team sheet above is the answer). The TRIGGER is unchanged: the
        // same replies are recognised by `composeSquadStateReply`, and a
        // lead it keeps is kept. A weekly club makes no query here.
        const monthlyList =
          org.squadMode === "monthly" && sheetRows.length === 0
            ? await (await import("@/lib/monthly-week")).currentWeekListPost(nextMatchForReply.id).catch(() => null)
            : null;
        const weeklyPost = monthlyList ? composeSquadStateReply(SQUAD_POST_MARKER, truth, org.language).text : null;
        const composedIdx: number[] = [];
        for (const i of candidates) {
          const out = composeSquadStateReply(results[i].reply!, truth, org.language);
          if (!out.composed) continue;
          let text = out.text;
          if (monthlyList && weeklyPost) {
            if (text === weeklyPost) text = monthlyList.text;
            else if (text.endsWith(`\n\n${weeklyPost}`)) text = `${text.slice(0, -weeklyPost.length)}${monthlyList.text}`;
          }
          results[i].reply = text;
          composedIdx.push(i);
        }
        // The group is about to see this list, so the scheduler must not
        // post the same one again (and its 30-minute floor counts from now).
        if (monthlyList && composedIdx.length > 0) {
          await (await import("@/lib/monthly-week"))
            .recordWeekListShown(nextMatchForReply.id, monthlyList.hash, "group-message")
            .catch((err) => console.error("[analyze] could not record the monthly list as shown:", err));
        }
        // The group is about to see the squad, so the scheduler must not
        // list the same one again inside three hours (2026-10-06, Sutton
        // FC: this reply at 07:28, then the same thirteen names from the
        // morning chase at 08:00). The scheduler's only memory is the
        // rows in `SentNotification`, and this reply used to leave none.
        // Only for the roster itself: the team sheet and a monthly club's
        // list are different posts. Best effort, like the row above.
        if (composedIdx.length > 0 && !truth.teams && !monthlyList) {
          const shownAt = new Date();
          await db.sentNotification
            .create({
              data: {
                key: rosterShownKey(
                  nextMatchForReply.id,
                  squadFingerprint({
                    confirmedUserIds: finalAtt.filter((a) => a.status === "CONFIRMED").map((a) => a.userId),
                    benchUserIds: finalAtt.filter((a) => a.status === "BENCH").map((a) => a.userId),
                    maxPlayers: nextMatchForReply.maxPlayers,
                  }),
                  shownAt,
                ),
                kind: ROSTER_SHOWN_KIND,
                matchId: nextMatchForReply.id,
              },
            })
            .catch((err) => console.error("[analyze] could not record the roster as shown:", err));
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

  // A change's own question whose answer the squad pass must not touch
  // (`also-asks-reply.ts`): added now, after the change's line and any list.
  for (const [id, text] of alsoAnswerAfterComposition) {
    const r = results.find((x) => x.waMessageId === id);
    if (r) r.reply = appendAfterComposition(r.reply ?? null, text);
  }
  // The team half of an attendance message (2026-10-30): its line, after
  // the change's own line and any list, in the same one reply.
  for (const [id, o] of teamOpsBatch?.alsoOutcomes ?? []) {
    const r = results.find((x) => x.waMessageId === id);
    if (!r) continue;
    if (o.reply) r.reply = appendAfterComposition(r.reply ?? null, o.reply);
    r.react = r.react ?? o.react;
    await augmentAnalysis({ waMessageId: id, action: o.action, reasoningSuffix: o.reasoning });
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
  // ── WHERE FROM, FOR A RECRUIT FROM THE ATTENDANCE PATH (L10; 2026-10-28)
  //   "@Match Time ask the pool for a player" reaches here from the
  //   attendance path (the router calls it `offer`; its extractor only
  //   says "recruit"). Before a mass DM, the shared admin extractor reads
  //   where the players are to come from (`recruit-source.ts`): the places
  //   named besides the club's own players are asked (the partner and pool
  //   passes below), the blast only when the club's own players were named
  //   too, and words naming no place are the organiser's question below.
  if (recruitRequests.length > 0) {
    const last = recruitRequests[recruitRequests.length - 1];
    if (last.fromAttendance && last.sender.userId) {
      const places = await recruitPlacesFromWords({ id: last.msg.waMessageId, body: last.msg.body, authorName: last.sender.name ?? last.msg.authorName ?? null, now: new Date() });
      if (places?.sources && places.sources.some((x) => x !== "club")) {
        console.log(`[analyze] ${last.msg.waMessageId}: a recruit from ${places.sources.join("+")}: asked there${places.sources.includes("club") ? ", and the recruit blast" : ", no recruit blast"}`);
        if (places.sources.includes("partners")) partnerAskRequests.push({ msg: last.msg, sender: last.sender, clubRef: places.clubRef, matchId: null });
        if (places.sources.includes("pool")) poolRequests.push({ msg: last.msg, userId: last.sender.userId, matchId: null });
        if (!places.sources.includes("club")) recruitRequests.length = 0;
      } else if (places && places.sources === null && messageTagsBot(last.msg)) {
        // Only when MatchTime was tagged: an untagged "Najib is out, we
        // need one more" that changed the squad keeps today's blast.
        last.sourceUnsaid = true;
      }
    }
  }

  // ── PLAYERS ASKED FOR, NO PLACE NAMED (Kemal, 2026-10-28) ───────────
  //   The same rule as HQ (`ask-source-rules.ts`): a club with partner
  //   clubs or the pool open is asked ONE question, "who shall I ask for
  //   players: your recent players, your partner clubs, or the MatchTime
  //   player pool?", logged as MatchTime's question in this group so the
  //   organiser's answer is read (the early pass above). Nobody is DM'd.
  //   A club with neither: the blast, as before.
  if (recruitRequests.length > 0) {
    const last = recruitRequests[recruitRequests.length - 1];
    if (last.sourceUnsaid) {
      const now = new Date();
      const d = decideRecruitSource({ sourceUnsaid: true }, await sourcesAvailable(org.id, await poolEnvForApiRequest(request)).catch(() => ({ partners: false, pool: false })));
      if (d.kind === "ask-which") {
        const question = await askWhichSource({ orgId: org.id, lang: org.language, options: d.options, now, where: "group" });
        console.log(`[analyze] ${last.msg.waMessageId}: players asked for, no place named: asking which (${d.options.join("+")}), no recruit blast`);
        const idx = results.findIndex((x) => x.waMessageId === last.msg.waMessageId);
        if (idx >= 0) {
          results[idx].reply = mergeRecruitReply(results[idx].reply, question);
          if (results[idx].handledBy === "ignored" || results[idx].intent === "noise" || results[idx].intent === "unclear") {
            results[idx].handledBy = "fast-path";
            results[idx].intent = "recruit_ask_source";
          }
        } else {
          results.push({ waMessageId: last.msg.waMessageId, handledBy: "fast-path", intent: "recruit_ask_source", react: null, reply: question });
        }
        await augmentAnalysis({
          waMessageId: last.msg.waMessageId,
          action: `recruit-ask-source:${d.options.join("+")}`,
          reasoningSuffix: `admin asked for players, no place named: asked which (${d.options.join("+")})`,
        });
        recruitRequests.length = 0;
      }
    }
  }

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
      // The four shapes live in `group-copy.ts` (pure, golden-pinned).
      // FULL-SQUAD CASE: the words are the LIB's on purpose. With the
      // bench feature on `r.reason` is the bench invitation (2026-09-14:
      // "is already full, no open spots to recruit for" was answering an
      // ask for BENCHERS, which are wanted because the squad is full);
      // with it off it is the old refusal, which for that org is true.
      // `recruit.ts`'s capacity guard is the only place holding the
      // squad, the features and the match at once, and the DM admin path
      // (`dm-reply/route.ts`) prints the same string.
      // NOBODY NEW TO ASK (2026-10-28, after "No new players to ask for
      // Football 9-a-side right now."): said plainly, and when the club
      // has partner clubs or the pool, the offer to ask them, logged as
      // MatchTime's question so "the pool" or "both" answers it.
      const nobodyLeft = r.ok && !r.reason && !(r.invited && r.invited > 0) && !(r.alreadyInvited && r.alreadyInvited > 0);
      const recruitReply = nobodyLeft
        ? (await nobodyLeftReply({ orgId: org.id, lang: org.language, matchName: r.matchName ?? "", now: new Date(), where: "group", env: await poolEnvForApiRequest(request) })).text
        : buildRecruitAckReply(r, org.language);
      // The group is being told the recruit DMs went out for this many
      // open places. The match-day morning chase asks for the same
      // places, so it stays quiet for three hours unless the need
      // changes (`roster-shown.ts`, 2026-10-06). Only when DMs were
      // really queued: the other three replies ask nobody for anything.
      if (r.ok && (r.invited ?? 0) > 0 && r.matchId && typeof r.need === "number") {
        await db.sentNotification
          .create({
            data: {
              key: recruitAckKey(r.matchId, r.need, new Date()),
              kind: RECRUIT_ACK_KIND,
              matchId: r.matchId,
            },
          })
          .catch((err) => console.error("[analyze] could not record the recruit ack:", err));
      }

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

  // ── ASK THE PARTNER CLUBS (slice S6, 2026-10-21) ───────────────────
  //   After every write, like the recruit blast above. The last request in
  //   the batch only: two organisers asking at once ask each partner once
  //   (and `requestPartnerAsk` refuses a second open ask per pair anyway).
  //   ONE reply, merged into the message's single result.
  if (partnerAskRequests.length > 0) {
    const ask = partnerAskRequests[partnerAskRequests.length - 1];
    try {
      const r = await askPartnersFromWords({
        orgId: org.id,
        requestedByUserId: ask.sender.userId,
        via: "group",
        clubRef: ask.clubRef,
        // Null: the asks code made from an answer or the attendance path,
        // for the club's next match (`askPartnersFromWords` loads it).
        matchId: ask.matchId ?? undefined,
        lang: org.language,
        now: new Date(),
      });
      const idx = results.findIndex((x) => x.waMessageId === ask.msg.waMessageId);
      if (idx >= 0) {
        results[idx].reply = mergeRecruitReply(results[idx].reply, r.replyText);
        results[idx].react = results[idx].react ?? (r.asked > 0 ? "✅" : null);
        if (results[idx].handledBy === "ignored" || results[idx].intent === "noise" || results[idx].intent === "unclear") {
          results[idx].handledBy = "fast-path";
          results[idx].intent = "partner_ask";
        }
      } else {
        results.push({ waMessageId: ask.msg.waMessageId, handledBy: "fast-path", intent: "partner_ask", react: r.asked > 0 ? "✅" : null, reply: r.replyText });
      }
      await augmentAnalysis({
        waMessageId: ask.msg.waMessageId,
        action: `partner-ask:${r.asked}`,
        reasoningSuffix: `admin asked the partner clubs (${r.outcome})`,
      });
    } catch (err) {
      console.error("[analyze] partner ask failed:", err instanceof Error ? err.message : "failed");
    }
  }

  // ── ASK THE MATCHTIME PLAYER POOL (local player pool L10) ──────────
  //   An organiser's tagged "ask the pool" in the players' group (clubs
  //   with no admin group ask here). The same door as HQ
  //   (`pool-ask-words.ts`): L5a's `requestPoolAsk`, every rule of the
  //   match page tick, after every write in the batch. The last request
  //   only (one open pool ask per match anyway). ONE line back, always:
  //   asked, why not, or that the pool is not open for the club.
  if (poolRequests.length > 0) {
    const ask = poolRequests[poolRequests.length - 1];
    try {
      const r = await askPoolFromWords({
        orgId: org.id,
        matchId: ask.matchId,
        userId: ask.userId,
        via: "words",
        where: "group",
        lang: org.language,
        now: new Date(),
        env: await poolEnvForApiRequest(request),
        remember: { askMessageId: ask.msg.waMessageId },
      });
      const react = r.outcome === "hq-pool-asked" ? "✅" : null;
      const idx = results.findIndex((x) => x.waMessageId === ask.msg.waMessageId);
      if (idx >= 0) {
        results[idx].reply = mergeRecruitReply(results[idx].reply, r.replyText);
        results[idx].react = results[idx].react ?? react;
        if (results[idx].handledBy === "ignored" || results[idx].intent === "noise" || results[idx].intent === "unclear") {
          results[idx].handledBy = "fast-path";
          results[idx].intent = "pool_ask";
        }
      } else {
        results.push({ waMessageId: ask.msg.waMessageId, handledBy: "fast-path", intent: "pool_ask", react, reply: r.replyText });
      }
      await augmentAnalysis({
        waMessageId: ask.msg.waMessageId,
        action: `pool-ask:${r.outcome}`,
        reasoningSuffix: `admin asked the MatchTime player pool (${r.outcome})`,
      });
    } catch (err) {
      console.error("[analyze] pool ask failed:", err instanceof Error ? err.message : "failed");
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
        // The group's org language: every stats DM is written in it.
        lang: org.language,
      });
      const blastReply = composeStatsBlastReply(queued, org.language);
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

  // ── The organisers announce the list (2026-10-14) ───────────────────
  //   `Organisation.listAnnouncer = "organisers"` (list-announcer.ts): the
  //   players' group never gets the squad from MatchTime. The composer
  //   already says nothing about it in this mode and the batch's squad
  //   marker is never attached (above); this is the net under every path
  //   that can still carry one, after every merge: a bare marker becomes
  //   silence (the reaction stands), a reply that shows the squad becomes
  //   "The organisers will post the list." A club on "matchtime" skips it.
  //
  //   EXCEPT THE HELP ANSWER (2026-10-15). It is deterministic copy that
  //   `buildHelpReply` already writes for this mode, and it shows no squad;
  //   but its heading "*Squad & availability: how it works*" ("*Kadro ve
  //   katılım ...*") matches `displaysSquadState`'s header rule, so "@Match
  //   Time help availability" used to come back as "The organisers will
  //   post the list."
  //
  //   AND THE SPACE ANSWER (FNF 2026-10-20). "Is there still space?" is
  //   answered with the open places and how to ask for one, no names
  //   (`oa_space_answer`); it used to carry the squad count and so came
  //   back as "The organisers will post the list." Both by intent
  //   (`passesOrganisersNet`), never by the reply's words.
  if (organisersMode) {
    for (const r of results) {
      if (passesOrganisersNet(r.intent)) continue;
      r.reply = organisersGroupReply(r.reply, org.language);
    }
  }

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

  // ── A MESSAGE TAGGED TO MATCHTIME IS NEVER MET WITH SILENCE ───────
  //   (MT Test, 2026-10-29.) The owner tagged "@Match Time invite players
  //   from pool" and, routed `offer` with a bare "chase", it ended with no
  //   reply, no tick, no write and nothing queued. Decided here, after every
  //   pass that can add words, a tick or a queued ask to a result, from the
  //   OUTCOME only (`tagged-silence.ts`), never the words: the players'
  //   group twin of HQ's "I didn't catch that", pointing to help.
  for (const r of results) {
    const m = fresh.find((x) => x.waMessageId === r.waMessageId);
    if (!m) continue;
    const silent = taggedSilence({
      taggedExplicitly: piMentionsBot(m),
      senderKnown: !!senderById.get(m.waMessageId)?.userId,
      late: lateById.has(m.waMessageId),
      capped: cappedIds.has(m.waMessageId),
      gated: gatedIds.has(m.waMessageId),
      route: gateRouteById.get(m.waMessageId),
      result: { reply: r.reply ?? null, react: r.react ?? null, intent: r.intent ?? "noise", handledBy: r.handledBy },
    });
    if (!silent) continue;
    r.reply = strings(org.language).group_not_understood;
    r.intent = "not_understood";
    r.handledBy = "fast-path";
    console.log(`[analyze] ${m.waMessageId}: tagged to MatchTime and nothing came of it: the not-understood line`);
    await augmentAnalysis({
      waMessageId: m.waMessageId,
      action: "not-understood",
      reasoningSuffix: "tagged to MatchTime, nothing written, queued or said: the not-understood line",
      intent: "not_understood",
    });
  }

  // ── AN ORGANISER CALLING THE GAME OFF WITHOUT A TAG ────────────────
  //   (Vets MNF, 2026-10-26.) "Alright, so it's off gents" from an
  //   organiser, untagged, left the game live. The group hears nothing
  //   (no tag, no words from MatchTime); for an organiser's untagged message
  //   while a game is coming, the model reads it against the recent chat
  //   (`calloff-reader.ts`) and, when it calls the game off, the organiser
  //   is DM'd once to say *cancel* (`calloff-offer.ts`). No result here
  //   changes. Best effort: it never costs the batch its replies.
  {
    const outcomes = await offerCalloffIfCalled({
      orgId: org.id,
      lang: org.language,
      now: new Date(),
      history,
      messages: fresh.map((m) => {
        const s = senderById.get(m.waMessageId);
        return {
          waMessageId: m.waMessageId,
          body: m.body,
          authorName: chatAuthorOf(s),
          userId: s?.userId ?? null,
          phone: s?.phone ?? (m.authorPhone || null),
          tagged: messageTagsBot(m),
          late: lateById.has(m.waMessageId),
          capped: cappedIds.has(m.waMessageId),
          reply: replyById.get(m.waMessageId) ?? null,
        };
      }),
    });
    for (const o of outcomes.filter((x) => x.outcome === "offered")) {
      await augmentAnalysis({
        waMessageId: o.waMessageId,
        action: "calloff-offer",
        reasoningSuffix: "an organiser called the next game off untagged: asked by DM whether to cancel it",
      });
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

  // ── LATE MESSAGES: THE BACKSTOP AND THE ONE EVENT (touch 4 of 4) ───
  //
  //   Every late result loses its words and keeps only a registration
  //   react, whatever above produced it: this is the last pass that can
  //   change a result, so no future branch can make a late message speak.
  //   Then ONE `late-message` event for the batch on /admin/health, info
  //   severity, deduped on the message ids so a re-posted batch records
  //   once. Never a DM. Best-effort: it must not cost the batch its reply.
  if (lateById.size > 0) {
    for (let i = 0; i < results.length; i++) {
      if (lateById.has(results[i].waMessageId)) results[i] = silenceLateResult(results[i]);
    }
    const alert = composeLateMessageAlert(lateEntries);
    if (alert) {
      console.warn(`[analyze] ${alert.title}: ${lateEntries.map((e) => e.waMessageId).join(", ")}`);
      await recordOpsEvent({
        orgId: org.id,
        kind: LATE_MESSAGE_KIND,
        severity: "info",
        title: alert.title,
        detail: alert.detail,
        dedupeKey: alert.dedupeKey,
      });
    }
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

  // MatchTime's replies are claimed like its other posts, with their match
  // (the result's match for a score, else the match being registered), so
  // a reply quoting one resolves by its id (`group-reply-claims.ts`).
  const replyKeys = await claimGroupReplies({
    orgId: org.id,
    door: "group",
    replies: results
      .filter((r) => !!r.reply)
      .map((r) => ({
        inboundId: r.waMessageId,
        text: r.reply!,
        matchId: scoreBatch?.outcomes.get(r.waMessageId)?.matchId ?? activeMatchForReply?.id ?? null,
      })),
  }).catch(() => new Map<string, string>());
  for (const r of results) {
    const key = replyKeys.get(r.waMessageId);
    if (key && r.reply) r.replyKey = key;
  }

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
  lang?: string | null;
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

  const [members, aliases, knownLids] = await Promise.all([
    db.membership.findMany({
      where: { orgId },
      select: { user: { select: { id: true, name: true, phoneNumber: true } } },
    }),
    db.userAlias.findMany({ where: { orgId }, select: { alias: true, userId: true } }),
    loadKnownLids(orgId).catch((err) => {
      console.error("[analyze] stored LID lookup failed (mentions named without it):", err);
      return [];
    }),
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
      knownLids,
    });
    const described = describeMentionOutcomes(outcomes);
    // One line per message that carried a mention. A run of "LEFT RAW"
    // is the signal that a player's pushname needs a `UserAlias`.
    if (described) console.log(`[analyze] mentions ${m.waMessageId}: ${described}`);
    return body === m.body ? m : { ...m, body };
  });
}

/**
 * Every LID this org's own records tie to a phone or a member
 * (2026-09-30): the participant snapshots taken when MatchTime joined the
 * group (`OnboardingSession`, `ClubConnect`) and the organiser's connect
 * DM (`ClubConnect.dmLid`). Read only for a batch that carries a raw
 * mention token, alongside the roster. The server stores no other LID.
 */
async function loadKnownLids(orgId: string): Promise<KnownLid[]> {
  const [sessions, connects] = await Promise.all([
    db.onboardingSession.findMany({ where: { orgId }, select: { participants: true } }),
    db.clubConnect.findMany({
      where: { orgId },
      select: { userId: true, dmLid: true, participants: true },
    }),
  ]);
  const out: KnownLid[] = [];
  for (const row of [...sessions, ...connects]) {
    for (const p of parseParticipantSnapshot(row.participants)) {
      if (p.lidId && p.phone) out.push({ lid: p.lidId, phone: p.phone });
    }
  }
  for (const c of connects) {
    if (c.dmLid) out.push({ lid: c.dmLid, userId: c.userId });
  }
  return out;
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
 * Put one message's pipeline trace on its AnalyzedMessage row. Handed to
 * `persistPipelineTraces` at the end of the request (see `POST`), which
 * logs and swallows a failure here: a lost trace never fails a batch.
 *
 * `updateMany`, not `update`: a message whose row was never written
 * updates nothing rather than throwing P2025. The trace is JSON by
 * construction (`buildPipelineTrace` builds it from primitives), and
 * Prisma's `InputJsonValue` will not take the interface, hence the cast.
 */
const writePipelineTrace: TraceWriter = async (waMessageId, trace) => {
  await db.analyzedMessage.updateMany({
    where: { waMessageId },
    data: { pipelineTrace: trace as unknown as object },
  });
};

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
