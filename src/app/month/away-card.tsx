"use client";

/**
 * "Games I can't make" on the player's month page (/month, slice 6, plan
 * 5.2 and 9.3): a regular ticks the games of the month they will miss,
 * ahead of time. Submits to `saveAwayWeeks`, which decides everything
 * again on the server (only their own, only a game the squad is not on
 * yet). No model reads anything: these are ticks.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveAwayWeeks } from "@/app/actions/month-close";
import { t } from "@/lib/i18n/t";

export interface AwayGameProp {
  /** The London day, "YYYY-MM-DD". */
  day: string;
  /** Already in words, in the club's language ("Mon 26 Oct"). */
  label: string;
  ticked: boolean;
  /** The squad is not on this game yet, so it can be ticked here. */
  editable: boolean;
}

export function AwayWeeksCard(props: { monthId: string; lang: string | null | undefined; creditRule: string; games: AwayGameProp[] }) {
  const s = t(props.lang);
  const router = useRouter();
  const [ticked, setTicked] = useState<string[]>(props.games.filter((g) => g.ticked).map((g) => g.day));
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const editable = props.games.filter((g) => g.editable);
  const seeded = props.games.filter((g) => !g.editable);

  async function save() {
    setSaving(true);
    setNote(null);
    try {
      const res = await saveAwayWeeks(props.monthId, ticked);
      setNote(res.ok ? { ok: true, text: s.mmp_away_saved } : { ok: false, text: s.mmp_error });
      router.refresh();
    } catch {
      setNote({ ok: false, text: s.mmp_error });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-3" data-testid="month-away" data-month={props.monthId}>
      <div>
        <h2 className="text-base font-semibold text-slate-900">{s.mmp_away_title}</h2>
        <p className="text-sm text-slate-500">{s.mmp_away_lead({ kind: props.creditRule })}</p>
      </div>
      {editable.length === 0 ? (
        <p className="text-sm text-slate-600" data-testid="month-away-none">
          {s.mmp_away_none}
        </p>
      ) : (
        <div className="space-y-2">
          {editable.map((g) => (
            <label key={g.day} className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={ticked.includes(g.day)}
                onChange={(e) => setTicked(e.target.checked ? [...ticked, g.day] : ticked.filter((d) => d !== g.day))}
                data-testid={`month-away-${g.day}`}
              />
              {g.label}
            </label>
          ))}
          <button type="button" className="h-10 rounded-lg bg-slate-900 px-3 text-sm font-medium text-white disabled:opacity-40" disabled={saving} onClick={save} data-testid="month-away-save">
            {s.mmp_away_save}
          </button>
        </div>
      )}
      {seeded.map((g) => (
        <p key={g.day} className="text-sm text-slate-500" data-testid="month-away-seeded">
          {s.mmp_away_seeded({ day: g.label })}
        </p>
      ))}
      {note && (
        <p className={`text-sm ${note.ok ? "text-green-700" : "text-red-600"}`} role={note.ok ? "status" : "alert"} data-testid="month-away-note">
          {note.text}
        </p>
      )}
    </section>
  );
}
