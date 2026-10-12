/**
 * F3, LEARNED SETUP: the 15-minute sweep (2026-10-05).
 *
 * Behind CRON_SECRET like every other cron, and behind
 * SETUP_LEARNING_ENABLED (off unless explicitly on): off, it returns at
 * once and nothing is read, called or changed. The work is
 * `runSetupLearningSweep` (src/lib/setup-learning/run.ts): each self-join
 * club approved in the last three days and not read yet gets its one model
 * call, its settings and its organiser DM.
 *
 * CAPTURED CHAT EXPIRY (2026-10-08) rides on the same schedule: after the
 * sweep, on every authorised call and whatever the flag says, chat that
 * nobody has read is deleted once it is 7 days old
 * (`expireCapturedHistory`, src/lib/captured-history-expiry.ts). It runs
 * after the sweep so anything this run reads is read first, and neither
 * half stops the other: a failed sweep still expires, and a failed expiry
 * still returns the sweep's report (with `expired: null`).
 *
 * THE SETUP DM (go-live slice S3, 2026-10-12) rides on it too: a club
 * approved while SETUP_HOLD_ENABLED was on is silent until its organiser
 * says GO, and gets ONE DM once its reading is final (or at once when the
 * reading is off). `runSetupDmSweep` (src/lib/club-setup-dm.ts) sends
 * whatever is due, on every authorised call and whatever either flag says
 * now: it is keyed on the club's stored state. With no club setting up it
 * is one query that finds nothing. It is the retry for the run that
 * follows an approval (`after()`, club-setup-schedule.ts).
 *
 * TEST SEAMS, honoured only when the server was booted with MT_TEST_MODE
 * exactly "1" (never in production): `x-test-now` pins the clock,
 * `x-mt-test-setup-learning` turns the flag on or off for this request,
 * and `x-mt-test-setup-learning-stub` is the raw JSON the model returns,
 * so the e2e suite drives the whole path without a model call.
 */
import { NextResponse } from "next/server";
import { runSetupLearningSweep } from "@/lib/setup-learning/run";
import { setupLearningEnabledForRequest } from "@/lib/setup-learning/flag";
import { expireCapturedHistory, type ExpiredCapturedHistory } from "@/lib/captured-history-expiry";
import { runSetupDmSweep } from "@/lib/club-setup-dm";
import { setupLearningTestSeam } from "@/lib/setup-learning/test-seam";

export async function GET(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const seam = setupLearningTestSeam(request);
  const now = seam.now ?? new Date();
  const model = seam.model;
  const learningEnabled = setupLearningEnabledForRequest(request);
  let report: Awaited<ReturnType<typeof runSetupLearningSweep>> | null = null;
  try {
    report = await runSetupLearningSweep(now, { enabled: learningEnabled, model });
  } catch (err) {
    console.error("[learn-setup] sweep failed:", err);
  }
  // The setup DM of a club held until its organiser says GO, AFTER the
  // sweep so a reading that finished in this run is told in this run.
  // Independent of the sweep: a failed sweep still sends what is due.
  let setupDms: Awaited<ReturnType<typeof runSetupDmSweep>> | null = null;
  try {
    setupDms = await runSetupDmSweep(now, { learningEnabled });
  } catch (err) {
    console.error("[learn-setup] setup DM sweep failed:", err);
  }
  let expired: ExpiredCapturedHistory | null = null;
  try {
    expired = await expireCapturedHistory(now);
  } catch (err) {
    console.error("[learn-setup] captured chat expiry failed:", err);
  }
  if (!report) return NextResponse.json({ error: "sweep failed", expired }, { status: 500 });
  // `setupDms` is reported only when a club was due, so with no club
  // setting up the response is exactly what it was.
  return NextResponse.json({ ...report, expired, ...(setupDms && setupDms.considered > 0 ? { setupDms } : {}) });
}
