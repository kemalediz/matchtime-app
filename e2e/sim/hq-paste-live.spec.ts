/**
 * A LIST PASTED IN HQ, THE PAID CHECK (2026-10-29): the FNF incident through
 * the real route and the REAL HQ squad reader, router and extractors (no
 * stub). A copy of the teams sheet and a "Swap / names / With / names" list
 * change nobody's place; a real squad list is still proposed with the right
 * changes. Stubbed, the same is pinned in e2e/api/admin-group-paste-teams.spec.ts.
 *
 * Opt in: MT_SIM_LIVE_LLM=1 (spends ANTHROPIC_API_KEY_DEV). Skipped otherwise.
 *
 *   MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/hq-paste-live.spec.ts
 *
 * Prints the model calls and cost the club was billed (OrgAiUsage).
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { MATCH, ORG_ID, PHONE, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import type { TestDb } from "../helpers/test-db";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000073@g.us";
const ADMIN = PHONE.admin.replace(/^\+/, "");

const SHEET = "📝 *Proposed teams*: 22:00 at Hackney Marshes\n\n*Red*:\n1. Alex Admin\n2. Colin Collector\n\n*Yellow*:\n1. Pat Player\n2. Tom Third\n\nTo change them, just tell me in your own words (for example *swap Alex and Pat*).\nReply *YES* when they are final. I won't post them in the players' group.";
const PASTED_BACK = "Here’s the teams: \n\n*Red*:\n1. Alex Admin\n2. Colin Collector\n\n*Yellow*:\n1. Pat Player\n2. Tom Third";
const SWAP = "Swap \nAlex\nColin\n\nWith \n\nPat\nTom";
const REAL = "Squad for Friday\n1. Alex Admin\n2. Colin Collector\n3. Pat Player\n4. Ben Bench";

let seq = 0;
async function say(request: APIRequestContext, text: string) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", groupId: HQ, messageId: `e2e-live-paste-${++seq}`, text, senderPhone: ADMIN, timestamp: String(Math.floor(Date.now() / 1000)) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}
const statusOf = async (db: TestDb, userId: string) =>
  (await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, userId]))?.status ?? null;
const proposals = (db: TestDb) => db.count(`SELECT count(*) FROM "AdminSquadProposal" WHERE "orgId" = $1`, [ORG_ID]);
const usage = async (db: TestDb) =>
  db.one<{ calls: number; cost: number }>(`SELECT sum(calls)::int AS calls, sum("costUsd")::float AS cost FROM "OrgAiUsage" WHERE "orgId" = $1`, [ORG_ID]);

(LIVE ? test.describe : test.describe.skip)("a list pasted in HQ, LIVE (real model)", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ db }) => {
    resetDb();
    await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
    for (const [i, [userId, team]] of ([[U.admin, "RED"], [U.collector, "RED"], [U.player, "YELLOW"], [U.third, "YELLOW"]] as const).entries()) {
      await db.run(`INSERT INTO "TeamAssignment" (id, "matchId", "userId", team) VALUES ($1, $2, $3, $4::"Team")`, [`e2e-live-ta-${i}`, MATCH.upcoming, userId, team]);
    }
    await db.run(`INSERT INTO "AdminTeamProposal" (id, "orgId", "matchId", state, "askedAt", "updatedAt") VALUES ('e2e-live-tp', $1, $2, 'proposed', now(), now())`, [ORG_ID, MATCH.upcoming]);
    await db.run(
      `INSERT INTO "AdminGroupMessage" (id, "orgId", "waMessageId", "fromMatchTime", text, "askRef", "createdAt") VALUES ('e2e-live-log', $1, 'mt:teams:e2e-live', true, $2, $3, now())`,
      [ORG_ID, SHEET, `teams:${MATCH.upcoming}`],
    );
  });
  test.afterAll(async ({ db }) => {
    const u = await usage(db);
    console.log(`[live] total model calls: ${u?.calls ?? 0}, cost: $${(u?.cost ?? 0).toFixed(5)}`);
    resetDb();
  });

  test("the teams sheet pasted back: no squad proposal, nobody dropped", async ({ request, db }) => {
    const out = await say(request, PASTED_BACK);
    console.log(`[live] teams sheet: ${JSON.stringify(out)}`);
    expect(String(out.outcome ?? "")).not.toMatch(/^paste-/);
    expect(await proposals(db)).toBe(0);
    for (const u of [U.admin, U.collector, U.player, U.third]) expect(await statusOf(db, u)).toBe("CONFIRMED");
  });

  test("Swap / names / With / names: no squad proposal, nobody called Swap or With", async ({ request, db }) => {
    const out = await say(request, SWAP);
    console.log(`[live] swap list: ${JSON.stringify(out)}`);
    expect(String(out.outcome ?? "")).not.toMatch(/^paste-/);
    expect(await proposals(db)).toBe(0);
    expect(await db.count(`SELECT count(*) FROM "User" WHERE name IN ('Swap', 'With')`)).toBe(0);
    for (const u of [U.admin, U.collector, U.player, U.third]) expect(await statusOf(db, u)).toBe("CONFIRMED");
  });

  test("a real squad list: Ben in, Tom out, proposed for YES", async ({ request }) => {
    const out = await say(request, REAL);
    console.log(`[live] real list: ${JSON.stringify(out)}`);
    expect(out).toMatchObject({ handled: true, outcome: "paste-proposed" });
    expect(out.replyText).toMatch(/^Adding: Ben Bench\. Removing: Tom Third\. Reply YES to apply\./);
  });
});
