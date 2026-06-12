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
  reasoning?: string;
}

export function setLlmStub(verdicts: Record<string, StubVerdict>): void {
  mkdirSync(path.dirname(E2E.LLM_STUB_FILE), { recursive: true });
  writeFileSync(E2E.LLM_STUB_FILE, JSON.stringify({ verdicts }, null, 2));
}

export function clearLlmStub(): void {
  setLlmStub({});
}
