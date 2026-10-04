/**
 * CLUB FEE BILLING, slice B5: MatchTime removed from, and added back to, a
 * live club's group, against a real Postgres, the real routes and the fake
 * Stripe (the same JSON-file world the dev server uses).
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, section 4.2 and decision 6.
 *
 * The e2e server runs with BILLING_ENABLED=1 and SELF_JOIN_ENABLED off. The
 * `x-mt-test-billing: 0` header turns billing off for one request (honoured
 * only because the harness boots the server with MT_TEST_MODE=1), and
 * `x-mt-test-self-join: 1` turns self-join on for the pending club's case.
 *
 * What is pinned (slice P2, games played: no subscription):
 *   - a billed club: paused (removed), NOTHING charged, ended or refunded
 *     in Stripe (only open card sessions expire; the games played before
 *     the removal are charged when that month closes), no DM; it leaves
 *     the Pi's monitored set; a repeat changes nothing;
 *   - added back: with a card on file and nothing unpaid it serves again;
 *     in the free month with no card it is back in trial; after it, it
 *     waits for a card;
 *   - Sutton FC (the seeded club, never billed): logged only;
 *   - BILLING_ENABLED off: logged only, nothing written;
 *   - a pending self-join club: exactly today's behaviour (back to draft).
 *
 * Deterministic end to end: nothing here calls a model.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { ORG_ID } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { testDb } from "../helpers/test-db";
// Static import: Playwright rewrites the "@/" alias only for static imports.
import { createFakeBillingStripe } from "@/lib/stripe-billing-fake";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const DAY = 24 * 60 * 60 * 1000;

const PAYING = "e2e-b5-paying";
const PAYING_GROUP = "120363900000000501@g.us";
const TRIAL = "e2e-b5-trial";
const TRIAL_GROUP = "120363900000000502@g.us";
const LATE = "e2e-b5-late";
const LATE_GROUP = "120363900000000503@g.us";
const FLAGOFF = "e2e-b5-flagoff";
const FLAGOFF_GROUP = "120363900000000504@g.us";
const PENDING = "e2e-b5-pending";
const PENDING_GROUP = "120363900000000505@g.us";
const PENDING_OWNER = "e2e-b5-pending-owner";

const CUS = "cus_e2e_b5";
const PM = "pm_e2e_b5";
const TRIAL_ENDS = new Date(Date.now() + 25 * DAY);

const fake = () => createFakeBillingStripe({ file: E2E.BILLING_STRIPE_FILE });

async function botRemoved(request: APIRequestContext, groupId: string, headers: Record<string, string> = KEY) {
  const res = await request.post("/api/whatsapp/bot-removed", { headers, data: { groupId } });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function botAdded(request: APIRequestContext, groupId: string, headers: Record<string, string> = KEY) {
  const res = await request.post("/api/whatsapp/bot-added", {
    headers,
    data: { groupId, groupSubject: "Back again", addedByPhone: "447700900991", participants: [] },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function orgs(request: APIRequestContext) {
  const res = await request.get("/api/whatsapp/orgs", { headers: KEY });
  expect(res.status(), await res.text()).toBe(200);
  return res.json() as Promise<{ orgs: Array<{ whatsappGroupId: string }>; silentGroups: string[] }>;
}
const monitored = async (request: APIRequestContext) => (await orgs(request)).orgs.map((o) => o.whatsappGroupId);

const club = (id: string) =>
  testDb().one<{
    approvalStatus: string;
    billingStatus: string;
    whatsappBotEnabled: boolean;
    pausedReason: string | null;
    cancelAtPeriodEnd: boolean | null;
    trialEndsAt: Date | null;
  }>(
    `SELECT o."approvalStatus", o."billingStatus", o."whatsappBotEnabled", b."pausedReason", b."cancelAtPeriodEnd", b."trialEndsAt"
       FROM "Organisation" o LEFT JOIN "ClubBilling" b ON b."orgId" = o.id WHERE o.id = $1`,
    [id],
  );

const billingDms = () => testDb().count(`SELECT COUNT(*) FROM "PlatformJob" WHERE purpose = 'billing'`);

async function seedBilledClub(id: string, group: string, status: string, trialEndsAt: Date, card = false) {
  const db = testDb();
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus","approvedAt","approvalDecidedAt","whatsappGroupId",
       "whatsappBotEnabled","billingStatus","createdAt","updatedAt")
     VALUES ($1,$2,$1,$3,'approved',$4,$4,$5,true,$6,now(),now())`,
    [id, `B5 ${id}`, `${id}-invite`, new Date(trialEndsAt.getTime() - 30 * DAY).toISOString(), group, status],
  );
  await db.run(
    `INSERT INTO "ClubBilling" ("orgId","trialStartedAt","trialEndsAt","graceEndsAt","stripeCustomerId","stripePaymentMethodId",
       "cardBrand","cardLast4","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
    [
      id,
      new Date(trialEndsAt.getTime() - 30 * DAY).toISOString(),
      trialEndsAt.toISOString(),
      status === "grace" ? new Date(trialEndsAt.getTime() + 7 * DAY).toISOString() : null,
      card ? CUS : null,
      card ? PM : null,
      card ? "visa" : null,
      card ? "4242" : null,
    ],
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
}

test.beforeAll(async () => {
  resetDb();
  mkdirSync(path.dirname(E2E.BILLING_STRIPE_FILE), { recursive: true });
  writeFileSync(E2E.BILLING_STRIPE_FILE, "{}");

  // A club with a card on in its free month ("subscribed": a card on file).
  await seedBilledClub(PAYING, PAYING_GROUP, "subscribed", TRIAL_ENDS, true);
  // In the free month with no card; in grace after it; one for the flag-off check.
  await seedBilledClub(TRIAL, TRIAL_GROUP, "trial", TRIAL_ENDS);
  await seedBilledClub(LATE, LATE_GROUP, "grace", new Date(Date.now() - 3 * DAY));
  await seedBilledClub(FLAGOFF, FLAGOFF_GROUP, "trial", TRIAL_ENDS);

  // A self-join club waiting for approval, its group linked.
  const db = testDb();
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus",language,"whatsappGroupId","createdAt","updatedAt")
     VALUES ($1,'B5 Pending',$1,$2,'pending','en',$3,now(),now())`,
    [PENDING, `${PENDING}-invite`, PENDING_GROUP],
  );
  await db.run(
    `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt")
     VALUES ($1,'Penny Pending','b5-pending@e2e-test.invalid','+447700900995',true,true,now())`,
    [PENDING_OWNER],
  );
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role) VALUES ($1,$2,$3,'OWNER')`, [`${PENDING_OWNER}-mem`, PENDING_OWNER, PENDING]);
  await db.run(
    `INSERT INTO "ClubConnect" (id,"orgId","userId",phone,code,status,"issuedAt","expiresAt","groupId","linkedAt","updatedAt")
     VALUES ('e2e-b5-connect',$1,$2,'447700900995','B5PQ','group_linked',now() - interval '1 hour',now() + interval '1 hour',$3,now(),now())`,
    [PENDING, PENDING_OWNER, PENDING_GROUP],
  );
});

test.afterAll(() => {
  resetDb();
});

test("a billed club: paused (removed), nothing charged or ended in Stripe, no DM, out of the Pi's monitored set", async ({
  request,
}) => {
  expect(await monitored(request)).toContain(PAYING_GROUP);
  const dms = await billingDms();

  expect(await botRemoved(request, PAYING_GROUP)).toEqual({ ok: true, billing: "paused", orgId: PAYING });

  expect(await club(PAYING)).toMatchObject({
    approvalStatus: "approved",
    billingStatus: "paused",
    whatsappBotEnabled: true, // billing never touches the mute switch
    pausedReason: "removed",
    cancelAtPeriodEnd: false,
  });
  // Only the open card sessions are expired: no invoice, no payment, no detach.
  expect(fake().state().calls.map((c) => c.method)).toEqual(["expireOpenCheckoutSessions"]);
  expect(await billingDms()).toBe(dms);

  const after = await orgs(request);
  expect(after.orgs.map((o) => o.whatsappGroupId)).not.toContain(PAYING_GROUP);
  expect(after.silentGroups).toContain(PAYING_GROUP);
});

test("the same removal again (a repeated event): nothing changes", async ({ request }) => {
  expect(await botRemoved(request, PAYING_GROUP)).toEqual({ ok: true, billing: "already-paused", orgId: PAYING });
  expect((await club(PAYING))?.billingStatus).toBe("paused");
  expect(fake().state().calls.filter((c) => !["expireOpenCheckoutSessions"].includes(c.method))).toEqual([]);
});

test("added back with a card on file and nothing unpaid: the club serves again, no Stripe call", async ({ request }) => {
  const before = fake().state().calls.length;
  const json = await botAdded(request, PAYING_GROUP);
  expect(json).toMatchObject({ ok: true, introText: null });
  expect(await club(PAYING)).toMatchObject({ billingStatus: "subscribed", pausedReason: null });
  expect(fake().state().calls.length).toBe(before);
  expect(await monitored(request)).toContain(PAYING_GROUP);
});

test("in the free month with no card: removed then added back is the same free month (trial end kept)", async ({ request }) => {
  const before = await club(TRIAL);
  expect(await botRemoved(request, TRIAL_GROUP)).toEqual({ ok: true, billing: "paused", orgId: TRIAL });
  expect(await club(TRIAL)).toMatchObject({ billingStatus: "paused", pausedReason: "removed" });
  await botAdded(request, TRIAL_GROUP);
  const after = await club(TRIAL);
  expect(after).toMatchObject({ billingStatus: "trial", pausedReason: null });
  expect(after?.trialEndsAt?.toISOString()).toBe(before?.trialEndsAt?.toISOString());
});

test("after the free month: removed then added back stays paused, now waiting for a card", async ({ request }) => {
  expect(await botRemoved(request, LATE_GROUP)).toEqual({ ok: true, billing: "paused", orgId: LATE });
  await botAdded(request, LATE_GROUP);
  expect(await club(LATE)).toMatchObject({ billingStatus: "paused", pausedReason: "no-card" });
  expect((await orgs(request)).silentGroups).toContain(LATE_GROUP);
});

test("Sutton FC (never billed): the removal is logged only, nothing changes", async ({ request }) => {
  expect(await botRemoved(request, E2E.GROUP_ID)).toEqual({ ok: true, billing: "exempt", orgId: ORG_ID });
  expect(await club(ORG_ID)).toMatchObject({ approvalStatus: "approved", billingStatus: "exempt", whatsappBotEnabled: true });
  expect(await monitored(request)).toContain(E2E.GROUP_ID);
  // And a re-add changes nothing either.
  expect(await botAdded(request, E2E.GROUP_ID)).toMatchObject({ introText: null });
  expect((await club(ORG_ID))?.billingStatus).toBe("exempt");
});

test("BILLING_ENABLED off: the removal is accepted and logged only, nothing written", async ({ request }) => {
  const calls = fake().state().calls.length;
  expect(await botRemoved(request, FLAGOFF_GROUP, { ...KEY, "x-mt-test-billing": "0" })).toEqual({
    ok: true,
    billing: "flag-off",
    orgId: FLAGOFF,
  });
  expect(await club(FLAGOFF)).toMatchObject({ billingStatus: "trial", pausedReason: null });
  expect(fake().state().calls.length).toBe(calls);
  expect(await monitored(request)).toContain(FLAGOFF_GROUP);
});

test("a pending self-join club: exactly today's behaviour, back to draft, no billing answer", async ({ request }) => {
  const json = await botRemoved(request, PENDING_GROUP, { ...KEY, "x-mt-test-self-join": "1" });
  expect(json).toEqual({ ok: true, returnedToDraft: 1, unsolicitedLeft: 0 });
  expect((await club(PENDING))?.approvalStatus).toBe("draft");
});
