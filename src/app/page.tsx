import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getUserOrg } from "@/lib/org";
import { redirect } from "next/navigation";
import Link from "next/link";
import { format, formatDistanceToNow, isBefore } from "date-fns";
import { formatLondon } from "@/lib/london-time";
import {
  Calendar,
  Trophy,
  MapPin,
  Users,
  Clock,
  ChevronRight,
  Timer,
  Shield,
  Star,
} from "lucide-react";
import { LandingPage } from "@/components/landing/landing-page";
import { getMomSummaries } from "@/lib/mom";
import { computePlayerRating } from "@/lib/player-rating";

function getGreeting(hour: number): string {
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

const TILE = {
  blue: "bg-blue-50 text-blue-700 border-blue-200 hover:border-blue-300",
  green: "bg-green-50 text-green-700 border-green-200 hover:border-green-300",
  purple: "bg-purple-50 text-purple-700 border-purple-200 hover:border-purple-300",
  amber: "bg-amber-50 text-amber-700 border-amber-200 hover:border-amber-300",
} as const;

export default async function DashboardPage() {
  const session = await auth();
  // Signed-out visitors see the marketing landing page instead of being
  // bounced to /login. They can Sign in / Sign up from there.
  if (!session?.user?.id) return <LandingPage />;

  const user = await db.user.findUnique({ where: { id: session.user.id } });
  // First-time sign-ins (Google / email) without a verified phone go
  // through /claim, which lets them link to an existing player record
  // by phone OTP. /claim has a "skip — I'm starting a new club" link
  // back to /welcome for fresh admins. Once they've either claimed or
  // skipped, /welcome takes over to collect name + mark onboarded.
  if (!user?.onboarded) {
    redirect(user?.phoneNumber ? "/welcome" : "/claim");
  }

  const membership = await getUserOrg(session.user.id);
  if (!membership) redirect("/create-org");

  const orgId = membership.orgId;

  // Positions summary — pulled from the primary active activity for this org.
  const primaryActivity = await db.activity.findFirst({
    where: { orgId, isActive: true },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  const myPositions = primaryActivity
    ? (
        await db.playerActivityPosition.findUnique({
          where: {
            userId_activityId: { userId: session.user.id, activityId: primaryActivity.id },
          },
          select: { positions: true },
        })
      )?.positions ?? []
    : [];

  const nextMatch = await db.match.findFirst({
    where: {
      activity: { orgId },
      date: { gte: new Date() },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
    },
    orderBy: { date: "asc" },
    include: {
      activity: { include: { sport: true } },
      attendances: { where: { status: { in: ["CONFIRMED", "BENCH"] } } },
    },
  });

  const myAttendance = nextMatch
    ? await db.attendance.findUnique({
        where: { matchId_userId: { matchId: nextMatch.id, userId: session.user.id } },
      })
    : null;

  const recentMatches = await db.match.findMany({
    where: { activity: { orgId }, status: "COMPLETED", isHistorical: false },
    orderBy: { date: "desc" },
    take: 5,
    include: { activity: true },
  });
  const recentMomByMatch = await getMomSummaries(recentMatches.map((m) => m.id));

  const matchesPlayed = await db.attendance.count({
    where: {
      userId: session.user.id,
      status: "CONFIRMED",
      match: { status: "COMPLETED", isHistorical: false },
    },
  });

  // Display rating — same Bayesian blend the team balancer uses
  // (computePlayerRating). Seed acts as a prior with weight 3, so
  // ratings move smoothly from the first peer rating instead of
  // jumping at a threshold. The user.seedRating tile that was here
  // before never moved despite weeks of peer ratings flowing in.
  const myRatings = await db.rating.findMany({
    where: { playerId: session.user.id },
    orderBy: { createdAt: "desc" },
    take: 60,
    select: { score: true },
  });
  const { rating: displayRating, source: ratingSource, peerCount: myPeerCount } =
    computePlayerRating({
      seedRating: user.seedRating ?? null,
      peerRatings: myRatings.map((r) => r.score),
    });
  // "MoM wins" = matches where this user had the highest vote count
  // (ties count as a shared win for everyone tied at the top). Plain
  // count-of-matches-with-any-vote was misleading — a single sympathy
  // vote shouldn't show up as a "win".
  const myVotedMatches = await db.moMVote.groupBy({
    by: ["matchId"],
    where: { playerId: session.user.id },
    _count: { playerId: true },
  });
  const myVotedMatchIds = myVotedMatches.map((v) => v.matchId);
  const allTallies = myVotedMatchIds.length
    ? await db.moMVote.groupBy({
        by: ["matchId", "playerId"],
        where: { matchId: { in: myVotedMatchIds } },
        _count: { playerId: true },
      })
    : [];
  const topByMatch = new Map<string, number>();
  for (const t of allTallies) {
    const cur = topByMatch.get(t.matchId) ?? 0;
    if (t._count.playerId > cur) topByMatch.set(t.matchId, t._count.playerId);
  }
  let momWinsCount = 0;
  for (const v of myVotedMatches) {
    if (v._count.playerId === topByMatch.get(v.matchId)) momWinsCount += 1;
  }

  const confirmedCount = nextMatch?.attendances.filter((a) => a.status === "CONFIRMED").length ?? 0;
  const benchCount = nextMatch?.attendances.filter((a) => a.status === "BENCH").length ?? 0;
  const slotsRemaining = nextMatch ? Math.max(0, nextMatch.maxPlayers - confirmedCount) : 0;
  const deadlinePassed = nextMatch ? isBefore(nextMatch.attendanceDeadline, new Date()) : false;
  const progressPct = nextMatch
    ? Math.min(100, Math.round((confirmedCount / nextMatch.maxPlayers) * 100))
    : 0;
  const progressColor =
    nextMatch && confirmedCount >= nextMatch.maxPlayers
      ? "bg-green-500"
      : nextMatch && confirmedCount >= nextMatch.maxPlayers * 0.75
      ? "bg-blue-600"
      : "bg-amber-500";

  const greeting = getGreeting(new Date().getHours());
  const firstName = (user.name ?? "").split(" ")[0];

  const myAttendBadge = myAttendance?.status === "CONFIRMED"
    ? { label: "You're in", cls: "bg-green-100 text-green-700" }
    : myAttendance?.status === "BENCH"
    ? { label: "On bench", cls: "bg-amber-100 text-amber-700" }
    : { label: "Not signed up", cls: "bg-slate-100 text-slate-600" };

  return (
    <div className="p-6 sm:p-8 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">
          {greeting}, {firstName}
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Here&apos;s what&apos;s happening at {membership.org.name}.
        </p>
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <div className={`p-5 rounded-xl border ${TILE.blue} transition-colors`}>
          <div className="flex items-center gap-2 opacity-75">
            <Calendar className="w-4 h-4" />
            <p className="text-xs font-medium uppercase tracking-wider">Played</p>
          </div>
          <p className="text-3xl font-bold mt-2">{matchesPlayed}</p>
        </div>
        <div className={`p-5 rounded-xl border ${TILE.amber} transition-colors`}>
          <div className="flex items-center gap-2 opacity-75">
            <Trophy className="w-4 h-4" />
            <p className="text-xs font-medium uppercase tracking-wider">MoM</p>
          </div>
          <p className="text-3xl font-bold mt-2">{momWinsCount}</p>
        </div>
        <div className={`p-5 rounded-xl border ${TILE.purple} transition-colors`}>
          <div className="flex items-center gap-2 opacity-75">
            <Shield className="w-4 h-4" />
            <p className="text-xs font-medium uppercase tracking-wider">Positions</p>
          </div>
          <div className="flex gap-1.5 flex-wrap mt-2">
            {myPositions.length === 0 ? (
              <span className="text-sm opacity-60">—</span>
            ) : (
              myPositions.map((p) => (
                <span key={p} className="inline-flex px-2 py-0.5 rounded-md bg-white/70 text-xs font-semibold">
                  {p}
                </span>
              ))
            )}
          </div>
        </div>
        <div className={`p-5 rounded-xl border ${TILE.green} transition-colors`}>
          <div className="flex items-center gap-2 opacity-75">
            <Users className="w-4 h-4" />
            <p className="text-xs font-medium uppercase tracking-wider">Rating</p>
          </div>
          <p className="text-3xl font-bold mt-2">{displayRating.toFixed(1)}</p>
          <p className="text-[11px] opacity-70 mt-0.5">
            {ratingSource === "peer"
              ? `${myPeerCount} peer rating${myPeerCount === 1 ? "" : "s"}`
              : ratingSource === "blended"
              ? `blended (${myPeerCount} peer + seed)`
              : "seed · waiting for peer ratings"}
          </p>
        </div>
      </div>

      {/* Next match */}
      {nextMatch ? (
        <section className="bg-white rounded-xl border border-slate-200 shadow-sm mb-8">
          <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-800">Next match</h2>
            <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${myAttendBadge.cls}`}>
              {myAttendBadge.label}
            </span>
          </div>
          <div className="p-6 space-y-4">
            <div>
              <p className="text-lg font-semibold text-slate-800">{nextMatch.activity.name}</p>
              <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-5 mt-2 text-sm text-slate-500">
                <span className="flex items-center gap-1.5">
                  <Clock className="w-4 h-4" />
                  {formatLondon(nextMatch.date, "EEEE, d MMM yyyy 'at' HH:mm")}
                </span>
                <span className="flex items-center gap-1.5">
                  <MapPin className="w-4 h-4" />
                  {nextMatch.activity.venue}
                </span>
              </div>
            </div>

            {/* Attendance progress */}
            <div>
              <div className="flex items-center justify-between text-sm mb-1.5">
                <span className="flex items-center gap-1.5 font-medium text-slate-700">
                  <Users className="w-4 h-4 text-slate-400" />
                  {confirmedCount}/{nextMatch.maxPlayers} confirmed
                </span>
                {slotsRemaining > 0 ? (
                  <span className="text-slate-500">{slotsRemaining} slot{slotsRemaining !== 1 ? "s" : ""} left</span>
                ) : (
                  <span className="text-green-600 font-medium">
                    Full{benchCount > 0 ? ` · ${benchCount} bench` : ""}
                  </span>
                )}
              </div>
              <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                <div
                  className={`h-full ${progressColor} transition-all duration-300`}
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>

            {!deadlinePassed && (
              <div className="flex items-center gap-1.5 text-sm text-slate-500">
                <Timer className="w-4 h-4" />
                Sign-ups close {formatDistanceToNow(nextMatch.attendanceDeadline, { addSuffix: true })}
              </div>
            )}

            <div className="flex items-center gap-2">
              <span className="inline-flex px-2.5 py-1 rounded-md bg-slate-100 text-slate-700 text-xs font-medium">
                {nextMatch.activity.sport.name}
              </span>
            </div>

            <Link
              href={`/matches/${nextMatch.id}`}
              className="inline-flex items-center gap-1 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
            >
              View match <ChevronRight className="w-4 h-4" />
            </Link>
          </div>
        </section>
      ) : (
        <section className="bg-white rounded-xl border border-slate-200 shadow-sm mb-8">
          <div className="p-10 text-center text-slate-400">
            No upcoming matches scheduled.
          </div>
        </section>
      )}

      {/* Recent */}
      {recentMatches.length > 0 && (
        <section className="bg-white rounded-xl border border-slate-200 shadow-sm">
          <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-800">Recent results</h2>
            <Link href="/matches" className="text-sm text-blue-600 hover:text-blue-700 font-medium">
              View all
            </Link>
          </div>
          <div className="divide-y divide-slate-100">
            {recentMatches.map((m) => {
              const mom = recentMomByMatch.get(m.id);
              const momLabel = mom
                ? mom.topPlayers.length > 1
                  ? `${mom.topPlayers.map((p) => p.name).join(" & ")} (${mom.topCount} each, ${mom.totalVotes} votes)`
                  : `${mom.topPlayers[0].name} (${mom.topCount}/${mom.totalVotes} votes)`
                : null;
              return (
                <Link
                  key={m.id}
                  href={`/matches/${m.id}`}
                  className="flex items-center justify-between gap-3 px-6 py-4 hover:bg-slate-50 transition-colors"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-slate-800 truncate">{m.activity.name}</p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {format(m.date, "EEE, d MMM yyyy")}
                    </p>
                    {momLabel && (
                      <p className="text-xs text-slate-500 mt-1 flex items-center gap-1.5 truncate">
                        <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500 shrink-0" />
                        <span className="truncate">{momLabel}</span>
                      </p>
                    )}
                  </div>
                  {m.redScore !== null && m.yellowScore !== null && (
                    <div className="flex items-center gap-2 font-mono font-bold shrink-0">
                      <span className="text-red-500">{m.redScore}</span>
                      <span className="text-slate-300">-</span>
                      <span className="text-amber-500">{m.yellowScore}</span>
                    </div>
                  )}
                </Link>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
