/**
 * Sampling — because a partial run must never read as a complete one.
 *
 * PURE (no clock, no randomness beyond a stated seed). A capped sweep
 * emits a plan that names the cap, the strategy, the seed, the strata
 * and EVERY key it dropped, and `partial: true` propagates into the
 * report's first line.
 *
 * Strategy: stratify by production's own intent label for the batch,
 * then round-robin. Taking the head instead would fill a cap with
 * `noise` (69% of traffic) and say nothing about the 31% that decides
 * anything.
 */
import { createHash } from "node:crypto";
import type { ReplayCase } from "./types";

export interface SamplingPlan {
  total: number;
  selected: string[];
  excludedKeys: string[];
  strategy: "all" | "stratified";
  seed: number;
  limit: number | null;
  strata: Record<string, { available: number; selected: number }>;
  /** TRUE when the sweep did not cover the whole corpus. */
  partial: boolean;
}

export interface SampleOptions {
  limit?: number | null;
  seed?: number;
}

/** The label a batch is stratified by: the most decision-bearing intent
 *  production recorded for it. Triage metadata, never an assertion. */
export function stratumOf(c: ReplayCase): string {
  const intents = c.meta.prodOutcomes.map((o) => o.intent ?? "(null)");
  return intents.find((i) => i !== "noise") ?? intents[0] ?? "(null)";
}

function order(key: string, seed: number): string {
  return createHash("sha256").update(`${seed}:${key}`).digest("hex");
}

export function planSample(cases: ReplayCase[], opts: SampleOptions = {}): SamplingPlan {
  const seed = opts.seed ?? 0;
  const limit = opts.limit ?? null;
  const strata: Record<string, { available: number; selected: number }> = {};

  const buckets = new Map<string, string[]>();
  for (const c of cases) {
    const s = stratumOf(c);
    if (!buckets.has(s)) buckets.set(s, []);
    buckets.get(s)!.push(c.key);
    strata[s] ??= { available: 0, selected: 0 };
    strata[s].available += 1;
  }

  if (limit === null || limit >= cases.length) {
    for (const s of Object.keys(strata)) strata[s].selected = strata[s].available;
    return {
      total: cases.length,
      selected: cases.map((c) => c.key),
      excludedKeys: [],
      strategy: "all",
      seed,
      limit,
      strata,
      partial: false,
    };
  }

  // Smallest stratum first, so a tight cap still touches the rare
  // intents (`team_swap`, `score`, `replacement_request`) rather than
  // spending itself on noise.
  const names = [...buckets.keys()].sort(
    (a, b) => buckets.get(a)!.length - buckets.get(b)!.length || a.localeCompare(b),
  );
  for (const n of names) {
    buckets.get(n)!.sort((x, y) => order(x, seed).localeCompare(order(y, seed)));
  }

  const selected: string[] = [];
  let progressed = true;
  while (selected.length < limit && progressed) {
    progressed = false;
    for (const n of names) {
      if (selected.length >= limit) break;
      const next = buckets.get(n)!.shift();
      if (next === undefined) continue;
      selected.push(next);
      strata[n].selected += 1;
      progressed = true;
    }
  }

  const chosen = new Set(selected);
  return {
    total: cases.length,
    selected,
    excludedKeys: cases.map((c) => c.key).filter((k) => !chosen.has(k)),
    strategy: "stratified",
    seed,
    limit,
    strata,
    partial: true,
  };
}
