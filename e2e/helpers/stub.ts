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
