/**
 * AN ORGANISERS' JOB ASKED FOR IN HQ: THE PAID CHECK (2026-10-20; since
 * 2026-10-31 HQ answers only a real tag, so the ask is tagged).
 *
 * Once each, through the real route and the REAL router (no stub):
 *   - a PLAYER asks MatchTime, tagged, to change the fee: the router must
 *     read it as admin_ops, and the player hears the one line naming who
 *     can;
 *   - an organiser's untagged chat with the other organisers about the
 *     fee: silent, and no model is asked at all.
 *
 * Opt in: MT_SIM_LIVE_LLM=1 (spends ANTHROPIC_API_KEY_DEV). Skipped otherwise.
 *
 *   MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/hq-organisers-only-untagged-live.spec.ts
 *
 * Prints the model calls and cost the club was billed (OrgAiUsage).
 */
import { test, expect, resetDb } from "../fixtures";
import { ORG_ID, PHONE } from "../helpers/constants";
import { E2E } from "../helpers/env";
import type { APIRequestContext } from "@playwright/test";
import type { TestDb } from "../helpers/test-db";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000073@g.us";

async function say(request: APIRequestContext, messageId: string, text: string, phone: string) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", botMentioned: text.includes("@Match Time"), groupId: HQ, messageId, text, senderPhone: phone.replace(/^\+/, ""), timestamp: String(Math.floor(Date.now() / 1000)) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const usage = (db: TestDb) =>
  db.one<{ calls: number; cost: number }>(`SELECT sum(calls)::int AS calls, sum("costUsd")::float AS cost FROM "OrgAiUsage" WHERE "orgId" = $1`, [ORG_ID]);

(LIVE ? test.describe : test.describe.skip)("an organisers' job asked for in HQ, untagged, LIVE (real model)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(async ({ db }) => {
    resetDb();
    await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
  });
  test.afterAll(() => resetDb());

  test("a player, tagged: 'can you change the match fee to £6 from this week' gets the one line", async ({ request, db }) => {
    const out = await say(request, "e2e-live-hq-fee-ask", "@Match Time can you change the match fee to £6 from this week", PHONE.player);
    const u = await usage(db);
    console.log(`[live] player fee ask: ${JSON.stringify(out)}`);
    console.log(`[live] model calls so far: ${u?.calls ?? 0}, cost: $${(u?.cost ?? 0).toFixed(5)}`);
    expect(out).toMatchObject({ handled: true, outcome: "hq-only-organisers", replyText: "Only Alex can change that.", react: null });
  });

  test("an organiser's untagged chat with the other organisers: silent", async ({ request, db }) => {
    const out = await say(request, "e2e-live-hq-fee-chat", "do you think we should put the fee up next month? pitch went up again", PHONE.admin);
    const u = await usage(db);
    console.log(`[live] organiser chat: ${JSON.stringify(out)}`);
    console.log(`[live] model calls in total: ${u?.calls ?? 0}, cost: $${(u?.cost ?? 0).toFixed(5)}`);
    expect(out).toMatchObject({ handled: false, replyText: null });
  });
});
