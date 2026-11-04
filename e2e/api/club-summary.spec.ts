/**
 * The club summary (slice A0, MDs/club-summary-design-2026-11-04.md) loaded
 * from real Postgres for a monthly and a weekly club shape. The checks run
 * under tsx (`e2e/helpers/club-summary-lib-tests.ts`): the loader imports
 * the Prisma 7 generated client, which Playwright's transpiler cannot load.
 * No model is involved ($0).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, expect, resetDb } from "../fixtures";
import { REPO_ROOT } from "../helpers/env";

const execFileAsync = promisify(execFile);

test.beforeAll(async () => {
  resetDb();
});

test("the club summary loads each club shape from real Postgres (tsx)", async () => {
  test.setTimeout(120_000);
  const { stdout, stderr } = await execFileAsync("npx", ["tsx", "e2e/helpers/club-summary-lib-tests.ts"], {
    cwd: REPO_ROOT,
    env: process.env,
    timeout: 110_000,
  }).catch((err: Error & { stdout?: string; stderr?: string }) => {
    throw new Error(`club-summary lib tests failed:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
  });
  console.log(stdout);
  expect(stdout, stderr).toContain("OK");
});
