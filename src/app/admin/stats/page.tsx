/**
 * The admin "Player leaderboard".
 *
 * Follows the same three-month inactivity rule as every other ranked
 * table (`ranked-table-activity.ts`) — but this surface solves the
 * disclosure problem differently from the others, because its reader is
 * different. A player reading `/profile/stats` is a SUBJECT of the table
 * and needs to know why he is missing. The owner reading this page is an
 * OPERATOR and needs the opposite: he runs the club, and "who has
 * drifted away" is information he actively wants, not noise to hide.
 *
 * So nothing is concealed here. The ranked table is filtered, and every
 * player it removed is listed underneath it with the date he last
 * played. That makes this the one screen where "where did X go?" is
 * answered before it is asked.
 */
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getUserOrg } from "@/lib/org";
import { redirect } from "next/navigation";
import { Trophy, Star } from "lucide-react";
import {
  RANKED_TABLE_INACTIVE_AFTER_MONTHS,
  buildRankedRoster,
  loadLastPlayedByUser,
  formatLastPlayed,
} from "@/lib/ranked-table-activity";

export default async function StatsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const membership = await getUserOrg(session.user.id);
  if (!membership) redirect("/create-org");

  const orgId = membership.orgId;

  const players = await db.user.findMany({
    where: { memberships: { some: { orgId } } },
    include: {
      ratingsReceived: {
        where: { match: { activity: { orgId } } },
        orderBy: { createdAt: "desc" },
        take: 60,
      },
      momVotesReceived: { where: { match: { activity: { orgId } } } },
      attendances: {
        where: { status: "CONFIRMED", match: { status: "COMPLETED", activity: { orgId } } },
      },
    },
  });

  const roster = buildRankedRoster(await loadLastPlayedByUser(db, orgId));

  const allWhoPlayed = players
    .map((p) => ({
      ...p,
      avgRating:
        p.ratingsReceived.length > 0
          ? p.ratingsReceived.reduce((sum, r) => sum + r.score, 0) / p.ratingsReceived.length
          : null,
      matchesPlayed: p.attendances.length,
      momVotes: p.momVotesReceived.length,
    }))
    .filter((p) => p.matchesPlayed > 0)
    .sort((a, b) => (b.avgRating ?? 0) - (a.avgRating ?? 0));

  const playerStats = allWhoPlayed.filter((p) => roster.isRanked(p.id));
  // Longest-absent first: the order the owner would chase them in.
  const inactive = allWhoPlayed
    .filter((p) => !roster.isRanked(p.id))
    .sort(
      (a, b) =>
        (roster.lastPlayed(a.id)?.getTime() ?? 0) - (roster.lastPlayed(b.id)?.getTime() ?? 0),
    );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-800">Player leaderboard</h2>
        <p className="mt-1 text-sm text-slate-500">
          Players who have played in the last {RANKED_TABLE_INACTIVE_AFTER_MONTHS} months.
          {inactive.length > 0 && " Everyone else is listed below, with their ratings intact."}
        </p>
      </div>

      {playerStats.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center text-slate-400">
          No stats yet — come back after your first completed match.
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm divide-y divide-slate-100">
          {playerStats.map((player, i) => (
            <div key={player.id} className="flex items-center gap-4 px-6 py-4">
              <span className={`w-10 text-center font-bold ${i === 0 ? "text-amber-500" : "text-slate-400"}`}>
                {i === 0 ? <Trophy className="w-6 h-6 mx-auto" /> : i + 1}
              </span>
              <div className="w-10 h-10 rounded-full bg-blue-50 text-blue-700 flex items-center justify-center text-sm font-semibold shrink-0">
                {(player.name ?? "?").charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-slate-800 truncate">{player.name}</p>
                <div className="flex items-center gap-1.5 mt-0.5 text-xs text-slate-500">
                  <span>{player.matchesPlayed} matches</span>
                </div>
              </div>
              <div className="text-right">
                <p className="text-xl font-bold text-slate-800">
                  {player.avgRating != null ? player.avgRating.toFixed(1) : "—"}
                </p>
                <p className="text-xs text-slate-500 flex items-center justify-end gap-1 mt-0.5">
                  <Star className="w-3 h-3" /> {player.momVotes} MoM
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Not ranked, not deleted. Every figure here is the player's real
          one — the inactivity rule removes rows from the table, it never
          touches a rating. If any of these men plays once, he is back in
          the list above at exactly the number shown here. */}
      {inactive.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-slate-600">
            Not ranked — no game in {RANKED_TABLE_INACTIVE_AFTER_MONTHS} months (
            {inactive.length})
          </h3>
          <p className="mt-1 text-xs text-slate-400">
            Their ratings are unchanged and their history is kept. One game back and they
            rejoin the table above at the same number.
          </p>
          <div className="mt-3 bg-white rounded-xl border border-slate-200 shadow-sm divide-y divide-slate-100">
            {inactive.map((player) => {
              const last = roster.lastPlayed(player.id);
              return (
                <div key={player.id} className="flex items-center gap-4 px-6 py-3">
                  <div className="w-10 h-10 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center text-sm font-semibold shrink-0">
                    {(player.name ?? "?").charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-slate-500 truncate">{player.name}</p>
                    <p className="mt-0.5 text-xs text-slate-400">
                      {player.matchesPlayed} matches · last played{" "}
                      {last ? formatLastPlayed(last) : "never"}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-semibold text-slate-400">
                      {player.avgRating != null ? player.avgRating.toFixed(1) : "—"}
                    </p>
                    <p className="text-xs text-slate-400 flex items-center justify-end gap-1 mt-0.5">
                      <Star className="w-3 h-3" /> {player.momVotes} MoM
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
