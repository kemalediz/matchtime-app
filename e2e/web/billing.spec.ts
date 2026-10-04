/**
 * Club fee billing, slice B2: the web. Plan:
 * MDs/club-fee-billing-plan-2026-10-01.md, sections 4.5, 8.1 to 8.3.
 *
 *   1. /billing/[orgId] per role: the money collector who is a PLAYER is
 *      the contact (full view, live card buttons since slice B3) and
 *      still cannot open /admin; the owner reads only; an old card holder
 *      sees Remove my card; a plain player and a non-member get a 404.
 *   2. The /admin/settings billing card for OWNER and ADMIN.
 *   3. The banner in grace, past due and paused; none in trial.
 *   4. Sutton FC's shape (the seeded exempt club) sees nothing new; its
 *      owner sees only an "exempt" line on the billing page.
 *   5. With BILLING_ENABLED off (the test-mode cookie), nothing at all.
 *   6. /admin/clubs: the billing row, AI spend, Plan (Custom, Free,
 *      Standard) and Start free month, for the platform owner only.
 *
 * Nothing here calls Stripe and nothing messages anyone. The card buttons
 * Stripe side (fake adapter, signed webhooks) is e2e/web/billing-stripe.spec.ts.
 */
import type { BrowserContext } from "@playwright/test";
import { test, expect, resetDb, signInAs, U } from "../fixtures";
import { E2E_BASE_URL } from "../helpers/env";
import { ORG_ID } from "../helpers/constants";
import { testDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const P = "e2e-bill";
const ORG = `${P}-club`;
const LATE = `${P}-late`;
const USER = {
  owner: `${P}-owner`,
  admin: `${P}-admin`,
  colin: `${P}-colin`,
  pat: `${P}-pat`,
  elvin: `${P}-elvin`,
  outsider: `${P}-outsider`,
} as const;
const DASH = /[—–]/;

async function billingFlag(context: BrowserContext, on: boolean) {
  await context.addCookies([{ name: "mt-test-billing", value: on ? "1" : "0", url: E2E_BASE_URL }]);
}

async function setState(sql: string, params: unknown[] = []) {
  await testDb().run(sql, params);
}

/** Back to the starting world: a free month, no card, Colin collects. */
async function resetClub() {
  await setState(
    `UPDATE "Organisation" SET "billingStatus"='trial', "billingPlan"='standard', "billingPricePence"=NULL, "paymentHolderId"=$2 WHERE id=$1`,
    [ORG, USER.colin],
  );
  await setState(
    `UPDATE "ClubBilling" SET "graceEndsAt"=NULL, "currentPeriodEnd"=NULL, "cardHolderUserId"=NULL, "cardBrand"=NULL, "cardLast4"=NULL WHERE "orgId"=$1`,
    [ORG],
  );
}

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  for (const [id, name, status, hasBilling] of [
    [ORG, "Billing Sevens", "trial", true],
    [LATE, "Late Starters", "exempt", false],
  ] as const) {
    await db.run(
      `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus",language,"approvedAt","approvalDecidedAt","billingStatus","createdAt","updatedAt")
       VALUES ($1,$2,$1,$3,'approved','en',now() - interval '5 days',now() - interval '5 days',$4,now(),now())`,
      [id, name, `${id}-invite`, status],
    );
    if (hasBilling) {
      await db.run(
        `INSERT INTO "ClubBilling" ("orgId","trialStartedAt","trialEndsAt","updatedAt") VALUES ($1,'2030-01-01T12:00:00Z','2030-01-31T12:00:00Z',now())`,
        [id],
      );
    }
  }
  const people: Array<[string, string, string]> = [
    [USER.owner, "Olly Owner", "+447700901001"],
    [USER.admin, "Ada Admin", "+447700901002"],
    [USER.colin, "Colin Sevens", "+447700901003"],
    [USER.pat, "Pat Sevens", "+447700901004"],
    [USER.elvin, "Elvin Sevens", "+447700901005"],
    [USER.outsider, "Otto Outsider", "+447700901006"],
  ];
  for (const [id, name, phone] of people) {
    await db.run(
      `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt") VALUES ($1,$2,$3,$4,true,true,now())`,
      [id, name, `${id}@e2e-test.invalid`, phone],
    );
  }
  const roles: Array<[string, string]> = [
    [USER.owner, "OWNER"],
    [USER.admin, "ADMIN"],
    [USER.colin, "PLAYER"],
    [USER.pat, "PLAYER"],
    [USER.elvin, "PLAYER"],
  ];
  for (const [userId, role] of roles) {
    await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role) VALUES ($1,$2,$3,$4)`, [`${userId}-m`, userId, ORG, role]);
  }
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role) VALUES ($1,$2,$3,'OWNER')`, [`${P}-late-m`, USER.outsider, LATE]);
  // A weekly 7-a-side at GBP 7: the tip is 20p and GBP 7.20 (plan 7.2, 10.2).
  await db.run(
    `INSERT INTO "Sport" (id,"orgId",name,preset,"playersPerTeam",positions,"teamLabels","updatedAt")
     VALUES ($1,$2,'Football 7-a-side','football-7aside',7,'{GK,DEF,MID,FWD}','{Red,Yellow}',now())`,
    [`${P}-sport`, ORG],
  );
  await db.run(
    `INSERT INTO "Activity" (id,"orgId","sportId",name,"dayOfWeek",time,venue,"feePerPlayer","updatedAt")
     VALUES ($1,$2,$3,'Tuesday 7s',2,'20:00','Sevens Arena',7,now())`,
    [`${P}-activity`, ORG, `${P}-sport`],
  );
  await db.run(`UPDATE "Organisation" SET "paymentHolderId"=$2 WHERE id=$1`, [ORG, USER.colin]);
  // Two London days of AI spend inside the last 30.
  await db.run(
    `INSERT INTO "OrgAiUsage" ("orgId",day,"costUsd") VALUES ($1,current_date,0.75),($1,current_date - 3,0.50)`,
    [ORG],
  );
});

test.beforeEach(async () => {
  await resetClub();
});

test.afterAll(() => {
  resetDb();
});

test.describe("/billing/[orgId] per role", () => {
  test("the money collector, a PLAYER, is the contact: state, tip, Add a card; /admin still redirects", async ({ page }) => {
    await signInAs(page, USER.colin, `/billing/${ORG}`);
    await page.waitForURL(`**/billing/${ORG}`);
    const billing = page.getByTestId("billing-page");
    await expect(billing).toHaveAttribute("data-role", "contact", { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Club fee" })).toBeVisible();
    await expect(page.getByTestId("billing-state")).toHaveText(
      "Free month until Thu 31 Jan. Then £9.99 a month for the whole group.",
    );
    const add = page.getByTestId("billing-btn-add-card");
    await expect(add).toBeVisible();
    await expect(add).toBeEnabled();
    await expect(page.getByText("Card payments open here soon.")).toHaveCount(0);
    const tip = page.getByTestId("billing-tip");
    await expect(tip).toContainText("your weekly 7-a-side is 14 players and about 4 games a month");
    await expect(tip).toContainText("20p a player per game");
    await expect(tip).toContainText("Your game is £7 each, so charging £7.20 covers it.");
    expect(await billing.innerText()).not.toMatch(DASH);

    // The same signed-in player cannot reach the admin pages.
    await page.goto("/admin/settings");
    await page.waitForURL((u) => !u.pathname.startsWith("/admin"), { timeout: 30_000 });
    expect(new URL(page.url()).pathname).not.toMatch(/^\/admin/);
  });

  test("the owner reads only when a collector is set: who pays, no buttons", async ({ page }) => {
    await signInAs(page, USER.owner, `/billing/${ORG}`);
    await expect(page.getByTestId("billing-page")).toHaveAttribute("data-role", "viewer", { timeout: 30_000 });
    await expect(page.getByTestId("billing-who")).toHaveText("Colin Sevens looks after the card.");
    await expect(page.locator("[data-testid^=billing-btn-]")).toHaveCount(0);
    await expect(page.getByTestId("billing-tip")).toContainText("20p a player per game");
  });

  test("no collector: the owner is the contact", async ({ page }) => {
    await setState(`UPDATE "Organisation" SET "paymentHolderId"=NULL WHERE id=$1`, [ORG]);
    await signInAs(page, USER.owner, `/billing/${ORG}`);
    await expect(page.getByTestId("billing-page")).toHaveAttribute("data-role", "contact", { timeout: 30_000 });
    await expect(page.getByTestId("billing-btn-add-card")).toBeEnabled();
  });

  test("an admin reads only", async ({ page }) => {
    await signInAs(page, USER.admin, `/billing/${ORG}`);
    await expect(page.getByTestId("billing-page")).toHaveAttribute("data-role", "viewer", { timeout: 30_000 });
    await expect(page.locator("[data-testid^=billing-btn-]")).toHaveCount(0);
  });

  test("an old card holder: their note and Remove my card; the new collector: Use my card instead", async ({ page, context }) => {
    await setState(
      `UPDATE "Organisation" SET "billingStatus"='subscribed' WHERE id=$1`,
      [ORG],
    );
    await setState(
      `UPDATE "ClubBilling" SET "cardHolderUserId"=$2,"cardBrand"='Visa',"cardLast4"='4242',"currentPeriodEnd"='2030-03-01T12:00:00Z' WHERE "orgId"=$1`,
      [ORG, USER.elvin],
    );
    await signInAs(page, USER.elvin, `/billing/${ORG}`);
    await expect(page.getByTestId("billing-page")).toHaveAttribute("data-role", "card-holder", { timeout: 30_000 });
    await expect(page.getByTestId("billing-holder-note")).toHaveText(
      "Your card still pays Billing Sevens's MatchTime fee until Colin Sevens adds theirs.",
    );
    await expect(page.getByTestId("billing-btn-remove-mine")).toBeEnabled();
    await expect(page.getByTestId("billing-tip")).toHaveCount(0);

    await context.clearCookies();
    await signInAs(page, USER.colin, `/billing/${ORG}`);
    await expect(page.getByTestId("billing-page")).toHaveAttribute("data-role", "contact", { timeout: 30_000 });
    await expect(page.getByTestId("billing-state")).toHaveText(
      "£9.99 a month, paid with Elvin Sevens's card until you put yours on. Next payment Fri 1 Mar.",
    );
    await expect(page.getByTestId("billing-btn-use-mine")).toBeEnabled();
    // The card's last four are only ever shown to its holder.
    await expect(page.getByTestId("billing-page")).not.toContainText("4242");
  });

  test("a plain player and a non-member get a 404", async ({ page, context }) => {
    for (const who of [USER.pat, USER.outsider]) {
      await context.clearCookies();
      await signInAs(page, who, "/");
      const res = await page.goto(`/billing/${ORG}`);
      expect(res?.status()).toBe(404);
      await expect(page.getByTestId("billing-page")).toHaveCount(0);
    }
  });

  test("an unknown club is a 404", async ({ page }) => {
    await signInAs(page, USER.owner, "/");
    const res = await page.goto(`/billing/${P}-nope`);
    expect(res?.status()).toBe(404);
  });
});

test.describe("/admin/settings billing card and the banner", () => {
  test("OWNER and ADMIN see the card: state, who pays, card on file, the tip, Open billing", async ({ page }) => {
    await signInAs(page, USER.admin, "/admin/settings");
    await page.waitForURL("**/admin/settings");
    const card = page.getByTestId("settings-billing-card");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText("Free month until Thu 31 Jan. Then £9.99 a month for the whole group.");
    await expect(card).toContainText("Colin Sevens looks after the card.");
    await expect(card).toContainText("Card on file: no.");
    await expect(card).toContainText("20p a player per game");
    await expect(card.getByRole("link", { name: "Open billing" })).toHaveAttribute("href", `/billing/${ORG}`);
    await expect(card.getByText("Choose a money collector")).toHaveCount(0);
    expect(await card.innerText()).not.toMatch(DASH);
    // No banner during the free month.
    await expect(page.getByTestId("billing-banner")).toHaveCount(0);
  });

  test("no collector: the owner fallback line", async ({ page }) => {
    await setState(`UPDATE "Organisation" SET "paymentHolderId"=NULL WHERE id=$1`, [ORG]);
    await signInAs(page, USER.owner, "/admin/settings");
    const card = page.getByTestId("settings-billing-card");
    await expect(card).toContainText("No money collector set: the owner is asked for the card.", { timeout: 30_000 });
  });

  test("the banner in grace, past due and paused, linking to the card", async ({ page }) => {
    await setState(`UPDATE "ClubBilling" SET "graceEndsAt"='2030-02-07T12:00:00Z' WHERE "orgId"=$1`, [ORG]);
    for (const [status, text] of [
      ["grace", "The free month has ended. Add a card before Thu 7 Feb to keep MatchTime running."],
      ["past_due", "This month's club fee didn't go through. MatchTime stops on Thu 7 Feb if it can't be taken."],
      ["paused", "MatchTime is paused for this club. Add a card to switch it back on."],
    ] as const) {
      await setState(`UPDATE "Organisation" SET "billingStatus"=$2 WHERE id=$1`, [ORG, status]);
      await signInAs(page, USER.owner, "/admin");
      const banner = page.getByTestId("billing-banner");
      await expect(banner).toContainText(text, { timeout: 30_000 });
      await expect(banner.getByRole("link", { name: "See billing" })).toHaveAttribute("href", "/admin/settings#billing");
    }
  });

  test("BILLING_ENABLED off: no card, no banner, and the billing page is a 404 even for the contact", async ({ page, context }) => {
    await setState(`UPDATE "Organisation" SET "billingStatus"='paused' WHERE id=$1`, [ORG]);
    await billingFlag(context, false);
    await signInAs(page, USER.owner, "/admin/settings");
    await expect(page.getByRole("heading", { name: "Bot language" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("settings-billing-card")).toHaveCount(0);
    await expect(page.getByTestId("billing-banner")).toHaveCount(0);

    await context.clearCookies();
    await billingFlag(context, false);
    await signInAs(page, USER.colin, "/");
    const res = await page.goto(`/billing/${ORG}`);
    expect(res?.status()).toBe(404);
  });
});

test.describe("an exempt club (Sutton FC's shape) sees nothing new", () => {
  test("no settings card, no banner; the owner's billing page is one exempt line; the collector gets a 404", async ({ page, context }) => {
    await signInAs(page, U.admin, "/admin/settings");
    await expect(page.getByRole("heading", { name: "Bot language" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("settings-billing-card")).toHaveCount(0);
    await expect(page.getByTestId("billing-banner")).toHaveCount(0);

    await page.goto(`/billing/${ORG_ID}`);
    await expect(page.getByTestId("billing-page")).toHaveAttribute("data-role", "exempt-owner", { timeout: 30_000 });
    await expect(page.getByTestId("billing-exempt")).toHaveText("E2E Test FC has no club fee. MatchTime is free for this club.");
    await expect(page.locator("[data-testid^=billing-btn-]")).toHaveCount(0);
    await expect(page.getByTestId("billing-tip")).toHaveCount(0);

    await context.clearCookies();
    await signInAs(page, U.collector, "/");
    const res = await page.goto(`/billing/${ORG_ID}`);
    expect(res?.status()).toBe(404);
  });
});

test.describe("/admin/clubs: the platform owner's billing controls", () => {
  test.beforeEach(async () => {
    await setState(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [USER.owner]);
  });
  test.afterEach(async () => {
    await setState(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [USER.owner]);
  });

  test("a club admin who is not the platform owner gets a 404", async ({ page }) => {
    await signInAs(page, USER.admin, "/");
    const res = await page.goto("/admin/clubs");
    expect(res?.status()).toBe(404);
  });

  test("the billing row: plan, state, card on file, who pays, AI over 30 days; totals", async ({ page }) => {
    await signInAs(page, USER.owner, "/admin/clubs");
    const row = page.getByTestId("live-club").filter({ hasText: "Billing Sevens" });
    await expect(row.getByTestId("club-billing-summary")).toContainText(
      "Standard £9.99. Free month. Free month ends Thu 31 Jan, 12:00. Card on file: no.",
      { timeout: 30_000 },
    );
    await expect(row).toContainText("Colin Sevens (money collector)");
    await expect(row.getByTestId("club-ai-30d")).toHaveText("$1.25");
    const late = page.getByTestId("live-club").filter({ hasText: "Late Starters" });
    await expect(late.getByTestId("club-billing-summary")).toContainText("Standard £9.99. Exempt (never billed).");
    await expect(page.getByTestId("billing-totals")).toContainText("0 paying, £0 a month at current prices.");
    await expect(page.getByTestId("billing-totals")).toContainText("1 in their free month");
    expect(await page.getByTestId("clubs-page").innerText()).not.toMatch(DASH);
  });

  test("Plan: Custom GBP 5, then Free (exempt first, in one go), then Standard", async ({ page, db }) => {
    await signInAs(page, USER.owner, "/admin/clubs");
    const row = page.getByTestId("live-club").filter({ hasText: "Billing Sevens" });
    await row.getByLabel("Plan", { exact: true }).selectOption("custom");
    await row.getByLabel("Custom price in pounds").fill("5");
    await row.getByRole("button", { name: "Save plan" }).click();
    await expect(page.getByText("Plan saved: Custom, up to £5 a month.")).toBeVisible({ timeout: 30_000 });
    expect(await db.one(`SELECT "billingPlan","billingPricePence","billingStatus" FROM "Organisation" WHERE id=$1`, [ORG])).toEqual({
      billingPlan: "custom",
      billingPricePence: 500,
      billingStatus: "trial",
    });

    // Out of range: refused, nothing written.
    await row.getByLabel("Custom price in pounds").fill("12");
    await row.getByRole("button", { name: "Save plan" }).click();
    await expect(page.getByText("A custom price must be between £1.00 and £9.99.")).toBeVisible({ timeout: 30_000 });
    expect((await db.one<{ p: number }>(`SELECT "billingPricePence" AS p FROM "Organisation" WHERE id=$1`, [ORG]))?.p).toBe(500);

    page.once("dialog", (d) => d.accept());
    await row.getByLabel("Plan", { exact: true }).selectOption("free");
    await row.getByRole("button", { name: "Save plan" }).click();
    await expect(page.getByText("Plan saved: Free. The club is not billed.")).toBeVisible({ timeout: 30_000 });
    expect(await db.one(`SELECT "billingPlan","billingPricePence","billingStatus" FROM "Organisation" WHERE id=$1`, [ORG])).toEqual({
      billingPlan: "free",
      billingPricePence: null,
      billingStatus: "exempt",
    });

    await row.getByLabel("Plan", { exact: true }).selectOption("standard");
    await row.getByRole("button", { name: "Save plan" }).click();
    // Slice B3: leaving Free while the club's one free month is still
    // running puts it back in that month (its end kept); no second free
    // month is ever started.
    await expect(page.getByText("Plan saved: Standard, up to £9.99 a month. The club is back in its free month.")).toBeVisible({ timeout: 30_000 });
    expect(await db.one(`SELECT "billingPlan","billingStatus" FROM "Organisation" WHERE id=$1`, [ORG])).toEqual({
      billingPlan: "standard",
      billingStatus: "trial",
    });
    expect(await db.one(`SELECT "trialEndsAt" FROM "ClubBilling" WHERE "orgId"=$1`, [ORG])).toEqual({
      trialEndsAt: new Date("2030-01-31T12:00:00Z"),
    });
    // It had its free month, so there is no "Start free month" for it.
    await expect(row.getByRole("button", { name: "Start free month" })).toHaveCount(0);
  });

  test("Start free month, for a self-join club approved before billing", async ({ page, db }) => {
    const jobsBefore = await db.count(`SELECT COUNT(*) FROM "PlatformJob"`);
    await signInAs(page, USER.owner, "/admin/clubs");
    const late = page.getByTestId("live-club").filter({ hasText: "Late Starters" });
    page.once("dialog", (d) => d.accept());
    await late.getByRole("button", { name: "Start free month" }).click();
    await expect(page.getByText(/^Free month started\. It ends on /)).toBeVisible({ timeout: 30_000 });
    expect(await db.one(`SELECT "billingStatus" FROM "Organisation" WHERE id=$1`, [LATE])).toEqual({ billingStatus: "trial" });
    expect(
      await db.count(`SELECT COUNT(*) FROM "ClubBilling" WHERE "orgId"=$1 AND "trialEndsAt" = "trialStartedAt" + interval '30 days'`, [LATE]),
    ).toBe(1);
    await expect(late.getByRole("button", { name: "Start free month" })).toHaveCount(0);
    // Nobody was messaged.
    expect(await db.count(`SELECT COUNT(*) FROM "PlatformJob"`)).toBe(jobsBefore);
    expect(await db.count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" IN ($1,$2)`, [ORG, LATE])).toBe(0);
  });
});
