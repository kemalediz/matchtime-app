"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Send, Trophy, Star } from "lucide-react";
import { toast } from "sonner";
import { submitRatings, submitMoMVote } from "@/app/actions/ratings";

interface Player {
  id: string;
  name: string | null;
  image: string | null;
  positions: string[];
}

const SCORES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

function Initials({ name }: { name: string | null }) {
  return (
    <div className="w-8 h-8 rounded-full bg-blue-50 text-blue-700 flex items-center justify-center text-xs font-semibold shrink-0">
      {(name ?? "?").charAt(0).toUpperCase()}
    </div>
  );
}

export default function RatePlayersPage() {
  const { matchId } = useParams<{ matchId: string }>();
  const { data: session } = useSession();
  const router = useRouter();

  const [players, setPlayers] = useState<Player[]>([]);
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [momPick, setMomPick] = useState<string | null>(null);
  const [mvpLabel, setMvpLabel] = useState<string>("Man of the Match");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    async function load() {
      const res = await fetch(`/api/matches/${matchId}`);
      if (!res.ok) return;
      const data = await res.json();
      const others = data.attendances
        .filter((a: { userId: string; status: string }) => a.status === "CONFIRMED" && a.userId !== session?.user?.id)
        .map((a: { user: Player }) => a.user);
      setPlayers(others);
      if (data.activity?.sport?.mvpLabel) setMvpLabel(data.activity.sport.mvpLabel);

      const defaults: Record<string, number> = {};
      others.forEach((p: Player) => {
        defaults[p.id] =
          data.existingRatings?.find((r: { playerId: string }) => r.playerId === p.id)?.score ?? 6;
      });
      setRatings(defaults);
      if (data.existingMoMVote) setMomPick(data.existingMoMVote.playerId);
      setLoading(false);
    }
    if (session?.user?.id) load();
  }, [matchId, session?.user?.id]);

  async function handleSubmit() {
    setSubmitting(true);
    try {
      await submitRatings(matchId, {
        ratings: Object.entries(ratings).map(([playerId, score]) => ({ playerId, score })),
      });
      if (momPick) await submitMoMVote(matchId, { playerId: momPick });
      toast.success("Ratings submitted! Thanks for voting.");
      // Land them on their dashboard — magic-link sign-in is already
      // active, so they see their stats (rating, MoM count, recent
      // results) without another click.
      router.push("/");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to submit");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="p-10 text-center text-slate-400">Loading players…</div>
    );
  }

  const allRated = players.every((p) => ratings[p.id] !== undefined);

  return (
    <div className="p-4 sm:p-8 max-w-2xl mx-auto space-y-4">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-slate-800">Rate players</h1>
        <p className="text-sm text-slate-500 mt-1">
          Tap a score for each player, then pick {mvpLabel}.
        </p>
      </div>

      <div className="space-y-3">
        {players.map((p) => (
          <div
            key={p.id}
            className="bg-white rounded-xl border border-slate-200 p-3 shadow-sm"
          >
            <div className="flex items-center gap-2.5 mb-2.5">
              <Initials name={p.name} />
              <span className="font-semibold text-sm text-slate-800 flex-1 truncate">
                {p.name}
              </span>
              {p.positions[0] && (
                <span className="inline-flex px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px] font-semibold">
                  {p.positions[0]}
                </span>
              )}
              {ratings[p.id] !== undefined && (
                <span className="text-lg font-bold text-blue-600 w-7 text-center">
                  {ratings[p.id]}
                </span>
              )}
            </div>
            <div className="flex justify-between gap-1">
              {SCORES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setRatings((r) => ({ ...r, [p.id]: s }))}
                  className={`w-9 h-9 rounded-full text-sm font-bold transition-all ${
                    ratings[p.id] === s
                      ? "bg-blue-600 text-white shadow-md scale-110"
                      : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* MoM */}
      <div className="bg-white rounded-xl border-2 border-amber-200 shadow-sm p-4">
        <div className="flex items-center gap-2 mb-3">
          <Trophy className="w-5 h-5 text-amber-500" />
          <h2 className="font-semibold text-slate-800">{mvpLabel}</h2>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {players.map((p) => {
            const selected = momPick === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setMomPick(p.id)}
                className={`flex items-center gap-2 p-2.5 rounded-lg border transition-all text-left ${
                  selected
                    ? "border-amber-400 bg-amber-50"
                    : "border-slate-200 hover:bg-slate-50"
                }`}
              >
                <Initials name={p.name} />
                <span className="text-sm font-medium text-slate-800 truncate">{p.name}</span>
                {selected && <Star className="w-4 h-4 text-amber-500 fill-amber-500 ml-auto shrink-0" />}
              </button>
            );
          })}
        </div>
      </div>

      <button
        onClick={handleSubmit}
        disabled={submitting || !allRated}
        className="w-full h-12 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium shadow-lg sticky bottom-4 inline-flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        <Send className="w-4 h-4" />
        {submitting ? "Submitting…" : "Submit ratings"}
      </button>
    </div>
  );
}
