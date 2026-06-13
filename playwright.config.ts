/**
 * Playwright config for the MatchTime e2e suite.
 *
 * DO NOT run `npx playwright test` directly — use `npm run test:e2e`,
 * which provisions the ISOLATED embedded Postgres first (e2e/run.ts).
 * This config refuses to start unless that orchestrator's env is
 * present and the DB URL is a local loopback address.
 */
import { defineConfig, devices } from "@playwright/test";
import { E2E, E2E_BASE_URL, assertSafeTestDbUrl, buildTestEnv } from "./e2e/helpers/env";

if (process.env.MT_E2E !== "1") {
  throw new Error(
    "Run the e2e suite via `npm run test:e2e` (it provisions the isolated " +
      "test database). Direct `playwright test` runs are blocked so the " +
      "suite can never accidentally point at a real database.",
  );
}

const testEnv = buildTestEnv();
assertSafeTestDbUrl(testEnv.DATABASE_URL);

// Make the SAME safe env visible to the Playwright worker processes —
// fixtures import src/lib/magic-link (needs AUTH_SECRET) and helpers
// connect to the test DB (MT_E2E_DATABASE_URL).
for (const [k, v] of Object.entries(testEnv)) process.env[k] = v;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /(api|web|sim)\/.*\.spec\.ts/,
  // Deterministic, state-sharing-safe: one worker, files in order.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  outputDir: ".e2e/test-results",
  use: {
    baseURL: E2E_BASE_URL,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: `npx next dev --port ${E2E.APP_PORT}`,
    url: `${E2E_BASE_URL}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: testEnv,
  },
});
