/**
 * SELF-JOIN SLICE 1: the silence rails, against a real Postgres and the
 * real routes. Plan: MDs/self-join-and-approval-plan-2026-09-28.md,
 * sections 3.1, 4.3 and 12.
 *
 * A club waiting for approval (or rejected, or suspended), and a group
 * nobody asked MatchTime into, must produce no post, no DM, no session
 * and no model call. And the seeded club, which stands in for Sutton FC,
 * must behave exactly as before: it is "approved" by the column default.
 *
 * The e2e server runs with SELF_JOIN_ENABLED unset (off) and
 * ONBOARDING_AUTOSTART=1, which is the combination in which today's
 * in-group setup is most able to fire. The self-join-ON branches are
 * unit-tested (src/lib/__tests__/club-approval.test.ts and the route
 * tests beside orgs/ and bot-added/).
 *
 * Deterministic end to end: no model is involved in anything asserted.
 */
import { test, expect, resetDb } from "../fixtures";
import { ORG_ID } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { testDb, type TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const HEADERS = { "x-api-key": E2E.WHATSAPP_API_KEY };

const PENDING_ORG = "e2e-selfjoin-pending";
const PENDING_GROUP = "120363900000000001@g.us";
const STRANGER_GROUP = "120363900000000002@g.us";
const ORGANISER = "e2e-selfjoin-organiser";
const ORGANISER_PHONE = "+447700900951";
const PENDING_ACTIVITY = "e2e-selfjoin-activity";
const PENDING_MATCH = "e2e-selfjoin-match";

let n = 0;
const msgId = () => `e2e-selfjoin-${Date.now()}-${++n}`;

async function orgs(request: APIRequestContext) {
  const res = await request.get("/api/whatsapp/orgs", { headers: HEADERS });
  expect(res.status(), await res.text()).toBe(200);
  return res.json() as Promise<{
    orgs: Array<{ id: string; whatsappGroupId: string }>;
    onboardingGroups: string[];
    silentGroups: string[];
    legacySetupTrigger: boolean;
  }>;
}

async function analyze(request: APIRequestContext, groupId: string, body: string) {
  const res = await request.post("/api/whatsapp/analyze", {
    headers: HEADERS,
    data: {
      groupId,
      messages: [
        { waMessageId: msgId(), body, authorPhone: "447700900952", authorName: "Someone", timestamp: new Date().toISOString() },
      ],
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function sessionsFor(db: TestDb, groupId: string) {
  return db.count(`SELECT COUNT(*) FROM "OnboardingSession" WHERE "whatsappGroupId" = $1`, [groupId]);
}

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  // A self-join club waiting for approval: bot off (the CHECK constraint
  // forbids anything else), its group named only by the connect request.
  await db.run(
    `INSERT INTO "Organisation" ("id","name","slug","inviteCode","approvalStatus","createdAt","updatedAt")
     VALUES ($1,'Riverside FC',$1,$2,'pending',now(),now())`,
    [PENDING_ORG, `${PENDING_ORG}-invite`],
  );
  await db.run(
    `INSERT INTO "User" (id, name, email, "phoneNumber", onboarded, "isActive", "updatedAt")
     VALUES ($1,'Ali Organiser','selfjoin-organiser@e2e-test.invalid',$2,true,true,now())`,
    [ORGANISER, ORGANISER_PHONE],
  );
  await db.run(
    `INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1,$2,$3,'OWNER')`,
    [`${ORGANISER}-mem`, ORGANISER, PENDING_ORG],
  );
  await db.run(
    `INSERT INTO "ClubConnect" (id,"orgId","userId",phone,code,status,"expiresAt","groupId","groupSubject","linkedAt","updatedAt")
     VALUES ('e2e-connect-1',$1,$2,'447700900951','7KQ2','group_linked',now() + interval '1 hour',$3,'Riverside Tuesday 5s',now(),now())`,
    [PENDING_ORG, ORGANISER, PENDING_GROUP],
  );
  // Somebody added MatchTime to a group with no code at all.
  await db.run(
    `INSERT INTO "UnsolicitedGroup" (id,"groupId",subject) VALUES ('e2e-unsolicited-1',$1,'Random lads')`,
    [STRANGER_GROUP],
  );
  // The weekly game set up on the website before the button (decision 2),
  // and a finished match, to prove the crons leave the club alone.
  await db.run(
    `INSERT INTO "Sport" ("id","orgId","name","playersPerTeam","positions","teamLabels","createdAt","updatedAt")
     VALUES ($1,$2,'Football 5-a-side',5,ARRAY['GK','DEF','MID','FWD'],ARRAY['Red','Yellow'],now(),now())`,
    [`${PENDING_ORG}-sport`, PENDING_ORG],
  );
  await db.run(
    `INSERT INTO "Activity" ("id","orgId","sportId","name","dayOfWeek","time","venue","isActive","deadlineHours","createdAt","updatedAt")
     VALUES ($1,$2,$3,'Riverside weekly',1,'20:00','Riverside Park',true,5,now(),now())`,
    [PENDING_ACTIVITY, PENDING_ORG, `${PENDING_ORG}-sport`],
  );
  await db.run(
    `INSERT INTO "Match" (id,"activityId",date,"maxPlayers",status,"attendanceDeadline","updatedAt")
     VALUES ($1,$2,now() - interval '1 day',10,'UPCOMING',now() - interval '2 days',now())`,
    [PENDING_MATCH, PENDING_ACTIVITY],
  );
});

test.afterAll(async () => {
  resetDb();
});

test.describe("the database invariant", () => {
  test("every pre-existing club is approved by the column default (the Sutton FC shape)", async ({ db }) => {
    const row = await db.one<{ approvalStatus: string; approvedAt: Date | null; whatsappBotEnabled: boolean }>(
      `SELECT "approvalStatus","approvedAt","whatsappBotEnabled" FROM "Organisation" WHERE id = $1`,
      [ORG_ID],
    );
    expect(row).toEqual({ approvalStatus: "approved", approvedAt: null, whatsappBotEnabled: true });
  });

  test("the bot cannot be switched ON for a club that is not approved", async ({ db }) => {
    await expect(
      db.run(`UPDATE "Organisation" SET "whatsappBotEnabled" = true WHERE id = $1`, [PENDING_ORG]),
    ).rejects.toThrow(/Organisation_bot_requires_approval/);
  });

  test("a live club cannot be moved out of approved while its bot is on", async ({ db }) => {
    await expect(
      db.run(`UPDATE "Organisation" SET "approvalStatus" = 'suspended' WHERE id = $1`, [ORG_ID]),
    ).rejects.toThrow(/Organisation_bot_requires_approval/);
  });

  test("only the five states exist", async ({ db }) => {
    await expect(
      db.run(`UPDATE "Organisation" SET "approvalStatus" = 'maybe' WHERE id = $1`, [PENDING_ORG]),
    ).rejects.toThrow(/Organisation_approvalStatus_check/);
  });
});

test.describe("what the Pi is told", () => {
  test("/orgs lists the seeded club as before, and the two silent groups", async ({ request }) => {
    const body = await orgs(request);
    expect(body.orgs.map((o) => o.id)).toContain(ORG_ID);
    expect(body.orgs.map((o) => o.id)).not.toContain(PENDING_ORG);
    expect(body.silentGroups.sort()).toEqual([PENDING_GROUP, STRANGER_GROUP].sort());
    expect(body.legacySetupTrigger).toBe(true);
    const seeded = body.orgs.find((o) => o.id === ORG_ID)!;
    expect(body.silentGroups).not.toContain(seeded.whatsappGroupId);
  });
});

test.describe("the server refuses silent groups", () => {
  for (const [label, groupId] of [
    ["a pending club's group", PENDING_GROUP],
    ["an unsolicited group", STRANGER_GROUP],
  ] as const) {
    test(`"@MatchTime setup" in ${label} starts nothing`, async ({ request, db }) => {
      const res = await analyze(request, groupId, "@MatchTime setup");
      expect(res.ignored).toBe("silent-group");
      expect(res.results).toEqual([]);
      expect(await sessionsFor(db, groupId)).toBe(0);
    });

    test(`being added to ${label} posts no intro and opens no session`, async ({ request, db }) => {
      const res = await request.post("/api/whatsapp/bot-added", {
        headers: HEADERS,
        data: { groupId, groupSubject: "Riverside Tuesday 5s", addedByPhone: "447700900951" },
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.introText).toBeNull();
      expect(body.ignored).toBe("silent-group");
      expect(await sessionsFor(db, groupId)).toBe(0);
    });
  }

  test("an organiser whose only club is pending gets nothing back by DM", async ({ request, db }) => {
    const res = await request.post("/api/whatsapp/dm-reply", {
      headers: HEADERS,
      data: { phone: ORGANISER_PHONE, body: "hi, when do we play?", waMessageId: msgId(), authorName: "Ali" },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).ignored).toBe("club-not-approved");
    expect(await db.count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1`, [PENDING_ORG])).toBe(0);
  });
});

test.describe("crons skip a club that is not approved", () => {
  test("generate-matches makes no fixture for it and says why", async ({ request, db }) => {
    const res = await request.get("/api/cron/generate-matches", {
      headers: { authorization: `Bearer ${E2E.CRON_SECRET}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.skippedNotApprovedOrgs).toBeGreaterThanOrEqual(1);
    expect(
      await db.count(`SELECT COUNT(*) FROM "Match" WHERE "activityId" = $1 AND id <> $2`, [
        PENDING_ACTIVITY,
        PENDING_MATCH,
      ]),
    ).toBe(0);
  });

  test("complete-matches leaves its finished match alone", async ({ request, db }) => {
    const res = await request.get("/api/cron/complete-matches", {
      headers: { authorization: `Bearer ${E2E.CRON_SECRET}` },
    });
    expect(res.status()).toBe(200);
    const row = await db.one<{ status: string }>(`SELECT status FROM "Match" WHERE id = $1`, [PENDING_MATCH]);
    expect(row?.status).toBe("UPCOMING");
  });
});
