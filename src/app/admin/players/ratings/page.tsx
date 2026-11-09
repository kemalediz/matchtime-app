"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  AlertCircle,
  Loader2,
  Star,
  Info,
  X,
} from "lucide-react";
import { seedPlayerRating } from "@/app/actions/players";
import { isUnchangedSeed, parseSeedBox, seedBoxValue } from "@/lib/default-seed";
import { t } from "@/lib/i18n/t";
import { DEFAULT_LANG, type Lang } from "@/lib/i18n/lang";
import { adminPlayerLabel, adminPlayerMatches } from "@/lib/admin-player-label";

interface Player {
  id: string;
  name: string | null;
  /** Null for a partner club's guest: his email is never sent. */
  email: string | null;
  /** Admin-only, null for any guest (/api/players). Labels a nameless player. */
  phoneNumber?: string | null;
  guestFrom?: string | null;
  seedRating: number | null;
  isActive: boolean;
  _count: { attendances: number };
}

type RowState = "idle" | "dirty" | "saving" | "saved" | "error";

export default function BulkRatingsPage() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  // The seed is one club's opinion, so the sentence that says so is in
  // the string table with the rest of the ratings copy and follows the
  // club's own language.
  const [lang, setLang] = useState<Lang>(DEFAULT_LANG);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"active" | "all">("active");
  const [search, setSearch] = useState("");
  const [infoOpen, setInfoOpen] = useState(false);

  const [values, setValues] = useState<Record<string, string>>({});
  const [states, setStates] = useState<Record<string, RowState>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    fetch("/api/org/settings").then((r) => r.json()).then((d) => {
      setOrgId(d.id);
      if (d.language) setLang(d.language as Lang);
    });
    load();
  }, []);

  async function load() {
    const res = await fetch("/api/players");
    if (res.ok) {
      const raw = await res.json();
      const data: Player[] = Array.isArray(raw) ? raw : raw.players ?? [];
      setPlayers(data);
      const vs: Record<string, string> = {};
      // A player nobody has seeded shows 6, the medium baseline
      // (`default-seed.ts`), for the admin to move up or down.
      data.forEach((p) => (vs[p.id] = seedBoxValue(p.seedRating)));
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
    if (saveTimers.current[userId]) clearTimeout(saveTimers.current[userId]);
    saveTimers.current[userId] = setTimeout(() => save(userId), 1200);
  }

  async function save(userId: string) {
    if (!orgId) return;
    if (saveTimers.current[userId]) {
      clearTimeout(saveTimers.current[userId]);
      delete saveTimers.current[userId];
    }
    const raw = values[userId]?.trim() ?? "";
    if (!raw) {
      setStates((s) => ({ ...s, [userId]: "idle" }));
      return;
    }
    // Exactly what was typed, whole number or decimal: never rounded
    // (Kemal, 2026-11-09).
    const num = parseSeedBox(raw);
    if (num === null) {
      setStates((s) => ({ ...s, [userId]: "error" }));
      setErrors((e) => ({ ...e, [userId]: t(lang).seed_box_error }));
      return;
    }
    const existing = players.find((p) => p.id === userId)?.seedRating;
    // Leaving the box as it shows is not a change: an unseeded player's
    // prefilled 6 stays unset, a 6.41666 shown as 6.42 is not cut.
    if (isUnchangedSeed(num, existing)) {
      setStates((s) => ({ ...s, [userId]: "idle" }));
      return;
    }
    setStates((s) => ({ ...s, [userId]: "saving" }));
    try {
      await seedPlayerRating(userId, orgId, num);
      setStates((s) => ({ ...s, [userId]: "saved" }));
      setPlayers((prev) => prev.map((p) => (p.id === userId ? { ...p, seedRating: num } : p)));
      setTimeout(() => {
        setStates((s) => (s[userId] === "saved" ? { ...s, [userId]: "idle" } : s));
      }, 2000);
    } catch (err) {
      setStates((s) => ({ ...s, [userId]: "error" }));
      setErrors((e) => ({ ...e, [userId]: err instanceof Error ? err.message : "Save failed" }));
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return players.filter((p) => {
      if (filter === "active" && !p.isActive) return false;
      if (!q) return true;
      return adminPlayerMatches(p, q);
    });
  }, [players, filter, search]);

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
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
            <Star className="w-5 h-5 text-slate-500" />
            Edit seed ratings
          </h2>
          <button
            onClick={() => setInfoOpen(true)}
            className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 border border-slate-200 px-2 py-1 rounded-md hover:bg-slate-50"
          >
            <Info className="w-3.5 h-3.5" />
            What is this?
          </button>
        </div>
        <p className="text-sm text-slate-500 mt-1">
          1 to 10 scale. Autosaves 1.2s after you stop typing, or on blur.
        </p>
        <p className="text-sm text-slate-500 mt-1" data-testid="seed-default-hint">
          {t(lang).seed_default_hint}
        </p>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang).rating_seed_club_hint}
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex gap-1 p-1 bg-slate-100 rounded-lg w-fit">
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
          className="flex-1 sm:max-w-xs h-10 px-3 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="hidden sm:grid grid-cols-[1fr_100px_120px] gap-4 px-5 py-3 border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500">
          <span>Player</span>
          <span className="text-center">Seed rating</span>
          <span className="text-right">Status</span>
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
                  className="grid grid-cols-[1fr_100px_120px] gap-4 px-5 py-3 items-center"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-slate-800 truncate">
                      {adminPlayerLabel(p, lang)}
                      {!p.isActive && (
                        <span className="ml-2 inline-flex px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 text-[10px] font-semibold uppercase tracking-wider">
                          Inactive
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-slate-500 truncate">
                      {p._count.attendances} matches
                    </p>
                  </div>
                  <div>
                    <input
                      type="number"
                      min="1"
                      max="10"
                      step="any"
                      value={values[p.id] ?? ""}
                      onChange={(e) => onChange(p.id, e.target.value)}
                      onBlur={() => save(p.id)}
                      className={`w-full h-10 px-2 rounded-lg border text-sm text-center font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                        state === "error" ? "border-red-300 bg-red-50" : "border-slate-200"
                      }`}
                    />
                    {err && <p className="text-xs text-red-600 mt-1">{err}</p>}
                  </div>
                  <div className="text-right text-xs">
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

      {infoOpen && <InfoModal lang={lang} onClose={() => setInfoOpen(false)} />}
    </div>
  );
}

/** "How ratings work", in the club's language. The copy lives in the
 *  string table (`ratings_info_*`) with where each line comes from in the
 *  code; the Elo blend this popup used to print was deleted on 2026-09-15. */
function InfoModal({ lang, onClose }: { lang: Lang; onClose: () => void }) {
  const s = t(lang);
  const sections: Array<[string, string]> = [
    [s.ratings_info_seed_head, s.ratings_info_seed_body],
    [s.ratings_info_joiner_head, s.ratings_info_joiner_body],
    [s.ratings_info_peers_head, s.ratings_info_peers_body],
    [s.ratings_info_match_day_head, s.ratings_info_match_day_body],
    [s.ratings_info_shown_head, s.ratings_info_shown_body],
  ];
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-full overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={s.ratings_info_title}
        data-testid="ratings-info"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <h3 className="font-semibold text-slate-800">{s.ratings_info_title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 space-y-4 text-sm text-slate-600">
          {sections.map(([head, body]) => (
            <p key={head}>
              <span className="font-medium text-slate-800">{head}</span> {body}
            </p>
          ))}
          <p className="text-xs text-slate-500">{s.ratings_info_elo}</p>
        </div>
      </div>
    </div>
  );
}
