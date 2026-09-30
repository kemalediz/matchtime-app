/**
 * Help, in the group and by DM, END TO END (2026-09-30). No model: every
 * reply here is deterministic, and no pipeline stub is set.
 *
 * Kemal, after the first real self-setup ("MT Test"): payments are off by
 * default, "@Match Time help payments" declined, and DMing "help payments"
 * got nothing. Now:
 *   - the group's help for an OFF topic explains it and how to switch it
 *     on (public URL, never a sign-in link, in a group);
 *   - a DM "help payments" from an ADMIN gets the same explanation with a
 *     link that signs them straight in, pinned to their club;
 *   - a DM from a PLAYER gets the player-facing text, no link.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { U, ORG_ID, PHONE, NAME } from "../helpers/constants";
import { E2E, E2E_BASE_URL } from "../helpers/env";
import type { APIRequestContext } from "@playwright/test";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

let n = 0;
const msgId = () => `e2e-help-${Date.now()}-${++n}`;

async function postDm(request: APIRequestContext, phone: string, body: string) {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { phone, body, waMessageId: msgId(), authorName: null },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const lastDmTo = (db: TestDb, phone: string) =>
  db.one<{ text: string; orgId: string }>(
    `SELECT text, "orgId" FROM "BotJob" WHERE kind = 'dm' AND phone = $1 ORDER BY "createdAt" DESC LIMIT 1`,
    [phone.replace(/^\+/, "")],
  );

async function paymentsOff(db: TestDb) {
  await db.run(
    `UPDATE "Organisation" SET "paymentTrackingEnabled" = false, "paymentCollectionEnabled" = false WHERE id = $1`,
    [ORG_ID],
  );
}

/** The signed payload behind a short link in a DM. */
async function payloadOf(db: TestDb, url: string): Promise<Record<string, unknown>> {
  const code = url.split("/r/")[1];
  const row = await db.one<{ token: string }>(`SELECT token FROM "ShortLink" WHERE code = $1`, [code]);
  const body = (row?.token ?? code).split(".")[0];
  return JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
}

test("group: '@Match Time help payments' with payments OFF explains it and how to switch it on", async ({
  request,
  db,
}) => {
  await paymentsOff(db);
  const id = msgId();
  const res = await postAnalyze(request, [
    { waMessageId: id, body: "@Match Time help payments", authorPhone: PHONE.player, authorName: NAME.player, botMentioned: true },
  ]);
  const r = (res.results as Array<{ waMessageId: string; reply?: string; handledBy?: string }>).find(
    (x) => x.waMessageId === id,
  )!;
  expect(r.handledBy).toBe("fast-path");
  expect(r.reply).toMatch(/isn't switched on for this group yet/);
  expect(r.reply).toMatch(/link to pay their share, by card or bank/);
  expect(r.reply).toContain(`${E2E_BASE_URL}/admin/settings`);
  expect(r.reply).toMatch(/\*Collect match fees\*/);
  expect(r.reply).toMatch(/DM me \*help payments\*/);
  expect(r.reply).not.toContain("/r/");
  expect(r.reply).not.toMatch(/[—–]/);
});

test("DM 'help payments' from the ADMIN: the steps with a signed-in link to Settings, in this club", async ({
  request,
  db,
}) => {
  await paymentsOff(db);
  const json = await postDm(request, PHONE.admin, "help payments");
  expect(json).toMatchObject({ handled: "dm-help", topic: "payments", audience: "admin", orgId: ORG_ID });
  const dm = await lastDmTo(db, PHONE.admin);
  expect(dm?.orgId).toBe(ORG_ID);
  expect(dm?.text).toMatch(/link to pay their share/);
  expect(dm?.text).toMatch(/open \*Settings\* on your admin page/);
  const link = dm!.text.match(/https?:\/\/\S+\/r\/\S+/)?.[0];
  expect(link, dm?.text).toBeTruthy();
  const p = await payloadOf(db, link!);
  expect(p).toMatchObject({ userId: U.admin, purpose: "sign-in", nextPath: "/admin/settings", orgId: ORG_ID });
});

test("DM 'help payments' from a PLAYER: the player text, no link", async ({ request, db }) => {
  await paymentsOff(db);
  const json = await postDm(request, PHONE.rater, "help payments");
  expect(json).toMatchObject({ handled: "dm-help", audience: "player" });
  const dm = await lastDmTo(db, PHONE.rater);
  expect(dm?.text).toMatch(/Your organiser switches this on/);
  expect(dm?.text).not.toMatch(/https?:\/\//);
});

test("DM 'yardım ödeme' in a Turkish club answers in Turkish", async ({ request, db }) => {
  await paymentsOff(db);
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  try {
    const json = await postDm(request, PHONE.rater, "yardım ödeme");
    expect(json).toMatchObject({ handled: "dm-help", topic: "payments" });
    expect((await lastDmTo(db, PHONE.rater))?.text).toContain("Maç ücretleri nasıl çalışır");
  } finally {
    await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
  }
});

test("DM 'help schedule' from the ADMIN: four signed-in links; from a player, one line", async ({ request, db }) => {
  await postDm(request, PHONE.admin, "help schedule");
  const admin = (await lastDmTo(db, PHONE.admin))!.text;
  expect(admin).toMatch(/\*New block booking\*/);
  expect(admin.match(/\/r\/\S+/g)?.length).toBe(4);
  await postDm(request, PHONE.rater, "help schedule");
  const player = (await lastDmTo(db, PHONE.rater))!.text;
  expect(player).toMatch(/organiser/);
  expect(player).not.toMatch(/https?:\/\//);
});
