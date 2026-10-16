/**
 * FREE PLACES, THE PURE RULES (2026-10-16). No database, no clock.
 *
 * A club can give a player a free place on a match (FNF: the player who
 * washes the bibs). That is `Attendance.feeWaivedAt`: the player owes
 * nothing, and it is NOT a payment. `paidAt` means money reached the
 * collector; a free place means no money is due. Keeping them apart is
 * what lets the payments page show "Free" and leave it out of
 * "collected", which tonight's stopgap (#299, marking them "received")
 * could not.
 *
 * Every reader of "who owes for this match" applies the same three
 * exclusions, here: the collector (collects, does not pay), a monthly
 * regular (paid for by the month), and a free place. Paid rows are left
 * to each reader, because some count them (the fee headcount: a player
 * who already paid cash still paid THIS fee) and some do not (the chase).
 *
 * Paid wins over free everywhere: a row can end up both (a bank payment
 * that started before the free place and settled after it). Money moved,
 * so it reads as paid and the collector refunds it if they want to;
 * MatchTime never moves money back by itself.
 */
/** `monthly-week.ts`'s `MONTHLY_PAYMENT_METHOD`, repeated here because
 *  that module reads the database and this one must not;
 *  fee-waiver-rules.test.ts pins that the two agree. */
const MONTHLY_PAYMENT_METHOD = "monthly";

/** The one reason in use today. The column is a free-text code. */
export const FEE_WAIVER_REASON_ORGANISER = "organiser";

export function isFeeWaived(a: { feeWaivedAt?: Date | null }): boolean {
  return a.feeWaivedAt != null;
}

interface FeeRow {
  status?: string;
  paidAt?: Date | null;
  feeWaivedAt?: Date | null;
  paymentMethod?: string | null;
}

/** Owes this match's fee right now: not the collector, not a monthly
 *  regular, not paid, not on a free place. */
export function owesMatchFee(a: FeeRow & { userId: string }, collectorId: string | null): boolean {
  if (collectorId && a.userId === collectorId) return false;
  if (a.paymentMethod === MONTHLY_PAYMENT_METHOD) return false;
  if (a.paidAt) return false;
  return !isFeeWaived(a);
}

export type WaiveDecision = "waive" | "already-free" | "already-paid" | "monthly" | "not-in-squad";

/** May this attendance be made free? The write itself repeats the
 *  conditions in its WHERE (`fee-waiver.ts`), so a race cannot get past
 *  them; this is what the reply says. */
export function decideWaive(a: FeeRow | null): WaiveDecision {
  if (!a || a.status === "DROPPED") return "not-in-squad";
  if (a.paidAt) return "already-paid";
  if (isFeeWaived(a)) return "already-free";
  if (a.paymentMethod === MONTHLY_PAYMENT_METHOD) return "monthly";
  return "waive";
}

/** A game that kicked off this recently is the one whose fee is being
 *  collected, so "he's free this week" means it. */
export const FEE_WAIVER_RECENT_MS = 48 * 60 * 60 * 1000;

/**
 * Which match an organiser means by "free this week", from the club's
 * matches that are not cancelled: the latest game that kicked off within
 * the last 48 hours, else the next game not yet kicked off, else none.
 * The reply always names the match's day, so a wrong guess is visible.
 */
export function pickWaiverMatch<T extends { date: Date }>(matches: readonly T[], now: Date): T | null {
  const t = now.getTime();
  const recent = matches
    .filter((m) => m.date.getTime() <= t && t - m.date.getTime() <= FEE_WAIVER_RECENT_MS)
    .sort((a, b) => b.date.getTime() - a.date.getTime());
  if (recent[0]) return recent[0];
  const ahead = matches.filter((m) => m.date.getTime() > t).sort((a, b) => a.date.getTime() - b.date.getTime());
  return ahead[0] ?? null;
}

/** The HQ outcome when a free place was asked for and none was given
 *  (already paid, not in the squad, no match): an answer, but nothing
 *  done, so no ✅ tick (admin-group.ts). */
export const HQ_FEE_FREE_NOTHING_DONE = "hq-fee-free-none";

export type CollectRowState = "paid" | "free" | "direct" | "unpaid";

/** How a row reads on /collect/<matchId>. */
export function collectRowState(a: FeeRow, directPending: boolean): CollectRowState {
  if (a.paidAt) return "paid";
  if (isFeeWaived(a)) return "free";
  return directPending ? "direct" : "unpaid";
}

/**
 * The number the collector's fee question uses (the N in "N played" and
 * the divisor of a total to split), and how many free places it left out.
 * CONFIRMED rows only, without the collector and monthly regulars. A paid
 * row still counts: that player paid this fee.
 */
export function feeHeadcount(
  rows: ReadonlyArray<FeeRow & { userId: string }>,
  collectorId: string | null,
): { headcount: number; freeCount: number } {
  let headcount = 0;
  let freeCount = 0;
  for (const a of rows) {
    if (a.status !== undefined && a.status !== "CONFIRMED") continue;
    if (collectorId && a.userId === collectorId) continue;
    if (a.paymentMethod === MONTHLY_PAYMENT_METHOD) continue;
    if (isFeeWaived(a) && !a.paidAt) freeCount++;
    else headcount++;
  }
  return { headcount, freeCount };
}
