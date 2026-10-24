"use client";

/**
 * "Ask a partner club" on the match page (cross-club ask, slice S2,
 * 2026-10-16; plan 3.3 step 3). Shown to the club's owners and admins
 * only, for an upcoming match, when the club asks partner clubs (its
 * setting is not Off) and has an active partner.
 *
 * Partner discovery P4 (2026-10-22, plan section 4):
 *   - "How many players?": 1 (the default, D-5) up to the open places;
 *   - "Which partner clubs?": a tick per active partner (default all); a
 *     paused partner (dormant or billing-paused) is shown as paused and is
 *     never offered; a partner with an ask already open shows its state;
 *   - one press asks every ticked partner in ONE round: the number is for
 *     all of them together, not each;
 *   - each open round shows its number, how many have a place so far, and
 *     "Cancel this ask".
 * The server decides everything again (`requestPartnerRound`,
 * `cancelPartnerRound`).
 *
 * The MatchTime player pool (L5a, 2026-10-24) is one more tick, shown
 * only when the pool is open for the club: the band of players near the
 * venue ("a few", "5+"), never who; once asked, how many were asked and
 * how many said no. Ticked by default like the partners; the press is the
 * organisers' approval (nobody is contacted before it).
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Handshake } from "lucide-react";
import { t } from "@/lib/i18n/t";
import { cancelPartnerRoundAction, requestPartnerRoundAction } from "@/app/actions/partner-asks";
import { poolCopy } from "@/lib/i18n/pool-offer";
import type { PoolPanelData } from "@/lib/pool/panel";

export interface PartnerAskPanelRow {
  partnershipId: string;
  partnerName: string;
  status: string | null;
  volunteers: number;
  paused: boolean;
  roundKey: string | null;
}

export interface PartnerAskPanelRound {
  roundKey: string;
  wanted: number;
  placed: number;
  partners: string[];
  /** The MatchTime player pool is asked in this round too. */
  pool?: boolean;
}

const isOpen = (status: string | null) => status === "awaiting-approval" || status === "posted";

export function PartnerAskPanel(props: {
  matchId: string;
  language: string | null;
  placesOpen: number;
  rows: PartnerAskPanelRow[];
  rounds: PartnerAskPanelRound[];
  pool?: PoolPanelData | null;
}) {
  const s = t(props.language);
  const ps = poolCopy(props.language);
  const pool = props.pool ?? null;
  const poolAskable = !!pool && !pool.gate && pool.band !== "none" && pool.ask?.status !== "open";
  const [poolUnticked, setPoolUnticked] = useState(false);
  const poolTicked = poolAskable && !poolUnticked;
  const router = useRouter();
  const [pending, start] = useTransition();
  const askable = props.rows.filter((r) => !r.paused && !isOpen(r.status));
  // Every askable partner is ticked by default (plan 4), so the state kept
  // is the ones UNticked: a partner that becomes askable again after a
  // refresh starts ticked.
  const [unticked, setUnticked] = useState<Set<string>>(() => new Set());
  const [places, setPlaces] = useState(1);
  const max = Math.max(0, props.placesOpen);
  const chosen = Math.min(Math.max(1, places), Math.max(1, max));
  const tickedNow = askable.filter((r) => !unticked.has(r.partnershipId)).map((r) => r.partnershipId);

  const toggle = (id: string) =>
    setUnticked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      try {
        const r = await fn();
        if (r.ok) toast.success(r.message);
        else toast.error(r.message);
        router.refresh();
      } catch {
        toast.error(s.xask_refused_generic);
      }
    });

  const ask = () => {
    if (tickedNow.length === 0 && !poolTicked) {
      toast.error(s.xask_round_none_ticked);
      return;
    }
    run(() => requestPartnerRoundAction(props.matchId, tickedNow, chosen, poolTicked));
  };
  const anyAskable = askable.length > 0 || poolAskable;
  const anyTicked = tickedNow.length > 0 || poolTicked;

  return (
    <section className="bg-white rounded-xl border border-slate-200 p-4" data-testid="partner-ask-panel">
      <div className="flex items-center gap-2">
        <Handshake className="w-4 h-4 text-slate-500" />
        <h3 className="text-sm font-semibold text-slate-800">{s.xask_panel_title}</h3>
      </div>
      <p className="mt-1 text-xs text-slate-500">{s.xask_panel_lead}</p>

      {props.rounds.length > 0 && (
        <ul className="mt-3 space-y-2">
          {props.rounds.map((round) => (
            <li
              key={round.roundKey}
              data-testid="partner-ask-round"
              data-wanted={round.wanted}
              data-placed={round.placed}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm text-slate-800">{s.xask_round_status({ wanted: round.wanted, placed: round.placed })}</p>
                <p className="text-xs text-slate-500 break-words">{[...round.partners, ...(round.pool ? [ps.pool_label] : [])].join(", ")}</p>
              </div>
              <button
                type="button"
                data-testid="partner-ask-cancel"
                disabled={pending}
                onClick={() => run(() => cancelPartnerRoundAction(props.matchId, round.roundKey))}
                className="h-9 px-3 rounded-lg border border-slate-300 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              >
                {s.xask_round_cancel}
              </button>
            </li>
          ))}
        </ul>
      )}

      <fieldset className="mt-3">
        <legend className="text-xs font-medium text-slate-600">{s.xask_round_partners_label}</legend>
        <ul className="mt-2 space-y-2">
          {props.rows.map((row) => (
            <li key={row.partnershipId} data-testid="partner-ask-row" data-status={row.paused ? "paused" : (row.status ?? "none")}>
              {row.paused ? (
                <p className="text-sm text-slate-500" data-testid="partner-ask-paused">
                  {s.xask_partner_paused({ partner: row.partnerName })}
                </p>
              ) : row.status === "awaiting-approval" ? (
                <p className="text-sm text-slate-700">{s.xask_status_awaiting({ partner: row.partnerName })}</p>
              ) : row.status === "posted" ? (
                <p className="text-sm text-slate-700">{s.xask_status_posted({ partner: row.partnerName, volunteers: row.volunteers })}</p>
              ) : (
                <label className="flex items-center gap-2 text-sm text-slate-800 min-h-10">
                  <input
                    type="checkbox"
                    data-testid="partner-ask-tick"
                    value={row.partnershipId}
                    checked={!unticked.has(row.partnershipId)}
                    disabled={pending || max <= 0}
                    onChange={() => toggle(row.partnershipId)}
                    className="h-4 w-4"
                  />
                  {row.partnerName}
                </label>
              )}
            </li>
          ))}
          {pool && (
            <li data-testid="pool-ask-row" data-band={pool.band} data-status={pool.ask?.status ?? "none"}>
              {pool.gate === "no-venue" ? (
                <p className="text-sm text-slate-500" data-testid="pool-ask-no-venue">
                  {ps.panel_no_venue}
                </p>
              ) : pool.ask?.status === "open" ? (
                <p className="text-sm text-slate-700" data-testid="pool-ask-status">
                  {ps.pool_label}:{" "}
                  {pool.ask.waitingForPartners ? ps.panel_partners_first : pool.ask.asked > 0 ? ps.panel_asked({ asked: pool.ask.asked, declined: pool.ask.declined }) : ps.panel_waiting}
                </p>
              ) : pool.band === "none" || pool.gate ? (
                <p className="text-sm text-slate-500" data-testid="pool-ask-none">
                  {ps.pool_label}: {ps.band_none}
                </p>
              ) : (
                <label className="flex items-center gap-2 text-sm text-slate-800 min-h-10">
                  <input
                    type="checkbox"
                    data-testid="pool-ask-tick"
                    checked={!poolUnticked}
                    disabled={pending || max <= 0}
                    onChange={() => setPoolUnticked((v) => !v)}
                    className="h-4 w-4"
                  />
                  {ps.pool_label} ({pool.band === "5+" ? ps.band_many : ps.band_few})
                </label>
              )}
            </li>
          )}
        </ul>
      </fieldset>

      {anyAskable &&
        (max <= 0 ? (
          <p className="mt-3 text-sm text-slate-500" data-testid="partner-ask-no-places">
            {s.xask_refused_no_places}
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
              {s.xask_round_number_label}
              <select
                data-testid="partner-ask-number"
                value={chosen}
                disabled={pending}
                onChange={(e) => setPlaces(Number(e.target.value))}
                className="h-10 rounded-lg border border-slate-300 px-2 text-sm text-slate-800 bg-white"
              >
                {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {s.xask_player_count({ n })}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              data-testid="partner-ask-button"
              disabled={pending || !anyTicked}
              onClick={ask}
              className="h-10 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-50"
            >
              {pending ? "…" : s.xask_round_button({ places: chosen })}
            </button>
            {tickedNow.length + (poolTicked ? 1 : 0) > 1 && <p className="w-full text-xs text-slate-500">{s.xask_round_count_hint}</p>}
            {poolTicked && tickedNow.length > 0 && <p className="w-full text-xs text-slate-500">{ps.panel_partners_first}</p>}
          </div>
        ))}
    </section>
  );
}
