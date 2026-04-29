import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { notFound, redirect } from "next/navigation";
import { requireOrgAdmin } from "@/lib/org";
import Link from "next/link";
import { format } from "date-fns";
import { ArrowLeft } from "lucide-react";
import { ResponseRow } from "./response-row";
import { CloseSurveyButton } from "./close-survey-button";

export default async function RosterSurveyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const survey = await db.rosterSurvey.findUnique({
    where: { id },
    include: {
      org: { select: { id: true, name: true } },
      dms: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              phoneNumber: true,
              memberships: { select: { orgId: true } },
            },
          },
        },
        orderBy: { createdAt: "asc" },
      },
      responses: true,
    },
  });
  if (!survey) notFound();
  await requireOrgAdmin(session.user.id, survey.orgId);

  const responsesByUser = new Map(
    survey.responses.map((r) => [r.userId, r]),
  );

  const inCount = survey.responses.filter((r) => r.response === "in").length;
  const maybeCount = survey.responses.filter((r) => r.response === "maybe").length;
  const outCount = survey.responses.filter((r) => r.response === "out").length;
  const unclearCount = survey.responses.filter((r) => r.response === "unclear").length;
  const pendingCount = Math.max(
    0,
    survey.dms.length - (inCount + maybeCount + outCount + unclearCount),
  );

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/roster-survey"
          className="text-sm text-slate-500 hover:text-slate-700 inline-flex items-center gap-1.5 mb-2"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to surveys
        </Link>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-lg font-semibold text-slate-800">
              Roster check-in — {format(survey.createdAt, "EEE d MMM yyyy")}
            </h2>
            <p className="text-sm text-slate-500 mt-1">
              {survey.org.name} · {survey.dms.length} member
              {survey.dms.length === 1 ? "" : "s"} surveyed ·{" "}
              <span
                className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ${
                  survey.status === "open"
                    ? "bg-blue-100 text-blue-700"
                    : "bg-slate-100 text-slate-600"
                }`}
              >
                {survey.status}
              </span>
            </p>
          </div>
          <CloseSurveyButton surveyId={survey.id} status={survey.status} />
        </div>
      </div>

      {/* Counts */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="p-4 rounded-xl border border-green-200 bg-green-50">
          <p className="text-xs uppercase tracking-wider text-green-700 font-medium">
            ✅ In
          </p>
          <p className="text-3xl font-bold text-green-700 mt-1">{inCount}</p>
        </div>
        <div className="p-4 rounded-xl border border-amber-200 bg-amber-50">
          <p className="text-xs uppercase tracking-wider text-amber-700 font-medium">
            🤔 Maybe
          </p>
          <p className="text-3xl font-bold text-amber-700 mt-1">{maybeCount}</p>
        </div>
        <div className="p-4 rounded-xl border border-slate-200 bg-slate-50">
          <p className="text-xs uppercase tracking-wider text-slate-600 font-medium">
            👋 Out
          </p>
          <p className="text-3xl font-bold text-slate-700 mt-1">{outCount}</p>
        </div>
        <div className="p-4 rounded-xl border border-slate-200 bg-white">
          <p className="text-xs uppercase tracking-wider text-slate-500 font-medium">
            🤷 Unclear
          </p>
          <p className="text-3xl font-bold text-slate-500 mt-1">{unclearCount}</p>
        </div>
        <div className="p-4 rounded-xl border border-slate-200 bg-white">
          <p className="text-xs uppercase tracking-wider text-slate-500 font-medium">
            ⏳ Pending
          </p>
          <p className="text-3xl font-bold text-slate-500 mt-1">{pendingCount}</p>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-3 border-b border-slate-100 grid grid-cols-[1fr_120px_1.5fr_220px] gap-4 text-xs font-semibold uppercase text-slate-500 tracking-wider">
          <div>Player</div>
          <div>Status</div>
          <div>Reply</div>
          <div className="text-right">Override</div>
        </div>
        <div className="divide-y divide-slate-100">
          {survey.dms.map((dm) => {
            const response = responsesByUser.get(dm.userId);
            return (
              <ResponseRow
                key={dm.id}
                surveyId={survey.id}
                userId={dm.userId}
                name={dm.user.name ?? "(unnamed)"}
                phone={dm.user.phoneNumber ?? ""}
                response={response?.response ?? null}
                rawReply={response?.rawReply ?? null}
                adminOverride={response?.adminOverride ?? false}
                respondedAt={response?.classifiedAt ?? null}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
