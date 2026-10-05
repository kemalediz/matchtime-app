/**
 * SETUP_LEARNING_ENABLED (F3, 2026-10-05): OFF unless explicitly
 * "1"/"true"/"on"/"yes". Off, the learned-setup sweep does nothing: no
 * model call, no setting changed, no DM. The chat history is still kept on
 * the connect request at the group add (it is cleared at the decision or
 * by the sweep), so switching the flag on later can still read a club
 * approved in the last few days.
 *
 * It stays off until Kemal has approved and seen the one live check
 * (scripts/live-check-setup-learning.ts), because it is a new prompt.
 *
 * TEST SEAM, the same double gate as billing-flag.ts: the cron route may
 * be told "1" or "0" by the `x-mt-test-setup-learning` header, honoured
 * only when the server was booted with MT_TEST_MODE exactly "1".
 */
export function isSetupLearningEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|on|yes)$/i.test((env.SETUP_LEARNING_ENABLED ?? "").trim());
}

export const SETUP_LEARNING_TEST_HEADER = "x-mt-test-setup-learning";

export function setupLearningEnabledForRequest(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.MT_TEST_MODE === "1") {
    const v = request.headers.get(SETUP_LEARNING_TEST_HEADER);
    if (v === "1") return true;
    if (v === "0") return false;
  }
  return isSetupLearningEnabled(env);
}
