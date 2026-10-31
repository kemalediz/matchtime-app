/**
 * ATTENDANCE IN THE ADMIN GROUP FROM A PLAYER: THE PAID CHECK (2026-10-20).
 *
 * The incident, once, through the real route and the REAL router and
 * attendance extractor (no stub): in FNF HQ Abdul-Hafeez Niaz, a PLAYER,
 * wrote "Naim is out" and nothing happened. Since Kemal and FNF's Raihan
 * agreed that anyone in HQ changes who plays, Naim is taken out, with the
 * organiser's reply, recorded as the player's. Since 2026-10-31 HQ answers
 * only a real tag, so the message tags MatchTime.
 *
 * Opt in: MT_SIM_LIVE_LLM=1 (spends ANTHROPIC_API_KEY_DEV). Skipped otherwise.
 *
 *   MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/hq-attendance-anyone-live.spec.ts
 *
 * Prints the model calls and cost the club was billed (OrgAiUsage).
 */
import { test, expect, resetDb } from "../fixtures";
import { MATCH, ORG_ID, PHONE, U } from "../helpers/constants";
import { E2E } from "../helpers/env";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000072@g.us";

(LIVE ? test.describe : test.describe.skip)("a player's 'Naim is out' in HQ, LIVE (real model)", () => {
  test.beforeAll(async ({ db }) => {
    resetDb();
    await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
    // Tom Third plays the part of Naim.
    await db.run(`UPDATE "User" SET name = 'Naim Newman' WHERE id = $1`, [U.third]);
  });
  test.afterAll(() => resetDb());

  test("Naim is out, from Pat Player (a PLAYER): Naim dropped, the organiser's reply, recorded as Pat's", async ({ request, db }) => {
    const messageId = "e2e-live-hq-naim-out";
    const res = await request.post("/api/whatsapp/admin-group", {
      headers: KEY,
      data: {
        channel: "admin-group",
        botMentioned: true,
        groupId: HQ,
        messageId,
        text: "@Match Time Naim is out",
        senderPhone: PHONE.player.replace(/^\+/, ""),
        timestamp: String(Math.floor(Date.now() / 1000)),
      },
    });
    expect(res.status(), await res.text()).toBe(200);
    const out = await res.json();
    const usage = await db.one<{ calls: number; cost: number }>(`SELECT sum(calls)::int AS calls, sum("costUsd")::float AS cost FROM "OrgAiUsage" WHERE "orgId" = $1`, [ORG_ID]);
    console.log(`[live] reply: ${JSON.stringify(out)}`);
    console.log(`[live] model calls: ${usage?.calls ?? 0}, cost: $${(usage?.cost ?? 0).toFixed(5)}`);
    expect(out).toMatchObject({ handled: true, outcome: "squad-changed", replyText: "Done: Naim Newman out. 3 of 5, 1 on the bench (Ben Bench).", react: "✅" });
    const row = await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, U.third]);
    expect(row?.status).toBe("DROPPED");
    const ev = await db.one<{ actorUserId: string; sourceRef: string }>(
      `SELECT "actorUserId", "sourceRef" FROM "AttendanceEvent" WHERE "matchId" = $1 AND "userId" = $2 ORDER BY at DESC LIMIT 1`,
      [MATCH.upcoming, U.third],
    );
    expect(ev).toMatchObject({ actorUserId: U.player, sourceRef: `admin-group:${messageId}` });
  });
});
