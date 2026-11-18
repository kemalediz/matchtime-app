/**
 * A REMINDER DM ASKED FOR IN A MESSAGE, THEN THE MESSAGE IS DELETED
 * (2026-11-16, PR #606), end to end through the real routes on a real
 * database: the reminder is queued, claimed by /api/whatsapp/due-posts
 * (which writes its `botjob-<id>` claim row WITH the DM's words), acked by
 * the Pi, and then the asking message is deleted for everyone. No words of
 * the DM are left in any table, and a later reply quoting the DM is shown
 * none of them. Also: a reminder claimed but never acked is cancelled with
 * its claim row blanked. Stubbed models only, $0. Made-up words.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { ORG_ID, PHONE, londonAt } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { clearPaymentClaimStub, stubCalls } from "../helpers/stub";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const SECRET = "the gate code is 4321";
const digits = (p: string) => p.replace(/^\+/, "");
const PLAYER = digits(PHONE.player);
let n = 0;

test.beforeEach(() => {
  resetDb();
  clearPaymentClaimStub();
});
test.afterAll(() => clearPaymentClaimStub());

async function queueReminder(db: TestDb, bare: string): Promise<string> {
  const id = `e2e-mcr-job-${++n}-${Date.now()}`;
  await db.run(
    `INSERT INTO "BotJob" (id, "orgId", kind, phone, text, "aboutKey", "createdAt") VALUES ($1, $2, 'dm', $3, $4, $5, now())`,
    [id, ORG_ID, PLAYER, `⏰ Reminder: ${SECRET}`, `asked-reminder:false_${E2E.GROUP_ID}_${bare}_${PLAYER}@c.us`],
  );
  return id;
}

async function claim(request: APIRequestContext, jobId: string) {
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`, {
    headers: { ...KEY, "x-test-now": londonAt(0, 12, 0).toISOString() },
  });
  expect(res.status(), await res.text()).toBe(200);
  const instrs = ((await res.json()).instructions ?? []) as Array<{ key: string; kind: string }>;
  const job = instrs.find((i) => i.key === `botjob-${jobId}`);
  expect(job, `the reminder is dispatched: ${JSON.stringify(instrs.map((i) => i.key))}`).toBeTruthy();
  return job!;
}

async function revoke(request: APIRequestContext, bare: string) {
  const res = await request.post("/api/whatsapp/message-change", {
    headers: KEY,
    data: { kind: "revoke", chatId: E2E.GROUP_ID, messageId: bare, byAdmin: false, senderJids: [`${PLAYER}@c.us`], senderPhone: PLAYER },
  });
  expect(res.status(), await res.text()).toBe(200);
}

const wordsAnywhere = async (db: TestDb) =>
  (await db.count(`SELECT count(*)::int AS c FROM "BotJob" WHERE text LIKE $1`, [`%4321%`])) +
  (await db.count(`SELECT count(*)::int AS c FROM "SentNotification" WHERE text LIKE $1`, [`%4321%`]));

test("sent: due-posts claims it, the Pi acks it, the message is deleted: no words in any table, and a reply quoting the DM is shown none", async ({ request, db }) => {
  const bare = `3EB0MCR${Date.now().toString(16).toUpperCase()}A`;
  const jobId = await queueReminder(db, bare);
  const job = await claim(request, jobId);
  expect(await db.one(`SELECT text FROM "SentNotification" WHERE key = $1`, [job.key])).toEqual({ text: `⏰ Reminder: ${SECRET}` });
  const stanza = `3EB0MCRSTANZA${++n}`;
  const ack = await request.post("/api/whatsapp/ack", { headers: KEY, data: { key: job.key, kind: job.kind, waMessageId: `true_${PLAYER}@c.us_${stanza}` } });
  expect(ack.status(), await ack.text()).toBe(200);
  expect(await db.one(`SELECT "sentAt" IS NOT NULL AS sent FROM "BotJob" WHERE id = $1`, [jobId])).toEqual({ sent: true });

  await revoke(request, bare);
  expect(await db.one(`SELECT text FROM "BotJob" WHERE id = $1`, [jobId])).toEqual({ text: "" });
  expect(await db.one(`SELECT text FROM "SentNotification" WHERE key = $1`, [job.key])).toEqual({ text: null });
  expect(await wordsAnywhere(db)).toBe(0);

  // The member replies to the DM (the Pi still has its own copy of the quoted words).
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: KEY,
    data: { phone: PLAYER, body: "thanks", waMessageId: `e2e-mcr-dm-${++n}`, authorName: null, quotedMessageId: stanza, quotedText: `⏰ Reminder: ${SECRET}`, quotedFromMatchTime: true },
  });
  expect(res.status(), await res.text()).toBe(200);
  const shown = stubCalls(E2E.PAYMENT_CLAIM_STUB_FILE).map((c) => c.user);
  // The DM classifier was asked, shown the reply's quote: MatchTime's DM, with no words.
  expect(shown.length).toBeGreaterThan(0);
  expect(shown.join("\n")).toContain("THEY ARE REPLYING TO MatchTime's message");
  expect(JSON.stringify(shown)).not.toContain("4321");
  expect(await wordsAnywhere(db)).toBe(0);
});

test("claimed but never acked: the reminder is cancelled, and its orphaned claim row has no words", async ({ request, db }) => {
  const bare = `3EB0MCR${Date.now().toString(16).toUpperCase()}B`;
  const jobId = await queueReminder(db, bare);
  const job = await claim(request, jobId);
  await revoke(request, bare);
  expect(await db.count(`SELECT count(*)::int AS c FROM "BotJob" WHERE id = $1`, [jobId])).toBe(0);
  expect(await db.one(`SELECT text FROM "SentNotification" WHERE key = $1`, [job.key])).toEqual({ text: null });
  expect(await wordsAnywhere(db)).toBe(0);
});
