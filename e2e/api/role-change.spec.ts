/**
 * Role changes against real Postgres (2026-10-20, FNF).
 *
 * An OWNER's role is never changed through a role edit, and every role
 * change that happens is recorded in RoleChange. The checks run under
 * tsx (`e2e/helpers/role-change-lib-tests.ts`) against the embedded
 * database: the libs import the Prisma 7 generated client, which
 * Playwright's transpiler cannot load. No model is involved.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, expect, resetDb } from "../fixtures";
import { REPO_ROOT } from "../helpers/env";

const execFileAsync = promisify(execFile);

test.beforeAll(async () => {
  resetDb();
});

test("owner guard, change log and merges (tsx, real Postgres)", async () => {
  test.setTimeout(120_000);
  const { stdout, stderr } = await execFileAsync("npx", ["tsx", "e2e/helpers/role-change-lib-tests.ts"], {
    cwd: REPO_ROOT,
    env: process.env,
    timeout: 110_000,
  }).catch((err: Error & { stdout?: string; stderr?: string }) => {
    throw new Error(`role-change lib tests failed:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
  });
  console.log(stdout);
  expect(stdout, stderr).toContain("OK");
});
