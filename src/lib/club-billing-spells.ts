/**
 * CLUB FEE BILLING, games played (slice P2 review, H1): the spells in which
 * a club's games are never charged, recorded as `BillingEvent` rows.
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, 2A.3 and 13.3.
 *
 *   mt.unbilled / mt.billed          per club: not billable because it was
 *                                    set FREE (written by `setBillingState`
 *                                    on the move into and out of "exempt"),
 *                                    then billable again
 *   mt.suspended / mt.unsuspended    per club: SUSPENDED by the platform
 *                                    owner (written here), then billable
 *                                    again (slice P3, P2 review LOW 2: its
 *                                    own pair, so a Free spell that ends
 *                                    while the club is still suspended never
 *                                    ends the suspension's spell)
 *   mt.billing-off / mt.billing-on   GLOBAL (orgId NULL): BILLING_ENABLED
 *                                    seen off, then on, by the hourly run
 *
 * The month loader turns them into spans (`notChargedSpansFrom`): a game
 * inside one is scheduled and not played, so it can only lower a fee. And
 * only the month containing "now" is ever opened, so a month that started
 * inside a spell is never opened, never charged (no catch-up).
 *
 * Every writer here is idempotent: it writes only when the latest marker of
 * its pair says otherwise.
 */
import { db } from "./db";
import {
  BILLED_EVENT_TYPE,
  BILLING_OFF_EVENT_TYPE,
  BILLING_ON_EVENT_TYPE,
  SUSPENDED_EVENT_TYPE,
  UNBILLED_EVENT_TYPE,
  UNSUSPENDED_EVENT_TYPE,
} from "./club-billing-cycle-rules";

async function latest(orgId: string | null, types: string[]) {
  return db.billingEvent.findFirst({
    where: { orgId, type: { in: types } },
    orderBy: { receivedAt: "desc" },
    select: { type: true },
  });
}

async function write(orgId: string | null, type: string, now: Date): Promise<boolean> {
  try {
    await db.billingEvent.create({
      data: { id: `${type.replace(".", "_")}_${orgId ?? "all"}_${now.getTime()}`, type, orgId, receivedAt: now, processedAt: now },
    });
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return false; // the same moment, already written
    throw err;
  }
}

/** The platform owner suspended the club: its suspension spell starts now
 *  (unless one is already open). */
export async function recordSuspended(orgId: string, now: Date = new Date()): Promise<boolean> {
  const last = await latest(orgId, [SUSPENDED_EVENT_TYPE, UNSUSPENDED_EVENT_TYPE]);
  if (last?.type === SUSPENDED_EVENT_TYPE) return false;
  return write(orgId, SUSPENDED_EVENT_TYPE, now);
}

/**
 * The club is billable now: close every not-billable spell of its own that
 * is still open (a suspension lifted by hand; a Free spell whose closing
 * marker was missed). Called by the month opener before it opens anything,
 * and only when the club IS billable, so games before this moment are
 * never charged. Returns how many spells it closed.
 */
export async function closeNotBillableSpells(orgId: string, now: Date = new Date()): Promise<number> {
  let closed = 0;
  for (const [start, end] of [
    [SUSPENDED_EVENT_TYPE, UNSUSPENDED_EVENT_TYPE],
    [UNBILLED_EVENT_TYPE, BILLED_EVENT_TYPE],
  ] as const) {
    const last = await latest(orgId, [start, end]);
    if (last?.type === start && (await write(orgId, end, now))) closed++;
  }
  return closed;
}

/** The hourly run, every run: BILLING_ENABLED as it sees it, recorded once
 *  per change (GLOBAL). No marker yet counts as "on". */
export async function recordBillingFlagState(on: boolean, now: Date = new Date()): Promise<boolean> {
  const last = await latest(null, [BILLING_OFF_EVENT_TYPE, BILLING_ON_EVENT_TYPE]);
  const isOff = last?.type === BILLING_OFF_EVENT_TYPE;
  if (on && isOff) return write(null, BILLING_ON_EVENT_TYPE, now);
  if (!on && !isOff) return write(null, BILLING_OFF_EVENT_TYPE, now);
  return false;
}
