"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, Zap, X } from "lucide-react";
import {
  createActivity,
  updateActivity,
  generateMatchesForActivity,
} from "@/app/actions/activities";
import { DAYS_OF_WEEK } from "@/lib/constants";

interface Sport {
  id: string;
  name: string;
  positions: string[];
  teamLabels: string[];
  playersPerTeam: number;
  mvpLabel: string;
  balancingStrategy: string;
}

interface Activity {
  id: string;
  name: string;
  sportId: string;
  sport: Sport;
  dayOfWeek: number;
  time: string;
  venue: string;
  isActive: boolean;
  deadlineHours: number;
  matchDurationMins: number;
  ratingWindowHours: number;
}

export default function ActivitiesPage() {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [sports, setSports] = useState<Sport[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [orgId, setOrgId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [sportId, setSportId] = useState("");
  const [dayOfWeek, setDayOfWeek] = useState("2");
  const [time, setTime] = useState("21:30");
  const [venue, setVenue] = useState("");
  const [deadlineHours, setDeadlineHours] = useState("5");
  const [matchDurationMins, setMatchDurationMins] = useState("60");

  // Edit existing activity (timing/venue/name).
  const [editId, setEditId] = useState<string | null>(null);
  const [eName, setEName] = useState("");
  const [eDay, setEDay] = useState("2");
  const [eTime, setETime] = useState("21:30");
  const [eVenue, setEVenue] = useState("");
  const [eSaving, setESaving] = useState(false);

  useEffect(() => {
    fetch("/api/org/settings").then((r) => r.json()).then((d) => setOrgId(d.id));
    fetch("/api/sports").then((r) => (r.ok ? r.json() : [])).then((s: Sport[]) => {
      setSports(s);
      // Default the picker to Football 7-a-side if present, else first sport.
      const def = s.find((x) => x.name.toLowerCase().includes("football 7")) ?? s[0];
      if (def) setSportId(def.id);
    });
    loadActivities();
  }, []);

  async function loadActivities() {
    const res = await fetch("/api/activities");
    if (res.ok) setActivities(await res.json());
    setLoading(false);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!orgId) return;
    if (!sportId) return toast.error("Pick a sport");
    try {
      await createActivity({
        orgId,
        sportId,
        name,
        dayOfWeek: parseInt(dayOfWeek),
        time,
        venue,
        deadlineHours: parseInt(deadlineHours),
        matchDurationMins: parseInt(matchDurationMins),
      });
      toast.success("Activity created!");
      setDialogOpen(false);
      setName("");
      setVenue("");
      loadActivities();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create");
    }
  }

  async function handleGenerateMatch(id: string) {
    try {
      await generateMatchesForActivity(id);
      toast.success("Match generated for next week!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate");
    }
  }

  function openEdit(a: Activity) {
    setEditId(a.id);
    setEName(a.name);
    setEDay(String(a.dayOfWeek));
    setETime(a.time);
    setEVenue(a.venue);
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editId) return;
    setESaving(true);
    try {
      await updateActivity(editId, {
        name: eName,
        dayOfWeek: parseInt(eDay),
        time: eTime,
        venue: eVenue,
      });
      toast.success("Activity updated");
      setEditId(null);
      loadActivities();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setESaving(false);
    }
  }

  async function handleToggleActive(a: Activity) {
    try {
      await updateActivity(a.id, { isActive: !a.isActive });
      toast.success(a.isActive ? "Deactivated" : "Activated");
      loadActivities();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    }
  }

  if (loading) return <div className="p-10 text-center text-slate-400">Loading…</div>;

  const selectedSport = sports.find((s) => s.id === sportId);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-800">Activities</h2>
        <button
          onClick={() => setDialogOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium"
        >
          <Plus className="w-4 h-4" />
          Create activity
        </button>
      </div>

      {activities.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center text-slate-400">
          No activities yet. Create your first one.
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm divide-y divide-slate-100">
          {activities.map((a) => (
            <div key={a.id} className="px-6 py-5 flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <p className="font-semibold text-slate-800">{a.name}</p>
                  <span
                    className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                      a.isActive ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    {a.isActive ? "Active" : "Inactive"}
                  </span>
                </div>
                <p className="text-sm text-slate-500 mt-1">
                  {DAYS_OF_WEEK[a.dayOfWeek]}s at {a.time} · {a.venue}
                </p>
                <p className="text-xs text-slate-400 mt-0.5">
                  {a.sport.name} · {a.matchDurationMins}min · Sign-ups close {a.deadlineHours}h before
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => handleGenerateMatch(a.id)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium"
                >
                  <Zap className="w-3.5 h-3.5" />
                  Generate match
                </button>
                <button
                  onClick={() => openEdit(a)}
                  className="px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleToggleActive(a)}
                  className="px-3 py-2 rounded-lg text-slate-500 hover:bg-slate-100 text-sm font-medium"
                >
                  {a.isActive ? "Deactivate" : "Activate"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {dialogOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
          onClick={() => setDialogOpen(false)}
        >
          <div
            className="bg-white rounded-xl shadow-xl max-w-md w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h3 className="font-semibold text-slate-800">New activity</h3>
              <button
                onClick={() => setDialogOpen(false)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreate} className="p-6 space-y-4">
              <Field label="Name">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Tuesday 7-a-side"
                  required
                  className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </Field>
              <Field label="Sport">
                <select
                  value={sportId}
                  onChange={(e) => setSportId(e.target.value)}
                  className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {sports.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · {s.playersPerTeam}-a-side
                    </option>
                  ))}
                </select>
                {selectedSport && (
                  <p className="text-xs text-slate-400 mt-1">
                    Positions: {selectedSport.positions.join(", ")} · Balancing: {selectedSport.balancingStrategy}
                  </p>
                )}
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Day">
                  <select
                    value={dayOfWeek}
                    onChange={(e) => setDayOfWeek(e.target.value)}
                    className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {DAYS_OF_WEEK.map((d, i) => (
                      <option key={i} value={i}>{d}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Time">
                  <input
                    type="time"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                    className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </Field>
              </div>
              <Field label="Venue">
                <input
                  value={venue}
                  onChange={(e) => setVenue(e.target.value)}
                  placeholder="e.g. Goals North Cheam"
                  required
                  className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Deadline (h before)">
                  <input
                    type="number"
                    value={deadlineHours}
                    onChange={(e) => setDeadlineHours(e.target.value)}
                    min="1"
                    max="48"
                    className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </Field>
                <Field label="Match duration (min)">
                  <input
                    type="number"
                    value={matchDurationMins}
                    onChange={(e) => setMatchDurationMins(e.target.value)}
                    min="20"
                    max="180"
                    className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </Field>
              </div>
              <button
                type="submit"
                className="w-full h-11 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium"
              >
                Create
              </button>
            </form>
          </div>
        </div>
      )}

      {editId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
          onClick={() => setEditId(null)}
        >
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h3 className="font-semibold text-slate-800">Edit activity</h3>
              <button onClick={() => setEditId(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleEdit} className="p-6 space-y-4">
              <Field label="Name">
                <input
                  value={eName}
                  onChange={(e) => setEName(e.target.value)}
                  required
                  className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Day">
                  <select
                    value={eDay}
                    onChange={(e) => setEDay(e.target.value)}
                    className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {DAYS_OF_WEEK.map((d, i) => (
                      <option key={i} value={i}>{d}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Time">
                  <input
                    type="time"
                    value={eTime}
                    onChange={(e) => setETime(e.target.value)}
                    className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </Field>
              </div>
              <Field label="Venue">
                <input
                  value={eVenue}
                  onChange={(e) => setEVenue(e.target.value)}
                  required
                  className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </Field>
              <p className="text-xs text-slate-400">
                Changing the day/time affects future matches generated for this
                activity. Matches already created keep their existing date — edit
                or cancel those individually if needed.
              </p>
              <button
                type="submit"
                disabled={eSaving}
                className="w-full h-11 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-50"
              >
                {eSaving ? "Saving…" : "Save changes"}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1.5">{label}</label>
      {children}
    </div>
  );
}
