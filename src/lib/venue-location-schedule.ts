/**
 * AFTER A WEEKLY GAME IS SAVED: look its venue up, without making the
 * save wait (2026-10-12).
 *
 * Every path that creates a weekly game or edits its venue text calls
 * one of these AFTER its own write has succeeded. The lookup is handed
 * to `after()` from `next/server`, which runs it once the response has
 * been sent (the same mechanism as club-setup-schedule.ts), so a slow or
 * failing Google can neither slow nor fail the save. NEVER inline.
 *
 * `after()` needs a request. Outside one (a script, a unit test) the
 * lookup is started and not awaited instead, which keeps the promise
 * that the caller never waits and never sees an error.
 *
 * Nothing retries a lookup that failed: the venue simply stays without a
 * place, the confirm line on /admin/activities asks the organiser for
 * the address, and scripts/backfill-venue-locations.ts can sweep later.
 */
import { after } from "next/server";
import { resolveActivityVenueSafe, resolveUnresolvedVenuesForOrg } from "./venue-location";

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

/** One activity: it was just created, or its venue text just changed. */
export function scheduleVenueResolve(activityId: string): void {
  later(() => resolveActivityVenueSafe(activityId));
}

/** A club that was just created, weekly game and all, in one transaction. */
export function scheduleVenueResolveForOrg(orgId: string): void {
  later(() => resolveUnresolvedVenuesForOrg(orgId));
}
