/**
 * /api/whatsapp/dm-reply: THE WEEKLY PAY LINKS WAIT OUT THE CLUB'S QUIET
 * HOURS (Kemal, 2026-10-21).
 *
 * Sutton FC (quiet hours 23:00 to 09:00) got its pay links at 08:14 London.
 * The collector's "✅" to the fee question now queues every player's link
 * with `sendAfter` = when quiet hours end, while the collector's ack goes at
 * once and says when the links go out. Outside quiet hours, or with them off,
 * nothing waits.
 *
 * The clock is pinned with `x-test-now` (MT_TEST_MODE=1). Free: no model is
 * called (the "✅" is decided by the allowlist).
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { MATCH, ORG_ID, PHONE, U, londonAt } from "../helpers/constants";
import { E2E } from "../helpers/env";

test.describe.configure({ mode: "serial" });

test.beforeEach(() => {
  resetDb();
});

let n = 0;
async function confirmFee(request: APIRequestContext, now: Date) {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY, "x-test-now": now.toISOString() },
    data: { phone: PHONE.collector, body: "✅", waMessageId: `e2e-plqh-${Date.now()}-${++n}`, authorName: null },
  });
  expect(res.status(), await res.text()).toBe(200);
  const json = await res.json();
  expect(json.handled).toBe("collector-fee");
  return json as { released?: number };
}

const digits = (p: string) => p.replace(/^\+/, "");

/** Yesterday's game waits for the collector's yes to £8. */
async function pending(db: TestDb) {
  await db.run(`UPDATE "Match" SET "feePendingConfirm" = 8, "feeSetByUserId" = $2 WHERE id = $1`, [MATCH.rate, U.collector]);
}

/** The pay links the release queued: every DM to someone other than the
 *  collector since the test began (a fresh world: nothing else is sent). */
let since = new Date(0);
test.beforeEach(() => {
  since = new Date(Date.now() - 1000);
});
const payLinks = (db: TestDb) =>
  db.all<{ phone: string; sendAfter: Date | null; text: string }>(
    `SELECT phone, "sendAfter", text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone <> $2 AND "createdAt" >= $3 ORDER BY phone`,
    [ORG_ID, digits(PHONE.collector), since],
  );

const ack = (db: TestDb) =>
  db.one<{ text: string; sendAfter: Date | null }>(
    `SELECT text, "sendAfter" FROM "BotJob" WHERE phone = $1 AND text LIKE '✅%' ORDER BY "createdAt" DESC LIMIT 1`,
    [digits(PHONE.collector)],
  );

test("08:10 London, quiet hours on: every link waits for 09:00; the ack goes now and says so", async ({ request, db }) => {
  await pending(db);
  const json = await confirmFee(request, londonAt(0, 8, 10));
  expect(json.released).toBeGreaterThan(0);
  const links = await payLinks(db);
  expect(links).toHaveLength(json.released!);
  for (const l of links) expect(l.text).toContain("£8");
  for (const l of links) expect(l.sendAfter?.toISOString()).toBe(londonAt(0, 9, 0).toISOString());
  const a = await ack(db);
  expect(a?.sendAfter).toBeNull();
  expect(a?.text).toContain("They go out at 09:00 London, when quiet hours end.");
  expect(a?.text).not.toContain("sent");
});

test("23:30 London: the links wait for 09:00 the next morning", async ({ request, db }) => {
  await pending(db);
  await confirmFee(request, londonAt(0, 23, 30));
  const links = await payLinks(db);
  expect(links.length).toBeGreaterThan(0);
  for (const l of links) expect(l.sendAfter?.toISOString()).toBe(londonAt(1, 9, 0).toISOString());
});

test("12:00 London: the links send at once and the ack says they were sent", async ({ request, db }) => {
  await pending(db);
  await confirmFee(request, londonAt(0, 12, 0));
  const links = await payLinks(db);
  expect(links.length).toBeGreaterThan(0);
  for (const l of links) expect(l.sendAfter).toBeNull();
  expect((await ack(db))?.text).toMatch(/^✅ Done, sent \d+ pay links? at \*£8\* each/);
});

test("quiet hours off: nothing waits, even at 23:30", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET "quietHoursEnabled" = false WHERE id = $1`, [ORG_ID]);
  await pending(db);
  await confirmFee(request, londonAt(0, 23, 30));
  const links = await payLinks(db);
  expect(links.length).toBeGreaterThan(0);
  for (const l of links) expect(l.sendAfter).toBeNull();
  expect((await ack(db))?.text).toMatch(/^✅ Done, sent /);
});
