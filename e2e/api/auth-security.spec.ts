/**
 * Email/password auth security — password injection onto passwordless
 * accounts, and brute-forceability of the 6-digit verification code.
 *
 * The assertions live in e2e/helpers/auth-security-tests.ts and run under
 * tsx (the auth server action imports the Prisma 7 generated client, which
 * Playwright's transpiler can't load). This spec shells out and surfaces
 * the script's per-assertion output.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, expect } from "../fixtures";
import { REPO_ROOT } from "../helpers/env";

const execFileAsync = promisify(execFile);

test("email auth: no password injection, code is attempt-capped (tsx)", async () => {
  test.setTimeout(120_000);
  const { stdout, stderr } = await execFileAsync(
    "npx",
    ["tsx", "e2e/helpers/auth-security-tests.ts"],
    { cwd: REPO_ROOT, env: process.env, timeout: 110_000 },
  ).catch((err: Error & { stdout?: string; stderr?: string }) => {
    throw new Error(`auth-security-tests failed:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
  });
  console.log(stdout);
  expect(stdout, stderr).toContain("OK");
});
