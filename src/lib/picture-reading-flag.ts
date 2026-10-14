/**
 * PICTURE_READING_ENABLED (2026-10-14): OFF unless explicitly
 * "1"/"true"/"on"/"yes". Off, the picture route answers "flag-off" to every
 * request, no club is looked up and no model is called, and the Pi hands
 * every picture up exactly as before (its caption only).
 *
 * It stays off until Kemal has approved and seen the one paid check of the
 * new prompt (picture-prompt.ts).
 *
 * TEST SEAM, the same double gate as setup-hold-flag.ts: the header
 * `x-mt-test-picture-reading` may say "1" or "0", honoured only when the
 * server was booted with MT_TEST_MODE exactly "1".
 */
export const PICTURE_READING_TEST_HEADER = "x-mt-test-picture-reading";

export function isPictureReadingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|on|yes)$/i.test((env.PICTURE_READING_ENABLED ?? "").trim());
}

export function pictureReadingEnabledForApiRequest(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.MT_TEST_MODE === "1") {
    const v = request.headers.get(PICTURE_READING_TEST_HEADER);
    if (v === "1") return true;
    if (v === "0") return false;
  }
  return isPictureReadingEnabled(env);
}
