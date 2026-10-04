/**
 * CLUB FEE BILLING, slice P3: a whole billing month through the REAL hourly
 * cron (/api/cron/billing, clock pinned by `x-test-now`) on real Postgres,
 * then the REAL billing webhook with a locally signed event.
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 2A, 5.3, 5.4, 6,
 * 7.3 and 10.2.
 *
 * STRIPE IS THE FAKE ADAPTER (src/lib/stripe-billing-fake.ts, one JSON file
 * shared with the dev server): nothing reaches Stripe. No model, no
 * production data.
 *
 * Fixture club: card on file (a player, Colin, is the money collector), its
 * free month ended at 00:00 London on Tue 1 Dec 2026, so month 1 is
 * 1 Dec to 31 Dec: five Tuesdays (1, 8, 15, 22, 29), four played and one
 * cancelled. Kemal's example: 4 of 5 is GBP 7.99.
 *
 *   1. The free month ends: the cron opens month 1 (at night too).
 *   2. Every run during the month and the night after it: nothing closes.
 *   3. 10:00 London on 1 Jan: the month closes, 4 of 5 counted, ONE fake
 *      invoice of 799p (the card needs a bank check, so it stays open).
 *   4. Stripe's invoice.paid (signed fixture): the month is paid and the
 *      collector gets ONE receipt; re-deliveries and later runs add nothing.
 *   5. January has no games: nothing charged, ONE "nothing to pay" DM;
 *      February has none either: no second DM.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Stripe from "stripe";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { E2E, E2E_BASE_URL } from "../helpers/env";
import { testDb } from "../helpers/test-db";
// Static import: Playwright rewrites the "@/" alias only for static imports.
import { createFakeBillingStripe, type FakeStripeState } from "@/lib/stripe-billing-fake";

test.describe.configure({ mode: "serial" });

const CRON = { authorization: `Bearer ${E2E.CRON_SECRET}` };
const ORG = "e2e-bill-p3-club";
const OWNER = { id: "e2e-bp3-owner", name: "Oona Owner", phone: "+447700901301" };
const COLIN = { id: "e2e-bp3-colin", name: "Colin Months", phone: "+447700901302" };
const PLAYERS = ["e2e-bp3-p1", "e2e-bp3-p2"];
const TRIAL_ENDS = "2026-12-01T00:00:00Z"; // 00:00 London, Tue 1 Dec
const DEC_TUESDAYS = ["2026-12-01", "2026-12-08", "2026-12-15", "2026-12-22", "2026-12-29"];
const DASH = /[—–]/;

const fake = () => createFakeBillingStripe({ file: E2E.BILLING_STRIPE_FILE });
const signer = new Stripe("sk_test_signing_only_never_used");
let seq = 0;

async function cron(request: APIRequestContext, at: string) {
  const res = await request.get("/api/cron/billing", { headers: { ...CRON, "x-test-now": at } });
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { enabled: boolean; clubs: Array<{ orgId: string; opened?: number[]; closed?: string; monthDms?: string[]; error?: string }> };
  const mine = body.clubs.find((c) => c.orgId === ORG);
  expect(mine?.error, JSON.stringify(mine)).toBeUndefined();
  return mine;
}

async function postEvent(request: APIRequestContext, type: string, object: Record<string, unknown>, id?: string) {
  const payload = JSON.stringify({ id: id ?? `evt_e2e_p3_${Date.now()}_${++seq}`, object: "event", type, created: Math.floor(Date.now() / 1000), data: { object } });
  const sig = signer.webhooks.generateTestHeaderString({ payload, secret: E2E.BILLING_WEBHOOK_SECRET });
  const res = await request.post(`${E2E_BASE_URL}/api/stripe/billing-webhook`, { headers: { "stripe-signature": sig, "content-type": "application/json" }, data: payload });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const months = () =>
  testDb().all<{ id: string; index: number; status: string; scheduled: number | null; played: number | null; amountPence: number | null; stripeInvoiceId: string | null }>(
    `SELECT id, index, status, scheduled, played, "amountPence", "stripeInvoiceId" FROM "ClubBillingMonth" WHERE "orgId" = $1 ORDER BY index`,
    [ORG],
  );
const billingDms = () =>
  testDb().all<{ phone: string; text: string; refId: string }>(
    `SELECT phone, text, "refId" FROM "PlatformJob" WHERE purpose = 'billing' AND "refId" LIKE $1 ORDER BY "createdAt"`,
    [`${ORG}:%`],
  );
const stripeState = () => JSON.parse(readFileSync(E2E.BILLING_STRIPE_FILE, "utf8")) as FakeStripeState;
const clubInvoices = () => Object.values(stripeState().invoices).filter((i) => (i.metadata ?? {}).orgId === ORG);

test.beforeAll(async () => {
  resetDb();
  mkdirSync(path.dirname(E2E.BILLING_STRIPE_FILE), { recursive: true });
  writeFileSync(E2E.BILLING_STRIPE_FILE, "{}");
  const db = testDb();
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus",language,"approvedAt","approvalDecidedAt","whatsappGroupId","billingStatus","createdAt","updatedAt")
     VALUES ($1,'Month Rovers',$1,$2,'approved','en','2026-10-31T23:00:00Z','2026-10-31T23:00:00Z',$3,'subscribed',now(),now())`,
    [ORG, `${ORG}-invite`, `${ORG}@g.us`],
  );
  await db.run(
    `INSERT INTO "ClubBilling" ("orgId","trialStartedAt","trialEndsAt","stripeCustomerId","stripePaymentMethodId","cardBrand","cardLast4","cardHolderUserId","updatedAt")
     VALUES ($1,'2026-10-31T23:00:00Z',$2,'cus_e2e_p3','pm_e2e_p3_colin','visa','4242',$3,now())`,
    [ORG, TRIAL_ENDS, COLIN.id],
  );
  for (const u of [OWNER, COLIN, ...PLAYERS.map((id, i) => ({ id, name: `Player ${i + 1}`, phone: `+4477009013${10 + i}` }))]) {
    await db.run(
      `INSERT INTO "User" (id, name, email, "phoneNumber", onboarded, "isActive", "updatedAt") VALUES ($1,$2,$3,$4,true,true,now())`,
      [u.id, u.name, `${u.id}@e2e-test.invalid`, u.phone],
    );
  }
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role) VALUES ($1,$2,$3,'OWNER')`, [`${OWNER.id}-m`, OWNER.id, ORG]);
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role) VALUES ($1,$2,$3,'PLAYER')`, [`${COLIN.id}-m`, COLIN.id, ORG]);
  await db.run(`UPDATE "Organisation" SET "paymentHolderId" = $2 WHERE id = $1`, [ORG, COLIN.id]);
  await db.run(
    `INSERT INTO "Sport" ("id","orgId","name","playersPerTeam","positions","teamLabels","createdAt","updatedAt")
     VALUES ($1,$2,'Football 5-a-side',5,ARRAY['GK','DEF','MID','FWD'],ARRAY['Red','Yellow'],now(),now())`,
    [`${ORG}-sport`, ORG],
  );
  await db.run(
    `INSERT INTO "Activity" ("id","orgId","sportId","name","dayOfWeek","time","venue","isActive","deadlineHours","createdAt","updatedAt")
     VALUES ($1,$2,$3,'Tuesday 5s',2,'19:00','Park',true,5,'2026-01-01T00:00:00Z',now())`,
    [`${ORG}-act`, ORG, `${ORG}-sport`],
  );
  // December: four Tuesdays played (players said IN), one cancelled.
  for (const [i, day] of DEC_TUESDAYS.entries()) {
    const id = `${ORG}-m-${day}`;
    const cancelled = i === 2;
    await db.run(
      `INSERT INTO "Match" (id,"activityId",date,"maxPlayers",status,"attendanceDeadline","postMatchEndFlow","updatedAt")
       VALUES ($1,$2,$3,10,$4,$3,false,now())`,
      [id, `${ORG}-act`, `${day}T19:00:00Z`, cancelled ? "CANCELLED" : "COMPLETED"],
    );
    if (!cancelled) {
      for (const p of PLAYERS) await db.run(`INSERT INTO "Attendance" (id,"matchId","userId",status,"updatedAt") VALUES ($1,$2,$3,'CONFIRMED',now())`, [`${id}-${p}`, id, p]);
    }
  }
  // The collector's card needs a bank check off-session: the close leaves
  // the invoice open, and Stripe's invoice.paid comes later.
  fake().setPayOutcome("pm_e2e_p3_colin", "action");
});

test("1. the free month ends at 00:00: the cron opens month 1, at night", async ({ request }) => {
  expect((await cron(request, "2026-11-30T23:00:00Z"))?.opened).toBeUndefined();
  expect((await cron(request, TRIAL_ENDS))?.opened).toEqual([1]);
  expect(await months()).toEqual([expect.objectContaining({ index: 1, status: "open", scheduled: null })]);
});

test("2. during the month and the night after it ends: nothing closes, nothing is charged", async ({ request }) => {
  for (const at of ["2026-12-15T12:00:00Z", "2026-12-31T19:00:00Z", "2027-01-01T00:00:00Z", "2027-01-01T06:00:00Z", "2027-01-01T09:00:00Z"]) await cron(request, at);
  expect((await months())[0]).toMatchObject({ index: 1, status: "open" });
  expect(clubInvoices()).toEqual([]);
});

test("3. 10:00 London on 1 Jan: the month closes ONCE (two runs at once), 4 of 5 played, one invoice of 799p", async ({ request }) => {
  const [a, b] = await Promise.all([cron(request, "2027-01-01T10:00:00Z"), cron(request, "2027-01-01T10:00:00Z")]);
  expect([a?.closed, b?.closed].filter((c) => c === "1:invoiced")).toHaveLength(1);
  const [m1, m2] = await months();
  expect(m1).toMatchObject({ index: 1, status: "invoiced", scheduled: 5, played: 4, amountPence: 799 });
  expect(m2).toMatchObject({ index: 2, status: "open" });
  const invs = clubInvoices();
  expect(invs).toHaveLength(1);
  expect(invs[0]).toMatchObject({ id: m1.stripeInvoiceId, status: "open", totalPence: 799 });
  // Nothing taken yet: no receipt.
  expect((await billingDms()).filter((d) => d.refId.includes(":month-charged:"))).toEqual([]);
});

test("4. invoice.paid: the month is paid and the collector gets ONE receipt, whatever is re-delivered or re-run", async ({ request }) => {
  const [m1] = await months();
  // The payer completes the bank check: Stripe now holds it paid.
  fake().setPayOutcome("pm_e2e_p3_colin", "succeed");
  await fake().payInvoice(m1.stripeInvoiceId!, { paymentMethodId: "pm_e2e_p3_colin" });
  const object = { id: m1.stripeInvoiceId, object: "invoice", metadata: { orgId: ORG, purpose: "club-fee", monthId: m1.id } };
  const evtId = `evt_e2e_p3_paid_${Date.now()}`;
  expect(await postEvent(request, "invoice.paid", object, evtId)).toMatchObject({ received: true, action: "month-paid" });
  expect(await postEvent(request, "invoice.paid", object, evtId)).toEqual({ received: true, duplicate: true });
  await postEvent(request, "invoice.paid", object); // a second, distinct delivery
  // Real time may be night (the webhook then leaves it for the 10:00 run):
  // the cron's daytime run sends it if it has not gone yet.
  await cron(request, "2027-01-02T10:00:00Z");
  await cron(request, "2027-01-02T11:00:00Z");
  expect((await months())[0]).toMatchObject({ status: "paid" });
  const receipts = (await billingDms()).filter((d) => d.refId === `${ORG}:month-charged:${m1.id}`);
  expect(receipts).toHaveLength(1);
  expect(receipts[0].phone).toBe(COLIN.phone.replace(/^\+/, ""));
  expect(receipts[0].text).toContain(
    "Hi Colin Months, Month Rovers played 4 of 5 games between 1 Dec and 31 Dec, so £7.99 was charged to your card ending 4242 (VAT included; a full month is £9.99).",
  );
  expect(receipts[0].text).toMatch(/Details: \S+\/r\/[A-Za-z0-9_-]+/);
  expect(receipts[0].text).not.toMatch(DASH);
  // Never the owner, nothing in the group.
  expect((await billingDms()).every((d) => d.phone !== OWNER.phone.replace(/^\+/, ""))).toBe(true);
  expect(await testDb().count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1 AND kind = 'group'`, [ORG])).toBe(0);
});

test("5. January has no games: nothing charged, ONE 'nothing to pay' DM; February has none either: no second DM", async ({ request }) => {
  await cron(request, "2027-02-01T10:00:00Z");
  await cron(request, "2027-02-01T11:00:00Z");
  const jan = (await months()).find((m) => m.index === 2)!;
  expect(jan).toMatchObject({ status: "no-games", amountPence: null, stripeInvoiceId: null });
  await cron(request, "2027-03-01T10:00:00Z");
  const feb = (await months()).find((m) => m.index === 3)!;
  expect(feb).toMatchObject({ status: "no-games" });
  expect(clubInvoices()).toHaveLength(1);
  const free = (await billingDms()).filter((d) => d.refId.includes(":month-free:"));
  expect(free.map((d) => d.refId)).toEqual([`${ORG}:month-free:${jan.id}`]);
  expect(free[0].text).toBe(
    "Hi Colin Months, Month Rovers played no games between 1 Jan and 31 Jan, so there is nothing to pay for that month. MatchTime only charges for the games you play.",
  );
});
