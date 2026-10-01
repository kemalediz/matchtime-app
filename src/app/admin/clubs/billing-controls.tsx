"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { setClubPlanAction, startFreeMonthAction, type BillingAdminResult } from "@/app/actions/club-billing-admin";

/**
 * The owner page's club fee controls (club fee billing, slice B2, plan
 * 8.3). The server actions authorise for real (superadmin) and go through
 * the billing module; these only ask, show the answer and refresh.
 */
function useAction() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<BillingAdminResult>) =>
    start(async () => {
      try {
        const r = await fn();
        if (r.ok) toast.success(r.message);
        else toast.error(r.message);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Something went wrong");
      }
    });
  return { pending, run };
}

export function PlanControl({
  orgId,
  club,
  plan,
  pricePence,
}: {
  orgId: string;
  club: string;
  plan: string;
  pricePence: number | null;
}) {
  const { pending, run } = useAction();
  const [choice, setChoice] = useState(plan);
  const [price, setPrice] = useState(pricePence ? (pricePence / 100).toFixed(2) : "5.00");
  const unchanged = choice === plan && (choice !== "custom" || price === (pricePence ? (pricePence / 100).toFixed(2) : ""));

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`Plan for ${club}`}>
      <label className="text-sm text-slate-600" htmlFor={`plan-${orgId}`}>
        Plan
      </label>
      <select
        id={`plan-${orgId}`}
        value={choice}
        onChange={(e) => setChoice(e.target.value)}
        disabled={pending}
        className="h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-700"
      >
        <option value="standard">Standard £9.99</option>
        <option value="free">Free</option>
        <option value="custom">Custom</option>
      </select>
      {choice === "custom" && (
        <span className="inline-flex items-center gap-1 text-sm text-slate-600">
          £
          <input
            aria-label="Custom price in pounds"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            disabled={pending}
            className="h-9 w-20 rounded-lg border border-slate-300 bg-white px-2 text-sm"
          />
          a month
        </span>
      )}
      <button
        type="button"
        disabled={pending || unchanged}
        onClick={() => {
          if (choice === "free" && plan !== "free") {
            const ok = window.confirm(
              `Make ${club} Free? It is never billed while on Free, and a free month it is in now ends for good.`,
            );
            if (!ok) return;
          }
          run(() => setClubPlanAction(orgId, choice, choice === "custom" ? price : null));
        }}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        Save plan
      </button>
    </div>
  );
}

export function StartFreeMonthButton({ orgId, club, enabled }: { orgId: string; club: string; enabled: boolean }) {
  const { pending, run } = useAction();
  return (
    <button
      type="button"
      disabled={pending || !enabled}
      title={enabled ? undefined : "Billing is switched off (BILLING_ENABLED)"}
      onClick={() => {
        if (window.confirm(`Start ${club}'s free month now? It runs 30 days from now, and a club gets only one.`)) {
          run(() => startFreeMonthAction(orgId));
        }
      }}
      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
    >
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarPlus className="h-4 w-4" />}
      Start free month
    </button>
  );
}
