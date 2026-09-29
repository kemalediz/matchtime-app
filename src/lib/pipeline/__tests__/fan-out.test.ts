/**
 * WARM THE CACHE, THEN FAN OUT (2026-09-29).
 *
 * Measured on Sutton FC's morning of 2026-09-29: 13 attendance
 * extractions, and not one read the prompt cache. Calls fanned out with
 * `Promise.all` all start before any of them has written the cache, so
 * every one of them WRITES it (1.25x input) instead of the later ones
 * READING it (0.1x). The system prompt write was ~$0.0088 of each
 * ~$0.011 call.
 *
 * `fanOutWarmFirst` runs one call per cacheable prompt first, then the
 * rest in parallel. These pin the ordering, and that nothing changes for
 * a batch of one or for a prompt too short to cache.
 */
import { describe, expect, it } from "vitest";
import { EXTRACTOR_PROMPTS, extractorFor } from "../extractors";
import { EXTRACTOR_MODEL, shouldCachePrompt } from "../llm";
import { extractorCacheKey, fanOutWarmFirst } from "../fan-out";
import type { Route } from "../types";

/** Runs each item as a fake call that takes `ms`, logging start and end. */
function recorder(ms = 5) {
  const log: string[] = [];
  const run = async (id: string) => {
    log.push(`start:${id}`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`end:${id}`);
  };
  return { log, run };
}

describe("fanOutWarmFirst", () => {
  it("finishes the first call of a cacheable prompt before the others start", async () => {
    const { log, run } = recorder();
    await fanOutWarmFirst(["a", "b", "c"], () => "attendance", run);
    expect(log.slice(0, 2)).toEqual(["start:a", "end:a"]);
    // The rest run together, not one after another.
    expect(log.slice(2, 4).sort()).toEqual(["start:b", "start:c"]);
    expect(log).toHaveLength(6);
  });

  it("a batch of one is one call, with nothing to wait for", async () => {
    const { log, run } = recorder();
    await fanOutWarmFirst(["a"], () => "attendance", run);
    expect(log).toEqual(["start:a", "end:a"]);
  });

  it("warms two different prompts at the same time, one call each", async () => {
    const { log, run } = recorder();
    const key = (id: string) => (id.startsWith("q") ? "question" : "attendance");
    await fanOutWarmFirst(["a1", "q1", "a2", "q2"], key, run);
    // Both warm calls start before either ends.
    expect(log.slice(0, 2).sort()).toEqual(["start:a1", "start:q1"]);
    expect(log.slice(2, 4).sort()).toEqual(["end:a1", "end:q1"]);
    expect(log.slice(4, 6).sort()).toEqual(["start:a2", "start:q2"]);
  });

  it("does not sequence calls whose prompt cannot cache: they stay fully parallel", async () => {
    const { log, run } = recorder();
    await fanOutWarmFirst(["a", "b", "c"], () => null, run);
    expect(log.slice(0, 3).sort()).toEqual(["start:a", "start:b", "start:c"]);
  });

  it("gives every item exactly one run, in any mix", async () => {
    const seen: string[] = [];
    const key = (id: string) => (id === "x" ? null : "attendance");
    await fanOutWarmFirst(["a", "x", "b", "c"], key, async (id) => {
      seen.push(id);
    });
    expect(seen.sort()).toEqual(["a", "b", "c", "x"]);
  });

  it("returns each item's result in input order, whichever wave ran it", async () => {
    const key = (id: string) => (id === "x" ? null : "attendance");
    const out = await fanOutWarmFirst(["a", "b", "x", "c"], key, async (id) => id.toUpperCase());
    expect(out).toEqual(["A", "B", "X", "C"]);
  });

  it("an empty batch does nothing", async () => {
    const { log, run } = recorder();
    await fanOutWarmFirst([], () => "attendance", run);
    expect(log).toEqual([]);
  });
});

describe("extractorCacheKey: which routes share a cacheable prompt", () => {
  const ROUTES: Route[] = ["self_att", "other_att", "offer", "unsure", "question", "balancer", "score", "admin_ops", "none"];

  it("keys a route by its extractor exactly when that prompt clears the model's cache minimum", () => {
    for (const route of ROUTES) {
      const kind = extractorFor(route);
      const expected =
        kind !== "none" && shouldCachePrompt(EXTRACTOR_MODEL, EXTRACTOR_PROMPTS[kind]) ? kind : null;
      expect(extractorCacheKey(route), route).toBe(expected);
    }
  });

  it("puts the four attendance routes on ONE key, so a mixed batch warms once", () => {
    const keys = new Set((["self_att", "other_att", "offer", "unsure"] as Route[]).map(extractorCacheKey));
    expect([...keys]).toEqual(["attendance"]);
  });

  it("the question extractor caches too; score, teams and admin do not (today)", () => {
    expect(extractorCacheKey("question")).toBe("question");
    expect(extractorCacheKey("score")).toBeNull();
    expect(extractorCacheKey("balancer")).toBeNull();
    expect(extractorCacheKey("admin_ops")).toBeNull();
    expect(extractorCacheKey("none")).toBeNull();
  });
});
