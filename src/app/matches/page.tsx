import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getUserOrg, isOrgAdmin } from "@/lib/org";
import { redirect } from "next/navigation";
import Link from "next/link";
import { format, formatDistanceToNow, isToday, isTomorrow } from "date-fns";
import { Calendar, MapPin, Users, Star } from "lucide-react";
import { MatchesTabs } from "@/components/match/matches-tabs";
import { formatLondon } from "@/lib/london-time";
import { getMomSummaries } from "@/lib/mom";
import { t } from "@/lib/i18n/t";
import { ResultScore } from "@/components/match/result-score";

// IMPORTANT: every user-facing time on this page is rendered in London
// wall-clock via formatLondon. Plain date-fns format() uses the runtime's
// local TZ which on Vercel is UTC — that's why kickoff at 21:30 BST was
// rendering as 20:30 (the UTC equivalent). Date-only strings can stay on
// date-fns since they don't carry a time component.
function relativeLabel(date: Date): string {
  if (isToday(date)) return `Today at ${formatLondon(date, "HH:mm")}`;
  if (isTomorrow(date)) return `Tomorrow at ${formatLondon(date, "HH:mm")}`;
  const dist = formatDistanceToNow(date, { addSuffix: false });
  if (dist.includes("day") && parseInt(dist) <= 7) {
    return `${formatLondon(date, "EEE 'at' HH:mm")} (in ${dist})`;
  }
  return formatLondon(date, "EEE, d MMM 'at' HH:mm");
}

export default async function MatchesPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const membership = await getUserOrg(session.user.id);
  if (!membership) redirect("/create-org");

  const orgId = membership.orgId;

  const upcomingMatches = await db.match.findMany({
    where: { activity: { orgId }, date: { gte: new Date() } },
    orderBy: { date: "asc" },
    include: {
      activity: { include: { sport: true } },
      attendances: { where: { status: { in: ["CONFIRMED", "BENCH"] } } },
    },
  });

  const pastMatches = await db.match.findMany({
    where: { activity: { orgId }, status: "COMPLETED", isHistorical: false },
    orderBy: { date: "desc" },
    take: 20,
    include: { activity: { include: { sport: true } } },
  });
  const momByMatch = await getMomSummaries(pastMatches.map((m) => m.id));
  // An admin sees "Add score" on a played match with no result (FNF,
  // 2026-10-18: the Past tab showed nothing, so nothing said it was missing).
  const isAdmin = await isOrgAdmin(session.user.id, orgId);
  const s = t(membership.org.language);

  const myAttendances = await db.attendance.findMany({
    where: {
      userId: session.user.id,
      matchId: { in: [...upcomingMatches, ...pastMatches].map((m) => m.id) },
      status: { not: "DROPPED" },
    },
  });
  const myAttMap = new Map(myAttendances.map((a) => [a.matchId, a.status]));

  const upcomingCards = upcomingMatches.map((m) => {
    const confirmed = m.attendances.filter((a) => a.status === "CONFIRMED").length;
    const bench = m.attendances.filter((a) => a.status === "BENCH").length;
    const myStatus = myAttMap.get(m.id) ?? null;
    const pct = Math.min(100, Math.round((confirmed / m.maxPlayers) * 100));
    const barColor =
      confirmed >= m.maxPlayers
        ? "bg-green-500"
        : confirmed >= m.maxPlayers * 0.75
        ? "bg-blue-600"
        : "bg-amber-500";

    const borderColor =
      myStatus === "CONFIRMED"
        ? "border-l-green-500"
        : myStatus === "BENCH"
        ? "border-l-amber-500"
        : "border-l-transparent";

    const pill =
      myStatus === "CONFIRMED"
        ? { label: "In", cls: "bg-green-100 text-green-700" }
        : myStatus === "BENCH"
        ? { label: "Bench", cls: "bg-amber-100 text-amber-700" }
        : { label: "Not signed up", cls: "bg-slate-100 text-slate-500" };

    return (
      <Link
        key={m.id}
        href={`/matches/${m.id}`}
        className={`block bg-white rounded-xl border border-slate-200 border-l-4 ${borderColor} shadow-sm hover:shadow transition-all`}
      >
        <div className="p-5 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-semibold text-slate-800 truncate">{m.activity.name}</p>
              <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 text-sm text-slate-500 mt-1">
                <span className="flex items-center gap-1.5">
                  <Calendar className="w-3.5 h-3.5" />
                  {relativeLabel(m.date)}
                </span>
                <span className="flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5" />
                  {m.activity.venue}
                </span>
              </div>
            </div>
            <span className={`shrink-0 inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${pill.cls}`}>
              {pill.label}
            </span>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-1.5 text-slate-500">
                <Users className="w-3.5 h-3.5" />
                {confirmed}/{m.maxPlayers}
                {bench > 0 && <span className="ml-2 text-slate-400">· {bench} bench</span>}
              </span>
              <span className="inline-flex px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 text-xs font-medium">
                {m.activity.sport.name}
              </span>
            </div>
            <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div className={`h-full ${barColor}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        </div>
      </Link>
    );
  });

  const pastCards = pastMatches.map((m) => {
    const mom = momByMatch.get(m.id);
    const momLabel = mom
      ? mom.topPlayers.length > 1
        ? `${mom.topPlayers.map((p) => p.name).join(" & ")} (${mom.topCount} each, ${mom.totalVotes} votes)`
        : `${mom.topPlayers[0].name} (${mom.topCount}/${mom.totalVotes} votes)`
      : null;
    return (
      <div
        key={m.id}
        data-testid="past-result"
        className="relative block bg-white rounded-xl border border-slate-200 shadow-sm hover:shadow transition-all"
      >
        <div className="p-5 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <Link
              href={`/matches/${m.id}`}
              className="block font-semibold text-slate-800 truncate after:absolute after:inset-0"
            >
              {m.activity.name}
            </Link>
            <p className="text-sm text-slate-500 mt-0.5">{format(m.date, "EEE, d MMM yyyy")}</p>
            {momLabel && (
              <p className="text-xs text-slate-500 mt-1.5 flex items-center gap-1.5 truncate">
                <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500 shrink-0" />
                <span className="truncate">{momLabel}</span>
              </p>
            )}
          </div>
          <ResultScore
            matchId={m.id}
            redScore={m.redScore}
            yellowScore={m.yellowScore}
            isAdmin={isAdmin}
            addLabel={s.score_entry_add}
            large
          />
        </div>
      </div>
    );
  });

  return (
    <div className="p-6 sm:p-8 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold text-slate-800 mb-6">Matches</h1>
      <MatchesTabs
        upcomingCount={upcomingMatches.length}
        pastCount={pastMatches.length}
        upcoming={upcomingCards}
        past={pastCards}
      />
    </div>
  );
}
