"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UserPlus, X } from "lucide-react";
import { addPlayerToMatch } from "@/app/actions/players";

interface ExistingPlayer {
  id: string;
  name: string;
  hasPhone: boolean;
}

/**
 * Admin control on the match page: add a player to this match's squad.
 * Type to search EXISTING org members (pick from the list — no retyping,
 * no duplicates). If nobody matches, fall back to creating a brand-new
 * player (name + optional phone). For a past match whose MoM isn't
 * announced, the server also DMs them their rating link.
 */
export function AddPlayerToMatch({
  matchId,
  existingPlayers,
}: {
  matchId: string;
  existingPlayers: ExistingPlayer[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ExistingPlayer | null>(null);
  const [phone, setPhone] = useState("");
  const [bench, setBench] = useState(false);
  const [busy, setBusy] = useState(false);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return existingPlayers.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 6);
  }, [query, existingPlayers]);

  // Exact (case-insensitive) name already exists → block creating a dup.
  const exactExisting = useMemo(
    () => existingPlayers.find((p) => p.name.toLowerCase() === query.trim().toLowerCase()) ?? null,
    [query, existingPlayers],
  );
  const isNewPlayer = !selected && query.trim().length > 0 && !exactExisting;

  function reset() {
    setQuery("");
    setSelected(null);
    setPhone("");
    setBench(false);
  }

  async function submit() {
    if (!selected && !query.trim()) {
      toast.error("Pick a player or type a name");
      return;
    }
    setBusy(true);
    try {
      const input = selected
        ? { userId: selected.id }
        : { name: query, phone: phone || undefined };
      const res = await addPlayerToMatch(matchId, input, bench ? "BENCH" : "CONFIRMED");
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(
        res.ratingDmSent
          ? "Added — rating link sent to them"
          : res.created
            ? "Player created & added"
            : "Added to match",
      );
      reset();
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add player");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium"
      >
        <UserPlus className="w-4 h-4" /> Add player
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-4">
      <p className="text-sm font-medium text-slate-800 mb-3">Add a player to this match</p>

      {selected ? (
        <div className="inline-flex items-center gap-2 px-3 h-11 rounded-lg bg-white border border-blue-300 text-slate-800 text-sm">
          <span className="font-medium">{selected.name}</span>
          {!selected.hasPhone && <span className="text-xs text-amber-600">(no phone — no link)</span>}
          <button onClick={() => setSelected(null)} className="text-slate-400 hover:text-slate-700">
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div className="relative">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search existing players, or type a new name…"
            autoFocus
            className="w-full h-11 px-3 rounded-lg border border-slate-200 bg-white text-slate-800"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (matches.length === 1) setSelected(matches[0]);
                else submit();
              }
            }}
          />
          {matches.length > 0 && (
            <ul className="absolute z-10 mt-1 w-full rounded-lg border border-slate-200 bg-white shadow-lg overflow-hidden">
              {matches.map((p) => (
                <li key={p.id}>
                  <button
                    onClick={() => { setSelected(p); setQuery(""); }}
                    className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-blue-50 flex items-center justify-between"
                  >
                    <span>{p.name}</span>
                    {!p.hasPhone && <span className="text-[10px] text-slate-400">no phone</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* New-player phone field — only when creating someone not in the list */}
      {isNewPlayer && (
        <div className="mt-3">
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Phone for new player (optional, recommended)"
            className="w-full h-11 px-3 rounded-lg border border-slate-200 bg-white font-mono text-sm text-slate-800"
          />
          <p className="mt-1 text-xs text-amber-700">
            No match for &ldquo;{query.trim()}&rdquo; — this creates a new player (default rating 6).
          </p>
        </div>
      )}

      <label className="mt-3 flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
        <input
          type="checkbox"
          checked={bench}
          onChange={(e) => setBench(e.target.checked)}
          className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
        />
        Add to bench instead of the squad
      </label>

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={submit}
          disabled={busy}
          className="inline-flex items-center gap-2 px-4 h-11 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-50"
        >
          {busy ? "Adding…" : "Add"}
        </button>
        <button
          onClick={() => { reset(); setOpen(false); }}
          className="px-4 h-11 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
