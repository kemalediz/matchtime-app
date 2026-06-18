/**
 * ONBOARDING ENRICHMENT ANALYZER — LIVE-LLM shape validation.
 *
 * Per the global TDD rule for LLM steps, this validates that the REAL
 * Anthropic model returns the right SHAPE when analysing a realistic
 * football group-chat history — NOT exact values (the model is
 * non-deterministic, so we never assert specific positions/ratings).
 *
 * Opt-in: this whole describe block only runs when MT_SIM_LIVE_LLM=1.
 * When the flag is OFF (the default for `npm run test:sim` /
 * `npm run test:e2e`), the entire file is SKIPPED — so it never breaks
 * the stubbed suite and never spends credits unintentionally.
 *
 * Under `MT_SIM_LIVE_LLM=1 tsx e2e/run.ts ...`, run.ts loads the
 * repo-root .env into process.env, then helpers/env.ts buildTestEnv()
 * propagates the real ANTHROPIC_API_KEY into the Playwright worker that
 * runs this spec. We call the analyzer in-process (no DB, no group, no
 * HTTP) since it only needs process.env.ANTHROPIC_API_KEY + its args.
 *
 * Runs the SAME shape check 3 times to confirm the model is consistently
 * shaped across runs.
 */
import { test, expect } from "../fixtures";
import {
  analyzeForOnboarding,
  type OnboardingAnalysis,
} from "@/lib/onboarding-analyzer";
import {
  buildParsedChatFromHistory,
  type HistoryMessage,
} from "@/lib/onboarding-enrichment-reconcile";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

const SPORT_NAME = "Football 7-a-side";
const VALID_POSITIONS = ["GK", "DEF", "MID", "FWD"];
const CANDIDATE_NAMES = ["Najib", "Talha", "Amir", "Khalid", "Sami", "Bilal", "Omar"];

/** A small, realistic football group history, chronological over ~2 weeks. */
function buildHistory(): HistoryMessage[] {
  // Anchor dates around a couple of Thursdays so the model has a schedule
  // pattern to latch onto. Times are London wall-clock-ish.
  const d = (iso: string) => new Date(iso);
  return [
    { author: "Najib", text: "Good game last week lads", timestamp: d("2026-06-01T20:10:00Z") },
    { author: "Talha", text: "Same time this week? Thursday 8pm Goals Sutton yeah", timestamp: d("2026-06-02T09:30:00Z") },
    { author: "Khalid", text: "Yeah Thursday works for me, count me in", timestamp: d("2026-06-02T09:45:00Z") },
    { author: "Omar", text: "Najib saved us again last night, unreal in goal", timestamp: d("2026-06-05T22:05:00Z") },
    { author: "Sami", text: "Talha hat-trick! 3 goals Thursday, absolute machine up front", timestamp: d("2026-06-05T22:10:00Z") },
    { author: "Amir", text: "Squad for Thursday: Najib, Talha, Amir, Khalid, Sami, Bilal, Omar", timestamp: d("2026-06-08T12:00:00Z") },
    { author: "Bilal", text: "Amir bossing midfield as always, ran the game", timestamp: d("2026-06-08T18:20:00Z") },
    { author: "Talha", text: "Khalid solid at the back again, nothing got past him", timestamp: d("2026-06-09T08:15:00Z") },
    { author: "Khalid", text: "Cheers, defending is my thing", timestamp: d("2026-06-09T08:30:00Z") },
    { author: "Omar", text: "Thursday 8pm again at Goals Sutton, usual spot", timestamp: d("2026-06-11T19:00:00Z") },
    { author: "Sami", text: "I'll play wherever, happy in midfield or up top", timestamp: d("2026-06-11T19:10:00Z") },
    { author: "Bilal", text: "Najib in goal, Khalid and me at the back, sorted", timestamp: d("2026-06-12T20:40:00Z") },
    { author: "Najib", text: "See everyone Thursday, 8pm sharp", timestamp: d("2026-06-12T20:55:00Z") },
  ];
}

(LIVE ? test.describe : test.describe.skip)(
  "onboarding enrichment analyzer LIVE (real Anthropic)",
  () => {
    function assertShape(result: OnboardingAnalysis | null) {
      // Pretty-print the full sample so we can eyeball it in CI output.
      console.log(
        "[onboarding-enrichment-live] analyzer result:\n" +
          JSON.stringify(result, null, 2),
      );

      expect(result, "analyzer returned null — key missing or call failed").not.toBeNull();
      const r = result as OnboardingAnalysis;

      // ── players ──────────────────────────────────────────────────────
      expect(Array.isArray(r.players)).toBe(true);
      expect(r.players.length).toBeGreaterThan(0);

      const candidateSet = new Set(CANDIDATE_NAMES);
      const positionSet = new Set(VALID_POSITIONS);
      let anyExtracted = false;

      for (const p of r.players) {
        // Every name must be one of the candidates.
        expect(candidateSet.has(p.name)).toBe(true);

        // Non-null position must be a valid position.
        if (p.position !== null) {
          expect(positionSet.has(p.position)).toBe(true);
        }

        // Non-null seedRating must be a number in [1, 10].
        if (p.seedRating !== null) {
          expect(typeof p.seedRating).toBe("number");
          expect(p.seedRating).toBeGreaterThanOrEqual(1);
          expect(p.seedRating).toBeLessThanOrEqual(10);
        }

        // Evidence is always a string (may be empty for backfilled players).
        expect(typeof p.evidence).toBe("string");

        // Confidence is a number in [0, 1].
        expect(typeof p.confidence).toBe("number");
        expect(p.confidence).toBeGreaterThanOrEqual(0);
        expect(p.confidence).toBeLessThanOrEqual(1);

        if (p.position !== null || p.seedRating !== null) anyExtracted = true;
      }

      // The model must have extracted SOMETHING from the chat.
      expect(anyExtracted, "model extracted no position/rating for any player").toBe(true);

      // ── schedule ─────────────────────────────────────────────────────
      expect(r.schedule).toBeTruthy();
      if (r.schedule.time !== null) {
        expect(r.schedule.time).toMatch(/^\d{2}:\d{2}$/);
      }
      if (r.schedule.dayOfWeek !== null) {
        expect(r.schedule.dayOfWeek).toBeGreaterThanOrEqual(0);
        expect(r.schedule.dayOfWeek).toBeLessThanOrEqual(6);
      }
      console.log(
        `[onboarding-enrichment-live] schedule venue=${JSON.stringify(r.schedule.venue)} ` +
          `day=${r.schedule.dayOfWeek} time=${r.schedule.time}`,
      );

      // ── paymentHolder (shape only — may be null) ─────────────────────
      expect(r.paymentHolder).toBeTruthy();
      if (r.paymentHolder.name !== null) {
        expect(candidateSet.has(r.paymentHolder.name)).toBe(true);
      }
    }

    for (let i = 1; i <= 3; i++) {
      test(`shape run #${i}`, async () => {
        test.setTimeout(120_000); // a real Anthropic call can take 10–60s

        if (!process.env.ANTHROPIC_API_KEY) {
          test.skip(
            true,
            "ANTHROPIC_API_KEY not visible in worker — run via `MT_SIM_LIVE_LLM=1 tsx e2e/run.ts sim/onboarding-enrichment-live.spec.ts`",
          );
          return;
        }

        const parsed = buildParsedChatFromHistory(buildHistory());
        const result = await analyzeForOnboarding({
          parsed,
          sportName: SPORT_NAME,
          validPositions: VALID_POSITIONS,
          candidateNames: CANDIDATE_NAMES,
        });

        assertShape(result);
      });
    }
  },
);
