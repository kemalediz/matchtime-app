"use client";

/**
 * Pair two clubs, one direction (cross-club ask, slice S1, 2026-10-16;
 * plan section 3.1, D1 and D2). The server action authorises
 * (superadmin) and refuses a club paired with itself or a pair that
 * exists; this only asks, shows the answer and refreshes. Each club's
 * owner then accepts on its own settings page.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createPartnershipAction } from "@/app/actions/partners";

export function PartnerPairingForm(props: { clubs: { id: string; name: string }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [asker, setAsker] = useState("");
  const [partner, setPartner] = useState("");

  const pair = () =>
    start(async () => {
      try {
        const r = await createPartnershipAction(asker, partner);
        if (r.ok) toast.success(r.message);
        else toast.error(r.message);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Something went wrong");
      }
    });

  const control = "h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-700";
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600" role="group" aria-label="Pair two clubs">
      <select aria-label="Club that asks" data-testid="pair-asker" value={asker} onChange={(e) => setAsker(e.target.value)} disabled={pending} className={control}>
        <option value="">Club that asks</option>
        {props.clubs.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <span>may ask</span>
      <select aria-label="Partner club" data-testid="pair-partner" value={partner} onChange={(e) => setPartner(e.target.value)} disabled={pending} className={control}>
        <option value="">Partner club</option>
        {props.clubs.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <span>for players</span>
      <button
        type="button"
        data-testid="pair-clubs"
        disabled={pending || !asker || !partner || asker === partner}
        onClick={pair}
        className="h-9 rounded-lg bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        Pair
      </button>
    </div>
  );
}
