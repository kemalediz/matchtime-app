"use client";

/**
 * "Guests from partner clubs" on the match page (cross-club ask, slice S4,
 * plan 3.10). Owners and admins of the asking club only. Each guest on
 * this match by name and club (never a phone), with "Add to <club>",
 * which keeps him as an ordinary member (`keepGuestAsMember`). The server
 * checks the role again.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { t } from "@/lib/i18n/t";
import { keepGuestAction } from "@/app/actions/partner-asks";

export interface PartnerGuestRow {
  userId: string;
  name: string;
  club: string;
}

export function PartnerGuestsPanel(props: { matchId: string; clubName: string; language: string | null; rows: PartnerGuestRow[] }) {
  const s = t(props.language);
  const router = useRouter();
  const [pending, start] = useTransition();
  const [kept, setKept] = useState<Set<string>>(new Set());

  const keep = (userId: string) =>
    start(async () => {
      try {
        const r = await keepGuestAction(props.matchId, userId);
        if (r.ok) {
          setKept((prev) => new Set(prev).add(userId));
          toast.success(s.xask_keep_done);
          router.refresh();
        } else toast.error(s.xask_refused_generic);
      } catch {
        toast.error(s.xask_refused_generic);
      }
    });

  return (
    <section className="bg-white rounded-xl border border-slate-200 p-4" data-testid="partner-guests-panel">
      <h3 className="text-sm font-semibold text-slate-800">{s.xask_guests_title}</h3>
      <ul className="mt-3 space-y-2">
        {props.rows.map((g) => (
          <li key={g.userId} data-testid="partner-guest-row" className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-700">
            <span>{s.xask_guest_row({ name: g.name, club: g.club })}</span>
            {kept.has(g.userId) ? (
              <span className="text-xs text-emerald-700">{s.xask_keep_done}</span>
            ) : (
              <button
                type="button"
                data-testid="partner-guest-keep"
                disabled={pending}
                onClick={() => keep(g.userId)}
                className="h-9 px-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {s.xask_keep_button({ club: props.clubName })}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
