"use client";

/**
 * "Find clubs near you" (partner discovery, slice P2, 2026-10-22), the
 * client half of /admin/partners/find. Plan:
 * MDs/partner-discovery-plan-2026-10-21.md, sections 2.2, 2.3 and 3.1.
 *
 * The distance presets and the same-day switch change the URL, and the
 * server page loads the list again. Each card ticks on its own, or all at
 * once ("Select all": the clubs on this page that can take a request); a
 * club already paired or with a request pending shows its status instead.
 * "Send request" first shows a short confirm saying what the other club
 * will see and what accepting means, then calls slice P3's
 * `sendPartnerRequestsAction` and shows each club's outcome, and "sent the
 * nearest 20" when the daily cap cut the list.
 *
 * Everything shown comes from `NearbyClubCard`: no names, no numbers.
 */
import { useMemo, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { MapPin, Users } from "lucide-react";
import { t } from "@/lib/i18n/t";
import { sendPartnerRequestsAction } from "@/app/actions/partner-requests";
import {
  RADIUS_PRESETS_MILES,
  readSendResult,
  type CardStatus,
  type NearbyClubCard,
  type RadiusMiles,
  type SendOutcomes,
} from "@/lib/club-discovery-rules";

export interface FindClubsProps {
  lang: string | null | undefined;
  radiusMiles: RadiusMiles;
  sameDay: boolean;
  canFilterSameDay: boolean;
  page: number;
  pageCount: number;
  total: number;
  clubs: NearbyClubCard[];
}

export function FindClubs(props: FindClubsProps) {
  const s = t(props.lang);
  const router = useRouter();
  const pathname = usePathname();
  const [navigating, startNav] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [outcomes, setOutcomes] = useState<SendOutcomes | null>(null);

  const selectable = useMemo(() => props.clubs.filter((c) => c.status === null && !outcomes?.byOrg[c.orgId]).map((c) => c.orgId), [props.clubs, outcomes]);
  const chosen = selectable.filter((id) => selected.has(id));
  const allChosen = selectable.length > 0 && chosen.length === selectable.length;

  function go(next: { radius?: RadiusMiles; sameDay?: boolean; page?: number }) {
    const q = new URLSearchParams();
    q.set("radius", String(next.radius ?? props.radiusMiles));
    if (next.sameDay ?? props.sameDay) q.set("sameDay", "1");
    const page = next.page ?? 1;
    if (page > 1) q.set("page", String(page));
    setSelected(new Set());
    setConfirming(false);
    setOutcomes(null);
    startNav(() => router.push(`${pathname}?${q.toString()}`));
  }

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function send() {
    setSending(true);
    try {
      const r = await sendPartnerRequestsAction({ partnerOrgIds: chosen });
      const read = readSendResult(r);
      setOutcomes(read);
      if (!read.failed) {
        setSelected(new Set());
        router.refresh();
      }
    } catch {
      setOutcomes(readSendResult(null));
    } finally {
      setSending(false);
      setConfirming(false);
    }
  }

  const statusLabel = (st: CardStatus) => (st === "paired" ? s.fc_status_paired : st === "paused" ? s.fc_status_paused : s.fc_status_pending);
  const busy = navigating || sending;
  const button = "h-9 px-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50";
  const primary = "h-9 px-4 rounded-lg bg-blue-600 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50";

  return (
    <div className="space-y-4" data-testid="find-clubs" aria-busy={busy}>
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 space-y-3">
        <div>
          <p id="find-clubs-radius" className="text-sm font-medium text-slate-800">
            {s.fc_radius_label}
          </p>
          <div role="radiogroup" aria-labelledby="find-clubs-radius" className="mt-2 flex flex-wrap gap-2">
            {RADIUS_PRESETS_MILES.map((m) => {
              const on = m === props.radiusMiles;
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={busy}
                  onClick={() => !on && go({ radius: m })}
                  className={`h-9 px-3 rounded-lg border text-sm disabled:opacity-50 ${on ? "border-blue-600 bg-blue-50 text-blue-700 font-medium" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}
                >
                  {s.fc_radius_option({ miles: m })}
                </button>
              );
            })}
          </div>
        </div>
        {props.canFilterSameDay && (
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium text-slate-800">{s.fc_same_day_label}</span>
            <button
              type="button"
              role="switch"
              aria-checked={props.sameDay}
              aria-label={s.fc_same_day_label}
              disabled={busy}
              onClick={() => go({ sameDay: !props.sameDay })}
              className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${props.sameDay ? "bg-green-500" : "bg-slate-300"}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${props.sameDay ? "translate-x-5" : "translate-x-0"}`} />
            </button>
          </div>
        )}
      </div>

      {props.total === 0 ? (
        <p className="text-sm text-slate-500" data-testid="find-clubs-none">
          {s.fc_none({ miles: props.radiusMiles })}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate-500" data-testid="find-clubs-count">
              {s.fc_count({ count: props.total })}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  aria-label={s.fc_select_all}
                  checked={allChosen}
                  disabled={busy || selectable.length === 0}
                  onChange={(e) => setSelected(e.target.checked ? new Set(selectable) : new Set())}
                  className="h-4 w-4"
                />
                {s.fc_select_all}
              </label>
              <span className="text-sm text-slate-500" data-testid="find-clubs-selected">
                {s.fc_selected({ count: chosen.length })}
              </span>
              <button type="button" className={primary} disabled={busy || chosen.length === 0} onClick={() => setConfirming(true)}>
                {s.fc_send}
              </button>
            </div>
          </div>

          {confirming && chosen.length > 0 && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4" data-testid="find-clubs-confirm" role="alertdialog" aria-labelledby="find-clubs-confirm-title">
              <p id="find-clubs-confirm-title" className="text-sm font-medium text-slate-800">
                {s.fc_confirm_title({ count: chosen.length })}
              </p>
              <p className="mt-1 text-sm text-slate-700">{s.fc_confirm_sees}</p>
              <p className="mt-1 text-sm text-slate-700">{s.fc_confirm_means}</p>
              <div className="mt-3 flex gap-2">
                <button type="button" className={primary} disabled={sending} onClick={send}>
                  {s.fc_confirm_send}
                </button>
                <button type="button" className={button} disabled={sending} onClick={() => setConfirming(false)}>
                  {s.fc_cancel}
                </button>
              </div>
            </div>
          )}

          {outcomes?.failed && (
            <p className="text-sm text-red-600" role="alert" data-testid="find-clubs-error">
              {s.fc_send_failed}
            </p>
          )}
          {outcomes?.capped && (
            <p className="text-sm text-amber-800" role="status" data-testid="find-clubs-capped">
              {s.fc_capped}
            </p>
          )}

          <ul className="space-y-2">
            {props.clubs.map((c) => {
              const outcome = outcomes?.byOrg[c.orgId];
              const canTick = c.status === null && !outcome;
              return (
                <li
                  key={c.orgId}
                  data-testid="nearby-club"
                  data-org={c.orgId}
                  className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
                >
                  <div className="pt-0.5 w-5 shrink-0">
                    {canTick && (
                      <input
                        type="checkbox"
                        aria-label={s.fc_select({ club: c.name })}
                        checked={selected.has(c.orgId)}
                        disabled={busy}
                        onChange={(e) => toggle(c.orgId, e.target.checked)}
                        className="h-4 w-4"
                      />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="font-medium text-slate-800">{c.name}</p>
                      <p className="text-sm text-slate-500">{s.fc_distance({ miles: c.miles })}</p>
                    </div>
                    <p className="mt-0.5 flex items-center gap-1 text-sm text-slate-600">
                      <MapPin className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                      {c.town ? `${c.venueName}, ${c.town}` : c.venueName}
                    </p>
                    {c.games.length === 0 ? (
                      <p className="mt-1 text-sm text-slate-500">{s.fc_no_game}</p>
                    ) : (
                      <ul className="mt-1 text-sm text-slate-700">
                        {c.games.map((g, i) => (
                          <li key={i}>{s.fc_game(g)}</li>
                        ))}
                      </ul>
                    )}
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-slate-500">
                      <span className="inline-flex items-center gap-1">
                        <Users className="w-3.5 h-3.5" aria-hidden="true" />
                        {s.fc_members({ count: c.members })}
                      </span>
                      <span title={s.fc_regulars_hint}>{s.fc_regulars({ count: c.regulars })}</span>
                    </p>
                    {c.status && (
                      <p className="mt-2 text-xs font-medium text-slate-600" data-testid="nearby-club-status">
                        {statusLabel(c.status)}
                      </p>
                    )}
                    {outcome && (
                      <p
                        className={`mt-2 text-xs font-medium ${outcome.outcome === "sent" ? "text-green-700" : "text-red-600"}`}
                        data-testid="nearby-club-outcome"
                        data-outcome={outcome.outcome}
                      >
                        {outcome.outcome === "sent"
                          ? s.fc_outcome_sent
                          : `${s.fc_outcome_refused}. ${s.fc_refusal({ kind: outcome.reason ?? "" })}`}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {props.pageCount > 1 && (
            <div className="flex items-center justify-between gap-2">
              <button type="button" className={button} disabled={busy || props.page <= 1} onClick={() => go({ page: props.page - 1 })}>
                {s.fc_prev}
              </button>
              <span className="text-sm text-slate-500">{s.fc_page({ page: props.page, pages: props.pageCount })}</span>
              <button type="button" className={button} disabled={busy || props.page >= props.pageCount} onClick={() => go({ page: props.page + 1 })}>
                {s.fc_next}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
