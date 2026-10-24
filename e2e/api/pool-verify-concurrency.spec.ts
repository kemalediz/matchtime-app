/**
 * The offer page's digits lock holds under 50 parallel guesses (local
 * player pool L5a, second review of #400, item 1). The assertions run under
 * tsx (e2e/helpers/pool-verify-lib-tests.ts) on the e2e database. Free.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, expect, resetDb } from "../fixtures";
import { REPO_ROOT } from "../helpers/env";

const execFileAsync = promisify(execFile);

test.beforeAll(() => resetDb());

test("50 wrong guesses at once on one offer: 5 recorded, 45 locked", async () => {
  test.setTimeout(120_000);
  const { stdout, stderr } = await execFileAsync("npx", ["tsx", "e2e/helpers/pool-verify-lib-tests.ts"], { cwd: REPO_ROOT, env: process.env, timeout: 110_000 }).catch(
    (err: Error & { stdout?: string; stderr?: string }) => {
      throw new Error(`pool-verify lib tests failed:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
    },
  );
  expect(stdout, stderr).toContain("OK pool verify lock");
});
