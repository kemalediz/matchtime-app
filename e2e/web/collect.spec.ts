/**
 * Collect page (/collect/[matchId]) — the money-collector dashboard.
 *
 * Regression guards from the 2026-06 payments sessions:
 *   - the collector is EXCLUDED from the roster (they don't pay themselves)
 *   - amounts show the collector's NET (base × qty), never the gross the
 *     player paid (6b2de3f)
 *   - paid / unpaid / direct-pending states render distinctly
 *   - the Refresh button exists (8d445d2)
 *   - access control: only the collector or an org admin may view
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { MATCH, NAME } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

test("collector sees the roster with NET amounts and per-player states", async ({ page }) => {
  await signInAs(page, U.collector, `/collect/${MATCH.pay}`);
  await page.waitForURL(`**/collect/${MATCH.pay}`);

  // Scope to the page content — the app sidebar shows the signed-in
  // user's own name, which must not trip the exclusion assertion.
  const main = page.getByRole("main");

  // Collector excluded from the list they're collecting for.
  await expect(main.getByText(NAME.rater)).toBeVisible();
  await expect(main.getByText(NAME.collector)).toHaveCount(0);

  // Riley paid by card for 2 — the row must show NET £16 (8×2), NOT the
  // £16.61 gross that includes Stripe + platform fees.
  const rileyRow = main.locator("div").filter({ hasText: NAME.rater }).last();
  await expect(rileyRow.getByText("£16")).toBeVisible();
  await expect(main.getByText("£16.61")).toHaveCount(0);
  await expect(rileyRow.getByText(/Paid/)).toBeVisible();

  // Gary said he'll pay directly → "Paying you directly" pending state.
  const garyRow = main.locator("div").filter({ hasText: NAME.guest }).last();
  await expect(garyRow.getByText(/Paying you directly/)).toBeVisible();

  // Pat is plain unpaid.
  const patRow = main.locator("div").filter({ hasText: NAME.player }).last();
  await expect(patRow.getByText(/Unpaid/)).toBeVisible();

  // Refresh button present.
  await expect(main.getByRole("button", { name: /refresh/i })).toBeVisible();

  // Header shows the per-player fee.
  await expect(main.getByText(/Fee £8 per player/)).toBeVisible();
});

test("marking a direct payment received flips the row to Paid", async ({ page, db }) => {
  await signInAs(page, U.collector, `/collect/${MATCH.pay}`);
  await page.waitForURL(`**/collect/${MATCH.pay}`);

  const garyRow = page
    .locator("div")
    .filter({ hasText: NAME.guest })
    .filter({ has: page.getByRole("button", { name: /mark received/i }) })
    .last();
  await garyRow.getByRole("button", { name: /mark received/i }).click();
  await expect(page.getByText("Marked as paid")).toBeVisible();

  await expect
    .poll(async () => {
      const att = await db.one<{ paidAt: Date | null; directPendingAt: Date | null }>(
        `SELECT "paidAt", "directPendingAt" FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
        [MATCH.pay, U.guest],
      );
      return att?.paidAt != null && att.directPendingAt == null;
    })
    .toBe(true);
});

// Free places (2026-10-16): "Mark free" beside "Mark received". A free
// place reads "Free place", leaves "N/M paid" and "collected", shows a
// count, and can be undone. The player's pay page says nothing to pay.
test("Mark free: the row reads Free place, out of the paid count, and Undo puts it back", async ({ page, db }) => {
  resetDb();
  await signInAs(page, U.collector, `/collect/${MATCH.pay}`);
  await page.waitForURL(`**/collect/${MATCH.pay}`);
  const main = page.getByRole("main");
  // Seed: Riley paid; Pat, Gary (direct, pending) and Ian not.
  await expect(main.getByText("1/4 paid")).toBeVisible();

  const patRow = main.getByTestId(`collect-row-${U.player}`);
  await expect(patRow.getByRole("button", { name: "Mark free" })).toBeVisible();
  await patRow.getByRole("button", { name: "Mark free" }).click();
  await expect(page.getByText("Marked as a free place")).toBeVisible();

  await expect(patRow.getByText("Free place")).toBeVisible();
  await expect(patRow.getByRole("button", { name: /mark received/i })).toHaveCount(0);
  await expect(main.getByText("1/3 paid")).toBeVisible();
  await expect(main.getByTestId("collect-free-count")).toHaveText(" · 1 free");
  // Collected is still Riley's £16 only.
  await expect(main.getByText(/£16 collected/)).toBeVisible();

  const row = await db.one<{ feeWaivedAt: Date | null; feeWaivedByUserId: string | null; paidAt: Date | null }>(
    `SELECT "feeWaivedAt", "feeWaivedByUserId", "paidAt" FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.pay, U.player],
  );
  expect(row?.feeWaivedAt).not.toBeNull();
  expect(row?.feeWaivedByUserId).toBe(U.collector);
  expect(row?.paidAt).toBeNull();

  await patRow.getByRole("button", { name: "Undo free" }).click();
  await expect(page.getByText("Free place removed")).toBeVisible();
  await expect(main.getByText("1/4 paid")).toBeVisible();
  await expect(patRow.getByText(/Unpaid/)).toBeVisible();
});

test("the player on a free place opens their pay link: nothing to pay, no buttons", async ({ page, db }) => {
  resetDb();
  await db.run(`UPDATE "Attendance" SET "feeWaivedAt" = now(), "feeWaivedReason" = 'organiser' WHERE "matchId" = $1 AND "userId" = $2`, [
    MATCH.pay,
    U.player,
  ]);
  await signInAs(page, U.player, `/pay/${MATCH.pay}`);
  await page.waitForURL(`**/pay/${MATCH.pay}`);
  await expect(page.getByTestId("pay-free")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Nothing to pay" })).toBeVisible();
  await expect(page.getByText("Pat, you're on a free place for E2E 5-a-side. Nothing to pay.")).toBeVisible();
  await expect(page.getByRole("button", { name: /pay/i })).toHaveCount(0);
  resetDb();
});

test("a non-collector, non-admin player is bounced to home", async ({ page }) => {
  await signInAs(page, U.player, `/collect/${MATCH.pay}`);
  // The server redirects to "/" — we must NOT end up on the collect page.
  await page.waitForURL((u) => !u.pathname.startsWith("/collect"), { timeout: 30_000 });
  expect(new URL(page.url()).pathname).not.toContain("/collect");
});

test("an org admin (non-collector) IS allowed in", async ({ page }) => {
  await signInAs(page, U.admin, `/collect/${MATCH.pay}`);
  await page.waitForURL(`**/collect/${MATCH.pay}`);
  await expect(page.getByText(/paid/i).first()).toBeVisible();
});
