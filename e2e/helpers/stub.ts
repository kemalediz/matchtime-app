/**
 * Writes the LLM stub file the server-under-test reads on every
 * `analyzeBatch` call (see MT_TEST_LLM_STUB_FILE in
 * src/lib/message-analyzer.ts). Tests call `setLlmStub` with a map of
 * waMessageId → partial verdict immediately before POSTing to
 * /api/whatsapp/analyze.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { E2E } from "./env";

export interface StubVerdict {
  intent?: string;
  confidence?: number;
  react?: string | null;
  reply?: string | null;
  registerAttendance?: "IN" | "OUT" | "BENCH" | null;
  benchConfirmation?: "yes" | "no" | null;
  registerFor?: Array<{ name: string; action: "IN" | "OUT" | "BENCH" }> | null;
  /** The message asks for MORE PLAYERS. A flag, not an intent — it
   *  coexists with the attendance the same message carries. */
  recruitRequest?: boolean;
  scoreRed?: number | null;
  scoreYellow?: number | null;
  includeNames?: string[] | null;
  teamOverrides?: Array<{ name: string; team: "RED" | "YELLOW" }> | null;
  teamNames?: [string, string] | null;
  bulkPayment?: { payerName: string; count: number; coveredNames?: string[] } | null;
  reminder?: { date: string; time?: string; note: string } | null;
  reasoning?: string;
}

export function setLlmStub(verdicts: Record<string, StubVerdict>): void {
  mkdirSync(path.dirname(E2E.LLM_STUB_FILE), { recursive: true });
  writeFileSync(E2E.LLM_STUB_FILE, JSON.stringify({ verdicts }, null, 2));
}

export function clearLlmStub(): void {
  setLlmStub({});
}

/**
 * The ROUTER stub (§10 step 5). Same seam, one layer earlier: it says
 * what the router answered and whether the gate and the floor are on for
 * this request.
 *
 * `{}` means "no override" — the flags fall back to the environment,
 * where both are OFF. That is what `clearRouterStub()` writes, and why
 * every spec that has never heard of the router is unaffected by the
 * file's existence.
 */
export interface RouterStub {
  enabled?: boolean;
  floor?: boolean;
  /** Overrides ATTENDANCE_ENGINE_ENABLED (§10 step 6). Carried on the
   *  ROUTER stub because the engine needs the router's answer anyway,
   *  and one file per request is easier to reason about than two. */
  engine?: boolean;
  /** waMessageId → route. Unmapped ids come back `unsure`, so the
   *  analyzer still sees them — the direction that cannot lose a write. */
  routes?: Record<string, string>;
  /** Trimmed body → route. The sim harness mints its own message ids, so
   *  a spec addresses the router by what was said. */
  bodies?: Record<string, string>;
}

export function setRouterStub(stub: RouterStub): void {
  mkdirSync(path.dirname(E2E.ROUTER_STUB_FILE), { recursive: true });
  writeFileSync(E2E.ROUTER_STUB_FILE, JSON.stringify(stub, null, 2));
}

export function clearRouterStub(): void {
  setRouterStub({});
}

/**
 * The EXTRACTOR stub (§10 step 6). One layer later than the router: it
 * says what FACTS the attendance extractor returned for a given body.
 *
 * It deliberately carries the model's RAW JSON rather than a `Facts`
 * object, so `parseFacts` still runs for real — the enum re-validation,
 * the dropped claim on a drifted polarity and the "none" → null
 * affirmation mapping are part of what a step-6 spec is testing.
 *
 * `{}` — what `clearExtractorStub()` writes — means every body extracts
 * NO claims. That is the direction that cannot invent a write in a spec
 * which has never heard of the engine, and combined with the flag
 * defaulting off it is why the existing suite is untouched by this
 * file's existence.
 */
export interface ExtractorStub {
  bodies?: Record<string, Record<string, unknown>>;
  /** Bodies whose extractor CALL fails with a real overload error, after
   *  the SDK's four retries. The only way to exercise the fail-open
   *  fallback end to end. */
  fail?: string[];
  /** Every extractor call fails — the total-overload edge. */
  failAll?: boolean;
}

/** A single attendance claim, with the boring fields filled in. */
export function claim(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subject: "sender",
    personRef: "",
    personNamed: false,
    polarity: "in",
    contingent: false,
    conditionOn: "none",
    tense: "present",
    basis: "decision",
    reported: false,
    confidence: 0.95,
    ...over,
  };
}

/** The whole attendance-extractor body, with the boring fields filled in. */
export function facts(
  claims: Array<Record<string, unknown>>,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return { claims, affirmation: "none", sideRequests: [], ...over };
}

export function setExtractorStub(stub: ExtractorStub): void {
  mkdirSync(path.dirname(E2E.EXTRACTOR_STUB_FILE), { recursive: true });
  writeFileSync(E2E.EXTRACTOR_STUB_FILE, JSON.stringify(stub, null, 2));
}

export function clearExtractorStub(): void {
  setExtractorStub({});
}
