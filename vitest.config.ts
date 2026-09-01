/**
 * Vitest — UNIT tests only (pure logic, no DB, no network).
 *
 *   npm run test:unit
 *
 * Scoped to `src/**\/*.test.ts` plus two pieces of the e2e harness that
 * are not Playwright specs:
 *   - `e2e/corpus/**\/*.test.ts` — the pure grader/scoreboard/loader.
 *   - `e2e/helpers/**\/*.test.ts` — the port allocator and the isolation
 *     proofs. These DO start throwaway databases (that is the point: a
 *     config assertion would prove nothing), but they never touch the
 *     suite's own fixture world.
 * so it never collides with the Playwright e2e harness
 * (e2e/{api,web,sim}/**\/*.spec.ts, run via `npm run test:e2e` + its
 * embedded Postgres orchestrator).
 */
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "e2e/corpus/**/*.test.ts", "e2e/helpers/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
