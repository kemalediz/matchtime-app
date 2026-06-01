import { auth } from "@/lib/auth";
import { getUserOrg } from "@/lib/org";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Share2 } from "lucide-react";
import { loadPlayerSeasonStats } from "@/lib/player-stats";
import { RatingTimeline } from "@/components/stats/rating-timeline";

export const dynamic = "force-dynamic";

export default async function MyStatsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const membership = await getUserOrg(session.user.id);
  if (!membership) redirect("/create-org");

  const stats = await loadPlayerSeasonStats(membership.orgId, session.user.id);
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
          <Tile
            big={`${stats.record.w}-${stats.record.d}-${stats.record.l}`}
            label="W–D–L"
            sub={`GD ${stats.goalDiff >= 0 ? "+" : ""}${stats.goalDiff}`}
            tone="slate"
          />
        </div>

        {/* Form */}
        <div className="mt-4 rounded-2xl bg-white border border-slate-200 p-4 flex items-center justify-between">
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-400">Current form</div>
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
          <div className="text-sm font-semibold text-slate-800 mb-1">Ratings over time</div>
          <p className="text-[11px] text-slate-400 mb-2">Tap a point for that game&apos;s detail.</p>
          <RatingTimeline data={stats.timeline} />
        </div>

        {/* Chemistry */}
        {(stats.chemistry.bestByWinRate || stats.chemistry.bestByRating) && (
          <div className="mt-4 rounded-2xl bg-white border border-slate-200 p-4">
            <div className="text-sm font-semibold text-slate-800 mb-3">Chemistry</div>
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

        {/* Badges */}
        <div className="mt-4 rounded-2xl bg-white border border-slate-200 p-4">
          <div className="text-sm font-semibold text-slate-800 mb-3">
            Badges{" "}
            <span className="text-slate-400 font-normal">
              ({earnedBadges.length}/{stats.badges.length})
            </span>
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
