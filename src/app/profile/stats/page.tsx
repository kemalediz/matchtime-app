import { auth } from "@/lib/auth";
import { getUserOrg } from "@/lib/org";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Share2 } from "lucide-react";
import {
  loadPlayerSeasonStats,
  loadRatingLeaderboard,
  loadTeamOfSeason,
  loadAllClubsOverview,
} from "@/lib/player-stats";
import { RatingTimeline } from "@/components/stats/rating-timeline";
import { InfoButton } from "@/components/stats/info-button";

export const dynamic = "force-dynamic";

export default async function MyStatsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const membership = await getUserOrg(session.user.id);
  if (!membership) redirect("/create-org");

  const meId = session.user.id;
  const [stats, leaderboard, tots, allClubs] = await Promise.all([
    loadPlayerSeasonStats(membership.orgId, meId),
    loadRatingLeaderboard(membership.orgId, { minGames: 2, limit: 12 }),
    loadTeamOfSeason(membership.orgId, { minGames: 2 }),
    loadAllClubsOverview(meId),
  ]);
  if (!stats) redirect("/profile");

  const earnedBadges = stats.badges.filter((b) => b.earned);
  const vsField = stats.vsFieldPct;
  const firstName = stats.player.name?.split(" ")[0] ?? "You";

  return (
    <div className="min-h-screen bg-slate-50 pb-16">
      <div className="max-w-md mx-auto px-4 pt-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <Link href="/profile" className="inline-flex items-center gap-1 text-sm text-slate-500">
            <ArrowLeft className="w-4 h-4" /> Profile
          </Link>
          <a
            href={`/api/wrapped/${stats.player.id}?org=${stats.orgId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-600"
          >
            <Share2 className="w-4 h-4" /> Share card
          </a>
        </div>

        <h1 className="mt-3 text-2xl font-bold text-slate-900">{firstName}&apos;s season</h1>
        <p className="text-sm text-slate-500">{stats.orgName} · since launch</p>

        {/* All clubs overview — only when they play for more than one. The
            club-specific sections below stay scoped to {stats.orgName}. */}
        {allClubs.clubCount > 1 && (
          <div className="mt-4 rounded-2xl border border-indigo-200 bg-gradient-to-br from-indigo-50 to-blue-50 p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-indigo-900 flex items-center gap-1.5">
                🌍 Across all your clubs
              </p>
              <InfoButton title="Across all your clubs">
                <p>
                  Combined totals from every club you play for ({allClubs.clubCount}).
                  One profile follows your phone number across groups, so your
                  games, MoMs and ratings add up everywhere you play.
                </p>
                <p>
                  Each club rates on its own scale, so the blended average is
                  indicative — the per-club breakdown is the precise picture.
                  The leaderboard, Team of the Season and rivalries below stay
                  specific to {stats.orgName}.
                </p>
              </InfoButton>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-2xl font-extrabold text-slate-900">{allClubs.totalGames}</p>
                <p className="text-[11px] text-slate-500">Games</p>
              </div>
              <div>
                <p className="text-2xl font-extrabold text-slate-900">{allClubs.totalMom}</p>
                <p className="text-[11px] text-slate-500">🏆 MoM</p>
              </div>
              <div>
                <p className="text-2xl font-extrabold text-slate-900">
                  {allClubs.overallAvg !== null ? allClubs.overallAvg.toFixed(1) : "—"}
                </p>
                <p className="text-[11px] text-slate-500">Avg rating</p>
              </div>
            </div>
            <div className="mt-3 space-y-1.5">
              {allClubs.clubs.map((c) => (
                <div
                  key={c.orgId}
                  className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm ${
                    c.orgId === stats.orgId ? "bg-white/80 ring-1 ring-indigo-200" : "bg-white/50"
                  }`}
                >
                  <span className="font-medium text-slate-700 truncate">{c.orgName}</span>
                  <span className="flex items-center gap-3 text-xs text-slate-500 shrink-0">
                    <span>{c.games} games</span>
                    {c.momCount > 0 && <span>{c.momCount}🏆</span>}
                    <span className="font-semibold text-slate-700">
                      {c.avgRating !== null ? c.avgRating.toFixed(1) : "—"}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Headline tiles */}
        <div className="grid grid-cols-2 gap-3 mt-4">
          <Tile
            big={stats.avgRating?.toFixed(1) ?? "—"}
            label="Avg rating"
            sub={
              vsField !== null
                ? `${vsField >= 0 ? "+" : ""}${vsField.toFixed(0)}% vs squad`
                : undefined
            }
            tone={vsField !== null && vsField >= 0 ? "green" : "slate"}
          />
          <Tile big={`${stats.momCount}`} label="Man of the Match" tone="amber" sub={stats.momCount > 0 ? "👑" : undefined} />
          <Tile
            big={`${stats.gamesPlayed}`}
            label="Games played"
            sub={`${stats.attendanceRate}% attendance`}
            tone="blue"
          />
          {stats.tracksResults ? (
            <Tile
              big={`${stats.record.w}-${stats.record.d}-${stats.record.l}`}
              label="W–D–L"
              sub={`GD ${stats.goalDiff >= 0 ? "+" : ""}${stats.goalDiff}`}
              tone="slate"
            />
          ) : (
            <Tile
              big={stats.bestGame ? stats.bestGame.avg.toFixed(1) : "—"}
              label="Best game"
              sub={stats.bestGame ? stats.bestGame.label : undefined}
              tone="slate"
            />
          )}
        </div>

        {/* Form */}
        <div className="mt-4 rounded-2xl bg-white border border-slate-200 p-4 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-1.5">
              <div className="text-xs uppercase tracking-wider text-slate-400">Current form</div>
              <InfoButton title="Current form">
                <p>
                  Your average rating across your last 5 rated games, and which way it&apos;s
                  trending.
                </p>
                <p>
                  🔥 <b>On fire</b> = climbing · ❄️ <b>Cold spell</b> = dipping · ➡️ <b>Steady</b> =
                  holding level.
                </p>
              </InfoButton>
            </div>
            <div className="text-lg font-semibold text-slate-800">
              {stats.form.trend === "hot" && "🔥 On fire"}
              {stats.form.trend === "cold" && "❄️ Cold spell"}
              {stats.form.trend === "steady" && "➡️ Steady"}
            </div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold text-slate-900">
              {stats.form.last5Avg?.toFixed(1) ?? "—"}
            </div>
            <div className="text-[11px] text-slate-400">last 5 games</div>
          </div>
        </div>

        {/* Timeline chart */}
        <div className="mt-4 rounded-2xl bg-white border border-slate-200 p-4">
          <div className="flex items-center gap-1.5 mb-1">
            <div className="text-sm font-semibold text-slate-800">Ratings over time</div>
            <InfoButton title="Ratings over time">
              <p>
                After every match, your teammates rate each player out of 10. The blue line is
                your average rating per game; the dashed grey line is the whole squad&apos;s average
                that game — so you can see when you played above or below the group.
              </p>
              <p>👑 marks games where you won Man of the Match. Tap any point to see that game&apos;s score, your rating, and how many people rated you.</p>
            </InfoButton>
          </div>
          <p className="text-[11px] text-slate-400 mb-2">Tap a point for that game&apos;s detail.</p>
          <RatingTimeline data={stats.timeline} />
        </div>

        {/* Chemistry */}
        {(stats.chemistry.bestByWinRate || stats.chemistry.bestByRating) && (
          <div className="mt-4 rounded-2xl bg-white border border-slate-200 p-4">
            <div className="flex items-center gap-1.5 mb-3">
              <div className="text-sm font-semibold text-slate-800">Chemistry</div>
              <InfoButton title="Chemistry">
                <p>
                  Who you click with on the pitch. We look at games where you were on the
                  <b> same team</b> as someone.
                </p>
                <p>
                  <b>Best partnership</b> = the teammate your team wins with most often.
                  <br />
                  <b>You play your best with</b> = the teammate alongside whom your own ratings
                  are highest.
                </p>
                <p className="text-slate-400">Needs at least 2 games together to count.</p>
              </InfoButton>
            </div>
            <div className="space-y-3">
              {stats.chemistry.bestByWinRate && (
                <ChemRow
                  emoji="🤝"
                  title="Best partnership"
                  name={stats.chemistry.bestByWinRate.name}
                  detail={`${Math.round(stats.chemistry.bestByWinRate.winRate * 100)}% win rate together · ${stats.chemistry.bestByWinRate.gamesTogether} games`}
                />
              )}
              {stats.chemistry.bestByRating &&
                stats.chemistry.bestByRating.userId !== stats.chemistry.bestByWinRate?.userId && (
                  <ChemRow
                    emoji="⭐"
                    title="You play your best with"
                    name={stats.chemistry.bestByRating.name}
                    detail={`You average ${stats.chemistry.bestByRating.myAvgWith?.toFixed(1)} alongside them`}
                  />
                )}
            </div>
          </div>
        )}

        {/* Rivalry */}
        {(stats.rivalry.nemesis || stats.rivalry.bestVictim) && (
          <div className="mt-4 rounded-2xl bg-white border border-slate-200 p-4">
            <div className="flex items-center gap-1.5 mb-3">
              <div className="text-sm font-semibold text-slate-800">Rivalries</div>
              <InfoButton title="Rivalries">
                <p>
                  The flip side of chemistry — how you do against people on the <b>opposing</b>{" "}
                  team.
                </p>
                <p>
                  <b>Nemesis</b> = the opponent who beats you most often.
                  <br />
                  <b>You own</b> = the opponent you beat most often.
                </p>
                <p className="text-slate-400">Needs at least 2 head-to-heads to count.</p>
              </InfoButton>
            </div>
            <div className="space-y-3">
              {stats.rivalry.nemesis && (
                <ChemRow
                  emoji="😤"
                  title="Your nemesis"
                  name={stats.rivalry.nemesis.name}
                  detail={`You've won ${stats.rivalry.nemesis.wins} of ${stats.rivalry.nemesis.gamesAgainst} when they're against you`}
                />
              )}
              {stats.rivalry.bestVictim && (
                <ChemRow
                  emoji="😎"
                  title="You own"
                  name={stats.rivalry.bestVictim.name}
                  detail={`${stats.rivalry.bestVictim.wins} wins from ${stats.rivalry.bestVictim.gamesAgainst} head-to-heads`}
                />
              )}
            </div>
          </div>
        )}

        {/* Rating leaderboard with movement arrows */}
        {leaderboard.length > 0 && (
          <div className="mt-4 rounded-2xl bg-white border border-slate-200 p-4">
            <div className="flex items-center gap-1.5 mb-3">
              <div className="text-sm font-semibold text-slate-800">Squad leaderboard</div>
              <InfoButton title="Squad leaderboard">
                <p>Everyone ranked by their average rating this season.</p>
                <p>
                  The arrow shows how each player moved since last week&apos;s match:{" "}
                  <span className="text-emerald-600 font-semibold">↑</span> climbed,{" "}
                  <span className="text-red-500 font-semibold">↓</span> dropped,{" "}
                  <span className="text-slate-400 font-semibold">▬</span> no change.
                </p>
                <p className="text-slate-400">Players need at least 2 games to appear.</p>
              </InfoButton>
            </div>
            <div className="space-y-1">
              {leaderboard.map((r) => {
                const isMe = r.userId === meId;
                return (
                  <div
                    key={r.userId}
                    className={`flex items-center gap-3 rounded-lg px-2 py-1.5 ${
                      isMe ? "bg-blue-50" : ""
                    }`}
                  >
                    <span className="w-5 text-sm font-semibold text-slate-500 text-right">
                      {r.rank}
                    </span>
                    <span
                      className={`flex-1 text-sm truncate ${
                        isMe ? "font-bold text-blue-700" : "text-slate-700"
                      }`}
                    >
                      {r.name}
                      {isMe && " (you)"}
                    </span>
                    <Movement delta={r.delta} />
                    <span className="w-10 text-right text-sm font-semibold text-slate-800">
                      {r.avg.toFixed(1)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Team of the Season */}
        {tots && tots.formation.length > 0 && (
          <div className="mt-4 rounded-2xl bg-gradient-to-b from-emerald-700 to-emerald-800 text-white p-4">
            <div className="flex items-center gap-1.5 mb-3">
              <div className="text-sm font-semibold">⚽ Team of the Season</div>
              <span className="[&_svg]:text-emerald-200">
                <InfoButton title="Team of the Season">
                  <p>
                    The best line-up of the season so far — the highest season-average-rated player
                    in each position ({tots.sportName}).
                  </p>
                  <p className="text-slate-400">Players need at least 2 games to be eligible.</p>
                </InfoButton>
              </span>
            </div>
            <div className="space-y-1.5">
              {tots.formation.map((slot, i) => (
                <div key={i} className="flex items-center gap-3">
                  <span className="w-10 text-[11px] font-semibold text-emerald-200">
                    {slot.position}
                  </span>
                  <span className="flex-1 text-sm font-medium truncate">
                    {slot.name}
                    {slot.userId === meId && " (you)"}
                  </span>
                  <span className="text-sm font-bold">{slot.avg.toFixed(1)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Badges */}
        <div className="mt-4 rounded-2xl bg-white border border-slate-200 p-4">
          <div className="flex items-center gap-1.5 mb-3">
            <div className="text-sm font-semibold text-slate-800">
              Badges{" "}
              <span className="text-slate-400 font-normal">
                ({earnedBadges.length}/{stats.badges.length})
              </span>
            </div>
            <InfoButton title="Badges">
              <p>Milestones you unlock as you play. Greyed-out ones are still to earn.</p>
              <p className="text-slate-400">
                e.g. Iron Man = played every match · MoM Machine = 3+ Man-of-the-Match awards ·
                Masterclass = averaged 9+ in a game.
              </p>
            </InfoButton>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {stats.badges.map((b) => (
              <div
                key={b.key}
                className={`flex items-center gap-2 rounded-xl border p-2.5 ${
                  b.earned
                    ? "bg-amber-50 border-amber-200"
                    : "bg-slate-50 border-slate-200 opacity-50"
                }`}
              >
                <span className={`text-xl ${b.earned ? "" : "grayscale"}`}>{b.emoji}</span>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-800 truncate">{b.label}</div>
                  <div className="text-[10px] text-slate-400 leading-tight">{b.hint}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {stats.bestGame && (
          <p className="mt-4 text-center text-xs text-slate-400">
            Best game: {stats.bestGame.label} — averaged {stats.bestGame.avg.toFixed(1)} ⭐
          </p>
        )}
      </div>
    </div>
  );
}

function Tile({
  big,
  label,
  sub,
  tone,
}: {
  big: string;
  label: string;
  sub?: string;
  tone: "green" | "amber" | "blue" | "slate";
}) {
  const toneCls: Record<string, string> = {
    green: "text-emerald-600",
    amber: "text-amber-500",
    blue: "text-blue-600",
    slate: "text-slate-800",
  };
  return (
    <div className="rounded-2xl bg-white border border-slate-200 p-4">
      <div className={`text-3xl font-bold ${toneCls[tone]}`}>{big}</div>
      <div className="text-xs text-slate-500 mt-1">{label}</div>
      {sub && <div className="text-[11px] text-slate-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function Movement({ delta }: { delta: number | null }) {
  if (delta === null)
    return <span className="text-[11px] text-blue-500 w-8 text-center">new</span>;
  if (delta === 0) return <span className="text-slate-300 w-8 text-center">▬</span>;
  if (delta > 0)
    return <span className="text-emerald-600 text-xs font-semibold w-8 text-center">↑{delta}</span>;
  return <span className="text-red-500 text-xs font-semibold w-8 text-center">↓{-delta}</span>;
}

function ChemRow({
  emoji,
  title,
  name,
  detail,
}: {
  emoji: string;
  title: string;
  name: string;
  detail: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-2xl">{emoji}</span>
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wider text-slate-400">{title}</div>
        <div className="text-sm font-semibold text-slate-800">{name}</div>
        <div className="text-xs text-slate-500">{detail}</div>
      </div>
    </div>
  );
}
