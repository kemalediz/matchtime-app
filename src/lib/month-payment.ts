/**
 * Monthly squad, slice 4: the month's price, payments and reminders, the
 * database side (2026-10-06).
 * Plan: MDs/monthly-squad-plan-2026-10-05.md, sections 4.2 and 4.3, with
 * decisions D1, D3 and D5.
 *
 * For a club on `squadMode = "monthly"` ONLY: every entry point checks
 * the mode (or reaches a month through one that does) before it writes.
 *
 *   priceMonth()             the organiser sets the share: each regular's
 *                            amount = share x games - credits, the credits
 *                            marked used. Under the club-month's lock.
 *   settleMemberAmount()     one member, after their place changed.
 *   claimMonthPaid()         "says paid": from a list, a DM, the page, or
 *                            a mark somebody else wrote. NEVER sets paidAt.
 *   confirmMonthPaid()       the collector's own word, and only theirs
 *   unconfirmMonthPaid()     (D3). The page and the digest reply end here.
 *   handlePlayerPaidDm()     a player's "paid", in a fixed vocabulary.
 *   handleCollectorPaidReply() the collector's "PAID ALL" / "PAID 1 3" /
 *                            "PAID NONE" to the digest. A decline is
 *                            recorded.
 *   sweepMonthPayments()     the poll's side effects: the "set the price"
 *                            notice, the daily digest, the summary after
 *                            the pay-by date.
 *   monthPaymentPosts()      for `computeDuePosts`: the priced list, the
 *                            group's count, the reminder DMs.
 *
 * MONEY RULES, all of them enforced here:
 *   - bank transfer only (D5). MatchTime never sees the money, never asks
 *     for an account number and never sends a pay link for the month;
 *   - `paidAt` is written by `confirmMonthPaid` and by nothing else;
 *   - no row and no credit is ever deleted;
 *   - every write is idempotent: a retry, or two polls at once, changes
 *     nothing the second time.
 *
 * The rules are pure and live in `month-payment-rules.ts`. No model is
 * called anywhere in this file.
 */
import { db } from "./db";
import { sendAdminNotice } from "./admin-channel";
import { appUrl } from "./app-url";
import { isClubOperational } from "./club-approval-state";
import { planPricePence } from "./club-billing-rules";
import { formatLondon } from "./london-time";
import {
  buildClaimsDigest,
  buildCollectorReplyAnswer,
  buildGroupPayReminder,
  buildMonthFeeTip,
  buildPaidClaimAckDm,
  buildPayBySummary,
  buildOtherMonthHint,
  buildPayReminderDm,
  buildPriceAskNotice,
  buildPricedListPost,
  buildStaleReplyAnswer,
  type PricedLine,
} from "./month-payment-copy";
import {
  DIGEST_REPLY_WINDOW_MS,
  claimsDigestDue,
  decideCollectorReply,
  priceAskDue,
  duePaymentReminder,
  groupReminderDue,
  monthFeeShare,
  planPricing,
  priceLocked,
  readCollectorReply,
  readPaidMessage,
  validatePricing,
  type PricingError,
  type PricingInput,
  type PricingMember,
  type RemindersSent,
  type SentDigest,
} from "./month-payment-rules";
import { loadLiveMonths, lockMonth, type SignupMonth } from "./month-signup";
import { WAITING_NOTE, buildSignupList, isDaytime, SIGNUP_REPOST_FLOOR_MS } from "./month-signup-rules";
import { weekListHash } from "./monthly-week-rules";
import { normalisePhone } from "./phone";
import { normaliseSquadMode } from "./squad-month-rules";

const DAY_MS = 24 * 60 * 60 * 1000;
type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

/** Every once-only key of the month's payments. Under the sign-up's own
 *  `org-<id>:msu:` prefix would hide them from nothing, but they are money:
 *  their own namespace, `org-<id>:mpy:`. */
export function paymentKeyPrefix(orgId: string): string {
  return `org-${orgId}:mpy:`;
}

async function claimOnce(key: string, kind: string): Promise<boolean> {
  try {
    await db.sentNotification.create({ data: { key, kind } });
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

/** One spender of a club's credits at a time. A credit belongs to a
 *  player in a CLUB, not to a month: two fixtures priced at the same
 *  moment must not both spend it. Taken after the month's own lock. */
async function lockClubCredits(tx: Tx, orgId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`squad-credits:${orgId}`}))`;
}

// ── Who confirms (D3) ──────────────────────────────────────────────────

/**
 * May this person confirm a month's payments? The club's money collector,
 * and only them. A club with no collector set: its OWNER and ADMINs.
 */
export async function mayConfirmPayments(orgId: string, userId: string): Promise<boolean> {
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: { paymentHolderId: true } });
  if (!org) return false;
  if (org.paymentHolderId) return org.paymentHolderId === userId;
  const admin = await db.membership.findFirst({
    where: { orgId, userId, leftAt: null, role: { in: ["OWNER", "ADMIN"] } },
    select: { id: true },
  });
  return admin !== null;
}

// ── The price (plan 4.2) ───────────────────────────────────────────────

type MemberRow = {
  id: string;
  userId: string;
  kind: string;
  tier: string;
  note: string | null;
  leftAt: Date | null;
  gamesCovered: number;
  creditsApplied: number;
  paidAt: Date | null;
  paidClaimedAt: Date | null;
};

const MEMBER_FIELDS = {
  id: true,
  userId: true,
  kind: true,
  tier: true,
  note: true,
  leftAt: true,
  gamesCovered: true,
  creditsApplied: true,
  paidAt: true,
  paidClaimedAt: true,
} as const;

const pricingMember = (r: MemberRow, inClub: ReadonlySet<string>): PricingMember => ({
  userId: r.userId,
  kind: r.kind === "payg" ? "payg" : "regular",
  tier: r.tier === "concession" ? "concession" : "standard",
  waiting: r.kind === "payg" && r.note === WAITING_NOTE,
  // Somebody who has left the group owes nothing more for the month.
  out: r.leftAt !== null || !inClub.has(r.userId),
  gamesCovered: r.gamesCovered,
  creditsApplied: r.creditsApplied,
  paid: r.paidAt ? "confirmed" : r.paidClaimedAt ? "claimed" : "none",
});

/**
 * The credits these players may use against a month now: not voided, not
 * used, and for a game that has been PLAYED (or tied to no game: a manual
 * or carried credit). A credit for a game still to come can be taken back
 * if the regular plays after all, so it is never spent in advance.
 */
async function usableCredits(tx: Tx, orgId: string, userIds: string[], now: Date) {
  if (userIds.length === 0) return [];
  const credits = await tx.squadCredit.findMany({
    where: { orgId, userId: { in: userIds }, voidedAt: null, appliedMonthId: null },
    select: { id: true, userId: true, createdAt: true, earnedMatchId: true },
  });
  const matchIds = [...new Set(credits.map((c) => c.earnedMatchId).filter((id): id is string => id !== null))];
  const played = new Set(
    matchIds.length === 0
      ? []
      : (await tx.match.findMany({ where: { id: { in: matchIds }, date: { lt: now } }, select: { id: true } })).map((m) => m.id),
  );
  return credits.filter((c) => c.earnedMatchId === null || played.has(c.earnedMatchId));
}

async function inClubOf(tx: Tx, orgId: string, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await tx.membership.findMany({
    where: { orgId, userId: { in: userIds }, leftAt: null, user: { isActive: true } },
    select: { userId: true },
  });
  return new Set(rows.map((r) => r.userId));
}

export type PriceMonthError = PricingError | "not-found" | "closed" | "locked";

/**
 * Set (or change) a month's price: the share per game, an optional
 * concession share and venue cost, and the pay-by date (D1: the organiser
 * types it; MatchTime only suggests).
 *
 * Under the club-month's lock, in one transaction:
 *   - every regular who has not paid gets `share x (games - credits)`, and
 *     the credits used are marked used against this month (oldest first);
 *   - once anybody has paid or says so, the SHARE is locked ("locked"):
 *     only the pay-by date and the venue cost can still change;
 *   - a regular who has paid is not re-priced.
 * Saving the same price twice changes nothing. Nothing is posted here:
 * the scheduler posts the priced list.
 */
export async function priceMonth(args: {
  orgId: string;
  monthId: string;
  input: PricingInput;
  now?: Date;
}): Promise<{ ok: true } | { ok: false; error: PriceMonthError }> {
  const now = args.now ?? new Date();
  const valid = validatePricing(args.input, now);
  if (!valid.ok) return valid;
  const month = await db.squadMonth.findFirst({
    where: { id: args.monthId, orgId: args.orgId },
    select: { id: true, status: true, org: { select: { squadMode: true } } },
  });
  if (!month || normaliseSquadMode(month.org.squadMode) !== "monthly") return { ok: false, error: "not-found" };
  if (month.status === "closed") return { ok: false, error: "closed" };

  return db.$transaction(async (tx) => {
    await lockMonth(tx, month.id);
    await lockClubCredits(tx, args.orgId);
    const [current, rows] = await Promise.all([
      tx.squadMonth.findUnique({
        where: { id: month.id },
        select: { sharePerGamePence: true, concessionPerGamePence: true, pricedAt: true, payByAt: true },
      }),
      tx.squadMonthMember.findMany({ where: { monthId: month.id }, select: MEMBER_FIELDS }),
    ]);
    const inClub = await inClubOf(tx, args.orgId, rows.map((r) => r.userId));
    const members = rows.map((r) => pricingMember(r, inClub));
    const shareChanges = current?.sharePerGamePence !== args.input.sharePence || (current?.concessionPerGamePence ?? null) !== args.input.concessionPence;
    if (current?.pricedAt && shareChanges && priceLocked(members)) return { ok: false as const, error: "locked" as const };

    const credits = await usableCredits(tx, args.orgId, members.filter((m) => m.kind === "regular" && !m.out && !m.waiting).map((m) => m.userId), now);
    const plan = planPricing({ members, credits, sharePence: args.input.sharePence, concessionPence: args.input.concessionPence });
    for (const row of plan) {
      if (row.creditIds.length > 0) {
        // `appliedMonthId: null` in the WHERE: a credit is used once.
        await tx.squadCredit.updateMany({
          where: { id: { in: row.creditIds }, appliedMonthId: null, voidedAt: null },
          data: { appliedMonthId: month.id, appliedAt: now },
        });
      }
      await tx.squadMonthMember.updateMany({
        where: { monthId: month.id, userId: row.userId, paidAt: null, paidClaimedAt: null },
        data: { creditsApplied: row.creditsApplied, amountDuePence: row.amountDuePence },
      });
    }
    await tx.squadMonth.update({
      where: { id: month.id },
      data: {
        sharePerGamePence: args.input.sharePence,
        concessionPerGamePence: args.input.concessionPence,
        venueCostPence: args.input.venueCostPence,
        payByAt: args.input.payByAt,
        pricedAt: current?.pricedAt ?? now,
        // A pay-by date moved (it is always ahead of now): the summary
        // that follows it is due again, once, after the new date.
        ...(current?.payByAt?.getTime() !== args.input.payByAt.getTime() ? { summarySentAt: null } : {}),
      },
    });
    return { ok: true as const };
  });
}

/**
 * One member's amount, after their place on a PRICED month changed
 * (`applySignup`).
 *  - A regular who has not paid gets their amount, with their usable
 *    credits. One who has paid, or says so, is left exactly as they are.
 *  - Somebody who is a regular NO LONGER (moved to PAYG, taken off) owes
 *    nothing for the month: the credits pricing took for them go back to
 *    the ledger, whether or not they had said "paid" (never the ones the
 *    organiser said they came into the month with). Only a CONFIRMED
 *    payment keeps its credits spent: that money was paid net of them.
 */
export async function settleMemberAmount(monthId: string, userId: string, now: Date = new Date()): Promise<void> {
  await db.$transaction(async (tx) => {
    await lockMonth(tx, monthId);
    const month = await tx.squadMonth.findUnique({
      where: { id: monthId },
      select: { orgId: true, sharePerGamePence: true, concessionPerGamePence: true },
    });
    const row = await tx.squadMonthMember.findUnique({ where: { monthId_userId: { monthId, userId } }, select: MEMBER_FIELDS });
    if (!month || !row || month.sharePerGamePence == null) return;
    await lockClubCredits(tx, month.orgId);
    const member = pricingMember(row, await inClubOf(tx, month.orgId, [userId]));
    if (member.kind === "regular" && !member.out && !member.waiting) {
      if (member.paid !== "none") return;
      const credits = await usableCredits(tx, month.orgId, [userId], now);
      const [plan] = planPricing({ members: [member], credits, sharePence: month.sharePerGamePence, concessionPence: month.concessionPerGamePence });
      if (!plan) return;
      if (plan.creditIds.length > 0) {
        await tx.squadCredit.updateMany({
          where: { id: { in: plan.creditIds }, appliedMonthId: null, voidedAt: null },
          data: { appliedMonthId: monthId, appliedAt: now },
        });
      }
      await tx.squadMonthMember.update({ where: { id: row.id }, data: { creditsApplied: plan.creditsApplied, amountDuePence: plan.amountDuePence } });
      return;
    }
    if (row.paidAt) return;
    const released = await tx.squadCredit.updateMany({
      where: { orgId: month.orgId, userId, appliedMonthId: monthId, voidedAt: null, reason: { not: "carried-in" } },
      data: { appliedMonthId: null, appliedAt: null },
    });
    await tx.squadMonthMember.update({
      where: { id: row.id },
      data: { creditsApplied: Math.max(0, Math.min(row.gamesCovered, row.creditsApplied - released.count)), amountDuePence: null },
    });
  });
}

// ── "Says paid" and "confirmed" (plan 4.3, D3) ─────────────────────────

export type PaidClaimSource = "list" | "dm" | "page" | "other-player";

/**
 * Record that a regular SAYS they have paid. A claim: `paidAt` is not
 * touched, and a row that already says paid (or is confirmed) is left
 * alone. True when this call made the claim.
 *
 * ONE EXCEPTION, and it is still only a claim: when the collector has
 * answered "not arrived" to their earlier claim and they say "paid"
 * again, this is a NEW claim. It gets a new time and the decline is
 * dropped, so it has to appear on a NEW digest before anybody can
 * confirm it. (A reply to the old digest can never reach it: the claim is
 * newer than that digest.)
 */
export async function claimMonthPaid(args: {
  monthId: string;
  userId: string;
  source: PaidClaimSource;
  amountPence?: number | null;
  now?: Date;
}): Promise<boolean> {
  const now = args.now ?? new Date();
  const base = {
    monthId: args.monthId,
    userId: args.userId,
    kind: "regular",
    leftAt: null,
    paidAt: null,
    month: { status: { not: "closed" }, org: { squadMode: "monthly" } },
  };
  const data = { paidClaimedAt: now, paidClaimSource: args.source, paidClaimedAmountPence: args.amountPence ?? null };
  const fresh = await db.squadMonthMember.updateMany({ where: { ...base, paidClaimedAt: null }, data });
  if (fresh.count > 0) return true;
  // Already says paid. Was that claim declined?
  const month = await db.squadMonth.findUnique({ where: { id: args.monthId }, select: { orgId: true } });
  if (!month) return false;
  const dropped = await db.sentNotification.deleteMany({ where: { key: declinedKey(month.orgId, args.monthId, args.userId) } });
  if (!dropped || dropped.count === 0) return false;
  const again = await db.squadMonthMember.updateMany({ where: { ...base, paidClaimedAt: { not: null } }, data });
  return again.count > 0;
}

export type ConfirmPaidError = "not-found" | "not-collector" | "closed";

/** THE ONE PLACE `paidAt` IS WRITTEN for a month. The caller has decided
 *  who is asking; this checks only the month and the row. */
async function writeConfirmed(
  orgId: string,
  monthId: string,
  userIds: string[],
  actorUserId: string,
  now: Date,
  /** A reply to a digest: only a claim made before that digest was sent. */
  claimedBefore?: Date,
): Promise<string[]> {
  if (userIds.length === 0) return [];
  return db.$transaction(async (tx) => {
    await lockMonth(tx, monthId);
    const month = await tx.squadMonth.findFirst({ where: { id: monthId, orgId, status: { not: "closed" } }, select: { id: true } });
    if (!month) return [];
    const rows = await tx.squadMonthMember.findMany({
      where: {
        monthId,
        userId: { in: userIds },
        kind: "regular",
        leftAt: null,
        paidAt: null,
        ...(claimedBefore ? { paidClaimedAt: { lte: claimedBefore } } : {}),
      },
      select: { id: true, userId: true, amountDuePence: true, paidClaimedAmountPence: true },
    });
    for (const r of rows) {
      await tx.squadMonthMember.updateMany({
        where: { id: r.id, paidAt: null },
        data: { paidAt: now, paidAmountPence: r.paidClaimedAmountPence ?? r.amountDuePence, paidConfirmedByUserId: actorUserId, paymentMethod: "bank" },
      });
    }
    return rows.map((r) => r.userId);
  });
}

/** The collector confirms one regular's payment, on the page. */
export async function confirmMonthPaid(args: {
  orgId: string;
  monthId: string;
  userId: string;
  actorUserId: string;
  now?: Date;
}): Promise<{ ok: true; changed: boolean } | { ok: false; error: ConfirmPaidError }> {
  if (!(await mayConfirmPayments(args.orgId, args.actorUserId))) return { ok: false, error: "not-collector" };
  const month = await db.squadMonth.findFirst({ where: { id: args.monthId, orgId: args.orgId }, select: { status: true, org: { select: { squadMode: true } } } });
  if (!month || normaliseSquadMode(month.org.squadMode) !== "monthly") return { ok: false, error: "not-found" };
  if (month.status === "closed") return { ok: false, error: "closed" };
  const done = await writeConfirmed(args.orgId, args.monthId, [args.userId], args.actorUserId, args.now ?? new Date());
  return { ok: true, changed: done.length > 0 };
}

/** The collector takes a confirmation back (a mistake). The player's own
 *  claim, if they made one, stands as it was. */
export async function unconfirmMonthPaid(args: {
  orgId: string;
  monthId: string;
  userId: string;
  actorUserId: string;
}): Promise<{ ok: true; changed: boolean } | { ok: false; error: ConfirmPaidError }> {
  if (!(await mayConfirmPayments(args.orgId, args.actorUserId))) return { ok: false, error: "not-collector" };
  const res = await db.squadMonthMember.updateMany({
    where: { monthId: args.monthId, userId: args.userId, paidAt: { not: null }, stripeSessionId: null, month: { orgId: args.orgId, status: { not: "closed" } } },
    data: { paidAt: null, paidAmountPence: null, paidConfirmedByUserId: null, paymentMethod: null },
  });
  return { ok: true, changed: res.count > 0 };
}

const declinedKey = (orgId: string, monthId: string, userId: string) => `${paymentKeyPrefix(orgId)}declined:${monthId}:${userId}`;
const digestPrefix = (orgId: string, monthId: string) => `${paymentKeyPrefix(orgId)}digest:${monthId}:`;
/** One row per claim a digest LISTED: `...:digest-item:<monthId>:<digest id>#<userId>`.
 *  The "#" ends the digest's id, so one digest's rows are never another's. */
const digestItemPrefix = (orgId: string, monthId: string, day: string) => `${paymentKeyPrefix(orgId)}digest-item:${monthId}:${day}#`;

// ── A player's "paid" DM ───────────────────────────────────────────────

/**
 * A player DMs "paid" (the fixed vocabulary of `readPaidMessage`; no
 * model). Engages only when they are a regular with ONE month to pay for
 * and owe no released per-match fee (that "Paid" is today's per-match
 * claim, untouched). Records the claim and answers once a day. Null: not
 * ours, and the DM goes on exactly as before.
 */
export async function handlePlayerPaidDm(input: {
  userId: string;
  userName: string | null;
  text: string;
  replyPhone: string | null;
  now?: Date;
}): Promise<{ handled: "month-paid-claim"; monthId: string; claimed: boolean } | null> {
  const read = readPaidMessage(input.text);
  if (!read || !input.replyPhone) return null;
  const now = input.now ?? new Date();
  const owed = await db.squadMonthMember.findMany({
    where: {
      userId: input.userId,
      kind: "regular",
      leftAt: null,
      paidAt: null,
      amountDuePence: { gt: 0 },
      month: { status: { in: ["open", "priced", "running"] }, pricedAt: { not: null }, org: { squadMode: "monthly" } },
    },
    select: {
      monthId: true,
      amountDuePence: true,
      paidClaimedAt: true,
      month: { select: { orgId: true, monthStart: true, org: { select: { language: true, paymentHolderId: true } } } },
    },
    take: 2,
  });
  // No month to pay for, or two: not ours to guess.
  if (owed.length !== 1) return null;
  const perMatch = await db.attendance.count({
    where: {
      userId: input.userId,
      paidAt: null,
      status: "CONFIRMED",
      OR: [{ paymentMethod: null }, { paymentMethod: { not: "monthly" } }],
      match: { isHistorical: false, status: { not: "CANCELLED" }, feePerPlayer: { not: null }, paymentLinksReleasedAt: { not: null } },
    },
  });
  if (perMatch > 0) return null;

  const row = owed[0];
  const { orgId } = row.month;
  // Saying it again after the collector said "not arrived" is a new claim
  // (`claimMonthPaid`): it goes on a new digest before it can be confirmed.
  const claimed = await claimMonthPaid({ monthId: row.monthId, userId: input.userId, source: "dm", amountPence: read.amountPence, now });

  const day = formatLondon(now, "yyyy-MM-dd");
  if (await claimOnce(`${paymentKeyPrefix(orgId)}claim-ack:${row.monthId}:${input.userId}:${day}`, "month-pay-dm")) {
    const collector = row.month.org.paymentHolderId
      ? await db.user.findUnique({ where: { id: row.month.org.paymentHolderId }, select: { name: true } })
      : null;
    await db.botJob.create({
      data: {
        orgId,
        kind: "dm",
        phone: input.replyPhone,
        text: buildPaidClaimAckDm({
          name: input.userName,
          amountPence: read.amountPence ?? row.amountDuePence,
          monthDate: new Date(`${row.month.monthStart.toISOString().slice(0, 10)}T12:00:00.000Z`),
          collectorName: collector?.name ?? null,
          lang: row.month.org.language,
        }),
      },
    });
  }
  return { handled: "month-paid-claim", monthId: row.monthId, claimed };
}

// ── The collector's reply to the digest ────────────────────────────────

interface WaitingRow {
  userId: string;
  name: string;
  slot: number | null;
  claimedAt: Date;
  amountPence: number | null;
}

/** The claims of a month still waiting for the collector's word: said
 *  paid, not confirmed, and not already answered "not arrived". */
async function waitingClaims(month: SignupMonth): Promise<WaitingRow[]> {
  const claimed = month.members.filter((m) => m.kind === "regular" && !m.out && m.paid === "claimed" && m.paidClaimedAt);
  if (claimed.length === 0) return [];
  const declined = new Set(
    (
      await db.sentNotification.findMany({
        where: { key: { in: claimed.map((m) => declinedKey(month.orgId, month.id, m.userId)) } },
        select: { key: true },
      })
    ).map((r) => r.key),
  );
  return claimed
    .filter((m) => !declined.has(declinedKey(month.orgId, month.id, m.userId)))
    .map((m) => ({ userId: m.userId, name: m.name, slot: m.slot, claimedAt: m.paidClaimedAt!, amountPence: m.paidPence ?? m.amountDuePence }))
    .sort((a, b) => (a.slot ?? 999) - (b.slot ?? 999));
}

/** The last digest sent for a month: when, and exactly whose claims it
 *  listed (the rows written when it was sent). Null: none was sent. */
async function latestDigest(orgId: string, monthId: string): Promise<SentDigest | null> {
  const prefix = digestPrefix(orgId, monthId);
  const row = await db.sentNotification.findFirst({
    where: { key: { startsWith: prefix } },
    orderBy: { createdAt: "desc" },
    select: { key: true, createdAt: true },
  });
  if (!row) return null;
  const items = await db.sentNotification.findMany({
    where: { key: { startsWith: digestItemPrefix(orgId, monthId, row.key.slice(prefix.length)) } },
    select: { targetUser: true },
  });
  return { at: row.createdAt, userIds: items.map((i) => i.targetUser).filter((u): u is string => !!u) };
}

/**
 * The collector answers the digest: "PAID ALL", "PAID 1 3", "PAID NONE"
 * (`readCollectorReply`: the word PAID is required; a stray "ok" or a
 * bare number is never read). Null when the text is not that, or the
 * sender may not confirm for any monthly club: the message then goes on
 * exactly as before, and nothing has been written for it. The same when
 * no digest is outstanding (none sent in the last two days), or when none
 * of the numbers is on it: "paid 8" from an organiser who is also a
 * player is their own message, not an answer to anything.
 *
 * Only claims the LAST digest LISTED are touched (the rows recorded when
 * it was sent), and only while they are those same claims; a number that
 * is not one of them confirms nothing; and a "NONE" is recorded: those
 * claims are not put to the collector again (the Months page still shows
 * them). One WhatsApp message is applied once.
 */
export async function handleCollectorPaidReply(input: {
  text: string;
  waMessageId: string | null;
  /** The sender, already resolved to user ids (by phone, or in an admin group). */
  senderUserIds: string[];
  /** Only this club (the admin group's). Omitted for a DM. */
  orgId?: string;
  now?: Date;
}): Promise<{ handled: string; orgId: string; replyText: string } | null> {
  const reply = readCollectorReply(input.text);
  if (!reply || input.senderUserIds.length === 0) return null;
  const now = input.now ?? new Date();

  const memberships = await db.membership.findMany({
    where: {
      userId: { in: input.senderUserIds },
      leftAt: null,
      ...(input.orgId ? { orgId: input.orgId } : {}),
      org: { squadMode: "monthly" },
    },
    select: { userId: true, orgId: true, org: { select: { language: true } } },
  });
  // Every month this sender may confirm for that has had a digest.
  const out: Array<{ month: SignupMonth; actorUserId: string; digest: SentDigest; lang: string | null }> = [];
  for (const m of memberships) {
    if (!(await mayConfirmPayments(m.orgId, m.userId))) continue;
    for (const month of await loadLiveMonths(m.orgId, now)) {
      const digest = await latestDigest(m.orgId, month.id);
      if (digest) out.push({ month, actorUserId: m.userId, digest, lang: m.org.language });
    }
  }
  // WHICH MONTH. The one the reply names ("PAID NOVEMBER ALL"); else the
  // one whose digest is the newest: that is the message being answered.
  const named = reply.month != null ? out.filter((o) => o.month.monthNumber === reply.month) : out;
  const best = [...named].sort((a, b) => b.digest.at.getTime() - a.digest.at.getTime())[0] ?? null;
  // Nobody who may confirm, or no digest ever sent: not a reply to one.
  if (!best) return null;
  const { month, actorUserId, lang } = best;

  const claims = await waitingClaims(month);
  const decision = decideCollectorReply({ reply, claims, digest: best.digest, now });
  // No digest was ever answerable by this, or none of the numbers is on
  // it: somebody's own message ("paid 8"), and it goes on untouched.
  if (decision.kind === "not-a-reply") return null;

  // Applied once per WhatsApp message (the Pi retries).
  if (input.waMessageId && !(await claimOnce(`${paymentKeyPrefix(month.orgId)}reply:${input.waMessageId}`, "month-pay-reply"))) {
    return { handled: "month-paid-duplicate", orgId: month.orgId, replyText: "" };
  }
  const nameOf = new Map(claims.map((c) => [c.userId, c.name]));
  // Another month with claims out on a digest of its own: the answer says
  // which month this was for, and how to answer the other.
  let hint = "";
  for (const o of out) {
    if (o.month.id === month.id || now.getTime() - o.digest.at.getTime() > DIGEST_REPLY_WINDOW_MS) continue;
    const listed = new Set(o.digest.userIds);
    if ((await waitingClaims(o.month)).some((c) => listed.has(c.userId))) {
      hint = `\n\n${buildOtherMonthHint({ monthDate: month.firstKickoff, otherDate: o.month.firstKickoff, lang })}`;
      break;
    }
  }
  const answer = (text: string, handled: string) => ({ handled, orgId: month.orgId, replyText: `${text}${hint}` });

  if (decision.kind === "stale") {
    // Out of date: nobody is marked. The collector gets the list as it
    // stands now, sent and recorded as a digest of its own, so the next
    // reply answers THAT.
    const current = claims.length > 0 ? await sendDigestNow(month, claims, now, `${formatLondon(now, "yyyy-MM-dd")}:again:${input.waMessageId ?? now.getTime()}`) : null;
    return answer(buildStaleReplyAnswer({ current, lang }), "month-paid-stale");
  }
  if (decision.kind === "nothing-waiting") {
    return answer(buildCollectorReplyAnswer({ kind: "nothing", lang }), "month-paid-nothing");
  }
  if (decision.kind === "unknown-numbers") {
    return answer(buildCollectorReplyAnswer({ kind: "unknown-numbers", numbers: decision.numbers, monthDate: month.firstKickoff, lang }), "month-paid-unknown");
  }
  if (decision.kind === "decline") {
    for (const userId of decision.userIds) {
      await db.sentNotification.create({ data: { key: declinedKey(month.orgId, month.id, userId), kind: "month-pay-declined", targetUser: userId } }).catch(() => {});
    }
    return answer(
      buildCollectorReplyAnswer({ kind: "declined", names: decision.userIds.map((u) => nameOf.get(u) ?? ""), monthDate: month.firstKickoff, lang }),
      "month-paid-declined",
    );
  }
  // Only claims made BEFORE that digest: a row re-claimed since is not written.
  const done = await writeConfirmed(month.orgId, month.id, decision.userIds, actorUserId, now, best.digest.at);
  if (done.length === 0) return answer(buildCollectorReplyAnswer({ kind: "nothing", lang }), "month-paid-nothing");
  return answer(
    buildCollectorReplyAnswer({ kind: "confirmed", names: done.map((u) => nameOf.get(u) ?? ""), monthDate: month.firstKickoff, lang }),
    "month-paid-confirmed",
  );
}

/**
 * Record a digest (its key, then exactly the claims it lists) and return
 * its text. The caller sends it. Null when that digest id was already
 * recorded (another poll, or a retry).
 */
async function sendDigestNow(month: SignupMonth, claims: WaitingRow[], now: Date, id: string): Promise<string | null> {
  void now;
  if (!(await claimOnce(`${digestPrefix(month.orgId, month.id)}${id}`, "month-pay-digest"))) return null;
  // EXACTLY what this digest lists, recorded with it: a reply can only
  // ever confirm these. A claim made a moment later is not among them.
  await db.sentNotification.createMany({
    data: claims.map((c) => ({ key: `${digestItemPrefix(month.orgId, month.id, id)}${c.userId}`, kind: "month-pay-digest-item", targetUser: c.userId })),
    skipDuplicates: true,
  });
  return buildClaimsDigest({ claims: claims.map((c) => ({ slot: c.slot, name: c.name, amountPence: c.amountPence })), monthDate: month.firstKickoff, lang: month.language });
}

/** The DM door: the sender is resolved by PHONE only, and the answer goes
 *  back by DM. The text is checked first, so a DM that is not a "PAID ..."
 *  reply costs no query at all. */
export async function handleCollectorPaidDm(input: {
  phone?: string | null;
  senderAltPhone?: string | null;
  text: string;
  waMessageId: string;
  now?: Date;
}): Promise<{ handled: string } | null> {
  if (!readCollectorReply(input.text)) return null;
  const phones = [input.phone, input.senderAltPhone]
    .map((p) => (typeof p === "string" && p.trim() ? normalisePhone(p.trim().startsWith("+") ? p.trim() : `+${p.trim().replace(/\D/g, "")}`) : null))
    .filter((p): p is string => !!p);
  if (phones.length === 0) return null;
  const users = await db.user.findMany({ where: { phoneNumber: { in: phones } }, select: { id: true, phoneNumber: true } });
  if (users.length === 0) return null;
  const res = await handleCollectorPaidReply({ text: input.text, waMessageId: input.waMessageId, senderUserIds: users.map((u) => u.id), now: input.now });
  if (!res) return null;
  const phone = users[0].phoneNumber?.replace(/^\+/, "");
  if (res.replyText && phone) await db.botJob.create({ data: { orgId: res.orgId, kind: "dm", phone, text: res.replyText } });
  return { handled: res.handled };
}

// ── The poll's side effects ────────────────────────────────────────────

const activeRegulars = (m: SignupMonth) => m.members.filter((x) => x.kind === "regular" && !x.out);

/**
 * The due-posts poll's one call for the month's money, BEFORE the posts
 * are computed. A club on "weekly" returns after one read. Never throws.
 *
 *   - "set the price": once per month, when sign-up has ended (or every
 *     regular place is taken) and no price is set;
 *   - the claims digest: once a London day from 10:00, to the collector
 *     (else the organisers), while a claim waits for their word;
 *   - the summary: once, after the pay-by date.
 */
export async function sweepMonthPayments(
  orgId: string,
  now: Date = new Date(),
  /** The club's live months, when the sign-up sweep has just read them. */
  preloaded?: SignupMonth[] | null,
): Promise<void> {
  try {
    const org = await db.organisation.findUnique({
      where: { id: orgId },
      select: {
        squadMode: true,
        approvalStatus: true,
        dormantAt: true,
        billingStatus: true,
        billingPlan: true,
        billingPricePence: true,
        paymentHolderId: true,
      },
    });
    if (!org || normaliseSquadMode(org.squadMode) !== "monthly" || !isClubOperational(org)) return;
    const months = preloaded ?? (await loadLiveMonths(orgId, now));
    for (const month of months) {
      await priceAsk(month, org, now);
      await claimsDigest(month, org.paymentHolderId, now);
      await payBySummary(month, now);
    }
  } catch (err) {
    console.error(`[month-payment] sweep for ${orgId} failed (the next poll retries):`, err);
  }
}

async function priceAsk(
  month: SignupMonth,
  org: { billingStatus: string | null; billingPlan: string; billingPricePence: number | null },
  now: Date,
): Promise<void> {
  // Only a month MatchTime opened itself, with no price, whose games are
  // still to come.
  if (!month.listOpenedAt || month.pricedAt) return;
  const regulars = activeRegulars(month).length;
  if (!priceAskDue({ now, listOpenedAt: month.listOpenedAt, firstKickoff: month.firstKickoff, regulars, maxRegulars: month.maxRegulars })) return;
  if (!(await claimOnce(`${paymentKeyPrefix(month.orgId)}price-ask:${month.id}`, "admin-notice"))) return;
  const price = org.billingStatus === "exempt" ? null : planPricePence(org.billingPlan, org.billingPricePence);
  const fee = monthFeeShare({ pricePence: price, regulars, games: month.kickoffs.length });
  const tip = fee && price ? buildMonthFeeTip({ pricePence: price, regulars, games: month.kickoffs.length, ...fee, lang: month.language }) : null;
  await sendAdminNotice({
    orgId: month.orgId,
    now,
    nextPath: "/admin/months",
    text: (link) =>
      buildPriceAskNotice({
        monthDate: month.firstKickoff,
        regulars,
        payg: month.members.filter((m) => m.kind === "payg" && !m.out && !m.waiting).length,
        link: link || appUrl("/admin/months"),
        tip,
        lang: month.language,
      }),
  });
}

async function claimsDigest(month: SignupMonth, collectorId: string | null, now: Date): Promise<void> {
  // The cheap tests first: nobody says paid, or not the hour for it.
  if (!month.members.some((m) => m.paid === "claimed" && !m.out)) return;
  if (!claimsDigestDue({ now, sentToday: false, waiting: 1 })) return;
  const day = formatLondon(now, "yyyy-MM-dd");
  const key = `${digestPrefix(month.orgId, month.id)}${day}`;
  const sentToday = (await db.sentNotification.findUnique({ where: { key }, select: { id: true } })) !== null;
  if (sentToday) return;
  const claims = await waitingClaims(month);
  if (!claimsDigestDue({ now, sentToday, waiting: claims.length })) return;
  const text = await sendDigestNow(month, claims, now, day);
  if (!text) return;
  const collector = collectorId ? await db.user.findUnique({ where: { id: collectorId }, select: { phoneNumber: true } }) : null;
  if (collector?.phoneNumber) {
    await db.botJob.create({ data: { orgId: month.orgId, kind: "dm", phone: collector.phoneNumber.replace(/^\+/, ""), text } });
  } else {
    await sendAdminNotice({ orgId: month.orgId, now, text });
  }
}

async function payBySummary(month: SignupMonth, now: Date): Promise<void> {
  if (!month.pricedAt || !month.payByAt || month.summarySentAt || now.getTime() < month.payByAt.getTime()) return;
  // The claim: only one poll moves it from null.
  const claim = await db.squadMonth.updateMany({ where: { id: month.id, summarySentAt: null }, data: { summarySentAt: now } });
  if (claim.count === 0) return;
  const regulars = activeRegulars(month);
  const confirmed = regulars.filter((m) => m.paid === "confirmed");
  await sendAdminNotice({
    orgId: month.orgId,
    now,
    nextPath: "/admin/months",
    text: buildPayBySummary({
      monthDate: month.firstKickoff,
      confirmed: { count: confirmed.length, totalPence: confirmed.reduce((sum, m) => sum + (m.paidPence ?? 0), 0) },
      claimed: regulars.filter((m) => m.paid === "claimed").map((m) => m.name),
      unpaid: regulars.filter((m) => m.paid === "none" && (m.amountDuePence ?? 0) > 0).map((m) => m.name),
      venue:
        month.venueCostPence != null
          ? { duePence: regulars.reduce((sum, m) => sum + (m.amountDuePence ?? 0), 0), venuePence: month.venueCostPence * month.kickoffs.length }
          : null,
      lang: month.language,
    }),
  });
}

// ── For the scheduler: the priced list, the count, the reminder DMs ────

export type PaymentInstruction =
  | { kind: "group-message"; key: string; text: string }
  | { kind: "dm"; key: string; phone: string; text: string; targetUser: string };

/** The priced list as it stands. */
export function renderPricedList(month: SignupMonth, facts: { collectorName: string | null; instructions: string | null }): string | null {
  if (month.sharePerGamePence == null || !month.payByAt) return null;
  const lines = new Map<string, PricedLine>(
    activeRegulars(month).map((m) => [m.userId, { amountDuePence: m.amountDuePence, paid: m.paid, paidPence: m.paidPence }]),
  );
  return buildPricedListPost({
    list: buildSignupList({ members: month.members, maxRegulars: month.maxRegulars, matches: month.matches }),
    lines,
    kickoffs: month.kickoffs,
    // What a regular in for the whole month is charged for, so the line in
    // brackets always agrees with the amounts under it.
    games: Math.max(0, ...activeRegulars(month).map((m) => m.gamesCovered)) || month.kickoffs.length,
    sharePence: month.sharePerGamePence,
    payByAt: month.payByAt,
    collectorName: facts.collectorName,
    instructions: facts.instructions,
    lang: month.language,
  });
}

/**
 * The payment posts and DMs due for a club right now, for
 * `computeDuePosts`. The caller has checked the club is monthly; a club
 * with no priced month costs one read.
 *
 *   - the priced list: ONE post per price (a new share or pay-by date is a
 *     new one), in waking hours, before the pay-by date, 30 minutes apart;
 *   - the group's count: once, in the last 24 hours;
 *   - a DM to each regular who has not paid: a day before, on the day,
 *     then once a day for three days. Never the collector (the existing
 *     rule), never somebody who says they have paid (unless the collector
 *     answered "not arrived"), never 22:00 to 07:59.
 * Every instruction has its own key and is claimed when it is handed out.
 */
export async function monthPaymentPosts(
  orgId: string,
  now: Date,
  /** The club's live months, when the poll has just read them. */
  preloaded?: SignupMonth[] | null,
): Promise<PaymentInstruction[]> {
  if (!isDaytime(now)) return [];
  const months = (preloaded ?? (await loadLiveMonths(orgId, now))).filter(
    (m) => m.pricedAt && m.payByAt && m.sharePerGamePence != null && now.getTime() < m.payByAt.getTime() + (3 + 1) * DAY_MS,
  );
  if (months.length === 0) return [];
  // The club's own state, checked HERE: a dormant or billing-paused club
  // is reminded of nothing, whoever called.
  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: { paymentHolderId: true, paymentInstructions: true, squadMode: true, approvalStatus: true, dormantAt: true, billingStatus: true },
  });
  if (!org || normaliseSquadMode(org.squadMode) !== "monthly" || !isClubOperational(org)) return [];
  const collector = org?.paymentHolderId ? await db.user.findUnique({ where: { id: org.paymentHolderId }, select: { name: true } }) : null;
  const out: PaymentInstruction[] = [];

  for (const month of months) {
    const payByAt = month.payByAt!;
    const prefix = paymentKeyPrefix(orgId);
    const sent = await db.sentNotification.findMany({
      where: { key: { startsWith: `${prefix}` }, AND: { key: { contains: `:${month.id}:` } } },
      select: { key: true, kind: true, createdAt: true },
    });
    const sentAt = new Map(sent.map((r) => [r.key, r.createdAt]));

    // The priced list: one post per (share, concession, pay-by date).
    const text = renderPricedList(month, { collectorName: collector?.name ?? null, instructions: org?.paymentInstructions ?? null });
    const pricedPrefix = `${prefix}priced:${month.id}:`;
    const pricedKey = `${pricedPrefix}${weekListHash(`${month.sharePerGamePence}|${month.concessionPerGamePence ?? ""}|${payByAt.toISOString()}`)}`;
    const lastPriced = Math.max(0, ...sent.filter((r) => r.key.startsWith(pricedPrefix)).map((r) => r.createdAt.getTime()));
    if (text && !sentAt.has(pricedKey) && now.getTime() < payByAt.getTime() && now.getTime() - lastPriced >= SIGNUP_REPOST_FLOOR_MS) {
      out.push({ kind: "group-message", key: pricedKey, text });
    }

    // Who is still to pay. Somebody who says they paid is not chased,
    // unless the collector answered that it has not arrived.
    const regulars = activeRegulars(month).filter((m) => (m.amountDuePence ?? 0) > 0 && m.paid !== "confirmed" && m.userId !== org?.paymentHolderId);
    const declined = new Set(sent.filter((r) => r.kind === "month-pay-declined").map((r) => r.key));
    const unpaid = regulars.filter((m) => m.paid === "none" || declined.has(declinedKey(orgId, month.id, m.userId)));

    const groupKey = `${prefix}group:${month.id}:count`;
    if (groupReminderDue({ now, payByAt, sent: sentAt.has(groupKey), unpaid: unpaid.length })) {
      out.push({ kind: "group-message", key: groupKey, text: buildGroupPayReminder({ count: unpaid.length, monthDate: month.firstKickoff, payByAt, lang: month.language }) });
    }

    if (unpaid.length === 0 || now.getTime() < payByAt.getTime() - DAY_MS) continue;
    const phones = new Map(
      (await db.user.findMany({ where: { id: { in: unpaid.map((m) => m.userId) } }, select: { id: true, phoneNumber: true } })).map((u) => [u.id, u.phoneNumber]),
    );
    const today = formatLondon(now, "yyyy-MM-dd");
    for (const m of unpaid) {
      const phone = phones.get(m.userId)?.replace(/^\+/, "");
      if (!phone) continue;
      const base = `${prefix}dm:${month.id}:${m.userId}:`;
      const history: RemindersSent = {
        r1At: sentAt.get(`${base}r1`) ?? null,
        r2At: sentAt.get(`${base}r2`) ?? null,
        lateDays: [...sentAt.keys()].filter((k) => k.startsWith(`${base}late:`)).map((k) => k.slice(`${base}late:`.length)),
      };
      const kind = duePaymentReminder({ now, payByAt, sent: history });
      if (!kind) continue;
      out.push({
        kind: "dm",
        key: kind === "late" ? `${base}late:${today}` : `${base}${kind}`,
        phone,
        targetUser: m.userId,
        text: buildPayReminderDm({
          kind,
          name: m.name,
          monthDate: month.firstKickoff,
          amountDuePence: m.amountDuePence ?? 0,
          games: m.gamesCovered,
          credits: m.creditsApplied,
          payByAt,
          collectorName: collector?.name ?? null,
          instructions: org?.paymentInstructions ?? null,
          lang: month.language,
        }),
      });
    }
  }
  return out;
}
