/**
 * THE SETUP READING'S TEST SEAMS, in one place (go-live slice S3,
 * 2026-10-12; they were inline in the learn-setup cron route before).
 *
 * Honoured ONLY when the server was booted with MT_TEST_MODE exactly "1",
 * which nothing sets but `e2e/helpers/env.ts`. In production this returns
 * an empty object whatever the request carries.
 *
 *   x-test-now                       pins the clock
 *   x-mt-test-setup-learning-stub    the raw JSON the model "returns", so
 *                                    the e2e suite drives the whole path
 *                                    without a model call
 *
 * Read by the cron route and by the run that follows a held approval
 * (club-setup-schedule.ts), so both can be driven from one dev server.
 */
import type { PipelineModel } from "../pipeline/llm";

export const SETUP_LEARNING_STUB_HEADER = "x-mt-test-setup-learning-stub";

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

export function setupLearningTestSeam(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): { now?: Date; model?: PipelineModel } {
  if (env.MT_TEST_MODE !== "1") return {};
  const out: { now?: Date; model?: PipelineModel } = {};
  const pinned = new Date(request.headers.get("x-test-now") ?? "");
  if (!Number.isNaN(pinned.getTime())) out.now = pinned;
  const stub = request.headers.get(SETUP_LEARNING_STUB_HEADER);
  if (stub) out.model = stubModel(stub);
  return out;
}
