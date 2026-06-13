/**
 * Vitest — UNIT tests only (pure logic, no DB, no network).
 *
 *   npm run test:unit
 *
 * Deliberately scoped to `src/**\/*.test.ts` so it never collides with
 * the Playwright e2e harness (e2e/**\/*.spec.ts, run via
 * `npm run test:e2e` + its embedded Postgres orchestrator).
 */
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
