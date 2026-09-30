/**
 * An admin link opens the club it names (2026-09-30).
 *
 * Kemal is in Sutton FC and in MT Test. The admin pages read the active
 * club from a cookie and otherwise fall back to the OLDEST membership, so
 * MT Test's setup link opened Sutton FC's admin page. A link minted with
 * `orgId` (every admin DM now, via `buildAdminLink`) pins that club at
 * sign-in. Proven here through the real /r/<token> flow and the real
 * admin layout, which prints the club's name.
 */
import { test, expect, resetDb, U } from "../fixtures";
import { ORG_ID } from "../helpers/constants";
import { signMagicLinkToken } from "@/lib/magic-link";
import { testDb } from "../helpers/test-db";

const OLDER = "e2e-older-club";

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","createdAt","updatedAt")
     VALUES ($1,'Older Club',$1,'e2e-older-invite','2020-01-01',now())`,
    [OLDER],
  );
  // Alex Admin runs the older club too, and joined it first.
  await db.run(
    `INSERT INTO "Membership" (id,"userId","orgId",role,"createdAt") VALUES ($1,$2,$3,'OWNER','2020-01-01')`,
    [`e2e-mem-older-admin`, U.admin, OLDER],
  );
});

const token = (orgId?: string) =>
  signMagicLinkToken({ userId: U.admin, purpose: "sign-in", nextPath: "/admin", ...(orgId ? { orgId } : {}), ttlSeconds: 3600 });

test("without a club in the link, the admin page falls back to the oldest club", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`/r/${token()}`);
  await page.waitForURL((u) => u.pathname === "/admin", { timeout: 30_000 });
  await expect(page.getByText("Older Club").first()).toBeVisible();
  await ctx.close();
});

test("a link naming the club opens THAT club's admin page", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`/r/${token(ORG_ID)}`);
  await page.waitForURL((u) => u.pathname === "/admin", { timeout: 30_000 });
  await expect(page.getByText("E2E Test FC").first()).toBeVisible();
  await ctx.close();
});

test("a link naming a club the user is NOT in changes nothing", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`/r/${signMagicLinkToken({ userId: U.player, purpose: "sign-in", nextPath: "/", orgId: OLDER, ttlSeconds: 3600 })}`);
  await page.waitForURL((u) => !u.pathname.startsWith("/r/"), { timeout: 30_000 });
  const cookies = await ctx.cookies();
  expect(cookies.find((c) => c.name === "orgId")?.value).not.toBe(OLDER);
  await ctx.close();
});
