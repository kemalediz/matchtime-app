/**
 * AFTER AN APPROVAL THAT HELD THE CLUB: read its chat and send its setup
 * DM promptly, without making anybody wait (go-live slice S3, 2026-10-12;
 * go-live plan 2.3).
 *
 * Both approval entry points call this when `decideClub` reports the club
 * as held: the dm-reply route (the owner's "APPROVE 7KQ2", where the Pi is
 * awaiting the response) and `approveClubAction` (/admin/clubs). The work
 * is scheduled with `after()` from `next/server`, which runs the callback
 * once the response has been sent, inside the same function invocation
 * and for as long as the route's duration limit allows. NEVER inline.
 *
 * The work is `runSetupAfterApproval` for that ONE club: one model call
 * at most, then its DM. The 15-minute learn-setup cron is the retry for
 * anything that did not finish (a deferred reading, a function that was
 * cut short, a server that dropped the callback).
 *
 * `request` (the route has one, the server action does not) carries the
 * test seams: the reading flag's header, the stub model and the pinned
 * clock, all honoured only under MT_TEST_MODE=1. They are read BEFORE the
 * response goes, not inside the callback.
 */
import { after } from "next/server";
import { runSetupAfterApproval } from "./club-setup-dm";
import { isSetupLearningEnabled, setupLearningEnabledForRequest } from "./setup-learning/flag";
import { setupLearningTestSeam } from "./setup-learning/test-seam";

export function scheduleSetupAfterApproval(orgId: string, request?: Request): void {
  const learningEnabled = request ? setupLearningEnabledForRequest(request) : isSetupLearningEnabled();
  const seam = request ? setupLearningTestSeam(request) : {};
  after(async () => {
    // `runSetupAfterApproval` never throws; this is the last line of defence.
    try {
      await runSetupAfterApproval(orgId, { learningEnabled, ...seam });
    } catch (err) {
      console.error(`[club-setup-schedule] ${orgId}: the run after approval failed; the cron retries:`, err);
    }
  });
}
