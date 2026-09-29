/**
 * The `msgRetryCounterCache` handed to `makeWASocket`.
 *
 * Baileys counts, per `<messageId>:<participant>`, how many retry receipts
 * it has sent for a message it could not decrypt, and how many times it
 * has re-sent one of OUR messages when a recipient asked. When no cache is
 * passed it builds a fresh one inside every socket (`messages-recv.js`,
 * `config.msgRetryCounterCache || new NodeCache(...)`), and this driver
 * builds a new socket on every reconnect. Baileys' own documentation says
 * to keep this cache outside the socket so a reconnect does not reset the
 * counts. This is that cache, created once per process.
 *
 * It implements Baileys' `CacheStore` (get, set, del, flushAll) over a Map,
 * with the same one-hour lifetime as Baileys' default
 * (`DEFAULT_CACHE_TTLS.MSG_RETRY`), and bounded so a long-running bot does
 * not hold every id it has ever retried. Written here rather than
 * importing Baileys' transitive `@cacheable/node-cache`, which is not a
 * dependency of this package.
 */

export interface RetryCounterCache {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  del(key: string): void;
  flushAll(): void;
}

export const RETRY_CACHE_TTL_MS = 60 * 60 * 1000;
export const RETRY_CACHE_MAX = 5_000;

export function createRetryCounterCache(
  opts: { ttlMs?: number; max?: number; now?: () => number } = {},
): RetryCounterCache {
  const ttlMs = opts.ttlMs ?? RETRY_CACHE_TTL_MS;
  const max = opts.max ?? RETRY_CACHE_MAX;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, { value: unknown; expiresAt: number }>();

  return {
    get<T>(key: string): T | undefined {
      const e = entries.get(key);
      if (!e) return undefined;
      if (now() >= e.expiresAt) {
        entries.delete(key);
        return undefined;
      }
      return e.value as T;
    },
    set<T>(key: string, value: T): void {
      // Re-inserted so a Map's insertion order stays "oldest first".
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + ttlMs });
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    del(key: string): void {
      entries.delete(key);
    },
    flushAll(): void {
      entries.clear();
    },
  };
}
