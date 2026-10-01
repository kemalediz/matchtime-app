/**
 * CLUB FEE BILLING, slice B1: the quiet gate, against a real Postgres and
 * the real routes. Plan: MDs/club-fee-billing-plan-2026-10-01.md, 4.3, 4.4.
 *
 * A club paused for the club fee must produce no post, no reply, no
 * fixture and no model call, while staying in the group with all its data.
 * The seeded club, which stands in for Sutton FC, is "exempt" by the
 * column default and must behave exactly as before.
 *
 * The e2e server runs with BILLING_ENABLED=1 (e2e/helpers/env.ts), so
 * every gate here runs its flag-ON branch. The flag-OFF branch (a paused
 * club served exactly like an approved one, every query byte for byte
 * today's) is pinned by the unit tests: src/lib/__tests__/club-billing-gates.test.ts,
 * ai-budget.test.ts, orgs-route.test.ts and crons-skip-unapproved.test.ts.
 *
 * Deterministic end to end: no model is involved in anything asserted.
 */
import { test, expect, resetDb } from "../fixtures";
import { ORG_ID, PHONE } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { testDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const HEADERS = { "x-api-key": E2E.WHATSAPP_API_KEY };
const CRON = { authorization: `Bearer ${E2E.CRON_SECRET}` };

const PAUSED_ORG = "e2e-billing-paused";
const PAUSED_GROUP = "120363900000000101@g.us";
const PAUSED_ACTIVITY = "e2e-billing-paused-activity";
const PAUSED_MATCH = "e2e-billing-paused-match";
const PAUSED_PLAYER = "e2e-billing-paused-player";
const PAUSED_PHONE = "+447700900961";

// A club that was paused and has just been resumed (4.4): what
// `resumeClub` leaves behind for a match that kicked off during the pause.
const RESUMED_ORG = "e2e-billing-resumed";
const RESUMED_GROUP = "120363900000000102@g.us";
const RESUMED_ACTIVITY = "e2e-billing-resumed-activity";
const QUIET_MATCH = "e2e-billing-quiet-match";
const CONTROL_MATCH = "e2e-billing-control-match";

let n = 0;
const msgId = () => `e2e-billing-${Date.now()}-${++n}`;

async function orgs(request: APIRequestContext) {
  const res = await request.get("/api/whatsapp/orgs", { headers: HEADERS });
  expect(res.status(), await res.text()).toBe(200);
  return res.json() as Promise<{ orgs: Array<{ id: string; whatsappGroupId: string }>; silentGroups: string[] }>;
}

async function analyze(request: APIRequestContext, groupId: string, body: string, authorPhone: string) {
  const res = await request.post("/api/whatsapp/analyze", {
    headers: HEADERS,
    data: {
      groupId,
      messages: [{ waMessageId: msgId(), body, authorPhone, authorName: "Someone", timestamp: new Date().toISOString() }],
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function dm(request: APIRequestContext, phone: string, body: string) {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: HEADERS,
    data: { phone, body, waMessageId: msgId(), authorName: "Someone" },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function seedClub(id: string, group: string, billingStatus: string, activityId: string) {
  const db = testDb();
  await db.run(
    `INSERT INTO "Organisation" ("id","name","slug","inviteCode","approvalStatus","approvedAt","whatsappGroupId",
       "whatsappBotEnabled","billingStatus","createdAt","updatedAt")
     VALUES ($1,$2,$1,$3,'approved',now() - interval '40 days',$4,true,$5,now(),now())`,
    [id, `Billing ${billingStatus} FC`, `${id}-invite`, group, billingStatus],
  );
  await db.run(
    `INSERT INTO "ClubBilling" ("orgId","trialStartedAt","trialEndsAt","graceEndsAt","pausedAt","pausedReason","updatedAt")
     VALUES ($1, now() - interval '40 days', now() - interval '10 days', now() - interval '3 days',
       CASE WHEN $2 = 'paused' THEN now() - interval '3 days' END,
       CASE WHEN $2 = 'paused' THEN 'no-card' END, now())`,
    [id, billingStatus],
  );
  await db.run(
    `INSERT INTO "Sport" ("id","orgId","name","playersPerTeam","positions","teamLabels","createdAt","updatedAt")
     VALUES ($1,$2,'Football 5-a-side',5,ARRAY['GK','DEF','MID','FWD'],ARRAY['Red','Yellow'],now(),now())`,
    [`${id}-sport`, id],
  );
  await db.run(
    `INSERT INTO "Activity" ("id","orgId","sportId","name","dayOfWeek","time","venue","isActive","deadlineHours","createdAt","updatedAt")
     VALUES ($1,$2,$3,'Weekly game',1,'20:00','Park',true,5,now(),now())`,
    [activityId, id, `${id}-sport`],
  );
}

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await seedClub(PAUSED_ORG, PAUSED_GROUP, "paused", PAUSED_ACTIVITY);
  await db.run(
    `INSERT INTO "User" (id, name, email, "phoneNumber", onboarded, "isActive", "updatedAt")
     VALUES ($1,'Paula Paused','billing-paused@e2e-test.invalid',$2,true,true,now())`,
    [PAUSED_PLAYER, PAUSED_PHONE],
  );
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1,$2,$3,'PLAYER')`, [
    `${PAUSED_PLAYER}-mem`,
    PAUSED_PLAYER,
    PAUSED_ORG,
  ]);
  // A finished match, to prove the completion cron leaves it alone.
  await db.run(
    `INSERT INTO "Match" (id,"activityId",date,"maxPlayers",status,"attendanceDeadline","updatedAt")
     VALUES ($1,$2,now() - interval '1 day',10,'UPCOMING',now() - interval '2 days',now())`,
    [PAUSED_MATCH, PAUSED_ACTIVITY],
  );
  // A BotJob queued before the pause: due-posts must never hand it out.
  await db.run(
    `INSERT INTO "BotJob" (id,"orgId",kind,text,"pollOptions") VALUES ('e2e-billing-job',$1,'group','queued before the pause','{}')`,
    [PAUSED_ORG],
  );

  // The resumed club: subscribed again. QUIET_MATCH is what resumeClub
  // wrote (completed, no post-match flow, score ask marked sent);
  // CONTROL_MATCH is the same match left as the cron would complete it.
  await seedClub(RESUMED_ORG, RESUMED_GROUP, "subscribed", RESUMED_ACTIVITY);
  for (const [id, quiet] of [
    [QUIET_MATCH, true],
    [CONTROL_MATCH, false],
  ] as const) {
    await db.run(
      `INSERT INTO "Match" (id,"activityId",date,"maxPlayers",status,"postMatchEndFlow","attendanceDeadline","updatedAt")
       VALUES ($1,$2,now() - interval '4 hours',10,'COMPLETED',$3,now() - interval '1 day',now())`,
      [id, RESUMED_ACTIVITY, !quiet],
    );
  }
  await db.run(
    `INSERT INTO "SentNotification" (id,key,kind,"matchId") VALUES ('e2e-billing-skip',$1,'billing-resume-skip',$2)`,
    [`${QUIET_MATCH}:ask-score`, QUIET_MATCH],
  );
});

test.afterAll(async () => {
  resetDb();
});

test.describe("the database invariant", () => {
  test("every pre-existing club is exempt by the column default (the Sutton FC shape)", async ({ db }) => {
    const row = await db.one<{ billingStatus: string; billingPlan: string; billingPricePence: number | null }>(
      `SELECT "billingStatus","billingPlan","billingPricePence" FROM "Organisation" WHERE id = $1`,
      [ORG_ID],
    );
    expect(row).toEqual({ billingStatus: "exempt", billingPlan: "standard", billingPricePence: null });
  });

  test("the database refuses to pause or bill a club that predates self-join (Sutton FC)", async ({ db }) => {
    for (const status of ["paused", "trial", "subscribed"]) {
      await expect(
        db.run(`UPDATE "Organisation" SET "billingStatus" = $2 WHERE id = $1`, [ORG_ID, status]),
      ).rejects.toThrow(/Organisation_billingPreSelfJoinExempt_check/);
    }
  });

  test("only the six states exist", async ({ db }) => {
    await expect(
      db.run(`UPDATE "Organisation" SET "billingStatus" = 'maybe' WHERE id = $1`, [PAUSED_ORG]),
    ).rejects.toThrow(/Organisation_billingStatus_check/);
  });

  test("a Free plan is always exempt", async ({ db }) => {
    await expect(
      db.run(`UPDATE "Organisation" SET "billingPlan" = 'free' WHERE id = $1`, [PAUSED_ORG]),
    ).rejects.toThrow(/Organisation_billingFreeExempt_check/);
  });

  test("a custom price only on a custom plan, and only 100 to 999 pence", async ({ db }) => {
    await expect(
      db.run(`UPDATE "Organisation" SET "billingPricePence" = 500 WHERE id = $1`, [ORG_ID]),
    ).rejects.toThrow(/Organisation_billingPricePence_check/);
    await expect(
      db.run(`UPDATE "Organisation" SET "billingPlan" = 'custom', "billingPricePence" = 50 WHERE id = $1`, [ORG_ID]),
    ).rejects.toThrow(/Organisation_billingPricePence_check/);
    await expect(
      db.run(`UPDATE "Organisation" SET "billingPlan" = 'custom' WHERE id = $1`, [ORG_ID]),
    ).rejects.toThrow(/Organisation_billingPricePence_check/);
  });
});

test.describe("what the Pi is told (4.3 points 2 and 3)", () => {
  test("/orgs drops the paused club's group and lists it as silent; the exempt club is served as before", async ({ request }) => {
    const body = await orgs(request);
    const ids = body.orgs.map((o) => o.id);
    expect(ids).toContain(ORG_ID);
    expect(ids).toContain(RESUMED_ORG);
    expect(ids).not.toContain(PAUSED_ORG);
    expect(body.silentGroups).toContain(PAUSED_GROUP);
    const seeded = body.orgs.find((o) => o.id === ORG_ID)!;
    expect(body.silentGroups).not.toContain(seeded.whatsappGroupId);
    expect(body.silentGroups).not.toContain(RESUMED_GROUP);
  });
});

test.describe("the server refuses a paused club anyway (4.3 point 4)", () => {
  test("due-posts: 404 for the paused club, never its queued job", async ({ request, db }) => {
    const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(PAUSED_GROUP)}`, {
      headers: HEADERS,
    });
    expect(res.status()).toBe(404);
    const job = await db.one<{ sentAt: Date | null }>(`SELECT "sentAt" FROM "BotJob" WHERE id = 'e2e-billing-job'`);
    expect(job?.sentAt).toBeNull();
  });

  test("due-posts: 200 for the exempt seeded club", async ({ request }) => {
    const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`, {
      headers: { ...HEADERS, "x-no-claim": "1" },
    });
    expect(res.status(), await res.text()).toBe(200);
  });

  test("analyze: the paused club's batch is ignored, nothing is recorded", async ({ request, db }) => {
    const body = await analyze(request, PAUSED_GROUP, "IN", PAUSED_PHONE.replace("+", ""));
    expect(body.ignored).toBe("unknown-or-disabled-group");
    expect(body.results).toEqual([]);
    expect(await db.count(`SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1`, [PAUSED_MATCH])).toBe(0);
    expect(
      await db.count(`SELECT COUNT(*) FROM "OnboardingSession" WHERE "whatsappGroupId" = $1`, [PAUSED_GROUP]),
    ).toBe(0);
  });

  test("analyze: even '@MatchTime setup' in a paused club's group starts no setup", async ({ request, db }) => {
    const body = await analyze(request, PAUSED_GROUP, "@MatchTime setup", "447700900962");
    expect(body.results).toEqual([]);
    expect(
      await db.count(`SELECT COUNT(*) FROM "OnboardingSession" WHERE "whatsappGroupId" = $1`, [PAUSED_GROUP]),
    ).toBe(0);
  });
});

test.describe("DMs (4.3 point 7)", () => {
  test("a member of only the paused club gets nothing back", async ({ request, db }) => {
    const before = await db.count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1`, [PAUSED_ORG]);
    const body = await dm(request, PAUSED_PHONE, "when do we play?");
    expect(body.ignored).toBe("club-billing-paused");
    expect(body.reply ?? null).toBeNull();
    expect(await db.count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1`, [PAUSED_ORG])).toBe(before);
  });

  test("a member of the exempt seeded club is answered as before", async ({ request }) => {
    const body = await dm(request, PHONE.player, "help");
    expect(body.ignored).not.toBe("club-billing-paused");
    expect(body.ignored).not.toBe("club-not-approved");
  });
});

test.describe("crons skip a paused club (4.3 point 6)", () => {
  test("generate-matches makes no fixture for it; the exempt club still gets one", async ({ request, db }) => {
    const res = await request.get("/api/cron/generate-matches", { headers: CRON });
    expect(res.status()).toBe(200);
    expect(
      await db.count(`SELECT COUNT(*) FROM "Match" WHERE "activityId" = $1 AND id <> $2`, [PAUSED_ACTIVITY, PAUSED_MATCH]),
    ).toBe(0);
    // The resumed (subscribed) club is served: its weekly fixture exists.
    expect(
      await db.count(`SELECT COUNT(*) FROM "Match" WHERE "activityId" = $1 AND status = 'UPCOMING'`, [RESUMED_ACTIVITY]),
    ).toBe(1);
  });

  test("complete-matches leaves the paused club's finished match alone", async ({ request, db }) => {
    const res = await request.get("/api/cron/complete-matches", { headers: CRON });
    expect(res.status()).toBe(200);
    const row = await db.one<{ status: string }>(`SELECT status FROM "Match" WHERE id = $1`, [PAUSED_MATCH]);
    expect(row?.status).toBe("UPCOMING");
  });

  test("bot-health does not look at the paused club", async ({ request }) => {
    const res = await request.get("/api/cron/bot-health", { headers: CRON });
    expect(res.status()).toBe(200);
    expect(await res.text()).not.toContain(PAUSED_ORG);
  });
});

test.describe("resume (4.4): no catch-up posts", () => {
  test("a match completed quietly by resumeClub gets no post-match work; the same match left normal would", async ({ request }) => {
    const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(RESUMED_GROUP)}`, {
      headers: { ...HEADERS, "x-no-claim": "1", "x-test-now": new Date().toISOString() },
    });
    expect(res.status(), await res.text()).toBe(200);
    const instructions = ((await res.json()).instructions ?? []) as Array<{ key?: string; matchId?: string }>;
    const about = (id: string) => instructions.filter((i) => i.matchId === id || (i.key ?? "").startsWith(`${id}:`));
    expect(about(QUIET_MATCH)).toEqual([]);
    // The control proves the assertion above is not vacuous.
    expect(about(CONTROL_MATCH).length).toBeGreaterThan(0);
  });
});
