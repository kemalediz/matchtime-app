/**
 * Conversational replies before bulk sends (FNF, 2026-10-16), END TO END.
 *
 * The real night: the fee release queued 16 pay-link DMs at 22:39; at
 * 22:46 Akram DMed "I've transferred already" and his reply and the
 * collector's notice waited ~10 minutes behind the pay links, because the
 * Pi sends the FIRST DM in the due-posts list once a minute.
 *
 * Here: 16 pay-link BotJobs are queued, then a player DMs "Paid" through
 * the real dm-reply route (the model stubbed, `paid-claim-dm.spec.ts`'s
 * seam). The reply and the collector notice are written with priority 1.
 * Then due-posts is read with the flag OFF (the env default in the suite)
 * and ON (the MT_TEST_MODE header seam, src/lib/dm-reply-priority.ts).
 *
 * The pure order rules are in src/lib/__tests__/dm-reply-priority*.test.ts,
 * the Pi's order and pacing in whatsapp-bot/src/scheduler.dm-order.test.ts.
 *
 * THE CLOCK (2026-10-25). The spec runs near the real time, but every
 * due-posts poll in a group is pinned with `x-test-now` to ONE instant,
 * `NOW`, taken when that group's setup starts, and every row the spec
 * writes is timed in JS from `NOW` (never SQL now(): the test cluster runs
 * in Europe/London, so a bare now() reads back an hour ahead in BST). The
 * twenty "spent" DMs used to be stamped "one minute ago"; in the first
 * minute after London midnight that is yesterday, the new-club cap
 * (counted from London midnight) saw none spent, and both cap groups
 * failed. They are now stamped no earlier than NOW's London midnight, and
 * the polls of a group cannot straddle midnight or the start of a
 * scheduled-post window, because they all read the same pinned instant.
 */
import { test, expect, resetDb } from "../fixtures";
import { ORG_ID, PHONE } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { setPaymentClaimStub, clearPaymentClaimStub } from "../helpers/stub";
import { DM_REPLY_PRIORITY_TEST_HEADER } from "@/lib/dm-reply-priority";
import { londonMidnight } from "@/lib/club-connect-rules";
import type { APIRequestContext } from "@playwright/test";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

interface Instruction {
  kind: string;
  key: string;
  phone?: string;
  text?: string;
}

const bare = (p: string) => p.replace(/^\+/, "");
const PAY_PHONES = Array.from({ length: 16 }, (_, i) => `4477009991${String(i).padStart(2, "0")}`);

/** The one instant a group's polls read; set when its setup starts. */
let NOW = new Date();

async function duePosts(
  request: APIRequestContext,
  opts: { flag?: "1" | "0"; claim?: boolean } = {},
): Promise<Instruction[]> {
  const headers: Record<string, string> = { "x-api-key": E2E.WHATSAPP_API_KEY, "x-test-now": NOW.toISOString() };
  if (!opts.claim) headers["x-no-claim"] = "1";
  if (opts.flag) headers[DM_REPLY_PRIORITY_TEST_HEADER] = opts.flag;
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`, { headers });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()).instructions ?? []) as Instruction[];
}

async function postDm(request: APIRequestContext, phone: string, body: string) {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { phone, body, waMessageId: `e2e-prio-${Date.now()}`, authorName: null },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

/** The fee release: 16 pay links, queued seven minutes before NOW, oldest
 *  first. "createdAt" is a timestamp WITHOUT time zone holding UTC, so it is
 *  written from JS (test-db.ts stores a Date as its UTC wall time). */
async function queuePayLinks(db: TestDb): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < PAY_PHONES.length; i++) {
    const id = `e2e-prio-pay-${String(i).padStart(2, "0")}`;
    await db.run(
      `INSERT INTO "BotJob" (id, "orgId", kind, phone, text, "createdAt")
       VALUES ($1, $2, 'dm', $3, $4, $5)`,
      [id, ORG_ID, PAY_PHONES[i], `Pay link ${i}`, new Date(NOW.getTime() - 7 * 60_000 + i)],
    );
    ids.push(`botjob-${id}`);
  }
  return ids;
}

const dms = (list: Instruction[]) => list.filter((i) => i.kind === "dm");

test.beforeAll(() => resetDb());
test.afterAll(() => clearPaymentClaimStub());

let payKeys: string[] = [];
let replyKey = "";
let noticeKey = "";

test("a 'Paid' after a fee release: the reply and the collector notice are marked, the pay links are not", async ({
  request,
  db,
}) => {
  // Quiet hours off: this spec is about send ORDER and runs on the real
  // clock; inside quiet hours the collector's notice waits for them to end
  // (2026-10-21), which pay-links-quiet-hours.spec.ts and the unit tests pin.
  NOW = new Date();
  await db.run(`UPDATE "Organisation" SET "quietHoursEnabled" = false WHERE id = $1`, [ORG_ID]);
  payKeys = await queuePayLinks(db);
  setPaymentClaimStub({ bodies: { "I've transferred already": "paid" } });
  const json = await postDm(request, PHONE.player, "I've transferred already");
  expect(json.handled).toBe("paid-claim");

  const rows = await db.all<{ id: string; phone: string; priority: number; text: string }>(
    `SELECT id, phone, priority, text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND "sentAt" IS NULL ORDER BY "createdAt" ASC`,
    [ORG_ID],
  );
  const reply = rows.find((r) => r.phone === bare(PHONE.player) && r.text.startsWith("Thanks Pat"));
  const notice = rows.find((r) => r.phone === bare(PHONE.collector) && r.text.includes("paid you directly"));
  expect(reply?.priority).toBe(1);
  expect(notice?.priority).toBe(1);
  for (const r of rows.filter((r) => r.id.startsWith("e2e-prio-pay-"))) expect(r.priority).toBe(0);
  replyKey = `botjob-${reply!.id}`;
  noticeKey = `botjob-${notice!.id}`;
});

test("flag OFF: today's order, the reply waits behind all 16 pay links; the header '0' changes nothing", async ({
  request,
}) => {
  const plain = dms(await duePosts(request));
  const off = dms(await duePosts(request, { flag: "0" }));
  expect(off.map((i) => i.key)).toEqual(plain.map((i) => i.key));

  const keys = plain.map((i) => i.key);
  const lastPay = Math.max(...payKeys.map((k) => keys.indexOf(k)));
  expect(payKeys.every((k) => keys.includes(k))).toBe(true);
  expect(keys.indexOf(replyKey)).toBeGreaterThan(lastPay);
  expect(keys.indexOf(noticeKey)).toBeGreaterThan(lastPay);
});

test("flag ON: the reply and the collector notice go before every pay link; nothing added or dropped", async ({
  request,
}) => {
  const off = await duePosts(request, { flag: "0" });
  const on = await duePosts(request, { flag: "1" });

  // The same instructions, only the DMs reordered among themselves.
  expect([...on.map((i) => i.key)].sort()).toEqual([...off.map((i) => i.key)].sort());
  expect(on.map((i) => i.kind)).toEqual(off.map((i) => i.kind));
  const onNonDm = on.filter((i) => i.kind !== "dm").map((i) => i.key);
  const offNonDm = off.filter((i) => i.kind !== "dm").map((i) => i.key);
  expect(onNonDm).toEqual(offNonDm);

  const keys = dms(on).map((i) => i.key);
  const firstPay = Math.min(...payKeys.map((k) => keys.indexOf(k)));
  expect(keys.indexOf(replyKey)).toBeLessThan(firstPay);
  expect(keys.indexOf(noticeKey)).toBeLessThan(firstPay);
  // The pay links keep their own order.
  expect(keys.filter((k) => payKeys.includes(k))).toEqual(payKeys);

  // Per recipient: every DM to the player or the collector keeps its
  // relative order from the flag-off list.
  for (const phone of [bare(PHONE.player), bare(PHONE.collector)]) {
    const offOrder = dms(off).filter((i) => i.phone === phone).map((i) => i.key);
    const onOrder = dms(on).filter((i) => i.phone === phone).map((i) => i.key);
    expect(onOrder).toEqual(offOrder);
  }
});

test("flag ON, claimed poll (what the Pi gets): the first DM it is handed is a reply, not a pay link", async ({
  request,
}) => {
  const claimed = dms(await duePosts(request, { flag: "1", claim: true }));
  expect(claimed.length).toBeGreaterThan(0);
  expect(payKeys).not.toContain(claimed[0].key);
  const firstPay = Math.min(...payKeys.map((k) => claimed.map((i) => i.key).indexOf(k)));
  expect(claimed.findIndex((i) => i.key === replyKey)).toBeLessThan(firstPay);
});

// ── The new-club DM cap (follow-up, same night) ────────────────────────
// FNF is a new self-join club: at most 20 member DMs a London day for its
// first 28 days (`newClubDmCap`). The pay links and earlier DMs spent the
// 20, so the reply and the collector notice were held until midnight.
// Flag on: replies are never held by the cap and do not count toward it;
// bulk DMs stay held. Flag off: held, as today.

/**
 * Quiet hours off for a setup that resets the database. `resetDb()` turns
 * the seeded club's quiet hours back on, and inside them (23:00 to 09:00
 * London) the collector's notice is held until they end (2026-10-21), so on
 * the real clock these tests failed overnight. This spec is about send
 * ORDER and the new-club cap, not quiet hours, which
 * pay-links-quiet-hours.spec.ts and the unit tests pin. The same fix as the
 * first test above, and as #366 made in monthly-week.spec.ts.
 */
async function quietHoursOff(db: TestDb): Promise<void> {
  await db.run(`UPDATE "Organisation" SET "quietHoursEnabled" = false WHERE id = $1`, [ORG_ID]);
}

/** Make the seeded club a new self-join club with `spent` DMs claimed
 *  today. "Today" is NOW's London day: the cap counts from NOW's London
 *  midnight, so a DM stamped "a minute ago" just after midnight would be
 *  yesterday's and the cap would never be reached. */
async function newClubWithSpent(db: TestDb, spent: number): Promise<void> {
  const twoDaysAgo = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);
  await db.run(`UPDATE "Organisation" SET "approvedAt" = $2, "liveAt" = $2 WHERE id = $1`, [ORG_ID, twoDaysAgo]);
  const claimedAt = new Date(Math.max(NOW.getTime() - 60_000, londonMidnight(NOW).getTime()));
  for (let i = 0; i < spent; i++) {
    const id = `e2e-cap-sent-${String(i).padStart(2, "0")}`;
    await db.run(
      `INSERT INTO "BotJob" (id, "orgId", kind, phone, text, "sentAt", "createdAt")
       VALUES ($1, $2, 'dm', $3, 'earlier DM', $4, $4)`,
      [id, ORG_ID, `4477009992${String(i).padStart(2, "0")}`, claimedAt],
    );
    await db.run(`INSERT INTO "SentNotification" (id, key, kind, "createdAt") VALUES ($1, $2, 'dm', $3)`, [
      `e2e-cap-sn-${i}`,
      `botjob-${id}`,
      claimedAt,
    ]);
  }
}

/** A "Paid" from the player; returns the reply's and the notice's keys. */
async function paidClaim(request: APIRequestContext, db: TestDb): Promise<{ reply: string; notice: string }> {
  setPaymentClaimStub({ bodies: { "I've transferred already": "paid" } });
  expect((await postDm(request, PHONE.player, "I've transferred already")).handled).toBe("paid-claim");
  const rows = await db.all<{ id: string; phone: string }>(
    `SELECT id, phone FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND "sentAt" IS NULL AND priority = 1`,
    [ORG_ID],
  );
  return {
    reply: `botjob-${rows.find((r) => r.phone === bare(PHONE.player))!.id}`,
    notice: `botjob-${rows.find((r) => r.phone === bare(PHONE.collector))!.id}`,
  };
}

async function release(request: APIRequestContext, key: string) {
  const res = await request.post("/api/whatsapp/ack", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { key, kind: "dm", release: true },
  });
  expect(res.status(), await res.text()).toBe(200);
}

test.describe("the new-club DM cap, reached (20 spent)", () => {
  let capPay: string[] = [];
  let k = { reply: "", notice: "" };

  test("setup: a new club whose 20 DMs for today are spent, 16 pay links waiting, then a 'Paid'", async ({
    request,
    db,
  }) => {
    resetDb();
    NOW = new Date();
    await quietHoursOff(db);
    await newClubWithSpent(db, 20);
    capPay = await queuePayLinks(db);
    k = await paidClaim(request, db);
  });

  test("flag OFF: the reply and the notice are HELD with the pay links (today)", async ({ request }) => {
    const sent = dms(await duePosts(request, { flag: "0", claim: true })).map((i) => i.key);
    expect(sent).toEqual([]);
  });

  test("flag ON: the reply and the notice still go; every bulk DM stays held", async ({ request }) => {
    const sent = dms(await duePosts(request, { flag: "1", claim: true })).map((i) => i.key);
    expect([...sent].sort()).toEqual([k.reply, k.notice].sort());
    expect(sent.filter((x) => capPay.includes(x))).toEqual([]);
  });
});

test.describe("the new-club DM cap: replies do not count toward it (19 spent)", () => {
  let capPay: string[] = [];
  let k = { reply: "", notice: "" };

  test("setup: 19 of 20 spent, 16 pay links, then a 'Paid'", async ({ request, db }) => {
    resetDb();
    NOW = new Date();
    await quietHoursOff(db);
    await newClubWithSpent(db, 19);
    capPay = await queuePayLinks(db);
    k = await paidClaim(request, db);
  });

  // The one DM the allowance has left: the first bulk DM in the list (a pay
  // link, or a DM the seeded world's scheduler emits).
  let bulk = "";

  test("flag ON: both replies plus exactly ONE bulk DM (the one left in the allowance)", async ({ request }) => {
    const sent = dms(await duePosts(request, { flag: "1", claim: true })).map((i) => i.key);
    expect(sent).toContain(k.reply);
    expect(sent).toContain(k.notice);
    const others = sent.filter((x) => x !== k.reply && x !== k.notice);
    expect(others).toHaveLength(1);
    bulk = others[0];
    // The Pi's pacing releases the bulk DM (it sends the reply first).
    await release(request, bulk);
  });

  test("flag ON, next poll: the two claimed replies did not use the allowance, so one bulk DM goes again", async ({
    request,
  }) => {
    const sent = dms(await duePosts(request, { flag: "1", claim: true })).map((i) => i.key);
    expect(sent).toEqual([bulk]);
    expect(capPay.filter((x) => sent.includes(x)).length).toBeLessThanOrEqual(1);
  });

  test("flag OFF, same state: the replies DO count (today), so every bulk DM is held", async ({ request }) => {
    await release(request, bulk);
    const sent = dms(await duePosts(request, { flag: "0", claim: true })).map((i) => i.key);
    expect(sent).toEqual([]);
  });
});
