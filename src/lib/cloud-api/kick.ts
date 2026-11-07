/**
 * RING THE CLOUD DISPATCHER RIGHT AFTER A CLOUD JOB IS QUEUED (WhatsApp
 * Cloud API plan, PR C4, section 5.5). `queuePlatformDm` calls this for a
 * job stored for the official number, and only for one.
 *
 * The work is scheduled with `after()` from `next/server`: it runs once
 * the response has been sent, inside the same function invocation, so the
 * person who asked for a code is not kept waiting and a job written in
 * the caller's transaction is committed by then. Outside a request (a
 * script, a unit test) `after()` throws; that is fine, the per-minute
 * sweep (`/api/cron/cloud-dispatch`) sends the job instead.
 *
 * The dispatcher is imported when the callback runs, never at load time:
 * it imports platform-jobs.ts, which imports this file.
 */
import { after } from "next/server";

export function scheduleCloudDispatch(): void {
  try {
    after(async () => {
      try {
        const { dispatchCloudJobs } = await import("./dispatch");
        await dispatchCloudJobs();
      } catch (err) {
        console.error(`[cloud-api] dispatch after queueing failed; the sweep sends it: ${(err as Error)?.name ?? "error"}`);
      }
    });
  } catch {
    // Not inside a request: the per-minute sweep sends it.
  }
}
