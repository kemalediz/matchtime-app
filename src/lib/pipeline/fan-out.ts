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
 * So: for each distinct cacheable prompt in the batch, the FIRST call
 * runs on its own (warm calls for different prompts run together), and
 * everything else fans out once they are done. The cost is one call's
 * latency (~2.5 to 3s) on a batch that has two or more calls for the
 * same cacheable prompt. A batch of one, and any call whose prompt is
 * too short to cache, runs exactly as before.
 */
import { EXTRACTOR_PROMPTS, extractorFor } from "./extractors";
import { EXTRACTOR_MODEL, shouldCachePrompt } from "./llm";
import type { Route } from "./types";

/**
 * The cache a route's extraction would read or write: its extractor's
 * name when that prompt clears the model's cache minimum, else null.
 * The four attendance routes share one extractor, so one key.
 *
 * Derived from `shouldCachePrompt`, the same predicate that decides
 * whether the marker goes on the request, so the two cannot disagree: a
 * prompt that grows past the minimum starts being warmed the day it
 * starts being cached.
 */
export function extractorCacheKey(route: Route): string | null {
  const kind = extractorFor(route);
  if (kind === "none") return null;
  return shouldCachePrompt(EXTRACTOR_MODEL, EXTRACTOR_PROMPTS[kind]) ? kind : null;
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
 */
export async function fanOutWarmFirst<T, R>(
  items: readonly T[],
  cacheKey: (item: T) => string | null,
  run: (item: T) => Promise<R>,
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
  const wave = (idx: number[]) =>
    Promise.all(
      idx.map(async (i) => {
        results[i] = await run(items[i]);
      }),
    );
  await wave(first);
  await wave(rest);
  return results;
}
