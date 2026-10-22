/**
 * PARTNER DISCOVERY, slice P1: the weekly venue reminder, against a real
 * Postgres (2026-10-22). Plan: MDs/partner-discovery-plan-2026-10-21.md,
 * section 2.1.
 *
 *   - a live club with no geocoded venue: ONE DM to its owners and admins
 *     (the fixture club is on "each-admin", so one per owner or admin with
 *     a phone), with a signed-in link to the venue lookup;
 *   - at most once a week: a second run that day, and one six days later,
 *     send nothing; one seven days later sends again;
 *   - CONCURRENCY: five runs at the same moment send ONE (the claim is a
 *     compare-and-set that Postgres serialises on the row);
 *   - never to a club with a geocoded venue (a game's or the club venue),
 *     and it stops for good once one is set;
 *   - a muted club is not reminded;
 *   - the CHECK constraints refuse a bad origin and a bad end reason.
 *
 * No model anywhere: this spec makes zero model calls.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { ACTIVITY_ID, ORG_ID, PHONE, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

/** 11:00 London on a weekday: inside message hours, so nothing is held. */
const T0 = new Date("2026-10-22T10:00:00Z");
const DAY = 24 * 3600_000;
const at = (days: number) => new Date(T0.getTime() + days * DAY);

async function runCron(request: APIRequestContext, now: Date) {
  const res = await request.get("/api/cron/venue-reminder", {
    headers: { authorization: `Bearer ${E2E.CRON_SECRET}`, "x-test-now": now.toISOString() },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as { considered: number; sent: number };
}

const reminders = (db: TestDb) =>
  db.all<{ phone: string; text: string; kind: string }>(
    `SELECT phone, text, kind FROM "BotJob" WHERE "orgId" = $1 AND text LIKE '%nearby clubs can find you%' ORDER BY "createdAt"`,
    [ORG_ID],
  );

test.beforeEach(async ({ db }) => {
  resetDb();
  await db.run(`DELETE FROM "BotJob"`);
});

test.afterAll(() => {
  resetDb();
});

test("unauthorised without the cron secret", async ({ request }) => {
  const res = await request.get("/api/cron/venue-reminder");
  expect(res.status()).toBe(401);
});

test("a club with no venue gets ONE reminder a week, with a link to the venue lookup", async ({ request, db }) => {
  expect((await runCron(request, T0)).sent).toBe(1);
  const sent = await reminders(db);
  expect(sent).toHaveLength(1);
  expect(sent[0].kind).toBe("dm");
  expect(sent[0].phone).toBe(PHONE.admin.replace(/^\+/, ""));
  expect(sent[0].text).toContain("E2E Test FC");
  expect(sent[0].text).toMatch(/https?:\/\/\S+/);
  const stamp = await db.one<{ at: Date }>(`SELECT "venueReminderSentAt" AS at FROM "Organisation" WHERE id = $1`, [ORG_ID]);
  expect(stamp?.at?.toISOString()).toBe(T0.toISOString());

  // The same day, and six days later: nothing.
  expect((await runCron(request, new Date(T0.getTime() + 3600_000))).sent).toBe(0);
  expect((await runCron(request, at(6))).sent).toBe(0);
  expect(await reminders(db)).toHaveLength(1);

  // A week later: again.
  expect((await runCron(request, at(7))).sent).toBe(1);
  expect(await reminders(db)).toHaveLength(2);
});

test("CONCURRENCY: five runs at the same moment send one reminder", async ({ request, db }) => {
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => runCron(request, T0)));
  expect(results.reduce((n, r) => n + r.sent, 0)).toBe(1);
  expect(await reminders(db)).toHaveLength(1);
});

test("never to a club whose game has a geocoded venue", async ({ request, db }) => {
  await db.run(
    `INSERT INTO "Venue" (id, "placeId", name, lat, lng, source, "createdAt", "updatedAt") VALUES ('e2e-vr-venue', 'ChIJ_e2e_vr_0001', 'E2E Arena', 51.36, -0.17, 'google', now(), now())`,
  );
  await db.run(`UPDATE "Activity" SET "venueId" = 'e2e-vr-venue' WHERE id = $1`, [ACTIVITY_ID]);
  expect((await runCron(request, T0)).sent).toBe(0);
  expect(await reminders(db)).toHaveLength(0);
});

test("stops for good once a club venue is set", async ({ request, db }) => {
  expect((await runCron(request, T0)).sent).toBe(1);
  await db.run(
    `INSERT INTO "Venue" (id, "placeId", name, lat, lng, source, "createdAt", "updatedAt") VALUES ('e2e-vr-home', 'ChIJ_e2e_vr_0002', 'Home Pitch', 51.37, -0.18, 'google', now(), now())`,
  );
  await db.run(`UPDATE "Organisation" SET "homeVenueId" = 'e2e-vr-home' WHERE id = $1`, [ORG_ID]);
  for (const days of [7, 14, 60]) expect((await runCron(request, at(days))).sent).toBe(0);
  expect(await reminders(db)).toHaveLength(1);
});

test("a muted club is not reminded", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET "whatsappBotEnabled" = false WHERE id = $1`, [ORG_ID]);
  expect((await runCron(request, T0)).sent).toBe(0);
  expect(await reminders(db)).toHaveLength(0);
});

test("existing clubs read as discoverable, auto-accept off; the CHECKs refuse bad values", async ({ db }) => {
  const org = await db.one<{ discoverable: boolean; auto: boolean }>(
    `SELECT discoverable, "autoAcceptPartnerRequests" AS auto FROM "Organisation" WHERE id = $1`,
    [ORG_ID],
  );
  expect(org).toEqual({ discoverable: true, auto: false });

  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","createdAt","updatedAt") VALUES ('e2e-vr-other','Other FC','e2e-vr-other','e2e-vr-other-invite',now(),now())`,
  );
  const insert = (origin: string, endReason: string | null) =>
    db.run(
      `INSERT INTO "ClubPartnership" (id,"askerOrgId","partnerOrgId","createdByUserId",origin,"endReason","createdAt","updatedAt")
       VALUES ('e2e-vr-pair',$1,'e2e-vr-other',$2,$3,$4,now(),now())`,
      [ORG_ID, U.admin, origin, endReason],
    );
  await expect(insert("somebody", null)).rejects.toThrow(/ClubPartnership_origin_check/);
  await expect(insert("request", "bored")).rejects.toThrow(/ClubPartnership_endReason_check/);
  await insert("request", "declined");
  await expect(
    db.run(`INSERT INTO "ClubBlock" (id,"blockerOrgId","blockedOrgId","createdByUserId") VALUES ('e2e-vr-block',$1,$1,$2)`, [ORG_ID, U.admin]),
  ).rejects.toThrow(/ClubBlock_two_clubs_check/);
});
