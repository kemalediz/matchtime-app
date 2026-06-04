"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, Clock, HandCoins } from "lucide-react";
import { confirmDirectPayment } from "@/app/actions/payments";

export interface RosterRow {
  userId: string;
  name: string;
  paid: boolean;
  method: string | null;
  directPending: boolean;
  amount: number | null;
  quantity: number;
}

function gbp(n: number): string {
  return n % 1 === 0 ? `£${n.toFixed(0)}` : `£${n.toFixed(2)}`;
}

export function PaymentRoster({ matchId, rows }: { matchId: string; rows: RosterRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function markPaid(userId: string) {
    setBusy(userId);
    try {
      await confirmDirectPayment(matchId, userId);
      toast.success("Marked as paid");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't update");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 divide-y divide-slate-100">
      {rows.map((r) => (
        <div key={r.userId} className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-800 truncate">{r.name}</p>
            <p className="text-xs text-slate-500 flex items-center gap-1 mt-0.5">
              {r.paid ? (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                  Paid
                  {r.method ? ` · ${methodLabel(r.method)}` : ""}
                  {r.amount != null ? ` · ${gbp(r.amount)}` : ""}
                  {r.quantity > 1 ? ` · ${r.quantity} players` : ""}
                </>
              ) : r.directPending ? (
                <>
                  <HandCoins className="w-3.5 h-3.5 text-amber-500" />
                  Paying you directly
                  {r.amount != null ? ` · ${gbp(r.amount)}` : ""}
                </>
              ) : (
                <>
                  <Clock className="w-3.5 h-3.5 text-slate-400" />
                  Unpaid
                </>
              )}
            </p>
          </div>
          {!r.paid && (
            <button
              onClick={() => markPaid(r.userId)}
              disabled={busy === r.userId}
              className="shrink-0 inline-flex items-center gap-1.5 px-3 h-9 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium disabled:opacity-50"
            >
              {busy === r.userId ? "Saving…" : "Mark received"}
            </button>
          )}
        </div>
      ))}
      {rows.length === 0 && (
        <p className="px-4 py-6 text-center text-sm text-slate-400">No confirmed players.</p>
      )}
    </div>
  );
}

function methodLabel(method: string): string {
  switch (method) {
    case "pay_by_bank":
      return "Bank";
    case "card":
      return "Card";
    case "direct":
      return "Direct";
    default:
      return method;
  }
}
