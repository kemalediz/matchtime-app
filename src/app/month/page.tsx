import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getUserOrg } from "@/lib/org";
import { t } from "@/lib/i18n/t";
import { dayCommaTimeLabel, monthNameLabel } from "@/lib/i18n/dates";
import { db } from "@/lib/db";
import { pounds } from "@/lib/month-payment-copy";
import { gameDaysLabel } from "@/lib/month-signup-copy";
import { loadLiveMonths } from "@/lib/month-signup";
import { normaliseSquadMode } from "@/lib/squad-month-rules";
import { MonthSignupCard } from "./signup-card";

/**
 * /month: a player's own page for the month's list (slice 3 of
 * MDs/monthly-squad-plan-2026-10-05.md, sections 4.1 and 9.3). The third
 * sign-up door, beside a pasted list and a message in the group: "I'm in
 * for the month", "pay as you go" (on the games they tick) or "not this
 * month".
 *
 * Any signed-in player of a club whose `squadMode` is "monthly". A WEEKLY
 * club (every club before this, Sutton FC included) gets a 404: the page
 * does not exist for it. It shows this month and the next while they are
 * not closed. The three choices are offered until a month's first game
 * kicks off; after that only the organiser changes who is on it.
 *
 * Slice 4: a regular also sees what they owe for the month, how it was
 * worked out, the club's own payment instructions and an "I've paid"
 * button. That button records a CLAIM; only the collector confirms.
 */
export const dynamic = "force-dynamic";

export default async function MonthPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login?callbackUrl=/month");
  const membership = await getUserOrg(session.user.id);
  if (!membership) redirect("/");
  if (normaliseSquadMode(membership.org.squadMode) !== "monthly") notFound();

  const lang = membership.org.language;
  const s = t(lang);
  const now = new Date();
  const months = await loadLiveMonths(membership.orgId, now);
  const collector = membership.org.paymentHolderId
    ? await db.user.findUnique({ where: { id: membership.org.paymentHolderId }, select: { name: true } })
    : null;
  const collectorFirst = collector?.name?.trim().split(/\s+/)[0] || null;

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8" data-testid="month-page">
      <div className="mx-auto max-w-md space-y-4">
        <p className="text-sm font-medium text-slate-500">{membership.org.name}</p>
        {months.length === 0 && (
          <p className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600" data-testid="month-none">
            {s.mmp_none}
          </p>
        )}
        {months.map((m) => {
          const me = m.members.find((x) => x.userId === session.user!.id) ?? null;
          const outcome = !me ? "none" : me.out ? "out" : me.waiting ? "waiting" : me.kind === "regular" ? "regular" : "payg";
          const myDays = me ? m.matches.filter((x) => me.paygMatchIds.includes(x.matchId)).map((x) => x.day) : [];
          return (
            <MonthSignupCard
              key={m.id}
              monthId={m.id}
              lang={lang}
              title={s.mmp_title({ month: monthNameLabel(lang, m.firstKickoff) })}
              games={s.mmp_games({ games: m.kickoffs.length, days: gameDaysLabel(m.kickoffs) })}
              days={m.matches.map((x) => x.day)}
              outcome={outcome}
              slot={me && outcome === "regular" ? me.slot : null}
              myDays={myDays}
              locked={!!me && !me.out && me.paid !== "none"}
              joinable={now.getTime() < m.firstKickoff.getTime()}
              money={
                me && outcome === "regular"
                  ? {
                      due:
                        me.amountDuePence != null
                          ? s.mmp_due({ amount: pounds(me.amountDuePence), games: me.gamesCovered, credits: me.creditsApplied })
                          : s.mmp_not_priced,
                      payBy: m.payByAt && me.amountDuePence != null ? s.mmp_payby({ when: dayCommaTimeLabel(lang, m.payByAt), collector: collectorFirst }) : null,
                      instructions: me.amountDuePence != null ? membership.org.paymentInstructions : null,
                      paid: me.paid,
                      canClaim: me.paid === "none" && (me.amountDuePence ?? 0) > 0,
                    }
                  : null
              }
            />
          );
        })}
      </div>
    </div>
  );
}
