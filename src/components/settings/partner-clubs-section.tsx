"use client";

/**
 * "Partner clubs" on /admin/settings (cross-club ask, slice S1, 2026-10-16).
 * Plan: MDs/cross-club-player-ask-plan-2026-10-16.md, section 3.2.
 *
 * Shown to EVERY club since partner discovery (slice P1, 2026-10-22,
 * MDs/partner-discovery-plan-2026-10-21.md, section 2.1): first the two
 * switches ("Let nearby clubs find us and send requests", on by default;
 * "Accept partner requests automatically", off), which an owner or admin
 * changes; then the club venue, set ONLY with the venue lookup (a picked
 * place, so always geocoded), with "Confirm your venue to find clubs near
 * you" while the club has neither an active game with a geocoded venue nor
 * a club venue. A venue in use shows as a card ("Set from your game" or
 * "Club venue") with the lookup closed behind "Change" or "Set a club
 * venue" (2026-10-22); with no venue the lookup is open. Then each pairing with its state and buttons (accept, decline and remove for the owner; pause
 * and resume for an owner or admin); then the asking side's settings when
 * this club may ask another (when to ask, the automatic time, the
 * cut-off), and the partner side's approval choice per club that may ask
 * this one. Words from the club's language table, each row with its ⓘ.
 * Loads and saves through its own server actions (`app/actions/partners.ts`).
 *
 * Partner requests (slice P3, 2026-10-22): a "Find clubs near you" link;
 * requests to this club (accept, with its per-ask choice, "Post their asks
 * straight away" by default; decline; block) and requests it sent
 * (withdraw); every button for an owner OR an admin (D-2); "Ask them for
 * players too" on a pairing that lets another club ask this one (D-1); and
 * the block list with unblock.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import Link from "next/link";
import { Handshake, MapPin, Search } from "lucide-react";
import { SettingInfo } from "@/components/info/setting-info";
import { VenueSuggestInput } from "@/components/venue/venue-suggest-input";
import { t } from "@/lib/i18n/t";
import { scrollToHashTarget } from "@/lib/scroll-to-hash";
import { venueSuggestLabels } from "@/lib/venue-suggest-labels";
import { pickForSubmit, type VenuePickState } from "@/lib/venue-suggest-rules";
import {
  actOnPartnershipAction,
  askTooAction,
  blockClubAction,
  unblockClubAction,
  getPartnerClubs,
  saveDiscoverySettingsAction,
  savePartnerAskSettingsAction,
  setClubHomeVenueAction,
  setPartnerApprovalAction,
  type PartnerClubsData,
} from "@/app/actions/partners";
import type { PartnershipView } from "@/lib/club-partnership";
import {
  PARTNER_ASK_CUTOFF_MAX_HOURS,
  PARTNER_ASK_CUTOFF_MIN_HOURS,
  PARTNER_ASK_TIME_DEFAULT,
  REQUEST_DEFAULT_APPROVAL,
  type PartnerApproval,
  type PartnerAskWhen,
  type PartnershipAction,
} from "@/lib/club-partnership-rules";

const CUTOFF_CHOICES = Array.from(
  { length: PARTNER_ASK_CUTOFF_MAX_HOURS - PARTNER_ASK_CUTOFF_MIN_HOURS + 1 },
  (_, i) => PARTNER_ASK_CUTOFF_MIN_HOURS + i,
);

export function PartnerClubsSection(props: { orgId: string; language: string | null | undefined }) {
  const s = t(props.language);
  const [data, setData] = useState<PartnerClubsData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [time, setTime] = useState(PARTNER_ASK_TIME_DEFAULT);
  const [venueText, setVenueText] = useState("");
  const [venuePick, setVenuePick] = useState<VenuePickState | null>(null);
  const [venueError, setVenueError] = useState<string | null>(null);
  // The venue lookup stays closed under a venue already in use, and opens
  // on "Change" / "Set a club venue" (2026-10-22: an empty input under the
  // current venue read as "no venue set").
  const [venueEditing, setVenueEditing] = useState(false);
  // An accepted request's per-ask choice, per request (P3; default "post
  // their asks straight away").
  const [choice, setChoice] = useState<Record<string, PartnerApproval>>({});
  // The "ask them too" link opens this page with `?askToo=<pairing>` (D-1):
  // that pairing's button is highlighted; the tap on it is the request.
  const [askTooId, setAskTooId] = useState<string | null>(null);
  const scrolled = useRef(false);

  useEffect(() => {
    try {
      setAskTooId(new URLSearchParams(window.location.search).get("askToo"));
    } catch {
      setAskTooId(null);
    }
  }, []);

  async function load() {
    try {
      const d = await getPartnerClubs(props.orgId);
      setData(d);
      if (d) setTime(d.settings.time ?? PARTNER_ASK_TIME_DEFAULT);
    } catch {
      setData(null);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.orgId]);

  // The notice DMs link to #partner-clubs, and the section is not in the
  // page when the browser looks for it. Once: the reload after an action
  // must not pull the page back up here.
  useEffect(() => {
    if (!data || scrolled.current) return;
    scrolled.current = true;
    // The weekly venue reminder links to #club-venue (partner discovery, P1).
    if (!scrollToHashTarget("club-venue")) scrollToHashTarget("partner-clubs");
  }, [data]);

  if (!data) return null;
  // Partner requests (P3): a request to us waiting for our answer, and
  // one we sent waiting for theirs, are listed on their own; the list
  // below keeps the rest (active, paused, and an older two-sided proposal).
  const requestsIn = data.partnerships.filter((p) => p.origin === "request" && p.status === "proposed" && p.side === "partner" && !p.weAccepted);
  const requestsOut = data.partnerships.filter((p) => p.origin === "request" && p.status === "proposed" && p.side === "asker" && p.weAccepted);
  const listed = data.partnerships.filter((p) => !requestsIn.includes(p) && !requestsOut.includes(p));
  const asks = data.partnerships.some((p) => p.side === "asker");
  const lends = data.partnerships.filter((p) => p.side === "partner" && p.status !== "proposed");

  async function act(p: PartnershipView, action: PartnershipAction, approval?: PartnerApproval) {
    if (action === "end" && !window.confirm(s.pc_remove_confirm({ other: p.otherOrgName }))) return;
    setBusy(`${p.id}:${action}`);
    try {
      const r = await actOnPartnershipAction(props.orgId, p.id, action, approval);
      if (r.ok) toast.success(s.pc_saved);
      else toast.error(s.pc_refused);
      await load();
    } catch {
      toast.error(s.pc_save_failed);
    } finally {
      setBusy(null);
    }
  }

  async function block(otherOrgId: string, otherName: string) {
    if (!window.confirm(s.pr_block_confirm({ other: otherName }))) return;
    setBusy(`block:${otherOrgId}`);
    try {
      const r = await blockClubAction(props.orgId, otherOrgId);
      if (r.ok) toast.success(s.pc_saved);
      else toast.error(s.pc_refused);
      await load();
    } catch {
      toast.error(s.pc_save_failed);
    } finally {
      setBusy(null);
    }
  }

  async function unblock(otherOrgId: string) {
    setBusy(`unblock:${otherOrgId}`);
    try {
      const r = await unblockClubAction(props.orgId, otherOrgId);
      if (r.ok) toast.success(s.pc_saved);
      else toast.error(s.pc_refused);
      await load();
    } catch {
      toast.error(s.pc_save_failed);
    } finally {
      setBusy(null);
    }
  }

  async function askToo(p: PartnershipView) {
    setBusy(`${p.id}:ask-too`);
    try {
      const r = await askTooAction(props.orgId, p.otherOrgId);
      if (r.ok) toast.success(s.pr_request_sent);
      else toast.error(s.pc_refused);
      await load();
    } catch {
      toast.error(s.pc_save_failed);
    } finally {
      setBusy(null);
    }
  }

  async function saveSettings(patch: { when?: PartnerAskWhen; time?: string; cutoffHours?: number }) {
    setBusy("settings");
    try {
      const r = await savePartnerAskSettingsAction(props.orgId, patch);
      if (r.ok) {
        setData((prev) => (prev ? { ...prev, settings: r.settings } : prev));
        toast.success(s.pc_saved);
      } else toast.error(s.pc_save_failed);
    } catch {
      toast.error(s.pc_save_failed);
    } finally {
      setBusy(null);
    }
  }

  async function saveDiscovery(patch: { discoverable?: boolean; autoAccept?: boolean }) {
    setBusy("discovery");
    try {
      const r = await saveDiscoverySettingsAction(props.orgId, patch);
      if (r.ok) {
        setData((prev) => (prev ? { ...prev, discovery: r.settings } : prev));
        toast.success(s.pc_saved);
      } else toast.error(s.pc_save_failed);
    } catch {
      toast.error(s.pc_save_failed);
    } finally {
      setBusy(null);
    }
  }

  // The club venue: only a place picked from the list is ever saved.
  const venueToSave = pickForSubmit(venuePick, venueText);
  async function saveVenue() {
    if (!venueToSave) {
      setVenueError(s.pd_venue_pick_first);
      return;
    }
    setBusy("venue");
    setVenueError(null);
    try {
      const r = await setClubHomeVenueAction(props.orgId, venueToSave);
      if (r.status === "found") {
        toast.success(s.pd_venue_saved);
        setVenueText("");
        setVenuePick(null);
        setVenueEditing(false);
        await load();
      } else setVenueError(r.status === "capped" ? s.pd_venue_capped : r.status === "no-pick" ? s.pd_venue_pick_first : s.pd_venue_unresolved);
    } catch {
      setVenueError(s.pd_venue_unresolved);
    } finally {
      setBusy(null);
    }
  }

  async function saveApproval(p: PartnershipView, value: PartnerApproval) {
    setBusy(`${p.id}:approval`);
    try {
      const r = await setPartnerApprovalAction(props.orgId, p.id, value);
      if (r.ok) toast.success(s.pc_saved);
      else toast.error(s.pc_save_failed);
      await load();
    } catch {
      toast.error(s.pc_save_failed);
    } finally {
      setBusy(null);
    }
  }

  function statusLine(p: PartnershipView): string {
    if (p.status === "active") return s.pc_status_active;
    if (p.status === "paused") {
      if (p.pausedBy === "platform") return s.pd_status_paused_platform;
      return p.pausedBy === "us" ? s.pc_status_paused_us : s.pc_status_paused_them({ other: p.otherOrgName });
    }
    if (!p.weAccepted && !p.theyAccepted) return s.pc_status_waiting_both;
    if (!p.weAccepted) return s.pc_status_waiting_us;
    return s.pc_status_waiting_them({ other: p.otherOrgName });
  }

  const button =
    "h-9 px-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50";
  const control =
    "h-10 px-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50";
  const suggestLabels = venueSuggestLabels(s);

  // A venue in use (an active game's geocoded venue, or the club venue)
  // is the current state; with none, the lookup is shown open, as before.
  const venueCurrent = !!(data.venue.gameVenue || data.venue.homeVenue);
  const venueLookupOpen = venueEditing || !venueCurrent;
  const closeVenueLookup = () => {
    setVenueEditing(false);
    setVenueText("");
    setVenuePick(null);
    setVenueError(null);
  };
  const openVenueButton = (label: string) => (
    <button type="button" className={`${button} shrink-0`} disabled={!!busy} onClick={() => setVenueEditing(true)} data-testid="club-venue-change">
      {label}
    </button>
  );
  const venueCard = (c: { testId: string; label: string; name: string; address?: string | null; note?: string; action?: ReactNode }) => (
    <div className="mt-2 flex items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3" data-testid={c.testId}>
      <MapPin className="mt-0.5 w-4 h-4 shrink-0 text-green-600" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-slate-500" data-testid="club-venue-current-label">
          {c.label}
        </p>
        <p className="text-sm text-slate-800 break-words" data-testid="club-venue-current-name">
          {c.name}
        </p>
        {c.address && (
          <p className="text-xs text-slate-500 break-words" data-testid="club-venue-current-address">
            {c.address}
          </p>
        )}
        {c.note && <p className="mt-1 text-xs text-slate-500">{c.note}</p>}
      </div>
      {c.action}
    </div>
  );

  const toggle = (on: boolean, label: string, testId: string, onClick: () => void) => (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-testid={testId}
      disabled={busy === "discovery"}
      onClick={onClick}
      className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${on ? "bg-green-500" : "bg-slate-300"}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-5" : "translate-x-0"}`} />
    </button>
  );

  return (
    <section id="partner-clubs" className="bg-white rounded-xl border border-slate-200 shadow-sm scroll-mt-6" data-testid="partner-clubs">
      <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
        <Handshake className="w-4 h-4 text-slate-500" />
        <h2 className="font-semibold text-slate-800">{s.pc_section_title}</h2>
      </div>
      <div className="p-6">
        <p className="text-sm text-slate-500 mb-4">{s.pc_section_lead}</p>
        <div className="divide-y divide-slate-100">
          {/* Partner discovery (P1): the two switches, owners and admins. */}
          <div className="py-3 flex items-center justify-between gap-4" data-setting="partnerDiscoverable">
            <div className="flex items-center gap-1 text-sm font-medium text-slate-800">
              {s.pd_discoverable_label}
              <SettingInfo k="partnerDiscoverable" lang={props.language} />
            </div>
            {toggle(data.discovery.discoverable, s.pd_discoverable_label, "partner-discoverable", () =>
              saveDiscovery({ discoverable: !data.discovery.discoverable }),
            )}
          </div>
          <div className="py-3 flex items-center justify-between gap-4" data-setting="partnerAutoAccept">
            <div className="flex items-center gap-1 text-sm font-medium text-slate-800">
              {s.pd_auto_accept_label}
              <SettingInfo k="partnerAutoAccept" lang={props.language} />
            </div>
            {toggle(data.discovery.autoAccept, s.pd_auto_accept_label, "partner-auto-accept", () =>
              saveDiscovery({ autoAccept: !data.discovery.autoAccept }),
            )}
          </div>

          {/* The club venue (P1): only through the venue lookup. */}
          <div id="club-venue" className="py-3 scroll-mt-6" data-setting="clubHomeVenue" data-testid="club-venue">
            <div className="flex items-center gap-1 text-sm font-medium text-slate-800">
              {s.pd_venue_label}
              <SettingInfo k="clubHomeVenue" lang={props.language} />
            </div>
            {!data.venue.hasVenue && (
              <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3" data-testid="club-venue-prompt" role="note">
                <p className="flex items-center gap-1 text-sm font-medium text-amber-900">
                  <MapPin className="w-4 h-4 shrink-0" aria-hidden="true" />
                  {s.pd_venue_prompt_title}
                </p>
                <p className="mt-1 text-xs text-amber-800">{s.pd_venue_prompt_body}</p>
              </div>
            )}
            {/* The venue in use, as a card: the game's venue first (it is
                the one measured from), then the club venue. */}
            {data.venue.gameVenue &&
              venueCard({
                testId: "club-venue-game",
                label: s.pd_venue_from_game,
                name: data.venue.gameVenue.name,
                note: s.pd_venue_game,
              })}
            {data.venue.homeVenue &&
              venueCard({
                testId: "club-venue-home",
                label: s.pd_venue_from_home,
                name: data.venue.homeVenue.name,
                address: data.venue.homeVenue.address,
                action: !venueEditing && openVenueButton(s.pd_venue_change),
              })}
            {data.venue.gameVenue && !data.venue.homeVenue && !venueEditing && (
              <div className="mt-2">{openVenueButton(s.pd_venue_set_club)}</div>
            )}
            {venueLookupOpen && (
              <>
                <div className="mt-2 flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1 basis-60">
                    <VenueSuggestInput
                      value={venueText}
                      onChange={(text, pick) => {
                        setVenueText(text);
                        setVenuePick(pick);
                        setVenueError(null);
                      }}
                      lang={props.language}
                      labels={suggestLabels}
                      describedBy="club-venue-hint"
                      testId="club-venue-input"
                      placeholder={s.pd_venue_placeholder}
                      maxLength={120}
                      disabled={busy === "venue"}
                      className={`w-full ${control}`}
                    />
                  </div>
                  <button
                    type="button"
                    className={`${button} h-10`}
                    disabled={!!busy || !venueToSave}
                    onClick={saveVenue}
                    data-testid="club-venue-save"
                  >
                    {s.pd_venue_save}
                  </button>
                  {venueCurrent && (
                    <button
                      type="button"
                      className={`${button} h-10`}
                      disabled={busy === "venue"}
                      onClick={closeVenueLookup}
                      data-testid="club-venue-cancel"
                    >
                      {s.pd_venue_cancel}
                    </button>
                  )}
                </div>
                <p id="club-venue-hint" className="mt-1 text-xs text-slate-400">
                  {s.pd_venue_pick_first} {suggestLabels.privacy}
                </p>
                {venueError && (
                  <p className="mt-1 text-xs text-red-600" role="alert" data-testid="club-venue-error">
                    {venueError}
                  </p>
                )}
              </>
            )}
          </div>

          {/* Partner requests (P3): find clubs, then the requests each way. */}
          <div className="py-3">
            <Link
              href="/admin/partners/find"
              className={`${button} inline-flex items-center gap-1.5`}
              data-testid="partner-find-link"
            >
              <Search className="w-4 h-4" aria-hidden="true" />
              {s.pr_find_link}
            </Link>
          </div>

          {requestsIn.length > 0 && (
            <div className="py-3" data-testid="partner-requests-in">
              <p className="text-sm font-medium text-slate-800">{s.pr_in_label}</p>
              <ul className="mt-2 space-y-2">
                {requestsIn.map((p) => {
                  const chosen = choice[p.id] ?? REQUEST_DEFAULT_APPROVAL;
                  return (
                    <li key={p.id} data-testid="partner-request-in" data-other={p.otherOrgName} className="rounded-lg border border-slate-200 p-3">
                      <p className="text-sm text-slate-800">{s.pr_in_row({ other: p.otherOrgName })}</p>
                      <label className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                        {s.pr_choice_label}
                        <select
                          aria-label={`${s.pr_choice_label}: ${p.otherOrgName}`}
                          data-testid="request-choice"
                          value={chosen}
                          disabled={!!busy}
                          onChange={(e) => setChoice((prev) => ({ ...prev, [p.id]: e.target.value as PartnerApproval }))}
                          className={control}
                        >
                          <option value="standing">{s.pr_choice_standing}</option>
                          <option value="each-ask">{s.pr_choice_each}</option>
                        </select>
                      </label>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button type="button" className={button} disabled={!!busy} onClick={() => act(p, "accept", chosen)} data-testid="request-accept">
                          {s.pc_accept}
                        </button>
                        <button type="button" className={button} disabled={!!busy} onClick={() => act(p, "decline")} data-testid="request-decline">
                          {s.pc_decline}
                        </button>
                        <button type="button" className={button} disabled={!!busy} onClick={() => block(p.otherOrgId, p.otherOrgName)} data-testid="request-block">
                          {s.pr_block}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {requestsOut.length > 0 && (
            <div className="py-3" data-testid="partner-requests-out">
              <p className="text-sm font-medium text-slate-800">{s.pr_out_label}</p>
              <ul className="mt-2 space-y-2">
                {requestsOut.map((p) => (
                  <li
                    key={p.id}
                    data-testid="partner-request-out"
                    data-other={p.otherOrgName}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm text-slate-800">{s.pr_out_row({ other: p.otherOrgName })}</p>
                      <p className="text-xs text-slate-500">{s.pr_out_waiting({ other: p.otherOrgName })}</p>
                    </div>
                    <button type="button" className={button} disabled={!!busy} onClick={() => act(p, "withdraw")} data-testid="request-withdraw">
                      {s.pr_withdraw}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="py-3" data-setting="partnerClubs">
            <div className="flex items-center gap-1 text-sm font-medium text-slate-800">
              {s.pc_list_label}
              <SettingInfo k="partnerClubs" lang={props.language} />
            </div>
            {listed.length === 0 && (
              <p className="mt-2 text-sm text-slate-500" data-testid="partner-clubs-none">
                {s.pd_none}
              </p>
            )}
            <ul className="mt-2 space-y-2">
              {listed.map((p) => (
                <li
                  key={p.id}
                  data-testid="partner-club"
                  data-status={p.status}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-slate-800">
                      {p.side === "asker" ? s.pc_row_we_ask({ other: p.otherOrgName }) : s.pc_row_they_ask({ other: p.otherOrgName })}
                    </p>
                    <p className="text-xs text-slate-500" data-testid="partner-club-status">
                      {statusLine(p)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {p.side === "partner" && p.status !== "proposed" && !p.reverseOpen && (
                      <button
                        type="button"
                        className={`${button} ${askTooId === p.id ? "ring-2 ring-blue-500 border-blue-300" : ""}`}
                        disabled={!!busy}
                        onClick={() => askToo(p)}
                        data-testid="partner-ask-too"
                      >
                        {s.pr_ask_too({ other: p.otherOrgName })}
                      </button>
                    )}
                    {p.status === "proposed" && !p.weAccepted && (
                      <button type="button" className={button} disabled={!!busy} onClick={() => act(p, "accept")} data-testid="partner-accept">
                        {s.pc_accept}
                      </button>
                    )}
                    {p.status === "proposed" && (
                      <button type="button" className={button} disabled={!!busy} onClick={() => act(p, "decline")} data-testid="partner-decline">
                        {s.pc_decline}
                      </button>
                    )}
                    {p.status === "active" && (
                      <button type="button" className={button} disabled={!!busy} onClick={() => act(p, "pause")} data-testid="partner-pause">
                        {s.pc_pause}
                      </button>
                    )}
                    {p.status === "paused" && p.pausedBy === "us" && (
                      <button type="button" className={button} disabled={!!busy} onClick={() => act(p, "resume")} data-testid="partner-resume">
                        {s.pc_resume}
                      </button>
                    )}
                    {p.status !== "proposed" && (
                      <button type="button" className={button} disabled={!!busy} onClick={() => act(p, "end")} data-testid="partner-remove">
                        {s.pc_remove}
                      </button>
                    )}
                    {p.side === "partner" && (
                      <button type="button" className={button} disabled={!!busy} onClick={() => block(p.otherOrgId, p.otherOrgName)} data-testid="partner-block">
                        {s.pr_block}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {data.blocked.length > 0 && (
            <div className="py-3" data-testid="partner-blocked">
              <p className="text-sm font-medium text-slate-800">{s.pr_blocks_label}</p>
              <ul className="mt-2 space-y-2">
                {data.blocked.map((b) => (
                  <li
                    key={b.orgId}
                    data-testid="blocked-club"
                    data-other={b.name}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3"
                  >
                    <span className="text-sm text-slate-800">{b.name}</span>
                    <button type="button" className={button} disabled={!!busy} onClick={() => unblock(b.orgId)} data-testid="blocked-unblock">
                      {s.pr_unblock}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {asks && (
            <>
              <div className="py-3" data-setting="partnerAskWhen">
                <div className="flex items-center gap-1 text-sm font-medium text-slate-800">
                  {s.pc_when_label}
                  <SettingInfo k="partnerAskWhen" lang={props.language} />
                </div>
                <select
                  aria-label={s.pc_when_label}
                  data-testid="partner-ask-when"
                  value={data.settings.when}
                  disabled={busy === "settings"}
                  onChange={(e) => saveSettings({ when: e.target.value as PartnerAskWhen })}
                  className={`mt-2 ${control}`}
                >
                  <option value="off">{s.pc_when_off}</option>
                  <option value="on-request">{s.pc_when_on_request}</option>
                  <option value="auto">{s.pc_when_auto}</option>
                </select>
              </div>
              {data.settings.when === "auto" && (
                <div className="py-3" data-setting="partnerAskTime">
                  <div className="flex items-center gap-1 text-sm font-medium text-slate-800">
                    {s.pc_time_label}
                    <SettingInfo k="partnerAskTime" lang={props.language} />
                  </div>
                  <input
                    type="time"
                    aria-label={s.pc_time_label}
                    data-testid="partner-ask-time"
                    value={time}
                    disabled={busy === "settings"}
                    onChange={(e) => setTime(e.target.value)}
                    onBlur={() => time && time !== (data.settings.time ?? PARTNER_ASK_TIME_DEFAULT) && saveSettings({ time })}
                    className={`mt-2 ${control}`}
                  />
                </div>
              )}
              <div className="py-3" data-setting="partnerAskCutoff">
                <div className="flex items-center gap-1 text-sm font-medium text-slate-800">
                  {s.pc_cutoff_label}
                  <SettingInfo k="partnerAskCutoff" lang={props.language} />
                </div>
                <select
                  aria-label={s.pc_cutoff_label}
                  data-testid="partner-ask-cutoff"
                  value={data.settings.cutoffHours}
                  disabled={busy === "settings"}
                  onChange={(e) => saveSettings({ cutoffHours: Number(e.target.value) })}
                  className={`mt-2 ${control}`}
                >
                  {CUTOFF_CHOICES.map((h) => (
                    <option key={h} value={h}>
                      {s.pc_cutoff_hours({ hours: h })}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}

          {lends.length > 0 && (
            <div className="py-3" data-setting="partnerApproval">
              <div className="flex items-center gap-1 text-sm font-medium text-slate-800">
                {s.pc_approval_label}
                <SettingInfo k="partnerApproval" lang={props.language} />
              </div>
              <div className="mt-2 space-y-2">
                {lends.map((p) => (
                  <label key={p.id} className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
                    <span className="min-w-[8rem]">{p.otherOrgName}</span>
                    <select
                      aria-label={`${s.pc_approval_label}: ${p.otherOrgName}`}
                      data-testid="partner-approval"
                      value={p.partnerApproval}
                      disabled={busy === `${p.id}:approval`}
                      onChange={(e) => saveApproval(p, e.target.value as PartnerApproval)}
                      className={control}
                    >
                      <option value="each-ask">{s.pc_approval_each}</option>
                      <option value="standing">{s.pc_approval_standing}</option>
                    </select>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
