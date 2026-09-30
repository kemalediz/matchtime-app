"use client";

/**
 * The two weekly-deadline rows of /admin/settings "Weekly routine"
 * (2026-09-30, slice 3 of MDs/friday-group-features-plan-2026-09-30.md,
 * section 5): the drop-out deadline and the list publish time, each a
 * weekday and a London time, saved through `setWeeklyRoutine`. Its own
 * component so the page only renders it; slice 2's rows sit beside it.
 *
 * Words from the club's language table, each row with its ⓘ. A refusal
 * (half a pair, outside 08:00 to 21:30, drop-out not before publish, a
 * match-day time after kickoff) is shown under the row and nothing is
 * saved.
 */
import { useState } from "react";
import { toast } from "sonner";
import { setWeeklyRoutine } from "@/app/actions/org";
import { InfoButton } from "@/components/stats/info-button";
import { t } from "@/lib/i18n/t";
import type { WeeklyDeadlineError } from "@/lib/weekly-deadlines";

export interface DayTimeValue {
  day: number;
  time: string;
}

type RowKey = "dropOutDeadline" | "listPublish";

const ERROR_KEY = {
  incomplete: "wd_err_incomplete",
  "bad-value": "wd_err_bad_value",
  "outside-hours": "wd_err_outside_hours",
  order: "wd_err_order",
  "after-kickoff": "wd_err_after_kickoff",
} as const satisfies Record<WeeklyDeadlineError, string>;

export function WeeklyDeadlineRows(props: {
  orgId: string;
  language: string | null | undefined;
  dropOutDeadline: DayTimeValue | null;
  listPublish: DayTimeValue | null;
}) {
  const s = t(props.language);
  return (
    <>
      <DeadlineRow
        rowKey="dropOutDeadline"
        testId="wd-dropout"
        orgId={props.orgId}
        language={props.language}
        label={s.wd_dropout_label}
        blurb={s.wd_dropout_blurb}
        info={s.wd_dropout_info}
        initial={props.dropOutDeadline}
      />
      <DeadlineRow
        rowKey="listPublish"
        testId="wd-publish"
        orgId={props.orgId}
        language={props.language}
        label={s.wd_publish_label}
        blurb={s.wd_publish_blurb}
        info={s.wd_publish_info}
        initial={props.listPublish}
      />
    </>
  );
}

function DeadlineRow(props: {
  rowKey: RowKey;
  testId: string;
  orgId: string;
  language: string | null | undefined;
  label: string;
  blurb: string;
  info: string;
  initial: DayTimeValue | null;
}) {
  const s = t(props.language);
  const [day, setDay] = useState<string>(props.initial ? String(props.initial.day) : "");
  const [time, setTime] = useState<string>(props.initial?.time ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(next: { day: string; time: string }) {
    setSaving(true);
    setError(null);
    const value = next.day === "" && next.time === "" ? null : { day: next.day === "" ? null : Number(next.day), time: next.time || null };
    try {
      const res = await setWeeklyRoutine(props.orgId, { [props.rowKey]: value } as Parameters<typeof setWeeklyRoutine>[1]);
      if (!res.ok) {
        setError(s[ERROR_KEY[res.error]]);
        return;
      }
      const saved = res[props.rowKey];
      setDay(saved ? String(saved.day) : "");
      setTime(saved?.time ?? "");
      toast.success(s.wd_saved);
    } catch {
      toast.error(s.wr_save_failed);
    } finally {
      setSaving(false);
    }
  }

  const control =
    "h-10 px-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50";

  return (
    <div className="py-3" data-testid={props.testId}>
      <div className="flex items-center gap-1 text-sm font-medium text-slate-800">
        {props.label}
        <InfoButton title={props.label}>
          <p>{props.info}</p>
        </InfoButton>
      </div>
      <p className="text-xs text-slate-500">{props.blurb}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          aria-label={`${props.label}: ${s.wd_day_label}`}
          data-testid={`${props.testId}-day`}
          value={day}
          disabled={saving}
          onChange={(e) => setDay(e.target.value)}
          className={control}
        >
          <option value="">{s.wd_not_set}</option>
          {/* Monday first, as a week reads. */}
          {[1, 2, 3, 4, 5, 6, 0].map((dow) => (
            <option key={dow} value={String(dow)}>
              {s.wd_weekday({ dow })}
            </option>
          ))}
        </select>
        <input
          type="time"
          aria-label={`${props.label}: ${s.wd_time_label}`}
          data-testid={`${props.testId}-time`}
          value={time}
          disabled={saving}
          onChange={(e) => setTime(e.target.value)}
          className={control}
        />
        <button
          type="button"
          data-testid={`${props.testId}-save`}
          disabled={saving}
          onClick={() => save({ day, time })}
          className="h-10 px-4 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          {s.wd_save}
        </button>
        {(day !== "" || time !== "") && (
          <button
            type="button"
            data-testid={`${props.testId}-clear`}
            disabled={saving}
            onClick={() => save({ day: "", time: "" })}
            className="h-10 px-3 rounded-lg border border-slate-200 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            {s.wd_clear}
          </button>
        )}
      </div>
      {error && (
        <p className="mt-2 text-xs text-red-600" role="alert" data-testid={`${props.testId}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}
