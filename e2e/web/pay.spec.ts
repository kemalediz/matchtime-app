/**
 * Pay page (/pay/[matchId]).
 *
 *   - all three methods render when enabled, with the exact per-method
 *     totals (same oracle values as the pricing unit tests: £8 base →
 *     bank £8.33, card £8.41, direct £8)
 *   - quantity stepper reprices every method live
 *   - "pay directly" marks direct-pending, DMs the collector ONCE
 *     (e013b6d: repeat taps must not re-notify)
 *   - card/bank reach the Stripe boundary and surface its error here
 *     (Stripe itself is external — never driven in tests)
 *   - already-paid players see the settled state
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { MATCH, ORG_ID, PHONE } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

test("three methods render with correct per-method totals", async ({ page }) => {
  await signInAs(page, U.player, `/pay/${MATCH.pay}`);
  await page.waitForURL(`**/pay/${MATCH.pay}`);

  await expect(page.getByText("Match fee:")).toBeVisible();

  const bank = page.getByRole("button", { name: /Pay by Bank/ });
  const card = page.getByRole("button", { name: /Card, Apple or Google Pay/ });
  const direct = page.getByRole("button", { name: /Pay the collector directly/ });
  await expect(bank).toBeVisible();
  await expect(card).toBeVisible();
  await expect(direct).toBeVisible();

  // £8 base → oracle totals (fees are the PLAYER's, collector nets £8).
  await expect(bank).toContainText("£8.33");
  await expect(card).toContainText("£8.41");
  await expect(direct).toContainText("£8");
  await expect(direct).toContainText("no fee");
});

test("quantity stepper reprices all methods", async ({ page }) => {
  await signInAs(page, U.player, `/pay/${MATCH.pay}`);
  await page.waitForURL(`**/pay/${MATCH.pay}`);

  await page.getByRole("button", { name: "More" }).click(); // qty → 2
  await expect(page.getByText(/Paying for yourself \+ 1 other/)).toBeVisible();

  await expect(page.getByRole("button", { name: /Pay by Bank/ })).toContainText("£16.45");
  await expect(page.getByRole("button", { name: /Card, Apple or Google Pay/ })).toContainText("£16.61");
  await expect(page.getByRole("button", { name: /Pay the collector directly/ })).toContainText("£16");

  await page.getByRole("button", { name: "Fewer" }).click(); // back to 1
  await expect(page.getByRole("button", { name: /Pay by Bank/ })).toContainText("£8.33");
});

test("card/bank click reaches the Stripe boundary (external — not driven)", async ({ page }) => {
  await signInAs(page, U.player, `/pay/${MATCH.pay}`);
  await page.waitForURL(`**/pay/${MATCH.pay}`);

  // The test org has stripeChargesEnabled but no Connect account and the
  // server runs with STRIPE_SECRET_KEY unset — the server action must
  // fail loudly AT the Stripe boundary, surfaced as a toast, never a
  // silent success or a crash.
  await page.getByRole("button", { name: /Card, Apple or Google Pay/ }).click();
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: /bank|stripe|couldn't start payment/i }).first(),
  ).toBeVisible({ timeout: 15_000 });
});

const collectorDmCount = (db: TestDb) =>
  db.count(
    `SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2 AND text LIKE '%pay you directly%'`,
    [ORG_ID, PHONE.collector.replace(/^\+/, "")],
  );

test("'pay directly' marks pending and notifies the collector exactly once", async ({ page, db }) => {
  const before = await collectorDmCount(db);

  await signInAs(page, U.fresh, `/pay/${MATCH.pay}`);
  await page.waitForURL(`**/pay/${MATCH.pay}`);
  await page.getByRole("button", { name: /Pay the collector directly/ }).click();

  // Page reloads into the "paying directly" pending state.
  await expect(page.getByText(/Paying the organiser directly/)).toBeVisible({ timeout: 15_000 });

  const att = await db.one<{
    paymentMethod: string | null;
    directPendingAt: Date | null;
    paidAt: Date | null;
  }>(
    `SELECT "paymentMethod", "directPendingAt", "paidAt" FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.pay, U.fresh],
  );
  expect(att?.paymentMethod).toBe("direct");
  expect(att?.directPendingAt).not.toBeNull();
  expect(att?.paidAt).toBeNull();
  expect(await collectorDmCount(db)).toBe(before + 1);

  // Repeat tap while still pending → state refresh only, NO second DM.
  await page.getByRole("button", { name: /Pay the collector directly/ }).click();
  await expect(page.getByText(/Paying the organiser directly/)).toBeVisible({ timeout: 15_000 });
  expect(await collectorDmCount(db)).toBe(before + 1);
});

test("already-paid player sees the settled state, no pay buttons", async ({ page }) => {
  await signInAs(page, U.rater, `/pay/${MATCH.pay}`);
  await page.waitForURL(`**/pay/${MATCH.pay}`);
  await expect(page.getByText(/You're all paid/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Pay by Bank/ })).toHaveCount(0);
});
