/**
 * FREE PLACES (2026-10-16). Server-side, no "use server".
 *
 * FNF gives a free place a week: the player who washes the bibs, chosen
 * by the organisers. A free place is `Attendance.feeWaivedAt` (see
 * fee-waiver-rules.ts for what it means and who reads it). Two doors give
 * one, and both write through `waiveMatchFee`:
 *
 *   - "Mark free" on /collect/<matchId>, for an organiser or the money
 *     collector (`markFeeWaived` in app/actions/payments.ts);
 *   - the club's admin group, in the organisers' own words ("Bilal washed
 *     the bibs, he's free this week"): the shared router routes it
 *     admin_ops and the shared admin extractor reads action fee_waiver,
 *     who, the day if one is named, and whether it takes one back (undo).
 *     NOTHING IS WRITTEN THEN. `proposeFeeFreeInHq` asks "Make Bilal Ahmed
 *     free for Fri 16 Oct? Reply YES." and `answerFeeProposalYes` applies
 *     it on an organiser's YES, decided by the safe-YES rule
 *     (`admin-group-confirm-rules.ts`), like a pasted list or proposed
 *     teams. The question names the game, so a wrong guess is corrected
 *     before anything changes (review of #301, items 2 and 3).
 *
 * ── WHAT IT NEVER DOES ─────────────────────────────────────────────
 * It never touches money. A player who has paid stays paid (the write
 * requires `paidAt` NULL, in the same statement), and is never refunded
 * from here. The money collector is never made free: they collect.
 *
 * The one message it sends: a player made free AFTER their pay link went
 * out gets one short DM, "You're on a free place for Fri 16 Oct, no need
 * to pay." (Kemal, decision a). Only on a fresh waive, so a repeat sends
 * nothing.
 *
 * IDEMPOTENT: the write requires `feeWaivedAt` NULL; a proposal is claimed
 * once (`resolvedAt` NULL in the WHERE), and a Pi retry of the same HQ
 * message finds its proposal by message id.
 */
import { db } from "./db";
import { t } from "./i18n/t";
import { dayLabel } from "./i18n/dates";
import { joinChoice, joinList } from "./i18n/text";
import { resolvePerson } from "./pipeline/identity";
import type { Member } from "./pipeline/types";
import { recordMatchTimeQuestion } from "./admin-group-log";
import {
  FEE_PROPOSAL_TTL_MS,
  FEE_WAIVER_REASON_ORGANISER,
  HQ_FEE_FREE_EXPIRED,
  HQ_FEE_FREE_NOTHING_DONE,
  decideWaive,
  feeAskRef,
  isFeeWaived,
  pickWaiverMatch,
  readDayHint,
  type WaiveDecision,
} from "./fee-waiver-rules";

export type WaiveOutcome = Exclude<WaiveDecision, "waive"> | "waived" | "unchanged" | "collector";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Give one player a free place on one match. */
export async function waiveMatchFee(input: {
  matchId: string;
  userId: string;
  byUserId: string;
  reason?: string;
  now: Date;
}): Promise<WaiveOutcome> {
  const { matchId, userId } = input;
  const match = await db.match.findUnique({
    where: { id: matchId },
    select: {
      date: true,
      paymentLinksReleasedAt: true,
      activity: { select: { orgId: true, org: { select: { paymentHolderId: true, language: true } } } },
    },
  });
  if (!match) return "not-in-squad";
  // The money collector collects; they are never charged, so never "free".
  if (match.activity.org.paymentHolderId === userId) return "collector";
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
  if (res.count > 0) {
    // Their pay link is already out: tell them, once, that they owe nothing.
    if (match.paymentLinksReleasedAt) {
      const user = await db.user.findUnique({ where: { id: userId }, select: { phoneNumber: true } });
      if (user?.phoneNumber) {
        await db.botJob.create({
          data: {
            orgId: match.activity.orgId,
            kind: "dm",
            phone: user.phoneNumber.replace(/^\+/, ""),
            text: t(match.activity.org.language).dm_free_place({ day: dayLabel(match.activity.org.language, match.date) }),
          },
        });
      }
    }
    return "waived";
  }
  // Nothing written: read the row to say why.
  const row = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId } },
    select: { status: true, paidAt: true, feeWaivedAt: true, paymentMethod: true },
  });
  const d = decideWaive(row);
  return d === "waive" ? "unchanged" : d;
}

/** Take a free place back. Only while unpaid. The chase picks the player
 *  up again on its next run; nothing is sent from here. */
export async function unwaiveMatchFee(input: { matchId: string; userId: string }): Promise<boolean> {
  const res = await db.attendance.updateMany({
    where: { matchId: input.matchId, userId: input.userId, feeWaivedAt: { not: null }, paidAt: null },
    data: { feeWaivedAt: null, feeWaivedReason: null, feeWaivedByUserId: null },
  });
  return res.count > 0;
}

// ── The admin group ────────────────────────────────────────────────────

/** How far back and ahead the games a free place can be for are loaded. */
const BACK_MS = 8 * DAY_MS;
const AHEAD_MS = 21 * DAY_MS;

export interface HqFeeFreeInput {
  orgId: string;
  lang: string | null;
  /** Who the organiser named, verbatim from the admin extractor. */
  refs: string[];
  /** True: take free places away ("Bilal isn't free after all"). */
  undo: boolean;
  /** The day named for the game, verbatim ("next Friday"), or null. */
  dayPhrase: string | null;
  senderUserId: string;
  messageId: string;
  now: Date;
}

interface HqReply {
  outcome: string;
  replyText: string;
}

const askText = (lang: string | null, undo: boolean, names: string, day: string, notes: string[]): string =>
  undo ? t(lang).hq_fee_unfree_ask({ names, day }) : t(lang).hq_fee_free_ask({ names, day, notes: notes.join(" ") });

/**
 * An organiser (or the money collector) in HQ said who plays free, or who
 * no longer does. Works out the game and the players and ASKS; writes no
 * free place. Lines for anyone it cannot do follow the question. Logs
 * carry ids and counts only.
 */
export async function proposeFeeFreeInHq(input: HqFeeFreeInput): Promise<HqReply> {
  const { lang } = input;
  const s = t(lang);
  const none = (replyText: string): HqReply => ({ outcome: HQ_FEE_FREE_NOTHING_DONE, replyText });
  const refs = [...new Set(input.refs.map((r) => r.trim()).filter(Boolean))];
  if (refs.length === 0) return none(s.hq_fee_free_who);

  const org = await db.organisation.findUnique({
    where: { id: input.orgId },
    select: { paymentCollectionEnabled: true, paymentTrackingEnabled: true, paymentHolderId: true },
  });
  if (!org?.paymentCollectionEnabled && !org?.paymentTrackingEnabled) return none(s.hq_fee_free_no_payments);
  const collectorId = org.paymentHolderId ?? null;

  const matches = await db.match.findMany({
    where: {
      activity: { orgId: input.orgId },
      isHistorical: false,
      status: { not: "CANCELLED" },
      date: { gte: new Date(input.now.getTime() - BACK_MS), lte: new Date(input.now.getTime() + AHEAD_MS) },
    },
    select: { id: true, date: true, status: true },
  });
  const match = pickWaiverMatch(matches, input.now, input.dayPhrase);
  if (!match) {
    return none(readDayHint(input.dayPhrase) && input.dayPhrase ? s.hq_fee_free_no_match_day({ day: input.dayPhrase.trim() }) : s.hq_fee_free_no_match);
  }
  const day = dayLabel(lang, match.date);

  // A Pi retry of the same message: the same question, nothing new.
  const earlier = await db.adminFeeProposal.findUnique({ where: { waMessageId: input.messageId } });
  if (earlier?.text) return { outcome: "fee-free-asked", replyText: earlier.text };

  const squad = await db.attendance.findMany({
    where: { matchId: match.id, status: { in: ["CONFIRMED", "BENCH"] } },
    select: {
      userId: true,
      status: true,
      paidAt: true,
      feeWaivedAt: true,
      paymentMethod: true,
      directPendingAt: true,
      user: { select: { name: true, phoneNumber: true } },
    },
  });
  const named = squad.filter((a) => !!a.user?.name);
  const asMember = (a: (typeof named)[number]): Member => ({ userId: a.userId, name: a.user.name as string, isAdmin: false, hasPhone: !!a.user.phoneNumber });
  const roster = named.filter((a) => a.userId !== collectorId).map(asMember);
  const collectorName = collectorId
    ? ((await db.user.findUnique({ where: { id: collectorId }, select: { name: true } }))?.name ?? null)
    : null;

  const chosen: Array<{ userId: string; name: string }> = [];
  const notes: string[] = [];
  const already: string[] = [];
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const shown = ref.replace(/^@/, "");
    const r = resolvePerson(ref, roster);
    if (r.kind === "ambiguous") {
      lines.push(s.hq_fee_free_which({ ref: shown, choices: joinChoice(lang, r.candidates.map((c) => c.name)) }));
      continue;
    }
    if (r.kind !== "resolved") {
      // The collector is out of the roster on purpose: say why, not "not found".
      const isCollector =
        collectorId && collectorName && resolvePerson(ref, [{ userId: collectorId, name: collectorName, isAdmin: false, hasPhone: false }]).kind === "resolved";
      lines.push(isCollector ? s.hq_fee_free_collector({ name: collectorName as string }) : s.hq_fee_free_not_in_squad({ name: shown, day }));
      continue;
    }
    if (seen.has(r.member.userId)) continue;
    seen.add(r.member.userId);
    const row = named.find((a) => a.userId === r.member.userId)!;
    const name = r.member.name;
    if (input.undo) {
      if (isFeeWaived(row) && !row.paidAt) chosen.push({ userId: row.userId, name });
      else lines.push(s.hq_fee_unfree_not_free({ name, day }));
      continue;
    }
    const d = decideWaive(row);
    if (d === "waive") {
      chosen.push({ userId: row.userId, name });
      // Item 5: they said they would pay the collector directly. Say so.
      if (row.directPendingAt) notes.push(s.hq_fee_free_direct_note({ name, collector: collectorName }));
    } else if (d === "already-free") already.push(name);
    else if (d === "already-paid") lines.push(s.hq_fee_free_paid({ name, day }));
    else if (d === "monthly") lines.push(s.hq_fee_free_monthly({ name, day }));
    else lines.push(s.hq_fee_free_not_in_squad({ name, day }));
  }
  if (already.length) lines.unshift(s.hq_fee_free_already({ names: joinList(lang, already), day }));
  if (chosen.length === 0) {
    console.log(`[fee-waiver] ${input.messageId}: match ${match.id}: nothing to ask, ${lines.length} line(s)`);
    return none(lines.join("\n"));
  }

  const question = askText(lang, input.undo, joinList(lang, chosen.map((c) => c.name)), day, notes);
  const replyText = [question, ...lines].join("\n");
  // One free place question waits at a time: a newer one supersedes it.
  await db.adminFeeProposal.updateMany({
    where: { orgId: input.orgId, resolvedAt: null },
    data: { resolvedAt: input.now, outcome: "superseded" },
  });
  const proposal = await db.adminFeeProposal.create({
    data: {
      orgId: input.orgId,
      matchId: match.id,
      waMessageId: input.messageId,
      proposedByUserId: input.senderUserId,
      userIds: chosen.map((c) => c.userId),
      undo: input.undo,
      text: replyText,
      expiresAt: new Date(input.now.getTime() + FEE_PROPOSAL_TTL_MS),
      createdAt: input.now,
    },
  });
  await recordMatchTimeQuestion({ orgId: input.orgId, askRef: feeAskRef(proposal.id), text: replyText, now: input.now });
  console.log(`[fee-waiver] ${input.messageId}: asked about ${chosen.length} player(s) on match ${match.id}${input.undo ? " (undo)" : ""}`);
  return { outcome: "fee-free-asked", replyText };
}

/** The open free place questions of a club, for what HQ is WAITING for
 *  (`admin-group-understand.ts` `loadPending`). A question past its 30
 *  minutes still waits for a day, so its YES is answered "too old". */
export async function feeProposalsAwaiting(
  orgId: string,
  now: Date,
  lang: string | null,
): Promise<Array<{ ref: string; day: string; names: string; undo: boolean; askedAt: Date }>> {
  const open = await db.adminFeeProposal.findMany({
    where: { orgId, resolvedAt: null, expiresAt: { gte: new Date(now.getTime() - DAY_MS) } },
  });
  const out: Array<{ ref: string; day: string; names: string; undo: boolean; askedAt: Date }> = [];
  for (const p of open) {
    const [m, users] = await Promise.all([
      db.match.findUnique({ where: { id: p.matchId }, select: { date: true } }),
      db.user.findMany({ where: { id: { in: p.userIds } }, select: { id: true, name: true } }),
    ]);
    if (!m) continue;
    const names = p.userIds.map((id) => users.find((u) => u.id === id)?.name ?? "?");
    out.push({ ref: feeAskRef(p.id), day: dayLabel(lang, m.date), names: joinList(lang, names), undo: p.undo, askedAt: p.createdAt });
  }
  return out;
}

/** An organiser's (or the collector's) YES to a free place question,
 *  already matched to it by the safe-YES rule. Null: nothing waiting. */
export async function answerFeeProposalYes(args: {
  orgId: string;
  proposalId: string;
  userId: string;
  lang: string | null;
  now: Date;
}): Promise<HqReply | null> {
  const { lang, now } = args;
  const s = t(lang);
  const p = await db.adminFeeProposal.findUnique({ where: { id: args.proposalId } });
  if (!p || p.orgId !== args.orgId || p.resolvedAt) return null;
  if (p.expiresAt.getTime() < now.getTime()) return { outcome: HQ_FEE_FREE_EXPIRED, replyText: s.hq_fee_free_expired };
  // Claim it once, before any write: two YESes apply it once.
  const claimed = await db.adminFeeProposal.updateMany({
    where: { id: p.id, resolvedAt: null },
    data: { resolvedAt: now, outcome: "applied", resolvedByUserId: args.userId },
  });
  if (claimed.count === 0) return null;

  const m = await db.match.findUnique({ where: { id: p.matchId }, select: { date: true } });
  const day = m ? dayLabel(lang, m.date) : "";
  const users = await db.user.findMany({ where: { id: { in: p.userIds } }, select: { id: true, name: true } });
  const nameOf = (id: string) => users.find((u) => u.id === id)?.name ?? "?";
  const done: string[] = [];
  const lines: string[] = [];
  for (const userId of p.userIds) {
    const name = nameOf(userId);
    if (p.undo) {
      if (await unwaiveMatchFee({ matchId: p.matchId, userId })) done.push(name);
      else lines.push(s.hq_fee_unfree_not_free({ name, day }));
      continue;
    }
    // Written as the organiser who asked: they gave the free place.
    const o = await waiveMatchFee({ matchId: p.matchId, userId, byUserId: p.proposedByUserId, now });
    if (o === "waived" || o === "already-free") done.push(name);
    else if (o === "already-paid") lines.push(s.hq_fee_free_paid({ name, day }));
    else if (o === "monthly") lines.push(s.hq_fee_free_monthly({ name, day }));
    else if (o === "collector") lines.push(s.hq_fee_free_collector({ name }));
    else lines.push(s.hq_fee_free_not_in_squad({ name, day }));
  }
  const head = done.length
    ? [p.undo ? s.hq_fee_unfree_done({ names: joinList(lang, done), day }) : s.hq_fee_free_done({ names: joinList(lang, done), day })]
    : [];
  console.log(`[fee-waiver] proposal ${p.id}: ${done.length} applied${p.undo ? " (undo)" : ""}, ${lines.length} other line(s)`);
  return { outcome: done.length ? "fee-free" : HQ_FEE_FREE_NOTHING_DONE, replyText: [...head, ...lines].join("\n") };
}
