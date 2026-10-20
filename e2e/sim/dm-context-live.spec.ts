/**
 * THE OTHER FOUR DM CLASSIFIERS, LIVE-LLM, END TO END (quoted-reply
 * context, slice S3, 2026-10-20).
 *
 * The free spec (`api/dm-reply-quote-context-s3.spec.ts`) proves what each
 * classifier is TOLD, with the model stubbed. This drives the REAL model
 * through the REAL /api/whatsapp/dm-reply route, one path each, with a
 * swipe-reply the Pi forwards (`quotedMessageId`, `quotedText`,
 * `quotedFromMatchTime`). No stub.
 *
 *   - fee-confirm: the collector swipe-replies "sounds good, fire them out"
 *     to the fee question while a newer notice came after: the links go
 *     out for that match;
 *   - dm-intent: an admin swipe-replies "who's left?" to MatchTime's rating
 *     update: the rating progress reply;
 *   - dm-qa: a player swipe-replies "what time?" to the invite: the answer
 *     names the kickoff.
 *
 * The roster check-in's live path is `roster-survey-live.spec.ts`. Once
 * each (Kemal's cheap test plan). Opt-in: only runs when MT_SIM_LIVE_LLM=1,
 * on the developer key.
 *
 *   MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/dm-context-live.spec.ts
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { MATCH, ORG_ID, PHONE, U } from "../helpers/constants";
import { E2E } from "../helpers/env";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const digits = (p: string) => p.replace(/^\+/, "");

let n = 0;
async function postDm(request: APIRequestContext, phone: string, body: string, extra: Record<string, unknown> = {}) {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { phone, body, waMessageId: `live-ctx-${Date.now()}-${++n}`, authorName: null, ...extra },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

/** A DM MatchTime sent and the Pi acked: a scheduler claim with its words,
 *  match, recipient and the bare stanza id a quote carries. */
async function sentSchedulerDm(
  db: TestDb,
  input: { key: string; userId: string; phone: string; matchId: string | null; text: string; minsAgo: number },
): Promise<string> {
  const stanza = `3EB0LIVECTX${++n}${Date.now()}`;
  await db.run(
    `INSERT INTO "SentNotification" (id, key, kind, "matchId", "targetUser", "waMessageId", "waStanzaId", text, "createdAt")
     VALUES ($1, $2, 'dm', $3, $4, $5, $6, $7, NOW() - ($8 || ' minutes')::interval)`,
    [`sn-${stanza}`, input.key, input.matchId, input.userId, `true_${digits(input.phone)}@s.whatsapp.net_${stanza}`, stanza, input.text, String(input.minsAgo)],
  );
  return stanza;
}

/** A queued DM the Pi sent and acked (`botjob-<id>`), with its stanza id. */
async function sentBotJobDm(db: TestDb, input: { phone: string; text: string; minsAgo: number }): Promise<string> {
  const id = `live-ctx-job-${++n}-${Date.now()}`;
  const stanza = `3EB0${id}`;
  await db.run(
    `INSERT INTO "BotJob" (id, "orgId", kind, phone, text, "createdAt", "sentAt")
     VALUES ($1, $2, 'dm', $3, $4, NOW() - ($5 || ' minutes')::interval, NOW() - ($5 || ' minutes')::interval)`,
    [id, ORG_ID, digits(input.phone), input.text, String(input.minsAgo)],
  );
  await db.run(
    `INSERT INTO "SentNotification" (id, key, kind, "waMessageId", "waStanzaId", "createdAt")
     VALUES ($1, $2, 'dm', $3, $4, NOW() - ($5 || ' minutes')::interval)`,
    [`sn-${id}`, `botjob-${id}`, `true_${digits(input.phone)}@s.whatsapp.net_${stanza}`, stanza, String(input.minsAgo)],
  );
  return stanza;
}

(LIVE ? test.describe : test.describe.skip)("DM chat context LIVE (real Anthropic model)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(resetDb);

  test("fee-confirm: 'sounds good, fire them out' swipe-replied to the fee question releases the links", async ({ request, db }) => {
    await db.run(`UPDATE "Match" SET "feePendingConfirm" = 8, "feeSetByUserId" = $2 WHERE id = $1`, [MATCH.rate, U.collector]);
    const ask = "Got it, *£8* per player for *E2E 5-a-side*, 5 players to charge.\n\nReply *✅* (or \"yes\") to send everyone their pay link, or send a different amount to change it.";
    const stanza = await sentBotJobDm(db, { phone: PHONE.collector, text: ask, minsAgo: 30 });
    // A newer DM to him, about something else.
    await sentBotJobDm(db, { phone: PHONE.collector, text: "💸 Riley Rater says they've paid you directly £8 for E2E 5-a-side.", minsAgo: 5 });
    const json = await postDm(request, PHONE.collector, "sounds good, fire them out", { quotedMessageId: stanza, quotedText: ask, quotedFromMatchTime: true });
    console.log(`[dm-context-live] FEE: ${JSON.stringify(json)}`);
    expect(json.handled).toBe("collector-fee");
    const m = await db.one<{ paymentLinksReleasedAt: Date | null }>(`SELECT "paymentLinksReleasedAt" FROM "Match" WHERE id = $1`, [MATCH.rate]);
    expect(m?.paymentLinksReleasedAt).not.toBeNull();
  });

  test("dm-intent: an admin's 'who's left?' swipe-replied to MatchTime's rating update is a rating progress question", async ({ request, db }) => {
    const update =
      "⭐ Ratings for E2E 5-a-side (yesterday):\n3 of 5 have rated.\n2 of 5 have picked a Man of the Match.\nStill to rate: Sam Stale, Olivia Opty.";
    const stanza = await sentBotJobDm(db, { phone: PHONE.admin, text: update, minsAgo: 20 });
    const json = await postDm(request, PHONE.admin, "who's left?", { quotedMessageId: stanza, quotedText: update, quotedFromMatchTime: true });
    console.log(`[dm-context-live] INTENT: ${JSON.stringify(json)}`);
    expect(json.handled).toBe("rating-progress-dm");
  });

  test("dm-qa: 'what time?' swipe-replied to the invite names the kickoff", async ({ request, db }) => {
    const up = await db.one<{ date: Date }>(`SELECT date FROM "Match" WHERE id = $1`, [MATCH.upcoming]);
    const kickoff = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false }).format(up!.date);
    const invite = "👋 Pat, we're putting the squad together for *E2E 5-a-side*. Playing? Reply *IN* or tap 👍 on this message.";
    const stanza = await sentSchedulerDm(db, {
      key: `${MATCH.upcoming}:recruit-chase:${U.player}:live`,
      userId: U.player,
      phone: PHONE.player,
      matchId: MATCH.upcoming,
      text: invite,
      minsAgo: 30,
    });
    const json = await postDm(request, PHONE.player, "what time?", { quotedMessageId: stanza, quotedText: invite, quotedFromMatchTime: true });
    console.log(`[dm-context-live] QA: ${JSON.stringify(json)}`);
    expect(json.handled).toBe("dm-qa");
    const answer = await db.one<{ text: string }>(
      `SELECT text FROM "BotJob" WHERE kind = 'dm' AND phone = $1 ORDER BY "createdAt" DESC LIMIT 1`,
      [digits(PHONE.player)],
    );
    console.log(`[dm-context-live] QA answer: ${JSON.stringify(answer?.text)}`);
    expect(answer?.text).toContain(kickoff);
  });
});
