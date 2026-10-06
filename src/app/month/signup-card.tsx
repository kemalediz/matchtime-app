"use client";

/**
 * One month on the player's sign-up page (/month, slice 3): where they
 * stand, and the three choices. Submits to `signUpForMonth`, which decides
 * everything again on the server (the cap, the lock, who may).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { signUpForMonth } from "@/app/actions/month-signup";
import { t } from "@/lib/i18n/t";
import type { SignupChoice } from "@/lib/month-signup-rules";

export function MonthSignupCard(props: {
  monthId: string;
  lang: string | null | undefined;
  title: string;
  games: string;
  /** The days of the month that have a game to tick. */
  days: number[];
  outcome: string;
  slot: number | null;
  myDays: number[];
  /** They have said they paid: the place is the organiser's to change. */
  locked: boolean;
}) {
  const s = t(props.lang);
  const router = useRouter();
  const [ticked, setTicked] = useState<number[]>(props.myDays);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(choice: SignupChoice) {
    setSaving(true);
    setError(null);
    try {
      const res = await signUpForMonth(props.monthId, choice, choice === "payg" ? ticked : []);
      if (!res.ok) setError(res.error === "closed" ? s.mmp_closed : s.mmp_error);
      else if (res.locked) setError(s.mmp_locked);
      router.refresh();
    } catch {
      setError(s.mmp_error);
    } finally {
      setSaving(false);
    }
  }

  const button = "h-10 rounded-lg px-3 text-sm font-medium disabled:opacity-40";
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-4" data-testid="month-signup" data-month={props.monthId}>
      <div>
        <h1 className="text-lg font-semibold text-slate-900">{props.title}</h1>
        <p className="text-sm text-slate-500">{props.games}</p>
      </div>
      <p className="text-sm text-slate-800" data-testid="month-state" data-outcome={props.outcome}>
        {s.mmp_state({ outcome: props.outcome, slot: props.slot, days: props.myDays.length > 0 ? props.myDays.join(", ") : null })}
      </p>
      {props.locked ? (
        <p className="text-sm text-slate-600" data-testid="month-locked">
          {s.mmp_locked}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={`${button} bg-slate-900 text-white`} disabled={saving} onClick={() => choose("in")} data-testid="month-in">
              {s.mmp_btn_in}
            </button>
            <button type="button" className={`${button} border border-slate-300 text-slate-700`} disabled={saving} onClick={() => choose("out")} data-testid="month-out">
              {s.mmp_btn_out}
            </button>
          </div>
          <div className="space-y-2 border-t border-slate-100 pt-3">
            <p className="text-sm text-slate-600">{s.mmp_payg_pick}</p>
            <div className="flex flex-wrap gap-3">
              {props.days.map((d) => (
                <label key={d} className="flex items-center gap-1 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={ticked.includes(d)}
                    onChange={(e) => setTicked(e.target.checked ? [...ticked, d] : ticked.filter((x) => x !== d))}
                    data-testid={`month-day-${d}`}
                  />
                  {d}
                </label>
              ))}
            </div>
            <button type="button" className={`${button} border border-slate-300 text-slate-700`} disabled={saving} onClick={() => choose("payg")} data-testid="month-payg">
              {s.mmp_btn_payg}
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="text-sm text-red-600" role="alert" data-testid="month-error">
          {error}
        </p>
      )}
    </section>
  );
}
