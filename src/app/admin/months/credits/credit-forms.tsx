"use client";

/**
 * The organiser's "Add credit" and "Remove credit" on the credits ledger
 * (slice 6, plan 9.2). Each asks for a reason. They submit to
 * `addCredit` / `removeCreditAction`, which check the admin and the club
 * again and refuse with a reason this form puts into words.
 *
 * "Add credit" sends a token made once per press, so a double click or a
 * retried request writes the credit once.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { addCredit, removeCreditAction } from "@/app/actions/month-close";
import { t } from "@/lib/i18n/t";
import { CREDIT_NOTE_MAX, MAX_MANUAL_CREDIT_GAMES } from "@/lib/month-close-rules";

const control = "h-9 px-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 disabled:opacity-40";

function newToken(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function AddCreditForm(props: { orgId: string; lang: string | null | undefined; players: { userId: string; name: string }[] }) {
  const s = t(props.lang);
  const router = useRouter();
  const [userId, setUserId] = useState("");
  const [games, setGames] = useState("1");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await addCredit(props.orgId, { userId, games: Number(games), reason, token: newToken() });
      if (!res.ok) setError(s.mcr_error({ key: res.error }));
      else {
        setReason("");
        setGames("1");
        router.refresh();
      }
    } catch {
      setError(s.mcr_error({ key: "" }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-3" data-testid="credit-add">
      <h3 className="text-sm font-semibold text-slate-800">{s.mcr_add_title}</h3>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-600 space-y-1">
          <span className="block">{s.mcr_add_player}</span>
          <select className={control} value={userId} onChange={(e) => setUserId(e.target.value)} data-testid="credit-add-player">
            <option value="">{s.mcr_add_player}</option>
            {props.players.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-600 space-y-1">
          <span className="block">{s.mcr_add_games}</span>
          <input className={`${control} w-20`} type="number" min={1} max={MAX_MANUAL_CREDIT_GAMES} value={games} onChange={(e) => setGames(e.target.value)} data-testid="credit-add-games" />
        </label>
        <label className="text-xs text-slate-600 space-y-1 grow">
          <span className="block">{s.mcr_add_reason}</span>
          <input
            className={`${control} w-full min-w-64`}
            maxLength={CREDIT_NOTE_MAX}
            placeholder={s.mcr_add_reason_hint}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            data-testid="credit-add-reason"
          />
        </label>
        <button type="button" className="h-9 rounded-lg bg-slate-900 px-3 text-sm font-medium text-white disabled:opacity-40" disabled={saving || !userId} onClick={save} data-testid="credit-add-save">
          {s.mcr_add_btn}
        </button>
      </div>
      {error && (
        <p className="text-sm text-red-600" role="alert" data-testid="credit-add-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function RemoveCreditButton(props: { orgId: string; creditId: string; lang: string | null | undefined }) {
  const s = t(props.lang);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const button = "rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-40";

  async function remove() {
    setSaving(true);
    setError(null);
    try {
      const res = await removeCreditAction(props.orgId, props.creditId, reason);
      if (!res.ok) setError(s.mcr_error({ key: res.error }));
      else {
        setOpen(false);
        router.refresh();
      }
    } catch {
      setError(s.mcr_error({ key: "" }));
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className={button} onClick={() => setOpen(true)} data-testid="credit-remove">
        {s.mcr_remove_btn}
      </button>
    );
  }
  return (
    <div className="space-y-1.5" data-testid="credit-remove-form">
      <input
        className={`${control} h-8 w-56`}
        maxLength={CREDIT_NOTE_MAX}
        aria-label={s.mcr_remove_reason}
        placeholder={s.mcr_remove_reason}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        data-testid="credit-remove-reason"
      />
      <div className="flex gap-1.5">
        <button type="button" className={button} disabled={saving} onClick={remove} data-testid="credit-remove-confirm">
          {s.mcr_remove_confirm}
        </button>
        <button type="button" className={button} disabled={saving} onClick={() => setOpen(false)} data-testid="credit-remove-cancel">
          {s.mcr_cancel}
        </button>
      </div>
      {error && (
        <p className="text-xs text-red-600" role="alert" data-testid="credit-remove-error">
          {error}
        </p>
      )}
    </div>
  );
}
