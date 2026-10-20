/**
 * /api/whatsapp/dm-reply: A SWIPE-REPLY ACTS ON THE MATCH IT QUOTES, END TO
 * END (quoted-reply context S2, adversarial review of #336).
 *
 * Drives the real route through the two DM classifier stub seams
 * (`MT_TEST_PAYMENT_CLAIM_STUB_FILE`, `MT_TEST_MATCH_AVAILABILITY_STUB_FILE`),
 * which stub only what the MODEL said and record each user turn it was
 * asked about. Everything else is the shipped code: the quote resolution,
 * the chat-context load, the match each path picks, and the writes.
 *
 *   - payment: owes two matches, swipe-replies "paid" to the OLDER one's
 *     chase: the claim lands on that one, and the model is told its date;
 *   - payment: a quote naming a match he does not owe is dropped (the
 *     recent messages instead), the claim lands on the default match;
 *   - tentative follow-up: two open maybes, a reply quoting the LATER one's
 *     follow-up registers for that one;
 *   - cold DM: a reply quoting the invite chase for a later match registers
 *     for that one; a quote naming an ineligible match does not steer;
 *   - only messages actually sent are shown; a DM quoting a GROUP post is
 *     never shown as MatchTime's DM to them.
 *
 * The guest DM OUT path's use of the quote is covered with the loader
 * mocked in src/lib/__tests__/partner-guest-dm.test.ts (no partner-club
 * fixture world exists for an e2e spec).
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { ACTIVITY_ID, MATCH, ORG_ID, PHONE, U, londonAt } from "../helpers/constants";
import { E2E } from "../helpers/env";
import {
  clearMatchAvailabilityStub,
  clearPaymentClaimStub,
  setMatchAvailabilityStub,
  setPaymentClaimStub,
  stubCalls,
} from "../helpers/stub";
import { contextMatchLabel } from "../../src/lib/reply-context";

test.describe.configure({ mode: "serial" });

test.beforeEach(() => {
  resetDb();
  clearPaymentClaimStub();
  clearMatchAvailabilityStub();
});

test.afterAll(() => {
  clearPaymentClaimStub();
  clearMatchAvailabilityStub();
});

let n = 0;
async function postDm(request: APIRequestContext, phone: string, body: string, extra: Record<string, unknown> = {}) {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { phone, body, waMessageId: `e2e-qc-${Date.now()}-${++n}`, authorName: null, ...extra },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const digits = (p: string) => p.replace(/^\+/, "");

/** A scheduler DM MatchTime sent and the Pi acked: claim row with words,
 *  match, recipient and the bare stanza id a quote carries. */
async function sentSchedulerDm(
  db: TestDb,
  input: { key: string; userId: string; phone: string; matchId: string | null; text: string; minsAgo: number },
): Promise<string> {
  const stanza = `3EB0QC${++n}${Date.now()}`;
  await db.run(
    `INSERT INTO "SentNotification" (id, key, kind, "matchId", "targetUser", "waMessageId", "waStanzaId", text, "createdAt")
     VALUES ($1, $2, 'dm', $3, $4, $5, $6, $7, NOW() - ($8 || ' minutes')::interval)`,
    [`sn-${stanza}`, input.key, input.matchId, input.userId, `true_${digits(input.phone)}@s.whatsapp.net_${stanza}`, stanza, input.text, String(input.minsAgo)],
  );
  return stanza;
}

async function botJobDm(db: TestDb, input: { phone: string; text: string; minsAgo: number; sent: boolean }) {
  await db.run(
    `INSERT INTO "BotJob" (id, "orgId", kind, phone, text, "createdAt", "sentAt")
     VALUES ($1, $2, 'dm', $3, $4, NOW() - ($5 || ' minutes')::interval,
             CASE WHEN $6 THEN NOW() - ($5 || ' minutes')::interval ELSE NULL END)`,
    [`qc-job-${++n}-${Date.now()}`, ORG_ID, digits(input.phone), input.text, String(input.minsAgo), input.sent],
  );
}

async function match(db: TestDb, id: string, date: Date, over: { status?: string; fee?: boolean } = {}) {
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt",
                          "feePerPlayer", "feeSetByUserId", "feeSetAt", "paymentLinksReleasedAt")
     VALUES ($1, $2, $3, 10, $4, $5, NOW(),
             $6, $7, $8, $8)`,
    [
      id,
      ACTIVITY_ID,
      date,
      over.status ?? "UPCOMING",
      new Date(date.getTime() - 5 * 3600 * 1000),
      over.fee ? 8 : null,
      over.fee ? U.collector : null,
      over.fee ? new Date(Date.now() - 6 * 24 * 3600 * 1000) : null,
    ],
  );
}

async function attend(db: TestDb, matchId: string, userId: string, status = "CONFIRMED") {
  await db.run(
    `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "respondedAt", "updatedAt")
     VALUES ($1, $2, $3, $4, 9, NOW(), NOW())`,
    [`qc-att-${++n}-${Date.now()}`, matchId, userId, status],
  );
}

const statusOn = (db: TestDb, matchId: string, userId: string) =>
  db.one<{ status: string; directPendingAt: Date | null }>(
    `SELECT status, "directPendingAt" FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
    [matchId, userId],
  );

const turns = (label: string) =>
  stubCalls(label === "payment-claim" ? E2E.PAYMENT_CLAIM_STUB_FILE : E2E.MATCH_AVAILABILITY_STUB_FILE)
    .filter((c) => c.label === label)
    .map((c) => c.user);

// ── payment ───────────────────────────────────────────────────────────

const OLDER = "e2e-qc-pay-older";

test("payment: owes two matches, 'paid' swipe-replying to the OLDER one's chase lands on that one", async ({ request, db }) => {
  const olderDate = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  await match(db, OLDER, olderDate, { status: "COMPLETED", fee: true });
  await attend(db, OLDER, U.player);
  const stanza = await sentSchedulerDm(db, {
    key: `${OLDER}:pay-chase:${U.player}:qc`,
    userId: U.player,
    phone: PHONE.player,
    matchId: OLDER,
    text: "💷 Pat, your £8 for last week is still outstanding: https://mt.example/s/pay",
    minsAgo: 120,
  });
  // A newer DM, about something else, that a non-reply would be read against.
  await botJobDm(db, { phone: PHONE.player, text: "⭐ Rate your teammates: https://mt.example/s/rate", minsAgo: 10, sent: true });
  setPaymentClaimStub({ bodies: { paid: "paid" } });

  const json = await postDm(request, PHONE.player, "paid", { quotedMessageId: stanza, quotedText: "💷 Pat...", quotedFromMatchTime: true });
  expect(json.handled).toBe("paid-claim");
  expect(json.matchId).toBe(OLDER);
  expect((await statusOn(db, OLDER, U.player))?.directPendingAt).not.toBeNull();
  expect((await statusOn(db, MATCH.pay, U.player))?.directPendingAt).toBeNull();

  const [turn] = turns("payment-claim");
  expect(turn).toContain(`They owe: £8 for ${contextMatchLabel("E2E 5-a-side", olderDate)}`);
  expect(turn).toContain("THEY ARE REPLYING TO MatchTime's message of");
  expect(turn).toContain("still outstanding");
  expect(turn).not.toContain("Rate your teammates");
});

test("payment: a quote naming a match he does NOT owe is dropped; the default match, read against the recent messages", async ({ request, db }) => {
  const stanza = await sentSchedulerDm(db, {
    key: `${MATCH.rate}:rate-reminder:${U.player}:qc`,
    userId: U.player,
    phone: PHONE.player,
    matchId: MATCH.rate,
    text: "⭐ Rate your teammates after last night",
    minsAgo: 30,
  });
  setPaymentClaimStub({ bodies: { paid: "paid" } });
  const json = await postDm(request, PHONE.player, "paid", { quotedMessageId: stanza, quotedText: "⭐ Rate...", quotedFromMatchTime: true });
  expect(json.handled).toBe("paid-claim");
  expect(json.matchId).toBe(MATCH.pay);
  const [turn] = turns("payment-claim");
  expect(turn).not.toContain("THEY ARE REPLYING TO");
  expect(turn).toContain("MATCHTIME'S RECENT MESSAGES TO THEM (oldest first");
});

test("only messages actually sent are shown; a queued BotJob is not", async ({ request, db }) => {
  await botJobDm(db, { phone: PHONE.player, text: "QC-SENT pay link", minsAgo: 60, sent: true });
  await botJobDm(db, { phone: PHONE.player, text: "QC-QUEUED never sent", minsAgo: 5, sent: false });
  await postDm(request, PHONE.player, "hello there");
  const [turn] = turns("payment-claim");
  expect(turn).toContain("QC-SENT pay link");
  expect(turn).not.toContain("QC-QUEUED");
});

test("a DM quoting a GROUP post is never shown as MatchTime's DM to them, and never steers the match", async ({ request, db }) => {
  const stanza = `3EB0QCGROUP${Date.now()}`;
  await db.run(
    `INSERT INTO "SentNotification" (id, key, kind, "matchId", "waMessageId", "waStanzaId", text, "createdAt")
     VALUES ($1, $2, 'group-message', $3, $4, $5, $6, NOW() - interval '20 minutes')`,
    [`sn-${stanza}`, `${MATCH.upcoming}:announce-match:qc`, MATCH.upcoming, `true_${E2E.GROUP_ID}_${stanza}`, stanza, "Playing Thursday? Reply IN"],
  );
  setPaymentClaimStub({ bodies: { paid: "paid" } });
  await postDm(request, PHONE.player, "paid", { quotedMessageId: stanza, quotedText: "Playing Thursday? Reply IN", quotedFromMatchTime: true });
  const [turn] = turns("payment-claim");
  expect(turn).not.toContain("THEY ARE REPLYING TO");
  expect(turn).not.toContain("Playing Thursday");
});

// ── availability ──────────────────────────────────────────────────────

const LATER = "e2e-qc-later";

test("tentative follow-up: two open maybes, a reply quoting the LATER one's follow-up registers for that one", async ({ request, db }) => {
  await match(db, LATER, londonAt(5, 20, 0));
  for (const m of [MATCH.upcoming, LATER]) {
    await db.run(
      `INSERT INTO "TentativeAvailability" (id, "matchId", "userId", "dueAt", "notifiedAt", "updatedAt")
       VALUES ($1, $2, $3, NOW(), NOW(), NOW())`,
      [`qc-tent-${m}`, m, U.fresh],
    );
  }
  const stanza = await sentSchedulerDm(db, {
    key: `${LATER}:tentative-followup:${U.fresh}`,
    userId: U.fresh,
    phone: PHONE.fresh,
    matchId: LATER,
    text: "You were a maybe for the later game: in or out?",
    minsAgo: 30,
  });
  setMatchAvailabilityStub({ bodies: { "go on then mate": "in" } });
  const json = await postDm(request, PHONE.fresh, "go on then mate", { quotedMessageId: stanza, quotedText: "You were a maybe...", quotedFromMatchTime: true });
  expect(json.handled).toBe("tentative-followup");
  expect((await statusOn(db, LATER, U.fresh))?.status).toBe("CONFIRMED");
  expect(await statusOn(db, MATCH.upcoming, U.fresh)).toBeNull();
  const [turn] = turns("match-availability");
  expect(turn).toContain("THEY ARE REPLYING TO MatchTime's message of");
  expect(turn).toContain("in or out?");
});

test("cold DM: a reply quoting the chase for a LATER match registers for that one", async ({ request, db }) => {
  await match(db, LATER, londonAt(5, 20, 0));
  const stanza = await sentSchedulerDm(db, {
    key: `${LATER}:recruit-chase:${U.fresh}:qc`,
    userId: U.fresh,
    phone: PHONE.fresh,
    matchId: LATER,
    text: "Still after 2 players for the later game. Playing?",
    minsAgo: 30,
  });
  setMatchAvailabilityStub({ bodies: { "go on then mate": "in" } });
  const json = await postDm(request, PHONE.fresh, "go on then mate", { quotedMessageId: stanza, quotedText: "Still after...", quotedFromMatchTime: true });
  expect(json.handled).toBe("dm-self-attendance");
  expect(json.matchId).toBe(LATER);
  expect((await statusOn(db, LATER, U.fresh))?.status).toBe("CONFIRMED");
  expect(await statusOn(db, MATCH.upcoming, U.fresh)).toBeNull();
  const [turn] = turns("match-availability");
  expect(turn).toContain("THEY ARE REPLYING TO MatchTime's message of");
});

test("cold DM: a quote naming a match he cannot register for (completed) never steers; the default match, recent messages", async ({ request, db }) => {
  const stanza = await sentSchedulerDm(db, {
    key: `${MATCH.pay}:pay-chase:${U.fresh}:qc`,
    userId: U.fresh,
    phone: PHONE.fresh,
    matchId: MATCH.pay,
    text: "💷 Ian, your £8 is still outstanding",
    minsAgo: 30,
  });
  setMatchAvailabilityStub({ bodies: { "go on then mate": "in" } });
  const json = await postDm(request, PHONE.fresh, "go on then mate", { quotedMessageId: stanza, quotedText: "💷 Ian...", quotedFromMatchTime: true });
  expect(json.handled).toBe("dm-self-attendance");
  expect(json.matchId).toBe(MATCH.upcoming);
  const [turn] = turns("match-availability");
  expect(turn).not.toContain("THEY ARE REPLYING TO");
  expect(turn).toContain("MATCHTIME'S RECENT MESSAGES TO THEM (oldest first");
});
