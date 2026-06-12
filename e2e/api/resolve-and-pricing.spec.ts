/**
 * Deterministic server-lib behaviour:
 *
 *   1. findExistingOrgMember + squad-from-list helpers — run under tsx
 *      (e2e/helpers/lib-tests.ts) because those libs import the Prisma 7
 *      generated client, which Playwright's transpiler can't load. The
 *      spec shells out and surfaces the tsx script's per-assertion output.
 *   2. payments pricing — pure functions (no Prisma), imported directly:
 *      the per-method fee math the pay page AND the Stripe charge share
 *      (single oracle, hardcoded expected values).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, expect, resetDb } from "../fixtures";
import { REPO_ROOT } from "../helpers/env";
// Static import — Playwright's transform only rewrites the "@/" alias for
// static imports; a runtime `await import("@/…")` fails to resolve.
import { totalForMethod, priceMethods, platformFeePence, parseFeeReply } from "@/lib/payments";

const execFileAsync = promisify(execFile);

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

test("findExistingOrgMember + squad-from-list semantics (tsx)", async () => {
  test.setTimeout(120_000);
  const { stdout, stderr } = await execFileAsync(
    "npx",
    ["tsx", "e2e/helpers/lib-tests.ts"],
    { cwd: REPO_ROOT, env: process.env, timeout: 110_000 },
  ).catch((err: Error & { stdout?: string; stderr?: string }) => {
    throw new Error(`lib-tests failed:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
  });
  console.log(stdout);
  expect(stdout, stderr).toContain("OK");
});

test.describe("payments pricing (single oracle for page + charge)", () => {
  test("per-method totals for a £8 base fee", async () => {
    // Hardcoded independently-computed oracles, qty 1:
    //   direct      = base                          → £8.00
    //   bank  0.5%+20p, +1% platform, ceil pennies  → £8.33
    //   card  1.5%+20p, +1% platform, ceil pennies  → £8.41
    expect(totalForMethod(8, "direct", 1)).toBe(8);
    expect(totalForMethod(8, "pay_by_bank", 1)).toBe(8.33);
    expect(totalForMethod(8, "card", 1)).toBe(8.41);
    // Quantity 2:
    expect(totalForMethod(8, "direct", 2)).toBe(16);
    expect(totalForMethod(8, "pay_by_bank", 2)).toBe(16.45);
    expect(totalForMethod(8, "card", 2)).toBe(16.61);
    // Platform fee = 1% of base×qty, in pence; zero for direct.
    expect(platformFeePence(8, "card", 2)).toBe(16);
    expect(platformFeePence(8, "direct", 5)).toBe(0);
    // priceMethods respects the org's enabled set + canonical ordering.
    const prices = priceMethods(8, ["card", "direct"]);
    expect(prices.map((p) => p.method)).toEqual(["card", "direct"]);
  });

  test("parseFeeReply: per-head vs total-split", async () => {
    expect(parseFeeReply("£8 each", 10)).toEqual({ perPlayer: 8, wasTotal: false });
    expect(parseFeeReply("80 total", 10)).toEqual({ perPlayer: 8, wasTotal: true });
    expect(parseFeeReply("no numbers here", 10)).toBeNull();
  });
});
