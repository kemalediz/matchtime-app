import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import Link from "next/link";
import { AttendButton } from "@/components/match/attend-button";
import { AttendanceList } from "@/components/match/attendance-list";
import { AddPlayerToMatch } from "@/components/match/add-player-to-match";
import { TeamDisplay } from "@/components/match/team-display";
import { isOrgAdmin } from "@/lib/org";
import { resolveTeamLabels } from "@/lib/team-labels";
import { format } from "date-fns";
import { formatLondon } from "@/lib/london-time";
import { Calendar, MapPin, Clock, Star, ChevronRight } from "lucide-react";

export default async function MatchDetailPage({
  params,
}: {
  params: Promise<{ matchId: string }>;
}) {
  const { matchId } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const match = await db.match.findUnique({
    where: { id: matchId },
    include: {
      activity: { include: { sport: true, org: { select: { teamLabels: true } } } },
      attendances: {
        where: { status: { in: ["CONFIRMED", "BENCH"] } },
        include: {
          user: {
            include: { activityPositions: true },
          },
        },
        orderBy: { position: "asc" },
      },
      teamAssignments: {
        include: {
          user: {
            include: { activityPositions: true },
          },
        },
      },
      momVotes: true,
    },
  });
  if (!match) redirect("/matches");

  const sport = match.activity.sport;
  const [redLabel, yellowLabel] = resolveTeamLabels(match.activity.org, sport);

  // Per-activity positions for the players in this match
  const positionsFor = (u: { activityPositions: { activityId: string; positions: string[] }[] }) =>
    u.activityPositions.find((p) => p.activityId === match.activityId)?.positions ?? [];

  const myAttendance = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId: session.user.id } },
  });

  const isAdmin = await isOrgAdmin(session.user.id, match.activity.orgId);

  // Payments dashboard link — shown to an org admin OR the money collector
  // when the org collects fees. Lets them open /collect/<match> on demand
  // to see who's paid (instead of only via the post-match DM link).
  const orgPay = await db.organisation.findUnique({
    where: { id: match.activity.orgId },
    select: { paymentCollectionEnabled: true, paymentHolderId: true },
  });
  const canSeePayments =
    !!orgPay?.paymentCollectionEnabled &&
    (isAdmin || orgPay.paymentHolderId === session.user.id);

  // Existing org members not already in this match — for the admin
  // "add player" picker, so they select rather than retype (avoids dupes).
  const inMatchIds = new Set(match.attendances.map((a) => a.userId));
  const addablePlayers = isAdmin
    ? (
        await db.membership.findMany({
          where: { orgId: match.activity.orgId, leftAt: null },
          select: { user: { select: { id: true, name: true, phoneNumber: true } } },
        })
      )
        .map((m) => m.user)
        .filter((u) => u.name && !inMatchIds.has(u.id))
        .map((u) => ({ id: u.id, name: u.name as string, hasPhone: !!u.phoneNumber }))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];
  const isPastDeadline = new Date() > match.attendanceDeadline;
  const hasTeams = match.teamAssignments.length > 0;

  // Block "I'm in" on a future match while a previous scheduled
  // match in the same org is still in flight (not yet COMPLETED).
  // Mirrors the server-side guard in src/lib/attendance.ts so the
  // button is greyed out instead of throwing on click.
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const blockedByPriorMatch =
    match.date >= todayStart &&
    !!(await db.match.findFirst({
      where: {
        activity: { orgId: match.activity.orgId },
        status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
        date: { lt: todayStart },
        id: { not: matchId },
      },
      select: { id: true },
    }));

  const redTeam = match.teamAssignments
    .filter((a) => a.team === "RED")
    .map((a) => ({ ...a.user, positions: positionsFor(a.user) }));
  const yellowTeam = match.teamAssignments
    .filter((a) => a.team === "YELLOW")
    .map((a) => ({ ...a.user, positions: positionsFor(a.user) }));

  const ratingWindowEnd = new Date(
    match.date.getTime() + match.activity.ratingWindowHours * 60 * 60 * 1000,
  );
  const canRate =
    match.status === "COMPLETED" &&
    new Date() < ratingWindowEnd &&
    myAttendance?.status === "CONFIRMED";

  const existingRatings = await db.rating.count({
    where: { matchId, raterId: session.user.id },
  });

  // MoM tally — handle ties at the top explicitly. The DB's `orderBy
  // _count desc` is not deterministic when two players have the same
  // count, so we sort by name as a tiebreaker for stable display.
  const momRows =
    match.status === "COMPLETED"
      ? await db.moMVote.groupBy({
          by: ["playerId"],
          where: { matchId },
          _count: { playerId: true },
        })
      : [];
  const momPlayerIds = momRows.map((r) => r.playerId);
  const momUsers = momPlayerIds.length
    ? await db.user.findMany({
        where: { id: { in: momPlayerIds } },
        select: { id: true, name: true },
      })
    : [];
  const momUserById = new Map(momUsers.map((u) => [u.id, u.name ?? "Unknown"]));
  const momTally = momRows
    .map((r) => ({
      playerId: r.playerId,
      name: momUserById.get(r.playerId) ?? "Unknown",
      votes: r._count.playerId,
    }))
    .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));
  const momTotalVotes = momTally.reduce((s, r) => s + r.votes, 0);
  const momTopCount = momTally[0]?.votes ?? 0;
  const momTopPlayers = momTally.filter((r) => r.votes === momTopCount);
  const momOthers = momTally.filter((r) => r.votes < momTopCount);
  // Each voter casts at most one MoMVote, so vote count == voter count.
  const momConfirmedCount = match.attendances.filter((a) => a.status === "CONFIRMED").length;

  const statusLabel = match.status.replace(/_/g, " ").toLowerCase();
  const statusPill =
    match.status === "COMPLETED"
      ? "bg-green-100 text-green-700"
      : match.status === "TEAMS_PUBLISHED"
      ? "bg-blue-100 text-blue-700"
      : match.status === "TEAMS_GENERATED"
      ? "bg-amber-100 text-amber-700"
      : "bg-slate-100 text-slate-600";

  return (
    <div className="p-6 sm:p-8 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">{match.activity.name}</h1>
          <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 mt-2 text-sm text-slate-500">
            <span className="flex items-center gap-1.5">
              <Calendar className="w-4 h-4" />
              {formatLondon(match.date, "EEEE, d MMMM yyyy 'at' HH:mm")}
            </span>
            <span className="flex items-center gap-1.5">
              <MapPin className="w-4 h-4" />
              {match.activity.venue}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex px-2.5 py-1 rounded-md bg-slate-100 text-slate-600 text-xs font-medium">
            {sport.name}
          </span>
          <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-medium capitalize ${statusPill}`}>
            {statusLabel}
          </span>
        </div>
      </div>

      {/* Score */}
      {match.status === "COMPLETED" && match.redScore !== null && match.yellowScore !== null && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm py-8 text-center">
          <div className="flex items-center justify-center gap-8 text-5xl font-bold">
            <span className="text-red-500">{match.redScore}</span>
            <span className="text-slate-300 text-3xl">-</span>
            <span className="text-amber-500">{match.yellowScore}</span>
          </div>
          {momTopCount > 0 && (
            <div className="mt-4 space-y-1">
              <p className="text-sm text-slate-500 flex items-center justify-center gap-1.5 flex-wrap">
                <Star className="w-4 h-4 text-amber-500 fill-amber-500" />
                {sport.mvpLabel}:{" "}
                {momTopPlayers.length > 1 ? (
                  <>
                    <span className="font-semibold text-slate-800">
                      shared between{" "}
                      {momTopPlayers
                        .map((p) => p.name)
                        .reduce<React.ReactNode[]>((acc, n, i, arr) => {
                          if (i === 0) return [n];
                          if (i === arr.length - 1) return [...acc, " and ", n];
                          return [...acc, ", ", n];
                        }, [])}
                    </span>
                    <span className="text-slate-400">
                      ({momTopCount} vote{momTopCount === 1 ? "" : "s"} each)
                    </span>
                  </>
                ) : (
                  <>
                    <span className="font-semibold text-slate-800">{momTopPlayers[0].name}</span>
                    <span className="text-slate-400">
                      ({momTopCount} of {momTotalVotes} vote{momTotalVotes === 1 ? "" : "s"})
                    </span>
                  </>
                )}
              </p>
              {momOthers.length > 0 && (
                <p className="text-xs text-slate-400">
                  Also received votes:{" "}
                  {momOthers.map((p, i) => (
                    <span key={p.playerId}>
                      {i > 0 && ", "}
                      {p.name} ({p.votes})
                    </span>
                  ))}
                </p>
              )}
              {momConfirmedCount > 0 && (
                <p className="text-xs text-slate-400">
                  {momTotalVotes} of {momConfirmedCount} player{momConfirmedCount === 1 ? "" : "s"} voted
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Attend button */}
      {match.status === "UPCOMING" && (
        <div className="flex items-center gap-4 flex-wrap">
          <AttendButton
            matchId={matchId}
            currentStatus={myAttendance?.status as "CONFIRMED" | "BENCH" | "DROPPED" | null}
            isPastDeadline={isPastDeadline}
            blockedByPriorMatch={blockedByPriorMatch}
          />
          {!isPastDeadline && (
            <p className="text-sm text-slate-500 flex items-center gap-1.5">
              <Clock className="w-4 h-4" />
              Deadline: {formatLondon(match.attendanceDeadline, "EEE d MMM, HH:mm")}
            </p>
          )}
        </div>
      )}

      {/* Teams */}
      {hasTeams && (
        <section>
          <h2 className="text-lg font-semibold text-slate-800 mb-4">Teams</h2>
          <TeamDisplay
            redTeam={redTeam}
            yellowTeam={yellowTeam}
            redScore={match.redScore}
            yellowScore={match.yellowScore}
            redLabel={redLabel}
            yellowLabel={yellowLabel}
          />
        </section>
      )}

      {/* Attendance list */}
      <section className="bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="px-6 py-4 border-b border-slate-100">
          <h2 className="text-lg font-semibold text-slate-800">Attendance</h2>
        </div>
        <div className="p-6 space-y-4">
          {isAdmin && <AddPlayerToMatch matchId={matchId} existingPlayers={addablePlayers} />}
          <AttendanceList
            attendances={match.attendances.map((a) => ({
              ...a,
              user: { ...a.user, positions: positionsFor(a.user) },
            }))}
            maxPlayers={match.maxPlayers}
            admin={isAdmin}
            matchId={matchId}
          />
        </div>
      </section>

      {/* Actions */}
      <div className="flex flex-wrap gap-3">
        {canSeePayments && (
          <Link
            href={`/collect/${matchId}`}
            className="inline-flex items-center gap-1 px-5 py-2.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium"
          >
            Payments · who&apos;s paid
            <ChevronRight className="w-4 h-4" />
          </Link>
        )}
        {canRate && (
          <Link
            href={`/matches/${matchId}/rate`}
            className="inline-flex items-center gap-1 px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors"
          >
            {existingRatings > 0 ? "Update ratings" : "Rate players & vote MoM"}
            <ChevronRight className="w-4 h-4" />
          </Link>
        )}
        {isAdmin && match.status === "UPCOMING" && isPastDeadline && (
          <Link
            href={`/admin/matches/${matchId}/teams`}
            className="inline-flex items-center gap-1 px-5 py-2.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium"
          >
            Generate teams
          </Link>
        )}
        {isAdmin && (match.status === "TEAMS_GENERATED" || match.status === "TEAMS_PUBLISHED") && (
          <Link
            href={`/admin/matches/${matchId}/teams`}
            className="inline-flex items-center gap-1 px-5 py-2.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium"
          >
            Manage teams
          </Link>
        )}
        {isAdmin &&
          (match.status === "UPCOMING" ||
            match.status === "TEAMS_GENERATED" ||
            match.status === "TEAMS_PUBLISHED") && (
            <Link
              href={`/admin/matches/${matchId}/switch-format`}
              className="inline-flex items-center gap-1 px-5 py-2.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium"
            >
              Switch format
            </Link>
          )}
      </div>
    </div>
  );
}
