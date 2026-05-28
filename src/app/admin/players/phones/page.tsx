"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, AlertCircle, Loader2, Phone } from "lucide-react";
import { updatePlayerPhone } from "@/app/actions/players";

interface Player {
  id: string;
  name: string | null;
  email: string;
  phoneNumber: string | null;
  isActive: boolean;
  positions: string[];
  _count: { attendances: number };
}

type RowState = "idle" | "dirty" | "saving" | "saved" | "error";

export default function BulkPhonesPage() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "missing" | "active">("active");
  const [search, setSearch] = useState("");

  // Per-row local state so saving one row doesn't reset others.
  const [values, setValues] = useState<Record<string, string>>({});
  const [states, setStates] = useState<Record<string, RowState>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    fetch("/api/org/settings").then((r) => r.json()).then((d) => setOrgId(d.id));
    load();
  }, []);

  async function load() {
    const res = await fetch("/api/players");
    if (res.ok) {
      const raw = await res.json();
      const data: Player[] = Array.isArray(raw) ? raw : raw.players ?? [];
      setPlayers(data);
      const vs: Record<string, string> = {};
      data.forEach((p) => (vs[p.id] = p.phoneNumber ?? ""));
      setValues(vs);
    }
    setLoading(false);
  }

  function onChange(userId: string, raw: string) {
    setValues((v) => ({ ...v, [userId]: raw }));
    setStates((s) => ({ ...s, [userId]: "dirty" }));
    setErrors((e) => {
      const { [userId]: _drop, ...rest } = e;
      return rest;
    });
    // Debounced autosave on blur — but also save after 1.5s of inactivity.
    if (saveTimers.current[userId]) clearTimeout(saveTimers.current[userId]);
    saveTimers.current[userId] = setTimeout(() => save(userId), 1500);
  }

  async function save(userId: string) {
    if (!orgId) return;
    if (saveTimers.current[userId]) {
      clearTimeout(saveTimers.current[userId]);
      delete saveTimers.current[userId];
    }
    const raw = values[userId] ?? "";
    const existing = players.find((p) => p.id === userId)?.phoneNumber ?? "";
    if (raw.trim() === existing.trim()) {
      setStates((s) => ({ ...s, [userId]: "idle" }));
      return;
    }
    setStates((s) => ({ ...s, [userId]: "saving" }));
    try {
      const res = await updatePlayerPhone(userId, orgId, raw);
      const { phoneNumber } = res;
      // Auto-merge (wa-sync or provisional orphan) shifts the player
      // list shape — one row removed, possibly a redirect. Reload.
      const merged =
        ("mergedSyncOrphan" in res && res.mergedSyncOrphan) ||
        ("mergedProvisional" in res && res.mergedProvisional);
      if (merged) {
        await load();
        setStates((s) => ({ ...s, [userId]: "saved" }));
        setTimeout(() => {
          setStates((s) => (s[userId] === "saved" ? { ...s, [userId]: "idle" } : s));
        }, 2000);
        return;
      }
      setStates((s) => ({ ...s, [userId]: "saved" }));
      setPlayers((prev) =>
        prev.map((p) => (p.id === userId ? { ...p, phoneNumber } : p)),
      );
      setValues((v) => ({ ...v, [userId]: phoneNumber ?? "" }));
      // Fade "saved" back to idle after 2s.
      setTimeout(() => {
        setStates((s) => (s[userId] === "saved" ? { ...s, [userId]: "idle" } : s));
      }, 2000);
    } catch (err) {
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
      if (filter === "missing" && p.phoneNumber) return false;
      if (filter === "active" && !p.isActive) return false;
      if (!q) return true;
      return (
        (p.name ?? "").toLowerCase().includes(q) ||
        p.email.toLowerCase().includes(q) ||
        (p.phoneNumber ?? "").includes(q)
      );
    });
  }, [players, filter, search]);

  const withPhone = players.filter((p) => !!p.phoneNumber).length;

  if (loading) return <div className="p-10 text-center text-slate-400">Loading…</div>;

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
          <Phone className="w-5 h-5 text-slate-500" />
          Bulk edit phone numbers
        </h2>
        <p className="text-sm text-slate-500 mt-1">
          {withPhone} of {players.length} players have a phone number.
          Tab to move between rows — autosaves 1.5s after you stop typing, or on blur.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex gap-1 p-1 bg-slate-100 rounded-lg w-fit">
          {(["active", "missing", "all"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium capitalize transition-colors ${
                filter === f
                  ? "bg-white text-slate-800 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {f === "missing" ? "Missing phone" : f === "active" ? "Active" : "All"}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, email, phone…"
          className="flex-1 sm:max-w-xs h-10 px-3 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="hidden sm:grid grid-cols-[1fr_1fr_auto] gap-4 px-5 py-3 border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500">
          <span>Player</span>
          <span>Phone number</span>
          <span className="w-20 text-right">Status</span>
        </div>

        {filtered.length === 0 ? (
          <div className="p-10 text-center text-slate-400">No players match.</div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {filtered.map((p) => {
              const state = states[p.id] ?? "idle";
              const err = errors[p.id];
              return (
                <li
                  key={p.id}
                  className="grid grid-cols-[1fr] sm:grid-cols-[1fr_1fr_auto] gap-2 sm:gap-4 px-5 py-3 items-center"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-slate-800 truncate">
                      {p.name ?? p.email}
                      {!p.isActive && (
                        <span className="ml-2 inline-flex px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 text-[10px] font-semibold uppercase tracking-wider">
                          Inactive
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-slate-500 truncate">
                      {p.email} · {p._count.attendances} matches
                    </p>
                  </div>
                  <div>
                    <input
                      type="tel"
                      inputMode="tel"
                      value={values[p.id] ?? ""}
                      onChange={(e) => onChange(p.id, e.target.value)}
                      onBlur={() => save(p.id)}
                      placeholder="+44 7700 900000"
                      className={`w-full h-10 px-3 rounded-lg border text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                        state === "error"
                          ? "border-red-300 bg-red-50"
                          : "border-slate-200"
                      }`}
                    />
                    {err && (
                      <p className="text-xs text-red-600 mt-1">{err}</p>
                    )}
                  </div>
                  <div className="sm:w-20 flex sm:justify-end items-center text-xs">
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
                    {state === "dirty" && (
                      <span className="text-amber-600 font-medium">Unsaved</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="text-xs text-slate-400">
        Numbers are auto-normalised: <code className="font-mono text-slate-600">07575 534985</code> → <code className="font-mono text-slate-600">+447575534985</code>,
        <code className="font-mono text-slate-600"> 0044…</code> → <code className="font-mono text-slate-600">+44…</code>.
      </p>
    </div>
  );
}
