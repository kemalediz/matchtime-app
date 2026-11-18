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
 * The clock is pinned with `x-test-now` (MT_TEST_MODE=1). Free: the "✅" is
 * read by the fee reader, stubbed to "yes" (2026-10-30).
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { MATCH, ORG_ID, PHONE, U, londonAt } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { clearFeeReplyStub, setFeeReplyStub } from "../helpers/stub";

test.describe.configure({ mode: "serial" });

test.beforeEach(() => {
  resetDb();
  setFeeReplyStub({ bodies: { "✅": "yes" } });
});

test.afterEach(() => {
  clearFeeReplyStub();
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

// ── Send time (Sutton, 2026-11-17) ─────────────────────────────────────
// Released at 23:01 inside quiet hours; the collector marked 8 players paid
// on /collect before midnight; at 09:00 all 8 still got "tap to pay". The
// scheduler now asks again, at send time, whether each player still owes.

/** The DM phones a poll hands out. Preview (`x-no-claim`) by default; with
 *  `claim: true` a real poll, which claims what it hands out. */
async function dueDmPhones(request: APIRequestContext, now: Date, opts: { claim?: boolean } = {}): Promise<string[]> {
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`, {
    headers: {
      "x-api-key": E2E.WHATSAPP_API_KEY,
      "x-test-now": now.toISOString(),
      ...(opts.claim ? {} : { "x-no-claim": "1" }),
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  const json = (await res.json()) as { instructions?: Array<{ kind: string; phone?: string }> };
  return (json.instructions ?? []).filter((i) => i.kind === "dm" && i.phone).map((i) => i.phone!);
}

test("released at 23:30, Pat marked received before 09:00: at 09:00 Pat gets no link, Riley still does", async ({ request, db }) => {
  await pending(db);
  await confirmFee(request, londonAt(0, 23, 30));
  const links = await payLinks(db);
  expect(links.map((l) => l.phone)).toEqual(expect.arrayContaining([digits(PHONE.player), digits(PHONE.rater)]));

  // The shape `confirmDirectPayment` writes for "Mark received" on /collect.
  await db.run(
    `UPDATE "Attendance" SET "paidAt" = now(), "directPendingAt" = null, "directConfirmedByUserId" = $3
      WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.rate, U.player, U.collector],
  );

  // Before 09:00 nothing is due.
  expect(await dueDmPhones(request, londonAt(1, 8, 59))).not.toContain(digits(PHONE.rater));

  const jobsTo = (phone: string) =>
    db.count(`SELECT count(*) FROM "BotJob" WHERE phone = $1 AND "createdAt" >= $2`, [digits(phone), since]);

  // A preview poll: Pat's link is not handed out, and nothing is deleted.
  const preview = await dueDmPhones(request, londonAt(1, 9, 1));
  expect(preview).not.toContain(digits(PHONE.player));
  expect(preview).toContain(digits(PHONE.rater));
  expect(await jobsTo(PHONE.player)).toBe(1);

  // The real poll the Pi makes: Pat's unsent job is deleted, Riley's is claimed.
  const nine = await dueDmPhones(request, londonAt(1, 9, 1), { claim: true });
  expect(nine).not.toContain(digits(PHONE.player));
  expect(nine).toContain(digits(PHONE.rater));
  expect(await jobsTo(PHONE.player)).toBe(0);

  // Riley's link was handed to the Pi and is not acked yet (sentAt null).
  // He pays a minute later: the record of that real message stays.
  await db.run(`UPDATE "Attendance" SET "paidAt" = now() WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.rate, U.rater]);
  const after = await dueDmPhones(request, londonAt(1, 9, 2), { claim: true });
  expect(after).not.toContain(digits(PHONE.rater));
  expect(await jobsTo(PHONE.rater)).toBe(1);
});

test("payment collection switched off before 09:00: no pay link goes out", async ({ request, db }) => {
  await pending(db);
  await confirmFee(request, londonAt(0, 23, 30));
  const phones = (await payLinks(db)).map((l) => l.phone);
  expect(phones.length).toBeGreaterThan(0);
  await db.run(`UPDATE "Organisation" SET "paymentCollectionEnabled" = false WHERE id = $1`, [ORG_ID]);
  const nine = await dueDmPhones(request, londonAt(1, 9, 1));
  for (const p of phones) expect(nine).not.toContain(p);
});

test("a free place, a direct payment chosen, or a drop before 09:00: no link for any of them", async ({ request, db }) => {
  await pending(db);
  await confirmFee(request, londonAt(0, 23, 30));
  await db.run(
    `UPDATE "Attendance" SET "feeWaivedAt" = now(), "feeWaivedReason" = 'organiser' WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.rate, U.player],
  );
  await db.run(
    `UPDATE "Attendance" SET "directPendingAt" = now(), "paymentMethod" = 'direct' WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.rate, U.third],
  );
  await db.run(`UPDATE "Attendance" SET status = 'DROPPED' WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.rate, U.rater]);
  const nine = await dueDmPhones(request, londonAt(1, 9, 1));
  expect(nine).not.toContain(digits(PHONE.player));
  expect(nine).not.toContain(digits(PHONE.third));
  expect(nine).not.toContain(digits(PHONE.rater));
});

test("the match cancelled before 09:00: no pay link goes out", async ({ request, db }) => {
  await pending(db);
  await confirmFee(request, londonAt(0, 23, 30));
  const phones = (await payLinks(db)).map((l) => l.phone);
  expect(phones.length).toBeGreaterThan(0);
  await db.run(`UPDATE "Match" SET status = 'CANCELLED' WHERE id = $1`, [MATCH.rate]);
  const nine = await dueDmPhones(request, londonAt(1, 9, 1));
  for (const p of phones) expect(nine).not.toContain(p);
});
