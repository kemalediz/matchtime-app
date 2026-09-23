/**
 * PRIVATE MESSAGES, as pure builders (Phase 3 of
 * MDs/multi-language-design-2026-09-16.md).
 *
 * Every DM below used to be a template literal inline in a function that
 * reaches the database (the scheduler, the payment flow, the dm-reply
 * route, a script), which is why the golden snapshot could not pin it.
 * Each one was moved here verbatim and its English recorded in
 * `copy.en.snap` BEFORE it moved into the string table; the words now
 * live in `i18n/strings.<lang>.ts` under "private messages (Phase 3)".
 * No clock, no database, no model.
 *
 * ── WHICH LANGUAGE ──────────────────────────────────────────────────
 * Every builder takes `lang`: the language of the org the message is
 * ABOUT (the match's org, `Organisation.language`), never a per-user
 * setting. The caller resolves it; each call site says where. Absent or
 * unknown means English, which is what every DM said before this.
 *
 * Rows refer to the design's inventory (section 1.3).
 */
import { gbp } from "./payments";
import { t } from "./i18n/t";
import type { Lang } from "./i18n/lang";

type WithLang = { lang?: Lang | string | null };

/** The first word of a name, or null when there is no name. The English
 *  fallbacks ("there", "mate") live in the English table. */
function firstOf(name: string | null | undefined, split: RegExp | string = " "): string | null {
  return name?.split(split)[0] ?? null;
}

// ── row 91: the rating-link DM (bot-scheduler.ts and the late one in
//    app/actions/players.ts, which were two copies of one message) ──────

export function buildRatingDm(
  p: {
    activityName: string;
    /** The match day, `dayLabel(lang, date)`: "Tue 8 Sep" / "8 Eylül Salı". */
    dateLabel: string;
    mvpLabel: string;
    rateUrl: string;
    statsUrl: string;
  } & WithLang,
): string {
  return t(p.lang).dm_rating({
    activityName: p.activityName,
    dateLabel: p.dateLabel,
    mvpLabel: p.mvpLabel,
    rateUrl: p.rateUrl,
    statsUrl: p.statsUrl,
  });
}

// ── row 92: the daily rating reminder, five day-toned variants ─────────

/**
 * Copy for the daily 18:00 rating-reminder DM. Varies tone by day so five
 * nudges in a row don't all read the same: a warm opener (first name if
 * we have it), the match named, why ratings matter, the personal link.
 * Never guilty or whiny.
 */
export function buildRatingReminderDm(
  args: {
    dayNum: number;
    playerName: string | null;
    activityName: string;
    mvpLabel: string;
    url: string;
  } & WithLang,
): string {
  return t(args.lang).dm_rating_reminder({
    dayNum: args.dayNum,
    firstName: firstOf(args.playerName, /\s+/),
    activityName: args.activityName,
    mvpLabel: args.mvpLabel,
    url: args.url,
  });
}

// ── row 83: the tentative ("maybe") follow-up DM ───────────────────────

export function buildTentativeFollowupDm(
  p: {
    playerName: string | null;
    activityName: string;
    /** `dayTimeLabel(lang, date)`: "Tue 8 Sep at 21:30", London. */
    whenLabel: string;
  } & WithLang,
): string {
  return t(p.lang).dm_tentative_followup({
    firstName: firstOf(p.playerName),
    activityName: p.activityName,
    whenLabel: p.whenLabel,
  });
}

// ── row 88: the fee ask to the money collector ─────────────────────────

export function buildFeeAskDm(
  p: {
    collectorName: string | null;
    activityName: string;
    /** Confirmed squad size. 0 omits the "(N played)" clause. */
    headcount: number;
  } & WithLang,
): string {
  return t(p.lang).dm_fee_ask({
    firstName: firstOf(p.collectorName),
    activityName: p.activityName,
    headcount: p.headcount,
  });
}

// ── row 89: the daily pay chase ────────────────────────────────────────

export function buildPayChaseDm(
  p: {
    playerName: string | null;
    /** Days since the links went out, 1-based. Picks the opener. */
    dayNum: number;
    fee: number;
    activityName: string;
    url: string;
  } & WithLang,
): string {
  return t(p.lang).dm_pay_chase({
    firstName: firstOf(p.playerName),
    dayNum: p.dayNum,
    fee: gbp(p.fee),
    activityName: p.activityName,
    url: p.url,
  });
}

// ── row 90: the collector's daily "tick off the direct payers" nudge ───

export function buildDirectPayCollectorNudge(
  p: { count: number; activityName: string; url: string } & WithLang,
): string {
  return t(p.lang).dm_direct_pay_nudge({ count: p.count, activityName: p.activityName, url: p.url });
}

// ── row 157: the collector's "settling directly" notice ────────────────

export function buildDirectPayCollectorNotice(
  p: {
    playerName: string | null;
    activityName: string;
    /** Base fee times quantity, in pounds. */
    amount: number;
    quantity: number;
    url: string;
    /** True when the player SAID they have paid (a "Paid" DM); false when
     *  they chose to pay directly on the pay page. */
    claimedPaid: boolean;
  } & WithLang,
): string {
  return t(p.lang).dm_direct_pay_notice({
    playerName: p.playerName,
    activityName: p.activityName,
    amount: gbp(p.amount),
    quantity: p.quantity,
    url: p.url,
    claimedPaid: p.claimedPaid,
  });
}

// ── rows 158 to 160: the player's reply to a "Paid" DM ─────────────────

export function buildPaidClaimAck(
  p: {
    playerName: string | null;
    collectorName: string | null;
    amount: number;
    activityName: string;
    /** The collector already knew (a repeat): a different, shorter reply. */
    alreadyPending: boolean;
  } & WithLang,
): string {
  const args = {
    firstName: firstOf(p.playerName),
    collectorName: firstOf(p.collectorName),
    amount: gbp(p.amount),
    activityName: p.activityName,
  };
  return p.alreadyPending ? t(p.lang).dm_paid_claim_already(args) : t(p.lang).dm_paid_claim_ack(args);
}

export function buildPaidForOthersReply(
  p: { playerName: string | null; collectorName: string | null; url: string } & WithLang,
): string {
  return t(p.lang).dm_paid_for_others({
    firstName: firstOf(p.playerName),
    collectorName: firstOf(p.collectorName),
    url: p.url,
  });
}

// ── row 95: the pay link ───────────────────────────────────────────────

export function buildPayLinkDm(
  p: { playerName: string | null; activityName: string; fee: number; url: string } & WithLang,
): string {
  return t(p.lang).dm_pay_link({
    firstName: firstOf(p.playerName),
    activityName: p.activityName,
    fee: gbp(p.fee),
    url: p.url,
  });
}

// ── rows 96, 97, 98: the collector fee flow's replies ──────────────────

export function buildFeeReleasedAck(p: { released: number; fee: number; matchName: string } & WithLang): string {
  return t(p.lang).dm_fee_released({ released: p.released, fee: gbp(p.fee), matchName: p.matchName });
}

export function buildFeeCancelledAck(lang?: Lang | string | null): string {
  return t(lang).dm_fee_cancelled;
}

export function buildFeeConfirmPrompt(
  p: {
    perPlayer: number;
    headcount: number;
    matchName: string;
    wasTotal: boolean;
  } & WithLang,
): string {
  return t(p.lang).dm_fee_confirm_prompt({
    fee: gbp(p.perPlayer),
    headcount: p.headcount,
    matchName: p.matchName,
    wasTotal: p.wasTotal,
  });
}

/**
 * The confirm question as the fee-reply MODEL is shown it: the same
 * table entry, rendered with placeholders, WhatsApp bold stripped, the
 * paragraph break flattened and the double quotes escaped. Built from
 * the entry rather than copied, so a change to the question can never
 * leave the model reading an older one (design section 7, point 5). For
 * English this is, byte for byte, the line the prompt always quoted.
 */
export function feeConfirmQuestionForPrompt(lang?: Lang | string | null): string {
  return t(lang)
    .dm_fee_confirm_prompt({ fee: "£X", headcount: "N", matchName: "<match>", wasTotal: false })
    .replace(/\*/g, "")
    .replace(/\n\n/g, " ")
    .replace(/"/g, '\\"');
}

// ── rows 103, 104: the bench-offer DM's replies (dm-reply route) ───────

export function buildBenchDmUnclear(lang?: Lang | string | null): string {
  return t(lang).dm_bench_unclear;
}

export type BenchDmAckKind = "declined" | "confirmed" | "taken" | "other";

export function buildBenchDmAck(kind: BenchDmAckKind, lang?: Lang | string | null): string {
  return t(lang).dm_bench_ack({ kind });
}

// ── row 105: the tentative follow-up's one re-ask ──────────────────────

export function buildTentativeReask(lang?: Lang | string | null): string {
  return t(lang).dm_tentative_reask;
}

// ── rows 106, 107, 108: the admin recruit-by-DM reply ──────────────────

export function buildAdminRecruitDmReply(
  r: {
    ok: boolean;
    reason?: string;
    invited?: number;
    matchName?: string;
    matchWhen?: string;
    need?: number;
  },
  lang?: Lang | string | null,
): string {
  const s = t(lang);
  if (!r.ok) return r.reason ?? s.recruit_failed;
  if (r.invited && r.invited > 0) {
    return s.dm_admin_recruit_done({
      invited: r.invited,
      matchName: r.matchName ?? "",
      matchWhen: r.matchWhen ?? "",
      need: r.need ?? null,
    });
  }
  return r.reason ?? s.dm_admin_recruit_nobody_new({ matchName: r.matchName ?? "" });
}

// ── rows 109, 110: the roster check-in replies ─────────────────────────

/** The opening of the clarification, which the route also uses as its
 *  one-per-person dedupe probe. `dm_survey_clarify` starts with exactly
 *  this text in every language (`dm-copy.test.ts` proves it). */
export function rosterSurveyClarificationProbe(firstName: string | null, lang?: Lang | string | null): string {
  return t(lang).dm_survey_clarify_probe({ firstName });
}

export function buildRosterSurveyClarification(
  p: { firstName: string | null; orgName: string } & WithLang,
): string {
  return t(p.lang).dm_survey_clarify({ firstName: p.firstName, orgName: p.orgName });
}

export function buildRosterSurveyConfirmation(
  p: { category: "in" | "maybe" | "out"; firstName: string | null } & WithLang,
): string {
  return t(p.lang).dm_survey_confirm({ category: p.category, firstName: p.firstName });
}

/** The check-in DM itself (scripts/start-roster-survey.ts). */
export function buildRosterSurveyInviteDm(p: { firstName: string | null; orgName: string } & WithLang): string {
  return t(p.lang).dm_survey_invite({ firstName: p.firstName, orgName: p.orgName });
}

// ── row 111: the DM Q&A apology ────────────────────────────────────────

export function buildDmQaApology(lang?: Lang | string | null): string {
  return t(lang).dm_qa_apology;
}

// ── row 122: the "@Match Time my stats" link DM (analyze route) ────────

export function buildStatsLinkDm(p: { name: string | null; url: string } & WithLang): string {
  return t(p.lang).dm_stats_link({ firstName: firstOf(p.name), url: p.url });
}
