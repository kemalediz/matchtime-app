"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { Pencil, Calendar, Star, Trophy, TrendingUp } from "lucide-react";
import { updateProfile, setMyPositions } from "@/app/actions/players";

type ActivityPositions = {
  positions: string[];
  activity: { id: string; name: string; sportId: string; isActive: boolean };
};

type Profile = {
  name: string;
  email: string;
  image: string | null;
  phoneNumber: string | null;
  activityPositions: ActivityPositions[];
};

type Stats = {
  matchesPlayed: number;
  avgRating: number | null;
  momCount: number;
  attendanceRate: number;
};

export default function ProfilePage() {
  const { data: session } = useSession();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");

  // Sport positions per activity (loaded alongside profile)
  const [activitySports, setActivitySports] = useState<
    Record<string, { positions: string[]; sportName: string }>
  >({});

  useEffect(() => {
    if (!session?.user?.id) return;
    fetch(`/api/players/${session.user.id}`)
      .then((r) => r.json())
      .then((data) => {
        setProfile(data.player);
        setStats(data.stats);
        setName(data.player.name);
        setPhoneNumber(data.player.phoneNumber ?? "");
      });

    // Load the user's activities to know which positions are valid per activity
    fetch("/api/activities").then((r) => r.json()).then((activities) => {
      const map: Record<string, { positions: string[]; sportName: string }> = {};
      for (const a of activities) {
        map[a.id] = { positions: a.sport.positions, sportName: a.sport.name };
      }
      setActivitySports(map);
    });
  }, [session?.user?.id]);

  async function handleSave() {
    try {
      await updateProfile({ name, phoneNumber: phoneNumber.trim() || undefined });
      toast.success("Profile updated!");
      setProfile((prev) =>
        prev ? { ...prev, name, phoneNumber: phoneNumber.trim() || null } : prev,
      );
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function togglePosition(activityId: string, pos: string, current: string[]) {
    const next = current.includes(pos) ? current.filter((p) => p !== pos) : [...current, pos];
    if (next.length === 0) {
      toast.error("Pick at least one position");
      return;
    }
    try {
      await setMyPositions({ activityId, positions: next });
      toast.success("Positions updated");
      setProfile((prev) =>
        prev
          ? {
              ...prev,
              activityPositions: prev.activityPositions.map((ap) =>
                ap.activity.id === activityId ? { ...ap, positions: next } : ap,
              ),
            }
          : prev,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  if (!profile || !stats) {
    return <div className="p-10 text-center text-slate-400">Loading…</div>;
  }

  const activeAPs = profile.activityPositions.filter((ap) => ap.activity.isActive);

  return (
    <div className="p-6 sm:p-8 max-w-4xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-slate-800">Profile</h1>

      <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
        <div className="flex items-start gap-5">
          <div className="w-20 h-20 rounded-full bg-blue-50 text-blue-700 flex items-center justify-center text-3xl font-bold ring-4 ring-blue-100 shrink-0">
            {(profile.name ?? "?").charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            {editing ? (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Name</label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full h-11 px-3 rounded-lg border border-slate-200 text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Phone number</label>
                  <input
                    type="tel"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    placeholder="+44 7700 900000"
                    className="w-full h-11 px-3 rounded-lg border border-slate-200 text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div className="flex gap-3 pt-2">
                  <button onClick={handleSave} className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium">
                    Save changes
                  </button>
                  <button onClick={() => setEditing(false)} className="px-4 py-2 rounded-lg text-slate-700 hover:bg-slate-100 font-medium">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xl font-bold text-slate-800 truncate">{profile.name}</p>
                    <p className="text-sm text-slate-500 truncate">{profile.email}</p>
                    {profile.phoneNumber && (
                      <p className="text-sm text-slate-500 mt-0.5">{profile.phoneNumber}</p>
                    )}
                  </div>
                  <button
                    onClick={() => setEditing(true)}
                    className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-800 border border-slate-200 px-3 py-1.5 rounded-lg hover:bg-slate-50"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    Edit
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Positions per activity */}
      {activeAPs.length > 0 && (
        <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
          <h2 className="text-lg font-semibold text-slate-800 mb-1">Your positions</h2>
          <p className="text-sm text-slate-500 mb-4">
            Positions are per activity — set the roles you&apos;re willing to play for each.
          </p>
          <div className="space-y-4">
            {activeAPs.map((ap) => {
              const allPositions = activitySports[ap.activity.id]?.positions ?? [];
              const sportName = activitySports[ap.activity.id]?.sportName ?? "";
              return (
                <div key={ap.activity.id} className="border-t border-slate-100 pt-4 first:border-t-0 first:pt-0">
                  <p className="font-medium text-slate-800">{ap.activity.name}</p>
                  {sportName && <p className="text-xs text-slate-500 mb-2">{sportName}</p>}
                  <div className="flex flex-wrap gap-2 mt-2">
                    {allPositions.map((pos) => {
                      const selected = ap.positions.includes(pos);
                      return (
                        <button
                          key={pos}
                          onClick={() => togglePosition(ap.activity.id, pos, ap.positions)}
                          className={`px-3 h-9 rounded-lg border-2 text-sm font-medium transition-colors ${
                            selected
                              ? "bg-blue-600 text-white border-blue-600"
                              : "bg-white text-slate-700 border-slate-200 hover:border-blue-300 hover:bg-blue-50"
                          }`}
                        >
                          {pos}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatTile icon={<Calendar className="w-4 h-4" />} label="Matches" value={stats.matchesPlayed} color="blue" />
        <StatTile icon={<Star className="w-4 h-4" />} label="Avg rating" value={stats.avgRating != null ? stats.avgRating.toFixed(1) : "—"} color="green" />
        <StatTile icon={<Trophy className="w-4 h-4" />} label="MoM" value={stats.momCount} color="amber" />
        <StatTile icon={<TrendingUp className="w-4 h-4" />} label="Attendance" value={`${stats.attendanceRate}%`} color="purple" />
      </div>

      <Link
        href="/profile/stats"
        className="flex items-center justify-between rounded-xl bg-gradient-to-r from-blue-600 to-blue-700 text-white px-5 h-14 font-semibold shadow-sm hover:from-blue-700 hover:to-blue-800 transition-colors"
      >
        <span className="flex items-center gap-2">
          <TrendingUp className="w-5 h-5" /> View my full stats
        </span>
        <span className="text-xl">📊</span>
      </Link>
    </div>
  );
}

function StatTile({
  icon, label, value, color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  color: "blue" | "green" | "amber" | "purple";
}) {
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
