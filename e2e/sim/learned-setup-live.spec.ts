/**
 * THE SETUP READING, END TO END, ON THE REAL MODEL (2026-10-22).
 *
 * e2e/api/learned-setup.spec.ts proves the cron route with the model
 * STUBBED. This is the same path with nothing stubbed: a self-join club
 * approved this morning, the rolling fixture's chat stored on its connect
 * request, one sweep of /api/cron/learn-setup, and the real
 * SETUP_LEARNING_SYSTEM_PROMPT read by Haiku 5.5. The chat says "same
 * squad, shout if you can't make it" in two weeks, so rolling squad is
 * switched on and the organiser is told once.
 *
 *   MT_SIM_LIVE_LLM=1 tsx e2e/run.ts sim/learned-setup-live.spec.ts
 *
 * Skipped unless MT_SIM_LIVE_LLM=1. Spends ANTHROPIC_API_KEY_DEV only
 * (e2e/run.ts refuses the production key). One reading: about $0.002.
 */
import { test, expect, resetDb } from "../fixtures";
import { E2E, REPO_ROOT } from "../helpers/env";
import { testDb } from "../helpers/test-db";
import { readFileSync } from "node:fs";
import path from "node:path";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

const rolling = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "src/lib/setup-learning/__fixtures__/rolling.json"), "utf8"),
) as { history: unknown[] };

const NOW = "2026-10-05T11:00:00Z";
const APPROVED = "2026-10-05T09:00:00Z";
const C = { org: "e2e-learn-live", owner: "e2e-learn-live-owner", phone: "+447700900991" };

(LIVE ? test.describe : test.describe.skip)("the setup reading LIVE (real Anthropic, no stub)", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    resetDb();
    const db = testDb();
    await db.run(
      `INSERT INTO "User" (id, name, email, "phoneNumber", onboarded, "isActive", "updatedAt") VALUES ($1,'Steve Hart',$2,$3,true,true,now())`,
      [C.owner, `${C.owner}@e2e-test.invalid`, C.phone],
    );
    await db.run(
      `INSERT INTO "Organisation" ("id","name","slug","inviteCode","approvalStatus","approvedAt","whatsappGroupId",
         "whatsappBotEnabled","language","settingsSetByOrganiser","createdAt","updatedAt")
       VALUES ($1,'Tuesday Night 6s',$1,$2,'approved',$3,$4,true,'en','{}',now(),now())`,
      [C.org, `${C.org}-invite`, APPROVED, `${C.org}@g.us`],
    );
    await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1,$2,$3,'OWNER')`, [`${C.owner}-mem`, C.owner, C.org]);
    await db.run(
      `INSERT INTO "Sport" ("id","orgId","name","playersPerTeam","positions","teamLabels","createdAt","updatedAt")
       VALUES ($1,$2,'Football 6-a-side',6,ARRAY['GK','DEF','MID','FWD'],ARRAY['Red','Yellow'],now(),now())`,
      [`${C.org}-sport`, C.org],
    );
    await db.run(
      `INSERT INTO "Activity" ("id","orgId","sportId","name","dayOfWeek","time","venue","isActive","deadlineHours","createdAt","updatedAt")
       VALUES ($1,$2,$3,'Weekly game',2,'21:00','Goals North Cheam',true,5,now(),now())`,
      [`${C.org}-activity`, C.org, `${C.org}-sport`],
    );
    await db.run(
      `INSERT INTO "ClubConnect" ("id","orgId","userId","phone","code","status","expiresAt","groupId","groupSubject","linkedAt",
         "capturedHistory","updatedAt")
       VALUES ($1,$2,$3,$4,'7KQ3','closed',$5,$6,'Tuesday Night 6s',$5,$7::jsonb,now())`,
      [`${C.org}-cc`, C.org, C.owner, C.phone.replace(/^\+/, ""), APPROVED, `${C.org}@g.us`, JSON.stringify(rolling.history)],
    );
  });

  test("one sweep reads the chat with the real model, switches rolling squad on and queues one DM", async ({ request }) => {
    const res = await request.get("/api/cron/learn-setup", {
      headers: { authorization: `Bearer ${E2E.CRON_SECRET}`, "x-test-now": NOW, "x-mt-test-setup-learning": "1" },
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    console.log("[learned-setup-live] sweep:", JSON.stringify(body));

    const db = testDb();
    const learning = await db.one<{ status: string; applied: Array<{ key: string }>; costUsd: number; detection: unknown }>(
      `SELECT * FROM "ClubSetupLearning" WHERE "orgId" = $1`,
      [C.org],
    );
    console.log("[learned-setup-live] recorded:", JSON.stringify(learning));
    expect(learning?.status).toBe("applied");
    expect(learning?.applied.map((a) => a.key)).toContain("rollingSquad");
    // A real call was made and priced (a stub costs nothing).
    expect(Number(learning?.costUsd)).toBeGreaterThan(0);
    const org = await db.one<{ rollingSquadEnabled: boolean }>(`SELECT "rollingSquadEnabled" FROM "Organisation" WHERE id = $1`, [C.org]);
    expect(org?.rollingSquadEnabled).toBe(true);
    const dms = await db.all<{ text: string }>(
      `SELECT text FROM "PlatformJob" WHERE purpose = 'setup-learned' AND phone = $1`,
      [C.phone.replace(/^\+/, "")],
    );
    expect(dms).toHaveLength(1);
    console.log("[learned-setup-live] DM:\n" + dms[0].text);
  });
});
