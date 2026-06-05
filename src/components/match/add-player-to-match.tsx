"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UserPlus } from "lucide-react";
import { addPlayerToMatch } from "@/app/actions/players";

/**
 * Admin-only control on the match page: add a missing player to this
 * match's squad. Creates the player record if they don't exist yet. For a
 * past match whose MoM isn't announced, the server also DMs them their
 * rating link.
 */
export function AddPlayerToMatch({ matchId }: { matchId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [bench, setBench] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!name.trim() && !phone.trim()) {
      toast.error("Enter a name (and optionally a phone)");
      return;
    }
    setBusy(true);
    try {
      const res = await addPlayerToMatch(
        matchId,
        { name, phone: phone || undefined },
        bench ? "BENCH" : "CONFIRMED",
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(
        res.ratingDmSent
          ? "Added — rating link sent to them"
          : res.created
            ? "Player created & added to match"
            : "Added to match",
      );
      setName("");
      setPhone("");
      setBench(false);
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
      <div className="flex flex-col sm:flex-row gap-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          className="flex-1 h-11 px-3 rounded-lg border border-slate-200 bg-white text-slate-800"
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="Phone (optional)"
          className="flex-1 h-11 px-3 rounded-lg border border-slate-200 bg-white font-mono text-sm text-slate-800"
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </div>
      <label className="mt-3 inline-flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
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
          onClick={() => { setOpen(false); setName(""); setPhone(""); setBench(false); }}
          className="px-4 h-11 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium"
        >
          Cancel
        </button>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Unknown number? We create the player (default rating 6). If the match
        has already happened and the Man of the Match isn&apos;t announced yet,
        they&apos;ll get their rating link by DM automatically.
      </p>
    </div>
  );
}
