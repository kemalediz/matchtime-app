/**
 * The weekly-deadline half of `setWeeklyRoutine` (2026-09-30, slice 3 of
 * MDs/friday-group-features-plan-2026-09-30.md, sections 3.1 and 5).
 * Kept out of `actions/org.ts` so the action only wires it in.
 *
 * A patch sets or clears either pair; it is validated TOGETHER with the
 * pair already saved (a new drop-out deadline must still come before the
 * saved publish time) and against every active activity of the club.
 * Validation failures come back as a code the settings page renders in
 * the club's language; nothing is written.
 */
import { db } from "./db";
import {
  validateWeeklyDeadlines,
  type WeeklyDeadlineError,
  type WeeklyDeadlineSettings,
} from "./weekly-deadlines";

export interface DayTime {
  day: number;
  time: string;
}

export interface WeeklyDeadlinesPatch {
  /** null clears it. */
  dropOutDeadline?: DayTime | null;
  listPublish?: DayTime | null;
}

export type WeeklyDeadlinesData = Partial<WeeklyDeadlineSettings>;

export function hasWeeklyDeadlinesPatch(patch: object | null | undefined): boolean {
  return !!patch && ("dropOutDeadline" in patch || "listPublish" in patch);
}

/** Row to the shape the page reads. */
export function weeklyDeadlinesView(row: WeeklyDeadlineSettings): {
  dropOutDeadline: DayTime | null;
  listPublish: DayTime | null;
} {
  const pair = (day: number | null, time: string | null) => (day != null && time != null ? { day, time } : null);
  return {
    dropOutDeadline: pair(row.dropOutDeadlineDay, row.dropOutDeadlineTime),
    listPublish: pair(row.listPublishDay, row.listPublishTime),
  };
}

/** A pair from the wire: null clears; anything malformed is kept as-is
 *  so validation reports "bad-value" rather than silently dropping it. */
function columns(v: unknown): [unknown, unknown] {
  if (v === null) return [null, null];
  const o = (v ?? {}) as { day?: unknown; time?: unknown };
  return [o.day ?? null, o.time ?? null];
}

export async function prepareWeeklyDeadlinesPatch(
  orgId: string,
  patch: WeeklyDeadlinesPatch,
): Promise<{ data: WeeklyDeadlinesData; error: WeeklyDeadlineError | null }> {
  const saved = await db.organisation.findUnique({
    where: { id: orgId },
    select: { dropOutDeadlineDay: true, dropOutDeadlineTime: true, listPublishDay: true, listPublishTime: true },
  });
  const data: Record<string, unknown> = {};
  if ("dropOutDeadline" in patch) {
    [data.dropOutDeadlineDay, data.dropOutDeadlineTime] = columns(patch.dropOutDeadline);
  }
  if ("listPublish" in patch) {
    [data.listPublishDay, data.listPublishTime] = columns(patch.listPublish);
  }
  const next = { ...(saved ?? {}), ...data } as WeeklyDeadlineSettings;
  const activities = await db.activity.findMany({
    where: { orgId, isActive: true },
    select: { dayOfWeek: true, time: true },
  });
  const error = validateWeeklyDeadlines(next, activities);
  return { data: data as WeeklyDeadlinesData, error };
}
