"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Phone, Star, Shield, Check, X, Sparkles, GitMerge, Tag, Plus } from "lucide-react";
import { toast } from "sonner";
import {
  updatePlayerRole,
  seedPlayerRating,
  confirmProvisionalPlayer,
  removeProvisionalPlayer,
  updatePlayerName,
  updatePlayerPhone,
  mergePlayers,
  addPlayerAlias,
  removePlayerAlias,
} from "@/app/actions/players";

interface Player {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  role: string;
  positions: string[];
  seedRating: number | null;
  phoneNumber: string | null;
  isActive: boolean;
  leftAt: string | null;
  provisionallyAddedAt: string | null;
  aliases: Array<{ alias: string; source: string }>;
  _count: { attendances: number };
}

export default function PlayersPage() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [loading, setLoading] = useState(true);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [includeFormer, setIncludeFormer] = useState(false);

  useEffect(() => {
    fetch("/api/org/settings").then((r) => r.json()).then((d) => setOrgId(d.id));
  }, []);

  useEffect(() => {
    loadPlayers(includeFormer);
  }, [includeFormer]);

  async function loadPlayers(withFormer: boolean) {
    setLoading(true);
    const qs = withFormer ? "?includeFormer=1" : "";
    const res = await fetch(`/api/players${qs}`);
    if (res.ok) {
      const data = await res.json();
      setPlayers(Array.isArray(data) ? data : data.players ?? []);
    }
    setLoading(false);
  }

  async function handleRoleChange(userId: string, role: string) {
    if (!orgId) return;
    try {
      await updatePlayerRole(userId, orgId, role as "ADMIN" | "PLAYER");
      toast.success("Role updated");
      loadPlayers(includeFormer);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function handleSeedRating(userId: string, value: string) {
    // Integers only — the whole numbers are easier to reason about and
    // the balancer picks up 1-point differences fine.
    const num = parseInt(value, 10);
    if (isNaN(num) || num < 1 || num > 10 || !orgId) return;
    try {
      await seedPlayerRating(userId, orgId, num);
      // Optimistic in-place update — keeps scroll position and focus so
      // admin can rate many players in a row without fighting the page.
      setPlayers((prev) =>
        prev.map((p) => (p.id === userId ? { ...p, seedRating: num } : p)),
      );
      toast.success("Rating updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function handleRename(userId: string, name: string, original: string | null) {
    if (!orgId) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === (original ?? "")) return; // no-op
    try {
      await updatePlayerName(userId, orgId, trimmed);
      setPlayers((prev) => prev.map((p) => (p.id === userId ? { ...p, name: trimmed } : p)));
      toast.success("Name updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function handlePhone(userId: string, phone: string, original: string | null) {
    if (!orgId) return;
    const trimmed = phone.trim();
    if (trimmed === (original ?? "")) return; // no-op
    try {
      const res = await updatePlayerPhone(userId, orgId, trimmed);
      setPlayers((prev) =>
        prev.map((p) => (p.id === userId ? { ...p, phoneNumber: res.phoneNumber } : p)),
      );
      toast.success("Phone updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  const [mergeFrom, setMergeFrom] = useState<string | null>(null); // user id we're merging FROM

  async function handleMerge(dropId: string, keepId: string) {
    if (!orgId) return;
    if (!confirm(`Merge into the chosen player? The duplicate row will be deleted, all attendance/ratings/messages re-attributed to the kept player. This cannot be undone.`)) return;
    try {
      await mergePlayers(orgId, keepId, dropId);
      toast.success("Players merged");
      setMergeFrom(null);
      loadPlayers(includeFormer);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  // Track which row's "add alias" input is open (one at a time).
  const [aliasInputFor, setAliasInputFor] = useState<string | null>(null);
  const [aliasInputValue, setAliasInputValue] = useState("");

  async function handleAddAlias(userId: string) {
    if (!orgId) return;
    const value = aliasInputValue.trim();
    if (!value) { setAliasInputFor(null); return; }
    try {
      const res = await addPlayerAlias(userId, orgId, value);
      // Optimistic update — push the new alias into the row.
      setPlayers((prev) =>
        prev.map((p) =>
          p.id === userId
            ? {
                ...p,
                aliases: res.alreadyExisted
                  ? p.aliases
                  : [...p.aliases, { alias: res.alias, source: "manual" }],
              }
            : p,
        ),
      );
      toast.success(res.alreadyExisted ? `"${res.alias}" already linked` : `Added alias "${res.alias}"`);
      setAliasInputFor(null);
      setAliasInputValue("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function handleRemoveAlias(userId: string, alias: string) {
    if (!orgId) return;
    if (!confirm(`Remove alias "${alias}"? Next time the bot sees that pushname, it'll fall back to fuzzy matching.`)) return;
    try {
      await removePlayerAlias(userId, orgId, alias);
      setPlayers((prev) =>
        prev.map((p) =>
          p.id === userId ? { ...p, aliases: p.aliases.filter((a) => a.alias !== alias) } : p,
        ),
      );
      toast.success(`Removed alias "${alias}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function handleConfirm(userId: string) {
    if (!orgId) return;
    try {
      await confirmProvisionalPlayer(userId, orgId);
      toast.success("Player confirmed");
      loadPlayers(includeFormer);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function handleRemove(userId: string) {
    if (!orgId) return;
    if (!confirm("Remove this player? Their attendance/rating history is preserved, but they won't appear in future matches.")) return;
    try {
      await removeProvisionalPlayer(userId, orgId);
      toast.success("Player removed");
      loadPlayers(includeFormer);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  if (loading) return <div className="p-10 text-center text-slate-400">Loading…</div>;

  const withPhoneCount = players.filter((p) => p.phoneNumber).length;
  const leftCount = players.filter((p) => p.leftAt).length;
  const provisionalPlayers = players.filter((p) => p.provisionallyAddedAt && !p.leftAt);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-slate-800">Players ({players.length})</h2>
          <label className="inline-flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={includeFormer}
              onChange={(e) => setIncludeFormer(e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
            />
            <span>
              Include former members
              {includeFormer && leftCount > 0 ? (
                <span className="ml-1 text-slate-400">({leftCount} left)</span>
              ) : null}
            </span>
          </label>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/admin/players/phones"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium"
          >
            <Phone className="w-4 h-4" />
            Phones
            <span className="inline-flex px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px] font-semibold">
              {withPhoneCount}/{players.length}
            </span>
          </Link>
          <Link
            href="/admin/players/positions"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium"
          >
            <Shield className="w-4 h-4" />
            Positions
          </Link>
          <Link
            href="/admin/players/ratings"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium"
          >
            <Star className="w-4 h-4" />
            Seed ratings
          </Link>
        </div>
      </div>

      <p className="text-sm text-slate-500">
        <span className="font-medium text-slate-700">Seed rating</span> is the player&apos;s
        starting skill score (1–10) used by the team-balancer until they&apos;ve
        accumulated enough peer ratings from completed matches.
      </p>

      {provisionalPlayers.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="w-4 h-4 text-amber-600" />
            <p className="font-semibold text-amber-900">
              {provisionalPlayers.length} new {provisionalPlayers.length === 1 ? "player" : "players"} joined via WhatsApp
            </p>
          </div>
          <p className="text-sm text-amber-800">
            {provisionalPlayers.map((p) => p.name).filter(Boolean).join(", ")} posted in the group and got auto-added. Review phone, position and seed rating below, then hit ✓ to confirm — or ✕ to remove if they&apos;re not a player.
          </p>
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="hidden sm:grid grid-cols-[1fr_auto_auto] gap-4 px-6 py-3 border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500">
          <span>Player</span>
          <span className="w-24 text-center">Seed rating</span>
          <span className="w-28 text-center">Role</span>
        </div>
        <div className="divide-y divide-slate-100">
          {players.map((p) => (
            <div
              key={p.id}
              className={`grid grid-cols-[1fr_auto_auto] gap-4 px-6 py-4 items-center ${
                p.leftAt ? "bg-slate-50/70 opacity-70" : p.provisionallyAddedAt ? "bg-amber-50/50" : ""
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold shrink-0 ${
                  p.provisionallyAddedAt ? "bg-amber-100 text-amber-700" : "bg-blue-50 text-blue-700"
                }`}>
                  {(p.name ?? p.email).charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <input
                      type="text"
                      defaultValue={p.name ?? ""}
                      placeholder={p.email}
                      onBlur={(e) => handleRename(p.id, e.target.value, p.name)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        if (e.key === "Escape") {
                          (e.target as HTMLInputElement).value = p.name ?? "";
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                      className="font-semibold text-slate-800 bg-transparent border-0 border-b border-transparent hover:border-slate-200 focus:border-blue-500 focus:outline-none min-w-0 flex-1 px-0 py-0.5 rounded-none"
                      title="Click to rename"
                    />
                    {p.leftAt && (
                      <span className="inline-flex shrink-0 px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 text-[10px] font-semibold uppercase tracking-wider">
                        Left
                      </span>
                    )}
                    {p.provisionallyAddedAt && !p.leftAt && (
                      <span className="inline-flex shrink-0 items-center gap-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-semibold uppercase tracking-wider">
                        <Sparkles className="w-3 h-3" /> New
                      </span>
                    )}
                    {p.provisionallyAddedAt && !p.leftAt && (
                      <button
                        onClick={() => handleConfirm(p.id)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-green-600 hover:bg-green-700 text-white text-[10px] font-semibold"
                        title="Confirm this is a real player"
                      >
                        <Check className="w-3 h-3" /> Confirm
                      </button>
                    )}
                    {p.provisionallyAddedAt && !p.leftAt && (
                      <button
                        onClick={() => handleRemove(p.id)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-200 hover:bg-slate-300 text-slate-700 text-[10px] font-semibold"
                        title="Not a player — remove"
                      >
                        <X className="w-3 h-3" /> Remove
                      </button>
                    )}
                    {!p.leftAt && (
                      <button
                        onClick={() => setMergeFrom(mergeFrom === p.id ? null : p.id)}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold ${
                          mergeFrom === p.id
                            ? "bg-blue-600 text-white"
                            : "bg-slate-100 hover:bg-slate-200 text-slate-600"
                        }`}
                        title="Duplicate of another player? Merge them."
                      >
                        <GitMerge className="w-3 h-3" /> Merge
                      </button>
                    )}
                  </div>
                  {mergeFrom === p.id && (
                    <div className="mt-2 p-2 rounded bg-slate-50 border border-slate-200 text-xs">
                      <p className="text-slate-700 mb-1.5">
                        Merge <strong>{p.name ?? p.email}</strong> into another player. Pick the one to keep:
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {players
                          .filter((q) => q.id !== p.id && !q.leftAt)
                          .map((q) => (
                            <button
                              key={q.id}
                              onClick={() => handleMerge(p.id, q.id)}
                              className="px-2 py-1 rounded bg-white border border-slate-200 hover:border-blue-400 hover:bg-blue-50 text-slate-700"
                            >
                              {q.name ?? q.email}
                            </button>
                          ))}
                        <button
                          onClick={() => setMergeFrom(null)}
                          className="px-2 py-1 rounded text-slate-500 hover:text-slate-700"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                  {(p.aliases.length > 0 || aliasInputFor === p.id) && (
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      <Tag className="w-3 h-3 text-slate-400 shrink-0" />
                      {p.aliases.map((a) => (
                        <button
                          key={a.alias}
                          onClick={() => handleRemoveAlias(p.id, a.alias)}
                          className="group inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-slate-100 hover:bg-red-50 text-slate-700 hover:text-red-700 text-[11px] font-medium transition-colors"
                          title={`Alias "${a.alias}" — click to remove (source: ${a.source})`}
                        >
                          {a.alias}
                          <X className="w-2.5 h-2.5 opacity-0 group-hover:opacity-100" />
                        </button>
                      ))}
                      {aliasInputFor === p.id ? (
                        <input
                          autoFocus
                          type="text"
                          value={aliasInputValue}
                          onChange={(e) => setAliasInputValue(e.target.value)}
                          onBlur={() => handleAddAlias(p.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                            if (e.key === "Escape") {
                              setAliasInputFor(null);
                              setAliasInputValue("");
                            }
                          }}
                          placeholder="nickname…"
                          className="w-28 px-1.5 py-0.5 text-[11px] rounded border border-slate-300 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                      ) : (
                        <button
                          onClick={() => { setAliasInputFor(p.id); setAliasInputValue(""); }}
                          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full border border-dashed border-slate-300 hover:border-blue-400 hover:bg-blue-50 text-slate-400 hover:text-blue-600 text-[11px] font-medium transition-colors"
                          title="Add a nickname / alternate name the bot should recognise"
                        >
                          <Plus className="w-2.5 h-2.5" /> add
                        </button>
                      )}
                    </div>
                  )}
                  {p.aliases.length === 0 && aliasInputFor !== p.id && (
                    <button
                      onClick={() => { setAliasInputFor(p.id); setAliasInputValue(""); }}
                      className="mt-1 inline-flex items-center gap-1 text-[10px] text-slate-400 hover:text-blue-600 transition-colors"
                      title="Add a nickname / alternate name the bot should recognise"
                    >
                      <Tag className="w-2.5 h-2.5" /> add alias
                    </button>
                  )}
                  <div className="flex items-center gap-1.5 text-xs text-slate-500 mt-0.5 flex-wrap">
                    {p.positions.map((pos) => (
                      <span
                        key={pos}
                        className="inline-flex px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-semibold"
                      >
                        {pos}
                      </span>
                    ))}
                    <span>{p.positions.length > 0 ? "·" : ""} {p._count.attendances} matches</span>
                    <span className="text-slate-300">·</span>
                    <input
                      type="tel"
                      defaultValue={p.phoneNumber ?? ""}
                      placeholder="+44 7…"
                      onBlur={(e) => handlePhone(p.id, e.target.value, p.phoneNumber)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        if (e.key === "Escape") {
                          (e.target as HTMLInputElement).value = p.phoneNumber ?? "";
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                      className="text-xs text-slate-500 bg-transparent border-0 border-b border-transparent hover:border-slate-200 focus:border-blue-500 focus:outline-none w-32 px-0 py-0.5 rounded-none"
                      title="Phone number — used for personal DMs (rating links, reminders)"
                    />
                  </div>
                </div>
              </div>
              <div className="w-24 flex flex-col items-center">
                <label className="sm:hidden text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-0.5">
                  Seed
                </label>
                <input
                  type="number"
                  defaultValue={p.seedRating != null ? Math.round(p.seedRating) : ""}
                  min={1}
                  max={10}
                  step={1}
                  title="Seed rating (1–10). Used by the team-balancer until peer ratings accumulate."
                  onBlur={(e) => e.target.value && handleSeedRating(p.id, e.target.value)}
                  className="w-20 h-10 px-2 rounded-lg border border-slate-200 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div className="w-28 flex flex-col items-center">
                <label className="sm:hidden text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-0.5">
                  Role
                </label>
                <select
                  value={p.role}
                  onChange={(e) => handleRoleChange(p.id, e.target.value)}
                  className="w-28 h-10 px-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="PLAYER">Player</option>
                  <option value="ADMIN">Admin</option>
                </select>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
