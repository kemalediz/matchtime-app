/**
 * RE-TIMING HELD MESSAGES when a club saves new quiet hours (Kemal,
 * 2026-10-28). PURE: no database, no clock of its own. The adapter is
 * `setQuietHours` (src/app/actions/quiet-hours.ts), which runs this in the
 * same transaction as the settings update.
 *
 * A queued BotJob keeps the `sendAfter` stamped when it was queued, and the
 * dispatch checks only that stamp. So a club that shortened or switched off
 * its quiet hours still waited for the old end.
 *
 * HOW A QUIET HOURS HOLD IS RECOGNISED. BotJob has no column saying why it
 * is held, and the jobs already queued when this shipped must be reached
 * too. Every club quiet hours hold is stamped by `messageHoursSendAfter`
 * (directly, or through `adminNoticeSendAfter` / `quietHoldOf`) from the
 * moment it was queued. So a job is a hold when its `sendAfter` is EXACTLY,
 * to the millisecond, `messageHoursSendAfter(createdAt, oldQuiet)`: it was
 * created inside the club's quiet hours AND is held to their end on that
 * London day. What this rules out:
 *   - the team sheet redraw delay (now + 2 minutes), anything on a pacing
 *     or rate limit, and the pool's own quiet hours (PlatformJob, a
 *     different table): a different time;
 *   - a deliberate schedule for the quiet end time, made in the daytime:
 *     created outside the quiet hours;
 *   - a job already due, or already sent: the adapter reads only unsent
 *     jobs still held past now.
 * The one look-alike left is a personal reminder asked for during the
 * night for exactly the quiet end time; it would move with the quiet end.
 *
 * WHAT THE NEW TIME IS. Recomputed from the moment of saving: inside the
 * new quiet hours, their end; outside them (or with them off), at once
 * (`sendAfter` null). Shorter hours release sooner, longer hours hold later.
 */
import { messageHoursSendAfter, type QuietHours } from "./message-hours";

export interface QueuedJob {
  id: string;
  createdAt: Date;
  sendAfter: Date | null;
}

/** Was this job held by the club's quiet hours `quiet` (the hours in force when it was queued)? */
export function isQuietHoursHold(job: QueuedJob, quiet: QuietHours): boolean {
  if (!job.sendAfter) return false;
  const expected = messageHoursSendAfter(job.createdAt, quiet);
  return expected !== null && expected.getTime() === job.sendAfter.getTime();
}

/** The quiet hours holds among `jobs` whose time changes, with their new `sendAfter`. */
export function retimeQuietHoursHolds(a: {
  jobs: QueuedJob[];
  oldQuiet: QuietHours;
  newQuiet: QuietHours;
  now: Date;
}): { id: string; sendAfter: Date | null }[] {
  const next = messageHoursSendAfter(a.now, a.newQuiet);
  const out: { id: string; sendAfter: Date | null }[] = [];
  for (const job of a.jobs) {
    if (!job.sendAfter || job.sendAfter.getTime() <= a.now.getTime()) continue;
    if (!isQuietHoursHold(job, a.oldQuiet)) continue;
    if (next !== null && next.getTime() === job.sendAfter.getTime()) continue;
    out.push({ id: job.id, sendAfter: next });
  }
  return out;
}
