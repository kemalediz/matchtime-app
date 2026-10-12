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
 * and for as long as the route's duration limit allows (300 seconds on
 * this project; the work is one model call at most). NEVER inline.
 *
 * The work is `runSetupAfterApproval` for that ONE club: one model call
 * at most, then its DM. The 15-minute learn-setup cron is the retry for
 * anything that did not finish (a deferred reading, a function that was
 * cut short, a server that dropped the callback).
 *
 * TEST SEAMS, all honoured only under MT_TEST_MODE=1 and all read BEFORE
 * the response goes, never inside the callback: the reading flag, the stub
 * model and the pinned clock. The route carries them as headers; the
 * server action, which has no request, as cookies.
 */
import { after } from "next/server";
import { runSetupAfterApproval, type SetupAfterApprovalOptions } from "./club-setup-dm";
import { isSetupLearningEnabled, setupLearningEnabledForRequest } from "./setup-learning/flag";
import { setupLearningTestSeam, setupLearningTestSeamFromCookies } from "./setup-learning/test-seam";

function schedule(orgId: string, opts: SetupAfterApprovalOptions): void {
  after(async () => {
    // `runSetupAfterApproval` never throws; this is the last line of defence.
    try {
      await runSetupAfterApproval(orgId, opts);
    } catch (err) {
      console.error(`[club-setup-schedule] ${orgId}: the run after approval failed; the cron retries: ${(err as Error)?.name ?? "error"}`);
    }
  });
}

/** From a route handler (the owner's APPROVE by WhatsApp). */
export function scheduleSetupAfterApproval(orgId: string, request: Request): void {
  schedule(orgId, { learningEnabled: setupLearningEnabledForRequest(request), ...setupLearningTestSeam(request) });
}

/** From a server action (the Approve button on /admin/clubs). */
export async function scheduleSetupAfterApprovalFromAction(orgId: string): Promise<void> {
  const { learningEnabled, ...seam } = await setupLearningTestSeamFromCookies();
  schedule(orgId, { learningEnabled: learningEnabled ?? isSetupLearningEnabled(), ...seam });
}
