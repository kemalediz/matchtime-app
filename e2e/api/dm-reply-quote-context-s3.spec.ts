/**
 * /api/whatsapp/dm-reply: THE OTHER FOUR DM CLASSIFIERS READ THE CHAT
 * CONTEXT, END TO END (quoted-reply context, slice S3, 2026-10-20).
 *
 * Drives the real route through the DM classifier stub seams, which stub
 * only what the MODEL said and record each user turn it was asked about
 * (`<file>.calls`). Everything else is the shipped code: the quote
 * resolution, the chat-context load, the match or club each path picks,
 * and the writes.
 *
 *   - fee-confirm: two matches awaiting the collector's yes; a swipe-reply
 *     to the OLDER one's fee question releases that one, and the model is
 *     told its date; a quote naming a match with no fee pending is dropped
 *     (recent messages, the default match);
 *   - roster check-in: a "yes" swipe-replied to a pay chase reaches the
 *     model with that pay chase as the message it answers (never dropped:
 *     the check-in is about no match), and when the check-in was sent;
 *   - dm-intent: an admin's "who's left?" swipe-replied to a rating DM is
 *     read against it; a quote naming another club's match is dropped;
 *   - dm-qa: a question swipe-replied to a message about one of his OTHER
 *     club's matches is answered from that club's context, read against
 *     the quote; a quote about a club he is not in is dropped.
 *
 * Free: no model is called.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { ACTIVITY_ID, MATCH, ORG_ID, PHONE, U, londonAt } from "../helpers/constants";
import { E2E } from "../helpers/env";
import {
  clearDmIntentStub,
  clearFeeReplyStub,
  clearRosterSurveyStub,
  setDmIntentStub,
  setFeeReplyStub,
  setRosterSurveyStub,
  stubCalls,
} from "../helpers/stub";
import { contextMatchLabel } from "../../src/lib/reply-context";
import { dayLabel } from "../../src/lib/i18n/dates";

test.describe.configure({ mode: "serial" });

test.beforeEach(() => {
  resetDb();
  clearFeeReplyStub();
  clearRosterSurveyStub();
  clearDmIntentStub();
});

test.afterAll(() => {
  clearFeeReplyStub();
  clearRosterSurveyStub();
  clearDmIntentStub();
});

let n = 0;
async function postDm(request: APIRequestContext, phone: string, body: string, extra: Record<string, unknown> = {}) {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { phone, body, waMessageId: `e2e-qc3-${Date.now()}-${++n}`, authorName: null, ...extra },
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
  const stanza = `3EB0QCS${++n}${Date.now()}`;
  await db.run(
    `INSERT INTO "SentNotification" (id, key, kind, "matchId", "targetUser", "waMessageId", "waStanzaId", text, "createdAt")
     VALUES ($1, $2, 'dm', $3, $4, $5, $6, $7, NOW() - ($8 || ' minutes')::interval)`,
    [`sn-${stanza}`, input.key, input.matchId, input.userId, `true_${digits(input.phone)}@s.whatsapp.net_${stanza}`, stanza, input.text, String(input.minsAgo)],
  );
  return stanza;
}

async function botJobDm(db: TestDb, input: { phone: string; text: string; minsAgo: number }) {
  await db.run(
    `INSERT INTO "BotJob" (id, "orgId", kind, phone, text, "createdAt", "sentAt")
     VALUES ($1, $2, 'dm', $3, $4, NOW() - ($5 || ' minutes')::interval, NOW() - ($5 || ' minutes')::interval)`,
    [`qc3-job-${++n}-${Date.now()}`, ORG_ID, digits(input.phone), input.text, String(input.minsAgo)],
  );
}

const turns = (file: string, label: string) =>
  stubCalls(file)
    .filter((c) => c.label === label)
    .map((c) => c.user);

/** A second club, "Other FC", with an upcoming match. `member` joins it. */
const OTHER = { org: "e2e-qc3-org", sport: "e2e-qc3-sport", act: "e2e-qc3-act", match: "e2e-qc3-match" };
async function otherClub(db: TestDb, member: string | null) {
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "setupStage", "updatedAt")
     VALUES ($1, 'Other FC', 'e2e-qc3-other', 'e2e-qc3-invite', 'live', now())`,
    [OTHER.org],
  );
  await db.run(
    `INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt")
     VALUES ($1, $2, 'Football 6-a-side', 6, ARRAY['GK','DEF','MID','FWD'], ARRAY['Red','Yellow'], now())`,
    [OTHER.sport, OTHER.org],
  );
  await db.run(
    `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "updatedAt")
     VALUES ($1, $2, $3, 'Thursday 6-a-side', 4, '19:00', 'Other Arena', 5, now())`,
    [OTHER.act, OTHER.org, OTHER.sport],
  );
  const kickoff = londonAt(3, 19, 0);
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt")
     VALUES ($1, $2, $3, 12, 'UPCOMING', $4, now())`,
    [OTHER.match, OTHER.act, kickoff, new Date(kickoff.getTime() - 5 * 3600 * 1000)],
  );
  if (member) {
    await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1, $2, $3, 'PLAYER')`, [
      `e2e-qc3-mem-${member}`,
      member,
      OTHER.org,
    ]);
  }
}

// ── fee-confirm ───────────────────────────────────────────────────────

const OLDER_FEE = "e2e-qc3-fee-older";

/** Two matches awaiting the collector's yes at £8: the seeded RATE match
 *  (yesterday) and an older one, two days ago. */
async function twoPendingFees(db: TestDb): Promise<Date> {
  const older = new Date(Date.now() - 2 * 24 * 3600 * 1000);
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt", "feePendingConfirm", "feeSetByUserId")
     VALUES ($1, $2, $3, 10, 'COMPLETED', $3, NOW(), 8, $4)`,
    [OLDER_FEE, ACTIVITY_ID, older, U.collector],
  );
  await db.run(
    `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "respondedAt", "updatedAt")
     VALUES ($1, $2, $3, 'CONFIRMED', 2, NOW(), NOW())`,
    [`qc3-att-${OLDER_FEE}`, OLDER_FEE, U.player],
  );
  await db.run(`UPDATE "Match" SET "feePendingConfirm" = 8, "feeSetByUserId" = $2 WHERE id = $1`, [MATCH.rate, U.collector]);
  return older;
}

const released = (db: TestDb, id: string) =>
  db.one<{ paymentLinksReleasedAt: Date | null; feePendingConfirm: number | null }>(
    `SELECT "paymentLinksReleasedAt", "feePendingConfirm" FROM "Match" WHERE id = $1`,
    [id],
  );

test("fee: a swipe-reply to the OLDER match's fee question releases THAT match, and the model is told which", async ({ request, db }) => {
  const olderDate = await twoPendingFees(db);
  const stanza = await sentSchedulerDm(db, {
    key: `${OLDER_FEE}:fee-ask`,
    userId: U.collector,
    phone: PHONE.collector,
    matchId: OLDER_FEE,
    text: "Got it, £8 per player for E2E 5-a-side, 1 player to charge. Reply ✅ (or \"yes\") to send everyone their pay link.",
    minsAgo: 90,
  });
  // A newer DM to the collector, about something else.
  await botJobDm(db, { phone: PHONE.collector, text: "💸 Riley says they've paid you directly", minsAgo: 5 });
  setFeeReplyStub({ bodies: { "yeah go on then": "yes" } });

  const json = await postDm(request, PHONE.collector, "yeah go on then", {
    quotedMessageId: stanza,
    quotedText: "Got it, £8 per player...",
    quotedFromMatchTime: true,
  });
  expect(json.handled).toBe("collector-fee");
  expect((await released(db, OLDER_FEE))?.paymentLinksReleasedAt).not.toBeNull();
  expect((await released(db, MATCH.rate))?.paymentLinksReleasedAt).toBeNull();

  const [turn] = turns(E2E.FEE_REPLY_STUB_FILE, "fee-confirm");
  expect(turn).toContain(`Match: ${contextMatchLabel("E2E 5-a-side", olderDate)}`);
  expect(turn).toContain("Amount waiting for their yes: £8 per player");
  expect(turn).toContain("THEY ARE REPLYING TO MatchTime's message of");
  expect(turn).toContain("Got it, £8 per player for E2E 5-a-side");
  expect(turn).not.toContain("paid you directly");
  expect(turn.endsWith("THEIR REPLY:\nyeah go on then")).toBe(true);
});

test("fee (H1): a swipe-reply to a KNOWN message about a match with nothing to release releases NOTHING, no fallback", async ({ request, db }) => {
  await twoPendingFees(db);
  // The PAY match's links went out long ago: not a match a yes can release.
  const stanza = await sentSchedulerDm(db, {
    key: `${MATCH.pay}:pay-chase:${U.collector}:qc3`,
    userId: U.collector,
    phone: PHONE.collector,
    matchId: MATCH.pay,
    text: "💷 QC3 an old message about the pay match",
    minsAgo: 60,
  });
  setFeeReplyStub({ bodies: { "yeah go on then": "yes", "✅": "yes" } });
  for (const body of ["yeah go on then", "✅"]) {
    const json = await postDm(request, PHONE.collector, body, { quotedMessageId: stanza, quotedText: "💷 QC3...", quotedFromMatchTime: true });
    expect(json.handled).not.toBe("collector-fee");
  }
  expect((await released(db, MATCH.rate))?.paymentLinksReleasedAt).toBeNull();
  expect((await released(db, OLDER_FEE))?.paymentLinksReleasedAt).toBeNull();
  expect(turns(E2E.FEE_REPLY_STUB_FILE, "fee-confirm")).toHaveLength(0);
});

test("fee (H2): '✅' swipe-replied to a rating DM about the pending match: the model reads it with that quote, and its neither releases nothing", async ({ request, db }) => {
  await db.run(`UPDATE "Match" SET "feePendingConfirm" = 8, "feeSetByUserId" = $2 WHERE id = $1`, [MATCH.rate, U.collector]);
  const stanza = await sentSchedulerDm(db, {
    key: `${MATCH.rate}:rate-dm:${U.collector}`,
    userId: U.collector,
    phone: PHONE.collector,
    matchId: MATCH.rate,
    text: "⭐ QC3 how did last night go? Rate your teammates",
    minsAgo: 20,
  });
  setFeeReplyStub({ bodies: {} });
  const json = await postDm(request, PHONE.collector, "✅", { quotedMessageId: stanza, quotedText: "⭐ QC3...", quotedFromMatchTime: true });
  expect(json.handled).not.toBe("collector-fee");
  expect(await released(db, MATCH.rate)).toMatchObject({ paymentLinksReleasedAt: null, feePendingConfirm: 8 });
  const [turn] = turns(E2E.FEE_REPLY_STUB_FILE, "fee-confirm");
  expect(turn).toContain("THEY ARE REPLYING TO MatchTime's message of");
  expect(turn).toContain("QC3 how did last night go?");
  expect(turn.endsWith("THEIR REPLY:\n✅")).toBe(true);
});

/** The collector types an amount: the route stages it and queues the
 *  confirm question. The Pi then sends and acks that DM (its stanza id). */
async function stageViaRoute(request: APIRequestContext, db: TestDb, amount: string): Promise<{ id: string; stanza: string }> {
  const json = await postDm(request, PHONE.collector, amount);
  expect(json.handled).toBe("collector-fee");
  const job = await db.one<{ id: string; matchId: string | null; aboutKey: string | null }>(
    `SELECT id, "matchId", "aboutKey" FROM "BotJob" WHERE phone = $1 AND text LIKE 'Got it%' ORDER BY "createdAt" DESC LIMIT 1`,
    [digits(PHONE.collector)],
  );
  expect(job).not.toBeNull();
  const stanza = `3EB0${job!.id}`;
  await db.run(`UPDATE "BotJob" SET "sentAt" = NOW() WHERE id = $1`, [job!.id]);
  await db.run(
    `INSERT INTO "SentNotification" (id, key, kind, "waMessageId", "waStanzaId", "createdAt") VALUES ($1, $2, 'dm', $3, $4, NOW())`,
    [`sn-${job!.id}`, `botjob-${job!.id}`, `true_${digits(PHONE.collector)}@s.whatsapp.net_${stanza}`, stanza],
  );
  return { id: job!.id, stanza };
}

test("fee (H3): the queued confirm question carries its match, so '✅' swiped to it releases THAT match, not a newer pending one", async ({ request, db }) => {
  // Only the RATE match (yesterday) has no fee yet: the amount stages there.
  setFeeReplyStub({
    bodies: { "£8": JSON.stringify({ intent: "amount", amount: 8, amountIs: "each", confidence: 1 }), "✅": "yes" },
  });
  const asked = await stageViaRoute(request, db, "£8");
  const job = await db.one<{ matchId: string | null; aboutKey: string | null }>(`SELECT "matchId", "aboutKey" FROM "BotJob" WHERE id = $1`, [asked.id]);
  expect(job).toEqual({ matchId: MATCH.rate, aboutKey: `${MATCH.rate}:fee-confirm` });
  // A NEWER match then also waits for the collector's yes.
  const newer = "e2e-qc3-fee-newer";
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt", "feePendingConfirm", "feeSetByUserId")
     VALUES ($1, $2, NOW() - interval '2 hours', 10, 'COMPLETED', NOW() - interval '3 hours', NOW(), 10, $3)`,
    [newer, ACTIVITY_ID, U.collector],
  );
  const json = await postDm(request, PHONE.collector, "✅", { quotedMessageId: asked.stanza, quotedText: "Got it...", quotedFromMatchTime: true });
  expect(json.handled).toBe("collector-fee");
  expect((await released(db, MATCH.rate))?.paymentLinksReleasedAt).not.toBeNull();
  expect((await released(db, newer))?.paymentLinksReleasedAt).toBeNull();
  // The model read the ✅ with the confirm question it swipe-replied to.
  const all = turns(E2E.FEE_REPLY_STUB_FILE, "fee-confirm");
  expect(all).toHaveLength(2);
  expect(all[1]).toContain("THEY ARE REPLYING TO MatchTime's message of");
  expect(all[1]).toContain("Amount waiting for their yes: £8 per player");
});

test("fee (H3): with no quote, the NEWEST pending match wins, not the highest amount (£10 older vs £8 newer)", async ({ request, db }) => {
  const older = "e2e-qc3-fee-10";
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt", "feePendingConfirm", "feeSetByUserId")
     VALUES ($1, $2, NOW() - interval '3 days', 10, 'COMPLETED', NOW() - interval '3 days', NOW(), 10, $3)`,
    [older, ACTIVITY_ID, U.collector],
  );
  await db.run(`UPDATE "Match" SET "feePendingConfirm" = 8, "feeSetByUserId" = $2 WHERE id = $1`, [MATCH.rate, U.collector]);
  setFeeReplyStub({ bodies: { "✅": "yes" } });
  const json = await postDm(request, PHONE.collector, "✅");
  expect(json.handled).toBe("collector-fee");
  expect((await released(db, MATCH.rate))?.paymentLinksReleasedAt).not.toBeNull();
  expect((await released(db, older))?.paymentLinksReleasedAt).toBeNull();
});

test("fee (idempotent): two '✅' at once, or a Pi redelivery, release the links ONCE", async ({ request, db }) => {
  await db.run(`UPDATE "Match" SET "feePendingConfirm" = 8, "feeSetByUserId" = $2 WHERE id = $1`, [MATCH.rate, U.collector]);
  const before = await db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM "BotJob" WHERE phone = $1`, [digits(PHONE.player)]);
  setFeeReplyStub({ bodies: { "✅": "yes" } });
  const send = (id: string) =>
    request.post("/api/whatsapp/dm-reply", {
      headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
      data: { phone: PHONE.collector, body: "✅", waMessageId: id, authorName: null },
    });
  const id = `e2e-qc3-twice-${Date.now()}`;
  const rs = await Promise.all([send(id), send(`${id}-b`), send(id)]);
  for (const r of rs) expect(r.status()).toBe(200);
  const after = await db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM "BotJob" WHERE phone = $1`, [digits(PHONE.player)]);
  expect((after?.n ?? 0) - (before?.n ?? 0)).toBe(1);
  const acks = await db.all(`SELECT id FROM "BotJob" WHERE phone = $1 AND text LIKE '✅ Done,%'`, [digits(PHONE.collector)]);
  expect(acks).toHaveLength(1);
});

test("fee: the collector's ack is queued under the MATCH's club and names the match's date", async ({ request, db }) => {
  // A second club Colin also collects for, whose match is the newest pending.
  await otherClub(db, U.collector);
  await db.run(`UPDATE "Organisation" SET "paymentCollectionEnabled" = true, "paymentHolderId" = $2 WHERE id = $1`, [OTHER.org, U.collector]);
  await db.run(
    `UPDATE "Match" SET date = NOW() - interval '2 hours', status = 'COMPLETED', "feePendingConfirm" = 6, "feeSetByUserId" = $2 WHERE id = $1`,
    [OTHER.match, U.collector],
  );
  await db.run(`UPDATE "Match" SET "feePendingConfirm" = 8, "feeSetByUserId" = $2 WHERE id = $1`, [MATCH.rate, U.collector]);
  setFeeReplyStub({ bodies: { "✅": "yes" } });
  const json = await postDm(request, PHONE.collector, "✅");
  expect(json.handled).toBe("collector-fee");
  expect((await released(db, OTHER.match))?.paymentLinksReleasedAt).not.toBeNull();
  const ack = await db.one<{ orgId: string; text: string }>(
    `SELECT "orgId", text FROM "BotJob" WHERE phone = $1 AND text LIKE '✅ Done,%' ORDER BY "createdAt" DESC LIMIT 1`,
    [digits(PHONE.collector)],
  );
  expect(ack?.orgId).toBe(OTHER.org);
  const date = await db.one<{ date: Date }>(`SELECT date FROM "Match" WHERE id = $1`, [OTHER.match]);
  expect(ack?.text).toContain(dayLabel("en", date!.date));
});

test("fee: the model says neither, nothing is released and the pending amount stays", async ({ request, db }) => {
  await twoPendingFees(db);
  setFeeReplyStub({ bodies: {} });
  await postDm(request, PHONE.collector, "cheers lads, great game 👍");
  expect((await released(db, MATCH.rate))).toMatchObject({ paymentLinksReleasedAt: null, feePendingConfirm: 8 });
  expect(turns(E2E.FEE_REPLY_STUB_FILE, "fee-confirm")).toHaveLength(1);
});

// ── roster check-in ───────────────────────────────────────────────────

const SURVEY = "e2e-qc3-survey";

test("roster: a 'yes' swipe-replied to a pay chase reaches the model with that pay chase as the message it answers", async ({ request, db }) => {
  const sentAt = new Date(Date.now() - 2 * 24 * 3600 * 1000);
  await db.run(
    `INSERT INTO "RosterSurvey" (id, "orgId", "sentByUserId", status, "createdAt", "updatedAt") VALUES ($1, $2, $3, 'open', $4, $4)`,
    [SURVEY, ORG_ID, U.admin, sentAt],
  );
  await db.run(`INSERT INTO "RosterSurveyDM" (id, "surveyId", "userId", "sentAt", "createdAt") VALUES ($1, $2, $3, $4, $4)`, [
    `${SURVEY}-dm`,
    SURVEY,
    U.third,
    sentAt,
  ]);
  const stanza = await sentSchedulerDm(db, {
    key: `${MATCH.rate}:pay-chase:${U.third}:qc3`,
    userId: U.third,
    phone: PHONE.third,
    matchId: MATCH.rate,
    text: "💷 Tom, QC3 your £8 for last night is outstanding",
    minsAgo: 20,
  });
  setRosterSurveyStub({ bodies: { yes: "unclear" } });
  const json = await postDm(request, PHONE.third, "yes", { quotedMessageId: stanza, quotedText: "💷 Tom...", quotedFromMatchTime: true });
  expect(json.action).toBe("clarification-sent");
  const [turn] = turns(E2E.ROSTER_SURVEY_STUB_FILE, "roster-survey");
  expect(turn).toContain("The check-in was sent: ");
  expect(turn).toContain("THEY ARE REPLYING TO MatchTime's message of");
  expect(turn).toContain("QC3 your £8 for last night");
  expect(turn.endsWith("THE DM:\nyes")).toBe(true);
});

// ── dm-intent ─────────────────────────────────────────────────────────

test("dm-intent: an admin's 'who's left?' swipe-replied to a rating DM is read against it", async ({ request, db }) => {
  const stanza = await sentSchedulerDm(db, {
    key: `${MATCH.rate}:rate-dm:${U.admin}`,
    userId: U.admin,
    phone: PHONE.admin,
    matchId: MATCH.rate,
    text: "⭐ QC3 how did last night go? Rate your teammates",
    minsAgo: 30,
  });
  setDmIntentStub({ bodies: { "who's left?": "rating_progress" } });
  const json = await postDm(request, PHONE.admin, "who's left?", { quotedMessageId: stanza, quotedText: "⭐ QC3...", quotedFromMatchTime: true });
  expect(json.handled).toBe("rating-progress-dm");
  const [turn] = turns(E2E.DM_INTENT_STUB_FILE, "dm-intent");
  expect(turn).toContain("THEY ARE REPLYING TO MatchTime's message of");
  expect(turn).toContain("QC3 how did last night go?");
  expect(turn.endsWith("THE DM:\nwho's left?")).toBe(true);
});

test("dm-intent: a quote naming another club's match is dropped; the recent messages instead", async ({ request, db }) => {
  await otherClub(db, null);
  const stanza = await sentSchedulerDm(db, {
    key: `${OTHER.match}:announce-match:${U.admin}:qc3`,
    userId: U.admin,
    phone: PHONE.admin,
    matchId: OTHER.match,
    text: "QC3 Other FC is playing Thursday",
    minsAgo: 30,
  });
  setDmIntentStub({ bodies: {} });
  // One DM from his own club, so the recent list has something in it.
  await sentSchedulerDm(db, { key: `${MATCH.rate}:rate-dm:${U.admin}`, userId: U.admin, phone: PHONE.admin, matchId: MATCH.rate, text: "QC3 own-club rating DM", minsAgo: 40 });
  await postDm(request, PHONE.admin, "who's left?", { quotedMessageId: stanza, quotedText: "QC3...", quotedFromMatchTime: true });
  const [turn] = turns(E2E.DM_INTENT_STUB_FILE, "dm-intent");
  expect(turn).not.toContain("THEY ARE REPLYING TO");
  expect(turn).toContain("MATCHTIME'S RECENT MESSAGES TO THEM (oldest first");
  expect(turn).toContain("QC3 own-club rating DM");
  // M1: the other club's DM is not in the recent list either.
  expect(turn).not.toContain("QC3 Other FC is playing Thursday");
});

// ── dm-qa ─────────────────────────────────────────────────────────────

test("dm-qa: a question swipe-replied to his OTHER club's invite is answered from that club, read against the quote", async ({ request, db }) => {
  await otherClub(db, U.player);
  const stanza = await sentSchedulerDm(db, {
    key: `${OTHER.match}:recruit-chase:${U.player}:qc3`,
    userId: U.player,
    phone: PHONE.player,
    matchId: OTHER.match,
    text: "QC3 Other FC needs 2 for Thursday. Playing?",
    minsAgo: 30,
  });
  const json = await postDm(request, PHONE.player, "what time is it?", { quotedMessageId: stanza, quotedText: "QC3...", quotedFromMatchTime: true });
  expect(json.handled).toBe("dm-qa");
  const answer = await db.one<{ text: string }>(
    `SELECT text FROM "BotJob" WHERE kind = 'dm' AND phone = $1 AND text LIKE '[scoped-qa-stub]%' ORDER BY "createdAt" DESC LIMIT 1`,
    [digits(PHONE.player)],
  );
  expect(answer?.text).toContain("GROUP: Other FC");
  expect(answer?.text).toContain("[chat-context]");
  expect(answer?.text).toContain("THEY ARE REPLYING TO MatchTime's message of");
  expect(answer?.text).toContain("QC3 Other FC needs 2 for Thursday");
});

test("dm-qa: a quote about a club he is not in is dropped; his own club, the recent messages", async ({ request, db }) => {
  await otherClub(db, null);
  const stanza = await sentSchedulerDm(db, {
    key: `${OTHER.match}:recruit-chase:${U.player}:qc3`,
    userId: U.player,
    phone: PHONE.player,
    matchId: OTHER.match,
    text: "QC3 a stray message about Other FC",
    minsAgo: 30,
  });
  const json = await postDm(request, PHONE.player, "what time is it?", { quotedMessageId: stanza, quotedText: "QC3...", quotedFromMatchTime: true });
  expect(json.handled).toBe("dm-qa");
  const answer = await db.one<{ text: string }>(
    `SELECT text FROM "BotJob" WHERE kind = 'dm' AND phone = $1 AND text LIKE '[scoped-qa-stub]%' ORDER BY "createdAt" DESC LIMIT 1`,
    [digits(PHONE.player)],
  );
  expect(answer?.text).toContain("GROUP: E2E Test FC");
  expect(answer?.text).not.toContain("THEY ARE REPLYING TO");
  expect(answer?.text).toContain("MATCHTIME'S RECENT MESSAGES TO THEM");
  // M1: the other club's DM is not in the recent list either.
  expect(answer?.text).not.toContain("QC3 a stray message about Other FC");
});
