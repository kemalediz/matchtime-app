/**
 * ══════════════════════════════════════════════════════════════════════
 * THE ENGLISH BYTES, PINNED. Read this before touching the snapshot.
 * ══════════════════════════════════════════════════════════════════════
 *
 * MatchTime is live for an English-speaking club. The multi-language
 * programme (MDs/multi-language-design-2026-09-16.md) moves every
 * outbound string into a per-language table, one composer at a time,
 * and its ONE acceptance test that never changes is this file: every
 * English string must be byte-identical before and after every phase.
 * Sutton FC is "en" by the column default and must never be able to
 * tell that anything happened.
 *
 * This is the repo's first snapshot test, so the convention is stated
 * here, once:
 *
 *   - `__snapshots__/copy.en.snap` is generated from `main` as it stood
 *     on 2026-09-16 (Phase 0) and COMMITTED. It is a review artefact:
 *     every case is labelled with the design's inventory row so a
 *     reviewer can read the rendered copy in context.
 *
 *   - A failure here means an English byte changed. That is either a
 *     bug (fix the code) or a DELIBERATE copy change (re-record with
 *     `npx vitest run copy-golden -u`, and the `.snap` diff is part of
 *     the PR that a reviewer reads line by line). It is never
 *     incidental: do not re-record to make CI green, and do not
 *     re-record in a refactor PR. A Phase 2 PR that moves a string into
 *     the table must leave this file's snapshot with an EMPTY diff.
 *
 *   - The renderer takes a language so the same cases produce
 *     `copy.tr.snap` (the owner's Turkish review artefact, committed
 *     since Phase 2 slice 1). A composer that has not been moved into
 *     the string table renders English in BOTH documents; the English
 *     cases in the Turkish snapshot are therefore the remaining Phase 2
 *     work, and each slice's diff to that file shows exactly what moved.
 *     Re-recording the Turkish snapshot is expected whenever a Turkish
 *     string changes; re-recording the English one never is.
 *
 *   - Deliberate additions (2026-09-17, Phase 2 slice 1, recorded on
 *     purpose in their own commit BEFORE any string moved): the "Squad
 *     complete" post (`buildSquadCompletePost`, extracted verbatim from
 *     `squad-announce.ts`) and the scheduler's static group posts
 *     (`scheduler-copy.ts`, extracted verbatim from `bot-scheduler.ts`:
 *     announce, roster block, match-day teams block, locked post, the
 *     17:00 fallback, unpaid tail, bench-offer context, poll question).
 *     Both extractions were proven byte-identical by the exact-string
 *     tests that already pinned those posts (`squad-announce.test.ts`,
 *     `announce-suppressed-when-squad-non-empty.test.ts`,
 *     `payment-suppression.test.ts`) staying green unchanged.
 *
 *   - Deliberate additions (2026-09-17, Phase 3, recorded in their own
 *     commit BEFORE any string moved): the private messages that lived
 *     inline in database-reaching code, extracted verbatim into
 *     `dm-copy.ts` (rows 83, 88 to 92, 95 to 98, 103 to 111, 122 and
 *     the roster check-in invite). The only non-additive line in that
 *     commit's `.snap` diff is the case count in the header.
 *
 * WHAT IS COVERED: every deterministic composer the design inventories
 * (sections 1.1 to 1.4) that is reachable as a PURE function with no
 * database, no model and no clock, against three fixed worlds (a short
 * squad with a bench, a full squad, teams generated) plus fixed inputs
 * for the standalone builders. The design counts about 185 templates;
 * the coverage note in the PR maps each rendered case to its row.
 *
 * WHAT IS NOT, and why (Phase 2 refactors these into pure builders):
 * every template that lives inline in a function that reaches the
 * database or the Pi. The list, with file:line at `main` d049732:
 *
 *   src/lib/bot-scheduler.ts     :191 buildReminderText, :402 botIntroMessage
 *                                (pure but not exported), and the inline posts at
 *                                :540, :688, :1433, :1474, :1531, :1556, :1581,
 *                                :1607, :1688, :1746, :1781, :1867
 *                                (the group posts at :300, :316, :948, :1049,
 *                                :1062, :1324 and :1637 are now in
 *                                `scheduler-copy.ts` and covered, see above)
 *   src/lib/squad-announce.ts    now covered via `buildSquadCompletePost`
 *   src/lib/bench-confirmation.ts:178 three bench-claim announcements
 *   src/lib/payment-flow.ts      :61 pay link DM, :318 fee confirmed ack,
 *                                :326 fee cancelled ack, :421 confirmPrompt
 *   src/lib/rating-progress.ts   :90  the "no recent completed match" reason
 *   src/lib/recruit.ts           :269, :373 the two recruit refusals
 *   src/lib/dm-qa.ts             :223 APOLOGY (a local const inside the model call)
 *   src/lib/onboarding-conversation.ts :139 INTRO (legacy setup opener),
 *                                :956 nextEventQuestion, :988 featureMenuText
 *                                (the legacy "@MatchTime setup" flow; the
 *                                group-add flow's turns, completion posts and
 *                                DMs were extracted as pure builders and pinned
 *                                on 2026-09-17)
 *   src/app/actions/matches.ts   :152 format-switch announcement, :192 cancel
 *   src/app/actions/payments.ts  :304 direct-pay notice
 *   src/app/actions/claim.ts :92, phone-signup.ts :79  verification codes
 *   src/app/api/whatsapp/analyze/route.ts :721, :2687, :2689, :2705, :2707,
 *                                :3681, :3690, :3711, :3744, :3865
 *   src/app/api/whatsapp/dm-reply/route.ts :166, :184, :452, :676, :678,
 *                                :691, :938, :1007
 *   src/app/api/whatsapp/attendance/route.ts :199, group-join/route.ts :145,
 *                                group-leave/route.ts :96
 *   whatsapp-bot/src/index.ts    :467 the Pi's one string
 *   The model-composed paths (message-analyzer.ts chases, dm-qa.ts) are
 *   not templates and are measured by live dry runs, not snapshots.
 */
import { describe, it, expect } from "vitest";
import type { EngineResult, SpeechIntent, SquadState } from "../../pipeline/types";
import { compose } from "../../pipeline/compose";
import { world } from "../../pipeline/__tests__/helpers";
import type { Lang } from "../lang";
import {
  buildMatchDayChaseFallback,
  buildRatePromoPost,
  buildSquadCompletePost,
  composeSquadStateReply,
} from "../../group-copy";
import {
  buildAnnounceMatchPost,
  buildAskScorePost,
  buildBenchOfferContext,
  buildBotIntro,
  buildChasePreKickoffFallback,
  buildDailyInListFallback,
  buildGearReminder,
  buildMatchDayLockedPost,
  buildMatchDayTeamsBlock,
  buildPaymentPollQuestion,
  buildPreKickoffShortFallback,
  buildSquadRosterBlock,
  buildUnpaidTailText,
} from "../../scheduler-copy";
import { buildBenchClaimAnnouncement, buildSquadCompleteBenchInvite } from "../../bench-offer-copy";
import { t } from "../t";
import { dayTimeLabel } from "../dates";
import {
  buildColourSwapReply,
  buildFormatSwitchAnnouncement,
  buildMatchCancelledAnnouncement,
  buildRecruitAckReply,
  buildRecruitFullSquadRefusal,
  buildSlotTransferReply,
  buildSwapDeferredReply,
  buildTeamSheet,
  buildTeamSwapReply,
  recruitNoMatchRefusal,
  teamGenReasonNotEnough,
  teamGenReasonNotFound,
  teamGenReasonStatus,
} from "../../group-copy";
import {
  benchClaimPhrasingExample,
  buildBenchAskedLine,
  buildBenchIntroLine,
  buildBenchOfferDm,
  buildBenchOfferGroupPost,
  buildFullSquadBenchInvite,
} from "../../bench-offer-copy";
import { formatRatingProgressReply } from "../../rating-progress-answer";
import { buildMomAnnouncement } from "../../mom-announcement";
import { buildFormatSwitchFacts, renderFormatSwitchContext } from "../../format-switch";
import { renderKickoffMoveLine } from "../../format-switch-time";
import { buildOutOfBandAttendanceLine } from "../../out-of-band-attendance";
import { planUnresolvedNudge } from "../../unresolved-nudge";
import { renderGuestNameAsk } from "../../guest-name-ask";
import { composeStatsBlastDm, composeStatsBlastReply } from "../../stats-blast";
import { buildBulkCancelAnnouncement } from "../../block-booking";
import { buildAttendanceFailureReply } from "../../attendance-write-outcome";
import { composePaymentAck, composeReminderDm, type PaymentApplyResult } from "../../admin-ops-engine";
import {
  composeBalancerRefusal,
  composeGenerateTeamsReply,
  teamOpsNoMatchReply,
} from "../../team-ops-engine";
import { buildRecruitGroupInviteDm, buildRecruitInviteDm } from "../../recruit";
import { buildRecruitChaseText } from "../../recruit-chase";
import { buildTentativeFollowupAck } from "../../tentative-followup";
import {
  buildAdminRecruitDmReply,
  buildBenchDmAck,
  buildBenchDmUnclear,
  buildDirectPayCollectorNudge,
  buildDmQaApology,
  buildFeeAskDm,
  buildFeeCancelledAck,
  buildFeeConfirmPrompt,
  buildFeeReleasedAck,
  buildPayChaseDm,
  buildPayLinkDm,
  buildRatingDm,
  buildRatingReminderDm,
  buildRosterSurveyClarification,
  buildRosterSurveyConfirmation,
  buildRosterSurveyInviteDm,
  buildStatsLinkDm,
  buildTentativeFollowupDm,
  buildTentativeReask,
  rosterSurveyClarificationProbe,
} from "../../dm-copy";
import { buildSelfAttendanceAck } from "../../out-of-band-self-attendance";
import { dmSubAckMessage } from "../../dm-subscriptions";
import {
  ADMIN_QUESTION,
  BOT_ADDED_INTRO,
  buildAdminMagicLinkDm,
  buildAdminsAck,
  buildCoAdminMagicLinkDm,
  buildConsentAck,
  buildEnrichmentReviewDm,
  buildLegacyFeatureMenu,
  buildLegacyProvisionedLead,
  buildLegacySetupIntro,
  legacyEventQuestion,
  legacyMenuRetryLead,
  buildGroupAddCompletionPost,
  buildHelpReply,
  buildHowToUseMe,
  buildLegacyCompletionPost,
} from "../../onboarding-conversation";
import { RECOMMENDED_BUNDLE, EVERYTHING_BUNDLE } from "../../onboarding-parse";
import { detailsFollowUpQuestion } from "../../onboarding-parse";
import { buildBenchUpgradeReply } from "../../bench-upgrade-ack";
import { resolveReminderPhrase } from "../../reminder-time";
import { FEE_REPLY_SYSTEM_PROMPT, buildFeeReplySystemPrompt } from "../../fee-confirm";

// ── The three worlds ─────────────────────────────────────────────────

const ELEVEN = [
  "kemal", "elvin", "sait", "mustafa", "abid", "idris",
  "faris", "shaz", "adam", "efat", "usama",
];
const FOURTEEN = [...ELEVEN, "karahan", "zair", "wasim"];

/**
 * A world in the given language. `world()` is the pipeline's English
 * fixture (Sutton FC); a Turkish world carries `features.language =
 * "tr"`, and the two values `load-state.ts` formats PER LANGUAGE before
 * the composer runs (the kickoff label and the default team labels) are
 * set to what the loader would produce for a Turkish org.
 */
function worldIn(lang: Lang, over: Parameters<typeof world>[0] = {}): SquadState {
  const w = world({ ...over, features: { language: lang, ...(over.features ?? {}) } });
  if (lang === "tr") {
    w.kickoffLabel = "Salı 21:30";
    w.teamLabels = ["Kırmızı", "Sarı"];
    // The played match's label is formatted by the same loader call.
    if (w.completedMatch) w.completedMatch = { ...w.completedMatch, kickoffLabel: "Salı 21:30" };
  }
  return w;
}

/** 11 of 14 confirmed, two on the bench, one dropped. */
function shortWorld(lang: Lang, over: Parameters<typeof world>[0] = {}): SquadState {
  return worldIn(lang, {
    confirmed: ELEVEN,
    bench: ["erdal", "amir"],
    dropped: ["habib"],
    ...over,
  });
}

/** 14 of 14 confirmed, one on the bench. */
function fullWorld(lang: Lang, over: Parameters<typeof world>[0] = {}): SquadState {
  return worldIn(lang, { confirmed: FOURTEEN, bench: ["najib"], ...over });
}

/** Full, with teams generated. */
function teamsWorld(lang: Lang): SquadState {
  const teams: Record<string, "RED" | "YELLOW"> = {};
  FOURTEEN.forEach((k, i) => (teams[k] = i % 2 === 0 ? "RED" : "YELLOW"));
  return fullWorld(lang, { teams });
}

const MSG = "wa-1";

/** Everything MatchTime would SAY for one speech intent, in order. */
function say(state: SquadState, ...speech: SpeechIntent[]): string {
  const result: EngineResult = {
    outcomes: [],
    writes: [],
    nextState: state,
    speech,
    degradations: [],
  };
  const out = compose(result);
  const said = out.utterances.map((u) => u.text);
  return said.length > 0 ? said.join("\n\n") : "(says nothing)";
}

// ── The renderer ─────────────────────────────────────────────────────
//
// `lang` is threaded through every world and every builder that takes a
// language, so the same cases produce `copy.en.snap` and `copy.tr.snap`.
// A builder that has not been moved into the string table yet ignores
// it and renders English in both documents; those English cases in the
// Turkish snapshot are the remaining Phase 2 work, visible by diff.

interface Case {
  /** Design inventory row(s), then a short name. */
  id: string;
  text: string;
}

function cases(lang: Lang): Case[] {
  const c: Case[] = [];
  // A builder that returns null or "" on purpose (a line that is omitted)
  // is recorded as such, so the document says what happened.
  const add = (id: string, text: string | null) =>
    c.push({ id, text: text === null ? "(null)" : text === "" ? "(empty string)" : text });

  const short = shortWorld(lang);
  const full = fullWorld(lang);
  const teams = teamsWorld(lang);
  const w = (over: Parameters<typeof world>[0] = {}) => worldIn(lang, over);
  const sw = (over: Parameters<typeof world>[0] = {}) => shortWorld(lang, over);

  // ── 1.1 compose.ts, one case per speech kind and branch ─────────────
  add("R1 squad_status / short with bench", say(short, { kind: "squad_status", messageId: null }));
  add("R1 squad_status / full", say(full, { kind: "squad_status", messageId: null }));
  add("R1 squad_status / empty squad", say(w(), { kind: "squad_status", messageId: null }));

  add("R6 answer_count / short, no stated count", say(short, { kind: "answer_count", messageId: MSG, statedCount: null }));
  add("R6 answer_count / short, stated count wrong", say(short, { kind: "answer_count", messageId: MSG, statedCount: 9 }));
  add("R6 answer_count / full", say(full, { kind: "answer_count", messageId: MSG, statedCount: null }));

  add("R7 answer_squad / short", say(short, { kind: "answer_squad", messageId: MSG }));

  add("R8 answer_fixture / venue", say(short, { kind: "answer_fixture", messageId: MSG }));
  add("R8 answer_fixture / no venue", say({ ...short, venue: "" }, { kind: "answer_fixture", messageId: MSG }));

  add("R9 answer_score / no played match", say(short, { kind: "answer_score", messageId: MSG }));
  add("R10 answer_score / no score yet", say(sw({ completedMatch: { id: "m-0" } }), { kind: "answer_score", messageId: MSG }));
  add("R11 answer_score / red won", say(sw({ completedMatch: { id: "m-0", redScore: 4, yellowScore: 2 } }), { kind: "answer_score", messageId: MSG }));
  add("R11 answer_score / yellow won", say(sw({ completedMatch: { id: "m-0", redScore: 1, yellowScore: 3 } }), { kind: "answer_score", messageId: MSG }));
  add("R11 answer_score / draw", say(sw({ completedMatch: { id: "m-0", redScore: 2, yellowScore: 2 } }), { kind: "answer_score", messageId: MSG }));

  add("R12 answer_payments / not tracked", say(sw({ payments: { kind: "not_tracked" } }), { kind: "answer_payments", messageId: MSG }));
  add("R13 answer_payments / no settled match", say(sw({ payments: { kind: "no_settled_match" } }), { kind: "answer_payments", messageId: MSG }));
  add("R14 answer_payments / no signal", say(sw({ payments: { kind: "no_signal", kickoffLabel: "Tue 21:30" } }), { kind: "answer_payments", messageId: MSG }));
  add("R15 answer_payments / all settled", say(sw({ payments: { kind: "counted", chargeable: 13, unpaid: 0, kickoffLabel: "Tue 21:30" } }), { kind: "answer_payments", messageId: MSG }));
  add("R16 answer_payments / some unpaid", say(sw({ payments: { kind: "counted", chargeable: 13, unpaid: 4, kickoffLabel: "Tue 21:30" } }), { kind: "answer_payments", messageId: MSG }));
  add("R16 answer_payments / not loaded", say(short, { kind: "answer_payments", messageId: MSG }));

  add("R17 answer_rating_progress / in progress", say(sw({ ratingProgress: { ok: true, matchName: "Tuesday 7-a-side", matchWhen: lang === "tr" ? "8 Eylül Salı" : "Tue 8 Sep", confirmed: 14, ratedCount: 9, momCount: 7, notRated: ["Abid Hussain", "Idris Bello"], ratedNoMom: ["Faris Nasser"] } }), { kind: "answer_rating_progress", messageId: MSG }));
  add("R17 answer_rating_progress / everyone rated", say(sw({ ratingProgress: { ok: true, matchName: "Tuesday 7-a-side", matchWhen: lang === "tr" ? "8 Eylül Salı" : "Tue 8 Sep", confirmed: 14, ratedCount: 14, momCount: 14, notRated: [], ratedNoMom: [] } }), { kind: "answer_rating_progress", messageId: MSG }));
  add("R60 answer_rating_progress / no recent match", say(sw({ ratingProgress: { ok: false, reason: t(lang).rating_progress_no_match } }), { kind: "answer_rating_progress", messageId: MSG }));
  add("R17 answer_rating_progress / not loaded", say(short, { kind: "answer_rating_progress", messageId: MSG }));

  add("R18 answer_bench / empty", say(w({ confirmed: ELEVEN }), { kind: "answer_bench", messageId: MSG }));
  add("R19 answer_bench / two", say(short, { kind: "answer_bench", messageId: MSG }));
  add("R19 answer_bench / one", say(sw({ bench: ["erdal"] }), { kind: "answer_bench", messageId: MSG }));
  add("R19 answer_bench / three", say(sw({ bench: ["erdal", "amir", "zeeshan"] }), { kind: "answer_bench", messageId: MSG }));

  add("R20 answer_person_status / not down", say(short, { kind: "answer_person_status", messageId: MSG, personRef: "Zeeshan", userId: "u-zeeshan" }));
  add("R20 answer_person_status / dropped", say(short, { kind: "answer_person_status", messageId: MSG, personRef: "Habib", userId: "u-habib" }));
  add("R21 answer_person_status / bench", say(short, { kind: "answer_person_status", messageId: MSG, personRef: "Erdal", userId: "u-erdal" }));
  add("R22 answer_person_status / confirmed", say(short, { kind: "answer_person_status", messageId: MSG, personRef: "Sait", userId: "u-sait" }));
  add("R20 answer_person_status / unknown person", say(short, { kind: "answer_person_status", messageId: MSG, personRef: "Bob", userId: null }));
  add("R5 answer_person_status / pushname is a phone number", say(short, { kind: "answer_person_status", messageId: MSG, personRef: "+44 7700 900123", userId: null }));

  add("R23 answer_phones / none missing", say(short, { kind: "answer_phones", messageId: MSG }));
  add("R24 answer_phones / one missing", say(sw({ noPhone: ["sait"] }), { kind: "answer_phones", messageId: MSG }));
  add("R24 answer_phones / three missing", say(sw({ noPhone: ["sait", "abid", "erdal"] }), { kind: "answer_phones", messageId: MSG }));

  add("R25 answer_stats / nothing to go on", say(short, { kind: "answer_stats", messageId: MSG }));
  add("R26 answer_stats / three ranked", say(sw({ appearances: [{ userId: "u-kemal", matches: 4 }, { userId: "u-elvin", matches: 3 }, { userId: "u-sait", matches: 1 }, { userId: "u-abid", matches: 1 }] }), { kind: "answer_stats", messageId: MSG }));

  add("R27 answer_options / full", say(full, { kind: "answer_options", messageId: MSG }));
  add("R28 answer_options / no smaller format", say(short, { kind: "answer_options", messageId: MSG }));
  add("R29 answer_options / none viable", say(sw({ smallerFormats: [{ sportName: "Football 6-a-side", totalPlayers: 12 }] }), { kind: "answer_options", messageId: MSG }));
  add("R30 answer_options / proposals", say(sw({ smallerFormats: [{ sportName: "Football 5-a-side", totalPlayers: 10 }, { sportName: "Football 6-a-side", totalPlayers: 12 }] }), { kind: "answer_options", messageId: MSG }));
  add("R30 answer_options / nobody benched", say(sw({ smallerFormats: [{ sportName: "Futsal", totalPlayers: 11 }] }), { kind: "answer_options", messageId: MSG }));

  add("R31 teams_post", say(teams, { kind: "teams_post", messageId: MSG }));
  add("R32 teams_not_generated", say(full, { kind: "teams_not_generated", messageId: MSG }));

  add("R33 guest_name_ask / singular", say(short, { kind: "guest_name_ask", messageId: MSG, askerName: "Sait Demir", body: "I'm in and bringing a mate" }));
  add("R33 guest_name_ask / plural", say(short, { kind: "guest_name_ask", messageId: MSG, askerName: "Sait Demir", body: "I'm in with two of my guys" }));
  add("R33 guest_name_ask / no asker name", say(short, { kind: "guest_name_ask", messageId: MSG, askerName: null, body: "+1" }));

  add("R34 score_ack", say(full, { kind: "score_ack", messageId: MSG, red: 3, yellow: 1 }));
  add("R35 payment_ack / one", say(full, { kind: "payment_ack", messageId: MSG, payerName: "Sait Demir", count: 1 }));
  add("R35 payment_ack / three", say(full, { kind: "payment_ack", messageId: MSG, payerName: "Sait Demir", count: 3 }));
  add("R36 reminder_ack / resolved", say(full, { kind: "reminder_ack", messageId: MSG, phrase: "thursday", whenLabel: "Thu 10 Sep at 09:00" }));
  add("R37 reminder_ack / unresolved", say(full, { kind: "reminder_ack", messageId: MSG, phrase: "when the fixture list is out", whenLabel: null }));

  add("R38 bench_offer_open / bench of two", say(short, { kind: "bench_offer_open", messageId: MSG, replacingName: "Sait Demir" }));
  add("R38 bench_offer_open / bench empty", say(w({ confirmed: ELEVEN }), { kind: "bench_offer_open", messageId: MSG, replacingName: "Sait Demir" }));

  const thirteen = w({ confirmed: FOURTEEN.slice(0, 13) });
  const twelve = w({ confirmed: FOURTEEN.slice(0, 12) });
  add("R39 slot_opened / one out, one slot", say(thirteen, { kind: "slot_opened", messageId: MSG, outNames: ["Wasim Akhtar"] }));
  add("R39 slot_opened / two out, two slots", say(twelve, { kind: "slot_opened", messageId: MSG, outNames: ["Wasim Akhtar", "Zair Malik"] }));
  add("R39 slot_opened / nobody out (benched), one slot", say(thirteen, { kind: "slot_opened", messageId: MSG, outNames: [] }));
  add("R39 slot_opened / full (says nothing)", say(full, { kind: "slot_opened", messageId: MSG, outNames: ["Wasim Akhtar"] }));

  add("R40 needs_tag_for_rest / out only", say(short, { kind: "needs_tag_for_rest", messageId: MSG, entries: [{ name: "Abid Hussain", action: "OUT" }] }));
  add("R40 needs_tag_for_rest / bench only", say(short, { kind: "needs_tag_for_rest", messageId: MSG, entries: [{ name: "Abid Hussain", action: "BENCH" }, { name: "Idris Bello", action: "BENCH" }] }));
  add("R40 needs_tag_for_rest / both", say(short, { kind: "needs_tag_for_rest", messageId: MSG, entries: [{ name: "Abid Hussain", action: "OUT" }, { name: "Idris Bello", action: "BENCH" }] }));

  add("R41 bench_claim_too_late", say(full, { kind: "bench_claim_too_late", messageId: MSG, userId: "u-najib" }));
  add("R42 pending_confirmed_ack / one", say(short, { kind: "pending_confirmed_ack", messageId: MSG, userIds: ["u-sait"] }));
  add("R42 pending_confirmed_ack / two", say(short, { kind: "pending_confirmed_ack", messageId: MSG, userIds: ["u-sait", "u-abid"] }));
  add("R42 pending_confirmed_ack / nobody has a place (says nothing)", say(short, { kind: "pending_confirmed_ack", messageId: MSG, userIds: ["u-habib"] }));

  // ── 1.1 group-copy.ts ───────────────────────────────────────────────
  add("R3 buildRatePromoPost", buildRatePromoPost({ activityName: "Tuesday 7-a-side", matchDateLabel: lang === "tr" ? "8 Eylül Salı" : "Tue 8 Sep", lang }));
  add("R4 buildMatchDayChaseFallback", buildMatchDayChaseFallback({ need: 3, activityName: "Tuesday 7-a-side", lang }));
  const truth = { confirmed: ["Kemal Ediz", "Elvin Aliyev"], bench: ["Erdal Ozkan"], maxPlayers: 14 };
  add("R1 composeSquadStateReply / marker with a lead", composeSquadStateReply("Cheers Sait, noted. [SQUAD]", truth, lang).text);
  add("R1 composeSquadStateReply / model roster replaced", composeSquadStateReply("*Playing:*\n1. Kemal\n2. Elvin\n3. Sait", truth, lang).text);
  add("R1 composeSquadStateReply / plain reply kept", composeSquadStateReply("Thanks, noted 👍", truth, lang).text);

  // ── 1.1 group-copy.ts, row 43 (extracted from squad-announce.ts 2026-09-17)
  const fourteenNames = FOURTEEN.map((k) => full.roster.find((m) => m.userId === `u-${k}`)!.name);
  const squadCompleteWhen = lang === "tr" ? "22 Eylül Salı 21:30" : "Tue 22 Sept 21:30";
  add("R43 buildSquadCompletePost / no bench, no invite", buildSquadCompletePost({ maxPlayers: 14, activityName: "Tuesday 7-a-side", kickoffLabel: squadCompleteWhen, confirmed: fourteenNames, bench: [], benchInvite: null, lang }));
  add("R43 buildSquadCompletePost / bench of two, invite", buildSquadCompletePost({ maxPlayers: 14, activityName: "Tuesday 7-a-side", kickoffLabel: squadCompleteWhen, confirmed: fourteenNames, bench: ["Erdal Ozkan", "Amir Ahmadi"], benchInvite: buildSquadCompleteBenchInvite({ lang }), lang }));
  add("R43 buildSquadCompletePost / unnamed row", buildSquadCompletePost({ maxPlayers: 3, activityName: "Thursday 5-a-side", kickoffLabel: lang === "tr" ? "24 Eylül Perşembe 20:00" : "Thu 24 Sept 20:00", confirmed: ["Kemal Ediz", null, "Sait Demir"], bench: [null], benchInvite: null, lang }));

  // ── 1.2 scheduler-copy.ts (extracted from bot-scheduler.ts 2026-09-17)
  const named = (names: Array<string | null>) => names.map((name) => ({ name }));
  const [redLabel, yellowLabel] = lang === "tr" ? ["Kırmızı", "Sarı"] : ["Red", "Yellow"];
  add("R68 buildAnnounceMatchPost", buildAnnounceMatchPost({ activityName: "Tuesday 7-a-side", dateLabel: lang === "tr" ? "8 Eylül Salı 21:30" : "Tuesday 8 September at 21:30", venue: "Goals North Cheam", maxPlayers: 14, lang }));
  add("R71 buildSquadRosterBlock / empty", buildSquadRosterBlock({ confirmed: [], bench: [], maxPlayers: 14, lang }));
  add("R71 buildSquadRosterBlock / short, no bench", buildSquadRosterBlock({ confirmed: named(fourteenNames.slice(0, 11)), bench: [], maxPlayers: 14, lang }));
  add("R71 buildSquadRosterBlock / short with bench and an unnamed row", buildSquadRosterBlock({ confirmed: named([...fourteenNames.slice(0, 10), null]), bench: named(["Erdal Ozkan", "Amir Ahmadi"]), maxPlayers: 14, lang }));
  add("R71 buildSquadRosterBlock / full", buildSquadRosterBlock({ confirmed: named(fourteenNames), bench: named(["Najib Ahmadi"]), maxPlayers: 14, lang }));
  add("R69 buildMatchDayTeamsBlock", buildMatchDayTeamsBlock({ activityName: "Tuesday 7-a-side", venue: "Goals North Cheam", timeLabel: "21:30", redLabel, yellowLabel, red: named(fourteenNames.filter((_, i) => i % 2 === 0)), yellow: named(fourteenNames.filter((_, i) => i % 2 === 1)), lang }));
  add("R69 buildMatchDayTeamsBlock / custom labels, unnamed row", buildMatchDayTeamsBlock({ activityName: "Thursday 5-a-side", venue: "Sim Arena", timeLabel: "20:00", redLabel: "Lions", yellowLabel: "Tigers", red: named(["Kemal Ediz", null]), yellow: named(["Sait Demir", "Abid Hussain"]), lang }));
  const fullRoster = buildSquadRosterBlock({ confirmed: named(fourteenNames), bench: named(["Najib Ahmadi"]), maxPlayers: 14, lang });
  add("R70 buildMatchDayLockedPost", buildMatchDayLockedPost({ activityName: "Tuesday 7-a-side", venue: "Goals North Cheam", timeLabel: "21:30", rosterBlock: fullRoster, lang }));
  add("R72 buildDailyInListFallback", buildDailyInListFallback({ activityName: "Tuesday 7-a-side", need: 3, rosterBlock: buildSquadRosterBlock({ confirmed: named(fourteenNames.slice(0, 11)), bench: named(["Erdal Ozkan"]), maxPlayers: 14, lang }), lang }));
  add("R72 buildDailyInListFallback / one more", buildDailyInListFallback({ activityName: "Tuesday 7-a-side", need: 1, rosterBlock: buildSquadRosterBlock({ confirmed: named(fourteenNames.slice(0, 13)), bench: [], maxPlayers: 14, lang }), lang }));
  add("R73 buildUnpaidTailText / one", buildUnpaidTailText(1, lang));
  add("R73 buildUnpaidTailText / four", buildUnpaidTailText(4, lang));
  const ctxTeam = buildBenchOfferContext({ activityName: "Tuesday 7-a-side", team: { teamLabel: redLabel, replacingName: "Sait Demir" }, lang });
  add("R81 buildBenchOfferContext / team and replaced player (group)", ctxTeam.group);
  add("R81 buildBenchOfferContext / team and replaced player (plain)", ctxTeam.plain);
  const ctxNoName = buildBenchOfferContext({ activityName: "Tuesday 7-a-side", team: { teamLabel: redLabel, replacingName: null }, lang });
  add("R81 buildBenchOfferContext / replaced player unnamed (group)", ctxNoName.group);
  const ctxFixture = buildBenchOfferContext({ activityName: "Tuesday 7-a-side", team: null, lang });
  add("R81 buildBenchOfferContext / fixture only (group)", ctxFixture.group);
  add("R81 buildBenchOfferContext / fixture only (plain)", ctxFixture.plain);
  add("R78 buildPaymentPollQuestion", buildPaymentPollQuestion("Tuesday 7-a-side", lang));

  // ── 1.2 scheduler-copy.ts, slice 2 (extracted from bot-scheduler.ts 2026-09-17)
  const INTRO_ALL = { attendance: true, bench: true, teamBalancing: true, momVoting: true, playerRating: true, reminders: true, statsQa: true, paymentTracking: true };
  const INTRO_MIN = { attendance: true, bench: false, teamBalancing: false, momVoting: false, playerRating: false, reminders: false, statsQa: false, paymentTracking: false };
  const INTRO_RATINGS = { ...INTRO_MIN, attendance: false, momVoting: true, playerRating: true };
  add("R67 buildBotIntro / everything on", buildBotIntro(INTRO_ALL, buildBenchIntroLine({ lang }), lang));
  add("R67 buildBotIntro / attendance only", buildBotIntro(INTRO_MIN, buildBenchIntroLine({ lang }), lang));
  add("R67 buildBotIntro / ratings and MoM only", buildBotIntro(INTRO_RATINGS, buildBenchIntroLine({ lang }), lang));
  add("R74 buildChasePreKickoffFallback", buildChasePreKickoffFallback({ need: 2, activityName: "Tuesday 7-a-side", timeLabel: "21:30", lang }));
  add("R75 buildPreKickoffShortFallback", buildPreKickoffShortFallback({ timeLabel: "21:30", venue: "Goals North Cheam", confirmed: 12, maxPlayers: 14, need: 2, lang }));
  add("R76 buildGearReminder", buildGearReminder({ timeLabel: "21:30", venue: "Goals North Cheam", lang }));
  add("R77 buildAskScorePost", buildAskScorePost({ activityName: "Tuesday 7-a-side", lang }));

  // ── 1.1 bench-offer-copy.ts, row 49 (extracted from bench-confirmation.ts 2026-09-17)
  add("R49 buildBenchClaimAnnouncement / team and replaced player", buildBenchClaimAnnouncement({ claimerName: "Erdal Ozkan", droppedName: "Sait Demir", teamLabel: redLabel, confirmedCount: 14, maxPlayers: 14, lang }));
  add("R49 buildBenchClaimAnnouncement / replaced player, no team", buildBenchClaimAnnouncement({ claimerName: "Erdal Ozkan", droppedName: "Sait Demir", teamLabel: null, confirmedCount: 14, maxPlayers: 14, lang }));
  add("R49 buildBenchClaimAnnouncement / open slot", buildBenchClaimAnnouncement({ claimerName: "Erdal Ozkan", droppedName: null, teamLabel: null, confirmedCount: 13, maxPlayers: 14, lang }));

  // ── 1.1 group-copy.ts, slice 2 (extracted from app/actions/matches.ts, analyze/route.ts, recruit.ts, rating-progress.ts, team-generation.ts)
  const kickoffMoved = renderKickoffMoveLine({ move: true, reason: "moved", previousKickoff: new Date("2026-09-08T20:30:00.000Z"), kickoff: new Date("2026-09-08T20:15:00.000Z"), attendanceDeadline: new Date("2026-09-08T20:15:00.000Z") }, lang);
  add("R64 buildFormatSwitchAnnouncement / kickoff moved, bench", buildFormatSwitchAnnouncement({ sportName: "Football 5-a-side", maxPlayers: 10, kickoffLine: kickoffMoved, playing: fourteenNames.slice(0, 10), bench: fourteenNames.slice(10, 12), lang }));
  add("R64 buildFormatSwitchAnnouncement / same time, nobody yet", buildFormatSwitchAnnouncement({ sportName: "Football 5-a-side", maxPlayers: 10, kickoffLine: "", playing: [], bench: [], lang }));
  add("R64 buildFormatSwitchAnnouncement / unnamed row", buildFormatSwitchAnnouncement({ sportName: "Futsal", maxPlayers: 10, kickoffLine: "", playing: ["Kemal Ediz", null], bench: [null], lang }));
  add("R65 buildMatchCancelledAnnouncement", buildMatchCancelledAnnouncement({ activityName: "Tuesday 7-a-side", whenLabel: dayTimeLabel(lang, new Date("2026-09-22T20:30:00.000Z")), lang }));
  add("R123 buildRecruitAckReply / not ok, no reason", buildRecruitAckReply({ ok: false }, lang));
  add("R123 buildRecruitAckReply / not ok, lib reason", buildRecruitAckReply({ ok: false, reason: recruitNoMatchRefusal(lang) }, lang));
  add("R124 buildRecruitAckReply / invited five, two spots", buildRecruitAckReply({ ok: true, invited: 5, matchName: "Tuesday 7-a-side", need: 2 }, lang));
  add("R124 buildRecruitAckReply / invited one, one spot", buildRecruitAckReply({ ok: true, invited: 1, matchName: "Tuesday 7-a-side", need: 1 }, lang));
  add("R124 buildRecruitAckReply / invited, need unknown", buildRecruitAckReply({ ok: true, invited: 3, matchName: "Tuesday 7-a-side", need: null }, lang));
  add("R124 buildRecruitAckReply / full squad, lib reason", buildRecruitAckReply({ ok: true, invited: 0, matchName: "Tuesday 7-a-side", reason: buildRecruitFullSquadRefusal({ matchName: "Tuesday 7-a-side", lang }) }, lang));
  add("R125 buildRecruitAckReply / already pinged", buildRecruitAckReply({ ok: true, invited: 0, matchName: "Tuesday 7-a-side", alreadyInvited: 4 }, lang));
  add("R126 buildRecruitAckReply / nobody new", buildRecruitAckReply({ ok: true, invited: 0, matchName: "Tuesday 7-a-side", alreadyInvited: 0 }, lang));
  const sheetEn = buildTeamSheet({ redLabel, yellowLabel, red: ["Kemal Ediz", "Sait Demir", null], yellow: ["Elvin Aliyev", "Abid Hussain"] });
  add("R127 buildTeamSheet", sheetEn);
  add("R128 buildSwapDeferredReply", buildSwapDeferredReply({ a: "Kemal Ediz", b: "Sait Demir", lang }));
  add("R129 buildTeamSwapReply", buildTeamSwapReply({ a: "Kemal Ediz", b: "Elvin Aliyev", sheet: sheetEn, lang }));
  add("R130 buildSlotTransferReply", buildSlotTransferReply({ to: "Erdal Ozkan", from: "Sait Demir", teamLabel: redLabel, sheet: sheetEn, lang }));
  add("R131 buildColourSwapReply", buildColourSwapReply({ sheet: sheetEn, lang }));
  add("R61 buildRecruitFullSquadRefusal", buildRecruitFullSquadRefusal({ matchName: "Tuesday 7-a-side", lang }));
  add("R62 RECRUIT_NO_MATCH_REFUSAL", recruitNoMatchRefusal(lang));
  add("R60 RATING_PROGRESS_NO_MATCH_REASON", t(lang).rating_progress_no_match);
  add("R66 balancer reasons / not found", teamGenReasonNotFound(lang));
  add("R66 balancer reasons / completed", teamGenReasonStatus("COMPLETED", lang));
  add("R66 balancer reasons / not enough", teamGenReasonNotEnough({ confirmed: 9, needed: 14, lang }));

  // ── 1.1 bench-offer-copy.ts, both flag branches ─────────────────────
  const ctx = ctxTeam.group;
  for (const mentionReactions of [false, true]) {
    const tag = mentionReactions ? "reactions on" : "reactions off";
    add(`R52 buildBenchOfferGroupPost / ${tag}`, buildBenchOfferGroupPost({ context: ctx, tagList: "@447700900001 @447700900002", mentionReactions, lang }));
    add(`R85 buildBenchOfferDm / ${tag}`, buildBenchOfferDm({ firstName: "Erdal", context: lang === "en" ? "on Red (replacing Sait Demir) for Tuesday 7-a-side tonight" : ctxTeam.plain, mentionReactions, lang }));
    add(`R53 buildBenchIntroLine / ${tag}`, buildBenchIntroLine({ mentionReactions, lang }));
    add(`R54 buildFullSquadBenchInvite / ${tag}`, buildFullSquadBenchInvite({ matchName: "Tuesday 7-a-side", confirmedCount: 14, maxPlayers: 14, mentionReactions, lang }));
    add(`R55 buildBenchAskedLine / ${tag}`, buildBenchAskedLine({ benchName: "Erdal Ozkan", confirmedCount: 13, maxPlayers: 14, mentionReactions, lang }));
    add(`R56 benchClaimPhrasingExample / ${tag}`, benchClaimPhrasingExample({ mentionReactions }));
  }
  add("R85 buildBenchOfferDm / no first name", buildBenchOfferDm({ firstName: "", context: lang === "en" ? "on Red for Tuesday 7-a-side tonight" : ctxFixture.plain, lang }));

  // ── 1.1 rating-progress-answer.ts ───────────────────────────────────
  add("R59 formatRatingProgressReply / not ok, no reason", formatRatingProgressReply({ ok: false }, lang));

  // ── 1.1 mom-announcement.ts ─────────────────────────────────────────
  add("R45 buildMomAnnouncement / single winner", buildMomAnnouncement({ mvpLabel: "Man of the Match", activityName: "Tuesday 7-a-side", tally: [{ name: "Sait Demir", votes: 6 }, { name: "Kemal Ediz", votes: 3 }, { name: "Abid Hussain", votes: 1 }], lang }));
  add("R45 buildMomAnnouncement / shared by two", buildMomAnnouncement({ mvpLabel: "Man of the Match", activityName: "Tuesday 7-a-side", tally: [{ name: "Sait Demir", votes: 4 }, { name: "Kemal Ediz", votes: 4 }, { name: "Abid Hussain", votes: 2 }], lang }));
  add("R45 buildMomAnnouncement / shared by three", buildMomAnnouncement({ mvpLabel: "Player of the Match", activityName: "Thursday 5-a-side", tally: [{ name: "Sait Demir", votes: 1 }, { name: "Kemal Ediz", votes: 1 }, { name: "Abid Hussain", votes: 1 }], lang }));
  add("R45 buildMomAnnouncement / one vote in total", buildMomAnnouncement({ mvpLabel: "Man of the Match", activityName: "Tuesday 7-a-side", tally: [{ name: "Sait Demir", votes: 1 }], lang }));

  // ── 1.1 format-switch.ts ────────────────────────────────────────────
  const facts = buildFormatSwitchFacts({
    confirmedNames: ["Kemal Ediz", "Elvin Aliyev", "Sait Demir", "Mustafa Kaya", "Abid Hussain", "Idris Bello", "Faris Nasser", "Shaz Iqbal", "Adam Osman", "Efat Rahman", "Usama Tariq", "Karahan Yildiz"],
    currentMaxPlayers: 14,
    alternatives: [
      { sportName: "Football 5-a-side", totalPlayers: 10 },
      { sportName: "Football 6-a-side", totalPlayers: 12 },
      { sportName: "Football 7-a-side", totalPlayers: 14 },
      { sportName: "Futsal", totalPlayers: 11 },
    ],
    lang,
  });
  facts.forEach((f) => add(`R46 format-switch proposal / ${f.sportName}`, f.proposal));
  add("R46 renderFormatSwitchContext (prompt lines)", renderFormatSwitchContext(facts).join("\n"));

  // ── 1.1 format-switch-time.ts ───────────────────────────────────────
  add("R47 renderKickoffMoveLine / moved", renderKickoffMoveLine({ move: true, reason: "moved", previousKickoff: new Date("2026-09-08T20:30:00.000Z"), kickoff: new Date("2026-09-08T20:15:00.000Z"), attendanceDeadline: new Date("2026-09-08T20:15:00.000Z") }, lang));
  add("R47 renderKickoffMoveLine / not moved", renderKickoffMoveLine({ move: false, reason: "same-time" }, lang));

  // ── 1.1 out-of-band-attendance.ts ───────────────────────────────────
  for (const status of ["CONFIRMED", "BENCH", "DROPPED"] as const) {
    for (const source of ["dm", "app", "reaction"] as const) {
      add(`R48 buildOutOfBandAttendanceLine / ${status} via ${source}`, buildOutOfBandAttendanceLine({ playerName: "Sait Demir", status, source, confirmedCount: 12, maxPlayers: 14, lang }));
    }
  }
  add("R48 buildOutOfBandAttendanceLine / no name", buildOutOfBandAttendanceLine({ playerName: null, status: "CONFIRMED", source: "dm", confirmedCount: 12, maxPlayers: 14, lang }));

  // ── 1.1 unresolved-nudge.ts ─────────────────────────────────────────
  add("R50 planUnresolvedNudge / named, joining", planUnresolvedNudge({ senderResolved: false, attendanceRelevant: true, matchId: "m-1", authorName: "Tommy T", dropping: false, lang }).reply);
  add("R50 planUnresolvedNudge / named, dropping", planUnresolvedNudge({ senderResolved: false, attendanceRelevant: true, matchId: "m-1", authorName: "Tommy T", dropping: true, lang }).reply);
  add("R50 planUnresolvedNudge / anonymous, joining", planUnresolvedNudge({ senderResolved: false, attendanceRelevant: true, matchId: "m-1", authorName: null, dropping: false, lang }).reply);
  add("R50 planUnresolvedNudge / anonymous, dropping", planUnresolvedNudge({ senderResolved: false, attendanceRelevant: true, matchId: "m-1", authorName: "447700900123", dropping: true, lang }).reply);

  // ── 1.1 guest-name-ask.ts (also reached via compose above) ──────────
  add("R44 renderGuestNameAsk / plural, no name", renderGuestNameAsk({ askerName: null, body: "bringing 2 friends", lang }));

  // ── 1.1 stats-blast.ts ──────────────────────────────────────────────
  add("R100 composeStatsBlastDm / named", composeStatsBlastDm("Sait Demir", "https://mt.example/s/abc", lang));
  add("R100 composeStatsBlastDm / no name", composeStatsBlastDm(null, "https://mt.example/s/abc", lang));
  add("R51 composeStatsBlastReply / one", composeStatsBlastReply(1, lang));
  add("R51 composeStatsBlastReply / twelve", composeStatsBlastReply(12, lang));

  // ── 1.1 block-booking.ts ────────────────────────────────────────────
  add("R63 buildBulkCancelAnnouncement / one match", buildBulkCancelAnnouncement({ activityName: "Tuesday 7-a-side", dates: [new Date("2026-09-15T20:30:00.000Z")], announce: true, lang }));
  add("R63 buildBulkCancelAnnouncement / two matches", buildBulkCancelAnnouncement({ activityName: "Tuesday 7-a-side", dates: [new Date("2026-09-22T20:30:00.000Z"), new Date("2026-09-15T20:30:00.000Z")], announce: true, lang }));
  add("R63 buildBulkCancelAnnouncement / silent", buildBulkCancelAnnouncement({ activityName: "Tuesday 7-a-side", dates: [new Date("2026-09-15T20:30:00.000Z")], announce: false, lang }));

  // ── 1.1 attendance-write-outcome.ts ─────────────────────────────────
  add("R58 buildAttendanceFailureReply / own OUT", buildAttendanceFailureReply([{ action: "OUT", who: null, error: "boom" }], "Sait Demir", lang));
  add("R58 buildAttendanceFailureReply / own IN", buildAttendanceFailureReply([{ action: "IN", who: null, error: "boom" }], "Sait Demir", lang));
  add("R58 buildAttendanceFailureReply / others only", buildAttendanceFailureReply([{ action: "IN", who: "Abid Hussain", error: "boom" }, { action: "OUT", who: "Idris Bello", error: "boom" }], "Sait Demir", lang));
  add("R58 buildAttendanceFailureReply / own and others", buildAttendanceFailureReply([{ action: "IN", who: null, error: "boom" }, { action: "BENCH", who: "Abid Hussain", error: "boom" }], "Sait Demir", lang));
  add("R58 buildAttendanceFailureReply / no usable name", buildAttendanceFailureReply([{ action: "IN", who: null, error: "boom" }], "447700900123", lang));

  // ── 1.4 admin-ops-engine.ts ─────────────────────────────────────────
  add("R132 composeReminderDm / named", composeReminderDm({ name: "Sait Demir", note: "book the pitch for Thursday", lang }));
  add("R132 composeReminderDm / no name", composeReminderDm({ name: null, note: "book the pitch for Thursday", lang }));
  const payment = (over: Partial<PaymentApplyResult>): PaymentApplyResult => ({
    write: { count: 3 } as PaymentApplyResult["write"],
    ok: true,
    matchName: "Tuesday 7-a-side",
    creditedNames: ["Abid Hussain", "Idris Bello", "Faris Nasser"],
    unmatchedUserIds: [],
    confirmedCount: 14,
    unpaidAfter: 6,
    ...over,
  });
  add("R133 composePaymentAck / named", composePaymentAck(payment({}), "Sait Demir", lang));
  add("R133 composePaymentAck / count only", composePaymentAck(payment({ creditedNames: [] }), "Sait Demir", lang));
  add("R133 composePaymentAck / one, some ignored", composePaymentAck(payment({ creditedNames: ["Abid Hussain"], unmatchedUserIds: ["u-x", "u-y"], write: { count: 1 } as PaymentApplyResult["write"] }), "Sait Demir", lang));

  // ── 1.4 team-ops-engine.ts ──────────────────────────────────────────
  add("R134 TEAM_OPS_NO_MATCH_REPLY", teamOpsNoMatchReply(lang));
  add("R134 composeBalancerRefusal", composeBalancerRefusal("not enough confirmed players, 9/14", lang));
  const sheet = "*Red*:\n1. Kemal Ediz\n2. Sait Demir\n\n*Yellow*:\n1. Elvin Aliyev\n2. Abid Hussain";
  add("R134 composeGenerateTeamsReply / plain", composeGenerateTeamsReply({ groupPost: sheet, includedNames: [], pinnedLog: [], unmatchedIncludes: [], unmatchedPins: [], lang }));
  add("R134 composeGenerateTeamsReply / all four notes", composeGenerateTeamsReply({ groupPost: sheet, includedNames: ["Erdal Ozkan"], pinnedLog: ["Kemal Ediz → RED"], unmatchedIncludes: ["Bob"], unmatchedPins: ["Jim"], lang }));

  // ── 1.3 DM builders ─────────────────────────────────────────────────
  //    Dates are pre-formatted by the callers, so each language gets its
  //    own shape here (`dayCommaTimeLabel`).
  const W = lang === "tr" ? "8 Eylül Salı 21:30" : "Tue 8 Sep, 21:30";
  const W2 = lang === "tr" ? "10 Eylül Perşembe 20:00" : "Thu 10 Sep, 20:00";
  for (const mentionReactions of [false, true]) {
    const tag = mentionReactions ? "reactions on" : "reactions off";
    add(`R93 buildRecruitInviteDm / ${tag}, two spots, link`, buildRecruitInviteDm({ firstName: "Sait", matchName: "Tuesday 7-a-side", matchWhen: W, spotsLeft: 2, link: "https://mt.example/m/abc", mentionReactions, lang }));
  }
  add("R93 buildRecruitInviteDm / one spot, no link", buildRecruitInviteDm({ firstName: "Sait", matchName: "Tuesday 7-a-side", matchWhen: W, spotsLeft: 1, link: null, lang }));
  add("R93 buildRecruitInviteDm / spots suppressed", buildRecruitInviteDm({ firstName: "Sait", matchName: "Tuesday 7-a-side", matchWhen: W, spotsLeft: 0, link: null, lang }));
  add("R94 buildRecruitGroupInviteDm", buildRecruitGroupInviteDm({ firstName: "Sait", matchName: "Thursday 5-a-side", matchWhen: W2, lang }));
  add("R84 buildRecruitChaseText / one", buildRecruitChaseText({ playerName: "Sait Demir", activityName: "Tuesday 7-a-side", matchWhen: W, need: 1, lang }));
  add("R84 buildRecruitChaseText / three", buildRecruitChaseText({ playerName: "Sait Demir", activityName: "Tuesday 7-a-side", matchWhen: W, need: 3, lang }));
  add("R84 buildRecruitChaseText / no name", buildRecruitChaseText({ playerName: null, activityName: "Tuesday 7-a-side", matchWhen: W, need: 2, lang }));
  add("R102 buildTentativeFollowupAck / in", buildTentativeFollowupAck({ decision: "in", failed: false, lang }));
  add("R102 buildTentativeFollowupAck / out", buildTentativeFollowupAck({ decision: "out", failed: false, lang }));
  add("R102 buildTentativeFollowupAck / failed", buildTentativeFollowupAck({ decision: "in", failed: true, lang }));
  for (const status of ["CONFIRMED", "BENCH", "DROPPED", null] as const) {
    add(`R101 buildSelfAttendanceAck / ${status ?? "no row"}`, buildSelfAttendanceAck({ failed: false, status, matchName: "Tuesday 7-a-side", matchWhen: W, lang }));
  }
  add("R101 buildSelfAttendanceAck / failed", buildSelfAttendanceAck({ failed: true, status: null, matchName: "Tuesday 7-a-side", matchWhen: W, lang }));
  for (const kind of ["opt-out-all", "opt-out-ratings", "opt-in-all", "opt-in-ratings"] as const) {
    add(`R99 dmSubAckMessage / ${kind}`, dmSubAckMessage(kind, lang));
  }

  // ── 1.4 onboarding and help ─────────────────────────────────────────
  const ALL_ON = { attendance: true, teamBalancing: true, momVoting: true, playerRating: true, statsQa: true, reminders: true, bench: true, paymentTracking: true };
  const MINIMAL = { attendance: true, teamBalancing: false, momVoting: false, playerRating: false, statsQa: false, reminders: false, bench: false, paymentTracking: false };
  const LIST_MODE = { ...ALL_ON, attendance: false, paymentTracking: false };
  add("R135 BOT_ADDED_INTRO", BOT_ADDED_INTRO);
  add("R141 buildHowToUseMe / everything on", buildHowToUseMe(ALL_ON));
  add("R141 buildHowToUseMe / attendance only", buildHowToUseMe(MINIMAL));
  add("R141 buildHowToUseMe / squad-from-list shape", buildHowToUseMe(LIST_MODE));
  add("R143 buildHelpReply / bare, everything on", buildHelpReply(null, ALL_ON));
  add("R143 buildHelpReply / bare, attendance only", buildHelpReply(null, MINIMAL));
  for (const topic of ["availability", "teams", "mom", "ratings", "reminders", "payments"] as const) {
    add(`R142 buildHelpReply / ${topic}`, buildHelpReply(topic, ALL_ON));
  }
  add("R143 buildHelpReply / topic switched off", buildHelpReply("payments", MINIMAL));
  add("R138 detailsFollowUpQuestion / all three missing", detailsFollowUpQuestion(["day", "time", "venue"]));
  add("R138 detailsFollowUpQuestion / day only", detailsFollowUpQuestion(["day"]));
  add("R138 detailsFollowUpQuestion / time and venue", detailsFollowUpQuestion(["time", "venue"]));

  // ── 1.4 the group-add flow's other turns (pinned 2026-09-17, before
  //    the self-setup rework; extracted as pure builders for the pin) ──
  add("R138 ADMIN_QUESTION", ADMIN_QUESTION);
  add("R138 buildConsentAck / admin captured", buildConsentAck(true));
  add("R138 buildConsentAck / no admin", buildConsentAck(false));
  add("R138 buildAdminsAck / none", buildAdminsAck(0));
  add("R138 buildAdminsAck / one", buildAdminsAck(1));
  add("R138 buildAdminsAck / two", buildAdminsAck(2));
  const completion = { groupName: "Tuesday Ballers FC", chosen: [...RECOMMENDED_BUNDLE], dayOfWeek: 2, kickoffTime: "21:00", venue: "Goals Wembley", weekly: true };
  add("R140 buildGroupAddCompletionPost / roster, no co-admins, DM queued", buildGroupAddCompletionPost({ ...completion, rosterCount: 12, adminsAdded: 0, adminDmQueued: true, adminName: "Adam Admin" }));
  add("R140 buildGroupAddCompletionPost / one person, two co-admins, no DM, no name", buildGroupAddCompletionPost({ ...completion, rosterCount: 1, adminsAdded: 2, adminDmQueued: false, adminName: null }));
  add("R140 buildGroupAddCompletionPost / everything, one-off, empty roster, one co-admin", buildGroupAddCompletionPost({ ...completion, chosen: [...EVERYTHING_BUNDLE], weekly: false, rosterCount: 0, adminsAdded: 1, adminDmQueued: true, adminName: "" }));
  add("R140 buildGroupAddCompletionPost / no group name", buildGroupAddCompletionPost({ ...completion, groupName: null, rosterCount: 0, adminsAdded: 0, adminDmQueued: false, adminName: null }));
  add("R140 buildLegacyCompletionPost / weekly", buildLegacyCompletionPost(completion, lang));
  add("R140 buildLegacyCompletionPost / one-off, MoM and ratings only", buildLegacyCompletionPost({ ...completion, chosen: ["momVoting", "playerRating"], weekly: false }, lang));
  add("R118 buildAdminMagicLinkDm / no payments", buildAdminMagicLinkDm({ groupName: "Tuesday Ballers FC", url: "https://mt.example/s/abc", payments: false }));
  add("R118 buildAdminMagicLinkDm / payments", buildAdminMagicLinkDm({ groupName: "Tuesday Ballers FC", url: "https://mt.example/s/abc", payments: true }));
  add("R118 buildAdminMagicLinkDm / no group name", buildAdminMagicLinkDm({ groupName: null, url: "https://mt.example/s/abc", payments: false }));
  add("R118 buildCoAdminMagicLinkDm", buildCoAdminMagicLinkDm({ groupName: "Tuesday Ballers FC", url: "https://mt.example/s/abc" }));
  add("R118 buildCoAdminMagicLinkDm / no group name", buildCoAdminMagicLinkDm({ groupName: null, url: "https://mt.example/s/abc" }));
  add("R119 buildEnrichmentReviewDm", buildEnrichmentReviewDm({ messagesAnalyzed: 340, groupName: "Tuesday Ballers FC", playerCount: 17, url: "https://mt.example/s/abc" }));
  add("R119 buildEnrichmentReviewDm / no group name", buildEnrichmentReviewDm({ messagesAnalyzed: 12, groupName: null, playerCount: 3, url: "https://mt.example/s/abc" }));

  // ── 1.1 bench-upgrade-ack.ts (dead since 2026-09-06, still pure) ────
  add("R57 buildBenchUpgradeReply / space", buildBenchUpgradeReply({ name: "Erdal Ozkan", confirmedCount: 12, maxPlayers: 14 }));
  add("R57 buildBenchUpgradeReply / last slot", buildBenchUpgradeReply({ name: "Erdal Ozkan", confirmedCount: 14, maxPlayers: 14 }));
  add("R57 buildBenchUpgradeReply / no name", buildBenchUpgradeReply({ name: null, confirmedCount: 12, maxPlayers: 14 }));

  // ── R36 reminder-time.ts: the label the reminder ack interpolates ───
  const now = new Date("2026-09-08T10:00:00.000Z"); // Tue 8 Sep 11:00 London
  for (const phrase of ["thursday", "tomorrow morning", "in 2 hours", "friday at 6pm", "in a week"]) {
    const r = resolveReminderPhrase(phrase, now, lang);
    add(`R36 resolveReminderPhrase whenLabel / "${phrase}"`, r.ok ? r.whenLabel : `(not resolved: ${r.reason})`);
  }

  // ── R98 fee-confirm.ts: the prompt that embeds the collector prompt ─
  add("R98 FEE_REPLY_SYSTEM_PROMPT", lang === "en" ? FEE_REPLY_SYSTEM_PROMPT : buildFeeReplySystemPrompt(lang));

  // ── Phase 3: the private messages, extracted as pure builders
  //    (dm-copy.ts, 2026-09-17) and pinned HERE, in English, before any
  //    of them moved into the string table. ────────────────────────────
  add("R91 buildRatingDm", buildRatingDm({ activityName: "Tuesday 7-a-side", dateLabel: lang === "tr" ? "8 Eylül Salı" : "Tue 8 Sep", mvpLabel: "Man of the Match", rateUrl: "https://mt.example/s/rate", statsUrl: "https://mt.example/s/stats", lang }));
  for (const dayNum of [1, 2, 3, 4, 5]) {
    add(`R92 buildRatingReminderDm / day ${dayNum}`, buildRatingReminderDm({ dayNum, playerName: "Sait Demir", activityName: "Tuesday 7-a-side", mvpLabel: "Man of the Match", url: "https://mt.example/s/rate", lang }));
  }
  add("R92 buildRatingReminderDm / no name", buildRatingReminderDm({ dayNum: 1, playerName: null, activityName: "Tuesday 7-a-side", mvpLabel: "Man of the Match", url: "https://mt.example/s/rate", lang }));
  add("R83 buildTentativeFollowupDm", buildTentativeFollowupDm({ playerName: "Sait Demir", activityName: "Tuesday 7-a-side", whenLabel: lang === "tr" ? "8 Eylül Salı 21:30" : "Tue 8 Sep at 21:30", lang }));
  add("R83 buildTentativeFollowupDm / no name", buildTentativeFollowupDm({ playerName: null, activityName: "Tuesday 7-a-side", whenLabel: lang === "tr" ? "8 Eylül Salı 21:30" : "Tue 8 Sep at 21:30", lang }));
  add("R88 buildFeeAskDm / fourteen played", buildFeeAskDm({ collectorName: "Kemal Ediz", activityName: "Tuesday 7-a-side", headcount: 14, lang }));
  add("R88 buildFeeAskDm / nobody, no name", buildFeeAskDm({ collectorName: null, activityName: "Tuesday 7-a-side", headcount: 0, lang }));
  for (const dayNum of [1, 2, 3]) {
    add(`R89 buildPayChaseDm / day ${dayNum}`, buildPayChaseDm({ playerName: "Sait Demir", dayNum, fee: 8.5, activityName: "Tuesday 7-a-side", url: "https://mt.example/s/pay", lang }));
  }
  add("R89 buildPayChaseDm / no name, whole pounds", buildPayChaseDm({ playerName: null, dayNum: 1, fee: 8, activityName: "Tuesday 7-a-side", url: "https://mt.example/s/pay", lang }));
  add("R90 buildDirectPayCollectorNudge / one", buildDirectPayCollectorNudge({ count: 1, activityName: "Tuesday 7-a-side", url: "https://mt.example/s/collect", lang }));
  add("R90 buildDirectPayCollectorNudge / three", buildDirectPayCollectorNudge({ count: 3, activityName: "Tuesday 7-a-side", url: "https://mt.example/s/collect", lang }));
  add("R95 buildPayLinkDm", buildPayLinkDm({ playerName: "Sait Demir", activityName: "Tuesday 7-a-side", fee: 8, url: "https://mt.example/s/pay", lang }));
  add("R95 buildPayLinkDm / no name, pence", buildPayLinkDm({ playerName: null, activityName: "Tuesday 7-a-side", fee: 7.5, url: "https://mt.example/s/pay", lang }));
  add("R96 buildFeeReleasedAck / one", buildFeeReleasedAck({ released: 1, fee: 8, matchName: "Tuesday 7-a-side", lang }));
  add("R96 buildFeeReleasedAck / thirteen", buildFeeReleasedAck({ released: 13, fee: 8.5, matchName: "Tuesday 7-a-side", lang }));
  add("R97 buildFeeCancelledAck", buildFeeCancelledAck(lang));
  add("R98 buildFeeConfirmPrompt / per player", buildFeeConfirmPrompt({ perPlayer: 8, headcount: 13, matchName: "Tuesday 7-a-side", wasTotal: false, lang }));
  add("R98 buildFeeConfirmPrompt / total split", buildFeeConfirmPrompt({ perPlayer: 7.69, headcount: 13, matchName: "Tuesday 7-a-side", wasTotal: true, lang }));
  add("R98 buildFeeConfirmPrompt / one player", buildFeeConfirmPrompt({ perPlayer: 8, headcount: 1, matchName: "Tuesday 7-a-side", wasTotal: true, lang }));
  add("R98 buildFeeConfirmPrompt / nobody to charge", buildFeeConfirmPrompt({ perPlayer: 8, headcount: 0, matchName: "Tuesday 7-a-side", wasTotal: false, lang }));
  add("R103 buildBenchDmUnclear", buildBenchDmUnclear(lang));
  for (const kind of ["declined", "confirmed", "taken", "other"] as const) {
    add(`R104 buildBenchDmAck / ${kind}`, buildBenchDmAck(kind, lang));
  }
  add("R105 buildTentativeReask", buildTentativeReask(lang));
  add("R106 buildAdminRecruitDmReply / invited three, two spots", buildAdminRecruitDmReply({ ok: true, invited: 3, matchName: "Tuesday 7-a-side", matchWhen: W, need: 2 }, lang));
  add("R106 buildAdminRecruitDmReply / invited one, one spot", buildAdminRecruitDmReply({ ok: true, invited: 1, matchName: "Tuesday 7-a-side", matchWhen: W, need: 1 }, lang));
  add("R106 buildAdminRecruitDmReply / invited, need unknown", buildAdminRecruitDmReply({ ok: true, invited: 2, matchName: "Tuesday 7-a-side", matchWhen: W }, lang));
  add("R107 buildAdminRecruitDmReply / nobody new", buildAdminRecruitDmReply({ ok: true, invited: 0, matchName: "Tuesday 7-a-side", matchWhen: W }, lang));
  add("R108 buildAdminRecruitDmReply / not ok, no reason", buildAdminRecruitDmReply({ ok: false }, lang));
  add("R109 buildRosterSurveyClarification", buildRosterSurveyClarification({ firstName: "Sait", orgName: "Sutton FC", lang }));
  add("R109 rosterSurveyClarificationProbe", rosterSurveyClarificationProbe("Sait", lang));
  for (const category of ["in", "maybe", "out"] as const) {
    add(`R110 buildRosterSurveyConfirmation / ${category}`, buildRosterSurveyConfirmation({ category, firstName: "Sait", lang }));
  }
  add("R109b buildRosterSurveyInviteDm", buildRosterSurveyInviteDm({ firstName: "Sait", orgName: "Sutton FC", lang }));
  add("R111 buildDmQaApology", buildDmQaApology(lang));
  add("R122 buildStatsLinkDm / named", buildStatsLinkDm({ name: "Sait Demir", url: "https://mt.example/s/stats", lang }));
  add("R122 buildStatsLinkDm / no name", buildStatsLinkDm({ name: null, url: "https://mt.example/s/stats", lang }));

  // ── Phase 3c: the legacy "@Match Time setup" flow (pinned before it moved) ──
  add("R136 buildLegacySetupIntro", buildLegacySetupIntro(lang));
  const legacy = { groupName: null as string | null, playersPerSide: null as number | null, dayOfWeek: null as number | null, kickoffTime: null as string | null, venue: null as string | null, recurrence: null as string | null, oneOffDate: null as string | null };
  add("R137 legacyEventQuestion / name", String(legacyEventQuestion(legacy, lang)));
  add("R137 legacyEventQuestion / players per side", String(legacyEventQuestion({ ...legacy, groupName: "Tuesday Ballers FC" }, lang)));
  add("R137 legacyEventQuestion / day", String(legacyEventQuestion({ ...legacy, groupName: "Tuesday Ballers FC", playersPerSide: 7 }, lang)));
  add("R137 legacyEventQuestion / time", String(legacyEventQuestion({ ...legacy, groupName: "Tuesday Ballers FC", playersPerSide: 7, dayOfWeek: 2 }, lang)));
  add("R137 legacyEventQuestion / venue", String(legacyEventQuestion({ ...legacy, groupName: "Tuesday Ballers FC", playersPerSide: 7, dayOfWeek: 2, kickoffTime: "21:00" }, lang)));
  add("R137 legacyEventQuestion / recurrence", String(legacyEventQuestion({ ...legacy, groupName: "Tuesday Ballers FC", playersPerSide: 7, dayOfWeek: 2, kickoffTime: "21:00", venue: "Goals Wembley" }, lang)));
  add("R137 legacyEventQuestion / one-off date", String(legacyEventQuestion({ ...legacy, groupName: "Tuesday Ballers FC", playersPerSide: 7, dayOfWeek: 2, kickoffTime: "21:00", venue: "Goals Wembley", recurrence: "oneoff" }, lang)));
  add("R139 buildLegacyFeatureMenu / provisioned", buildLegacyFeatureMenu(buildLegacyProvisionedLead({ groupName: "Tuesday Ballers FC", playersPerTeam: 7, dayOfWeek: 2, kickoffTime: "21:00", venue: "Goals Wembley" }, lang), lang));
  add("R139 buildLegacyFeatureMenu / retry", buildLegacyFeatureMenu(legacyMenuRetryLead(lang), lang));

  return c;
}

function render(lang: Lang): string {
  const all = cases(lang);
  const head =
    `# MatchTime outbound copy, language "${lang}"\n` +
    `# ${all.length} rendered cases. Generated by copy-golden.test.ts; re-record only on purpose.\n` +
    (lang === "en"
      ? ""
      : `# A case that still reads as English here is a composer not yet moved into the string table.\n`);
  return head + all.map((k) => `\n### ${k.id}\n${k.text}\n`).join("");
}

/** The inventory rows moved into the string table so far. A case with one
 *  of these prefixes must render DIFFERENTLY in Turkish; every other case
 *  is allowed to (and today does) render English in both documents.
 *  Extend it with every slice; the second Turkish test below then proves
 *  the slice translated what it moved. */
/** Cases under a migrated row whose text is the SAME in every language by
 *  design, each with its reason. */
const LANGUAGE_FREE_CASES = new Set([
  // The model's own reply, passed through untouched: it neither shows
  // nor contradicts squad state, so the composer has nothing to say.
  "R1 composeSquadStateReply / plain reply kept",
  // The kickoff-move line is empty when the kickoff did not move.
  "R47 renderKickoffMoveLine / not moved",
  // A team sheet is names and labels only (the labels are the org's).
  "R127 buildTeamSheet",
  // The prompt lines the chase model copies stay English until slice 3
  // gives the chase its language line; the proposal inside them is in
  // the group's language already (`format_switch_proposal`).
  "R46 renderFormatSwitchContext (prompt lines)",
  // A generate-teams reply with no notes is the balancer's sheet alone,
  // which is names and the org's labels.
  "R134 composeGenerateTeamsReply / plain",
]);

const MIGRATED_ROWS = [
  // slice 1
  "R1 ", "R2 ", "R3 ", "R4 ", "R31 ", "R38 ", "R39 ", "R43 ", "R52 ", "R68 ", "R69 ", "R70 ", "R71 ", "R72 ", "R73 ", "R78 ", "R81 ",
  // slice 2: every remaining group-facing row of the design's inventory
  "R5 ", "R6 ", "R7 ", "R8 ", "R9 ", "R10 ", "R11 ", "R12 ", "R13 ", "R14 ", "R15 ", "R16 ", "R17 ", "R18 ", "R19 ", "R20 ",
  "R21 ", "R22 ", "R23 ", "R24 ", "R25 ", "R26 ", "R27 ", "R28 ", "R29 ", "R30 ", "R32 ", "R33 ", "R34 ", "R35 ", "R36 ", "R37 ",
  "R40 ", "R41 ", "R42 ", "R44 ", "R45 ", "R46 ", "R47 ", "R48 ", "R49 ", "R50 ", "R51 ", "R53 ", "R54 ", "R55 ", "R58 ", "R59 ",
  "R60 ", "R61 ", "R62 ", "R63 ", "R64 ", "R65 ", "R66 ", "R67 ", "R74 ", "R75 ", "R76 ", "R77 ", "R123 ", "R124 ", "R125 ",
  "R126 ", "R128 ", "R129 ", "R130 ", "R131 ", "R133 ", "R134 ",
  // Phase 3: the private messages
  "R83 ", "R84 ", "R85 ", "R88 ", "R89 ", "R90 ", "R91 ", "R92 ", "R93 ", "R94 ", "R95 ", "R96 ", "R97 ", "R98 ",
  "R99 ", "R100 ", "R101 ", "R102 ", "R103 ", "R104 ", "R105 ", "R106 ", "R107 ", "R108 ", "R109 ", "R109b ", "R110 ",
  "R111 ", "R122 ", "R132 ",
  // Phase 3c: the legacy setup flow
  "R136 ", "R137 ", "R139 ",
];

describe("English copy is byte-identical to the committed snapshot", () => {
  it("every pure composer, rendered", async () => {
    await expect(render("en")).toMatchFileSnapshot("./__snapshots__/copy.en.snap");
  });

  it("renders a useful number of cases (a regression here means a case was dropped)", () => {
    expect(cases("en").length).toBeGreaterThanOrEqual(150);
  });

  it("no case rendered an empty string", () => {
    for (const k of cases("en")) {
      expect(k.text.length, k.id).toBeGreaterThan(0);
    }
  });
});

describe("Turkish copy, the owner's review artefact", () => {
  it("every pure composer, rendered in Turkish where it has been moved", async () => {
    await expect(render("tr")).toMatchFileSnapshot("./__snapshots__/copy.tr.snap");
  });

  it("every migrated composer renders differently in Turkish (it is translated)", () => {
    const enById = new Map(cases("en").map((k) => [k.id, k.text]));
    for (const k of cases("tr")) {
      if (!MIGRATED_ROWS.some((r) => k.id.startsWith(r))) continue;
      if (LANGUAGE_FREE_CASES.has(k.id)) continue;
      // A reminder phrase the resolver refuses says so in the same words
      // in every language (it is a log reason, not copy).
      if (k.id.startsWith("R36 resolveReminderPhrase") && k.text.startsWith("(not resolved")) continue;
      // A composer that says nothing, or returns null, does so in every language.
      if (k.text === "(says nothing)" || k.text === "(null)" || k.text === "(empty string)") continue;
      expect(k.text, k.id).not.toBe(enById.get(k.id));
    }
  });

  it("no migrated Turkish case carries an English instruction token", () => {
    for (const k of cases("tr")) {
      if (!MIGRATED_ROWS.some((r) => k.id.startsWith(r))) continue;
      if (LANGUAGE_FREE_CASES.has(k.id)) continue;
      expect(k.text, k.id).not.toMatch(/\*IN\*|\bsay IN\b|Say \*IN\*|\*Playing|\*Bench \(|\*Confirmed \(/);
    }
  });
});
