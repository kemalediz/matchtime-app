/**
 * One match switched to another size inside its game's range (2026-11-03,
 * the Vets play 6, 7 or 8 a side), against real Postgres. The checks run
 * under tsx (`e2e/helpers/review-517-resize-race.ts`): the lib imports the
 * Prisma 7 generated client, which Playwright's transpiler cannot load. No
 * model is involved.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, expect, resetDb } from "../fixtures";
import { REPO_ROOT } from "../helpers/env";

const execFileAsync = promisify(execFile);

test.beforeAll(async () => {
  resetDb();
});

test("review 517: resizeMatch against concurrent writers (tsx, real Postgres)", async () => {
  test.setTimeout(120_000);
  const { stdout, stderr } = await execFileAsync("npx", ["tsx", "e2e/helpers/review-517-resize-race.ts"], {
    cwd: REPO_ROOT,
    env: process.env,
    timeout: 110_000,
  }).catch((err: Error & { stdout?: string; stderr?: string }) => {
    throw new Error(`review-517 race tests failed:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
  });
  console.log(stdout);
  expect(stdout, stderr).toContain("OK");
});
