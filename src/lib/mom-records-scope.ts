/**
 * ONE READ OF A CLUB'S MAN OF THE MATCH RECORDS PER REQUEST (review of #608,
 * round 2). The inbound WhatsApp routes run their work inside this scope;
 * `mom-records.ts` keeps each club's records here while it lasts, so a group
 * stats answer (about three readers) or a DM (about six) reads them once.
 * Outside a scope every read is fresh, so nothing is served stale across
 * requests. `AsyncLocalStorage`, as `analyze-batch-context.ts`: the value
 * follows the request through every await and no other request sees it.
 *
 * Its own module, importing nothing, so a route can open the scope without
 * reaching the answer code (`admin-group-model-door.source.test.ts`).
 */
import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage<Map<string, Promise<unknown>>>();

/** Run `fn` with the club records shared by every reader inside it. Nested
 *  calls keep the outer scope. */
export function withMomRecordsScope<T>(fn: () => Promise<T>): Promise<T> {
  if (scope.getStore()) return fn();
  return scope.run(new Map(), fn);
}

/** The current request's memo, or undefined outside a scope. */
export function momRecordsMemo(): Map<string, Promise<unknown>> | undefined {
  return scope.getStore();
}
