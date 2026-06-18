/**
 * Unit tests for seedFromAnalyzerRating — the pure conversion from the
 * onboarding analyser's 1–10 rating to a User.seedRating value.
 *
 * The analyser and seedRating share the SAME 1–10 band (see
 * player-rating.ts, which clamps blended ratings to [1,10]), so the
 * conversion is a clamp of a finite number; anything non-finite → null.
 *
 * Pure logic — no DB, no network.
 */
import { describe, it, expect } from "vitest";
import { seedFromAnalyzerRating } from "@/lib/seed-scale";

describe("seedFromAnalyzerRating", () => {
  it.each([
    [1, 1],
    [5.5, 5.5],
    [10, 10],
  ])("passes in-band rating %s through unchanged → %s", (input, expected) => {
    expect(seedFromAnalyzerRating(input)).toBe(expected);
  });

  it.each([
    [0, 1],
    [-3, 1],
  ])("clamps below-band rating %s up to 1", (input, expected) => {
    expect(seedFromAnalyzerRating(input)).toBe(expected);
  });

  it.each([
    [11, 10],
    [99, 10],
  ])("clamps above-band rating %s down to 10", (input, expected) => {
    expect(seedFromAnalyzerRating(input)).toBe(expected);
  });

  it.each([
    [null],
    [undefined],
    [NaN],
    [Infinity],
    [-Infinity],
  ])("maps non-finite / nullish %s → null", (input) => {
    expect(seedFromAnalyzerRating(input as number | null | undefined)).toBeNull();
  });
});
