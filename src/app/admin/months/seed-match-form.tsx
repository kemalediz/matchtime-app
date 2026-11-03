"use client";

/**
 * "Who is who on your list" on /admin/months (2026-11-03): each name on the
 * organiser's posted list that matched nobody, with a picker of who it
 * could be (the club's members with no name, by phone: this page is for
 * organisers only). Saving puts the member on the draft with that line and
 * names him; the server checks everything again (`matchSeedListName`).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { matchSeedListName } from "@/app/actions/month-seed-match";
import { t } from "@/lib/i18n/t";

export function SeedMatchRow(props: {
  orgId: string;
  proposalId: string;
  lang: string | null | undefined;
  ref_: string;
  name: string;
  options: Array<{ userId: string; label: string }>;
}) {
  const s = t(props.lang);
  const router = useRouter();
  const [userId, setUserId] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!userId) return;
    setSaving(true);
    try {
      const res = await matchSeedListName(props.orgId, props.proposalId, props.ref_, userId);
      if (!res.ok) toast.error(s.mth_act_error);
      router.refresh();
    } catch {
      toast.error(s.mth_act_error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-2 py-1.5" data-testid="seed-match-row" data-ref={props.ref_}>
      <span className="min-w-24 font-medium text-slate-800" data-testid="seed-match-name">
        {props.name}
      </span>
      {props.options.length === 0 ? (
        <span className="text-sm text-slate-500">{s.mth_match_none}</span>
      ) : (
        <>
          <select
            className="rounded-md border border-slate-200 px-2 py-1 text-sm"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            disabled={saving}
            aria-label={`${s.mth_match_pick}: ${props.name}`}
            data-testid="seed-match-pick"
          >
            <option value="">{s.mth_match_pick}</option>
            {props.options.map((o) => (
              <option key={o.userId} value={o.userId}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            disabled={saving || !userId}
            onClick={save}
            data-testid="seed-match-save"
          >
            {s.mth_match_save}
          </button>
        </>
      )}
    </li>
  );
}
