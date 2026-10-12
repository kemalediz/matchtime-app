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
 * WHAT IT RETURNS IS ABOUT THE SETUP DM ITSELF, exactly as before those
 * slices: `cancelled` and `alreadyClaimed` count the setup DM's own job
 * and nothing else. Callers decide from them whether the organiser was
 * ever told (the removal handling makes a club "never asked" again only
 * when the SETUP DM was taken back; a reminder or a command cancelled
 * after the setup DM had gone must not cause a second setup DM). What
 * became of the other two is in `followUps`, summed.
 * `alreadyClaimed` > 0 means the Pi had already
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

export interface SetupDmCancelResult {
  /** The setup DM's own job: taken back before it went ... */
  cancelled: number;
  /** ... or already with the Pi: left alone, and marked. */
  alreadyClaimed: number;
  /** The admin group command and the reminder, summed. */
  followUps: { cancelled: number; alreadyClaimed: number };
}

export async function cancelSetupDm(
  orgId: string,
  why: SetupDmCancelReason,
  now: Date = new Date(),
): Promise<SetupDmCancelResult> {
  const all = await cancelQueuedPlatformDms({
    purposes: [SETUP_ASK_DM_PURPOSE, SETUP_ADMIN_CODE_DM_PURPOSE, SETUP_REMINDER_DM_PURPOSE],
    refIds: [setupAskRefId(orgId), setupAdminCodeRefId(orgId), setupReminderRefId(orgId)],
    reason: why,
    now,
  });
  const zero = { cancelled: 0, alreadyClaimed: 0 };
  const ask = all.byPurpose[SETUP_ASK_DM_PURPOSE] ?? zero;
  const followUps = {
    cancelled: all.cancelled - ask.cancelled,
    alreadyClaimed: all.alreadyClaimed - ask.alreadyClaimed,
  };
  if (all.cancelled > 0 || all.alreadyClaimed > 0) {
    console.log(
      `[club-setup-dm] ${orgId}: cancel (${why}): setup DM ${ask.cancelled} cancelled, ${ask.alreadyClaimed} left with the Pi; ` +
        `command and reminder ${followUps.cancelled} cancelled, ${followUps.alreadyClaimed} left with the Pi`,
    );
  }
  return { cancelled: ask.cancelled, alreadyClaimed: ask.alreadyClaimed, followUps };
}
