/**
 * THE SETUP READING'S TEST SEAMS, in one place (go-live slice S3,
 * 2026-10-12; they were inline in the learn-setup cron route before).
 *
 * Honoured ONLY when the server was booted with MT_TEST_MODE exactly "1",
 * which nothing sets but `e2e/helpers/env.ts`. In production both
 * functions return an empty object whatever the request carries, and the
 * cookie one does not even read the cookies.
 *
 * As HEADERS (the cron route, and the run that follows the owner's
 * APPROVE by WhatsApp, club-setup-schedule.ts):
 *   x-test-now                       pins the clock
 *   x-mt-test-setup-learning-stub    the raw JSON the model "returns", so
 *                                    the e2e suite drives the whole path
 *                                    without a model call
 * (the flag's own header, `x-mt-test-setup-learning`, is in flag.ts).
 *
 * As COOKIES (the run that follows the Approve button on /admin/clubs: a
 * server action has no request to carry headers):
 *   mt-test-setup-learning           "1" or "0": the reading flag
 *   mt-test-setup-learning-stub      the same JSON, base64url encoded
 */
import { cookies } from "next/headers";
import type { PipelineModel } from "../pipeline/llm";

export const SETUP_LEARNING_STUB_HEADER = "x-mt-test-setup-learning-stub";
export const SETUP_LEARNING_TEST_COOKIE = "mt-test-setup-learning";
export const SETUP_LEARNING_STUB_TEST_COOKIE = "mt-test-setup-learning-stub";

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

/** For a server action. `learningEnabled` undefined: the environment decides. */
export async function setupLearningTestSeamFromCookies(
  env: Record<string, string | undefined> = process.env,
): Promise<{ learningEnabled?: boolean; model?: PipelineModel }> {
  if (env.MT_TEST_MODE !== "1") return {};
  const jar = await cookies();
  const out: { learningEnabled?: boolean; model?: PipelineModel } = {};
  const flag = jar.get(SETUP_LEARNING_TEST_COOKIE)?.value;
  if (flag === "1") out.learningEnabled = true;
  if (flag === "0") out.learningEnabled = false;
  const stub = jar.get(SETUP_LEARNING_STUB_TEST_COOKIE)?.value;
  if (stub) out.model = stubModel(Buffer.from(stub, "base64url").toString("utf8"));
  return out;
}
