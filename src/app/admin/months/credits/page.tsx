import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getUserOrg, isOrgAdmin } from "@/lib/org";
import { SectionInfo } from "@/components/info/section-info";
import { t } from "@/lib/i18n/t";
import { dayLabel, monthYearLabel } from "@/lib/i18n/dates";
import { loadCreditLedger, type LedgerRow } from "@/lib/month-close";
import { normaliseSquadMode } from "@/lib/squad-month-rules";
import { AddCreditForm, RemoveCreditButton } from "./credit-forms";

/**
 * /admin/months/credits: the credits ledger of a club on a monthly squad
 * (slice 6 of MDs/monthly-squad-plan-2026-10-05.md, section 9.2).
 *
 * OWNER and ADMIN of a club whose `squadMode` is "monthly"; a WEEKLY club
 * (Sutton FC and every club before this) gets a 404.
 *
 * Every game of credit, by player: why it was earned, and where it stands
 * (available, used against a month, removed, refunded, taken back). An
 * organiser can add credit by hand and remove one that has not been used,
 * each with a reason. Nothing is ever deleted, and nothing here posts to
 * WhatsApp or moves money.
 */
export const dynamic = "force-dynamic";

export default async function CreditsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const membership = await getUserOrg(session.user.id);
  if (!membership) redirect("/create-org");
  if (!(await isOrgAdmin(session.user.id, membership.orgId))) redirect("/");
  if (normaliseSquadMode(membership.org.squadMode) !== "monthly") notFound();

  const lang = membership.org.language;
  const s = t(lang);
  const orgId = membership.orgId;
  const { players, clubPlayers } = await loadCreditLedger(orgId);

  const why = (r: LedgerRow): string => {
    const base = s.mcr_reason({ kind: r.reason, day: r.gameDate ? dayLabel(lang, new Date(r.gameDate)) : null });
    return r.note ? `${base}: ${r.note}` : base;
  };
  const where = (r: LedgerRow): string =>
    s.mcr_state({
      status: r.state,
      // The month it came off, or the organiser's reason for removing it.
      detail: r.state === "used" && r.appliedMonthStart ? monthYearLabel(lang, new Date(`${r.appliedMonthStart}T12:00:00.000Z`)) : r.voidNote && r.state === "removed" ? r.voidNote : null,
    });

  return (
    <div className="space-y-6" data-testid="credits-page">
      <div>
        <h2 className="flex items-center gap-1 text-lg font-semibold text-slate-800">
          {s.mcr_title}
          <SectionInfo k="mcr" lang={lang} />
        </h2>
        <p className="text-sm text-slate-500 mt-1">{s.mcr_lead}</p>
        <p className="mt-2 text-sm">
          <Link href="/admin/months" className="text-blue-700 hover:underline" data-testid="credits-back">
            {s.mcr_back}
          </Link>
        </p>
      </div>

      <AddCreditForm orgId={orgId} lang={lang} players={clubPlayers} />

      {players.length === 0 && (
        <p className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500" data-testid="credits-empty">
          {s.mcr_empty}
        </p>
      )}

      {players.map((p) => (
        <section key={p.userId} className="bg-white rounded-xl border border-slate-200 shadow-sm" data-testid="credits-player" data-user={p.userId}>
          <div className="px-6 py-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold text-slate-800">{p.name}</h3>
            <span className="text-sm text-slate-600" data-testid="credits-available" data-games={p.available}>
              {s.mcr_available({ games: p.available })}
            </span>
          </div>
          <div className="p-6 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-100">
                  <th className="py-2 pr-3 font-medium">{s.mcr_col_date}</th>
                  <th className="py-2 pr-3 font-medium">{s.mcr_col_reason}</th>
                  <th className="py-2 pr-3 font-medium">{s.mcr_col_state}</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {p.rows.map((r) => (
                  <tr key={r.id} className="border-b border-slate-50 last:border-0" data-testid="credit-row" data-state={r.state} data-reason={r.reason}>
                    <td className="py-2 pr-3 text-slate-500 whitespace-nowrap">{dayLabel(lang, new Date(r.createdAt))}</td>
                    <td className="py-2 pr-3 text-slate-700" data-testid="credit-why">
                      {why(r)}
                    </td>
                    <td className="py-2 pr-3 text-slate-600" data-testid="credit-where">
                      {where(r)}
                    </td>
                    <td className="py-2">{r.removable && <RemoveCreditButton orgId={orgId} creditId={r.id} lang={lang} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
