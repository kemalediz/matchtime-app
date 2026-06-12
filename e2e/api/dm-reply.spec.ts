/**
 * /api/whatsapp/dm-reply — rating-DM opt-out keyword fast-path.
 *
 * Asserts the GOLDEN RULE: the bot only acks ("no more rating messages")
 * AFTER the Membership write actually landed, opt-out and re-opt-in both
 * flip Membership.ratingDmOptOut, and unknown senders are ignored.
 */
import { test, expect, resetDb } from "../fixtures";
import { U, ORG_ID, PHONE } from "../helpers/constants";
import { E2E } from "../helpers/env";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

let n = 0;
async function postDm(request: APIRequestContext, phone: string, body: string) {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { phone, body, waMessageId: `e2e-dm-${Date.now()}-${++n}`, authorName: null },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

interface MembershipRow {
  ratingDmOptOut: boolean;
  ratingDmOptOutAt: Date | null;
}

const membership = (db: import("../helpers/test-db").TestDb) =>
  db.one<MembershipRow>(
    `SELECT * FROM "Membership" WHERE "userId" = $1 AND "orgId" = $2`,
    [U.opt, ORG_ID],
  );

test("opt-out keyword sets ratingDmOptOut and acks only after the write", async ({ request, db }) => {
  const json = await postDm(request, PHONE.opt, "stop messaging me about ratings please");
  expect(json.handled).toBe("rating-dm-opt-out");
  expect(json.optOut).toBe(true);

  const mem = await membership(db);
  expect(mem?.ratingDmOptOut).toBe(true);
  expect(mem?.ratingDmOptOutAt).not.toBeNull();

  // Confirmation DM was queued (BotJob row — the Pi is not in the loop).
  const ack = await db.one<{ text: string }>(
    `SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2 ORDER BY "createdAt" DESC LIMIT 1`,
    [ORG_ID, PHONE.opt.replace(/^\+/, "")],
  );
  expect(ack?.text).toContain("no more rating");
});

test("re-opt-in clears the flag", async ({ request, db }) => {
  const json = await postDm(request, PHONE.opt, "start ratings again please");
  expect(json.handled).toBe("rating-dm-opt-out");
  expect(json.optOut).toBe(false);

  const mem = await membership(db);
  expect(mem?.ratingDmOptOut).toBe(false);
  expect(mem?.ratingDmOptOutAt).toBeNull();
});

test("unknown sender is ignored — no write, no ack", async ({ request, db }) => {
  const before = await db.count(`SELECT COUNT(*) FROM "BotJob"`);
  const json = await postDm(request, "+447700900999", "stop messaging me about ratings");
  expect(json.ignored).toBe("unknown-sender");
  expect(await db.count(`SELECT COUNT(*) FROM "BotJob"`)).toBe(before);
});
