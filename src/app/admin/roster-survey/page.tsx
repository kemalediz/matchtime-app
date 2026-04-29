import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { getCurrentOrgId, requireOrgAdmin } from "@/lib/org";
import Link from "next/link";
import { Calendar, ChevronRight, ClipboardList } from "lucide-react";
import { format } from "date-fns";

/**
 * List of roster check-in surveys for the active org.
 *
 * Each row shows date, status, and quick counts (in / maybe / out /
 * pending). Click → detail page with full table + admin overrides.
 */
export default async function RosterSurveyListPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const orgId = await getCurrentOrgId();
  if (!orgId) redirect("/admin/organisations");
  await requireOrgAdmin(session.user.id, orgId);

  const surveys = await db.rosterSurvey.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    include: {
      dms: { select: { id: true } },
      responses: { select: { response: true } },
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-800">Roster check-in surveys</h2>
        <p className="text-sm text-slate-500 mt-1">
          One-off DM surveys to check who&apos;s still up for matches. Trigger via{" "}
          <code className="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">
            scripts/start-roster-survey.ts
          </code>
          .
        </p>
      </div>

      {surveys.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center">
          <ClipboardList className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500">No surveys yet for this organisation.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm divide-y divide-slate-100">
          {surveys.map((s) => {
            const dmCount = s.dms.length;
            const responses = s.responses;
            const inCount = responses.filter((r) => r.response === "in").length;
            const maybeCount = responses.filter((r) => r.response === "maybe").length;
            const outCount = responses.filter((r) => r.response === "out").length;
            const unclearCount = responses.filter((r) => r.response === "unclear").length;
            const pendingCount = Math.max(
              0,
              dmCount - (inCount + maybeCount + outCount + unclearCount),
            );
            return (
              <Link
                key={s.id}
                href={`/admin/roster-survey/${s.id}`}
                className="flex items-center justify-between gap-4 px-6 py-5 hover:bg-slate-50 transition-colors"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold text-slate-800">
                      {format(s.createdAt, "EEE d MMM yyyy")}
                    </p>
                    <span
                      className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ${
                        s.status === "open"
                          ? "bg-blue-100 text-blue-700"
                          : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {s.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-slate-500 mt-1">
                    <Calendar className="w-3 h-3" />
                    {format(s.createdAt, "HH:mm")} · {dmCount} member
                    {dmCount === 1 ? "" : "s"} surveyed
                  </div>
                  <div className="flex items-center gap-3 mt-2 text-xs">
                    <span className="text-green-700">✅ {inCount} in</span>
                    <span className="text-amber-700">🤔 {maybeCount} maybe</span>
                    <span className="text-slate-600">👋 {outCount} out</span>
                    {unclearCount > 0 && (
                      <span className="text-slate-500">🤷 {unclearCount} unclear</span>
                    )}
                    <span className="text-slate-400">⏳ {pendingCount} pending</span>
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
