/**
 * TEST-ONLY seam shared by the DM classifiers that read the chat-context
 * block (payment-claim, match-availability). It stubs what ENTERS the
 * system (what the model said, keyed by the DM body), never what the
 * system concludes: the gates, the writes and the replies all run for real
 * behind it. `e2e/helpers/live-llm.ts` refuses a "live" run that can still
 * see either file.
 *
 * Every user turn the stub is asked about is appended, as one JSON line,
 * to `<file>.calls`, so a route-level spec can assert what the model WOULD
 * have been told (the chat context, the owed match) without a model.
 */
import { appendFileSync, readFileSync } from "node:fs";

export interface DmClassifierStub {
  /** Trimmed message body → the label the model would have returned. */
  bodies?: Record<string, string>;
  /** Bodies whose model CALL throws, the way an overloaded API does. */
  fail?: string[];
}

/** Everything after the header line, trimmed, so a multi-line message is
 *  read whole. The whole turn when the header is missing. */
export function bodyUnderHeader(user: string, header: string): string {
  const i = user.indexOf(`${header}\n`);
  return (i === -1 ? user : user.slice(i + header.length + 1)).trim();
}

/**
 * The stubbed call, or null when the env var is unset. `answer` turns the
 * stubbed label (or null: no mapping) into the model's raw JSON.
 */
export function dmClassifierStubCall(
  file: string | undefined,
  input: { label: string; header: string; answer: (label: string | null) => string },
): ((system: string, user: string) => Promise<string>) | null {
  if (!file) return null;
  return async (_system, user) => {
    let cfg: DmClassifierStub = {};
    try {
      cfg = JSON.parse(readFileSync(file, "utf8")) as DmClassifierStub;
    } catch {
      // Missing or garbled → no mapping at all, the safe answer.
      cfg = {};
    }
    try {
      appendFileSync(`${file}.calls`, `${JSON.stringify({ label: input.label, user })}\n`);
    } catch {
      // Recording is for the spec; never fail the call over it.
    }
    const body = bodyUnderHeader(user, input.header);
    if ((cfg.fail ?? []).includes(body)) throw new Error(`${input.label} stub: forced failure`);
    return input.answer(cfg.bodies?.[body] ?? null);
  };
}
