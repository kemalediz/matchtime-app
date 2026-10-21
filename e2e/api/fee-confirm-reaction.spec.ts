/**
 * /api/whatsapp/reaction: a ✅ or 👍 REACTION on the money collector's fee
 * confirm prompt is his "yes" (Sutton FC, 2026-10-21: Kemal reacted ✅,
 * the route answered "no-open-offer", and the pay links never went out).
 *
 * End to end against the real routes and the real DB: the collector types
 * an amount (dm-reply queues the prompt BotJob with its aboutKey), the
 * prompt is dispatched and acked the way production does it (the
 * `botjob-<id>` claim row with the serialised id), and he reacts.
 *
 * Free: no model is called.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { ORG_ID, PHONE } from "../helpers/constants";
import { E2E } from "../helpers/env";

test.describe.configure({ mode: "serial" });

test.beforeEach(() => {
  resetDb();
});

const digits = (p: string) => p.replace(/^\+/, "");
let n = 0;

async function postDm(request: APIRequestContext, phone: string, body: string) {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { phone, body, waMessageId: `e2e-fcr-${Date.now()}-${++n}`, authorName: null },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function react(request: APIRequestContext, body: { waMessageId: string; emoji: string; fromPhone: string }) {
  const res = await request.post("/api/whatsapp/reaction", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { ...body, fromAuthorName: null },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

/** The collector types an amount; the newest confirm prompt is dispatched
 *  and acked like production. Returns the id a reaction on it carries. */
async function promptSent(request: APIRequestContext, db: TestDb, amount: string): Promise<{ wa: string; matchId: string }> {
  const json = await postDm(request, PHONE.collector, amount);
  expect(json.handled).toBe("collector-fee");
  const job = await db.one<{ id: string; matchId: string }>(
    `SELECT id, "matchId" FROM "BotJob" WHERE "orgId" = $1 AND "aboutKey" LIKE '%:fee-confirm' ORDER BY "createdAt" DESC LIMIT 1`,
    [ORG_ID],
  );
  expect(job).toBeTruthy();
  const stanza = `3EB0FCR${++n}${Date.now()}`;
  const wa = `true_${digits(PHONE.collector)}@c.us_${stanza}`;
  await db.run(`UPDATE "BotJob" SET "sentAt" = now() WHERE id = $1`, [job!.id]);
  await db.run(
    `INSERT INTO "SentNotification" (id, key, kind, "waMessageId", "waStanzaId", "createdAt") VALUES ($1, $2, 'dm', $3, $4, now())`,
    [`sn-fcr-${stanza}`, `botjob-${job!.id}`, wa, stanza],
  );
  return { wa, matchId: job!.matchId };
}

const matchState = (db: TestDb, id: string) =>
  db.one<{ paymentLinksReleasedAt: Date | null; feePendingConfirm: number | null; feePerPlayer: number | null }>(
    `SELECT "paymentLinksReleasedAt", "feePendingConfirm", "feePerPlayer" FROM "Match" WHERE id = $1`,
    [id],
  );

const acks = (db: TestDb) =>
  db.all<{ text: string }>(
    `SELECT text FROM "BotJob" WHERE "orgId" = $1 AND phone = $2 AND text LIKE '%pay link%' AND "aboutKey" IS NULL ORDER BY "createdAt"`,
    [ORG_ID, digits(PHONE.collector)],
  );

test("✅ on the latest prompt releases the links once and acks like a typed yes; a second ✅ does nothing", async ({ request, db }) => {
  const { wa, matchId } = await promptSent(request, db, "£8 each");
  expect((await matchState(db, matchId))?.feePendingConfirm).toBe(8);

  const json = await react(request, { waMessageId: wa, emoji: "✅", fromPhone: digits(PHONE.collector) });
  expect(json.handled, JSON.stringify(json)).toBe("fee-confirm-reaction");
  const after = await matchState(db, matchId);
  expect(after?.paymentLinksReleasedAt).not.toBeNull();
  expect(after?.feePendingConfirm).toBeNull();
  expect(after?.feePerPlayer).toBe(8);
  const ack = await acks(db);
  expect(ack).toHaveLength(1);
  // "sent ..." by day, "... ready. They go out at 09:00 London" inside the
  // club's quiet hours (2026-10-21): this spec runs on the real clock.
  expect(ack[0].text).toMatch(/^✅ Done, (sent \d+ pay links? |\d+ pay links? .* (is|are) ready\. (It goes|They go) out at \d\d:\d\d London)/);

  const again = await react(request, { waMessageId: wa, emoji: "👍", fromPhone: digits(PHONE.collector) });
  expect(again.ignored).toBe("nothing-pending");
  expect(await acks(db)).toHaveLength(1);
});

test("❤️ does nothing, and a reaction on a superseded prompt does nothing", async ({ request, db }) => {
  const first = await promptSent(request, db, "£8 each");
  expect((await react(request, { waMessageId: first.wa, emoji: "❤️", fromPhone: digits(PHONE.collector) })).ignored).toBe("not-yes");

  const second = await promptSent(request, db, "£9 each");
  expect(second.matchId).toBe(first.matchId);
  expect((await react(request, { waMessageId: first.wa, emoji: "✅", fromPhone: digits(PHONE.collector) })).ignored).toBe(
    "superseded-prompt",
  );
  const st = await matchState(db, first.matchId);
  expect(st?.paymentLinksReleasedAt).toBeNull();
  expect(st?.feePendingConfirm).toBe(9);

  // The latest prompt still works, at the latest amount.
  expect((await react(request, { waMessageId: second.wa, emoji: "👍🏽", fromPhone: digits(PHONE.collector) })).handled).toBe(
    "fee-confirm-reaction",
  );
  expect((await matchState(db, first.matchId))?.feePerPlayer).toBe(9);
});

test("somebody other than the collector reacting does nothing", async ({ request, db }) => {
  const { wa, matchId } = await promptSent(request, db, "£8 each");
  const other = digits(PHONE[Object.keys(PHONE).find((k) => k !== "collector") as keyof typeof PHONE]);
  expect((await react(request, { waMessageId: wa, emoji: "✅", fromPhone: other })).ignored).toBe("reactor-not-the-recipient");
  expect((await matchState(db, matchId))?.paymentLinksReleasedAt).toBeNull();
});
