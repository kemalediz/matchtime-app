/**
 * A submit button stays busy until the page actually changes.
 *
 * Reported live by the owner during a real sign-up: on /create-org,
 * after "Create club", the button went back to enabled with its normal
 * label while /admin (a slow page) was still loading. A second press
 * called the action again and the organiser read "You already have a
 * club".
 *
 * The test holds two requests open so each phase can be looked at:
 *   1. the server action POST, to see the busy state during the action;
 *   2. the navigation to /admin, to see it for as long as that is
 *      pending, and to try a second submit meanwhile.
 *
 * Deterministic: no model is involved anywhere in this flow.
 */
import type { BrowserContext, Request } from "@playwright/test";
import { test, expect, resetDb, signInAs } from "../fixtures";
import { E2E_BASE_URL } from "../helpers/env";
import { testDb } from "../helpers/test-db";

const USER_ID = "e2e-busy-organiser";
const CLUB = "Busy Button FC";

async function flag(context: BrowserContext, on: boolean) {
  await context.addCookies([{ name: "mt-test-self-join", value: on ? "1" : "0", url: E2E_BASE_URL }]);
}

/** A manually released gate for a held request. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

const isAction = (r: Request) => r.method() === "POST" && r.headers()["next-action"] !== undefined;

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  // A user with a phone verified by a used WhatsApp code, and no club.
  await db.run(
    `INSERT INTO "User" (id, name, email, "phoneNumber", onboarded, "isActive", "updatedAt")
     VALUES ($1,'Busy Organiser',$2,'+447700900971',true,true,now())`,
    [USER_ID, `${USER_ID}@e2e.local`],
  );
  await db.run(
    `INSERT INTO "PhoneOtp" (id, phone, code, "expiresAt", "usedAt", attempts, "createdAt")
     VALUES ($1,'447700900971','123456',now(),now(),0,now())`,
    [`${USER_ID}-otp`],
  );
});

test("create club: the button stays busy until /admin has loaded, and a second submit is ignored", async ({
  page,
  context,
}) => {
  const db = testDb();
  await flag(context, true);
  await signInAs(page, USER_ID, "/create-org");
  await expect(page.getByRole("heading", { name: "Set up your club" })).toBeVisible();

  await page.getByLabel("Club name").fill(CLUB);
  await page.getByLabel("Kick-off time").fill("20:00");
  await page.getByLabel("Venue", { exact: true }).fill("Goals Wembley");

  const actionGate = gate();
  const adminGate = gate();
  // Every call of the create-club action, whichever URL it is posted to:
  // Next queues an action dispatched during a navigation and sends it
  // once the navigation is over, from the new page.
  const actionIds: string[] = [];
  page.on("request", (r) => {
    if (isAction(r)) actionIds.push(r.headers()["next-action"]);
  });
  const createCalls = () => actionIds.filter((id) => id === actionIds[0]).length;
  let adminRequests = 0;
  await page.route(
    (url) => url.pathname === "/create-org",
    async (route) => {
      if (!isAction(route.request())) return route.continue();
      await actionGate.opened;
      await route.continue();
    },
  );
  await page.route(
    (url) => url.pathname === "/admin",
    async (route) => {
      adminRequests++;
      await adminGate.opened;
      await route.continue();
    },
  );

  const form = page.locator("form");
  const button = form.locator('button[type="submit"]');
  await expect(button).toHaveText("Create club");
  await button.click();

  // ── 1. While the action is running ──
  await expect.poll(createCalls).toBe(1);
  await expect.soft(button, "busy during the action").toBeDisabled();
  await expect.soft(button, "busy label during the action").toHaveText("Creating...");

  // ── 2. The action has answered; the navigation to /admin is pending ──
  actionGate.open();
  await expect.poll(() => adminRequests, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(500); // let any re-render after the action settle
  expect(new URL(page.url()).pathname).toBe("/create-org");
  await expect.soft(button, "busy while the navigation is pending").toBeDisabled();
  await expect.soft(button, "busy label while the navigation is pending").toHaveText("Creating...");

  // ── 3. A second press, and a submit that does not go through the button ──
  await button.click({ force: true });
  await form.evaluate((f: HTMLFormElement) => f.requestSubmit());
  await page.waitForTimeout(1_000);
  expect.soft(createCalls(), "action calls while the navigation is pending").toBe(1);
  await expect.soft(button, "busy label after the second press").toHaveText("Creating...");

  // ── 4. Let the page through ──
  adminGate.open();
  await page.waitForURL("**/admin", { timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1_000); // a queued second call would be sent now
  expect.soft(createCalls(), "action calls once /admin has loaded").toBe(1);
  const clubs = await db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM "Organisation" WHERE name = $1`, [CLUB]);
  expect(clubs?.n).toBe(1);
});
