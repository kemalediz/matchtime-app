/**
 * FREE PLACES (2026-10-16). Server-side, no "use server".
 *
 * FNF gives a free place a week: the player who washes the bibs, chosen
 * by the organisers. A free place is `Attendance.feeWaivedAt` (see
 * fee-waiver-rules.ts for what it means and who reads it). Two doors give
 * one, and both come here:
 *
 *   - "Mark free" on /collect/<matchId>, for an organiser or the money
 *     collector (`markFeeWaived` in app/actions/payments.ts);
 *   - an organiser in the club's admin group, in their own words ("Bilal
 *     washed the bibs, he's free this week"): the shared router routes it
 *     admin_ops, the shared admin extractor reads action "fee_waiver" and
 *     who, and `answerFeeFreeInHq` below does the rest
 *     (admin-group-understand.ts).
 *
 * ── WHAT IT NEVER DOES ─────────────────────────────────────────────
 * It never touches money. A player who has paid stays paid (the write
 * requires `paidAt` NULL, in the same statement), and is never refunded
 * from here: the reply says so and leaves it to the collector. It sends
 * nobody a message: the chase simply stops picking the player up.
 *
 * IDEMPOTENT: the write requires `feeWaivedAt` NULL, so a repeat (a
 * double tap, a Pi retry of the same HQ message) changes nothing and
 * says "already a free place".
 */
import { db } from "./db";
import { t } from "./i18n/t";
import { dayLabel } from "./i18n/dates";
import { joinChoice, joinList } from "./i18n/text";
import { resolvePerson } from "./pipeline/identity";
import type { Member } from "./pipeline/types";
import {
  FEE_WAIVER_REASON_ORGANISER,
  FEE_WAIVER_RECENT_MS,
  HQ_FEE_FREE_NOTHING_DONE,
  decideWaive,
  pickWaiverMatch,
  type WaiveDecision,
} from "./fee-waiver-rules";

export type WaiveOutcome = Exclude<WaiveDecision, "waive"> | "waived" | "unchanged";

/** Give one player a free place on one match. */
export async function waiveMatchFee(input: {
  matchId: string;
  userId: string;
  byUserId: string;
  reason?: string;
  now: Date;
}): Promise<WaiveOutcome> {
  const { matchId, userId } = input;
  const res = await db.attendance.updateMany({
    where: {
      matchId,
      userId,
      status: { in: ["CONFIRMED", "BENCH"] },
      paidAt: null,
      feeWaivedAt: null,
      // A monthly regular's place is paid for by the month. `not` alone
      // would also skip a NULL method, the usual case.
      OR: [{ paymentMethod: null }, { paymentMethod: { not: "monthly" } }],
    },
    data: { feeWaivedAt: input.now, feeWaivedReason: input.reason ?? FEE_WAIVER_REASON_ORGANISER, feeWaivedByUserId: input.byUserId },
  });
  if (res.count > 0) return "waived";
  // Nothing written: read the row to say why.
  const row = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId } },
    select: { status: true, paidAt: true, feeWaivedAt: true, paymentMethod: true },
  });
  const d = decideWaive(row);
  return d === "waive" ? "unchanged" : d;
}

/** Take a free place back (a mistaken tap). Only while unpaid. The chase
 *  picks the player up again on its next run; nothing is sent from here. */
export async function unwaiveMatchFee(input: { matchId: string; userId: string }): Promise<boolean> {
  const res = await db.attendance.updateMany({
    where: { matchId: input.matchId, userId: input.userId, feeWaivedAt: { not: null }, paidAt: null },
    data: { feeWaivedAt: null, feeWaivedReason: null, feeWaivedByUserId: null },
  });
  return res.count > 0;
}

/** How far ahead "this week" can reach for the next game. */
const AHEAD_MS = 14 * 24 * 60 * 60 * 1000;

export interface HqFeeFreeInput {
  orgId: string;
  lang: string | null;
  /** Who the organiser named, verbatim from the admin extractor. */
  refs: string[];
  senderUserId: string;
  messageId: string;
  now: Date;
}


/**
 * An organiser in HQ said who plays free. Which match: `pickWaiverMatch`
 * (the game just played, else the next one), named in the reply. Names
 * are read against that match's squad with the pipeline's own resolver.
 * Logs carry ids and counts only.
 */
export async function answerFeeFreeInHq(input: HqFeeFreeInput): Promise<{ outcome: string; replyText: string }> {
  const s = t(input.lang);
  const none = (replyText: string) => ({ outcome: HQ_FEE_FREE_NOTHING_DONE, replyText });
  const refs = [...new Set(input.refs.map((r) => r.trim()).filter(Boolean))];
  if (refs.length === 0) return none(s.hq_fee_free_who);

  const org = await db.organisation.findUnique({
    where: { id: input.orgId },
    select: { paymentCollectionEnabled: true, paymentTrackingEnabled: true },
  });
  if (!org?.paymentCollectionEnabled && !org?.paymentTrackingEnabled) return none(s.hq_fee_free_no_payments);

  const matches = await db.match.findMany({
    where: {
      activity: { orgId: input.orgId },
      isHistorical: false,
      status: { not: "CANCELLED" },
      date: { gte: new Date(input.now.getTime() - FEE_WAIVER_RECENT_MS), lte: new Date(input.now.getTime() + AHEAD_MS) },
    },
    select: { id: true, date: true },
  });
  const match = pickWaiverMatch(matches, input.now);
  if (!match) return none(s.hq_fee_free_no_match);
  const day = dayLabel(input.lang, match.date);

  const squad = await db.attendance.findMany({
    where: { matchId: match.id, status: { in: ["CONFIRMED", "BENCH"] } },
    select: { userId: true, user: { select: { name: true, phoneNumber: true } } },
  });
  const roster: Member[] = squad
    .filter((a) => !!a.user?.name)
    .map((a) => ({ userId: a.userId, name: a.user.name as string, isAdmin: false, hasPhone: !!a.user.phoneNumber }));

  const freed: string[] = [];
  const already: string[] = [];
  const lines: string[] = [];
  const done = new Set<string>();
  for (const ref of refs) {
    const r = resolvePerson(ref, roster);
    const shown = ref.replace(/^@/, "");
    if (r.kind === "ambiguous") {
      lines.push(s.hq_fee_free_which({ ref: shown, choices: joinChoice(input.lang, r.candidates.map((c) => c.name)) }));
      continue;
    }
    if (r.kind !== "resolved") {
      lines.push(s.hq_fee_free_not_in_squad({ name: shown, day }));
      continue;
    }
    if (done.has(r.member.userId)) continue;
    done.add(r.member.userId);
    const name = r.member.name;
    const outcome = await waiveMatchFee({ matchId: match.id, userId: r.member.userId, byUserId: input.senderUserId, now: input.now });
    if (outcome === "waived") freed.push(name);
    else if (outcome === "already-free") already.push(name);
    else if (outcome === "already-paid") lines.push(s.hq_fee_free_paid({ name, day }));
    else if (outcome === "monthly") lines.push(s.hq_fee_free_monthly({ name, day }));
    else lines.push(s.hq_fee_free_not_in_squad({ name, day }));
  }
  const head: string[] = [];
  if (freed.length) head.push(s.hq_fee_free_done({ names: joinList(input.lang, freed), day }));
  if (already.length) head.push(s.hq_fee_free_already({ names: joinList(input.lang, already), day }));
  console.log(
    `[fee-waiver] ${input.messageId}: match ${match.id}: ${freed.length} made free, ${already.length} already free, ${lines.length} other line(s)`,
  );
  return {
    outcome: freed.length || already.length ? "fee-free" : HQ_FEE_FREE_NOTHING_DONE,
    replyText: [...head, ...lines].join("\n"),
  };
}
