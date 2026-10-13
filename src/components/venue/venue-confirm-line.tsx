"use client";

/**
 * THE CONFIRM LINE under a weekly game's venue on /admin/activities
 * (2026-10-12). It shows the organiser the place MatchTime found for the
 * venue they typed and asks "Is this the right place?".
 *
 * Seven looks, one per `data-state`. Each is what was RECORDED about the
 * lookup, so the line never says "not found" about a place nobody looked
 * for:
 *   never      nothing was ever looked up (every game that existed
 *              before this feature): a small neutral line asking where
 *              the club plays. No amber, no warning icon;
 *   pending    a lookup is under way: one quiet line;
 *   failed     the lookup could not be made (Google failed or timed out,
 *              or the club's daily lookups ran out): a neutral line and
 *              "Try again";
 *   confirmed  the organiser said Yes (or pasted the pin themselves):
 *              one quiet line with the address, a map link and Change;
 *   question   found and we are fairly sure: the address, then the
 *              question with Yes and Change;
 *   low        found but we are not sure: the same question in the amber
 *              "things to check" style of the settings page;
 *   none       Google answered and found nothing: the amber block asking
 *              for the address or a map link.
 *
 * "Change" opens a box for a fuller address or a pasted map link. It
 * never changes the venue name the group sees.
 *
 * The map link is a plain Google Maps URL. There is no embedded map, no
 * map script and no key in the browser.
 *
 * Phone first: organisers arrive here from a WhatsApp link. Buttons are
 * at least 36px tall, the input is 16px text (so iOS does not zoom) and
 * long addresses wrap.
 */
import { useState } from "react";
import { AlertTriangle, ExternalLink, MapPin } from "lucide-react";
import { changeVenueLocationAction, confirmVenueLocationAction, retryVenueLookupAction } from "@/app/actions/venue-location";
import { t } from "@/lib/i18n/t";
import type { VenueLocationView } from "@/lib/venue-location-rules";
import { venueSuggestLabels } from "@/lib/venue-suggest-labels";
import { pickForSubmit, type VenuePickState } from "@/lib/venue-suggest-rules";
import { VenueSuggestInput } from "./venue-suggest-input";

const PRIMARY =
  "inline-flex min-h-9 items-center justify-center rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50";
const SECONDARY =
  "inline-flex min-h-9 items-center justify-center rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50";
const AMBER_PRIMARY =
  "inline-flex min-h-9 items-center justify-center rounded-lg bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 disabled:opacity-50";
const AMBER_BLOCK = "rounded-lg border border-l-4 border-amber-300 border-l-amber-500 bg-amber-50 p-3";

export function VenueConfirmLine(props: {
  activityId: string;
  location: VenueLocationView | undefined;
  lang: string | null | undefined;
  /** Reload the activities after a Yes or a Change. */
  onChanged: () => void | Promise<void>;
}) {
  const s = t(props.lang);
  const loc = props.location;
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [pick, setPick] = useState<VenuePickState | null>(null);
  const suggestLabels = venueSuggestLabels(s);
  const [busy, setBusy] = useState<"yes" | "find" | "retry" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A plain member's response carries no location: render nothing.
  if (!loc) return null;

  const state =
    loc.state !== "found"
      ? loc.state
      : loc.confirmed
          ? "confirmed"
          : loc.confidence === "high"
            ? "question"
            : "low";

  async function yes() {
    setBusy("yes");
    setError(null);
    try {
      const res = await confirmVenueLocationAction(props.activityId);
      if (!res.ok) setError(s.venue_loc_err_generic);
      else await props.onChanged();
    } catch {
      setError(s.venue_loc_err_generic);
    } finally {
      setBusy(null);
    }
  }

  async function retry() {
    setBusy("retry");
    setError(null);
    try {
      // Whatever it came to is recorded: the reload shows it.
      await retryVenueLookupAction(props.activityId);
      await props.onChanged();
    } catch {
      setError(s.venue_loc_err_generic);
    } finally {
      setBusy(null);
    }
  }

  async function find(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim() || busy) return;
    setBusy("find");
    setError(null);
    try {
      // A place picked from the suggestions goes with the text, as long as
      // the text is still the picked place's own.
      const res = await changeVenueLocationAction(props.activityId, value, pickForSubmit(pick, value));
      if (res.status === "found") {
        setOpen(false);
        setValue("");
        setPick(null);
        await props.onChanged();
      } else if (res.status === "not-found") setError(s.venue_loc_err_not_found);
      else if (res.status === "capped") setError(s.venue_loc_err_capped);
      else if (res.status === "unsupported") setError(res.reason === "what3words" ? s.venue_loc_err_w3w : s.venue_loc_err_link);
      else setError(s.venue_loc_failed);
    } catch {
      setError(s.venue_loc_err_generic);
    } finally {
      setBusy(null);
    }
  }

  const inputId = `venue-loc-input-${props.activityId}`;
  const where = loc.state === "found" ? (loc.address ?? (loc.coords ? s.venue_loc_pin({ coords: loc.coords }) : "")) : "";
  const mapLink =
    loc.state === "found" && loc.mapUrl ? (
      <a
        href={loc.mapUrl}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="venue-loc-map"
        className="inline-flex items-center gap-1 whitespace-nowrap font-medium underline underline-offset-2"
      >
        {s.venue_loc_map}
        <ExternalLink aria-hidden="true" className="h-3 w-3" />
      </a>
    ) : null;

  const changeBox = open && (
    <form onSubmit={find} className="mt-2 space-y-2" data-testid="venue-loc-form">
      <label htmlFor={inputId} className="block text-sm font-medium text-slate-700">
        {s.venue_loc_input_label}
      </label>
      {/* Typing a place shows suggestions; a pasted map link shows none
          (venue-suggest-rules.ts) and is read as before. */}
      <VenueSuggestInput
        id={inputId}
        value={value}
        onChange={(text, picked) => {
          setValue(text);
          setPick(picked);
        }}
        lang={props.lang}
        labels={suggestLabels}
        placeholder={s.venue_loc_input_placeholder}
        maxLength={2000}
        className="h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-base text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <p className="text-xs text-slate-500">
        {s.venue_loc_input_help} {suggestLabels.privacy}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy !== null || !value.trim()} className={PRIMARY}>
          {busy === "find" ? s.venue_loc_finding : s.venue_loc_find}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          disabled={busy !== null}
          className={SECONDARY}
        >
          {s.venue_loc_cancel}
        </button>
      </div>
    </form>
  );

  const alert = error && (
    <p role="alert" data-testid="venue-loc-error" className="mt-2 text-sm text-red-700">
      {error}
    </p>
  );

  const wrap = (children: React.ReactNode, className: string) => (
    <div data-testid={`venue-loc-${props.activityId}`} data-state={state} className={`mt-2 max-w-xl ${className}`}>
      {children}
      {changeBox}
      {alert}
    </div>
  );

  if (state === "pending") {
    return wrap(<p className="text-xs text-slate-400">{s.venue_loc_pending}</p>, "");
  }

  if (state === "never" || state === "failed") {
    // Neutral on purpose: nothing is wrong, MatchTime just does not know yet.
    return wrap(
      <>
        <div className="flex items-start gap-2">
          <MapPin aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
          <p className="min-w-0 text-sm text-slate-600">{state === "never" ? s.venue_loc_never : s.venue_loc_failed}</p>
        </div>
        {!open && (
          <div className="mt-2 flex flex-wrap gap-2">
            {state === "failed" && (
              <button type="button" onClick={retry} disabled={busy !== null} className={SECONDARY}>
                {busy === "retry" ? s.venue_loc_retrying : s.venue_loc_retry}
              </button>
            )}
            <button type="button" onClick={() => setOpen(true)} disabled={busy !== null} className={SECONDARY}>
              {s.venue_loc_add}
            </button>
          </div>
        )}
      </>,
      "rounded-lg border border-slate-200 bg-white p-3",
    );
  }

  if (state === "none") {
    return wrap(
      <>
        <div className="flex items-start gap-2">
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="min-w-0 text-sm text-amber-900">{s.venue_loc_not_found}</p>
        </div>
        {!open && (
          <button type="button" onClick={() => setOpen(true)} className={`mt-2 ${AMBER_PRIMARY}`}>
            {s.venue_loc_add}
          </button>
        )}
      </>,
      AMBER_BLOCK,
    );
  }

  if (state === "confirmed") {
    return wrap(
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
        <span className="inline-flex min-w-0 items-start gap-1">
          <MapPin aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="sr-only">{s.venue_loc_confirmed}: </span>
          <span className="min-w-0 break-words" data-testid="venue-loc-address">
            {where}
          </span>
        </span>
        {mapLink}
        {!open && (
          <button type="button" onClick={() => setOpen(true)} className="font-medium underline underline-offset-2">
            {s.venue_loc_change}
          </button>
        )}
      </p>,
      "",
    );
  }

  const low = state === "low";
  return wrap(
    <>
      <div className="flex items-start gap-2">
        {low ? (
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        ) : (
          <MapPin aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
        )}
        <div className={`min-w-0 text-sm ${low ? "text-amber-900" : "text-slate-600"}`}>
          {low && <p className="font-medium">{s.venue_loc_low_lead}</p>}
          <p className="break-words" data-testid="venue-loc-address">
            {where}
          </p>
          {mapLink && <p className="mt-0.5 text-xs">{mapLink}</p>}
        </div>
      </div>
      {!open && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className={`text-sm font-medium ${low ? "text-amber-900" : "text-slate-700"}`}>{s.venue_loc_question}</span>
          <button type="button" onClick={yes} disabled={busy !== null} className={low ? AMBER_PRIMARY : PRIMARY}>
            {s.venue_loc_yes}
          </button>
          <button type="button" onClick={() => setOpen(true)} disabled={busy !== null} className={SECONDARY}>
            {s.venue_loc_change}
          </button>
        </div>
      )}
    </>,
    low ? AMBER_BLOCK : "rounded-lg border border-slate-200 bg-slate-50 p-3",
  );
}
