"use client";

/**
 * "Ask a partner club" on the match page (cross-club ask, slice S2,
 * 2026-10-16; plan 3.3 step 3). Shown to the club's owners and admins
 * only, for an upcoming match, when the club asks partner clubs (its
 * setting is not Off) and has an active partner. One line per partner:
 * a button, or the state of the ask already open. The server decides
 * everything again when the button is pressed (`requestPartnerAsk`).
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Handshake } from "lucide-react";
import { t } from "@/lib/i18n/t";
import { requestPartnerAskAction } from "@/app/actions/partner-asks";

export interface PartnerAskPanelRow {
  partnershipId: string;
  partnerName: string;
  status: string | null;
  volunteers: number;
}

export function PartnerAskPanel(props: { matchId: string; language: string | null; rows: PartnerAskPanelRow[] }) {
  const s = t(props.language);
  const router = useRouter();
  const [pending, start] = useTransition();
  const [pressed, setPressed] = useState<string | null>(null);

  const ask = (row: PartnerAskPanelRow) =>
    start(async () => {
      setPressed(row.partnershipId);
      try {
        const r = await requestPartnerAskAction(props.matchId, row.partnershipId);
        if (r.ok) toast.success(r.message);
        else toast.error(r.message);
        router.refresh();
      } catch {
        toast.error(s.xask_refused_generic);
      } finally {
        setPressed(null);
      }
    });

  return (
    <section className="bg-white rounded-xl border border-slate-200 p-4" data-testid="partner-ask-panel">
      <div className="flex items-center gap-2">
        <Handshake className="w-4 h-4 text-slate-500" />
        <h3 className="text-sm font-semibold text-slate-800">{s.xask_panel_title}</h3>
      </div>
      <p className="mt-1 text-xs text-slate-500">{s.xask_panel_lead}</p>
      <ul className="mt-3 space-y-2">
        {props.rows.map((row) => (
          <li key={row.partnershipId} data-testid="partner-ask-row" data-status={row.status ?? "none"}>
            {row.status === "awaiting-approval" ? (
              <p className="text-sm text-slate-700">{s.xask_status_awaiting({ partner: row.partnerName })}</p>
            ) : row.status === "posted" ? (
              <p className="text-sm text-slate-700">{s.xask_status_posted({ partner: row.partnerName, volunteers: row.volunteers })}</p>
            ) : (
              <button
                type="button"
                data-testid="partner-ask-button"
                disabled={pending}
                onClick={() => ask(row)}
                className="h-10 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-50"
              >
                {pressed === row.partnershipId ? "…" : s.xask_ask_button({ partner: row.partnerName })}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
