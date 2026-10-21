"use client";

/**
 * "Partner clubs" on /admin/settings (cross-club ask, slice S1, 2026-10-16).
 * Plan: MDs/cross-club-player-ask-plan-2026-10-16.md, section 3.2.
 *
 * Shown only to a club that has a partner club (the platform owner pairs
 * them, D1), so every other club's page is unchanged. Each pairing with
 * its state and buttons (accept, decline and remove for the owner; pause
 * and resume for an owner or admin); then the asking side's settings when
 * this club may ask another (when to ask, the automatic time, the
 * cut-off), and the partner side's approval choice per club that may ask
 * this one. Words from the club's language table, each row with its ⓘ.
 * Loads and saves through its own server actions (`app/actions/partners.ts`).
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Handshake } from "lucide-react";
import { SettingInfo } from "@/components/info/setting-info";
import { t } from "@/lib/i18n/t";
import { scrollToHashTarget } from "@/lib/scroll-to-hash";
import {
  actOnPartnershipAction,
  getPartnerClubs,
  savePartnerAskSettingsAction,
  setPartnerApprovalAction,
  type PartnerClubsData,
} from "@/app/actions/partners";
import type { PartnershipView } from "@/lib/club-partnership";
import {
  PARTNER_ASK_CUTOFF_MAX_HOURS,
  PARTNER_ASK_CUTOFF_MIN_HOURS,
  PARTNER_ASK_TIME_DEFAULT,
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
  const scrolled = useRef(false);

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
    scrollToHashTarget("partner-clubs");
  }, [data]);

  if (!data) return null;
  const asks = data.partnerships.some((p) => p.side === "asker");
  const lends = data.partnerships.filter((p) => p.side === "partner");

  async function act(p: PartnershipView, action: PartnershipAction) {
    if (action === "end" && !window.confirm(s.pc_remove_confirm({ other: p.otherOrgName }))) return;
    setBusy(`${p.id}:${action}`);
    try {
      const r = await actOnPartnershipAction(props.orgId, p.id, action);
      if (r.ok) toast.success(s.pc_saved);
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
    if (p.status === "paused") return p.pausedBy === "us" ? s.pc_status_paused_us : s.pc_status_paused_them({ other: p.otherOrgName });
    if (!p.weAccepted && !p.theyAccepted) return s.pc_status_waiting_both;
    if (!p.weAccepted) return s.pc_status_waiting_us;
    return s.pc_status_waiting_them({ other: p.otherOrgName });
  }

  const button =
    "h-9 px-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50";
  const control =
    "h-10 px-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50";

  return (
    <section id="partner-clubs" className="bg-white rounded-xl border border-slate-200 shadow-sm scroll-mt-6" data-testid="partner-clubs">
      <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
        <Handshake className="w-4 h-4 text-slate-500" />
        <h2 className="font-semibold text-slate-800">{s.pc_section_title}</h2>
      </div>
      <div className="p-6">
        <p className="text-sm text-slate-500 mb-4">{s.pc_section_lead}</p>
        <div className="divide-y divide-slate-100">
          <div className="py-3" data-setting="partnerClubs">
            <div className="flex items-center gap-1 text-sm font-medium text-slate-800">
              {s.pc_list_label}
              <SettingInfo k="partnerClubs" lang={props.language} />
            </div>
            <ul className="mt-2 space-y-2">
              {data.partnerships.map((p) => (
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
                    {p.status === "proposed" && !p.weAccepted && data.isOwner && (
                      <button type="button" className={button} disabled={!!busy} onClick={() => act(p, "accept")} data-testid="partner-accept">
                        {s.pc_accept}
                      </button>
                    )}
                    {p.status === "proposed" && data.isOwner && (
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
                    {p.status !== "proposed" && data.isOwner && (
                      <button type="button" className={button} disabled={!!busy} onClick={() => act(p, "end")} data-testid="partner-remove">
                        {s.pc_remove}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {!data.isOwner && <p className="mt-2 text-xs text-slate-500">{s.pc_owner_only}</p>}
          </div>

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
