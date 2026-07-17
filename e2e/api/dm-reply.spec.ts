/**
 * /api/whatsapp/dm-reply — DM subscription-preference keyword fast-path.
 *
 * Asserts the GOLDEN RULE: the bot only acks AFTER the Membership write
 * actually landed. Covers the narrow ratings-only opt-out (flips
 * subRatingDm), the BROAD all-but-payment opt-out (flips every sub* flag
 * false while payment stays sendable), opt-in, and unknown-sender ignore.
 *
 * (Supersedes the old single ratingDmOptOut toggle — see
 * src/lib/dm-subscriptions.ts.)
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
  subMatchInviteDm: boolean;
  subBenchOfferDm: boolean;
  subTentativeDm: boolean;
  subRatingDm: boolean;
  subReminderDm: boolean;
  subPrefsUpdatedAt: Date | null;
}

const membership = (db: import("../helpers/test-db").TestDb) =>
  db.one<MembershipRow>(
    `SELECT * FROM "Membership" WHERE "userId" = $1 AND "orgId" = $2`,
    [U.opt, ORG_ID],
  );

test("ratings-only opt-out flips subRatingDm and acks only after the write", async ({ request, db }) => {
  const json = await postDm(request, PHONE.opt, "stop messaging me about ratings please");
  expect(json.handled).toBe("dm-subscription");
  expect(json.cmd).toBe("opt-out-ratings");

  const mem = await membership(db);
  expect(mem?.subRatingDm).toBe(false);
  // Only ratings touched — other categories remain subscribed.
  expect(mem?.subMatchInviteDm).toBe(true);
  expect(mem?.subReminderDm).toBe(true);
  expect(mem?.subPrefsUpdatedAt).not.toBeNull();

  const ack = await db.one<{ text: string }>(
    `SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2 ORDER BY "createdAt" DESC LIMIT 1`,
    [ORG_ID, PHONE.opt.replace(/^\+/, "")],
  );
  expect(ack?.text).toContain("no more rating");
});

test("broad 'only payment' opt-out flips EVERY sub flag false", async ({ request, db }) => {
  const json = await postDm(request, PHONE.opt, "do not message me on any topic but payment");
  expect(json.handled).toBe("dm-subscription");
  expect(json.cmd).toBe("opt-out-all");

  const mem = await membership(db);
  expect(mem?.subMatchInviteDm).toBe(false);
  expect(mem?.subBenchOfferDm).toBe(false);
  expect(mem?.subTentativeDm).toBe(false);
  expect(mem?.subRatingDm).toBe(false);
  expect(mem?.subReminderDm).toBe(false);

  const ack = await db.one<{ text: string }>(
    `SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2 ORDER BY "createdAt" DESC LIMIT 1`,
    [ORG_ID, PHONE.opt.replace(/^\+/, "")],
  );
  expect(ack?.text.toLowerCase()).toContain("payment");
});

test("'start messages' re-subscribes to everything", async ({ request, db }) => {
  const json = await postDm(request, PHONE.opt, "start messages");
  expect(json.handled).toBe("dm-subscription");
  expect(json.cmd).toBe("opt-in-all");

  const mem = await membership(db);
  expect(mem?.subMatchInviteDm).toBe(true);
  expect(mem?.subBenchOfferDm).toBe(true);
  expect(mem?.subTentativeDm).toBe(true);
  expect(mem?.subRatingDm).toBe(true);
  expect(mem?.subReminderDm).toBe(true);
});

test("unknown sender is ignored — no write, no ack", async ({ request, db }) => {
  const before = await db.count(`SELECT COUNT(*) FROM "BotJob"`);
  const json = await postDm(request, "+447700900999", "stop messaging me about ratings");
  expect(json.ignored).toBe("unknown-sender");
  expect(await db.count(`SELECT COUNT(*) FROM "BotJob"`)).toBe(before);
});
