"use server";

/**
 * The billing page's card buttons (club fee billing, slice B3; slice P2
 * for games played: setup mode only, no Customer Portal, our own Stop
 * paying). Plan: MDs/club-fee-billing-plan-2026-10-01.md, 4.2, 4.5, 5.3.
 *
 *   Add a card              startClubCheckout  the billing contact (setup
 *                                              mode, nothing charged)
 *   Use my card instead,    startCardReplace   the billing contact (setup
 *   Change card,                               mode; anything unpaid is
 *   Update card and pay                        paid on the new card)
 *   Stop paying             stopPaying         the billing contact
 *   Keep paying             keepPaying         the billing contact
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
  keepPaying,
  removeMyCard,
  startCardReplace,
  startClubCheckout,
  stopPaying,
  type BillingActionRefusal,
} from "@/lib/club-billing-stripe";
import type { BillingAccessRole } from "@/lib/club-billing-rules";

type Outcome = { ok: true; url?: string } | { ok: false; reason: BillingActionRefusal };

function noticeFor(reason: BillingActionRefusal): string {
  if (reason === "not-set-up") return "not-set-up";
  if (reason === "already-card") return "already";
  if (reason === "removed-from-group") return "re-add";
  if (reason === "past-due") return "past-due";
  return "failed";
}

/** Signed in, the guard again, then the action; redirect with the result. */
async function run(
  orgId: string,
  label: string,
  act: (a: { orgId: string; userId: string; role: BillingAccessRole }) => Promise<Outcome>,
  okNotice: string | null | (() => string),
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
    const notice = typeof okNotice === "function" ? okNotice() : okNotice;
    if (r.ok) target = r.url ?? (notice ? `${back}?notice=${notice}` : back);
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

/** Add a card: Stripe Checkout, setup mode (nothing charged). */
export async function addCardAction(orgId: string): Promise<void> {
  await run(orgId, "Add a card", startClubCheckout, null);
}

/** Use my card instead, Change card, Update card and pay: Stripe
 *  Checkout, setup mode. */
export async function useMyCardAction(orgId: string): Promise<void> {
  await run(orgId, "Use my card instead", startCardReplace, null);
}

/** Stop paying: billing ends with the current month (inside the free
 *  month the card is removed at once). */
export async function stopPayingAction(orgId: string): Promise<void> {
  const freeMonth = { value: false };
  await run(
    orgId,
    "Stop paying",
    async (a) => {
      const r = await stopPaying(a);
      if (r.ok && r.freeMonth) freeMonth.value = true;
      return r;
    },
    () => (freeMonth.value ? "stopped-free" : "stopped"),
  );
}

/** Keep paying: undoes Stop paying, or starts billing again after it. */
export async function keepPayingAction(orgId: string): Promise<void> {
  await run(orgId, "Keep paying", keepPaying, "kept");
}

/** Remove my card: the old card holder stops paying. */
export async function removeMyCardAction(orgId: string): Promise<void> {
  await run(orgId, "Remove my card", removeMyCard, "removed");
}
