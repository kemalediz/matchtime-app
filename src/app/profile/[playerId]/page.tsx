"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Calendar, Star, Trophy, TrendingUp } from "lucide-react";

interface Data {
  player: {
    id: string;
    name: string;
    email: string;
    image: string | null;
    positions: string[];
    role: string;
  };
  stats: {
    matchesPlayed: number;
    avgRating: number | null;
    momCount: number;
    attendanceRate: number;
  };
}

export default function PlayerProfilePage() {
  const { playerId } = useParams<{ playerId: string }>();
  const [data, setData] = useState<Data | null>(null);

  useEffect(() => {
    fetch(`/api/players/${playerId}`).then((r) => r.json()).then(setData);
  }, [playerId]);

  if (!data) return <div className="p-10 text-center text-slate-400">Loading…</div>;
  const { player, stats } = data;

  return (
    <div className="p-6 sm:p-8 max-w-4xl mx-auto space-y-6">
      <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
        <div className="flex items-center gap-5">
          <div className="w-20 h-20 rounded-full bg-blue-50 text-blue-700 flex items-center justify-center text-3xl font-bold ring-4 ring-blue-100 shrink-0">
            {(player.name ?? "?").charAt(0).toUpperCase()}
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-800">{player.name}</h1>
            <div className="flex items-center gap-1.5 mt-2">
              {player.positions.map((pos) => (
                <span key={pos} className="inline-flex px-2 py-1 rounded-md bg-slate-100 text-slate-700 text-xs font-semibold">
                  {pos}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Tile icon={<Calendar className="w-4 h-4" />} label="Matches" value={stats.matchesPlayed} color="blue" />
        <Tile icon={<Star className="w-4 h-4" />} label="Avg rating" value={stats.avgRating != null ? stats.avgRating.toFixed(1) : "-"} color="green" />
        <Tile icon={<Trophy className="w-4 h-4" />} label="MoM" value={stats.momCount} color="amber" />
        <Tile icon={<TrendingUp className="w-4 h-4" />} label="Attendance" value={`${stats.attendanceRate}%`} color="purple" />
      </div>
    </div>
  );
}

function Tile({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string | number; color: "blue" | "green" | "amber" | "purple" }) {
  const cls = {
    blue: "bg-blue-50 text-blue-700 border-blue-200",
    green: "bg-green-50 text-green-700 border-green-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    purple: "bg-purple-50 text-purple-700 border-purple-200",
  }[color];
  return (
    <div className={`p-5 rounded-xl border ${cls}`}>
      <div className="flex items-center gap-2 opacity-75">
        {icon}
        <p className="text-xs font-medium uppercase tracking-wider">{label}</p>
      </div>
      <p className="text-3xl font-bold mt-2">{value}</p>
    </div>
  );
}
