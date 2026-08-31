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
import { U, ORG_ID, PHONE, MATCH } from "../helpers/constants";
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

// ── COLD self-attendance fallback (2026-08-31) ─────────────────────────
//   A player replying "IN" / "OUT" to a recruit DM, with no pending prompt
//   to attribute it to, must be registered against the SAME match the group
//   path would choose — and the group must be told, because an out-of-band
//   registration is invisible to everybody else.
//
//   These bodies all hit the free regex FAST-PATH, so they are
//   deterministic under the normal e2e env (ANTHROPIC_API_KEY is blank, so
//   the LLM layer returns "unclear"). The MODEL's behaviour on natural
//   wording is validated separately against the real model in
//   e2e/sim/dm-self-attendance-live.spec.ts.

const attendance = (db: import("../helpers/test-db").TestDb, userId: string) =>
  db.one<{ status: string; position: number }>(
    `SELECT status, position FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.upcoming, userId],
  );

const groupPostsLike = (db: import("../helpers/test-db").TestDb, needle: string) =>
  db.count(
    `SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1 AND kind = 'group' AND text LIKE $2`,
    [ORG_ID, `%${needle}%`],
  );

test("a cold 'IN' DM registers against the next match and tells the group", async ({ request, db }) => {
  const json = await postDm(request, PHONE.fresh, "IN");
  expect(json.handled).toBe("dm-self-attendance");
  expect(json.decision).toBe("in");
  expect(json.via).toBe("fast-path");
  expect(json.matchId).toBe(MATCH.upcoming);
  expect(json.status).toBe("CONFIRMED");

  // Registered on the upcoming match (4 confirmed seeded + this one = 5/5).
  const att = await attendance(db, U.fresh);
  expect(att?.status).toBe("CONFIRMED");

  // Personal confirmation DM back to the player.
  const ack = await db.one<{ text: string }>(
    `SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2 ORDER BY "createdAt" DESC LIMIT 1`,
    [ORG_ID, PHONE.fresh.replace(/^\+/, "")],
  );
  expect(ack?.text).toContain("You're in for");

  // Group announcement, with the count computed AFTER the write.
  expect(await groupPostsLike(db, "*Ian Innes* is IN (replied by DM). Squad *5/5*.")).toBe(1);
});

test("a repeat 'IN' is idempotent and does NOT announce again", async ({ request, db }) => {
  const before = await attendance(db, U.fresh);
  const beforeGroup = await db.count(
    `SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1 AND kind = 'group'`,
    [ORG_ID],
  );

  const json = await postDm(request, PHONE.fresh, "i'm in");
  expect(json.handled).toBe("dm-self-attendance");
  expect(json.status).toBe("CONFIRMED");

  // Same row, same slot — no duplicate, no reshuffle.
  const after = await attendance(db, U.fresh);
  expect(after?.status).toBe(before?.status);
  expect(after?.position).toBe(before?.position);
  expect(
    await db.count(
      `SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
      [MATCH.upcoming, U.fresh],
    ),
  ).toBe(1);

  // Nothing changed, so the group hears nothing.
  expect(
    await db.count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1 AND kind = 'group'`, [ORG_ID]),
  ).toBe(beforeGroup);
});

test("a cold 'IN' on a FULL squad goes to the bench, exactly like the group path", async ({ request, db }) => {
  const json = await postDm(request, PHONE.extra, "count me in");
  expect(json.handled).toBe("dm-self-attendance");
  expect(json.status).toBe("BENCH");

  const att = await attendance(db, U.extra);
  expect(att?.status).toBe("BENCH");

  const ack = await db.one<{ text: string }>(
    `SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2 ORDER BY "createdAt" DESC LIMIT 1`,
    [ORG_ID, PHONE.extra.replace(/^\+/, "")],
  );
  expect(ack?.text).toContain("bench");

  expect(
    await groupPostsLike(db, "*Zara Zest* replied IN by DM and goes to the bench. Squad *5/5*."),
  ).toBe(1);
});

test("an ambiguous DM is NOT guessed at — no write, no announcement", async ({ request, db }) => {
  const beforeGroup = await db.count(
    `SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1 AND kind = 'group'`,
    [ORG_ID],
  );
  const json = await postDm(request, PHONE.rater, "cheers mate");
  expect(json.handled).not.toBe("dm-self-attendance");

  expect(await attendance(db, U.rater)).toBeNull();
  expect(
    await db.count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1 AND kind = 'group'`, [ORG_ID]),
  ).toBe(beforeGroup);
});

test("a cold 'OUT' DM drops the player and tells the group", async ({ request, db }) => {
  const json = await postDm(request, PHONE.player, "out");
  expect(json.handled).toBe("dm-self-attendance");
  expect(json.decision).toBe("out");
  expect(json.status).toBe("DROPPED");

  const att = await attendance(db, U.player);
  expect(att?.status).toBe("DROPPED");

  expect(await groupPostsLike(db, "*Pat Player* is OUT (replied by DM). Squad *4/5*.")).toBe(1);
});
