import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getUserOrg } from "@/lib/org";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Users, Calendar, Clock, CheckCircle, ChevronRight, Star } from "lucide-react";
import { format } from "date-fns";

const TILE = {
  blue: "bg-blue-50 text-blue-700 border-blue-200",
  green: "bg-green-50 text-green-700 border-green-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  purple: "bg-purple-50 text-purple-700 border-purple-200",
} as const;

export default async function AdminDashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const membership = await getUserOrg(session.user.id);
  if (!membership) redirect("/create-org");

  const orgId = membership.orgId;

  const [playerCount, activeActivities, upcomingMatches, completedMatches, latestMatch] = await Promise.all([
    db.membership.count({ where: { orgId, leftAt: null } }),
    db.activity.count({ where: { orgId, isActive: true } }),
    db.match.count({
      where: {
        activity: { orgId },
        status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
      },
    }),
    db.match.count({
      where: { activity: { orgId }, status: "COMPLETED", isHistorical: false },
    }),
    db.match.findFirst({
      where: { activity: { orgId }, status: "COMPLETED", isHistorical: false },
      orderBy: { date: "desc" },
      include: {
        activity: { select: { name: true } },
        attendances: {
          // CONFIRMED only — the rating-DM dispatch in bot-scheduler.ts
          // only sends to CONFIRMED players (BENCH never plays, never
          // gets the DM, can't reach the rating UI). Including BENCH
          // here left them permanently in "pending" with no way to
          // resolve. Sutton Lads 2026-05-28 showed 0/15 instead of 0/14
          // because Eman was on the bench.
          where: { status: "CONFIRMED" },
          include: { user: { select: { id: true, name: true } } },
        },
        ratings: { select: { raterId: true } },
      },
    }),
  ]);

  const ratingProgress = latestMatch
    ? (() => {
        const raters = new Set(latestMatch.ratings.map((r) => r.raterId));
        const players = latestMatch.attendances;
        const submitted = players.filter((a) => raters.has(a.user.id));
        const pending = players.filter((a) => !raters.has(a.user.id));
        return { match: latestMatch, submitted, pending, total: players.length };
      })()
    : null;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Link href="/admin/players" className={`p-5 rounded-xl border ${TILE.purple} hover:shadow-md transition-shadow`}>
          <div className="flex items-center gap-2 opacity-75">
            <Users className="w-4 h-4" />
            <p className="text-xs font-medium uppercase tracking-wider">Players</p>
          </div>
          <p className="text-3xl font-bold mt-2">{playerCount}</p>
        </Link>
        <Link href="/admin/activities" className={`p-5 rounded-xl border ${TILE.blue} hover:shadow-md transition-shadow`}>
          <div className="flex items-center gap-2 opacity-75">
            <Calendar className="w-4 h-4" />
            <p className="text-xs font-medium uppercase tracking-wider">Activities</p>
          </div>
          <p className="text-3xl font-bold mt-2">{activeActivities}</p>
        </Link>
        <div className={`p-5 rounded-xl border ${TILE.amber}`}>
          <div className="flex items-center gap-2 opacity-75">
            <Clock className="w-4 h-4" />
            <p className="text-xs font-medium uppercase tracking-wider">Upcoming</p>
          </div>
          <p className="text-3xl font-bold mt-2">{upcomingMatches}</p>
        </div>
        <div className={`p-5 rounded-xl border ${TILE.green}`}>
          <div className="flex items-center gap-2 opacity-75">
            <CheckCircle className="w-4 h-4" />
            <p className="text-xs font-medium uppercase tracking-wider">Completed</p>
          </div>
          <p className="text-3xl font-bold mt-2">{completedMatches}</p>
        </div>
      </div>

      {ratingProgress && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-2">
              <Star className="w-4 h-4 text-amber-500" />
              <h2 className="font-semibold text-slate-800">Rating progress</h2>
              <span className="text-sm text-slate-500">
                · {ratingProgress.match.activity.name}, {format(ratingProgress.match.date, "EEE d MMM")}
              </span>
            </div>
            <span className="text-sm font-medium text-slate-700">
              {ratingProgress.submitted.length}/{ratingProgress.total} submitted
            </span>
          </div>
          <div className="h-2 bg-slate-100 rounded-full overflow-hidden mb-4">
            <div
              className="h-full bg-amber-500"
              style={{
                width: `${ratingProgress.total ? Math.round((ratingProgress.submitted.length / ratingProgress.total) * 100) : 0}%`,
              }}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-slate-400 mb-2">
                ✅ Submitted ({ratingProgress.submitted.length})
              </p>
              <div className="flex flex-wrap gap-1.5">
                {ratingProgress.submitted.length === 0 ? (
                  <span className="text-slate-400 italic">None yet</span>
                ) : (
                  ratingProgress.submitted.map((a) => (
                    <span
                      key={a.user.id}
                      className="inline-flex px-2 py-0.5 rounded-md bg-green-50 text-green-700 text-xs"
                    >
                      {a.user.name}
                    </span>
                  ))
                )}
              </div>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-slate-400 mb-2">
                ⏳ Pending ({ratingProgress.pending.length})
              </p>
              <div className="flex flex-wrap gap-1.5">
                {ratingProgress.pending.length === 0 ? (
                  <span className="text-slate-400 italic">All done 🎉</span>
                ) : (
                  ratingProgress.pending.map((a) => (
                    <span
                      key={a.user.id}
                      className="inline-flex px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 text-xs"
                    >
                      {a.user.name}
                    </span>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <Link
          href="/admin/activities"
          className="inline-flex items-center gap-1 px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors"
        >
          Manage activities <ChevronRight className="w-4 h-4" />
        </Link>
        <Link
          href="/admin/players"
          className="inline-flex items-center gap-1 px-5 py-2.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium"
        >
          Manage players <ChevronRight className="w-4 h-4" />
        </Link>
        <Link
          href="/admin/settings"
          className="inline-flex items-center gap-1 px-5 py-2.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium"
        >
          Org settings
        </Link>
      </div>
    </div>
  );
}
