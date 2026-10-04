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
 * After a plan is saved, `onPlanChanged` (slice P2, games played): on Free
 * the open month is waived and every unpaid club fee invoice voided; a
 * price change needs nothing in Stripe (each month close charges the lower
 * of the price when the month opened and the price at the close). A club
 * billed again after Free with its free month used up gets one DM to its
 * billing contact asking for a card, unless a card is on file: then that
 * card is billed and nobody is asked.
 *
 * "use server" modules may export async functions only.
 */
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { isSuperadmin } from "@/lib/org";
import { setClubPlan, startTrial } from "@/lib/club-billing";
import { flushPendingBillingNotices, onPlanChanged } from "@/lib/club-billing-stripe";
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
  const r = await setClubPlan(orgId, { plan: choice.plan, pricePence: choice.pricePence });
  revalidatePath("/admin/clubs");
  if (!r.ok) {
    return {
      ok: false,
      message: r.reason === "not-found" ? "That club no longer exists." : "Only clubs that joined themselves have a plan.",
    };
  }
  const label =
    r.plan === "free" ? "Free" : r.plan === "custom" ? `Custom, up to ${moneyLabel(r.pricePence ?? 0)} a month` : "Standard, up to £9.99 a month";
  let message = `Plan saved: ${label}.${r.plan === "free" ? " The club is not billed." : ""}${r.resumed ? " MatchTime is back on in its group." : ""}`;

  // The database is committed; now the months and Stripe (Free only).
  try {
    const changed = await onPlanChanged(orgId);
    if (changed.action === "forgiven") {
      if (changed.waived > 0) message += " This month is not charged.";
      if (changed.voided > 0) message += ` ${changed.voided} unpaid invoice(s) cancelled.`;
      if (changed.alreadyPaid > 0) message += ` ${changed.alreadyPaid} invoice(s) had already been paid: refund by hand in Stripe if they should be.`;
      if (changed.failed > 0) {
        return { ok: false, message: `${message} ${changed.failed} unpaid invoice(s) could not be cancelled in Stripe yet; the hourly billing run keeps trying. Press Save plan again to retry now.` };
      }
    }
  } catch (err) {
    console.error(`[club-billing-admin] ${orgId}: plan change follow-up failed:`, err);
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
  } else if (r.billedAgain === "subscribed") {
    message += " The card on file is billed again; nobody is asked for a card.";
  } else if (r.billedAgain === "paused") {
    message += " The payer had stopped paying, so it stays paused until they press Keep paying.";
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
