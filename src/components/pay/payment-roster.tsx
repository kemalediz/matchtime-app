"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, Clock, Gift, HandCoins } from "lucide-react";
import { confirmDirectPayment, markFeeWaived, undoFeeWaived } from "@/app/actions/payments";

export interface RosterRow {
  userId: string;
  name: string;
  paid: boolean;
  /** A free place (2026-10-16): owes nothing. Never true for a paid row. */
  free?: boolean;
  method: string | null;
  directPending: boolean;
  amount: number | null;
  quantity: number;
}

/** The free-place words, in the club's language (the page passes them). */
export interface RosterWords {
  free: string;
  markFree: string;
  undoFree: string;
  markedFree: string;
  unmarkedFree: string;
}

const ENGLISH: RosterWords = {
  free: "Free place",
  markFree: "Mark free",
  undoFree: "Undo free",
  markedFree: "Marked as a free place",
  unmarkedFree: "Free place removed",
};

function gbp(n: number): string {
  return n % 1 === 0 ? `£${n.toFixed(0)}` : `£${n.toFixed(2)}`;
}

export function PaymentRoster({ matchId, rows, words = ENGLISH }: { matchId: string; rows: RosterRow[]; words?: RosterWords }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function run(userId: string, fn: () => Promise<string | null>) {
    setBusy(userId);
    try {
      const done = await fn();
      if (done) toast.success(done);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't update");
    } finally {
      setBusy(null);
    }
  }

  const markPaid = (userId: string) =>
    run(userId, async () => {
      await confirmDirectPayment(matchId, userId);
      return "Marked as paid";
    });
  const markFree = (userId: string) =>
    run(userId, async () => {
      const r = await markFeeWaived(matchId, userId);
      if (!r.ok) throw new Error(r.reason === "already-paid" ? "Already paid" : "Couldn't update");
      return words.markedFree;
    });
  const undoFree = (userId: string) =>
    run(userId, async () => {
      await undoFeeWaived(matchId, userId);
      return words.unmarkedFree;
    });

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 divide-y divide-slate-100">
      {rows.map((r) => (
        <div key={r.userId} className="flex items-center justify-between gap-3 px-4 py-3" data-testid={`collect-row-${r.userId}`}>
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
              ) : r.free ? (
                <>
                  <Gift className="w-3.5 h-3.5 text-sky-500" />
                  {words.free}
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
          {!r.paid && r.free && (
            <button
              onClick={() => undoFree(r.userId)}
              disabled={busy === r.userId}
              className="shrink-0 inline-flex items-center gap-1.5 px-3 h-9 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 text-sm font-medium disabled:opacity-50"
            >
              {busy === r.userId ? "Saving…" : words.undoFree}
            </button>
          )}
          {!r.paid && !r.free && (
            <div className="shrink-0 flex items-center gap-2">
              <button
                onClick={() => markFree(r.userId)}
                disabled={busy === r.userId}
                className="inline-flex items-center gap-1.5 px-3 h-9 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium disabled:opacity-50"
              >
                {words.markFree}
              </button>
              <button
                onClick={() => markPaid(r.userId)}
                disabled={busy === r.userId}
                className="inline-flex items-center gap-1.5 px-3 h-9 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium disabled:opacity-50"
              >
                {busy === r.userId ? "Saving…" : "Mark received"}
              </button>
            </div>
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
