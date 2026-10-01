"use server";

/**
 * The platform owner's club fee controls on /admin/clubs (club fee
 * billing, slice B2). Plan: MDs/club-fee-billing-plan-2026-10-01.md,
 * section 8.3, decisions 2, 9 and 13.
 *
 * OWNER ONLY: every action checks `User.isSuperadmin` itself, whatever
 * the page showed. Each is a thin wrapper round the billing module's one
 * writer path (`setClubPlan`, `startTrial` in src/lib/club-billing.ts),
 * which refuses any club that predates self-join (Sutton FC).
 *
 * Slice B3: after a plan is saved, `syncPlanToStripe` swaps a live
 * subscription's price (no proration, from the next month) or cancels it
 * on Free; a club billed again after Free with its free month used up
 * gets one DM to its billing contact asking for a card.
 *
 * "use server" modules may export async functions only.
 */
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { isSuperadmin } from "@/lib/org";
import { setClubPlan, startTrial } from "@/lib/club-billing";
import { flushPendingBillingNotices, syncPlanToStripe } from "@/lib/club-billing-stripe";
import { billingStripeConfig } from "@/lib/stripe-billing";
import { parsePlanChoice } from "@/lib/club-billing-rules";
import { moneyLabel } from "@/lib/club-billing-view";
import { dayLabel } from "@/lib/i18n/dates";

export interface BillingAdminResult {
  ok: boolean;
  message: string;
}

async function requireOwner(): Promise<string> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId || !(await isSuperadmin(userId))) throw new Error("Not allowed");
  return userId;
}

/** Standard, Free or Custom (price in pounds as typed, GBP 1.00 to GBP 9.99). */
export async function setClubPlanAction(orgId: string, plan: string, price?: string | null): Promise<BillingAdminResult> {
  await requireOwner();
  const choice = parsePlanChoice({ plan, price });
  if (!choice.ok) {
    return {
      ok: false,
      message: choice.reason === "unknown-plan" ? "That is not a plan." : "A custom price must be between £1.00 and £9.99.",
    };
  }
  if (choice.plan === "custom" && !billingStripeConfig().productId) {
    // A Custom price is made in Stripe under the club product; without it a
    // card could never be taken at that price. Refuse before writing.
    return { ok: false, message: "Custom prices need STRIPE_CLUB_PRODUCT_ID set (the MatchTime club product in Stripe). Nothing was saved." };
  }
  const r = await setClubPlan(orgId, { plan: choice.plan, pricePence: choice.pricePence });
  revalidatePath("/admin/clubs");
  if (!r.ok) {
    return {
      ok: false,
      message: r.reason === "not-found" ? "That club no longer exists." : "Only clubs that joined themselves have a plan.",
    };
  }
  const label = r.plan === "free" ? "Free" : r.plan === "custom" ? `Custom ${moneyLabel(r.pricePence ?? 0)} a month` : "Standard £9.99 a month";
  let message = `Plan saved: ${label}.${r.plan === "free" ? " The club is not billed." : ""}${r.resumed ? " MatchTime is back on in its group." : ""}`;

  // The database is committed; now Stripe (a live subscription only).
  try {
    const synced = await syncPlanToStripe(orgId);
    if (synced.action === "cancelled") message += " Its card subscription was cancelled.";
    else if (synced.action === "price-changed") message += " The card is charged the new price from the next payment.";
  } catch (err) {
    console.error(`[club-billing-admin] ${orgId}: Stripe plan sync failed:`, err);
    return { ok: false, message: `${message} Stripe could not be updated (${(err as Error).message}). Press Save plan again to retry.` };
  }

  // Any DM the change left pending ("plan-billed"), including one an
  // earlier save failed to send. A failure here is logged; the next save
  // (or webhook) sends it.
  try {
    await flushPendingBillingNotices(orgId);
  } catch (err) {
    console.error(`[club-billing-admin] ${orgId}: pending billing DM not sent yet:`, err);
  }
  if (r.billedAgain === "grace") {
    message += " The free month was already used, so the club has 7 days to add a card.";
  } else if (r.billedAgain === "trial") {
    message += " The club is back in its free month.";
  }
  return { ok: true, message };
}

const START_REFUSED: Record<string, string> = {
  "not-found": "That club no longer exists.",
  "not-self-join": "Only clubs that joined themselves can have a free month.",
  "flag-off": "Billing is switched off (BILLING_ENABLED), so no free month can start.",
  "not-exempt": "This club is already being billed.",
  "had-free-month": "This club has had its free month already.",
  "plan-free": "This club is on the Free plan. Choose Standard or Custom first.",
  raced: "Something changed at the same moment. Refresh and try again.",
};

/** "Start free month" for a self-join club approved before billing. */
export async function startFreeMonthAction(orgId: string): Promise<BillingAdminResult> {
  await requireOwner();
  const r = await startTrial(orgId);
  revalidatePath("/admin/clubs");
  if (!r.ok) return { ok: false, message: START_REFUSED[r.reason] ?? "The free month could not start." };
  return { ok: true, message: `Free month started. It ends on ${dayLabel("en", r.trialEndsAt)}.` };
}
