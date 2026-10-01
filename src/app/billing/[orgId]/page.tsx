import { auth } from "@/lib/auth";
import { notFound, redirect } from "next/navigation";
import { CreditCard } from "lucide-react";
import { loadBillingAccess, loadClubFeeTip } from "@/lib/club-billing";
import { billingNoticeText, billingPageView, type BillingButton, type BillingPageNotice } from "@/lib/club-billing-view";
import { addCardAction, openPortalAction, removeMyCardAction, useMyCardAction } from "@/app/actions/club-billing";
import { isClubPortalAvailable } from "@/lib/club-billing-stripe";
import { billingUiEnabledForRequest } from "@/lib/billing-flag";
import { WaText } from "@/components/billing/wa-text";

export const dynamic = "force-dynamic";

/**
 * /billing/[orgId]: one club's club fee (club fee billing, slice B2).
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 4.5 and 8.1.
 *
 * OUTSIDE /admin on purpose, like /collect/[matchId]: the person who pays
 * is the money collector, who is often a PLAYER, and /admin redirects
 * every non-admin. A player collector reaches this page and the pages any
 * player can, never the admin pages.
 *
 * Who sees what (`requireClubBillingAccess` / `billingAccessRole`):
 *   the billing contact (collector, else owner)  the state, the tip, the
 *                                                card buttons
 *   an old card holder                           Remove my card
 *   an OWNER or ADMIN, or the superadmin         read only
 *   the owner of an exempt club (Sutton FC)      one "exempt" line
 *   anybody else, an unknown club, or the flag   404
 *   off
 *
 * SLICE B3: each card button is a form posting to its server action
 * (src/app/actions/club-billing.ts), which re-checks the guard itself and
 * redirects to Stripe (Checkout or the Customer Portal) or back here with
 * a notice. English or Turkish by the club's language.
 */
const ACTION: Record<BillingButton, (orgId: string) => Promise<void>> = {
  "add-card": addCardAction,
  "use-mine": useMyCardAction,
  "change-card": openPortalAction,
  // "Update card and pay": setup mode, then the open invoice is retried.
  "update-card": useMyCardAction,
  "remove-mine": removeMyCardAction,
};

const NOTICES: readonly BillingPageNotice[] = ["done", "replaced", "removed", "not-set-up", "already", "failed"];

/** The notice to show after a card action, from the URL Stripe or the
 *  action sent the viewer back to. */
function noticeFrom(sp: Record<string, string | string[] | undefined>): BillingPageNotice | null {
  if (sp.done === "1") return "done";
  if (sp.replaced === "1") return "replaced";
  const n = typeof sp.notice === "string" ? sp.notice : null;
  return n && (NOTICES as readonly string[]).includes(n) ? (n as BillingPageNotice) : null;
}

export default async function BillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId } = await params;
  const notice = noticeFrom(await searchParams);
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  const flagOn = await billingUiEnabledForRequest();
  const access = await loadBillingAccess(userId, orgId, { flagOn });
  if (!access) {
    // An old card holder who is a player has no access once their card is
    // removed: they still see that it worked (no club data on this view).
    if (flagOn && notice === "removed") {
      return (
        <div className="min-h-screen bg-slate-50 px-4 py-8" data-testid="billing-page" data-role="none">
          <p data-testid="billing-notice" data-notice="removed" role="status" className="mx-auto max-w-md rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-900">
            {billingNoticeText(null, "removed")}
          </p>
        </div>
      );
    }
    notFound();
  }
  const { role, snapshot } = access;
  const tip = role === "exempt-owner" || role === "card-holder" ? null : await loadClubFeeTip(orgId);
  const v = billingPageView(snapshot.language, snapshot, role, userId, tip, { portalAvailable: isClubPortalAvailable() });

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8" data-testid="billing-page" data-role={role}>
      <div className="mx-auto w-full max-w-md">
        <div className="text-center mb-5">
          <p className="text-xs uppercase tracking-wider text-slate-400">{v.club}</p>
          <h1 className="text-xl font-bold text-slate-900 mt-1">{v.title}</h1>
        </div>

        {notice && role !== "exempt-owner" && (
          <p
            data-testid="billing-notice"
            data-notice={notice}
            role="status"
            className={`mb-4 rounded-lg border p-3 text-sm ${
              notice === "failed" || notice === "not-set-up" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-blue-100 bg-blue-50 text-blue-900"
            }`}
          >
            {billingNoticeText(snapshot.language, notice)}
          </p>
        )}

        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-3 text-sm text-slate-700">
          {v.exempt && <p data-testid="billing-exempt">{v.exempt}</p>}
          {v.lines.length > 0 && (
            <div data-testid="billing-state" className="space-y-1">
              {v.lines.map((l) => (
                <p key={l}>{l}</p>
              ))}
            </div>
          )}
          {v.holderNote && <p data-testid="billing-holder-note">{v.holderNote}</p>}
          {v.who && (
            <p data-testid="billing-who" className="text-slate-500">
              {v.who}
            </p>
          )}
          {v.buttons.length > 0 && (
            <div className="pt-1 flex flex-wrap gap-2">
              {v.buttons.map((b) => (
                <form key={b.key} action={ACTION[b.key].bind(null, orgId)}>
                  <button
                    type="submit"
                    data-testid={`billing-btn-${b.key}`}
                    className="inline-flex items-center gap-2 h-11 px-4 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700"
                  >
                    <CreditCard className="h-4 w-4" />
                    {b.label}
                  </button>
                </form>
              ))}
            </div>
          )}
        </section>

        {v.tip && (
          <section data-testid="billing-tip" className="mt-4 rounded-xl border border-emerald-100 bg-emerald-50 p-5 text-sm text-emerald-900">
            <WaText text={v.tip} />
          </section>
        )}
      </div>
    </div>
  );
}
