/**
 * AFTER A WEEKLY GAME IS SAVED: look its venue up, without making the
 * save wait (2026-10-12).
 *
 * Every path that creates a weekly game or edits its venue text awaits
 * one of these AFTER its own write has succeeded. Two things happen:
 *
 *   1. the lookup is RECORDED as scheduled (`venueLookupStatus =
 *      "pending"`), one small write, so the page says "looking" because a
 *      lookup really is under way (review of PR #241, fix 3: it used to
 *      infer that from `updatedAt`, and an edit of the time alone looked
 *      like a lookup);
 *   2. the lookup itself is handed to `after()` from `next/server`, which
 *      runs it once the response has been sent (the same mechanism as
 *      club-setup-schedule.ts), so a slow or failing Google can neither
 *      slow nor fail the save. NEVER inline.
 *
 * Neither step can fail the save: both are caught here.
 *
 * `after()` needs a request. Outside one (a script, a unit test) the
 * lookup is started and not awaited instead.
 *
 * A lookup that fails is recorded as failed; the confirm line on
 * /admin/activities then offers "Try again", and the next save of the
 * venue schedules a new one. A lookup the server never ran stays
 * "pending" and the page treats it as failed after half a minute.
 */
import { after } from "next/server";
import {
  markVenueLookupPending,
  resolveActivityVenuePickSafe,
  resolveActivityVenueSafe,
  resolvePendingVenuesForOrg,
} from "./venue-location";
import type { VenuePick } from "./venue-suggest-rules";

function later(work: () => Promise<unknown>): void {
  const run = async () => {
    try {
      await work();
    } catch (err) {
      console.error(`[geocode] scheduled lookup failed (${(err as Error)?.name ?? "error"})`);
    }
  };
  try {
    after(run);
  } catch {
    void run();
  }
}

async function record(target: { activityId: string } | { orgId: string }): Promise<boolean> {
  try {
    await markVenueLookupPending(target);
    return true;
  } catch (err) {
    console.error(`[geocode] could not record a scheduled lookup (${(err as Error)?.name ?? "error"})`);
    return false;
  }
}

/** One activity: it was just created, or its venue text just changed. */
export async function scheduleVenueResolve(activityId: string): Promise<void> {
  if (await record({ activityId })) later(() => resolveActivityVenueSafe(activityId));
}

/** A club that was just created, weekly game and all, in one transaction. */
export async function scheduleVenueResolveForOrg(orgId: string): Promise<void> {
  if (await record({ orgId })) later(() => resolvePendingVenuesForOrg(orgId));
}

/**
 * One activity whose venue was PICKED from the suggestions under the
 * venue box (2026-10-13): after the response, the server asks Google
 * what the picked place is and links it. If Google does not resolve it,
 * the venue text gets the ordinary lookup instead
 * (`resolveActivityVenuePickSafe`). Never part of the save.
 */
export async function scheduleVenuePickResolve(activityId: string, userId: string, pick: VenuePick): Promise<void> {
  if (await record({ activityId })) later(() => resolveActivityVenuePickSafe(activityId, userId, pick));
}
