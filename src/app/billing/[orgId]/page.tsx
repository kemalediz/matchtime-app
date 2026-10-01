import { auth } from "@/lib/auth";
import { notFound, redirect } from "next/navigation";
import { CreditCard } from "lucide-react";
import { loadBillingAccess, loadClubFeeTip } from "@/lib/club-billing";
import { billingPageView } from "@/lib/club-billing-view";
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
 * SLICE B2: the card buttons are shown disabled. The Stripe calls behind
 * them (and the server actions, each re-checking the guard) are slice B3.
 * English or Turkish by the club's language.
 */
export default async function BillingPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  const access = await loadBillingAccess(userId, orgId, { flagOn: await billingUiEnabledForRequest() });
  if (!access) notFound();
  const { role, snapshot } = access;
  const tip = role === "exempt-owner" || role === "card-holder" ? null : await loadClubFeeTip(orgId);
  const v = billingPageView(snapshot.language, snapshot, role, userId, tip);

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8" data-testid="billing-page" data-role={role}>
      <div className="mx-auto w-full max-w-md">
        <div className="text-center mb-5">
          <p className="text-xs uppercase tracking-wider text-slate-400">{v.club}</p>
          <h1 className="text-xl font-bold text-slate-900 mt-1">{v.title}</h1>
        </div>

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
            <div className="pt-1 space-y-2">
              <div className="flex flex-wrap gap-2">
                {v.buttons.map((b) => (
                  <button
                    key={b.key}
                    type="button"
                    disabled
                    aria-disabled="true"
                    data-testid={`billing-btn-${b.key}`}
                    className="inline-flex items-center gap-2 h-11 px-4 rounded-lg bg-blue-600 text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <CreditCard className="h-4 w-4" />
                    {b.label}
                  </button>
                ))}
              </div>
              {v.soon && <p className="text-xs text-slate-400">{v.soon}</p>}
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
