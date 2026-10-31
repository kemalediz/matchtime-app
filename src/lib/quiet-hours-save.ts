/**
 * SAVING A CLUB'S QUIET HOURS: the one core (2026-10-31). Used by the
 * settings page's server action (`src/app/actions/quiet-hours.ts`, which
 * keeps its own sign-in and admin check) and by an organiser tagging
 * MatchTime in WhatsApp (`quiet-hours-words.ts`), so both do exactly the
 * same thing: validate, update the club, and re-time the unsent messages
 * the OLD hours were holding, in one transaction.
 *
 * Off keeps the saved times, so switching back on restores them.
 *
 * The re-timing rule, and how a hold is told apart from a deliberate
 * schedule, are in `quiet-hours-retime.ts`. Each update is guarded on the
 * club, unsent, and the time read, so a job the Pi sends meanwhile is never
 * touched. `released` counts the holds that now go out at once (their new
 * `sendAfter` is null); a hold moved to a different end time is re-timed
 * but not released. Logs ids only.
 */
import { db } from "./db";
import { QUIET_HOURS_SELECT, quietHoursOf, validateQuietHours, type QuietHours } from "./message-hours";
import { retimeQuietHoursHolds } from "./quiet-hours-retime";

export type QuietHoursInput = { enabled: boolean; from?: string; to?: string };

export type QuietHoursSaved =
  | { ok: true; before: QuietHours; value: QuietHours; released: number; retimed: string[] }
  | { ok: false; error: "bad-time" | "same-time" };

export async function saveQuietHours(p: { orgId: string; input: QuietHoursInput; now: Date }): Promise<QuietHoursSaved> {
  const v = validateQuietHours(p.input);
  if (!v.ok) return v;
  const { orgId, now } = p;
  const data = v.value.enabled
    ? { quietHoursEnabled: true, quietHoursFrom: v.value.from, quietHoursTo: v.value.to }
    : { quietHoursEnabled: false };
  const { before, row, retimed, released } = await db.$transaction(async (tx) => {
    const before = await tx.organisation.findUnique({ where: { id: orgId }, select: QUIET_HOURS_SELECT });
    const row = await tx.organisation.update({ where: { id: orgId }, data, select: QUIET_HOURS_SELECT });
    const jobs = await tx.botJob.findMany({
      where: { orgId, sentAt: null, sendAfter: { gt: now } },
      select: { id: true, createdAt: true, sendAfter: true },
    });
    const changes = retimeQuietHoursHolds({ jobs, oldQuiet: quietHoursOf(before), newQuiet: quietHoursOf(row), now });
    const retimed: string[] = [];
    let released = 0;
    for (const c of changes) {
      const old = jobs.find((j) => j.id === c.id)!.sendAfter;
      const r = await tx.botJob.updateMany({
        where: { id: c.id, orgId, sentAt: null, sendAfter: old },
        data: { sendAfter: c.sendAfter },
      });
      if (r.count > 0) {
        retimed.push(c.id);
        if (c.sendAfter === null) released++;
      }
    }
    return { before, row, retimed, released };
  });
  if (retimed.length) console.log(`[quiet-hours] org=${orgId} re-timed ${retimed.length} held job(s), ${released} released: ${retimed.join(",")}`);
  return { ok: true, before: quietHoursOf(before), value: quietHoursOf(row), released, retimed };
}
