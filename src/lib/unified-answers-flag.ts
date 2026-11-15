/**
 * UNIFIED_ANSWERS (Kemal, 2026-11-10). The code's default is OFF: on only
 * when the variable is "1"/"true"/"on"/"yes". PRODUCTION SETS IT: live with
 * UNIFIED_ANSWERS=1 since 2026-11-11 23:18 UTC (#595). Unset it to go back.
 *
 * Kemal: "any question that is being asked should go to other category and
 * just answered by LLM after looking at all data. this way we can get rid of
 * some of the categories as well and make the code simpler."
 *
 * ON, every tagged question in the players' group, HQ and a DM is answered by
 * ONE model call over ONE context of the club's data
 * (`pipeline/unified-answer.ts`), except four things that stay in code: the
 * list post, the help, the asker's own stats link, and who has paid (only
 * ever in the organisers' context). The question extractor shrinks to those
 * four and "anything else" (`UNIFIED_QUESTION_PROMPT`).
 *
 * OFF, the old path: the extractor, the engine, the composer and the DM
 * answer as they were before #595 (pinned by "UNIFIED_ANSWERS off" in
 * `pipeline/__tests__/answer-batch-unified.test.ts` and the flag-off case of
 * `e2e/api/unified-answers.spec.ts`).
 *
 * TEST SEAM, the same double gate as picture-reading-flag.ts: the header
 * `x-mt-test-unified-answers` may say "1" or "0", honoured only when the
 * server was booted with MT_TEST_MODE exactly "1".
 */
export const UNIFIED_ANSWERS_TEST_HEADER = "x-mt-test-unified-answers";

export function isUnifiedAnswersEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|on|yes)$/i.test((env.UNIFIED_ANSWERS ?? "").trim());
}

export function unifiedAnswersEnabledForApiRequest(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.MT_TEST_MODE === "1") {
    const v = request.headers.get(UNIFIED_ANSWERS_TEST_HEADER);
    if (v === "1") return true;
    if (v === "0") return false;
  }
  return isUnifiedAnswersEnabled(env);
}
