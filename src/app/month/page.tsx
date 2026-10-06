import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getUserOrg } from "@/lib/org";
import { t } from "@/lib/i18n/t";
import { monthNameLabel } from "@/lib/i18n/dates";
import { gameDaysLabel } from "@/lib/month-signup-copy";
import { loadJoinableMonths } from "@/lib/month-signup";
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
 * does not exist for it. It shows the months somebody can still join: not
 * closed, and the first game not kicked off yet.
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
  const months = await loadJoinableMonths(membership.orgId);

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
            />
          );
        })}
      </div>
    </div>
  );
}
