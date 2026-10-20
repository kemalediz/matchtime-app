/**
 * A PLAYER DMs ABOUT PAYING THE COLLECTOR — LIVE-LLM, END TO END (2026-10-18).
 *
 * Feroz (FNF) DM'd "I bank transferred Raihan" and nothing was recorded:
 * the model was never told Raihan collects the money. `paid-claim-dm.spec.ts`
 * proves the wiring with the model stubbed; this drives the REAL model
 * through the REAL /api/whatsapp/dm-reply route against the seeded PAY
 * match (Pat owes £8, Colin collects). No stub.
 *
 *   - "I bank transferred Colin": pending (never paid), the collector's
 *     "says they've paid you directly", the ack, the ✅ queued.
 *   - "will send Colin tonight": the settle-directly button said in words
 *     (Kemal, 2026-10-18): pending, "says they'll pay you directly".
 *   - "did Colin get it?": a question, nothing written.
 *   - "done 👍" swipe-replying to the pay link while a rating DM came after
 *     it (quoted-reply context, slice S2): the quoted message is the one it
 *     answers, so it is a claim.
 *   - owes TWO matches, "done 👍" swipe-replying to the OLDER one's chase
 *     (review of #336): the claim lands on the older match, never the
 *     most recent one.
 *
 * Once each (Kemal's cheap test plan). Opt-in: only runs when
 * MT_SIM_LIVE_LLM=1, on the developer key.
 *
 *   MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/paid-claim-live.spec.ts
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { U, ORG_ID, PHONE, MATCH, ACTIVITY_ID } from "../helpers/constants";
import { E2E } from "../helpers/env";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

(LIVE ? test.describe : test.describe.skip)("payment claim LIVE (real Anthropic model)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(resetDb);

  async function postDm(request: APIRequestContext, body: string, waMessageId: string, extra: Record<string, unknown> = {}) {
    const res = await request.post("/api/whatsapp/dm-reply", {
      headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
      data: { phone: PHONE.player, body, waMessageId, authorName: null, ...extra },
    });
    expect(res.status(), await res.text()).toBe(200);
    return res.json();
  }

  const row = (db: TestDb) =>
    db.one<{ paidAt: Date | null; directPendingAt: Date | null; paymentMethod: string | null }>(
      `SELECT "paidAt", "directPendingAt", "paymentMethod" FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
      [MATCH.pay, U.player],
    );
  const collectorNotices = (db: TestDb) =>
    db.all<{ text: string }>(
      `SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2 AND text LIKE '💸%'`,
      [ORG_ID, PHONE.collector.replace(/^\+/, "")],
    );
  const repliesToPlayer = (db: TestDb) =>
    db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE kind = 'dm' AND phone = $1 ORDER BY "createdAt" DESC`, [
      PHONE.player.replace(/^\+/, ""),
    ]);
  const ticksOn = (db: TestDb, id: string) =>
    db.all<{ emoji: string }>(`SELECT emoji FROM "RetroReaction" WHERE "waMessageId" = $1`, [id]);

  test("Feroz's case: 'I bank transferred Colin' is a claim on the collector", async ({ request, db }) => {
    const id = `false_111222333@lid_LIVEPAID${Date.now()}`;
    const json = await postDm(request, "I bank transferred Colin", id);
    expect(json.handled).toBe("paid-claim");
    const r = await row(db);
    expect(r?.paidAt).toBeNull();
    expect(r?.directPendingAt).not.toBeNull();
    expect(r?.paymentMethod).toBe("direct");
    const notices = await collectorNotices(db);
    expect(notices).toHaveLength(1);
    expect(notices[0].text).toContain("says they've paid you directly");
    expect((await repliesToPlayer(db))[0].text).toBe(
      "Thanks Pat, I've told Colin you've paid *£8* for *E2E 5-a-side*. Colin will confirm once it lands 👍",
    );
    expect(await ticksOn(db, id)).toEqual([{ emoji: "✅" }]);
  });

  test("'will send Colin tonight' is the settle-directly button", async ({ request, db }) => {
    const id = `false_111222333@lid_LIVEWILL${Date.now()}`;
    const json = await postDm(request, "will send Colin tonight", id);
    expect(json.handled).toBe("will-pay-direct");
    const r = await row(db);
    expect(r?.paidAt).toBeNull();
    expect(r?.directPendingAt).not.toBeNull();
    const notices = await collectorNotices(db);
    expect(notices).toHaveLength(1);
    expect(notices[0].text).toContain("says they'll pay you directly");
    expect((await repliesToPlayer(db))[0].text).toBe(
      "Noted Pat, I've told Colin you'll pay them *£8* directly for *E2E 5-a-side*. Colin will confirm once it lands 👍",
    );
  });

  test("'did Colin get it?' is a question: nothing written", async ({ request, db }) => {
    const id = `false_111222333@lid_LIVEASK${Date.now()}`;
    const json = await postDm(request, "did Colin get it?", id);
    expect(["paid-claim", "will-pay-direct"]).not.toContain(json.handled);
    const r = await row(db);
    expect(r?.directPendingAt).toBeNull();
    expect(r?.paidAt).toBeNull();
    expect(await collectorNotices(db)).toHaveLength(0);
    expect(await ticksOn(db, id)).toEqual([]);
  });

  test("'done 👍' swipe-replying to the pay link, a rating DM after it: a claim", async ({ request, db }) => {
    const playerDigits = PHONE.player.replace(/^\+/, "");
    const stamp = Date.now();
    // MatchTime's DMs to Pat, as sent and acked: the pay link, then (newer)
    // the rating request. Each acked BotJob has its `botjob-<id>` row with
    // the bare stanza id a WhatsApp quote carries.
    const sends: Array<[string, string, number]> = [
      [`live-swipe-pay-${stamp}`, "💷 Pat, match fee for *E2E 5-a-side* is *£8*. Tap to pay, or pay Colin directly: https://mt.example/s/pay", 60],
      [`live-swipe-rate-${stamp}`, "⭐ How did *E2E 5-a-side* go? Rate your teammates and vote for Man of the Match: https://mt.example/s/rate", 10],
    ];
    for (const [id, text, minsAgo] of sends) {
      await db.run(
        `INSERT INTO "BotJob" (id, "orgId", kind, phone, text, "createdAt", "sentAt")
         VALUES ($1, $2, 'dm', $3, $4, NOW() - ($5 || ' minutes')::interval, NOW() - ($5 || ' minutes')::interval)`,
        [id, ORG_ID, playerDigits, text, String(minsAgo)],
      );
      await db.run(
        `INSERT INTO "SentNotification" (id, key, kind, "waMessageId", "waStanzaId", "createdAt")
         VALUES ($1, $2, 'dm', $3, $4, NOW() - ($5 || ' minutes')::interval)`,
        [`sn-${id}`, `botjob-${id}`, `true_${playerDigits}@s.whatsapp.net_3EB0${id}`, `3EB0${id}`, String(minsAgo)],
      );
    }
    const id = `false_111222333@lid_LIVESWIPE${stamp}`;
    const json = await postDm(request, "done 👍", id, {
      quotedMessageId: `3EB0live-swipe-pay-${stamp}`,
      quotedText: sends[0][1],
      quotedFromMatchTime: true,
    });
    console.log(`[paid-claim-live] SWIPE: ${JSON.stringify(json)}`);
    expect(json.handled).toBe("paid-claim");
    const r = await row(db);
    expect(r?.paidAt).toBeNull();
    expect(r?.directPendingAt).not.toBeNull();
    expect(await collectorNotices(db)).toHaveLength(1);
  });

  test("owes two matches: 'done 👍' swipe-replying to the OLDER one's chase lands on the older one", async ({ request, db }) => {
    const playerDigits = PHONE.player.replace(/^\+/, "");
    const older = `live-older-${Date.now()}`;
    const olderDate = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    await db.run(
      `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt",
                            "feePerPlayer", "feeSetByUserId", "feeSetAt", "paymentLinksReleasedAt")
       VALUES ($1, $2, $3, 10, 'COMPLETED', $3, NOW(), 8, $4, $3, $3)`,
      [older, ACTIVITY_ID, olderDate, U.collector],
    );
    await db.run(
      `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "respondedAt", "updatedAt")
       VALUES ($1, $2, $3, 'CONFIRMED', 2, NOW(), NOW())`,
      [`att-${older}`, older, U.player],
    );
    const stanza = `3EB0LIVEOLD${Date.now()}`;
    const chase = "💷 Quick one Pat: your *£8* for *E2E 5-a-side* last week is still outstanding. Pay here or pay Colin directly: https://mt.example/s/pay";
    await db.run(
      `INSERT INTO "SentNotification" (id, key, kind, "matchId", "targetUser", "waMessageId", "waStanzaId", text, "createdAt")
       VALUES ($1, $2, 'dm', $3, $4, $5, $6, $7, NOW() - interval '2 hours')`,
      [`sn-${stanza}`, `${older}:pay-chase:${U.player}:live`, older, U.player, `true_${playerDigits}@s.whatsapp.net_${stanza}`, stanza, chase],
    );
    await db.run(
      `INSERT INTO "BotJob" (id, "orgId", kind, phone, text, "createdAt", "sentAt")
       VALUES ($1, $2, 'dm', $3, $4, NOW() - interval '10 minutes', NOW() - interval '10 minutes')`,
      [`rate-${older}`, ORG_ID, playerDigits, "⭐ How did *E2E 5-a-side* go? Rate your teammates: https://mt.example/s/rate"],
    );
    const id = `false_111222333@lid_LIVETWO${Date.now()}`;
    const json = await postDm(request, "done 👍", id, { quotedMessageId: stanza, quotedText: chase, quotedFromMatchTime: true });
    console.log(`[paid-claim-live] TWO OWED: ${JSON.stringify(json)}`);
    expect(json.handled).toBe("paid-claim");
    expect(json.matchId).toBe(older);
    const olderRow = await db.one<{ directPendingAt: Date | null }>(
      `SELECT "directPendingAt" FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
      [older, U.player],
    );
    expect(olderRow?.directPendingAt).not.toBeNull();
    expect((await row(db))?.directPendingAt).toBeNull();
  });
});
