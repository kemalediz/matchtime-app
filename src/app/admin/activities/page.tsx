"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Plus, Zap, X } from "lucide-react";
import {
  createActivity,
  updateActivity,
  generateMatchesForActivity,
} from "@/app/actions/activities";
import { DAYS_OF_WEEK } from "@/lib/constants";
import { SectionInfo } from "@/components/info/section-info";
import { useOrgLang } from "@/components/info/org-lang";
import { VenueConfirmLine } from "@/components/venue/venue-confirm-line";
import { VenueSuggestInput } from "@/components/venue/venue-suggest-input";
import type { VenueLocationView } from "@/lib/venue-location-rules";
import { venueSuggestLabels } from "@/lib/venue-suggest-labels";
import { pickForSubmit, type VenuePickState } from "@/lib/venue-suggest-rules";
import { t } from "@/lib/i18n/t";
import { activityFeeText, parseActivityFee } from "@/lib/activity-fee";
import { FEE_EDIT_PARAM } from "@/lib/setup-learning/suggestion-action";
import { activityTimingsPatch, type ActivityTimings } from "@/lib/activity-timings";

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
  /** Where the venue is, as far as MatchTime knows. OWNER and ADMIN only. */
  venueLocation?: VenueLocationView;
  /** Pounds a player for one game; null: none entered. */
  feePerPlayer: number | null;
  /** The pitch cost is split between who played: no fixed fee. */
  feeSplitTotal: boolean;
  createdAt: string;
}

/** How many times the page looks again while a venue is being looked up. */
const PENDING_RELOADS = 12;

export default function ActivitiesPage() {
  const lang = useOrgLang();
  const s = t(lang);
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
  // A place picked from the suggestions under a venue box, if any. It is
  // dropped the moment the text is edited (venue-suggest-input.tsx).
  const [venuePick, setVenuePick] = useState<VenuePickState | null>(null);
  const [eVenuePick, setEVenuePick] = useState<VenuePickState | null>(null);
  const suggestLabels = venueSuggestLabels(s);
  const [deadlineHours, setDeadlineHours] = useState("5");
  const [matchDurationMins, setMatchDurationMins] = useState("60");

  // Edit existing activity (timing/venue/name).
  const [editId, setEditId] = useState<string | null>(null);
  const [eName, setEName] = useState("");
  const [eDay, setEDay] = useState("2");
  const [eTime, setETime] = useState("21:30");
  const [eVenue, setEVenue] = useState("");
  const [eFee, setEFee] = useState("");
  // The fee as the form opened with it. It is SENT only when it differs,
  // so a stored fee the form cannot show exactly is never rewritten, and
  // never blocks the save, by an edit of something else.
  const [eFeeWas, setEFeeWas] = useState("");
  const [eSplit, setESplit] = useState(false);
  // Match length and sign-up deadline as typed, and as stored. Each is
  // SENT only when changed (src/lib/activity-timings.ts), so a stored
  // value outside today's bounds never blocks an edit of something else.
  const [eDuration, setEDuration] = useState("60");
  const [eDeadline, setEDeadline] = useState("5");
  const [eTimingsWas, setETimingsWas] = useState<ActivityTimings>({ matchDurationMins: 60, deadlineHours: 5 });
  const [eSaving, setESaving] = useState(false);
  // The setup reading's fee suggestion links here with `?edit=fee`
  // (setup-learning/suggestion-action.ts): the weekly game's edit form
  // opens once, at its fee field.
  const [focusFee, setFocusFee] = useState(false);
  const [feeLinkHandled, setFeeLinkHandled] = useState(false);

  useEffect(() => {
    if (loading || feeLinkHandled || typeof window === "undefined") return;
    setFeeLinkHandled(true);
    const [key, value] = FEE_EDIT_PARAM.split("=");
    if (new URLSearchParams(window.location.search).get(key) !== value) return;
    // The weekly game the reading compared the fee with: the club's first
    // active one (setup-learning/run.ts).
    const first = activities.filter((a) => a.isActive).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!first) return;
    openEdit(first);
    setFocusFee(true);
  }, [loading, activities, feeLinkHandled]);

  useEffect(() => {
    fetch("/api/org/settings").then((r) => r.json()).then((d) => setOrgId(d.id));
    fetch("/api/sports").then((r) => (r.ok ? r.json() : [])).then((s: Sport[]) => {
      setSports(s);
      // Default the picker to Football 7-a-side if present, else first sport.
      const def = s.find((x) => x.name.toLowerCase().includes("football 7")) ?? s[0];
      if (def) setSportId(def.id);
    });
  }, []);

  // A venue is looked up AFTER the save has answered, so the first load
  // can find it "pending". Look again a few times, two seconds apart.
  const pendingReloads = useRef(0);
  const loadActivities = useCallback(async () => {
    const res = await fetch("/api/activities");
    if (res.ok) {
      const rows: Activity[] = await res.json();
      setActivities(rows);
      if (rows.some((a) => a.venueLocation?.state === "pending") && pendingReloads.current < PENDING_RELOADS) {
        pendingReloads.current += 1;
        setTimeout(() => void loadActivities(), 2000);
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadActivities();
  }, [loadActivities]);

  /** After a save: start the "pending" look-agains afresh. */
  function reloadAfterSave() {
    pendingReloads.current = 0;
    void loadActivities();
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
        venuePick: pickForSubmit(venuePick, venue),
        deadlineHours: parseInt(deadlineHours),
        matchDurationMins: parseInt(matchDurationMins),
      });
      toast.success("Activity created!");
      setDialogOpen(false);
      setName("");
      setVenue("");
      setVenuePick(null);
      reloadAfterSave();
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
    setEVenuePick(null);
    setEFee(activityFeeText(a.feePerPlayer));
    setEFeeWas(activityFeeText(a.feePerPlayer));
    setESplit(a.feeSplitTotal);
    setEDuration(String(a.matchDurationMins));
    setEDeadline(String(a.deadlineHours));
    setETimingsWas({ matchDurationMins: a.matchDurationMins, deadlineHours: a.deadlineHours });
    setFocusFee(false);
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editId) return;
    const feeChanged = !eSplit && eFee.trim() !== eFeeWas;
    if (feeChanged && !parseActivityFee(eFee).ok) return toast.error(s.act_fee_invalid);
    const timings = activityTimingsPatch({ matchDurationMins: eDuration, deadlineHours: eDeadline }, eTimingsWas);
    if (!timings.ok) return toast.error(timings.field === "matchDurationMins" ? s.act_duration_invalid : s.act_deadline_invalid);
    setESaving(true);
    try {
      await updateActivity(editId, {
        name: eName,
        dayOfWeek: parseInt(eDay),
        time: eTime,
        venue: eVenue,
        venuePick: pickForSubmit(eVenuePick, eVenue),
        ...(feeChanged ? { feePerPlayer: eFee } : {}),
        ...timings.patch,
      });
      toast.success("Activity updated");
      setEditId(null);
      reloadAfterSave();
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
        <h2 className="flex items-center gap-1 text-lg font-semibold text-slate-800">
          Activities
          <SectionInfo k="act_page" lang={lang} />
        </h2>
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
            <div key={a.id} className="px-4 sm:px-6 py-5 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-semibold text-slate-800">{a.name}</p>
                  <span
                    className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                      a.isActive ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    {a.isActive ? "Active" : "Inactive"}
                  </span>
                  <SectionInfo k="act_active" lang={lang} />
                </div>
                <p className="text-sm text-slate-500 mt-1">
                  {DAYS_OF_WEEK[a.dayOfWeek]}s at {a.time} · {a.venue}
                  {!a.feeSplitTotal && activityFeeText(a.feePerPlayer) && (
                    <span data-testid="activity-fee-row"> · {s.act_fee_row({ fee: activityFeeText(a.feePerPlayer) })}</span>
                  )}
                </p>
                <VenueConfirmLine activityId={a.id} location={a.venueLocation} lang={lang} onChanged={loadActivities} />
                <p className="flex flex-wrap items-center gap-1 text-xs text-slate-400 mt-0.5">
                  {a.sport.name} · {a.matchDurationMins}min · Sign-ups close {a.deadlineHours}h before
                  <SectionInfo k="act_deadline" lang={lang} />
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0 flex-wrap">
                <button
                  onClick={() => handleGenerateMatch(a.id)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium"
                >
                  <Zap className="w-3.5 h-3.5" />
                  Generate match
                </button>
                <SectionInfo k="act_generate" lang={lang} />
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
                <VenueSuggestInput
                  value={venue}
                  onChange={(text, pick) => {
                    setVenue(text);
                    setVenuePick(pick);
                  }}
                  lang={lang}
                  labels={suggestLabels}
                  describedBy="new-venue-hint"
                  testId="new-activity-venue"
                  placeholder="e.g. Goals North Cheam"
                  required
                  className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p id="new-venue-hint" className="mt-1 text-xs text-slate-400">
                  {suggestLabels.hint} {suggestLabels.privacy}
                </p>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label={s.act_deadline_label}>
                  <input
                    type="number"
                    value={deadlineHours}
                    onChange={(e) => setDeadlineHours(e.target.value)}
                    min="1"
                    max="48"
                    className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </Field>
                <Field label={s.act_duration_label}>
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
                <VenueSuggestInput
                  value={eVenue}
                  onChange={(text, pick) => {
                    setEVenue(text);
                    setEVenuePick(pick);
                  }}
                  lang={lang}
                  labels={suggestLabels}
                  describedBy="edit-venue-hint"
                  testId="edit-activity-venue"
                  required
                  className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p id="edit-venue-hint" className="mt-1 text-xs text-slate-400">
                  {suggestLabels.hint} {suggestLabels.privacy}
                </p>
              </Field>
              <div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="activity-duration" className="flex items-center gap-1 text-sm font-medium text-slate-700 mb-1.5">
                      {s.act_duration_label}
                      <SectionInfo k="act_duration" lang={lang} />
                    </label>
                    {/* No min or max here: a stored value outside the
                        bounds must not block an edit of something else.
                        A changed value is checked on save. */}
                    <input
                      id="activity-duration"
                      data-testid="activity-duration"
                      type="number"
                      inputMode="numeric"
                      value={eDuration}
                      onChange={(e) => setEDuration(e.target.value)}
                      aria-describedby="activity-timings-hint"
                      className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label htmlFor="activity-deadline" className="flex items-center gap-1 text-sm font-medium text-slate-700 mb-1.5">
                      {s.act_deadline_label}
                    </label>
                    <input
                      id="activity-deadline"
                      data-testid="activity-deadline"
                      type="number"
                      inputMode="numeric"
                      value={eDeadline}
                      onChange={(e) => setEDeadline(e.target.value)}
                      aria-describedby="activity-timings-hint"
                      className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
                <p id="activity-timings-hint" data-testid="activity-timings-hint" className="mt-1 text-xs text-slate-400">
                  {s.act_timings_hint}
                </p>
              </div>
              <div>
                <label htmlFor="activity-fee" className="block text-sm font-medium text-slate-700 mb-1.5">
                  {s.act_fee_label}
                </label>
                <input
                  id="activity-fee"
                  data-testid="activity-fee"
                  inputMode="decimal"
                  autoFocus={focusFee && !eSplit}
                  disabled={eSplit}
                  value={eSplit ? "" : eFee}
                  onChange={(e) => setEFee(e.target.value)}
                  placeholder="6.50"
                  aria-describedby="activity-fee-hint"
                  className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-50 disabled:text-slate-400"
                />
                <p id="activity-fee-hint" data-testid="activity-fee-hint" className="mt-1 text-xs text-slate-400">
                  {eSplit ? s.act_fee_split : s.act_fee_hint}
                </p>
              </div>
              <p className="text-xs text-slate-400">
                Changing the day/time affects future matches generated for this
                activity. Matches already created keep their existing date, so edit
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
