/**
 * THE CLOUD DISPATCH SWEEP, every minute (WhatsApp Cloud API plan, PR C4;
 * MDs/whatsapp-cloud-api-plan-2026-11-04.md section 5.5).
 *
 * Behind CRON_SECRET like every other cron. The work is
 * `runCloudDispatchSweep` (src/lib/cloud-api/dispatch.ts):
 *   - CLOUD_API_ENABLED off (the default): it returns at once. Nothing is
 *     read, claimed or sent; the pool's sweeps stay the Pi's alone.
 *   - on: the pool's sweeps the Pi runs (`runPlatformPoolSweeps`, the same
 *     function), then up to a batch of jobs for the official number,
 *     claimed with the Pi's own claim and sent through the Cloud API. It
 *     is the retry for the dispatch that runs right after a job is queued
 *     (`after()`, src/lib/cloud-api/kick.ts).
 *   - then (PR C5) the Cloud webhook's recorded messages that the work
 *     after its 200 never started (`sweepCloudInbound`,
 *     src/lib/cloud-api/webhook.ts), through the same DM pipeline. Off,
 *     it reads nothing either. Its failure never changes this answer.
 *
 * The schedule (`* * * * *` in vercel.json) needs Vercel Pro: Hobby allows
 * one run a day. The project is on the Cressoft team's Pro plan (moved
 * there 2026-05-21, MDs/learnings.md), where the minimum interval is one
 * minute.
 *
 * TEST SEAMS, honoured only when the server was booted with MT_TEST_MODE
 * exactly "1": `x-test-now` pins the clock and `x-mt-test-pool-open` the
 * pool switch (`pool/flags-request.ts`), as on the Pi's platform poll.
 */
import { NextResponse } from "next/server";
import { runCloudDispatchSweep } from "@/lib/cloud-api/dispatch";
import { sweepCloudInbound } from "@/lib/cloud-api/webhook";
import { poolEnvForApiRequest } from "@/lib/pool/switch-env";

/** Seconds, a literal as Next.js reads it from the build. The inbound
 *  sweep claims messages here, so `INBOUND_RETRY_AFTER_MS` (15 minutes)
 *  must stay over twice this (pinned by cloud-dispatch-route.test.ts). */
export const maxDuration = 300;

function nowOf(request: Request): Date {
  if (process.env.MT_TEST_MODE === "1") {
    const pinned = new Date(request.headers.get("x-test-now") ?? "");
    if (!Number.isNaN(pinned.getTime())) return pinned;
  }
  return new Date();
}

export async function GET(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const now = nowOf(request);
  let answer: Response;
  try {
    const report = await runCloudDispatchSweep({ now, poolEnv: () => poolEnvForApiRequest(request) });
    if (report.claimed > 0) console.log(`[cloud-dispatch] ${JSON.stringify(report)}`);
    answer = NextResponse.json(report);
  } catch (err) {
    console.error(`[cloud-dispatch] sweep failed; the next minute tries again: ${(err as Error)?.message ?? "error"}`);
    answer = NextResponse.json({ error: "sweep failed" }, { status: 500 });
  }
  try {
    await sweepCloudInbound({ request, now });
  } catch (err) {
    console.error(`[cloud-dispatch] inbound sweep failed; the next minute tries again: ${(err as Error)?.name ?? "error"}`);
  }
  return answer;
}
