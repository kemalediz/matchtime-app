/**
 * CLUB FEE BILLING, slice B5: MatchTime removed from (and added back to) a
 * live club's WhatsApp group.
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, section 4.2 (the
 * "removed from the group" and "re-added" rows) and decision 6.
 *
 * REMOVED (`handleBillingRemoval`, from POST /api/whatsapp/bot-removed).
 * The Pi forwards a removal only when one of the removed participants is
 * MatchTime itself (whatsapp-bot/src/bot-added.ts,
 * `handleMonitoredGroupSelfRemoval`). Here:
 *   - no APPROVED club owns the group: "no-club", and the route carries on
 *     with today's self-join handling (a pending club goes back to draft,
 *     an unsolicited group is marked left), unchanged;
 *   - a club that predates self-join (`approvedAt` NULL: Sutton FC), an
 *     exempt club, or BILLING_ENABLED off: LOGGED ONLY. Nothing is
 *     written, nothing goes to Stripe;
 *   - a club being billed (trial, grace, subscribed, past due): paused,
 *     reason "removed", through the one writer (`setBillingState`). Slice
 *     P2: NO Stripe call to end anything (there is no subscription): the
 *     games played before the removal are charged when that month closes
 *     (the weeks after it count as scheduled, not played), and no later
 *     month opens while it is removed. Any open Add a card session is
 *     expired, so one started before the removal cannot save a card for a
 *     group MatchTime is not in. No DM to anyone;
 *   - already paused because removed (a repeated event): nothing changes;
 *     the session expiry runs again, so a failed earlier attempt is healed;
 *   - paused for another reason (no card, payment failed, cancelled):
 *     nothing changes.
 *
 * ADDED BACK (`handleBillingReAdd`, from POST /api/whatsapp/bot-added).
 * Only a club paused BECAUSE it was removed, with the flag on. Read from
 * OUR rows (slice P2), no Stripe call:
 *   - a card on file and no club fee invoice unpaid: serving again
 *     ("subscribed");
 *   - a club fee invoice unpaid: stays paused, now "payment-failed", so
 *     "Update card and pay" brings it back as usual;
 *   - no card, free month still running: back to "trial" with the same
 *     `trialEndsAt` (never reset);
 *   - no card, free month over: stays paused, now "no-card", so Add a card
 *     brings it back as usual.
 * This keeps one rule for the billing page: a club paused because removed
 * is never offered Add a card (it would pay for a group MatchTime is not
 * in, and the webhook deliberately does not resume a removed club); the
 * page asks for MatchTime to be added back first.
 *
 * This file never writes `billingStatus`: every move goes through
 * `setBillingState` (club-billing.ts). It writes nothing else.
 */
import { db } from "./db";
import { APPROVED_CLUB_WHERE } from "./club-approval-state";
import { setBillingState } from "./club-billing";
import { unpaidMonthIds } from "./club-billing-months";
import { BILLING_ALERT_KIND, recordOpsEvent } from "./ops-alerts";
import { getBillingStripe } from "./stripe-billing";

const LIVE_BILLED = new Set(["trial", "grace", "subscribed", "past_due"]);

/** What happened in Stripe after a removal (slice P2: only open Add a
 *  card sessions are expired; nothing is charged or ended). */
export type RemovalStripeOutcome = "sessions-expired" | "no-customer" | "not-set-up" | "failed";

export type BillingRemovalResult =
  /** No approved club owns the group: not a billing matter. */
  | { kind: "no-club" }
  /** Logged only: nothing written, nothing sent to Stripe. */
  | { kind: "logged"; orgId: string; why: "exempt-club" | "flag-off" | "not-billed" | "paused-other" }
  | { kind: "paused"; orgId: string; stripe: RemovalStripeOutcome }
  | { kind: "already-paused"; orgId: string; stripe: RemovalStripeOutcome };

/** The word the route answers the Pi with (`billing`). */
export function removalAnswer(r: Exclude<BillingRemovalResult, { kind: "no-club" }>): string {
  if (r.kind === "logged") return r.why === "exempt-club" ? "exempt" : r.why;
  return r.kind;
}

async function loadApprovedClubByGroup(groupId: string) {
  return db.organisation.findFirst({
    where: { whatsappGroupId: groupId, ...APPROVED_CLUB_WHERE },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      approvedAt: true,
      billingStatus: true,
      clubBilling: {
        select: {
          pausedReason: true,
          stripeCustomerId: true,
          stripePaymentMethodId: true,
        },
      },
    },
  });
}

/**
 * MatchTime itself was removed from `groupId`. See the file comment.
 * `flagOn` is BILLING_ENABLED as the route reads it. Throws only when the
 * database does (the Pi logs a failed post); a Stripe failure is recorded
 * on /admin/health instead, and the club stays paused.
 */
export async function handleBillingRemoval(
  groupId: string,
  opts: { flagOn: boolean; now?: Date },
): Promise<BillingRemovalResult> {
  const now = opts.now ?? new Date();
  const org = await loadApprovedClubByGroup(groupId);
  if (!org) return { kind: "no-club" };
  const tag = `[club-billing-removal] ${org.id} (${groupId})`;

  if (org.approvedAt === null) {
    console.log(`${tag}: MatchTime removed from the group of a club that is never billed; logged only`);
    return { kind: "logged", orgId: org.id, why: "exempt-club" };
  }
  if (!opts.flagOn) {
    console.log(`${tag}: MatchTime removed from the group (billing ${org.billingStatus}); BILLING_ENABLED off, logged only`);
    return { kind: "logged", orgId: org.id, why: "flag-off" };
  }
  if (org.billingStatus === "paused") {
    if (org.clubBilling?.pausedReason !== "removed") {
      console.log(`${tag}: MatchTime removed from the group of a club already paused (${org.clubBilling?.pausedReason ?? "?"}); nothing changes`);
      return { kind: "logged", orgId: org.id, why: "paused-other" };
    }
    const stripe = await expireCardSessions(org.id, now);
    console.log(`${tag}: removed again, already paused (removed); Stripe ${stripe}`);
    return { kind: "already-paused", orgId: org.id, stripe };
  }
  if (!LIVE_BILLED.has(org.billingStatus)) {
    console.log(`${tag}: MatchTime removed from the group of a club not being billed (${org.billingStatus}); logged only`);
    return { kind: "logged", orgId: org.id, why: "not-billed" };
  }

  const moved = await setBillingState(org.id, { type: "removed-from-group" }, now);
  if (!moved.ok) {
    // Raced with another writer: decide on what it left.
    const fresh = await loadApprovedClubByGroup(groupId);
    if (fresh?.billingStatus === "paused" && fresh.clubBilling?.pausedReason === "removed") {
      return { kind: "already-paused", orgId: org.id, stripe: await expireCardSessions(org.id, now) };
    }
    console.log(`${tag}: removal not applied (${moved.reason}); now ${fresh?.billingStatus ?? "gone"}`);
    return { kind: "logged", orgId: org.id, why: fresh?.billingStatus === "paused" ? "paused-other" : "not-billed" };
  }
  const stripe = await expireCardSessions(org.id, now);
  console.log(`${tag}: MatchTime removed from the group; ${moved.from} -> paused (removed), Stripe ${stripe}, no DM`);
  return { kind: "paused", orgId: org.id, stripe };
}

/**
 * Expire any open Add a card session on the club's Customer, so one
 * started before the removal cannot save a card afterwards. Nothing else
 * goes to Stripe (slice P2: no subscription to end; the open month closes
 * as usual). Never throws.
 */
async function expireCardSessions(orgId: string, now: Date): Promise<RemovalStripeOutcome> {
  const billing = await db.clubBilling.findUnique({ where: { orgId }, select: { stripeCustomerId: true } });
  if (!billing?.stripeCustomerId) return "no-customer";
  const stripe = getBillingStripe();
  if (!stripe) return "not-set-up";
  try {
    await stripe.expireOpenCheckoutSessions(billing.stripeCustomerId);
    return "sessions-expired";
  } catch (err) {
    console.error(`[club-billing-removal] ${orgId}: could not expire open card sessions:`, err);
    await recordOpsEvent({
      orgId,
      kind: BILLING_ALERT_KIND,
      severity: "warning",
      title: "Card sessions still open after MatchTime was removed",
      detail: `MatchTime was removed from this club's group and the club is paused, but open Add a card sessions on ${billing.stripeCustomerId} could not be expired (${err instanceof Error ? err.message : String(err)}). They expire on their own within a day; it is retried the next time the removal is reported.`,
      dedupeKey: `removed-sessions-${orgId}`,
      now,
    }).catch((e) => console.error(`[club-billing-removal] ${orgId}: could not record the alert:`, e));
    return "failed";
  }
}

export type BillingReAddResult =
  | { kind: "not-removed" }
  | { kind: "resumed"; orgId: string; to: "trial" | "subscribed" }
  | { kind: "still-paused"; orgId: string; reason: "no-card" | "payment-failed" }
  | { kind: "failed"; orgId: string };

/**
 * MatchTime was added back to `groupId`. See the file comment. Only ever
 * acts on a club paused because it was removed, with the flag on; Sutton
 * FC and every other club are "not-removed" with no write. Never throws.
 */
export async function handleBillingReAdd(
  groupId: string,
  opts: { flagOn: boolean; now?: Date },
): Promise<BillingReAddResult> {
  const now = opts.now ?? new Date();
  try {
    if (!opts.flagOn) return { kind: "not-removed" };
    const org = await loadApprovedClubByGroup(groupId);
    if (!org || org.approvedAt === null || org.billingStatus !== "paused" || org.clubBilling?.pausedReason !== "removed") {
      return { kind: "not-removed" };
    }
    const unpaid = (await unpaidMonthIds(org.id)).length > 0;
    const card: "ok" | "unpaid" | null = unpaid ? "unpaid" : org.clubBilling.stripePaymentMethodId ? "ok" : null;
    const moved = await setBillingState(org.id, { type: "re-added", card }, now);
    if (!moved.ok) {
      console.log(`[club-billing-removal] ${org.id}: re-added, no change (${moved.reason})`);
      return { kind: "not-removed" };
    }
    console.log(`[club-billing-removal] ${org.id} (${groupId}): MatchTime added back; paused -> ${moved.to} (card ${card ?? "none"})`);
    if (moved.to === "trial" || moved.to === "subscribed") return { kind: "resumed", orgId: org.id, to: moved.to };
    return { kind: "still-paused", orgId: org.id, reason: card === "unpaid" ? "payment-failed" : "no-card" };
  } catch (err) {
    console.error(`[club-billing-removal] ${groupId}: re-add billing step failed (club left as it was):`, err);
    return { kind: "failed", orgId: "" };
  }
}
