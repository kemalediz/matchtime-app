/**
 * Money path — Stripe webhook outcome handling + the pay guards.
 *
 *   1. The DB-touching half runs under tsx (e2e/helpers/payment-lib-tests.ts)
 *      because src/lib/payment-flow.ts imports the Prisma 7 generated
 *      client, which Playwright's transpiler can't load. The spec shells
 *      out and surfaces its per-assertion output.
 *   2. The pure decision core is imported directly (no Prisma, no Stripe):
 *      the same oracle the webhook and the pay actions share.
 *
 * The Stripe API is never called — sessions are plain objects shaped like
 * a webhook payload.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, expect, resetDb } from "../fixtures";
import { REPO_ROOT } from "../helpers/env";
// Static import — Playwright's transform only rewrites the "@/" alias for
// static imports; a runtime `await import("@/…")` fails to resolve.
import { decideCheckoutEvent, payBlockedReason } from "@/lib/payment-outcome";

const execFileAsync = promisify(execFile);

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

test("checkout outcome + pay-guard semantics against the DB (tsx)", async () => {
  test.setTimeout(120_000);
  const { stdout, stderr } = await execFileAsync(
    "npx",
    ["tsx", "e2e/helpers/payment-lib-tests.ts"],
    { cwd: REPO_ROOT, env: process.env, timeout: 110_000 },
  ).catch((err: Error & { stdout?: string; stderr?: string }) => {
    throw new Error(`payment-lib-tests failed:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
  });
  console.log(stdout);
  expect(stdout, stderr).toContain("OK");
});

test.describe("checkout decision (pure)", () => {
  test("only a settled payment_status marks a player paid", () => {
    expect(decideCheckoutEvent("checkout.session.completed", "paid")).toBe("mark-paid");
    // Pay by Bank: the session completes long before the money moves.
    expect(decideCheckoutEvent("checkout.session.completed", "unpaid")).toBe("await-settlement");
    expect(decideCheckoutEvent("checkout.session.async_payment_succeeded", "paid")).toBe("mark-paid");
    expect(decideCheckoutEvent("checkout.session.async_payment_failed", "unpaid")).toBe(
      "reverse-unpaid",
    );
    expect(decideCheckoutEvent("checkout.session.expired", "unpaid")).toBe("ignore");
  });
});

test.describe("pay guards (pure)", () => {
  test("blocks double payment, cancelled matches and dropped players", () => {
    const base = { paidAt: null, attendanceStatus: "CONFIRMED", matchStatus: "COMPLETED" };
    expect(payBlockedReason(base)).toBeNull();
    expect(payBlockedReason({ ...base, paidAt: new Date() })).toMatch(/already paid/i);
    expect(payBlockedReason({ ...base, matchStatus: "CANCELLED" })).toMatch(/cancelled/i);
    expect(payBlockedReason({ ...base, attendanceStatus: "DROPPED" })).toMatch(/dropped out/i);
  });
});
