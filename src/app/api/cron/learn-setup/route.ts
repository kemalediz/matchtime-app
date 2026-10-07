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
import type { PipelineModel } from "@/lib/pipeline/llm";

const STUB_HEADER = "x-mt-test-setup-learning-stub";

function stubModel(text: string): PipelineModel {
  return {
    name: "setup-learning-stub",
    complete: async () => ({
      text,
      stopReason: "end_turn",
      usage: { inputTokens: 12_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0.0145,
      ms: 1,
    }),
  };
}

export async function GET(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let now = new Date();
  let model: PipelineModel | undefined;
  if (process.env.MT_TEST_MODE === "1") {
    const pinned = new Date(request.headers.get("x-test-now") ?? "");
    if (!Number.isNaN(pinned.getTime())) now = pinned;
    const stub = request.headers.get(STUB_HEADER);
    if (stub) model = stubModel(stub);
  }
  let report: Awaited<ReturnType<typeof runSetupLearningSweep>> | null = null;
  try {
    report = await runSetupLearningSweep(now, { enabled: setupLearningEnabledForRequest(request), model });
  } catch (err) {
    console.error("[learn-setup] sweep failed:", err);
  }
  let expired: ExpiredCapturedHistory | null = null;
  try {
    expired = await expireCapturedHistory(now);
  } catch (err) {
    console.error("[learn-setup] captured chat expiry failed:", err);
  }
  if (!report) return NextResponse.json({ error: "sweep failed", expired }, { status: 500 });
  return NextResponse.json({ ...report, expired });
}
