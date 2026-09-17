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
 *     `copy.tr.snap` in Phase 2 (the owner's Turkish review artefact).
 *     Until a composer reads `t(lang)`, the Turkish document is
 *     identical to the English one and is not committed.
 *
 *   - Known re-record: `src/lib/squad-announce.ts` (the "Squad
 *     complete" post) is NOT in this file because its text is built
 *     inline in a DB-bound function; it is being changed in parallel
 *     (a bench invite is being added). When a pure builder is
 *     extracted for it, add it here and record it on purpose.
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
 *   src/lib/bot-scheduler.ts     :191 buildReminderText, :300 buildUnpaidTail,
 *                                :316 buildSquadRosterBlock, :402 botIntroMessage
 *                                (pure but not exported), and the inline posts at
 *                                :540, :688, :948, :1049, :1062, :1324, :1433,
 *                                :1474, :1531, :1556, :1581, :1607, :1637, :1688,
 *                                :1746, :1781, :1867
 *   src/lib/squad-announce.ts    :72  the "Squad complete" post (see above)
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
  composeSquadStateReply,
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
  TEAM_OPS_NO_MATCH_REPLY,
  composeBalancerRefusal,
  composeGenerateTeamsReply,
} from "../../team-ops-engine";
import { buildRecruitGroupInviteDm, buildRecruitInviteDm } from "../../recruit";
import { buildRecruitChaseText } from "../../recruit-chase";
import { buildTentativeFollowupAck } from "../../tentative-followup";
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
  buildGroupAddCompletionPost,
  buildHelpReply,
  buildHowToUseMe,
  buildLegacyCompletionPost,
} from "../../onboarding-conversation";
import { RECOMMENDED_BUNDLE, EVERYTHING_BUNDLE } from "../../onboarding-parse";
import { detailsFollowUpQuestion } from "../../onboarding-parse";
import { buildBenchUpgradeReply } from "../../bench-upgrade-ack";
import { resolveReminderPhrase } from "../../reminder-time";
import { FEE_REPLY_SYSTEM_PROMPT } from "../../fee-confirm";

// ── The three worlds ─────────────────────────────────────────────────

const ELEVEN = [
  "kemal", "elvin", "sait", "mustafa", "abid", "idris",
  "faris", "shaz", "adam", "efat", "usama",
];
const FOURTEEN = [...ELEVEN, "karahan", "zair", "wasim"];

/** 11 of 14 confirmed, two on the bench, one dropped. */
function shortWorld(over: Parameters<typeof world>[0] = {}): SquadState {
  return world({
    confirmed: ELEVEN,
    bench: ["erdal", "amir"],
    dropped: ["habib"],
    ...over,
  });
}

/** 14 of 14 confirmed, one on the bench. */
function fullWorld(over: Parameters<typeof world>[0] = {}): SquadState {
  return world({ confirmed: FOURTEEN, bench: ["najib"], ...over });
}

/** Full, with teams generated. */
function teamsWorld(): SquadState {
  const teams: Record<string, "RED" | "YELLOW"> = {};
  FOURTEEN.forEach((k, i) => (teams[k] = i % 2 === 0 ? "RED" : "YELLOW"));
  return fullWorld({ teams });
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
// `lang` is threaded through so the Turkish document can be produced by
// the same cases in Phase 2. Nothing reads it yet: Phase 0 has no
// composer that takes a language, and that is the point of this file.

interface Case {
  /** Design inventory row(s), then a short name. */
  id: string;
  text: string;
}

function cases(lang: Lang): Case[] {
  void lang;
  const c: Case[] = [];
  // A builder that returns null or "" on purpose (a line that is omitted)
  // is recorded as such, so the document says what happened.
  const add = (id: string, text: string | null) =>
    c.push({ id, text: text === null ? "(null)" : text === "" ? "(empty string)" : text });

  const short = shortWorld();
  const full = fullWorld();
  const teams = teamsWorld();

  // ── 1.1 compose.ts, one case per speech kind and branch ─────────────
  add("R1 squad_status / short with bench", say(short, { kind: "squad_status", messageId: null }));
  add("R1 squad_status / full", say(full, { kind: "squad_status", messageId: null }));
  add("R1 squad_status / empty squad", say(world(), { kind: "squad_status", messageId: null }));

  add("R6 answer_count / short, no stated count", say(short, { kind: "answer_count", messageId: MSG, statedCount: null }));
  add("R6 answer_count / short, stated count wrong", say(short, { kind: "answer_count", messageId: MSG, statedCount: 9 }));
  add("R6 answer_count / full", say(full, { kind: "answer_count", messageId: MSG, statedCount: null }));

  add("R7 answer_squad / short", say(short, { kind: "answer_squad", messageId: MSG }));

  add("R8 answer_fixture / venue", say(short, { kind: "answer_fixture", messageId: MSG }));
  add("R8 answer_fixture / no venue", say({ ...short, venue: "" }, { kind: "answer_fixture", messageId: MSG }));

  add("R9 answer_score / no played match", say(short, { kind: "answer_score", messageId: MSG }));
  add("R10 answer_score / no score yet", say(shortWorld({ completedMatch: { id: "m-0" } }), { kind: "answer_score", messageId: MSG }));
  add("R11 answer_score / red won", say(shortWorld({ completedMatch: { id: "m-0", redScore: 4, yellowScore: 2 } }), { kind: "answer_score", messageId: MSG }));
  add("R11 answer_score / yellow won", say(shortWorld({ completedMatch: { id: "m-0", redScore: 1, yellowScore: 3 } }), { kind: "answer_score", messageId: MSG }));
  add("R11 answer_score / draw", say(shortWorld({ completedMatch: { id: "m-0", redScore: 2, yellowScore: 2 } }), { kind: "answer_score", messageId: MSG }));

  add("R12 answer_payments / not tracked", say(shortWorld({ payments: { kind: "not_tracked" } }), { kind: "answer_payments", messageId: MSG }));
  add("R13 answer_payments / no settled match", say(shortWorld({ payments: { kind: "no_settled_match" } }), { kind: "answer_payments", messageId: MSG }));
  add("R14 answer_payments / no signal", say(shortWorld({ payments: { kind: "no_signal", kickoffLabel: "Tue 21:30" } }), { kind: "answer_payments", messageId: MSG }));
  add("R15 answer_payments / all settled", say(shortWorld({ payments: { kind: "counted", chargeable: 13, unpaid: 0, kickoffLabel: "Tue 21:30" } }), { kind: "answer_payments", messageId: MSG }));
  add("R16 answer_payments / some unpaid", say(shortWorld({ payments: { kind: "counted", chargeable: 13, unpaid: 4, kickoffLabel: "Tue 21:30" } }), { kind: "answer_payments", messageId: MSG }));
  add("R16 answer_payments / not loaded", say(short, { kind: "answer_payments", messageId: MSG }));

  add("R17 answer_rating_progress / in progress", say(shortWorld({ ratingProgress: { ok: true, matchName: "Tuesday 7-a-side", matchWhen: "Tue 8 Sep", confirmed: 14, ratedCount: 9, momCount: 7, notRated: ["Abid Hussain", "Idris Bello"], ratedNoMom: ["Faris Nasser"] } }), { kind: "answer_rating_progress", messageId: MSG }));
  add("R17 answer_rating_progress / everyone rated", say(shortWorld({ ratingProgress: { ok: true, matchName: "Tuesday 7-a-side", matchWhen: "Tue 8 Sep", confirmed: 14, ratedCount: 14, momCount: 14, notRated: [], ratedNoMom: [] } }), { kind: "answer_rating_progress", messageId: MSG }));
  add("R60 answer_rating_progress / no recent match", say(shortWorld({ ratingProgress: { ok: false, reason: "There's no recent completed match to check yet." } }), { kind: "answer_rating_progress", messageId: MSG }));
  add("R17 answer_rating_progress / not loaded", say(short, { kind: "answer_rating_progress", messageId: MSG }));

  add("R18 answer_bench / empty", say(world({ confirmed: ELEVEN }), { kind: "answer_bench", messageId: MSG }));
  add("R19 answer_bench / two", say(short, { kind: "answer_bench", messageId: MSG }));
  add("R19 answer_bench / one", say(shortWorld({ bench: ["erdal"] }), { kind: "answer_bench", messageId: MSG }));
  add("R19 answer_bench / three", say(shortWorld({ bench: ["erdal", "amir", "zeeshan"] }), { kind: "answer_bench", messageId: MSG }));

  add("R20 answer_person_status / not down", say(short, { kind: "answer_person_status", messageId: MSG, personRef: "Zeeshan", userId: "u-zeeshan" }));
  add("R20 answer_person_status / dropped", say(short, { kind: "answer_person_status", messageId: MSG, personRef: "Habib", userId: "u-habib" }));
  add("R21 answer_person_status / bench", say(short, { kind: "answer_person_status", messageId: MSG, personRef: "Erdal", userId: "u-erdal" }));
  add("R22 answer_person_status / confirmed", say(short, { kind: "answer_person_status", messageId: MSG, personRef: "Sait", userId: "u-sait" }));
  add("R20 answer_person_status / unknown person", say(short, { kind: "answer_person_status", messageId: MSG, personRef: "Bob", userId: null }));
  add("R5 answer_person_status / pushname is a phone number", say(short, { kind: "answer_person_status", messageId: MSG, personRef: "+44 7700 900123", userId: null }));

  add("R23 answer_phones / none missing", say(short, { kind: "answer_phones", messageId: MSG }));
  add("R24 answer_phones / one missing", say(shortWorld({ noPhone: ["sait"] }), { kind: "answer_phones", messageId: MSG }));
  add("R24 answer_phones / three missing", say(shortWorld({ noPhone: ["sait", "abid", "erdal"] }), { kind: "answer_phones", messageId: MSG }));

  add("R25 answer_stats / nothing to go on", say(short, { kind: "answer_stats", messageId: MSG }));
  add("R26 answer_stats / three ranked", say(shortWorld({ appearances: [{ userId: "u-kemal", matches: 4 }, { userId: "u-elvin", matches: 3 }, { userId: "u-sait", matches: 1 }, { userId: "u-abid", matches: 1 }] }), { kind: "answer_stats", messageId: MSG }));

  add("R27 answer_options / full", say(full, { kind: "answer_options", messageId: MSG }));
  add("R28 answer_options / no smaller format", say(short, { kind: "answer_options", messageId: MSG }));
  add("R29 answer_options / none viable", say(shortWorld({ smallerFormats: [{ sportName: "Football 6-a-side", totalPlayers: 12 }] }), { kind: "answer_options", messageId: MSG }));
  add("R30 answer_options / proposals", say(shortWorld({ smallerFormats: [{ sportName: "Football 5-a-side", totalPlayers: 10 }, { sportName: "Football 6-a-side", totalPlayers: 12 }] }), { kind: "answer_options", messageId: MSG }));
  add("R30 answer_options / nobody benched", say(shortWorld({ smallerFormats: [{ sportName: "Futsal", totalPlayers: 11 }] }), { kind: "answer_options", messageId: MSG }));

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
  add("R38 bench_offer_open / bench empty", say(world({ confirmed: ELEVEN }), { kind: "bench_offer_open", messageId: MSG, replacingName: "Sait Demir" }));

  const thirteen = world({ confirmed: FOURTEEN.slice(0, 13) });
  const twelve = world({ confirmed: FOURTEEN.slice(0, 12) });
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
  add("R3 buildRatePromoPost", buildRatePromoPost({ activityName: "Tuesday 7-a-side", matchDateLabel: "Tue 8 Sep" }));
  add("R4 buildMatchDayChaseFallback", buildMatchDayChaseFallback({ need: 3, activityName: "Tuesday 7-a-side" }));
  const truth = { confirmed: ["Kemal Ediz", "Elvin Aliyev"], bench: ["Erdal Ozkan"], maxPlayers: 14 };
  add("R1 composeSquadStateReply / marker with a lead", composeSquadStateReply("Cheers Sait, noted. [SQUAD]", truth).text);
  add("R1 composeSquadStateReply / model roster replaced", composeSquadStateReply("*Playing:*\n1. Kemal\n2. Elvin\n3. Sait", truth).text);
  add("R1 composeSquadStateReply / plain reply kept", composeSquadStateReply("Thanks, noted 👍", truth).text);

  // ── 1.1 bench-offer-copy.ts, both flag branches ─────────────────────
  const ctx = "on *Red* (replacing Sait Demir) for *Tuesday 7-a-side* tonight";
  for (const mentionReactions of [false, true]) {
    const tag = mentionReactions ? "reactions on" : "reactions off";
    add(`R52 buildBenchOfferGroupPost / ${tag}`, buildBenchOfferGroupPost({ context: ctx, tagList: "@447700900001 @447700900002", mentionReactions }));
    add(`R85 buildBenchOfferDm / ${tag}`, buildBenchOfferDm({ firstName: "Erdal", context: "on Red (replacing Sait Demir) for Tuesday 7-a-side tonight", mentionReactions }));
    add(`R53 buildBenchIntroLine / ${tag}`, buildBenchIntroLine({ mentionReactions }));
    add(`R54 buildFullSquadBenchInvite / ${tag}`, buildFullSquadBenchInvite({ matchName: "Tuesday 7-a-side", confirmedCount: 14, maxPlayers: 14, mentionReactions }));
    add(`R55 buildBenchAskedLine / ${tag}`, buildBenchAskedLine({ benchName: "Erdal Ozkan", confirmedCount: 13, maxPlayers: 14, mentionReactions }));
    add(`R56 benchClaimPhrasingExample / ${tag}`, benchClaimPhrasingExample({ mentionReactions }));
  }
  add("R85 buildBenchOfferDm / no first name", buildBenchOfferDm({ firstName: "", context: "on Red for Tuesday 7-a-side tonight" }));

  // ── 1.1 rating-progress-answer.ts ───────────────────────────────────
  add("R59 formatRatingProgressReply / not ok, no reason", formatRatingProgressReply({ ok: false }));

  // ── 1.1 mom-announcement.ts ─────────────────────────────────────────
  add("R45 buildMomAnnouncement / single winner", buildMomAnnouncement({ mvpLabel: "Man of the Match", activityName: "Tuesday 7-a-side", tally: [{ name: "Sait Demir", votes: 6 }, { name: "Kemal Ediz", votes: 3 }, { name: "Abid Hussain", votes: 1 }] }));
  add("R45 buildMomAnnouncement / shared by two", buildMomAnnouncement({ mvpLabel: "Man of the Match", activityName: "Tuesday 7-a-side", tally: [{ name: "Sait Demir", votes: 4 }, { name: "Kemal Ediz", votes: 4 }, { name: "Abid Hussain", votes: 2 }] }));
  add("R45 buildMomAnnouncement / shared by three", buildMomAnnouncement({ mvpLabel: "Player of the Match", activityName: "Thursday 5-a-side", tally: [{ name: "Sait Demir", votes: 1 }, { name: "Kemal Ediz", votes: 1 }, { name: "Abid Hussain", votes: 1 }] }));
  add("R45 buildMomAnnouncement / one vote in total", buildMomAnnouncement({ mvpLabel: "Man of the Match", activityName: "Tuesday 7-a-side", tally: [{ name: "Sait Demir", votes: 1 }] }));

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
  });
  facts.forEach((f) => add(`R46 format-switch proposal / ${f.sportName}`, f.proposal));
  add("R46 renderFormatSwitchContext (prompt lines)", renderFormatSwitchContext(facts).join("\n"));

  // ── 1.1 format-switch-time.ts ───────────────────────────────────────
  add("R47 renderKickoffMoveLine / moved", renderKickoffMoveLine({ move: true, reason: "moved", previousKickoff: new Date("2026-09-08T20:30:00.000Z"), kickoff: new Date("2026-09-08T20:15:00.000Z"), attendanceDeadline: new Date("2026-09-08T20:15:00.000Z") }));
  add("R47 renderKickoffMoveLine / not moved", renderKickoffMoveLine({ move: false, reason: "same-time" }));

  // ── 1.1 out-of-band-attendance.ts ───────────────────────────────────
  for (const status of ["CONFIRMED", "BENCH", "DROPPED"] as const) {
    for (const source of ["dm", "app", "reaction"] as const) {
      add(`R48 buildOutOfBandAttendanceLine / ${status} via ${source}`, buildOutOfBandAttendanceLine({ playerName: "Sait Demir", status, source, confirmedCount: 12, maxPlayers: 14 }));
    }
  }
  add("R48 buildOutOfBandAttendanceLine / no name", buildOutOfBandAttendanceLine({ playerName: null, status: "CONFIRMED", source: "dm", confirmedCount: 12, maxPlayers: 14 }));

  // ── 1.1 unresolved-nudge.ts ─────────────────────────────────────────
  add("R50 planUnresolvedNudge / named, joining", planUnresolvedNudge({ senderResolved: false, attendanceRelevant: true, matchId: "m-1", authorName: "Tommy T", dropping: false }).reply);
  add("R50 planUnresolvedNudge / named, dropping", planUnresolvedNudge({ senderResolved: false, attendanceRelevant: true, matchId: "m-1", authorName: "Tommy T", dropping: true }).reply);
  add("R50 planUnresolvedNudge / anonymous, joining", planUnresolvedNudge({ senderResolved: false, attendanceRelevant: true, matchId: "m-1", authorName: null, dropping: false }).reply);
  add("R50 planUnresolvedNudge / anonymous, dropping", planUnresolvedNudge({ senderResolved: false, attendanceRelevant: true, matchId: "m-1", authorName: "447700900123", dropping: true }).reply);

  // ── 1.1 guest-name-ask.ts (also reached via compose above) ──────────
  add("R44 renderGuestNameAsk / plural, no name", renderGuestNameAsk({ askerName: null, body: "bringing 2 friends" }));

  // ── 1.1 stats-blast.ts ──────────────────────────────────────────────
  add("R100 composeStatsBlastDm / named", composeStatsBlastDm("Sait Demir", "https://mt.example/s/abc"));
  add("R100 composeStatsBlastDm / no name", composeStatsBlastDm(null, "https://mt.example/s/abc"));
  add("R51 composeStatsBlastReply / one", composeStatsBlastReply(1));
  add("R51 composeStatsBlastReply / twelve", composeStatsBlastReply(12));

  // ── 1.1 block-booking.ts ────────────────────────────────────────────
  add("R63 buildBulkCancelAnnouncement / one match", buildBulkCancelAnnouncement({ activityName: "Tuesday 7-a-side", dates: [new Date("2026-09-15T20:30:00.000Z")], announce: true }));
  add("R63 buildBulkCancelAnnouncement / two matches", buildBulkCancelAnnouncement({ activityName: "Tuesday 7-a-side", dates: [new Date("2026-09-22T20:30:00.000Z"), new Date("2026-09-15T20:30:00.000Z")], announce: true }));
  add("R63 buildBulkCancelAnnouncement / silent", buildBulkCancelAnnouncement({ activityName: "Tuesday 7-a-side", dates: [new Date("2026-09-15T20:30:00.000Z")], announce: false }));

  // ── 1.1 attendance-write-outcome.ts ─────────────────────────────────
  add("R58 buildAttendanceFailureReply / own OUT", buildAttendanceFailureReply([{ action: "OUT", who: null, error: "boom" }], "Sait Demir"));
  add("R58 buildAttendanceFailureReply / own IN", buildAttendanceFailureReply([{ action: "IN", who: null, error: "boom" }], "Sait Demir"));
  add("R58 buildAttendanceFailureReply / others only", buildAttendanceFailureReply([{ action: "IN", who: "Abid Hussain", error: "boom" }, { action: "OUT", who: "Idris Bello", error: "boom" }], "Sait Demir"));
  add("R58 buildAttendanceFailureReply / own and others", buildAttendanceFailureReply([{ action: "IN", who: null, error: "boom" }, { action: "BENCH", who: "Abid Hussain", error: "boom" }], "Sait Demir"));
  add("R58 buildAttendanceFailureReply / no usable name", buildAttendanceFailureReply([{ action: "IN", who: null, error: "boom" }], "447700900123"));

  // ── 1.4 admin-ops-engine.ts ─────────────────────────────────────────
  add("R132 composeReminderDm / named", composeReminderDm({ name: "Sait Demir", note: "book the pitch for Thursday" }));
  add("R132 composeReminderDm / no name", composeReminderDm({ name: null, note: "book the pitch for Thursday" }));
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
  add("R133 composePaymentAck / named", composePaymentAck(payment({}), "Sait Demir"));
  add("R133 composePaymentAck / count only", composePaymentAck(payment({ creditedNames: [] }), "Sait Demir"));
  add("R133 composePaymentAck / one, some ignored", composePaymentAck(payment({ creditedNames: ["Abid Hussain"], unmatchedUserIds: ["u-x", "u-y"], write: { count: 1 } as PaymentApplyResult["write"] }), "Sait Demir"));

  // ── 1.4 team-ops-engine.ts ──────────────────────────────────────────
  add("R134 TEAM_OPS_NO_MATCH_REPLY", TEAM_OPS_NO_MATCH_REPLY);
  add("R134 composeBalancerRefusal", composeBalancerRefusal("not enough confirmed players, 9/14"));
  const sheet = "*Red*:\n1. Kemal Ediz\n2. Sait Demir\n\n*Yellow*:\n1. Elvin Aliyev\n2. Abid Hussain";
  add("R134 composeGenerateTeamsReply / plain", composeGenerateTeamsReply({ groupPost: sheet, includedNames: [], pinnedLog: [], unmatchedIncludes: [], unmatchedPins: [] }));
  add("R134 composeGenerateTeamsReply / all four notes", composeGenerateTeamsReply({ groupPost: sheet, includedNames: ["Erdal Ozkan"], pinnedLog: ["Kemal Ediz → RED"], unmatchedIncludes: ["Bob"], unmatchedPins: ["Jim"] }));

  // ── 1.3 DM builders ─────────────────────────────────────────────────
  for (const mentionReactions of [false, true]) {
    const tag = mentionReactions ? "reactions on" : "reactions off";
    add(`R93 buildRecruitInviteDm / ${tag}, two spots, link`, buildRecruitInviteDm({ firstName: "Sait", matchName: "Tuesday 7-a-side", matchWhen: "Tue 8 Sep, 21:30", spotsLeft: 2, link: "https://mt.example/m/abc", mentionReactions }));
  }
  add("R93 buildRecruitInviteDm / one spot, no link", buildRecruitInviteDm({ firstName: "Sait", matchName: "Tuesday 7-a-side", matchWhen: "Tue 8 Sep, 21:30", spotsLeft: 1, link: null }));
  add("R93 buildRecruitInviteDm / spots suppressed", buildRecruitInviteDm({ firstName: "Sait", matchName: "Tuesday 7-a-side", matchWhen: "Tue 8 Sep, 21:30", spotsLeft: 0, link: null }));
  add("R94 buildRecruitGroupInviteDm", buildRecruitGroupInviteDm({ firstName: "Sait", matchName: "Thursday 5-a-side", matchWhen: "Thu 10 Sep, 20:00" }));
  add("R84 buildRecruitChaseText / one", buildRecruitChaseText({ playerName: "Sait Demir", activityName: "Tuesday 7-a-side", matchWhen: "Tue 8 Sep, 21:30", need: 1 }));
  add("R84 buildRecruitChaseText / three", buildRecruitChaseText({ playerName: "Sait Demir", activityName: "Tuesday 7-a-side", matchWhen: "Tue 8 Sep, 21:30", need: 3 }));
  add("R84 buildRecruitChaseText / no name", buildRecruitChaseText({ playerName: null, activityName: "Tuesday 7-a-side", matchWhen: "Tue 8 Sep, 21:30", need: 2 }));
  add("R102 buildTentativeFollowupAck / in", buildTentativeFollowupAck({ decision: "in", failed: false }));
  add("R102 buildTentativeFollowupAck / out", buildTentativeFollowupAck({ decision: "out", failed: false }));
  add("R102 buildTentativeFollowupAck / failed", buildTentativeFollowupAck({ decision: "in", failed: true }));
  for (const status of ["CONFIRMED", "BENCH", "DROPPED", null] as const) {
    add(`R101 buildSelfAttendanceAck / ${status ?? "no row"}`, buildSelfAttendanceAck({ failed: false, status, matchName: "Tuesday 7-a-side", matchWhen: "Tue 8 Sep, 21:30" }));
  }
  add("R101 buildSelfAttendanceAck / failed", buildSelfAttendanceAck({ failed: true, status: null, matchName: "Tuesday 7-a-side", matchWhen: "Tue 8 Sep, 21:30" }));
  for (const kind of ["opt-out-all", "opt-out-ratings", "opt-in-all", "opt-in-ratings"] as const) {
    add(`R99 dmSubAckMessage / ${kind}`, dmSubAckMessage(kind));
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
  add("R140 buildLegacyCompletionPost / weekly", buildLegacyCompletionPost(completion));
  add("R140 buildLegacyCompletionPost / one-off, MoM and ratings only", buildLegacyCompletionPost({ ...completion, chosen: ["momVoting", "playerRating"], weekly: false }));
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
    const r = resolveReminderPhrase(phrase, now);
    add(`R36 resolveReminderPhrase whenLabel / "${phrase}"`, r.ok ? r.whenLabel : `(not resolved: ${r.reason})`);
  }

  // ── R98 fee-confirm.ts: the prompt that embeds the collector prompt ─
  add("R98 FEE_REPLY_SYSTEM_PROMPT", FEE_REPLY_SYSTEM_PROMPT);

  return c;
}

function render(lang: Lang): string {
  const all = cases(lang);
  const head =
    `# MatchTime outbound copy, language "${lang}"\n` +
    `# ${all.length} rendered cases. Generated by copy-golden.test.ts; re-record only on purpose.\n`;
  return head + all.map((k) => `\n### ${k.id}\n${k.text}\n`).join("");
}

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
