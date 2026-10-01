"use server";

/**
 * The billing page's card buttons (club fee billing, slice B3).
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 4.5 and 5.2.
 *
 *   Add a card              startClubCheckout  the billing contact
 *   Use my card instead,    startCardReplace   the billing contact (setup
 *   Update card and pay                        mode; an unpaid invoice is
 *                                              retried on the new card)
 *   Change card or cancel   openClubPortal     the contact who holds the card
 *   Remove my card          removeMyCard       an old card holder
 *
 * EVERY action re-checks the guard itself (`requireClubBillingAccess`,
 * with BILLING_ENABLED as the web reads it), never trusting that the page
 * was shown, and the billing module then refuses any role it does not
 * serve (a "viewer" changes nothing). With the flag off the guard throws,
 * so nothing here is reachable.
 *
 * Stripe's pages are reached by redirect; a refusal or an error lands back
 * on /billing/<orgId> with a notice. "use server" modules may export async
 * functions only.
 */
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { billingUiEnabledForRequest } from "@/lib/billing-flag";
import { requireClubBillingAccess } from "@/lib/club-billing";
import {
  openClubPortal,
  removeMyCard,
  startCardReplace,
  startClubCheckout,
  type BillingActionRefusal,
} from "@/lib/club-billing-stripe";
import type { BillingAccessRole } from "@/lib/club-billing-rules";

type Outcome = { ok: true; url?: string } | { ok: false; reason: BillingActionRefusal };

function noticeFor(reason: BillingActionRefusal): string {
  if (reason === "not-set-up") return "not-set-up";
  if (reason === "already-subscribed") return "already";
  return "failed";
}

/** Signed in, the guard again, then the action; redirect with the result. */
async function run(
  orgId: string,
  label: string,
  act: (a: { orgId: string; userId: string; role: BillingAccessRole }) => Promise<Outcome>,
  okNotice: string | null,
): Promise<never> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/login");

  let role: BillingAccessRole;
  try {
    role = (await requireClubBillingAccess(userId, orgId, { flagOn: await billingUiEnabledForRequest() })).role;
  } catch {
    redirect("/");
  }

  const back = `/billing/${encodeURIComponent(orgId)}`;
  let target: string;
  try {
    const r = await act({ orgId, userId, role });
    if (r.ok) target = r.url ?? (okNotice ? `${back}?notice=${okNotice}` : back);
    else {
      console.warn(`[billing-action] ${label} for ${orgId} by ${userId} (${role}) refused: ${r.reason}`);
      target = `${back}?notice=${noticeFor(r.reason)}`;
    }
  } catch (err) {
    console.error(`[billing-action] ${label} for ${orgId} by ${userId} failed:`, err);
    target = `${back}?notice=failed`;
  }
  // Outside the try: redirect() works by throwing.
  redirect(target);
}

/** Add a card: Stripe Checkout, subscription mode. */
export async function addCardAction(orgId: string): Promise<void> {
  await run(orgId, "Add a card", startClubCheckout, null);
}

/** Use my card instead: Stripe Checkout, setup mode. */
export async function useMyCardAction(orgId: string): Promise<void> {
  await run(orgId, "Use my card instead", startCardReplace, null);
}

/** Change card or cancel (and Update card): the Customer Portal. */
export async function openPortalAction(orgId: string): Promise<void> {
  await run(orgId, "Customer Portal", openClubPortal, null);
}

/** Remove my card: the old card holder stops paying. */
export async function removeMyCardAction(orgId: string): Promise<void> {
  await run(orgId, "Remove my card", removeMyCard, "removed");
}
