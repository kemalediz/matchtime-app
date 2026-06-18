"use client";

/**
 * Review + apply the proposed onboarding roster.
 *
 * Mobile-first (works at 390px): a card per proposed player (editable
 * position + seed rating, with the chat evidence + a confidence badge), a
 * phone input per phone-less member, and the schedule/format fields. Apply
 * calls the applyEnrichment server action; idempotent server-side.
 *
 * Native <select> elements are used to match the rest of the admin UI
 * (the codebase edits positions/activities with native selects).
 */
import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, AlertCircle, Loader2, Users } from "lucide-react";
import type {
  ProposedRosterEntry,
  CapturedSchedule,
} from "@/lib/onboarding-enrichment-reconcile";
import { applyEnrichment } from "@/app/actions/finish-setup";

interface Props {
  sessionId: string;
  roster: ProposedRosterEntry[];
  unresolved: { name: string | null; userId: string }[];
  schedule: CapturedSchedule;
  positions: string[];
}

interface RosterRow {
  matchedUserId: string | null;
  name: string;
  position: string | null;
  seedRating: number | null;
  evidence: string;
  confidence: number;
}

const NONE = "__none__";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function confidenceBadge(c: number): { label: string; cls: string } {
  if (c >= 0.66) return { label: "high", cls: "bg-green-50 text-green-700 border-green-200" };
  if (c >= 0.33) return { label: "med", cls: "bg-amber-50 text-amber-700 border-amber-200" };
  return { label: "low", cls: "bg-red-50 text-red-700 border-red-200" };
}

function clampSeed(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(1, Math.min(10, Math.round(n)));
}

export function FinishSetupForm({ sessionId, roster, unresolved, schedule, positions }: Props) {
  const [rows, setRows] = useState<RosterRow[]>(() =>
    roster.map((r) => ({
      matchedUserId: r.matchedUserId,
      name: r.name,
      position: r.proposedPosition,
      seedRating: r.proposedSeedRating,
      evidence: r.evidence,
      confidence: r.confidence,
    })),
  );
  const [phones, setPhones] = useState<Record<string, string>>({});
  const [dayOfWeek, setDayOfWeek] = useState<string>(
    schedule.dayOfWeek != null ? String(schedule.dayOfWeek) : "",
  );
  const [time, setTime] = useState<string>(schedule.time ?? "");
  const [venue, setVenue] = useState<string>(schedule.venue ?? "");
  const [playersPerSide, setPlayersPerSide] = useState<string>(
    schedule.playersPerSide != null ? String(schedule.playersPerSide) : "",
  );

  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setRow(i: number, patch: Partial<RosterRow>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  async function onApply() {
    setPending(true);
    setError(null);
    try {
      await applyEnrichment({
        sessionId,
        players: rows.map((r) => ({
          userId: r.matchedUserId,
          name: r.name,
          position: r.position,
          seedRating: r.seedRating,
        })),
        phones: Object.entries(phones)
          .filter(([, v]) => v.trim() !== "")
          .map(([userId, phone]) => ({ userId, phone: phone.trim() })),
        schedule: {
          dayOfWeek: dayOfWeek === "" ? null : Number(dayOfWeek),
          time: time.trim() === "" ? null : time.trim(),
          venue: venue.trim() === "" ? null : venue.trim(),
          playersPerSide: playersPerSide.trim() === "" ? null : Number(playersPerSide),
        },
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-10">
        <div className="bg-white rounded-xl border border-green-200 shadow-sm p-8 text-center">
          <CheckCircle2 className="w-10 h-10 text-green-600 mx-auto" />
          <h1 className="text-lg font-semibold text-slate-800 mt-3">Setup complete ✓</h1>
          <p className="text-sm text-slate-500 mt-2">
            Seed ratings, positions, phones and the schedule have been applied.
          </p>
          <Link
            href="/admin"
            className="inline-flex items-center justify-center h-11 px-5 mt-5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
          >
            Go to dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2">
          <Users className="w-5 h-5 text-slate-500" />
          Finish setting up your group
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          We read your chat history and proposed positions and seed ratings. Review and tweak
          anything below, then apply.
        </p>
      </div>

      {/* ── Players ── */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Proposed players
        </h2>
        {rows.length === 0 ? (
          <p className="text-sm text-slate-400">No players were proposed from the chat.</p>
        ) : (
          rows.map((r, i) => {
            const badge = confidenceBadge(r.confidence);
            return (
              <div
                key={`${r.matchedUserId ?? "x"}-${i}`}
                className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 space-y-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium text-slate-800">{r.name}</p>
                  <span
                    className={`inline-flex px-2 py-0.5 rounded-full border text-[11px] font-semibold ${badge.cls}`}
                  >
                    {badge.label}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor={`pos-${i}`}
                      className="block text-xs font-medium text-slate-500 mb-1"
                    >
                      Position
                    </label>
                    <select
                      id={`pos-${i}`}
                      value={r.position ?? NONE}
                      onChange={(e) =>
                        setRow(i, { position: e.target.value === NONE ? null : e.target.value })
                      }
                      className="w-full h-11 px-3 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value={NONE}>None</option>
                      {positions.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label
                      htmlFor={`seed-${i}`}
                      className="block text-xs font-medium text-slate-500 mb-1"
                    >
                      Seed rating
                    </label>
                    <input
                      id={`seed-${i}`}
                      aria-label={`Seed rating for ${r.name}`}
                      type="number"
                      min={1}
                      max={10}
                      value={r.seedRating ?? ""}
                      onChange={(e) =>
                        setRow(i, {
                          seedRating: e.target.value === "" ? null : Number(e.target.value),
                        })
                      }
                      onBlur={(e) => setRow(i, { seedRating: clampSeed(e.target.value) })}
                      className="w-full h-11 px-3 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>

                {r.evidence && (
                  <p className="text-xs italic text-slate-400 line-clamp-2">{r.evidence}</p>
                )}
              </div>
            );
          })
        )}
      </section>

      {/* ── Missing phones ── */}
      {unresolved.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Add missing phone numbers
          </h2>
          <p className="text-xs text-slate-400 -mt-1">
            These members have no phone yet — add one so they get match notifications.
          </p>
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm divide-y divide-slate-100">
            {unresolved.map((m) => {
              const v = phones[m.userId] ?? "";
              const warn = v.trim() !== "" && !v.trim().startsWith("+");
              return (
                <div key={m.userId} className="p-4">
                  <label
                    htmlFor={`phone-${m.userId}`}
                    className="block text-sm font-medium text-slate-700 mb-1"
                  >
                    {m.name ?? "Unnamed member"}
                  </label>
                  <input
                    id={`phone-${m.userId}`}
                    aria-label={m.name ?? "Unnamed member"}
                    type="tel"
                    inputMode="tel"
                    value={v}
                    onChange={(e) =>
                      setPhones((p) => ({ ...p, [m.userId]: e.target.value }))
                    }
                    placeholder="+447..."
                    className="w-full h-11 px-3 rounded-lg border border-slate-200 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  {warn && (
                    <p className="text-xs text-amber-600 mt-1">
                      Include the country code, e.g. +44…
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Schedule / format ── */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Schedule &amp; format
        </h2>
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="dow" className="block text-xs font-medium text-slate-500 mb-1">
              Day of week
            </label>
            <select
              id="dow"
              value={dayOfWeek}
              onChange={(e) => setDayOfWeek(e.target.value)}
              className="w-full h-11 px-3 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">—</option>
              {DAYS.map((d, idx) => (
                <option key={d} value={String(idx)}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="time" className="block text-xs font-medium text-slate-500 mb-1">
              Kick-off time
            </label>
            <input
              id="time"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="w-full h-11 px-3 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label htmlFor="venue" className="block text-xs font-medium text-slate-500 mb-1">
              Venue
            </label>
            <input
              id="venue"
              type="text"
              value={venue}
              onChange={(e) => setVenue(e.target.value)}
              placeholder="e.g. Goals Sutton"
              className="w-full h-11 px-3 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label htmlFor="pps" className="block text-xs font-medium text-slate-500 mb-1">
              Players per side
            </label>
            <input
              id="pps"
              type="number"
              min={1}
              max={11}
              value={playersPerSide}
              onChange={(e) => setPlayersPerSide(e.target.value)}
              placeholder="e.g. 7"
              className="w-full h-11 px-3 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      </section>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <button
        onClick={onApply}
        disabled={pending || done}
        className="w-full h-12 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
      >
        {pending && <Loader2 className="w-4 h-4 animate-spin" />}
        {pending ? "Applying…" : "Apply & finish setup"}
      </button>
    </div>
  );
}
