/**
 * Someone added to the group (2026-09-30, "MT Test").
 *
 * The organiser got "Please set their name:\n/admin/players/phones", a
 * bare path WhatsApp does not make tappable, even when the bot could have
 * known the name. Now:
 *   - the DM carries the admin's own signed-in link, in this club;
 *   - a name the Pi forwards (`names`) names the player and the DM;
 *   - with no name, the placeholder takes the WhatsApp name of its first
 *     post in the group.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { ORG_ID, PHONE, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const ALI = "447546111893";
const BO = "447546111894";

async function groupJoin(request: APIRequestContext, phones: string[], names?: Record<string, string>) {
  const res = await request.post("/api/whatsapp/group-join", {
    headers: KEY,
    data: { groupId: E2E.GROUP_ID, phones, ...(names ? { names } : {}) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const lastAdminDm = async (db: TestDb) =>
  (
    await db.one<{ text: string }>(
      `SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2 ORDER BY "createdAt" DESC LIMIT 1`,
      [ORG_ID, PHONE.admin.replace(/^\+/, "")],
    )
  )?.text ?? "";

const nameOf = async (db: TestDb, phone: string) =>
  (await db.one<{ name: string | null }>(`SELECT name FROM "User" WHERE "phoneNumber" = $1`, [`+${phone}`]))?.name;

async function payloadOf(db: TestDb, text: string) {
  const code = text.match(/\/r\/([A-Za-z0-9_-]+)/)?.[1];
  const row = await db.one<{ token: string }>(`SELECT token FROM "ShortLink" WHERE code = $1`, [code]);
  return JSON.parse(Buffer.from(row!.token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
}

test("a joiner the Pi could name: the player is named, the DM says so, with a signed-in link", async ({ request, db }) => {
  await groupJoin(request, [ALI], { [ALI]: "Ali Veli" });
  expect(await nameOf(db, ALI)).toBe("Ali Veli");
  const dm = await lastAdminDm(db);
  expect(dm).toContain("🆕 *Ali Veli* joined *E2E Test FC* on WhatsApp");
  expect(dm).toContain("Tap to check their details");
  expect(dm).not.toMatch(/(^|\s)\/admin/);
  const p = await payloadOf(db, dm);
  expect(p).toMatchObject({ userId: U.admin, nextPath: "/admin/players", orgId: ORG_ID });
});

test("a joiner with no name: a signed-in link to set it, then their first post names them", async ({ request, db }) => {
  await groupJoin(request, [BO]);
  expect(await nameOf(db, BO)).toBeNull();
  const dm = await lastAdminDm(db);
  expect(dm).toMatch(/fill in their WhatsApp name when they first post/);
  expect(dm).not.toMatch(/(^|\s)\/admin/);
  expect((await payloadOf(db, dm)).nextPath).toBe("/admin/players/phones");

  // Their first post carries their WhatsApp name.
  await postAnalyze(request, [
    { waMessageId: `e2e-gjn-${Date.now()}`, body: "hi all 👋", authorPhone: BO, authorName: "Bo Brave" },
  ]);
  expect(await nameOf(db, BO)).toBe("Bo Brave");
});
