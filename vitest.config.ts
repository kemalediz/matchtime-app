/**
 * Vitest — UNIT tests only (pure logic, no DB, no network).
 *
 *   npm run test:unit
 *
 * Scoped to `src/**\/*.test.ts` plus the incident corpus harness
 * (`e2e/corpus/**\/*.test.ts` — the pure grader/scoreboard/loader, no
 * DB and no Playwright) so it never collides with the Playwright e2e
 * harness (e2e/**\/*.spec.ts, run via `npm run test:e2e` + its embedded
 * Postgres orchestrator).
 */
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "e2e/corpus/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
