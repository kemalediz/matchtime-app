import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getUserOrg, isOrgAdmin } from "@/lib/org";
import { SectionInfo } from "@/components/info/section-info";
import { t } from "@/lib/i18n/t";
import { dayCommaTimeLabel, monthYearLabel } from "@/lib/i18n/dates";
import { moneyLabel } from "@/lib/club-billing-view";
import { loadMonthPage, type MonthFixtureView, type MonthMemberView } from "@/lib/squad-month";
import { nextMonthStart, previousMonthStart } from "@/lib/month-signup-rules";
import { db } from "@/lib/db";
import { loadMonthMoney, loadMonthSummaryById, type MonthMoney } from "@/lib/month-close";
import { buildMonthSummaryLines } from "@/lib/month-close-copy";
import { pounds } from "@/lib/month-payment-copy";
import { monthStartToDate } from "@/lib/squad-month-rules";
import { RefundForm, ShareChangeForm } from "./money-forms";
import { normaliseSquadMode } from "@/lib/squad-month-rules";
import { AddMember, MemberActions } from "./member-actions";
import { PaidButton, PriceForm } from "./price-form";
import { planPricePence } from "@/lib/club-billing-rules";
import { mayConfirmPayments } from "@/lib/month-payment";
import { buildMonthFeeTip } from "@/lib/month-payment-copy";
import { monthFeeShare } from "@/lib/month-payment-rules";
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
 *
 * Slice 6: beside the table, what a share changed after payments leaves
 * each paid regular owing or owed, who left part-way and what they are
 * owed (with the collector's "Record refund"), a closed month's summary,
 * a link to the credits ledger, and `?month=YYYY-MM-01` for an earlier
 * month. Nothing here moves money.
 */
export const dynamic = "force-dynamic";

export default async function MonthsPage({ searchParams }: { searchParams: Promise<{ month?: string | string[] }> }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const membership = await getUserOrg(session.user.id);
  if (!membership) redirect("/create-org");
  if (!(await isOrgAdmin(session.user.id, membership.orgId))) redirect("/");
  if (normaliseSquadMode(membership.org.squadMode) !== "monthly") notFound();

  const lang = membership.org.language;
  const s = t(lang);
  const now = new Date();
  const orgId = membership.orgId;
  // Slice 6: `?month=2026-09-01` shows an earlier month (read from the
  // address, so it must be a real month start or it is ignored).
  const asked = (await searchParams)?.month;
  const askedStart = typeof asked === "string" && /^\d{4}-\d{2}-01$/.test(asked) ? asked : null;
  const current = await loadMonthPage(orgId, now);
  const past = askedStart !== null && askedStart < current.monthStart;
  const data = past ? await loadMonthPage(orgId, now, askedStart) : current;
  const month = monthYearLabel(lang, new Date(`${data.monthStart}T12:00:00.000Z`));
  // Next month, once MatchTime has opened its list (slice 3).
  const nextStart = nextMonthStart(data.monthStart);
  const nextMonth = monthYearLabel(lang, new Date(`${nextStart}T12:00:00.000Z`));
  const nextFixtures = past ? [] : (await loadMonthPage(orgId, now, nextStart)).fixtures.filter((f) => f.month);
  // The month before the one shown, when the club has one: a link to it.
  const earlierStart = previousMonthStart(data.monthStart);
  const hasEarlier = (await db.squadMonth.findFirst({ where: { orgId, monthStart: monthStartToDate(earlierStart) }, select: { id: true } })) !== null;
  // Slice 6: balances, leavers and refunds for every month on the page,
  // and the summary of each one that is closed.
  const shown = [...data.fixtures, ...nextFixtures].flatMap((f) => (f.month ? [f.month] : []));
  const money = await loadMonthMoney(
    orgId,
    shown.map((m) => m.id),
  );
  const summaries = new Map<string, string[]>();
  for (const m of shown.filter((x) => x.status === "closed")) {
    const res = await loadMonthSummaryById(orgId, m.id, now);
    if (res) summaries.set(m.id, buildMonthSummaryLines({ summary: res.summary, monthDate: new Date(`${res.monthStart}T12:00:00.000Z`), lang }));
  }
  const noMoney: MonthMoney = { balances: {}, refunded: {}, leavers: [] };
  // Slice 4. Only the club's money collector confirms a payment (D3).
  const canConfirm = await mayConfirmPayments(orgId, session.user.id);
  const clubFeePence = membership.org.billingStatus === "exempt" ? null : planPricePence(membership.org.billingPlan, membership.org.billingPricePence);
  /** The club fee in month terms, under the price form (plan 4.2). */
  const feeTipFor = (f: MonthFixtureView): string | null => {
    const regulars = f.month?.members.filter((m) => m.kind === "regular").length ?? 0;
    const games = f.month?.gamesScheduled ?? 0;
    const fee = monthFeeShare({ pricePence: clubFeePence, regulars, games });
    return fee && clubFeePence ? buildMonthFeeTip({ pricePence: clubFeePence, regulars, games, ...fee, lang }) : null;
  };

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
  /** Slice 6: what a paid regular owes, or is owed, since the share changed. */
  const balanceText = (pence: number | undefined): string | null =>
    !pence ? null : pence > 0 ? s.mth_bal_owes({ amount: pounds(pence) }) : s.mth_bal_back({ amount: pounds(-pence) });

  const card = (f: MonthFixtureView, label: string, next: boolean) => {
    const mo = f.month;
    const cash = (mo && money[mo.id]) || noMoney;
    const summary = mo ? summaries.get(mo.id) : undefined;
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
              {mo.payByAt && <span data-testid="month-payby"> {s.mth_payby_line({ when: dayCommaTimeLabel(lang, new Date(mo.payByAt)) })}</span>}
            </p>
            {mo.status !== "closed" && (
              <PriceForm
                orgId={orgId}
                monthId={mo.id}
                lang={lang}
                sharePence={mo.sharePerGamePence}
                concessionPence={mo.concessionPerGamePence}
                venuePence={mo.venueCostPence}
                payBy={mo.payByDefault}
                regulars={mo.members.filter((m) => m.kind === "regular").length}
                priced={mo.priced}
                locked={mo.priced && mo.priceLocked}
                feeTip={feeTipFor(f)}
              />
            )}
            {mo.status !== "closed" && mo.priced && mo.priceLocked && (
              <ShareChangeForm orgId={orgId} monthId={mo.id} lang={lang} sharePence={mo.sharePerGamePence} concessionPence={mo.concessionPerGamePence} />
            )}
            {summary && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-1" data-testid="month-summary">
                <h4 className="text-sm font-semibold text-slate-800">{s.mth_summary_title}</h4>
                {summary.map((line, i) => (
                  <p key={i} className="text-sm text-slate-700" data-testid="month-summary-line">
                    {line}
                  </p>
                ))}
              </div>
            )}
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
                        {m.kind === "regular" && balanceText(cash.balances[m.userId]) && (
                          <span className="block text-xs font-medium text-amber-700" data-testid="member-balance">
                            {balanceText(cash.balances[m.userId])}
                          </span>
                        )}
                        {m.kind === "regular" && cash.refunded[m.userId] > 0 && (
                          <span className="block text-xs text-slate-500" data-testid="member-refunded">
                            {s.mth_refunded({ amount: pounds(cash.refunded[m.userId]) })}
                          </span>
                        )}
                      </td>
                      <td className="py-2">
                        {/* The collector confirms on a closed month too: money that arrives late. */}
                        {canConfirm && m.kind === "regular" && (
                          <div className="mb-1.5">
                            <PaidButton orgId={orgId} monthId={mo.id} userId={m.userId} lang={lang} confirmed={m.paid === "confirmed"} />
                          </div>
                        )}
                        {canConfirm && m.kind === "regular" && (cash.balances[m.userId] ?? 0) < 0 && (
                          <div className="mb-1.5">
                            <RefundForm orgId={orgId} monthId={mo.id} userId={m.userId} lang={lang} suggestedPence={-cash.balances[m.userId] + (cash.refunded[m.userId] ?? 0)} />
                          </div>
                        )}
                        {mo.status !== "closed" && (
                          <MemberActions orgId={orgId} monthId={mo.id} userId={m.userId} lang={lang} now={m.waiting ? "waiting" : m.kind} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {cash.leavers.length > 0 && (
              <div className="space-y-2" data-testid="month-leavers">
                <h4 className="text-sm font-semibold text-slate-800">{s.mth_leavers_title}</h4>
                <p className="text-xs text-slate-500 max-w-2xl">{s.mth_leavers_lead}</p>
                <ul className="space-y-1.5">
                  {cash.leavers.map((l) => (
                    <li key={l.userId} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-700" data-testid="month-leaver" data-user={l.userId}>
                      <span className="font-medium text-slate-800">{l.name}</span>
                      <span data-testid="leaver-owed">
                        {l.owedGames > 0 ? s.mth_leaver_owed({ games: l.owedGames, amount: l.owedPence != null ? pounds(l.owedPence) : null }) : s.mth_leaver_settled}
                      </span>
                      {l.refundedPence > 0 && (
                        <span className="text-slate-500" data-testid="leaver-refunded">
                          {s.mth_refunded({ amount: pounds(l.refundedPence) })}
                        </span>
                      )}
                      {canConfirm && l.owedGames > 0 && (
                        <RefundForm orgId={orgId} monthId={mo.id} userId={l.userId} lang={lang} suggestedPence={l.owedPence} />
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
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
            {past ? null : data.players.length === 0 ? (
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
        <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <Link href="/admin/months/credits" className="text-blue-700 hover:underline" data-testid="months-credits-link">
            {s.mth_credits_link}
          </Link>
          {hasEarlier && (
            <Link href={`/admin/months?month=${earlierStart}`} className="text-blue-700 hover:underline" data-testid="months-earlier-link">
              {s.mth_earlier({ month: monthYearLabel(lang, new Date(`${earlierStart}T12:00:00.000Z`)) })}
            </Link>
          )}
          {past && (
            <Link href="/admin/months" className="text-blue-700 hover:underline" data-testid="months-current-link">
              {s.mth_back_current}
            </Link>
          )}
        </p>
        {past && (
          <p className="mt-1 text-sm text-slate-600" data-testid="months-viewing-past">
            {s.mth_viewing_past({ month })}
          </p>
        )}
      </div>

      {data.fixtures.length === 0 && (
        <p className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500" data-testid="months-no-fixture">
          {s.mth_no_fixture}
        </p>
      )}

      {(past ? data.fixtures.filter((f) => f.month) : data.fixtures).map((f) => card(f, month, false))}

      {nextFixtures.length > 0 && (
        <div className="space-y-3" data-testid="next-month">
          <h3 className="text-sm font-semibold text-slate-700">{s.mth_next_month({ month: nextMonth })}</h3>
          {nextFixtures.map((f) => card(f, nextMonth, true))}
        </div>
      )}
    </div>
  );
}
