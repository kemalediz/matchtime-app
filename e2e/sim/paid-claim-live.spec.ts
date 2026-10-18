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
 *
 * Once each (Kemal's cheap test plan). Opt-in: only runs when
 * MT_SIM_LIVE_LLM=1, on the developer key.
 *
 *   MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/paid-claim-live.spec.ts
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { U, ORG_ID, PHONE, MATCH } from "../helpers/constants";
import { E2E } from "../helpers/env";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

(LIVE ? test.describe : test.describe.skip)("payment claim LIVE (real Anthropic model)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(resetDb);

  async function postDm(request: APIRequestContext, body: string, waMessageId: string) {
    const res = await request.post("/api/whatsapp/dm-reply", {
      headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
      data: { phone: PHONE.player, body, waMessageId, authorName: null },
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
});
