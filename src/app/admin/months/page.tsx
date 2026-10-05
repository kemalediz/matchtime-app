import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getUserOrg, isOrgAdmin } from "@/lib/org";
import { SectionInfo } from "@/components/info/section-info";
import { t } from "@/lib/i18n/t";
import { monthYearLabel } from "@/lib/i18n/dates";
import { moneyLabel } from "@/lib/club-billing-view";
import { loadMonthPage, type MonthMemberView } from "@/lib/squad-month";
import { normaliseSquadMode } from "@/lib/squad-month-rules";
import { StartMonthForm } from "./start-month-form";

/**
 * /admin/months: the month's list for a club on a monthly squad (slice 2
 * of MDs/monthly-squad-plan-2026-10-05.md, sections 9.2 and 4.5).
 *
 * OWNER and ADMIN of a club whose `squadMode` is "monthly". Anybody else
 * is turned away by the admin layout, and a WEEKLY club (every club
 * today, Sutton FC included) gets a 404: the page does not exist for it.
 *
 * Slice 2 shows the current London month for each active fixture. A
 * month not yet started is an empty page with one thing to do: start it
 * now, part-way through, from the organiser's own list. A started month
 * is read only here; pricing, confirming payments and credits are later
 * slices. Nothing on this page posts to WhatsApp.
 */
export const dynamic = "force-dynamic";

export default async function MonthsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const membership = await getUserOrg(session.user.id);
  if (!membership) redirect("/create-org");
  if (!(await isOrgAdmin(session.user.id, membership.orgId))) redirect("/");
  if (normaliseSquadMode(membership.org.squadMode) !== "monthly") notFound();

  const lang = membership.org.language;
  const s = t(lang);
  const data = await loadMonthPage(membership.orgId);
  const month = monthYearLabel(lang, new Date(`${data.monthStart}T12:00:00.000Z`));

  const paidCell = (m: MonthMemberView): string => {
    if (m.kind === "payg") return "";
    const state = m.paid === "confirmed" ? s.mth_paid_confirmed : m.paid === "claimed" ? s.mth_paid_claimed : s.mth_paid_none;
    return m.paid !== "none" && m.paidPence != null ? s.mth_paid_amount({ state, amount: moneyLabel(m.paidPence) }) : state;
  };

  return (
    <div className="space-y-6" data-testid="months-page">
      <div>
        <h2 className="flex items-center gap-1 text-lg font-semibold text-slate-800">
          {s.mth_page_title}
          <SectionInfo k="mth_page" lang={lang} />
        </h2>
        <p className="text-sm text-slate-500 mt-1">{s.mth_page_lead}</p>
      </div>

      {data.fixtures.length === 0 && (
        <p className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500" data-testid="months-no-fixture">
          {s.mth_no_fixture}
        </p>
      )}

      {data.fixtures.map((f) => (
        <section
          key={f.activityId}
          className="bg-white rounded-xl border border-slate-200 shadow-sm"
          data-testid="month-card"
          data-activity={f.activityId}
        >
          <div className="px-6 py-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-semibold text-slate-800">
                {month}: {f.name}
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                {s.mth_fixture_games({ games: f.month?.gamesScheduled ?? f.dates.length, played: f.gamesPlayed })}
              </p>
            </div>
            {f.month && (
              <span
                className="rounded-full border border-green-200 bg-green-50 px-2.5 py-0.5 text-xs font-medium text-green-700"
                data-testid="month-status"
              >
                {s.mth_status({ status: f.month.status })}
              </span>
            )}
          </div>

          {f.month ? (
            <div className="p-6 space-y-3">
              {f.month.startedMidMonth && (
                <p className="text-sm text-slate-600" data-testid="month-started-mid">
                  {s.mth_started_mid({ played: f.month.gamesPlayedBeforeStart })}
                </p>
              )}
              <p className="text-sm text-slate-600" data-testid="month-share">
                {f.month.sharePerGamePence != null
                  ? s.mth_share_line({ amount: moneyLabel(f.month.sharePerGamePence) })
                  : s.mth_no_share}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="month-members">
                  <thead>
                    <tr className="text-left text-xs text-slate-500 border-b border-slate-100">
                      <th className="py-2 pr-3 font-medium">{s.mth_col_slot}</th>
                      <th className="py-2 pr-3 font-medium">{s.mth_col_player}</th>
                      <th className="py-2 pr-3 font-medium">{s.mth_col_type}</th>
                      <th className="py-2 pr-3 font-medium">{s.mth_col_games}</th>
                      <th className="py-2 pr-3 font-medium">{s.mth_col_credits_used}</th>
                      <th className="py-2 pr-3 font-medium">{s.mth_col_due}</th>
                      <th className="py-2 font-medium">{s.mth_col_paid}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {f.month.members.map((m) => (
                      <tr key={m.userId} className="border-b border-slate-50 last:border-0" data-testid="month-member" data-user={m.userId}>
                        <td className="py-2 pr-3 text-slate-500">{m.slot ?? ""}</td>
                        <td className="py-2 pr-3 font-medium text-slate-800">{m.name}</td>
                        <td className="py-2 pr-3 text-slate-600">{m.kind === "payg" ? s.mth_kind_payg : s.mth_kind_regular}</td>
                        <td className="py-2 pr-3 text-slate-600">{m.kind === "payg" ? "" : m.gamesCovered}</td>
                        <td className="py-2 pr-3 text-slate-600">{m.kind === "payg" ? "" : m.creditsApplied}</td>
                        <td className="py-2 pr-3 text-slate-600">
                          {m.kind === "payg" ? "" : m.amountDuePence != null ? moneyLabel(m.amountDuePence) : s.mth_due_unknown}
                        </td>
                        <td className="py-2 text-slate-600" data-paid={m.kind === "payg" ? "" : m.paid}>
                          {paidCell(m)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="p-6 space-y-4" data-testid="month-empty">
              <div>
                <h4 className="flex items-center gap-1 text-sm font-semibold text-slate-800">
                  {s.mth_empty_title({ month })}
                  <SectionInfo k="mth_start" lang={lang} />
                </h4>
                <p className="text-sm text-slate-500 mt-1 max-w-2xl">{s.mth_empty_body}</p>
              </div>
              {data.players.length === 0 ? (
                <p className="text-sm text-slate-500">{s.mth_no_players}</p>
              ) : (
                <StartMonthForm
                  orgId={membership.orgId}
                  lang={lang}
                  activityId={f.activityId}
                  month={month}
                  games={f.dates.length}
                  played={f.gamesPlayed}
                  players={data.players}
                />
              )}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
