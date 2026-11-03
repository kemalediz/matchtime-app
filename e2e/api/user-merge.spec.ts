/**
 * Folding one User into another, against real Postgres (2026-11-03).
 *
 * The checks run under tsx (`e2e/helpers/user-merge-lib-tests.ts`): the
 * lib imports the Prisma 7 generated client, which Playwright's
 * transpiler cannot load. This spec arms the AttendanceEvent COVERAGE
 * gate around them, so an attendance move without its event in the same
 * transaction fails the merge at COMMIT. No model is involved.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { test, expect, resetDb } from "../fixtures";
import { REPO_ROOT } from "../helpers/env";
import { testDb } from "../helpers/test-db";

const execFileAsync = promisify(execFile);
const COVERAGE_SQL = path.join(REPO_ROOT, "prisma", "sql", "attendance-event-coverage.sql");

test.beforeAll(async () => {
  resetDb();
  await testDb().run(readFileSync(COVERAGE_SQL, "utf8"));
});

test.afterAll(async () => {
  // A test gate: never leave it armed for another spec.
  for (const t of ["attendance_requires_event_ins", "attendance_requires_event_upd", "attendance_requires_event_del"]) {
    await testDb().run(`DROP TRIGGER IF EXISTS ${t} ON "Attendance"`);
  }
});

test("merge one user into another: moves, conflicts, audit, idempotency (tsx, real Postgres)", async () => {
  test.setTimeout(120_000);
  const { stdout, stderr } = await execFileAsync("npx", ["tsx", "e2e/helpers/user-merge-lib-tests.ts"], {
    cwd: REPO_ROOT,
    env: process.env,
    timeout: 110_000,
  }).catch((err: Error & { stdout?: string; stderr?: string }) => {
    throw new Error(`user-merge lib tests failed:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
  });
  console.log(stdout);
  expect(stdout, stderr).toContain("OK");
});
