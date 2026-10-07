/**
 * A match's score and the Elo it implies, against real Postgres.
 *
 * `lib/match-elo.ts` takes two row locks with raw SQL, stores a JSON
 * record on the match, and must survive two score changes racing over
 * the same players. None of that is visible to the in-memory unit suite
 * (`src/lib/__tests__/match-elo.test.ts`), so the checks run under tsx
 * (`e2e/helpers/match-elo-lib-tests.ts`) against the embedded database:
 * the lib imports the Prisma 7 generated client, which Playwright's
 * transpiler cannot load. No model is involved.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, expect, resetDb } from "../fixtures";
import { REPO_ROOT } from "../helpers/env";

const execFileAsync = promisify(execFile);

test.beforeAll(async () => {
  resetDb();
});

test("score writes, corrections and racing reconciles (tsx, real Postgres)", async () => {
  test.setTimeout(120_000);
  const { stdout, stderr } = await execFileAsync("npx", ["tsx", "e2e/helpers/match-elo-lib-tests.ts"], {
    cwd: REPO_ROOT,
    env: process.env,
    timeout: 110_000,
  }).catch((err: Error & { stdout?: string; stderr?: string }) => {
    throw new Error(`match-elo lib tests failed:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
  });
  console.log(stdout);
  expect(stdout, stderr).toContain("OK");
});
