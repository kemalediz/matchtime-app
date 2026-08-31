/**
 * Admin → Unresolved: attendance writes that FAILED.
 *
 * The failure is now honest in the chat (the player is told nothing
 * landed), but an operator still has to be able to find it. A failed
 * write is stored as handledBy "error" with an "attendance-failed:…"
 * action, and that has to reach a human surface, not just the logs.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ORG_ID } from "../helpers/constants";
import { E2E } from "../helpers/env";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

test("a failed attendance write shows up in the admin queue", async ({ page, db }) => {
  await db.run(
    `INSERT INTO "AnalyzedMessage"
       (id, "waMessageId", "orgId", "groupId", "authorUserId", "authorName", body,
        "handledBy", intent, action, confidence, reasoning, "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'error', 'in', $8, 0.95, 'db fault', now())`,
    [
      "e2e-am-failed-1",
      "e2e-wa-failed-1",
      ORG_ID,
      E2E.GROUP_ID,
      U.fresh,
      "Ian Innes",
      "im in for tuesday",
      "attendance-failed:IN",
    ],
  );

  await signInAs(page, U.admin, "/admin/unresolved");
  await page.waitForURL("**/admin/unresolved");

  await expect(page.getByText(/didn't save/i)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Ian Innes tried to join")).toBeVisible();
  await expect(page.getByText("im in for tuesday")).toBeVisible();
});

test("the subnav badge counts it too", async ({ page, request }) => {
  await signInAs(page, U.admin, "/admin/unresolved");
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const res = await request.get("/api/admin/unresolved-count", {
    headers: { cookie: cookieHeader },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.count).toBeGreaterThanOrEqual(1);
});
