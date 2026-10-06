"use client";

/**
 * Admin: override player positions on a per-activity basis.
 *
 * Positions are always scoped to a specific activity (a player's football
 * positions differ from their basketball positions). The page has an
 * activity picker at the top — default is the primary active activity.
 * Toggling a chip autosaves via setPlayerPositions; each row shows its own
 * save status.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  AlertCircle,
  Loader2,
  Shield,
} from "lucide-react";
import { setPlayerPositions } from "@/app/actions/players";

interface Player {
  id: string;
  name: string | null;
  email: string;
  isActive: boolean;
  positions: string[]; // for the currently-selected activity
  _count: { attendances: number };
}

interface ActivityWithSport {
  id: string;
  name: string;
  isActive: boolean;
  sport: { id: string; name: string; positions: string[] };
}

type RowState = "idle" | "saving" | "saved" | "error";

export default function BulkPositionsPage() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [activities, setActivities] = useState<ActivityWithSport[]>([]);
  const [activityId, setActivityId] = useState<string>("");
  const [loadingPlayers, setLoadingPlayers] = useState(true);
  const [filter, setFilter] = useState<"active" | "all">("active");
  const [search, setSearch] = useState("");

  // Per-row save state
  const [states, setStates] = useState<Record<string, RowState>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch("/api/activities")
      .then((r) => r.json())
      .then((acts: ActivityWithSport[]) => {
        setActivities(acts);
        const def = acts.find((a) => a.isActive) ?? acts[0];
        if (def) setActivityId(def.id);
      });
  }, []);

  useEffect(() => {
    if (!activityId) return;
    setLoadingPlayers(true);
    fetch(`/api/players?activityId=${encodeURIComponent(activityId)}`)
      .then((r) => r.json())
      .then((data: { players: Player[] }) => {
        setPlayers(data.players ?? []);
        setStates({});
        setErrors({});
      })
      .finally(() => setLoadingPlayers(false));
  }, [activityId]);

  const selectedActivity = activities.find((a) => a.id === activityId);
  const allPositions = selectedActivity?.sport.positions ?? [];

  async function togglePosition(userId: string, pos: string, current: string[]) {
    if (!activityId) return;
    const next = current.includes(pos)
      ? current.filter((p) => p !== pos)
      : [...current, pos];
    if (next.length === 0) {
      setStates((s) => ({ ...s, [userId]: "error" }));
      setErrors((e) => ({ ...e, [userId]: "Pick at least one position" }));
      return;
    }

    // Optimistically update local state — snap back on error.
    const previous = current;
    setPlayers((ps) => ps.map((p) => (p.id === userId ? { ...p, positions: next } : p)));
    setStates((s) => ({ ...s, [userId]: "saving" }));
    setErrors((e) => {
      const { [userId]: _drop, ...rest } = e;
      return rest;
    });

    try {
      const result = await setPlayerPositions(userId, activityId, next);
      setPlayers((ps) =>
        ps.map((p) => (p.id === userId ? { ...p, positions: result.positions } : p)),
      );
      setStates((s) => ({ ...s, [userId]: "saved" }));
      setTimeout(() => {
        setStates((s) => (s[userId] === "saved" ? { ...s, [userId]: "idle" } : s));
      }, 1500);
    } catch (err) {
      setPlayers((ps) => ps.map((p) => (p.id === userId ? { ...p, positions: previous } : p)));
      setStates((s) => ({ ...s, [userId]: "error" }));
      setErrors((e) => ({
        ...e,
        [userId]: err instanceof Error ? err.message : "Save failed",
      }));
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return players.filter((p) => {
      if (filter === "active" && !p.isActive) return false;
      if (!q) return true;
      return (p.name ?? "").toLowerCase().includes(q) || p.email.toLowerCase().includes(q);
    });
  }, [players, filter, search]);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/players"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-2"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to players
        </Link>
        <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
          <Shield className="w-5 h-5 text-slate-500" />
          Override player positions
        </h2>
        <p className="text-sm text-slate-500 mt-1">
          Positions are per activity. Toggle a chip to add or remove (autosaves).
        </p>
      </div>

      {/* Activity picker */}
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="flex-1 sm:max-w-xs">
          <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1.5">
            Activity
          </label>
          <select
            value={activityId}
            onChange={(e) => setActivityId(e.target.value)}
            className="w-full h-11 px-3 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {activities.length === 0 && <option value="">(no activities)</option>}
            {activities.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}{a.isActive ? "" : " (inactive)"} · {a.sport.name}
              </option>
            ))}
          </select>
          {selectedActivity && (
            <p className="text-xs text-slate-400 mt-1">
              Sport: {selectedActivity.sport.name} · Positions:{" "}
              {allPositions.join(", ") || "(none defined)"}
            </p>
          )}
        </div>

        <div className="flex gap-1 p-1 bg-slate-100 rounded-lg w-fit self-start">
          {(["active", "all"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium capitalize transition-colors ${
                filter === f
                  ? "bg-white text-slate-800 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {f === "active" ? "Active" : "All"}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
          className="flex-1 sm:max-w-xs h-11 px-3 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* Players */}
      {loadingPlayers ? (
        <div className="p-10 text-center text-slate-400">Loading…</div>
      ) : allPositions.length === 0 ? (
        <div className="p-10 text-center text-slate-400">
          This sport has no positions defined.
        </div>
      ) : filtered.length === 0 ? (
        <div className="p-10 text-center text-slate-400">No players match.</div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm divide-y divide-slate-100">
          {filtered.map((p) => {
            const state = states[p.id] ?? "idle";
            const err = errors[p.id];
            return (
              <div key={p.id} className="px-5 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-slate-800 truncate">
                      {p.name ?? p.email}
                      {!p.isActive && (
                        <span className="ml-2 inline-flex px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 text-[10px] font-semibold uppercase tracking-wider">
                          Inactive
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-slate-500">
                      {p._count.attendances} matches · {p.positions.length} position{p.positions.length === 1 ? "" : "s"}
                    </p>
                  </div>
                  <div className="text-xs shrink-0">
                    {state === "saving" && (
                      <span className="inline-flex items-center gap-1 text-slate-500">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Saving
                      </span>
                    )}
                    {state === "saved" && (
                      <span className="inline-flex items-center gap-1 text-green-600 font-medium">
                        <Check className="w-3.5 h-3.5" />
                        Saved
                      </span>
                    )}
                    {state === "error" && (
                      <span className="inline-flex items-center gap-1 text-red-600 font-medium">
                        <AlertCircle className="w-3.5 h-3.5" />
                        Error
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 mt-3">
                  {allPositions.map((pos) => {
                    const selected = p.positions.includes(pos);
                    return (
                      <button
                        key={pos}
                        onClick={() => togglePosition(p.id, pos, p.positions)}
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
                {err && <p className="text-xs text-red-600 mt-2">{err}</p>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
