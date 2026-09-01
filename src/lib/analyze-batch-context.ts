/**
 * The identity of one analyze BATCH.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY A BATCH ID EXISTS AT ALL
 * ─────────────────────────────────────────────────────────────────────
 * The Pi buffers inbound WhatsApp messages and flushes a WINDOW to
 * `/api/whatsapp/analyze`; the route reasons over the whole window in
 * one model call. So the BATCH, not the message, is the unit anything
 * replaying this history has to reconstruct — a message replayed on its
 * own is a world production never analysed.
 *
 * `AnalyzedMessage` carried no batch id, so `e2e/replay/reconstruct.ts`
 * recovered batches from WRITE TIMING: consecutive rows less than 2s
 * apart are one flush, more than 10s apart are certainly two, and the
 * band in between is genuinely ambiguous — "one slow flush" and "two
 * quick ones" look identical. Measured against production on
 * 2026-09-01 that band cost **62 batches / 104 messages**, thrown away
 * rather than guessed. One column and one assignment end the class.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY ASYNCLOCALSTORAGE AND NOT A PARAMETER
 * ─────────────────────────────────────────────────────────────────────
 * `recordAnalysis` is called from eighteen places inside the analyze
 * route, most of them deep inside helpers that have no reason to know
 * about batching. Threading an id through all of them would be a large
 * diff across a file another change is already touching, for a value
 * that is constant for the whole request.
 *
 * A module-level variable would be WRONG — Next handles requests
 * concurrently, and two overlapping flushes would stamp each other's
 * ids. `AsyncLocalStorage` is per-async-context by construction: the
 * value follows the request through every await, including work handed
 * to `after()`, and is invisible to any other request.
 *
 * Reading OUTSIDE a batch returns `null`, and `AnalyzedMessage.batchId`
 * is nullable, so nothing here can fail a write.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const storage = new AsyncLocalStorage<string>();

/**
 * Run one analyze request inside a fresh batch identity.
 *
 * One call = one flush = one batch, which is exactly the definition the
 * replay harness needs. Nested calls keep the outer id rather than
 * minting a second one for the same flush.
 */
export function withAnalyzeBatch<T>(fn: () => Promise<T>, batchId?: string): Promise<T> {
  const existing = storage.getStore();
  if (existing) return fn();
  return storage.run(batchId ?? randomUUID(), fn);
}

/** The current batch id, or null outside a batch. Never throws. */
export function currentAnalyzeBatchId(): string | null {
  return storage.getStore() ?? null;
}
