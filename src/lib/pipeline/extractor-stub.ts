/**
 * TEST-ONLY seam for the extractors, mirroring `MT_TEST_LLM_STUB_FILE`
 * (`message-analyzer.ts`) and `MT_TEST_ROUTER_STUB_FILE` (`gate.ts`).
 *
 * §10 step 6 puts the extractor on the WRITE path, and a write path
 * that can only be exercised by spending money is a write path nobody
 * exercises. `npm run test:e2e` has to be able to drive the whole
 * engine — router, extractor, engine, apply — deterministically and for
 * free, or the free suite silently stops covering the thing that
 * changed.
 *
 * The stub returns the model's RAW JSON, not a `Facts` object, so
 * `parseFacts` still runs for real: the enum re-validation, the dropped
 * claim on a drifted polarity, and the "none" → null affirmation
 * mapping are all part of what is under test (§11.3 — structured output
 * guarantees shape, never semantics).
 *
 * Never set in production. `e2e/helpers/live-llm.ts` refuses a "live"
 * run that can still see a stub seam, the same way it refuses one that
 * can still see the analyzer's.
 */
import { readFileSync } from "node:fs";
import type { PipelineModel } from "./llm";

export const EXTRACTOR_STUB_FILE_ENV = "MT_TEST_EXTRACTOR_STUB_FILE";

export interface ExtractorStubConfig {
  /** Trimmed message body → the raw JSON body the extractor would have
   *  returned, e.g. `{"claims":[…],"affirmation":"none","sideRequests":[]}`. */
  bodies?: Record<string, Record<string, unknown>>;
}

/** The facts a body with no entry gets: none. That is the direction
 *  that cannot invent a write in a test. */
const EMPTY_ATTENDANCE = { claims: [], affirmation: "none", sideRequests: [] };

function config(env: NodeJS.ProcessEnv = process.env): ExtractorStubConfig | null {
  const file = env[EXTRACTOR_STUB_FILE_ENV];
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ExtractorStubConfig;
  } catch {
    // Missing or garbled → behave as if there were no mapping at all.
    return {};
  }
}

/**
 * The stubbed extractor model, or null when the env var is unset —
 * which is the only thing standing between this and production.
 *
 * The message body is the last line of the user block the extractor is
 * sent (`extractors.ts` appends "THE MESSAGE (from X):" then the body),
 * so the whole tail after that header is matched rather than a single
 * line: a real WhatsApp message can be several lines long, and PR #33's
 * incident message is exactly that shape.
 */
export function extractorStubFromEnv(env: NodeJS.ProcessEnv = process.env): PipelineModel | null {
  if (!env[EXTRACTOR_STUB_FILE_ENV]) return null;
  return {
    name: "extractor-stub",
    async complete(req) {
      const cfg = config(env) ?? {};
      const body = messageBodyOf(req.user);
      const canned = cfg.bodies?.[body] ?? EMPTY_ATTENDANCE;
      return {
        text: JSON.stringify(canned),
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
        ms: 0,
      };
    },
  };
}

/** Everything after the "THE MESSAGE (from …):" header, trimmed. */
export function messageBodyOf(user: string): string {
  const m = /^THE MESSAGE \(from [^)]*\):\n([\s\S]*)$/m.exec(user);
  return (m ? m[1] : user).trim();
}
