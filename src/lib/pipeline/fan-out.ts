/**
 * WARM THE PROMPT CACHE, THEN FAN OUT (2026-09-29).
 *
 * Every batch runner extracts its messages in parallel. Each extractor
 * call carries the same long system prompt with a cache marker, and a
 * cache entry only exists once a call has FINISHED writing it. So calls
 * that all start together all write the cache (1.25x input on a
 * five-minute entry, 2x on a one-hour one) and none of them reads it
 * (0.1x).
 *
 * Measured on Sutton FC's morning of 2026-09-29: 13 attendance
 * extractions and zero cache reads. Each call paid ~$0.0088 to write the
 * 3,522-token prompt, most of its ~$0.011.
 *
 * So: for each distinct cached prompt in the batch, the FIRST call runs
 * on its own (warm calls for different prompts run together), and
 * everything else fans out once they are done. The cost is one call's
 * latency (~2.5 to 3s) on a batch that has two or more calls for the
 * same prompt. A batch of one, and any item that makes no model call,
 * runs exactly as before.
 *
 * The dev harnesses use the same function for parallel router sweeps
 * (`ROUTER_CACHE_KEY`, with a concurrency limit), so N parallel starts
 * pay one write instead of N.
 */
import { extractorFor } from "./extractors";
import type { Route } from "./types";

/** The router's one prompt, as a cache key for `fanOutWarmFirst`. */
export const ROUTER_CACHE_KEY = "router";

/**
 * The cache a route's extraction reads or writes: its extractor's name,
 * or null for `none`, which makes no call. The four attendance routes
 * share one extractor, so one key.
 *
 * Every extractor request carries the cache marker (`systemBlock` in
 * llm.ts), and every extractor prompt clears Sonnet 5's 1,024-token
 * minimum once its schema is counted (MEASURED 2026-10-19, count_tokens
 * on the captured bodies: teams 1,175, score 2,000, admin 1,880), so
 * every one is worth warming.
 */
export function extractorCacheKey(route: Route): string | null {
  const kind = extractorFor(route);
  return kind === "none" ? null : kind;
}

/**
 * Run `run` once per item and return the results IN INPUT ORDER. For
 * each non-null cache key, the first item with that key runs in the
 * first wave; the rest of that key's items run after the whole first
 * wave has finished. Items with a null key make no cached call and run
 * in the first wave.
 *
 * Rejects like `Promise.all` does: if a first-wave item throws, the
 * second wave does not start. The batch runners' `run` functions do not
 * throw (extraction failures come back as degradations).
 *
 * `concurrency` caps how many items of each wave are in flight at once
 * (a harness sweep); omitted, each wave is fully parallel.
 */
export async function fanOutWarmFirst<T, R>(
  items: readonly T[],
  cacheKey: (item: T) => string | null,
  run: (item: T) => Promise<R>,
  opts?: { concurrency?: number },
): Promise<R[]> {
  const warmed = new Set<string>();
  const first: number[] = [];
  const rest: number[] = [];
  items.forEach((item, i) => {
    const key = cacheKey(item);
    if (key !== null && warmed.has(key)) {
      rest.push(i);
    } else {
      if (key !== null) warmed.add(key);
      first.push(i);
    }
  });
  const results = new Array<R>(items.length);
  const limit = Math.max(1, opts?.concurrency ?? Infinity);
  const wave = async (idx: number[]) => {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(limit, idx.length) }, async () => {
        while (next < idx.length) {
          const i = idx[next++];
          results[i] = await run(items[i]);
        }
      }),
    );
  };
  await wave(first);
  await wave(rest);
  return results;
}
