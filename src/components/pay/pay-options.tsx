"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Landmark, CreditCard, HandCoins, Minus, Plus } from "lucide-react";
import { payByMethod, payDirect } from "@/app/actions/payments";
import { gbp, type MethodPrice } from "@/lib/payments";

const ICON: Record<string, React.ReactNode> = {
  pay_by_bank: <Landmark className="w-5 h-5" />,
  card: <CreditCard className="w-5 h-5" />,
  direct: <HandCoins className="w-5 h-5" />,
};

export function PayOptions({ matchId, prices }: { matchId: string; prices: MethodPrice[] }) {
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);

  async function choose(p: MethodPrice) {
    setBusy(p.method);
    try {
      if (p.method === "direct") {
        await payDirect(matchId, qty);
        toast.success("Told the organiser — they'll confirm when it lands.");
        location.reload();
        return;
      }
      const { url } = await payByMethod(matchId, p.method, qty);
      location.href = url; // redirect to Stripe Checkout
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't start payment");
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      {/* Paying for others */}
      <div className="flex items-center justify-between rounded-xl bg-slate-50 border border-slate-200 px-3 py-2.5">
        <span className="text-sm text-slate-600">Paying for</span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setQty((q) => Math.max(1, q - 1))}
            className="w-7 h-7 rounded-lg border border-slate-300 flex items-center justify-center text-slate-600 disabled:opacity-40"
            disabled={qty <= 1}
            aria-label="Fewer"
          >
            <Minus className="w-4 h-4" />
          </button>
          <span className="w-6 text-center font-semibold text-slate-900">{qty}</span>
          <button
            type="button"
            onClick={() => setQty((q) => Math.min(10, q + 1))}
            className="w-7 h-7 rounded-lg border border-slate-300 flex items-center justify-center text-slate-600 disabled:opacity-40"
            disabled={qty >= 10}
            aria-label="More"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </div>
      {qty > 1 && (
        <p className="text-[11px] text-slate-400 -mt-1 px-1">
          Paying for yourself + {qty - 1} other{qty - 1 === 1 ? "" : "s"} (e.g. a guest you brought).
        </p>
      )}

      {prices.map((p) => {
        // Per-person base = (total for 1) minus its uplift; show the
        // quantity-scaled total on the button.
        const total = p.method === "direct" ? perDirect(p, qty) : scale(p, qty);
        return (
          <button
            key={p.method}
            type="button"
            onClick={() => choose(p)}
            disabled={busy !== null}
            className="w-full flex items-center gap-3 rounded-xl border border-slate-200 hover:border-blue-300 hover:bg-blue-50/40 px-4 py-3.5 text-left transition-colors disabled:opacity-50"
          >
            <span className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center text-slate-600 shrink-0">
              {ICON[p.method]}
            </span>
            <span className="flex-1 min-w-0">
              <span className="block font-semibold text-slate-900">{p.label}</span>
              {p.method !== "direct" && p.fee > 0 && (
                <span className="block text-[11px] text-slate-400">includes {gbp(p.fee)} processing &amp; service fee</span>
              )}
              {p.method === "direct" && (
                <span className="block text-[11px] text-emerald-600">no fee · cash or transfer</span>
              )}
            </span>
            <span className="font-bold text-slate-900">{busy === p.method ? "…" : gbp(total)}</span>
          </button>
        );
      })}
    </div>
  );
}

// total for qty: (base*qty) + uplift-once. We only have the per-1 total
// (base+uplift) and the uplift (fee), so base = total - fee.
function scale(p: MethodPrice, qty: number): number {
  const base = p.total - p.fee;
  return Math.ceil((base * qty + p.fee) * 20) / 20;
}
function perDirect(p: MethodPrice, qty: number): number {
  return p.total * qty; // direct has no uplift; total === base
}
