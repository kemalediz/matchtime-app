/**
 * A GAME THAT DID NOT HAPPEN: THE PAID END-TO-END CHECK (2026-10-28).
 *
 * Once each, through the real routes and the REAL router and admin
 * extractor (no stub):
 *   - HQ: an owner's "@Match Time last night's game didn't happen" marks the
 *     fixture's game of last night as not played, and HQ hears the reply;
 *   - the players' group of a club with no HQ: "@Match Time salı maçı
 *     olmadı, iptal et" said of that game the same way, the reply in the
 *     group (the game is moved to the last Tuesday for this one).
 *
 * Opt in: MT_SIM_LIVE_LLM=1 (spends ANTHROPIC_API_KEY_DEV). Skipped otherwise.
 *
 *   MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/not-played-live.spec.ts
 *
 * Prints the model calls and cost the club was billed (OrgAiUsage).
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { MATCH, NAME, ORG_ID, PHONE } from "../helpers/constants";
import { E2E } from "../helpers/env";
import type { TestDb } from "../helpers/test-db";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000074@g.us";

const usage = (db: TestDb) =>
  db.one<{ calls: number; cost: number }>(`SELECT sum(calls)::int AS calls, sum("costUsd")::float AS cost FROM "OrgAiUsage" WHERE "orgId" = $1`, [ORG_ID]);
const status = async (db: TestDb) => (await db.one<{ status: string }>(`SELECT status::text AS status FROM "Match" WHERE id = $1`, [MATCH.rate]))!.status;

(LIVE ? test.describe : test.describe.skip)("a game that did not happen, LIVE (real model)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(async ({ db }) => {
    resetDb();
    // The rate match (last night, 20:00 London) is the game, unscored; the
    // pay match is moved out of the 7-day window.
    await db.run(`UPDATE "Match" SET "redScore" = NULL, "yellowScore" = NULL, "eloApplied" = NULL, status = 'COMPLETED' WHERE id = $1`, [MATCH.rate]);
    await db.run(`UPDATE "Match" SET date = now() - interval '10 days' WHERE id = $1`, [MATCH.pay]);
  });
  test.afterAll(() => resetDb());

  test("HQ: an owner's 'last night's game didn't happen'", async ({ request, db }) => {
    await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
    const res = await request.post("/api/whatsapp/admin-group", {
      headers: KEY,
      data: {
        channel: "admin-group",
        groupId: HQ,
        messageId: "e2e-live-notplayed-hq",
        text: "@Match Time last night's game didn't happen",
        senderPhone: PHONE.admin.replace(/^\+/, ""),
        timestamp: String(Math.floor(Date.now() / 1000)),
      },
    });
    expect(res.status(), await res.text()).toBe(200);
    const out = await res.json();
    const u = await usage(db);
    console.log(`[live] HQ: ${JSON.stringify(out)}`);
    console.log(`[live] model calls so far: ${u?.calls ?? 0}, cost: $${(u?.cost ?? 0).toFixed(5)}`);
    expect(out).toMatchObject({ handled: true, outcome: "hq-match-not-played", react: "✅" });
    expect(out.replyText).toMatch(/is marked as not played: no score, ratings or Man of the Match for it\.$/);
    expect(await status(db)).toBe("CANCELLED");
  });

  test("the players' group, Turkish: 'salı maçı olmadı, iptal et'", async ({ request, db }) => {
    await db.run(`UPDATE "Organisation" SET "adminGroupId" = NULL, language = 'tr' WHERE id = $1`, [ORG_ID]);
    // The game on the most recent Tuesday before today (London), 20:00.
    await db.run(
      `UPDATE "Match" SET date = ((date_trunc('day', now() AT TIME ZONE 'Europe/London') - (((extract(isodow FROM now() AT TIME ZONE 'Europe/London')::int - 2 + 7) % 7 + CASE WHEN extract(isodow FROM now() AT TIME ZONE 'Europe/London')::int = 2 THEN 7 ELSE 0 END) * interval '1 day') + interval '20 hours') AT TIME ZONE 'Europe/London') WHERE id = $1`,
      [MATCH.rate],
    );
    const id = `e2e-live-notplayed-pg-${Date.now()}`;
    const res = await postAnalyze(request, [{ waMessageId: id, body: "@Match Time salı maçı olmadı, iptal et", authorPhone: PHONE.admin, authorName: NAME.admin, botMentioned: true }]);
    const out = res.results.find((r: { waMessageId: string }) => r.waMessageId === id);
    const u = await usage(db);
    console.log(`[live] players' group: ${JSON.stringify(out)}`);
    console.log(`[live] model calls in total: ${u?.calls ?? 0}, cost: $${(u?.cost ?? 0).toFixed(5)}`);
    expect(out).toMatchObject({ react: "✅", intent: "match_not_played" });
    expect(out.reply).toMatch(/oynanmadı olarak işaretlendi: skor, puanlama ya da maçın adamı yok\./);
    expect(await status(db)).toBe("CANCELLED");
  });
});
