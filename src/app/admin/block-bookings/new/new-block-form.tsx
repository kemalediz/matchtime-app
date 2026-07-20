"use client";

/**
 * Two-step create: (1) fill the form and PREVIEW — the server resolves
 * every occurrence's real UTC kickoff instant per date, so a DST mistake
 * (e.g. the 27 Oct 2026 match after BST ends) is visible before anything
 * is written; (2) confirm and create. Slots already occupied by an
 * existing match are flagged and adopted, never duplicated.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Eye, Loader2, CalendarPlus } from "lucide-react";
import {
  previewBlockBooking,
  createBlockBooking,
  type BlockPreviewRow,
} from "@/app/actions/block-bookings";
import { DAYS_OF_WEEK } from "@/lib/constants";

interface ActivityOption {
  id: string;
  name: string;
  venue: string;
  dayOfWeek: number;
  time: string;
  isActive: boolean;
  sportName: string;
  playersPerTeam: number;
}

export function NewBlockForm({ activities }: { activities: ActivityOption[] }) {
  const router = useRouter();
  const [activityId, setActivityId] = useState(activities[0]?.id ?? "");
  const [startDate, setStartDate] = useState("");
  const [endMode, setEndMode] = useState<"endDate" | "count">("endDate");
  const [endDate, setEndDate] = useState("");
  const [count, setCount] = useState("10");
  const [time, setTime] = useState("");
  const [costPerMatch, setCostPerMatch] = useState("");
  const [notes, setNotes] = useState("");

  const [previewing, setPreviewing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [preview, setPreview] = useState<{
    activityName: string;
    venue: string;
    time: string;
    maxPlayers: number;
    rows: BlockPreviewRow[];
  } | null>(null);

  const activity = activities.find((a) => a.id === activityId);

  function buildInput() {
    if (!activityId) throw new Error("Pick an activity");
    if (!startDate) throw new Error("Pick a start date");
    return {
      activityId,
      startDate,
      endDate: endMode === "endDate" ? endDate || undefined : undefined,
      count: endMode === "count" ? parseInt(count, 10) : undefined,
      time: time || undefined,
      costPerMatch: costPerMatch ? parseFloat(costPerMatch) : undefined,
      notes: notes || undefined,
    };
  }

  async function handlePreview(e: React.FormEvent) {
    e.preventDefault();
    setPreviewing(true);
    try {
      setPreview(await previewBlockBooking(buildInput()));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setPreviewing(false);
    }
  }

  async function handleCreate() {
    setCreating(true);
    try {
      const res = await createBlockBooking(buildInput());
      toast.success(
        `Block created — ${res.created} matches generated` +
          (res.adopted > 0 ? `, ${res.adopted} existing adopted` : "") +
          ". Nothing was posted to the group.",
      );
      router.push("/admin/block-bookings");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create");
      setCreating(false);
    }
  }

  const newCount = preview?.rows.filter((r) => !r.alreadyExists).length ?? 0;

  return (
    <div className="space-y-6">
      <form
        onSubmit={handlePreview}
        className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-4 max-w-xl"
      >
        <Field label="Activity">
          <select
            value={activityId}
            onChange={(e) => {
              setActivityId(e.target.value);
              setPreview(null);
            }}
            className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {activities.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {DAYS_OF_WEEK[a.dayOfWeek]}s {a.time} · {a.venue}
                {a.isActive ? "" : " (paused)"}
              </option>
            ))}
          </select>
          {activity && !activity.isActive && (
            <p className="text-xs text-amber-600 mt-1">
              This activity is paused — that&apos;s fine: the weekly
              auto-generator skips it and this block becomes the schedule.
            </p>
          )}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Start date">
            <input
              type="date"
              value={startDate}
              onChange={(e) => {
                setStartDate(e.target.value);
                setPreview(null);
              }}
              required
              className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </Field>
          <Field label={`Kick-off (default ${activity?.time ?? "--:--"})`}>
            <input
              type="time"
              value={time}
              onChange={(e) => {
                setTime(e.target.value);
                setPreview(null);
              }}
              className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </Field>
        </div>

        <Field label="Block length">
          <div className="flex items-center gap-2 mb-2 text-sm">
            <label className="inline-flex items-center gap-1.5">
              <input
                type="radio"
                checked={endMode === "endDate"}
                onChange={() => {
                  setEndMode("endDate");
                  setPreview(null);
                }}
              />
              End date
            </label>
            <label className="inline-flex items-center gap-1.5 ml-4">
              <input
                type="radio"
                checked={endMode === "count"}
                onChange={() => {
                  setEndMode("count");
                  setPreview(null);
                }}
              />
              Number of matches
            </label>
          </div>
          {endMode === "endDate" ? (
            <input
              type="date"
              value={endDate}
              onChange={(e) => {
                setEndDate(e.target.value);
                setPreview(null);
              }}
              required
              className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          ) : (
            <input
              type="number"
              min="1"
              max="60"
              value={count}
              onChange={(e) => {
                setCount(e.target.value);
                setPreview(null);
              }}
              required
              className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          )}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Cost per match (£, optional)">
            <input
              type="number"
              step="0.01"
              min="0"
              value={costPerMatch}
              onChange={(e) => setCostPerMatch(e.target.value)}
              placeholder="e.g. 84.00"
              className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </Field>
          <Field label="Notes (optional)">
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Autumn block, paid 01/08"
              className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </Field>
        </div>

        <button
          type="submit"
          disabled={previewing}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-60"
        >
          {previewing ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Eye className="w-4 h-4" />
          )}
          Preview dates
        </button>
      </form>

      {preview && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-4 max-w-xl">
          <div>
            <h3 className="font-semibold text-slate-800">
              {preview.rows.length} matches · {preview.activityName} ·{" "}
              {preview.venue}
            </h3>
            <p className="text-sm text-slate-500 mt-1">
              Kick-off {preview.time} London time · {preview.maxPlayers} players
              max. Check the UTC column across any clock change — each date is
              resolved individually.
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-100">
                  <th className="py-2 pr-4 font-medium">#</th>
                  <th className="py-2 pr-4 font-medium">London kick-off</th>
                  <th className="py-2 pr-4 font-medium">UTC instant</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {preview.rows.map((r, i) => (
                  <tr key={r.date}>
                    <td className="py-2 pr-4 text-slate-400">{i + 1}</td>
                    <td className="py-2 pr-4 text-slate-800">{r.kickoffLondon}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-slate-500">
                      {r.kickoffUtcIso.replace(".000Z", "Z")}
                    </td>
                    <td className="py-2">
                      {r.alreadyExists ? (
                        <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700">
                          exists — will be adopted
                        </span>
                      ) : (
                        <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700">
                          will be created
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-600">
            Creating this block generates {newCount} new matches and posts{" "}
            <b>nothing</b> to the group. The bot will only ever announce the
            next match that&apos;s on (not cancelled, previous one finished).
          </div>

          <button
            onClick={handleCreate}
            disabled={creating}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-green-600 hover:bg-green-700 text-white font-medium disabled:opacity-60"
          >
            {creating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <CalendarPlus className="w-4 h-4" />
            )}
            Create block ({newCount} new matches)
          </button>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1.5">
        {label}
      </label>
      {children}
    </div>
  );
}
