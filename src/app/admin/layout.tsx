import Link from "next/link";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getUserOrg, isOrgAdmin } from "@/lib/org";
import { AdminSubnav } from "@/components/layout/admin-subnav";
import { loadBillingBanner } from "@/lib/club-billing";
import { billingUiEnabledForRequest } from "@/lib/billing-flag";
import { t } from "@/lib/i18n/t";
import { OrgLangProvider } from "@/components/info/org-lang";
import { normaliseSquadMode } from "@/lib/squad-month-rules";
import { CONNECT_FOCUS_HOME, PATHNAME_HEADER, connectFocusAdminView } from "@/lib/connect-focus";
import { connectFocusFor } from "@/lib/connect-focus-server";
import { ConnectFocusGate } from "@/components/club-connect/connect-focus-gate";
import { guestPlayersTabShown } from "@/lib/pool/guest-report-loader";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const membership = await getUserOrg(session.user.id);
  if (!membership) redirect("/");

  const admin = await isOrgAdmin(session.user.id, membership.orgId);
  if (!admin) redirect("/");

  // "Finish connecting" mode (src/lib/connect-focus.ts): the owner of a
  // club that is a draft or pending gets the connect panel and nothing
  // else. No tabs, no "Admin" heading. Any admin page but the panel and
  // the two edit pages goes back to the panel: here on a full load (the
  // middleware hands the pathname over), and in the gate, on the client,
  // when the organiser moves between pages without one.
  if (await connectFocusFor(session.user.id, membership)) {
    if (connectFocusAdminView((await headers()).get(PATHNAME_HEADER)) === "redirect") redirect(CONNECT_FOCUS_HOME);
    const s = t(membership.org.language);
    return (
      <ConnectFocusGate
        lang={membership.org.language}
        labels={{ back: s.cf_back, club: s.cf_edit_tab_club, game: s.cf_edit_tab_game }}
      >
        <OrgLangProvider lang={membership.org.language}>{children}</OrgLangProvider>
      </ConnectFocusGate>
    );
  }

  // Club fee billing (slice B2, plan 8.2): one line for the club's OWNER
  // and ADMINs in grace, past due or paused. Never in trial, never for an
  // exempt club, never with BILLING_ENABLED off.
  const banner = await loadBillingBanner(membership.orgId, { flagOn: await billingUiEnabledForRequest() });
  // The Guest players tab (pool slice L5b), only where it has something to show.
  const guestsTab = await guestPlayersTabShown(membership.orgId).catch(() => false);

  return (
    <div className="p-6 sm:p-8 max-w-6xl mx-auto">
      {banner && (
        <div
          role="status"
          data-testid="billing-banner"
          className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900"
        >
          <span>{banner}</span>
          <Link href="/admin/settings#billing" className="font-medium underline">
            {t(membership.org.language).billing_banner_link}
          </Link>
        </div>
      )}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Admin</h1>
        <p className="text-sm text-slate-500 mt-1">{membership.org.name}</p>
      </div>
      {/* The Months tab exists only for a club on a monthly squad (slice 2). */}
      <AdminSubnav
        monthsLabel={
          normaliseSquadMode(membership.org.squadMode) === "monthly" ? t(membership.org.language).mth_nav : undefined
        }
        guestsLabel={guestsTab ? t(membership.org.language).gst_title : undefined}
      />
      <div className="mt-6">
        {/* The club's language for the client pages' ⓘ popups (F1). */}
        <OrgLangProvider lang={membership.org.language}>{children}</OrgLangProvider>
      </div>
    </div>
  );
}
