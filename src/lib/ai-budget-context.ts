/**
 * WHOSE MONEY IS THIS MODEL CALL? The request-scoped half of the daily AI
 * spend cap (2026-09-29). The accounting and the cap rule live in
 * `ai-budget.ts`; this file is the part every model call site can import.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY IT IS SPLIT IN TWO
 * ─────────────────────────────────────────────────────────────────────
 * `pipeline/llm.ts` must stay loadable without Prisma (the Playwright
 * worker and the plain `tsx` harnesses import the pipeline, and its header
 * says so at length). The guard has to live in `llm.ts`, because that is
 * where the one pipeline `messages.create` is. So the guard reads a SCOPE
 * from here, and the scope carries its own LEDGER: the object that
 * actually talks to the database is handed in by whoever opened the scope
 * (`ai-budget.ts`), never imported by this file.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY ASYNCLOCALSTORAGE AND NOT A PARAMETER
 * ─────────────────────────────────────────────────────────────────────
 * The same argument `analyze-batch-context.ts` makes. The router, the
 * extractors, the composer and the generic stats answer are reached from
 * the analyze route through half a dozen engines that have no reason to
 * know about money; threading an org id through all of them would be a
 * large diff for a value that is constant for the whole request. The
 * scope follows the request through every await and is invisible to any
 * other request.
 *
 * OUTSIDE A SCOPE A CALL IS NOT GUARDED. That is deliberate and it is the
 * fail-open direction: a harness, a script or a unit test with no scope
 * behaves exactly as it did before this file existed. Every production
 * entry point that spends on a club's behalf opens a scope; the list is in
 * `ai-budget.ts`.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** Thrown BEFORE a model call when the scope's daily cap is reached. The
 *  call was never made and nothing was billed. Every call site already
 *  fails closed on a thrown model call; the ones that must behave
 *  differently at the cap (the router, the attendance extractor, the
 *  group DM answer) check for this class by name. */
export class AiBudgetExceededError extends Error {
  readonly aiBudgetExceeded = true;
  constructor(
    readonly scopeKey: string,
    readonly label: string,
  ) {
    super(`AI daily cap reached for ${scopeKey}; ${label} was not called`);
    this.name = "AiBudgetExceededError";
  }
}

/** True for an `AiBudgetExceededError`, including one that crossed a
 *  module boundary (a second copy of this class under a bundler). */
export function isAiBudgetExceeded(err: unknown): err is AiBudgetExceededError {
  return (
    err instanceof AiBudgetExceededError ||
    (typeof err === "object" && err !== null && (err as { aiBudgetExceeded?: unknown }).aiBudgetExceeded === true)
  );
}

/**
 * The money held for one call between `reserve` and `settle`. Opaque to
 * everything but the ledger that issued it. It carries the DAY it was
 * taken on, so a call that starts at 23:59:59 and returns at 00:00:01 is
 * booked to the day it was allowed on, not the day it finished.
 */
export interface AiBudgetHold {
  key: string;
  day: string;
  /** What `reserve` actually held. 0 when the ledger failed open and
   *  made the call without being able to reserve anything. */
  reservedUsd: number;
}

/**
 * The accounting, as three operations. `ai-budget.ts` implements it
 * against Postgres; unit tests implement it in memory.
 *
 * CONTRACT: `reserve` throws `AiBudgetExceededError` when the cap is
 * reached and NEVER throws anything else (a database failure is logged
 * and the call is allowed: fail open). `settle` and `release` never throw.
 */
export interface AiBudgetLedger {
  /** Hold money for one call about to be made, or refuse it. */
  reserve(key: string, label: string): Promise<AiBudgetHold>;
  /** The call returned and cost `costUsd`: book it, free the hold. */
  settle(hold: AiBudgetHold, costUsd: number): Promise<void>;
  /** The call threw before anything was billed: free the hold. */
  release(hold: AiBudgetHold): Promise<void>;
}

interface Store {
  /** Null until the request knows whose money it is spending. */
  key: string | null;
  ledger: AiBudgetLedger;
}

const storage = new AsyncLocalStorage<Store>();

/** Run `fn` spending from `key`'s budget. A nested scope replaces the
 *  outer one for its own duration. */
export function runWithAiBudget<T>(key: string, ledger: AiBudgetLedger, fn: () => Promise<T>): Promise<T> {
  return storage.run({ key, ledger }, fn);
}

/** Run `fn` in a scope whose key is set later by `bindAiBudgetKey`, for a
 *  request that learns which club it is for part-way through (the analyze
 *  route resolves the org from the group id after reading the body). */
export function runWithDeferredAiBudget<T>(ledger: AiBudgetLedger, fn: () => Promise<T>): Promise<T> {
  return storage.run({ key: null, ledger }, fn);
}

/** Name the club the current deferred scope is spending for. A no-op
 *  outside a scope. */
export function bindAiBudgetKey(key: string): void {
  const s = storage.getStore();
  if (s) s.key = key;
}

/** The current scope's key and ledger, or null when calls are unguarded. */
export function currentAiBudget(): { key: string; ledger: AiBudgetLedger } | null {
  const s = storage.getStore();
  return s && s.key ? { key: s.key, ledger: s.ledger } : null;
}

/**
 * THE GUARD. Wraps one model call: reserve before, settle after.
 *
 * `costOfResult` prices what came back. A result it cannot price is
 * booked at `unpricedUsd`, never at 0, so an unknown model can only make
 * the cap stricter.
 *
 * If the call throws, the hold is released: a request that failed on the
 * wire (a 529 the SDK gave up on, a network error) is not billed by the
 * API. A response that came back and was then REJECTED by the caller (a
 * truncated body) is not a throw from here, because the caller prices
 * the response before it inspects it; see `anthropicModel`.
 */
export async function guardedModelCall<T>(
  label: string,
  call: () => Promise<T>,
  costOfResult: (r: T) => number | null,
  unpricedUsd: number,
): Promise<T> {
  const scope = currentAiBudget();
  if (!scope) return call();
  const hold = await scope.ledger.reserve(scope.key, label);
  let result: T;
  try {
    result = await call();
  } catch (err) {
    await scope.ledger.release(hold);
    throw err;
  }
  let cost: number | null = null;
  try {
    cost = costOfResult(result);
  } catch {
    cost = null;
  }
  await scope.ledger.settle(hold, cost === null || !Number.isFinite(cost) ? unpricedUsd : Math.max(0, cost));
  return result;
}
