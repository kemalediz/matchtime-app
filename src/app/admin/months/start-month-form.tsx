"use client";

/**
 * "Start <month> now" on /admin/months (slice 2, plan 4.5): an organiser
 * opens a month that is already under way. Two ways to fill the table,
 * which can be mixed: PASTE the group's current list (read on the server
 * by the slice 1 reader; names matched to the club's players, a paid mark
 * read as "says paid", never as confirmed), or TICK the players. For each
 * one: regular or PAYG, whether they have paid (and how much), and any
 * credits they came into the month with.
 *
 * Submits to `startCurrentMonth`, which validates everything again on the
 * server and refuses with a reason this form puts into words. Starting a
 * month posts nothing in the group, and the form says so.
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { readMonthList, startCurrentMonth } from "@/app/actions/squad-month";
import { SectionInfo } from "@/components/info/section-info";
import { t } from "@/lib/i18n/t";
import { parsePounds, poundsText, type MemberKind, type MemberTier, type SeedPaid, type SeedRowInput } from "@/lib/squad-month-rules";

interface RowState {
  on: boolean;
  kind: MemberKind;
  paid: SeedPaid;
  amount: string;
  credits: string;
  /** From a pasted list only: the number as written, and a concession hint. */
  slot: number | null;
  tier: MemberTier;
}

const BLANK: RowState = { on: false, kind: "regular", paid: "none", amount: "", credits: "", slot: null, tier: "standard" };

const control =
  "h-9 px-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 disabled:opacity-40 disabled:bg-slate-50";

export function StartMonthForm(props: {
  orgId: string;
  lang: string | null | undefined;
  activityId: string;
  /** "October 2026", in the club's language. */
  month: string;
  /** The month's games on this fixture's weekday, and how many have kicked off. */
  games: number;
  played: number;
  players: { userId: string; name: string }[];
}) {
  const s = t(props.lang);
  const router = useRouter();
  const [games, setGames] = useState(String(props.games));
  const [played, setPlayed] = useState(String(props.played));
  const [share, setShare] = useState("");
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The pasted list. Reading it only fills the table; nothing is saved.
  const [pasted, setPasted] = useState("");
  const [reading, setReading] = useState(false);
  const [fromList, setFromList] = useState(false);
  const [pasteNote, setPasteNote] = useState<{ read: number; unmatched: string[]; otherMonth: boolean } | null>(null);
  const [pasteError, setPasteError] = useState<string | null>(null);

  async function readList() {
    setPasteError(null);
    setPasteNote(null);
    setReading(true);
    try {
      const res = await readMonthList(props.orgId, pasted);
      if (!res.ok) return setPasteError(res.error === "not-a-list" ? s.mth_paste_not_list : s.mth_start_error({ key: res.error }));
      const next: Record<string, RowState> = {};
      for (const r of res.rows) {
        next[r.userId] = {
          on: true,
          kind: r.kind,
          paid: r.paid,
          amount: poundsText(r.paidAmountPence),
          credits: "",
          slot: r.slot,
          tier: r.tier,
        };
      }
      setRows(next);
      setFromList(true);
      setPasteNote({ read: res.rows.length, unmatched: res.unmatched.map((u) => u.name), otherMonth: res.monthMismatch });
    } catch {
      setPasteError(s.mth_start_error({ key: "failed" }));
    } finally {
      setReading(false);
    }
  }

  const row = (userId: string): RowState => rows[userId] ?? BLANK;
  const patch = (userId: string, next: Partial<RowState>) =>
    setRows((prev) => ({ ...prev, [userId]: { ...(prev[userId] ?? BLANK), ...next } }));

  const counts = useMemo(() => {
    const on = Object.values(rows).filter((r) => r.on);
    return { regulars: on.filter((r) => r.kind === "regular").length, payg: on.filter((r) => r.kind === "payg").length };
  }, [rows]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const whole = (v: string): number | null => (/^\d+$/.test(v.trim()) ? Number(v) : null);
    const gamesScheduled = whole(games);
    const gamesPlayed = whole(played);
    if (gamesScheduled === null || gamesPlayed === null) return setError(s.mth_start_error({ key: "bad-games" }));
    const sharePence = share.trim() === "" ? null : parsePounds(share);
    if (share.trim() !== "" && sharePence === null) return setError(s.mth_start_error({ key: "bad-share" }));

    const seedRows: SeedRowInput[] = [];
    for (const p of props.players) {
      const r = row(p.userId);
      if (!r.on) continue;
      if (r.kind === "payg") {
        seedRows.push({ userId: p.userId, kind: "payg", slot: r.slot });
        continue;
      }
      const amount = r.amount.trim() === "" ? null : parsePounds(r.amount);
      if (r.amount.trim() !== "" && amount === null) return setError(s.mth_start_error({ key: "bad-amount" }));
      const credits = r.credits.trim() === "" ? 0 : whole(r.credits);
      if (credits === null) return setError(s.mth_start_error({ key: "bad-credits" }));
      seedRows.push({
        userId: p.userId,
        kind: "regular",
        tier: r.tier,
        slot: r.slot,
        paid: r.paid,
        paidAmountPence: r.paid === "none" ? null : amount,
        creditsCarriedIn: credits,
      });
    }
    if (seedRows.length === 0) return setError(s.mth_start_error({ key: "no-players" }));

    setSaving(true);
    try {
      const res = await startCurrentMonth(props.orgId, {
        activityId: props.activityId,
        gamesScheduled,
        gamesPlayed,
        sharePerGamePence: sharePence,
        source: fromList ? "seed-list" : "seed-tick",
        rows: seedRows,
      });
      if (!res.ok) return setError(s.mth_start_error({ key: res.error }));
      toast.success(s.mth_started({ month: props.month }));
      router.refresh();
    } catch {
      setError(s.mth_start_error({ key: "failed" }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" data-testid="start-month-form">
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-2" data-testid="start-paste">
        <div className="flex items-center gap-1 text-sm font-medium text-slate-800">
          <label htmlFor={`paste-${props.activityId}`}>{s.mth_paste_label}</label>
          <SectionInfo k="mth_paste" lang={props.lang} />
        </div>
        <p className="text-xs text-slate-500">{s.mth_paste_hint}</p>
        <textarea
          id={`paste-${props.activityId}`}
          data-testid="start-paste-text"
          rows={5}
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          className="w-full max-w-xl px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 font-mono"
        />
        <div>
          <button
            type="button"
            data-testid="start-paste-read"
            disabled={reading || pasted.trim() === ""}
            onClick={readList}
            className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-sm font-medium text-slate-700 disabled:opacity-50"
          >
            {s.mth_paste_button}
          </button>
        </div>
        {pasteError && (
          <p role="alert" data-testid="start-paste-error" className="text-sm text-red-600">
            {pasteError}
          </p>
        )}
        {pasteNote && (
          <div className="text-sm text-slate-700 space-y-1" data-testid="start-paste-note">
            <p>{s.mth_paste_read({ count: pasteNote.read })}</p>
            {pasteNote.unmatched.length > 0 && (
              <p className="text-amber-800" data-testid="start-paste-unmatched">
                {s.mth_paste_unmatched({ names: pasteNote.unmatched.join(", ") })}
              </p>
            )}
            {pasteNote.otherMonth && (
              <p className="text-amber-800" data-testid="start-paste-month">
                {s.mth_paste_month}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-4">
        <label className="text-sm text-slate-700">
          <span className="block text-xs font-medium text-slate-500 mb-1">{s.mth_games_label}</span>
          <input data-testid="start-games" inputMode="numeric" value={games} onChange={(e) => setGames(e.target.value)} className={`w-20 ${control}`} />
        </label>
        <label className="text-sm text-slate-700">
          <span className="block text-xs font-medium text-slate-500 mb-1">{s.mth_played_label}</span>
          <input data-testid="start-played" inputMode="numeric" value={played} onChange={(e) => setPlayed(e.target.value)} className={`w-20 ${control}`} />
        </label>
        <label className="text-sm text-slate-700">
          <span className="block text-xs font-medium text-slate-500 mb-1">{s.mth_share_label}</span>
          <input
            data-testid="start-share"
            inputMode="decimal"
            value={share}
            onChange={(e) => setShare(e.target.value)}
            placeholder="7.50"
            className={`w-24 ${control}`}
          />
        </label>
      </div>
      <p className="text-xs text-slate-500">{s.mth_share_hint}</p>

      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="start-players">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-100">
              <th className="py-2 pr-3 font-medium">{s.mth_col_in}</th>
              <th className="py-2 pr-3 font-medium">{s.mth_col_player}</th>
              <th className="py-2 pr-3 font-medium">{s.mth_col_type}</th>
              <th className="py-2 pr-3 font-medium">
                <span className="inline-flex items-center gap-1">
                  {s.mth_col_paid}
                  <SectionInfo k="mth_paid" lang={props.lang} />
                </span>
              </th>
              <th className="py-2 pr-3 font-medium">{s.mth_col_amount}</th>
              <th className="py-2 font-medium">
                <span className="inline-flex items-center gap-1">
                  {s.mth_col_credits}
                  <SectionInfo k="mth_credits" lang={props.lang} />
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {props.players.map((p) => {
              const r = row(p.userId);
              const regular = r.on && r.kind === "regular";
              return (
                <tr key={p.userId} className="border-b border-slate-50 last:border-0" data-testid="start-row" data-user={p.userId}>
                  <td className="py-1.5 pr-3">
                    <input
                      type="checkbox"
                      aria-label={p.name}
                      checked={r.on}
                      onChange={(e) => patch(p.userId, { on: e.target.checked })}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                  </td>
                  <td className="py-1.5 pr-3 font-medium text-slate-800 whitespace-nowrap">{p.name}</td>
                  <td className="py-1.5 pr-3">
                    <select
                      aria-label={`${s.mth_col_type}: ${p.name}`}
                      data-testid="start-kind"
                      value={r.kind}
                      disabled={!r.on}
                      onChange={(e) => patch(p.userId, { kind: e.target.value as MemberKind })}
                      className={control}
                    >
                      <option value="regular">{s.mth_kind_regular}</option>
                      <option value="payg">{s.mth_kind_payg}</option>
                    </select>
                  </td>
                  <td className="py-1.5 pr-3">
                    <select
                      aria-label={`${s.mth_col_paid} ${p.name}`}
                      data-testid="start-paid"
                      value={r.paid}
                      disabled={!regular}
                      onChange={(e) => patch(p.userId, { paid: e.target.value as SeedPaid })}
                      className={control}
                    >
                      <option value="none">{s.mth_paid_none}</option>
                      <option value="claimed">{s.mth_paid_claimed}</option>
                      <option value="confirmed">{s.mth_paid_confirmed}</option>
                    </select>
                  </td>
                  <td className="py-1.5 pr-3">
                    <input
                      aria-label={`${s.mth_col_amount}: ${p.name}`}
                      data-testid="start-amount"
                      inputMode="decimal"
                      value={r.amount}
                      disabled={!regular || r.paid === "none"}
                      onChange={(e) => patch(p.userId, { amount: e.target.value })}
                      className={`w-24 ${control}`}
                    />
                  </td>
                  <td className="py-1.5">
                    <input
                      aria-label={`${s.mth_col_credits}: ${p.name}`}
                      data-testid="start-credits"
                      inputMode="numeric"
                      value={r.credits}
                      disabled={!regular}
                      onChange={(e) => patch(p.userId, { credits: e.target.value })}
                      placeholder="0"
                      className={`w-16 ${control}`}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {error && (
        <p role="alert" data-testid="start-error" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          data-testid="start-submit"
          disabled={saving}
          className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-50"
        >
          {s.mth_start_button({ month: props.month })}
        </button>
        <span className="text-xs text-slate-500" data-testid="start-count">
          {s.mth_selected_count(counts)}
        </span>
      </div>
      <p className="text-xs text-slate-500">{s.mth_nothing_posts}</p>
    </form>
  );
}
