/**
 * TAKING BACK A SETUP DM THAT HAS NOT GONE YET (go-live slice S3, PR #235
 * review fix 3).
 *
 * A setup DM queued outside 09:00 to 23:00 London waits for the next
 * 09:00. If, before then, the club is suspended, MatchTime is removed from
 * its group, or the club goes live from the settings page, what the DM
 * says ("approved, I'm in your group, reply GO") is no longer true, and
 * the platform channel knows nothing about clubs: it would send it.
 *
 * `cancelSetupDm(orgId, why)` is the ONE function for that. Callers:
 *   - `decideClub` on SUSPEND of a club that is setting up (this slice);
 *   - go-live (`goLiveClub`) and the removal handling (bot-removed), in
 *     their own slices: call it after their own write has committed.
 *
 * WHAT IT COVERS (go-live slices S6 and S7): the club's setup DM, the
 * admin group command that follows it, and its 24-hour reminder. Three
 * jobs at most, each with its own purpose and refId, cancelled by ONE
 * statement. A reminder queued at 23:10 for 09:00 and a club that goes
 * live at midnight is the same case as the setup DM's.
 *
 * It returns what it did, summed over those jobs. `alreadyClaimed` > 0 means the Pi had already
 * taken the job: it is left alone (it may be on its way) and the caller
 * decides whether that matters. See `cancelQueuedPlatformDms` for why the
 * claim cannot race the cancel.
 *
 * In its own small file, with no import of the reading or of
 * club-approval, so `decideClub` can call it without an import cycle.
 */
import { cancelQueuedPlatformDms } from "./platform-jobs";
import { SETUP_ASK_DM_PURPOSE, setupAskRefId } from "./club-setup-dm-rules";
import {
  SETUP_ADMIN_CODE_DM_PURPOSE,
  SETUP_REMINDER_DM_PURPOSE,
  setupAdminCodeRefId,
  setupReminderRefId,
} from "./club-setup-followup-rules";

export type SetupDmCancelReason = "suspended" | "removed" | "went-live";

export async function cancelSetupDm(
  orgId: string,
  why: SetupDmCancelReason,
  now: Date = new Date(),
): Promise<{ cancelled: number; alreadyClaimed: number }> {
  const r = await cancelQueuedPlatformDms({
    purposes: [SETUP_ASK_DM_PURPOSE, SETUP_ADMIN_CODE_DM_PURPOSE, SETUP_REMINDER_DM_PURPOSE],
    refIds: [setupAskRefId(orgId), setupAdminCodeRefId(orgId), setupReminderRefId(orgId)],
    reason: why,
    now,
  });
  if (r.cancelled > 0 || r.alreadyClaimed > 0) {
    console.log(
      `[club-setup-dm] ${orgId}: setup DMs cancel (${why}): ${r.cancelled} cancelled` +
        `${r.alreadyClaimed > 0 ? `, ${r.alreadyClaimed} already claimed by the Pi and left alone` : ""}`,
    );
  }
  return r;
}
