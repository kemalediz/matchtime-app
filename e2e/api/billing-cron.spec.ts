/**
 * CLUB FEE BILLING, slice B4: /api/cron/billing against a real Postgres
 * and the real route, with the clock pinned by `x-test-now`.
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 4.1, 6 and 7.
 *
 * Day 21, 28, 30 and 37 each queue exactly ONE platform DM (purpose
 * "billing") to the billing contact, in the club's language, and the free
 * month and grace week end on time. Two cron runs at the same moment (the
 * row lock and the BillingNotice claim) still make one transition and one
 * DM. A suspended club is never touched. The e2e server runs with
 * BILLING_ENABLED=1 (e2e/helpers/env.ts).
 *
 * Deterministic: no model, no Stripe call (no refund intents are open).
 */
import { test, expect, resetDb } from "../fixtures";
import { E2E } from "../helpers/env";
import { testDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const CRON = { authorization: `Bearer ${E2E.CRON_SECRET}` };
const APPROVED = "2026-10-01T09:00:00Z"; // Thu 1 Oct, 10:00 London

// English club: a player is the money collector.
const EN_ORG = "e2e-billing-cron-en";
const EN_OWNER = { id: "e2e-bc-owner", name: "Owen Owner", phone: "+447700900971" };
const EN_COLLECTOR = { id: "e2e-bc-collector", name: "Cole Collector", phone: "+447700900972" };
// Turkish club: no collector, so the owner is asked.
const TR_ORG = "e2e-billing-cron-tr";
const TR_OWNER = { id: "e2e-bc-tr-owner", name: "Erdal", phone: "+447700900973" };
// Suspended club: never touched.
const SUSP_ORG = "e2e-billing-cron-susp";
const SUSP_OWNER = { id: "e2e-bc-susp-owner", name: "Sam Suspended", phone: "+447700900974" };

async function cron(request: APIRequestContext, at: string) {
  const res = await request.get("/api/cron/billing", { headers: { ...CRON, "x-test-now": at } });
  expect(res.status(), await res.text()).toBe(200);
  return res.json() as Promise<{ enabled: boolean; daytime: boolean; clubs: Array<{ orgId: string; transition?: string; error?: string }> }>;
}

const digits = (p: string) => p.replace(/^\+/, "");
async function billingDms(phone: string) {
  return testDb().all<{ text: string; refId: string; sendAfter: Date | null }>(
    `SELECT text, "refId", "sendAfter" FROM "PlatformJob" WHERE purpose = 'billing' AND phone = $1 ORDER BY "createdAt"`,
    [digits(phone)],
  );
}
async function status(orgId: string) {
  return (await testDb().one<{ s: string }>(`SELECT "billingStatus" AS s FROM "Organisation" WHERE id = $1`, [orgId]))!.s;
}

async function seedUser(u: { id: string; name: string; phone: string }) {
  await testDb().run(
    `INSERT INTO "User" (id, name, email, "phoneNumber", onboarded, "isActive", "updatedAt") VALUES ($1,$2,$3,$4,true,true,now())`,
    [u.id, u.name, `${u.id}@e2e-test.invalid`, u.phone],
  );
}

async function seedClub(id: string, opts: { language: string; approvalStatus: string; owner: { id: string; name: string; phone: string }; collector?: { id: string; name: string; phone: string } }) {
  const db = testDb();
  await db.run(
    `INSERT INTO "Organisation" ("id","name","slug","inviteCode","approvalStatus","approvedAt","whatsappGroupId",
       "whatsappBotEnabled","billingStatus","language","createdAt","updatedAt")
     VALUES ($1,$2,$1,$3,$4,$5,$6,$8,'trial',$7,now(),now())`,
    [id, id === TR_ORG ? "Erdal Spor" : "Cron Rovers", `${id}-invite`, opts.approvalStatus, APPROVED, `${id}@g.us`, opts.language, opts.approvalStatus === "approved"],
  );
  await db.run(
    `INSERT INTO "ClubBilling" ("orgId","trialStartedAt","trialEndsAt","updatedAt") VALUES ($1,$2,$3,now())`,
    // 30 days of 24 hours, as trialWindow() writes it (not Postgres's calendar interval).
    [id, new Date(APPROVED), new Date(Date.parse(APPROVED) + 30 * 24 * 60 * 60 * 1000)],
  );
  await db.run(
    `INSERT INTO "Sport" ("id","orgId","name","playersPerTeam","positions","teamLabels","createdAt","updatedAt")
     VALUES ($1,$2,'Football 5-a-side',5,ARRAY['GK','DEF','MID','FWD'],ARRAY['Red','Yellow'],now(),now())`,
    [`${id}-sport`, id],
  );
  await db.run(
    `INSERT INTO "Activity" ("id","orgId","sportId","name","dayOfWeek","time","venue","isActive","deadlineHours","createdAt","updatedAt")
     VALUES ($1,$2,$3,'Weekly game',2,'20:00','Park',true,5,now(),now())`,
    [`${id}-activity`, id, `${id}-sport`],
  );
  await seedUser(opts.owner);
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1,$2,$3,'OWNER')`, [`${opts.owner.id}-mem`, opts.owner.id, id]);
  if (opts.collector) {
    await seedUser(opts.collector);
    await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1,$2,$3,'PLAYER')`, [`${opts.collector.id}-mem`, opts.collector.id, id]);
    await db.run(`UPDATE "Organisation" SET "paymentHolderId" = $2 WHERE id = $1`, [id, opts.collector.id]);
  }
}

test.beforeAll(async () => {
  resetDb();
  await seedClub(EN_ORG, { language: "en", approvalStatus: "approved", owner: EN_OWNER, collector: EN_COLLECTOR });
  await seedClub(TR_ORG, { language: "tr", approvalStatus: "approved", owner: TR_OWNER });
  await seedClub(SUSP_ORG, { language: "en", approvalStatus: "suspended", owner: SUSP_OWNER });
});

test("refuses without the cron secret", async ({ request }) => {
  const res = await request.get("/api/cron/billing");
  expect(res.status()).toBe(401);
});

test("day 20: nothing yet", async ({ request }) => {
  await cron(request, "2026-10-21T12:00:00Z");
  expect(await billingDms(EN_COLLECTOR.phone)).toEqual([]);
  expect(await billingDms(TR_OWNER.phone)).toEqual([]);
});

test("day 21 at 10:00 London: one DM to the collector (EN) and one to the owner (TR), each with the tip; the admins get the tip once", async ({ request }) => {
  await cron(request, "2026-10-22T09:00:00Z");
  await cron(request, "2026-10-22T10:00:00Z"); // the next hourly run sends nothing more

  const en = await billingDms(EN_COLLECTOR.phone);
  expect(en).toHaveLength(1);
  expect(en[0].refId).toBe(`${EN_ORG}:trial-21:2026-10-31T09:00:00.000Z`);
  expect(en[0].sendAfter).toBeNull();
  expect(en[0].text).toContain("Hi Cole Collector, Cron Rovers's free month on MatchTime ends on Sat 31 Oct.");
  expect(en[0].text).toContain("*25p a player per game*");
  expect(en[0].text).toMatch(/\/r\/[A-Za-z0-9_-]+/);
  expect(en[0].text).not.toContain("make them the money collector");

  const tr = await billingDms(TR_OWNER.phone);
  expect(tr).toHaveLength(1);
  expect(tr[0].text).toContain("Merhaba Erdal, Erdal Spor için MatchTime'daki ücretsiz ay 31 Ekim Cumartesi tarihinde bitiyor.");
  expect(tr[0].text).toContain("Ayarlar'dan onu para toplayan kişi yapın");
  expect(tr[0].text).not.toMatch(/[–—]/);

  // The admin channel's tip: the EN club's owner (one person) is not the
  // contact, so it is queued for them as a BotJob; the TR club's one person
  // IS the contact, so it is skipped.
  const enTip = await testDb().all<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND text LIKE '%Club fee tip%'`, [EN_ORG]);
  expect(enTip).toHaveLength(1);
  expect(await testDb().count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1 AND text LIKE '%ipucu%'`, [TR_ORG])).toBe(0);

  // The suspended club: nothing, ever.
  expect(await billingDms(SUSP_OWNER.phone)).toEqual([]);
});

test("day 28: one reminder each, and still nothing twice", async ({ request }) => {
  await cron(request, "2026-10-29T10:00:00Z");
  await cron(request, "2026-10-29T11:00:00Z");
  const en = await billingDms(EN_COLLECTOR.phone);
  expect(en).toHaveLength(2);
  expect(en[1].text).toContain("a quick reminder: Cron Rovers's free month ends on Sat 31 Oct.");
  expect(await billingDms(TR_OWNER.phone)).toHaveLength(2);
});

test("day 30: the free month ends ON TIME (09:00 London), the DM waits for 10:00", async ({ request }) => {
  await cron(request, "2026-10-31T09:00:00Z");
  expect(await status(EN_ORG)).toBe("grace");
  expect(await status(SUSP_ORG)).toBe("trial");
  expect(await billingDms(EN_COLLECTOR.phone)).toHaveLength(2);
  await cron(request, "2026-10-31T10:00:00Z");
  const en = await billingDms(EN_COLLECTOR.phone);
  expect(en).toHaveLength(3);
  expect(en[2].text).toContain("free month has ended. MatchTime will keep running in Cron Rovers's WhatsApp group for one more week, until Sat 7 Nov.");
});

test("day 37: two cron runs at the same moment pause the club ONCE and send ONE 'paused' DM", async ({ request }) => {
  const [a, b] = await Promise.all([cron(request, "2026-11-07T10:00:00Z"), cron(request, "2026-11-07T10:00:00Z")]);
  const moved = [...a.clubs, ...b.clubs].filter((c) => c.orgId === EN_ORG && c.transition === "grace->paused");
  expect(moved).toHaveLength(1);
  expect(await status(EN_ORG)).toBe("paused");
  const paused = (await billingDms(EN_COLLECTOR.phone)).filter((d) => d.refId.startsWith(`${EN_ORG}:paused:`));
  expect(paused).toHaveLength(1);
  expect(paused[0].text).toContain("Hi Cole Collector, MatchTime is now paused for Cron Rovers.");
  expect(await testDb().count(`SELECT COUNT(*) FROM "BillingNotice" WHERE "orgId" = $1 AND kind = 'paused'`, [EN_ORG])).toBe(1);
  // Nothing was said in the club's own group.
  expect(await testDb().count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1 AND kind = 'group'`, [EN_ORG])).toBe(0);
});
