import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getUserOrg } from "@/lib/org";
import { t } from "@/lib/i18n/t";
import { monthYearLabel } from "@/lib/i18n/dates";
import { loadMonthMoney, type MonthMoney } from "@/lib/month-close";
import { mayConfirmPayments } from "@/lib/month-payment";
import { pounds } from "@/lib/month-payment-copy";
import { nextMonthStart, previousMonthStart } from "@/lib/month-signup-rules";
import { loadMonthPage, type MonthFixtureView, type MonthMemberView } from "@/lib/squad-month";
import { normaliseSquadMode } from "@/lib/squad-month-rules";
import { RefundForm } from "@/app/admin/months/money-forms";
import { PaidButton } from "@/app/admin/months/price-form";

/**
 * /month/collect: the money collector's own page (slice 6, review round
 * 1). The plan has the COLLECTOR confirm payments and record refunds (D3),
 * and the collector need not be an OWNER or ADMIN, so this lives outside
 * /admin. Whoever `mayConfirmPayments` says may confirm for the club sees
 * it; anybody else, and every WEEKLY club, gets a 404.
 *
 * This month, the next and the one before (or `?month=YYYY-MM-01`): each
 * regular with what they owe and whether they have paid, "Confirm paid",
 * and "Record refund" where money is owed back. Nothing else can be
 * changed from here, and nothing here moves money.
 */
export const dynamic = "force-dynamic";

export default async function CollectPage({ searchParams }: { searchParams: Promise<{ month?: string | string[]; club?: string | string[] }> }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login?callbackUrl=/month/collect");
  const params = await searchParams;
  const club = typeof params?.club === "string" ? params.club : null;
  const membership = club
    ? await db.membership.findFirst({ where: { userId: session.user.id, orgId: club, leftAt: null }, include: { org: true } })
    : await getUserOrg(session.user.id);
  if (!membership) redirect("/");
  if (normaliseSquadMode(membership.org.squadMode) !== "monthly") notFound();
  const orgId = membership.orgId;
  if (!(await mayConfirmPayments(orgId, session.user.id))) notFound();

  const lang = membership.org.language;
  const s = t(lang);
  const now = new Date();
  const current = await loadMonthPage(orgId, now);
  const asked = typeof params?.month === "string" && /^\d{4}-\d{2}-01$/.test(params.month) ? params.month : null;
  const starts = asked ? [asked] : [previousMonthStart(current.monthStart), current.monthStart, nextMonthStart(current.monthStart)];
  const pages: Array<{ monthStart: string; fixtures: MonthFixtureView[] }> = [];
  for (const start of starts) {
    const page = start === current.monthStart ? current : await loadMonthPage(orgId, now, start);
    pages.push({ monthStart: start, fixtures: page.fixtures.filter((f) => f.month) });
  }
  const money = await loadMonthMoney(
    orgId,
    pages.flatMap((p) => p.fixtures.map((f) => f.month!.id)),
  );
  const noMoney: MonthMoney = { balances: {}, refunded: {}, leavers: [] };

  const paidText = (m: MonthMemberView): string => {
    const state = m.paid === "confirmed" ? s.mth_paid_confirmed : m.paid === "claimed" ? s.mth_paid_claimed : s.mth_paid_none;
    return m.paid !== "none" && m.paidPence != null ? s.mth_paid_amount({ state, amount: pounds(m.paidPence) }) : state;
  };
  const cards = pages.flatMap((p) => p.fixtures.map((f) => ({ f, label: monthYearLabel(lang, new Date(`${p.monthStart}T12:00:00.000Z`)) })));

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8" data-testid="collect-page">
      <div className="mx-auto max-w-2xl space-y-4">
        <p className="text-sm font-medium text-slate-500">{membership.org.name}</p>
        <div>
          <h1 className="text-lg font-semibold text-slate-900">{s.mcp_title}</h1>
          <p className="text-sm text-slate-500 mt-1">{s.mcp_lead}</p>
          <p className="mt-2 text-sm">
            <Link href={club ? `/month?club=${club}` : "/month"} className="text-blue-700 hover:underline">
              {s.mth_back_current}
            </Link>
          </p>
        </div>
        {cards.length === 0 && (
          <p className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600" data-testid="collect-none">
            {s.mcp_none}
          </p>
        )}
        {cards.map(({ f, label }) => {
          const mo = f.month!;
          const cash = money[mo.id] ?? noMoney;
          return (
            <section key={mo.id} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-3" data-testid="collect-month" data-month={mo.id}>
              <h2 className="font-semibold text-slate-800">
                {label}: {f.name}
              </h2>
              <ul className="space-y-2">
                {mo.members
                  .filter((m) => m.kind === "regular")
                  .map((m) => {
                    const balance = cash.balances[m.userId] ?? 0;
                    return (
                      <li key={m.userId} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-700" data-testid="collect-member" data-user={m.userId}>
                        <span className="font-medium text-slate-800">{m.name}</span>
                        <span>{m.amountDuePence != null ? pounds(m.amountDuePence) : s.mth_due_unknown}</span>
                        <span data-paid={m.paid}>{paidText(m)}</span>
                        {balance !== 0 && (
                          <span className="text-xs font-medium text-amber-700" data-testid="collect-balance">
                            {balance > 0 ? s.mth_bal_owes({ amount: pounds(balance) }) : s.mth_bal_back({ amount: pounds(-balance) })}
                          </span>
                        )}
                        {cash.refunded[m.userId] > 0 && <span className="text-xs text-slate-500">{s.mth_refunded({ amount: pounds(cash.refunded[m.userId]) })}</span>}
                        <PaidButton orgId={orgId} monthId={mo.id} userId={m.userId} lang={lang} confirmed={m.paid === "confirmed"} />
                        {balance < 0 && <RefundForm orgId={orgId} monthId={mo.id} userId={m.userId} lang={lang} suggestedPence={-balance + (cash.refunded[m.userId] ?? 0)} />}
                      </li>
                    );
                  })}
              </ul>
              {cash.leavers.length > 0 && (
                <div className="space-y-1.5 border-t border-slate-100 pt-3">
                  <h3 className="text-sm font-semibold text-slate-800">{s.mth_leavers_title}</h3>
                  {cash.leavers.map((l) => (
                    <p key={l.userId} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-700" data-testid="collect-leaver" data-user={l.userId}>
                      <span className="font-medium text-slate-800">{l.name}</span>
                      <span data-testid="leaver-owed">
                        {l.owedGames > 0 ? s.mth_leaver_owed({ games: l.owedGames, amount: l.owedPence != null ? pounds(l.owedPence) : null }) : s.mth_leaver_settled}
                      </span>
                      {l.refundedPence > 0 && <span className="text-slate-500">{s.mth_refunded({ amount: pounds(l.refundedPence) })}</span>}
                      {l.owedGames > 0 && <RefundForm orgId={orgId} monthId={mo.id} userId={l.userId} lang={lang} suggestedPence={l.owedPence} />}
                    </p>
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
