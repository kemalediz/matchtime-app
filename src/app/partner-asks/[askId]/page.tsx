import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { t } from "@/lib/i18n/t";
import { loadPartnerAskForApprover } from "@/lib/partner-ask";
import { PartnerAskAnswer } from "./answer";

export const dynamic = "force-dynamic";

/**
 * The approve page for a partner club's ask (cross-club ask, slice S2,
 * 2026-10-16; plan 3.3 step 4, D3). A partner organiser's DM carries a
 * signed-in link here; in an admin group the plain URL asks for sign-in.
 * Only an OWNER or ADMIN of the club that was asked sees the ask; the
 * answer is checked again by the server action. In that club's language.
 */
export default async function PartnerAskPage({ params }: { params: Promise<{ askId: string }> }) {
  const { askId } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const view = await loadPartnerAskForApprover(askId, session.user.id);
  if (!view) {
    return (
      <div className="max-w-md mx-auto px-4 py-10" data-testid="partner-ask-page">
        <p className="text-sm text-slate-600">{t("en").xask_page_not_allowed}</p>
      </div>
    );
  }
  const s = t(view.language);
  return (
    <div className="max-w-md mx-auto px-4 py-10" data-testid="partner-ask-page">
      <h1 className="text-xl font-bold text-slate-900">{s.xask_page_title}</h1>
      <p className="mt-3 text-sm text-slate-700" data-testid="partner-ask-summary">
        {s.xask_page_summary(view.facts)}
      </p>
      {view.own && <p className="mt-2 text-sm text-slate-700">{s.xask_page_own(view.own)}</p>}
      <p className="mt-2 text-xs text-slate-500">{s.xask_page_how}</p>
      <div className="mt-6">
        {view.status === "awaiting-approval" ? (
          <PartnerAskAnswer askId={askId} language={view.language} />
        ) : (
          <p className="text-sm text-slate-600" data-testid="partner-ask-closed">
            {view.status === "posted" || view.status === "filled" ? s.xask_page_posted : view.status === "declined" ? s.xask_page_declined : s.xask_page_closed}
          </p>
        )}
      </div>
    </div>
  );
}
