/**
 * Quoted-reply context in the groups, slice S4 (2026-10-20): what a reply
 * in the players' group or HQ quotes, resolved against real Postgres
 * (tsx, e2e/helpers/group-reply-context-lib-tests.ts). The live checks of
 * what the models make of it are in scripts/live-check-group-reply-context.ts.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, expect, resetDb } from "../fixtures";
import { REPO_ROOT } from "../helpers/env";

const execFileAsync = promisify(execFile);

test.describe.configure({ mode: "serial" });

test.beforeEach(async () => {
  resetDb();
});

test("the group resolver against real Postgres (tsx)", async () => {
  test.setTimeout(120_000);
  const { stdout, stderr } = await execFileAsync("npx", ["tsx", "e2e/helpers/group-reply-context-lib-tests.ts"], {
    cwd: REPO_ROOT,
    env: process.env,
    timeout: 110_000,
  }).catch((err: Error & { stdout?: string; stderr?: string }) => {
    throw new Error(`group reply-context lib tests failed:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
  });
  console.log(stdout);
  expect(stdout, stderr).toContain("OK");
});
