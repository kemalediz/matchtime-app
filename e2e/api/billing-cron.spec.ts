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
 * The clubs above are seeded with a STORED end (the scheduler reads only
 * `trialEndsAt`). The last test proves the two month free period end to
 * end instead: a club approved through the REAL path (connect, added to
 * its group, the owner's APPROVE by DM) gets its end from the one writer,
 * and the cron is then walked along that end.
 *
 * Deterministic: no model, no Stripe call (no refund intents are open).
 */
import { test, expect, resetDb } from "../fixtures";
import { E2E } from "../helpers/env";
import { testDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";
import { freePeriodEnd } from "@/lib/club-billing-rules";
import { formatLondon, londonDateTimeToUtc } from "@/lib/london-time";

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
    // A STORED free period end (30 days on, as it was written before the
    // free period became two months, 2026-10-12): the scheduler reads only
    // the stored `trialEndsAt`, so every step below is counted from it.
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

test("day 21 at 09:00 London: one DM to the collector (EN) and one to the owner (TR), each with the tip; the admins get the tip once", async ({ request }) => {
  await cron(request, "2026-10-22T07:00:00Z"); // 08:00 London: not yet
  expect(await billingDms(EN_COLLECTOR.phone)).toHaveLength(0);
  await cron(request, "2026-10-22T08:00:00Z"); // 09:00 London
  await cron(request, "2026-10-22T09:00:00Z"); // the next hourly run sends nothing more

  const en = await billingDms(EN_COLLECTOR.phone);
  expect(en).toHaveLength(1);
  expect(en[0].refId).toBe(`${EN_ORG}:trial-21:2026-10-31T09:00:00.000Z`);
  expect(en[0].sendAfter).toBeNull();
  expect(en[0].text).toContain("Hi Cole Collector, Cron Rovers's free period on MatchTime ends on Sat 31 Oct.");
  expect(en[0].text).toContain("*25p a player per game*");
  expect(en[0].text).toMatch(/\/r\/[A-Za-z0-9_-]+/);
  expect(en[0].text).not.toContain("make them the money collector");

  const tr = await billingDms(TR_OWNER.phone);
  expect(tr).toHaveLength(1);
  expect(tr[0].text).toContain("Merhaba Erdal, Erdal Spor için MatchTime'daki ücretsiz dönem 31 Ekim Cumartesi tarihinde bitiyor.");
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
  expect(en[1].text).toContain("a quick reminder: Cron Rovers's free period ends on Sat 31 Oct.");
  expect(await billingDms(TR_OWNER.phone)).toHaveLength(2);
});

test("day 30: the free month ends ON TIME (09:00 London), which is daytime, so the same run sends the DM, once", async ({ request }) => {
  await cron(request, "2026-10-31T08:00:00Z"); // 08:00 London: an hour early, nothing
  expect(await status(EN_ORG)).toBe("trial");
  expect(await billingDms(EN_COLLECTOR.phone)).toHaveLength(2);
  await cron(request, "2026-10-31T09:00:00Z");
  expect(await status(EN_ORG)).toBe("grace");
  expect(await status(SUSP_ORG)).toBe("trial");
  expect(await billingDms(EN_COLLECTOR.phone)).toHaveLength(3);
  await cron(request, "2026-10-31T10:00:00Z"); // the next hourly run sends nothing more
  const en = await billingDms(EN_COLLECTOR.phone);
  expect(en).toHaveLength(3);
  expect(en[2].text).toContain("free period has ended. MatchTime will keep running in the Cron Rovers WhatsApp group for one more week, until Sat 7 Nov.");
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

// ── The two month free period, from a REAL approval (2026-10-12) ────────

const TWO_ORG = "e2e-billing-cron-two";
const TWO_OWNER = { id: "e2e-bc-two-owner", name: "Tessa Two", phone: "+447700900975" };
const TWO_GROUP = "120363700000000091@g.us";
const SELF_JOIN = { "x-api-key": E2E.WHATSAPP_API_KEY, "x-mt-test-self-join": "1" };
const DAY = 24 * 60 * 60 * 1000;

/** `time` London on the London date `days` days after the London date of `at`. */
function londonAt(at: Date, days: number, time: string): Date {
  const [y, m, d] = formatLondon(at, "yyyy-MM-dd").split("-").map(Number);
  return londonDateTimeToUtc(new Date(Date.UTC(y, m - 1, d + days, 12)).toISOString().slice(0, 10), time);
}

test("a club approved through the real path is free for TWO months: nothing at one month, reminders 9 and 2 days before the end, grace at the end", async ({ request }) => {
  const db = testDb();
  // A draft club whose organiser has sent the connect DM (as self-join leaves it).
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus",language,"createdAt","updatedAt")
     VALUES ($1,'Two Month Town',$1,$2,'draft','en',now(),now())`,
    [TWO_ORG, `${TWO_ORG}-invite`],
  );
  await seedUser(TWO_OWNER);
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role) VALUES ($1,$2,$3,'OWNER')`, [`${TWO_OWNER.id}-mem`, TWO_OWNER.id, TWO_ORG]);
  await db.run(
    `INSERT INTO "Sport" ("id","orgId","name","playersPerTeam","positions","teamLabels","createdAt","updatedAt")
     VALUES ($1,$2,'Football 5-a-side',5,ARRAY['GK','DEF','MID','FWD'],ARRAY['Red','Yellow'],now(),now())`,
    [`${TWO_ORG}-sport`, TWO_ORG],
  );
  await db.run(
    `INSERT INTO "Activity" ("id","orgId","sportId","name","dayOfWeek","time","venue","isActive","deadlineHours","createdAt","updatedAt")
     VALUES ($1,$2,$3,'Weekly game',2,'20:00','Park',true,5,now(),now())`,
    [`${TWO_ORG}-activity`, TWO_ORG, `${TWO_ORG}-sport`],
  );
  await db.run(
    `INSERT INTO "ClubConnect" (id,"orgId","userId",phone,code,status,"issuedAt","expiresAt","dmAt","dmPhone","dmPhoneMatched","addWindowEndsAt","updatedAt")
     VALUES ('e2e-bc-two',$1,$2,$3,'2MTH','dm_verified',now() - interval '10 minutes',now() + interval '50 minutes',now() - interval '5 minutes',$3,true,now() + interval '23 hours',now())`,
    [TWO_ORG, TWO_OWNER.id, digits(TWO_OWNER.phone)],
  );

  // The organiser adds MatchTime to the group; the platform owner approves by DM.
  const added = await request.post("/api/whatsapp/bot-added", {
    headers: SELF_JOIN,
    data: {
      groupId: TWO_GROUP,
      groupSubject: "Two Month Town 5s",
      addedByPhone: digits(TWO_OWNER.phone),
      participants: [{ phone: digits(TWO_OWNER.phone), pushname: "Tessa" }],
    },
  });
  expect(added.status(), await added.text()).toBe(200);
  expect(await added.json()).toMatchObject({ selfJoin: "linked", silent: true });
  const approve = await request.post("/api/whatsapp/dm-reply", {
    headers: SELF_JOIN,
    data: { phone: E2E.APPROVER_PHONE, body: "APPROVE 2MTH", waMessageId: "e2e-bc-two-approve" },
  });
  expect(approve.status(), await approve.text()).toBe(200);
  expect(await approve.json()).toMatchObject({ handled: "approver-dm", result: "approved" });

  // The one writer started the free period at the approval, two London
  // calendar months long. (AT TIME ZONE 'UTC': the columns hold UTC with no
  // zone, and `pg` would otherwise read them as this machine's local time.)
  expect(await status(TWO_ORG)).toBe("trial");
  const row = await db.one<{ approved: Date; starts: Date; ends: Date }>(
    `SELECT o."approvedAt" AT TIME ZONE 'UTC' AS approved, cb."trialStartedAt" AT TIME ZONE 'UTC' AS starts, cb."trialEndsAt" AT TIME ZONE 'UTC' AS ends
       FROM "ClubBilling" cb JOIN "Organisation" o ON o.id = cb."orgId" WHERE cb."orgId" = $1`,
    [TWO_ORG],
  );
  const { approved, starts, ends } = row!;
  expect(starts).toEqual(approved);
  expect(ends).toEqual(freePeriodEnd(approved));
  // Not 30 days: two calendar months on, at the same London time of day.
  expect((ends.getTime() - approved.getTime()) / DAY).toBeGreaterThan(58.9);
  expect((ends.getTime() - approved.getTime()) / DAY).toBeLessThan(62.1);
  expect(formatLondon(ends, "HH:mm:ss")).toBe(formatLondon(approved, "HH:mm:ss"));
  const [ay, am] = formatLondon(approved, "yyyy-MM").split("-").map(Number);
  const [ey, em] = formatLondon(ends, "yyyy-MM").split("-").map(Number);
  expect(ey * 12 + em - (ay * 12 + am)).toBe(2);

  const ownerDms = () => billingDms(TWO_OWNER.phone);
  const endKey = ends.toISOString();
  const endDay = formatLondon(ends, "EEE d MMM");

  // One month and a day in, at midday (where a 30 day free period would
  // already be over and in its grace week): still free, nothing said.
  await cron(request, londonAt(approved, 31, "12:00").toISOString());
  expect(await status(TWO_ORG)).toBe("trial");
  expect(await ownerDms()).toEqual([]);

  // Ten days before the end, at midday: still nothing.
  await cron(request, londonAt(ends, -10, "12:00").toISOString());
  expect(await ownerDms()).toEqual([]);

  // Nine days before the end: nothing at 08:00 London, the first reminder at 09:00, once.
  await cron(request, londonAt(ends, -9, "08:00").toISOString());
  expect(await ownerDms()).toEqual([]);
  await cron(request, londonAt(ends, -9, "09:00").toISOString());
  await cron(request, londonAt(ends, -9, "10:00").toISOString());
  let dms = await ownerDms();
  expect(dms).toHaveLength(1);
  expect(dms[0].refId).toBe(`${TWO_ORG}:trial-21:${endKey}`);
  expect(dms[0].text).toContain(`Hi Tessa Two, Two Month Town's free period on MatchTime ends on ${endDay}.`);

  // Three days before the end: no second reminder yet.
  await cron(request, londonAt(ends, -3, "12:00").toISOString());
  expect(await ownerDms()).toHaveLength(1);

  // Two days before the end, 09:00 London: the second reminder, once.
  await cron(request, londonAt(ends, -2, "09:00").toISOString());
  await cron(request, londonAt(ends, -2, "10:00").toISOString());
  dms = await ownerDms();
  expect(dms).toHaveLength(2);
  expect(dms[1].refId).toBe(`${TWO_ORG}:trial-28:${endKey}`);
  expect(dms[1].text).toContain(`a quick reminder: Two Month Town's free period ends on ${endDay}.`);

  // The last free minute, then the end itself: grace for a week from the end.
  await cron(request, new Date(ends.getTime() - 60_000).toISOString());
  expect(await status(TWO_ORG)).toBe("trial");
  await cron(request, endKey);
  expect(await status(TWO_ORG)).toBe("grace");
  const grace = await db.one<{ g: Date }>(`SELECT "graceEndsAt" AT TIME ZONE 'UTC' AS g FROM "ClubBilling" WHERE "orgId" = $1`, [TWO_ORG]);
  expect(grace!.g).toEqual(new Date(ends.getTime() + 7 * DAY));
  // No billing month before the end: the two months were free.
  expect(
    await db.count(`SELECT COUNT(*) FROM "ClubBillingMonth" WHERE "orgId" = $1 AND "startsAt" < ($2::timestamptz AT TIME ZONE 'UTC')`, [TWO_ORG, endKey]),
  ).toBe(0);

  // The "free period has ended" DM, in the daytime (the next midday at the latest), once.
  await cron(request, londonAt(ends, 1, "12:00").toISOString());
  await cron(request, londonAt(ends, 1, "13:00").toISOString());
  dms = await ownerDms();
  expect(dms).toHaveLength(3);
  expect(dms[2].refId).toBe(`${TWO_ORG}:trial-ended:${endKey}`);
  expect(dms[2].text).toContain("Hi Tessa Two, Two Month Town's free period has ended.");
});
