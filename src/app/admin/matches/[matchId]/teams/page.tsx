"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw, Send, Save, ArrowLeftRight, X, AlertTriangle } from "lucide-react";
import {
  generateTeams,
  swapPlayers,
  swapTeamColours,
  movePlayerToOtherTeam,
  addToTeam,
  removeFromTeam,
  promoteFromBench,
  publishTeams,
} from "@/app/actions/teams";
import { updateMatchScore } from "@/app/actions/matches";

interface Player {
  id: string;
  name: string | null;
  image: string | null;
  positions: string[];
}

interface TeamAssignment {
  userId: string;
  team: "RED" | "YELLOW";
  user: Player;
}

export default function TeamManagementPage() {
  const { matchId } = useParams<{ matchId: string }>();
  const [match, setMatch] = useState<{
    status: string;
    teamAssignments: TeamAssignment[];
    attendances: { status: string; user: Player }[];
    redScore: number | null;
    yellowScore: number | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedSwap, setSelectedSwap] = useState<string[]>([]);
  const [redScore, setRedScore] = useState("");
  const [yellowScore, setYellowScore] = useState("");

  useEffect(() => {
    loadMatch();
  }, [matchId]);

  async function loadMatch() {
    const res = await fetch(`/api/matches/${matchId}`);
    if (res.ok) {
      const data = await res.json();
      setMatch(data);
      if (data.redScore !== null) setRedScore(String(data.redScore));
      if (data.yellowScore !== null) setYellowScore(String(data.yellowScore));
    }
    setLoading(false);
  }

  async function handleGenerate() {
    try {
      await generateTeams(matchId);
      toast.success("Teams generated!");
      loadMatch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function handleSwap() {
    if (selectedSwap.length !== 2) return;
    try {
      await swapPlayers(matchId, selectedSwap[0], selectedSwap[1]);
      toast.success("Players swapped!");
      setSelectedSwap([]);
      loadMatch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function handleSwapColours() {
    try {
      await swapTeamColours(matchId);
      toast.success("Colours swapped — same teams");
      loadMatch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }
  async function handleMove(userId: string) {
    try {
      await movePlayerToOtherTeam(matchId, userId);
      loadMatch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }
  async function handleRemove(userId: string) {
    try {
      await removeFromTeam(matchId, userId);
      loadMatch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }
  async function handleAdd(userId: string, team: "RED" | "YELLOW") {
    try {
      await addToTeam(matchId, userId, team);
      loadMatch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }
  async function handlePromote(userId: string, team: "RED" | "YELLOW") {
    try {
      await promoteFromBench(matchId, userId, team);
      toast.success("Moved up from the bench");
      loadMatch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function handlePublish() {
    try {
      await publishTeams(matchId);
      toast.success("Teams published!");
      loadMatch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function handleScore() {
    try {
      await updateMatchScore(matchId, {
        redScore: parseInt(redScore),
        yellowScore: parseInt(yellowScore),
      });
      toast.success("Score saved! Match marked as completed.");
      loadMatch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  function toggleSwap(playerId: string) {
    setSelectedSwap((prev) => {
      if (prev.includes(playerId)) return prev.filter((id) => id !== playerId);
      if (prev.length >= 2) return [playerId];
      return [...prev, playerId];
    });
  }

  if (loading) return <div className="p-6 sm:p-8 max-w-6xl mx-auto text-slate-400">Loading…</div>;
  if (!match) return <div className="p-6 sm:p-8 max-w-6xl mx-auto text-slate-400">Match not found</div>;

  const redTeam = match.teamAssignments.filter((a) => a.team === "RED");
  const yellowTeam = match.teamAssignments.filter((a) => a.team === "YELLOW");
  const hasTeams = match.teamAssignments.length > 0;

  // Reflect post-generation squad changes: confirmed players not yet on a
  // team (to slot in), and team-assigned players who've since dropped.
  const attendances = match.attendances ?? [];
  const confirmedIds = new Set(
    attendances.filter((a) => a.status === "CONFIRMED").map((a) => a.user.id),
  );
  const assignedIds = new Set(match.teamAssignments.map((a) => a.userId));
  const droppedAssigned = new Set(
    match.teamAssignments.filter((a) => !confirmedIds.has(a.userId)).map((a) => a.userId),
  );
  const unassigned = attendances
    .filter((a) => a.status === "CONFIRMED" && !assignedIds.has(a.user.id))
    .map((a) => a.user);
  const benchPlayers = attendances
    .filter((a) => a.status === "BENCH" && !assignedIds.has(a.user.id))
    .map((a) => a.user);

  return (
    <div className="p-6 sm:p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-bold text-slate-800">Team management</h1>
        <div className="flex items-center gap-2">
          <a
            href={`/admin/matches/${matchId}/switch-format`}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium"
          >
            Switch format
          </a>
          {match.status !== "COMPLETED" && match.status !== "CANCELLED" && (
            <a
              href={`/admin/matches/${matchId}/cancel`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-200 bg-white hover:bg-red-50 text-red-700 text-sm font-medium"
            >
              Cancel match
            </a>
          )}
          <span className="inline-flex px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-600 capitalize">
            {match.status.replace(/_/g, " ").toLowerCase()}
          </span>
        </div>
      </div>

      {!hasTeams && (
        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center">
          <p className="text-slate-400 mb-5">No teams generated yet.</p>
          <button
            onClick={handleGenerate}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium"
          >
            Generate teams
          </button>
        </div>
      )}

      {hasTeams && (
        <>
          {selectedSwap.length === 2 && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 flex items-center gap-3">
              <p className="text-sm flex-1 font-medium text-blue-800">Swap these two players?</p>
              <button
                onClick={handleSwap}
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm"
              >
                Confirm swap
              </button>
              <button
                onClick={() => setSelectedSwap([])}
                className="px-4 py-2 rounded-lg text-blue-800 hover:bg-blue-100 font-medium text-sm"
              >
                Cancel
              </button>
            </div>
          )}

          <div className="grid gap-5 sm:grid-cols-2">
            <TeamCard color="red" players={redTeam} selected={selectedSwap} onToggle={toggleSwap}
              dropped={droppedAssigned} onMove={handleMove} onRemove={handleRemove} />
            <TeamCard color="yellow" players={yellowTeam} selected={selectedSwap} onToggle={toggleSwap}
              dropped={droppedAssigned} onMove={handleMove} onRemove={handleRemove} />
          </div>

          {/* Confirmed players not yet on a team — e.g. a replacement after a drop */}
          {unassigned.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
              <p className="text-sm font-medium text-amber-800 mb-3 flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4" />
                {unassigned.length} confirmed player{unassigned.length === 1 ? "" : "s"} not on a team
              </p>
              <ul className="space-y-2">
                {unassigned.map((u) => (
                  <li key={u.id} className="flex items-center gap-3 bg-white rounded-lg px-3 py-2">
                    <span className="text-sm font-medium text-slate-800 flex-1 truncate">{u.name}</span>
                    <button
                      onClick={() => handleAdd(u.id, "RED")}
                      className="px-2.5 py-1 rounded-md text-xs font-semibold bg-red-50 text-red-700 hover:bg-red-100"
                    >
                      → Red
                    </button>
                    <button
                      onClick={() => handleAdd(u.id, "YELLOW")}
                      className="px-2.5 py-1 rounded-md text-xs font-semibold bg-amber-50 text-amber-700 hover:bg-amber-100"
                    >
                      → Yellow
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Bench — promote a standby player straight into a team */}
          {benchPlayers.length > 0 && (
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
              <p className="text-sm font-medium text-slate-700 mb-3">
                🪑 Bench ({benchPlayers.length}) — move up into the squad
              </p>
              <ul className="space-y-2">
                {benchPlayers.map((u) => (
                  <li key={u.id} className="flex items-center gap-3 bg-white rounded-lg px-3 py-2">
                    <span className="text-sm font-medium text-slate-800 flex-1 truncate">{u.name}</span>
                    <button
                      onClick={() => handlePromote(u.id, "RED")}
                      className="px-2.5 py-1 rounded-md text-xs font-semibold bg-red-50 text-red-700 hover:bg-red-100"
                    >
                      ↑ Red
                    </button>
                    <button
                      onClick={() => handlePromote(u.id, "YELLOW")}
                      className="px-2.5 py-1 rounded-md text-xs font-semibold bg-amber-50 text-amber-700 hover:bg-amber-100"
                    >
                      ↑ Yellow
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            <button
              onClick={handleSwapColours}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium"
            >
              <ArrowLeftRight className="w-4 h-4" />
              Swap colours
            </button>
            <button
              onClick={handleGenerate}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium"
            >
              <RefreshCw className="w-4 h-4" />
              Regenerate
            </button>
            {match.status === "TEAMS_GENERATED" && (
              <button
                onClick={handlePublish}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium"
              >
                <Send className="w-4 h-4" />
                Publish teams
              </button>
            )}
          </div>
        </>
      )}

      {/* Score entry */}
      {(match.status === "TEAMS_PUBLISHED" || match.status === "COMPLETED") && (
        <section className="bg-white rounded-xl border border-slate-200 shadow-sm">
          <div className="px-6 py-4 border-b border-slate-100">
            <h2 className="font-semibold text-slate-800">Match score</h2>
          </div>
          <div className="p-6 flex flex-wrap items-center gap-5">
            <div className="flex items-center gap-3">
              <span className="h-4 w-4 rounded-full bg-red-500" />
              <span className="font-medium text-slate-700">Red</span>
              <input
                type="number"
                min="0"
                value={redScore}
                onChange={(e) => setRedScore(e.target.value)}
                className="w-20 h-11 text-center text-lg font-bold rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <span className="text-xl font-bold text-slate-300">–</span>
            <div className="flex items-center gap-3">
              <span className="h-4 w-4 rounded-full bg-amber-400" />
              <span className="font-medium text-slate-700">Yellow</span>
              <input
                type="number"
                min="0"
                value={yellowScore}
                onChange={(e) => setYellowScore(e.target.value)}
                className="w-20 h-11 text-center text-lg font-bold rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <button
              onClick={handleScore}
              className="inline-flex items-center gap-2 px-5 h-11 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium"
            >
              <Save className="w-4 h-4" />
              Save score
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function TeamCard({
  color,
  players,
  selected,
  onToggle,
  dropped,
  onMove,
  onRemove,
}: {
  color: "red" | "yellow";
  players: TeamAssignment[];
  selected: string[];
  onToggle: (id: string) => void;
  dropped: Set<string>;
  onMove: (userId: string) => void;
  onRemove: (userId: string) => void;
}) {
  const palette =
    color === "red"
      ? { dot: "bg-red-500", border: "border-red-200", label: "Red team", initialsBg: "bg-red-50 text-red-700" }
      : { dot: "bg-amber-400", border: "border-amber-200", label: "Yellow team", initialsBg: "bg-amber-50 text-amber-700" };

  return (
    <div className={`bg-white rounded-xl border-2 ${palette.border} shadow-sm`}>
      <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2.5">
        <span className={`h-3 w-3 rounded-full ${palette.dot}`} />
        <h3 className="font-semibold text-slate-800">{palette.label}</h3>
        <span className="ml-auto text-xs font-medium text-slate-400">{players.length}</span>
      </div>
      <ul className="p-2">
        {players.map((a) => {
          const on = selected.includes(a.userId);
          const isDropped = dropped.has(a.userId);
          return (
            <li
              key={a.userId}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all ${
                isDropped ? "bg-red-50 ring-1 ring-red-200" : on ? "bg-blue-50 ring-2 ring-blue-500" : "hover:bg-slate-50"
              }`}
            >
              <div
                onClick={() => onToggle(a.userId)}
                className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer"
                title="Tap to select for a 2-player swap"
              >
                <div className={`w-8 h-8 rounded-full ${palette.initialsBg} flex items-center justify-center text-xs font-semibold`}>
                  {(a.user.name ?? "?").charAt(0).toUpperCase()}
                </div>
                <span className="text-sm font-medium text-slate-800 truncate">{a.user.name}</span>
                {isDropped && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-semibold">
                    <AlertTriangle className="w-3 h-3" /> dropped
                  </span>
                )}
                {!isDropped && a.user.positions[0] && (
                  <span className="inline-flex px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px] font-semibold">
                    {a.user.positions[0]}
                  </span>
                )}
              </div>
              <button
                onClick={() => onMove(a.userId)}
                title="Move to the other team"
                className="shrink-0 p-1.5 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100"
              >
                <ArrowLeftRight className="w-4 h-4" />
              </button>
              <button
                onClick={() => onRemove(a.userId)}
                title="Remove from teams"
                className="shrink-0 p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50"
              >
                <X className="w-4 h-4" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
