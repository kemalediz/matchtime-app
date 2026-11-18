"use client";

/**
 * The coverage editor (2026-11-16, Kemal) on /admin/months: how many of
 * the month's games a regular covers, from the games left to the whole
 * month, either way. A player added after the start who had paid the whole
 * month is raised to it here; one given the whole month by mistake goes
 * back to the games left. Saving prices them again with the existing
 * pricing (`setMonthMemberCoverage`); nothing here records a payment. The
 * server refuses anything outside the bounds, in words this form shows.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { setMemberCoverage } from "@/app/actions/squad-month";
import { monthSetupCopy } from "@/lib/i18n/month-setup";

export function MemberCoverageForm(props: {
  orgId: string;
  monthId: string;
  userId: string;
  lang: string | null | undefined;
  covered: number;
  /**
   * The choices, exactly within the bounds the server checks
   * (`memberCoverageBounds`), shown in playable games (`coverageOptions`,
   * round 3, item 5): `value` is what is stored, `games of of` what the
   * organiser reads. What he covers now is always one of them.
   */
  options: Array<{ value: number; games: number; of: number; least: boolean; wholeMonth: boolean }>;
}) {
  const c = monthSetupCopy(props.lang);
  const router = useRouter();
  const [value, setValue] = useState(String(props.covered));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = props.options;
  const changed = Number(value) !== props.covered;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const res = await setMemberCoverage(props.orgId, props.monthId, props.userId, Number(value));
      if (!res.ok) return setError(c.cover_error({ key: res.error }));
      toast.success(c.cover_saved);
      router.refresh();
    } catch {
      setError(c.cover_error({ key: "failed" }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="mt-1 flex flex-wrap items-center gap-1.5" data-testid="member-cover-form">
      <label className="text-xs text-slate-500" htmlFor={`cover-${props.monthId}-${props.userId}`}>
        {c.cover_label}
      </label>
      <select
        id={`cover-${props.monthId}-${props.userId}`}
        data-testid="member-cover-select"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="h-8 rounded-md border border-slate-200 bg-white px-1.5 text-xs text-slate-700"
      >
        {options.map((o) => (
          <option key={o.value} value={String(o.value)}>
            {c.cover_opt({ games: o.games, of: o.of, left: o.least, whole: o.wholeMonth })}
          </option>
        ))}
      </select>
      {changed && (
        <button
          type="submit"
          data-testid="member-cover-save"
          disabled={saving}
          className="px-2 py-1 rounded-md border border-slate-300 bg-white hover:bg-slate-100 text-xs font-medium text-slate-700 disabled:opacity-50"
        >
          {c.cover_save}
        </button>
      )}
      {error && (
        <span role="alert" data-testid="member-cover-error" className="text-xs text-red-600">
          {error}
        </span>
      )}
    </form>
  );
}
