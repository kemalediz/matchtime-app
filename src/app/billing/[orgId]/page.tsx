import { auth } from "@/lib/auth";
import { notFound, redirect } from "next/navigation";
import { CreditCard } from "lucide-react";
import { loadBillingAccess, loadClubFeeTip } from "@/lib/club-billing";
import { billingNoticeText, billingPageView, type BillingButton, type BillingPageNotice } from "@/lib/club-billing-view";
import {
  addCardAction,
  keepPayingAction,
  removeMyCardAction,
  stopPayingAction,
  useMyCardAction,
} from "@/app/actions/club-billing";
import { billingUiEnabledForRequest } from "@/lib/billing-flag";
import { WaText } from "@/components/billing/wa-text";
import { loadMonthsSummary } from "@/lib/club-billing-month-summary";
import { SectionInfo } from "@/components/info/section-info";
import { infoCopy } from "@/lib/info-copy";

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
 * SLICE B3, P2: each card button is a form posting to its server action
 * (src/app/actions/club-billing.ts), which re-checks the guard itself and
 * redirects to Stripe Checkout (setup mode: nothing is charged when a card
 * is saved) or back here with a notice. English or Turkish by the club's
 * language.
 *
 * SLICE P4 (games played): the "this month" box (games played so far of
 * scheduled, still to come, the charge so far and the most it can be,
 * the charge date), then the past months (amount and state, the games
 * behind "See games", and for the payer their own card's receipts, through
 * /billing/[orgId]/receipt/[monthId]). Nobody's name is on a game line.
 */
const ACTION: Record<BillingButton, (orgId: string) => Promise<void>> = {
  "add-card": addCardAction,
  "use-mine": useMyCardAction,
  // Change card is setup mode too (slice P2: no Customer Portal).
  "change-card": useMyCardAction,
  // "Update card and pay": setup mode, then what is unpaid is paid on it.
  "update-card": useMyCardAction,
  "remove-mine": removeMyCardAction,
  "stop-paying": stopPayingAction,
  "keep-paying": keepPayingAction,
};

const NOTICES: readonly BillingPageNotice[] = [
  "done",
  "replaced",
  "removed",
  "not-set-up",
  "already",
  "re-add",
  "failed",
  "stopped",
  "stopped-free",
  "kept",
  "past-due",
];

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
  const sp = await searchParams;
  const notice = noticeFrom(sp);
  // Stop paying asks first (test mode fix, 2026-10-05): the button links
  // here with ?confirm=stop-paying, and only "Yes, stop paying" posts.
  const confirmingStop = sp.confirm === "stop-paying";
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
  const now = new Date();
  const months =
    role === "exempt-owner" || role === "card-holder"
      ? null
      : await loadMonthsSummary(orgId, {
          now,
          plan: snapshot.plan,
          pricePence: snapshot.pricePence,
          role,
          viewerUserId: userId,
          cardHolderUserId: snapshot.billing?.cardHolderUserId ?? null,
        });
  const v = billingPageView(snapshot.language, snapshot, role, userId, tip, { now, months, orgId });
  const billingPath = `/billing/${encodeURIComponent(orgId)}`;

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8" data-testid="billing-page" data-role={role}>
      <div className="mx-auto w-full max-w-md">
        <div className="text-center mb-5">
          <p className="text-xs uppercase tracking-wider text-slate-400">{v.club}</p>
          <h1 className="text-xl font-bold text-slate-900 mt-1 inline-flex items-center gap-1">
            {v.title}
            {/* F1: how the fee works. Not for an exempt club, which has none. */}
            {!v.exempt && <SectionInfo k="bill_page" lang={snapshot.language} />}
          </h1>
        </div>

        {notice && role !== "exempt-owner" && (
          <p
            data-testid="billing-notice"
            data-notice={notice}
            role="status"
            className={`mb-4 rounded-lg border p-3 text-sm ${
              notice === "failed" || notice === "not-set-up" || notice === "past-due" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-blue-100 bg-blue-50 text-blue-900"
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
          {v.monthBox && (
            <p data-testid="billing-month-box" className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-blue-900">
              {v.monthBox}
            </p>
          )}
          {v.holderNote && <p data-testid="billing-holder-note">{v.holderNote}</p>}
          {v.who && (
            <p data-testid="billing-who" className="text-slate-500">
              {v.who}
            </p>
          )}
          {v.buttons.length > 0 && (
            <div className="pt-1 flex flex-wrap gap-2">
              {v.buttons.map((b) =>
                b.key === "stop-paying" ? (
                  // A link, not a post: it opens the confirmation below.
                  confirmingStop && v.stopConfirm ? null : (
                    <a
                      key={b.key}
                      href={`${billingPath}?confirm=stop-paying`}
                      data-testid={`billing-btn-${b.key}`}
                      className="inline-flex items-center gap-2 h-11 px-4 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700"
                    >
                      <CreditCard className="h-4 w-4" />
                      {b.label}
                    </a>
                  )
                ) : (
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
                ),
              )}
            </div>
          )}
          {/* F1: who looks after the card, for every role but an exempt club. */}
          {!v.exempt && (
            <p className="flex items-center gap-1 text-xs text-slate-500">
              {infoCopy(snapshot.language, "bill_card").title}
              <SectionInfo k="bill_card" lang={snapshot.language} />
            </p>
          )}
          {confirmingStop && v.stopConfirm && (
            <div data-testid="billing-stop-confirm" role="alertdialog" aria-labelledby="billing-stop-confirm-title" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900 space-y-2">
              <p id="billing-stop-confirm-title" className="font-semibold">
                {v.stopConfirm.title}
              </p>
              <p>{v.stopConfirm.text}</p>
              <div className="flex flex-wrap gap-2 pt-1">
                <form action={ACTION["stop-paying"].bind(null, orgId)}>
                  <button
                    type="submit"
                    data-testid="billing-btn-stop-paying-confirm"
                    className="inline-flex items-center h-11 px-4 rounded-lg bg-amber-600 text-white font-medium hover:bg-amber-700"
                  >
                    {v.stopConfirm.yes}
                  </button>
                </form>
                <a
                  href={billingPath}
                  data-testid="billing-stop-cancel"
                  className="inline-flex items-center h-11 px-4 rounded-lg border border-slate-300 bg-white text-slate-700 font-medium hover:bg-slate-50"
                >
                  {v.stopConfirm.no}
                </a>
              </div>
            </div>
          )}
        </section>

        {v.past.length > 0 && (
          <section data-testid="billing-past" className="mt-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm text-sm text-slate-700">
            <h2 className="font-semibold text-slate-900 mb-2 flex items-center gap-1">
              {v.pastTitle}
              <SectionInfo k="bill_past" lang={snapshot.language} />
            </h2>
            <ul className="space-y-2">
              {v.past.map((m) => (
                <li key={m.id} data-testid="billing-past-month" data-month={m.id}>
                  <p>
                    {m.line}
                    {m.receiptHref && (
                      <>
                        {" "}
                        <a data-testid="billing-receipt" href={m.receiptHref} className="font-medium text-blue-700 hover:underline">
                          {v.receiptLabel}
                        </a>
                      </>
                    )}
                  </p>
                  {m.games.length > 0 && (
                    <details className="mt-1">
                      <summary data-testid="billing-see-games" className="cursor-pointer text-blue-700">
                        {v.seeGamesLabel}
                      </summary>
                      <ul className="mt-1 ml-4 list-disc text-slate-600">
                        {m.games.map((g, i) => (
                          <li key={i}>{g}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {v.tip && (
          <section data-testid="billing-tip" className="mt-4 rounded-xl border border-emerald-100 bg-emerald-50 p-5 text-sm text-emerald-900">
            <WaText text={v.tip} />
          </section>
        )}
      </div>
    </div>
  );
}
