import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getUserOrg, isOrgAdmin } from "@/lib/org";
import { SectionInfo } from "@/components/info/section-info";
import { t } from "@/lib/i18n/t";
import { dayCommaTimeLabel, monthYearLabel } from "@/lib/i18n/dates";
import { moneyLabel } from "@/lib/club-billing-view";
import { loadMonthPage, type MonthFixtureView, type MonthMemberView } from "@/lib/squad-month";
import { nextMonthStart } from "@/lib/month-signup-rules";
import { normaliseSquadMode } from "@/lib/squad-month-rules";
import { AddMember, MemberActions } from "./member-actions";
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
 *
 * Slice 3: a month MatchTime opened itself (its list is in the group)
 * shows who has signed up, who is PAYG and who is waiting for a regular
 * place, with the organiser's buttons for each. Next month appears here
 * as soon as its list is open.
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
  const now = new Date();
  const data = await loadMonthPage(membership.orgId, now);
  const month = monthYearLabel(lang, new Date(`${data.monthStart}T12:00:00.000Z`));
  // Next month, once MatchTime has opened its list (slice 3).
  const nextStart = nextMonthStart(data.monthStart);
  const nextMonth = monthYearLabel(lang, new Date(`${nextStart}T12:00:00.000Z`));
  const nextFixtures = (await loadMonthPage(membership.orgId, now, nextStart)).fixtures.filter((f) => f.month);
  const orgId = membership.orgId;

  const kindCell = (m: MonthMemberView): string =>
    m.waiting
      ? s.mth_kind_waiting
      : m.kind === "payg"
        ? m.paygDays.length > 0
          ? s.mth_payg_days({ days: m.paygDays.join(", ") })
          : s.mth_kind_payg
        : s.mth_kind_regular;

  /** The sign-up lines of a month MatchTime opened itself. */
  const signupLines = (f: MonthFixtureView) => {
    const mo = f.month;
    if (!mo?.signupEndsAt) return null;
    const regulars = mo.members.filter((m) => m.kind === "regular").length;
    return (
      <div className="space-y-1 text-sm text-slate-600" data-testid="month-signup-lines">
        <p className="flex items-center gap-1" data-testid="month-signup-state">
          {mo.status === "open" ? s.mth_signup_open({ when: dayCommaTimeLabel(lang, new Date(mo.signupEndsAt)) }) : s.mth_signup_ended}
          <SectionInfo k="mth_signup" lang={lang} />
        </p>
        <p data-testid="month-signup-counts">
          {s.mth_signup_counts({
            regulars,
            max: mo.maxRegulars,
            payg: mo.members.filter((m) => m.kind === "payg" && !m.waiting).length,
            waiting: mo.members.filter((m) => m.waiting).length,
          })}
        </p>
      </div>
    );
  };

  const paidCell = (m: MonthMemberView): string => {
    if (m.kind === "payg") return "";
    const state = m.paid === "confirmed" ? s.mth_paid_confirmed : m.paid === "claimed" ? s.mth_paid_claimed : s.mth_paid_none;
    return m.paid !== "none" && m.paidPence != null ? s.mth_paid_amount({ state, amount: moneyLabel(m.paidPence) }) : state;
  };

  const card = (f: MonthFixtureView, label: string, next: boolean) => {
    const mo = f.month;
    return (
      <section
        key={`${next ? "next" : "this"}-${f.activityId}`}
        className="bg-white rounded-xl border border-slate-200 shadow-sm"
        data-testid={next ? "next-month-card" : "month-card"}
        data-activity={f.activityId}
      >
        <div className="px-6 py-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-semibold text-slate-800">
              {label}: {f.name}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {s.mth_fixture_games({ games: mo?.gamesScheduled ?? f.dates.length, played: f.gamesPlayed })}
            </p>
          </div>
          {mo && (
            <span
              className="rounded-full border border-green-200 bg-green-50 px-2.5 py-0.5 text-xs font-medium text-green-700"
              data-testid="month-status"
            >
              {s.mth_status({ status: mo.status })}
            </span>
          )}
        </div>

        {mo ? (
          <div className="p-6 space-y-3">
            {mo.startedMidMonth && (
              <p className="text-sm text-slate-600" data-testid="month-started-mid">
                {s.mth_started_mid({ played: mo.gamesPlayedBeforeStart })}
              </p>
            )}
            {signupLines(f)}
            <p className="text-sm text-slate-600" data-testid="month-share">
              {mo.sharePerGamePence != null ? s.mth_share_line({ amount: moneyLabel(mo.sharePerGamePence) }) : s.mth_no_share}
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
                    <th className="py-2 pr-3 font-medium">{s.mth_col_paid}</th>
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {mo.members.map((m) => (
                    <tr key={m.userId} className="border-b border-slate-50 last:border-0" data-testid="month-member" data-user={m.userId}>
                      <td className="py-2 pr-3 text-slate-500">{m.slot ?? ""}</td>
                      <td className="py-2 pr-3 font-medium text-slate-800">{m.name}</td>
                      <td className="py-2 pr-3 text-slate-600" data-kind={m.waiting ? "waiting" : m.kind}>
                        {kindCell(m)}
                      </td>
                      <td className="py-2 pr-3 text-slate-600">{m.kind === "payg" ? "" : m.gamesCovered}</td>
                      <td className="py-2 pr-3 text-slate-600">{m.kind === "payg" ? "" : m.creditsApplied}</td>
                      <td className="py-2 pr-3 text-slate-600">
                        {m.kind === "payg" ? "" : m.amountDuePence != null ? moneyLabel(m.amountDuePence) : s.mth_due_unknown}
                      </td>
                      <td className="py-2 pr-3 text-slate-600" data-paid={m.kind === "payg" ? "" : m.paid}>
                        {paidCell(m)}
                      </td>
                      <td className="py-2">
                        {mo.status !== "closed" && (
                          <MemberActions orgId={orgId} monthId={mo.id} userId={m.userId} lang={lang} now={m.waiting ? "waiting" : m.kind} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {mo.status !== "closed" && (
              <AddMember
                orgId={orgId}
                monthId={mo.id}
                lang={lang}
                players={data.players.filter((p) => !mo.members.some((m) => m.userId === p.userId))}
              />
            )}
          </div>
        ) : (
          <div className="p-6 space-y-4" data-testid="month-empty">
            <div>
              <h4 className="flex items-center gap-1 text-sm font-semibold text-slate-800">
                {s.mth_empty_title({ month: label })}
                <SectionInfo k="mth_start" lang={lang} />
              </h4>
              <p className="text-sm text-slate-500 mt-1 max-w-2xl">{s.mth_empty_body}</p>
            </div>
            {data.players.length === 0 ? (
              <p className="text-sm text-slate-500">{s.mth_no_players}</p>
            ) : (
              <StartMonthForm
                orgId={orgId}
                lang={lang}
                activityId={f.activityId}
                month={label}
                games={f.dates.length}
                played={f.gamesPlayed}
                players={data.players}
              />
            )}
          </div>
        )}
      </section>
    );
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

      {data.fixtures.map((f) => card(f, month, false))}

      {nextFixtures.length > 0 && (
        <div className="space-y-3" data-testid="next-month">
          <h3 className="text-sm font-semibold text-slate-700">{s.mth_next_month({ month: nextMonth })}</h3>
          {nextFixtures.map((f) => card(f, nextMonth, true))}
        </div>
      )}
    </div>
  );
}
