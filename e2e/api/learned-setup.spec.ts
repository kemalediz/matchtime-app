/**
 * F3, LEARNED SETUP (2026-10-05): /api/cron/learn-setup against a real
 * Postgres and the real route, with the model STUBBED through the
 * test-only `x-mt-test-setup-learning-stub` header (honoured only under
 * MT_TEST_MODE=1). Nothing here calls a model.
 *
 * A self-join club approved this morning, its group's chat stored on the
 * connect request: one sweep switches rolling squad on, records what it
 * read, deletes the chat and queues ONE DM to the organiser. A second
 * sweep does nothing. Flag off: nothing at all. A setting the organiser
 * saved on the website is never changed. Sutton-shaped clubs (approved by
 * the column default, no approvedAt) are never read.
 */
import { test, expect, resetDb } from "../fixtures";
import { E2E } from "../helpers/env";
import { testDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../helpers/env";

const rolling = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "src/lib/setup-learning/__fixtures__/rolling.json"), "utf8"),
) as { history: unknown[] };

test.describe.configure({ mode: "serial" });

const CRON = { authorization: `Bearer ${E2E.CRON_SECRET}` };
const NOW = "2026-10-05T11:00:00Z"; // 12:00 London, daytime
const APPROVED = "2026-10-05T09:00:00Z";

const ROLLING_ANSWER = {
  regular_game: true,
  // Two quotes from two messages: one is not enough to switch a setting.
  squad: {
    answer: "rolling",
    confidence: "high",
    evidence: ["Same lot as last week, let me know if you can't do Tuesday", "Usual crew this week too, only message if you're dropping out"],
  },
  open_places: { answer: "unclear", confidence: "low", evidence: [] },
  drop_out_deadline: { day: "none", time: "none", confidence: "low", evidence: [] },
  list_published: { day: "none", time: "none", confidence: "low", evidence: [] },
  payments: { answer: "no_sign", confidence: "low", evidence: [] },
  monthly_list: {
    answer: "no_sign",
    prepay_for_month: false,
    pay_as_you_go_fill_ins: false,
    credit_for_missed_games: false,
    confidence: "low",
    evidence: [],
  },
  weekly_game: { day: "none", time: "none", venue: "", players_per_side: 0, confidence: "low", evidence: [] },
};

const A = { org: "e2e-learn-a", owner: "e2e-learn-a-owner", phone: "+447700900981" };
const B = { org: "e2e-learn-b", owner: "e2e-learn-b-owner", phone: "+447700900982" };
const OLD = { org: "e2e-learn-old", owner: "e2e-learn-old-owner", phone: "+447700900983" };

async function sweep(request: APIRequestContext, flag: "1" | "0" = "1") {
  const res = await request.get("/api/cron/learn-setup", {
    headers: {
      ...CRON,
      "x-test-now": NOW,
      "x-mt-test-setup-learning": flag,
      "x-mt-test-setup-learning-stub": JSON.stringify(ROLLING_ANSWER),
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json() as Promise<{ enabled: boolean; considered: number; outcomes: Array<{ orgId: string; outcome: { kind: string } }> }>;
}

async function seedClub(c: typeof A, opts: { approvedAt: string | null; organiserSet?: string[] }) {
  const db = testDb();
  await db.run(
    `INSERT INTO "User" (id, name, email, "phoneNumber", onboarded, "isActive", "updatedAt") VALUES ($1,'Steve Hart',$2,$3,true,true,now())`,
    [c.owner, `${c.owner}@e2e-test.invalid`, c.phone],
  );
  await db.run(
    `INSERT INTO "Organisation" ("id","name","slug","inviteCode","approvalStatus","approvedAt","whatsappGroupId",
       "whatsappBotEnabled","language","settingsSetByOrganiser","createdAt","updatedAt")
     VALUES ($1,'Tuesday Night 6s',$1,$2,'approved',$3,$4,true,'en',$5,now(),now())`,
    [c.org, `${c.org}-invite`, opts.approvedAt, `${c.org}@g.us`, opts.organiserSet ?? []],
  );
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1,$2,$3,'OWNER')`, [`${c.owner}-mem`, c.owner, c.org]);
  await db.run(
    `INSERT INTO "Sport" ("id","orgId","name","playersPerTeam","positions","teamLabels","createdAt","updatedAt")
     VALUES ($1,$2,'Football 6-a-side',6,ARRAY['GK','DEF','MID','FWD'],ARRAY['Red','Yellow'],now(),now())`,
    [`${c.org}-sport`, c.org],
  );
  await db.run(
    `INSERT INTO "Activity" ("id","orgId","sportId","name","dayOfWeek","time","venue","isActive","deadlineHours","createdAt","updatedAt")
     VALUES ($1,$2,$3,'Weekly game',2,'21:00','Goals North Cheam',true,5,now(),now())`,
    [`${c.org}-activity`, c.org, `${c.org}-sport`],
  );
  await db.run(
    `INSERT INTO "ClubConnect" ("id","orgId","userId","phone","code","status","expiresAt","groupId","groupSubject","linkedAt",
       "capturedHistory","updatedAt")
     VALUES ($1,$2,$3,$4,'7KQ2','closed',$5,$6,'Tuesday Night 6s',$5,$7::jsonb,now())`,
    [`${c.org}-cc`, c.org, c.owner, c.phone.replace(/^\+/, ""), APPROVED, `${c.org}@g.us`, JSON.stringify(rolling.history)],
  );
}

const org = (id: string) =>
  testDb().one<{ rollingSquadEnabled: boolean }>(`SELECT "rollingSquadEnabled" FROM "Organisation" WHERE id = $1`, [id]);
const learning = (id: string) =>
  testDb().one<{ status: string; applied: Array<{ key: string }>; messageCount: number; costUsd: number }>(
    `SELECT status, applied, "messageCount", "costUsd" FROM "ClubSetupLearning" WHERE "orgId" = $1`,
    [id],
  );
const history = (id: string) =>
  testDb().one<{ h: unknown }>(`SELECT "capturedHistory" AS h FROM "ClubConnect" WHERE "orgId" = $1`, [id]);
const dms = (phone: string) =>
  testDb().all<{ text: string; refId: string; sendAfter: Date | null }>(
    `SELECT text, "refId", "sendAfter" FROM "PlatformJob" WHERE purpose = 'setup-learned' AND phone = $1`,
    [phone.replace(/^\+/, "")],
  );

test.beforeAll(async () => {
  resetDb();
  await seedClub(A, { approvedAt: APPROVED });
  await seedClub(B, { approvedAt: APPROVED, organiserSet: ["rollingSquad"] });
  await seedClub(OLD, { approvedAt: null }); // approved by the column default, like Sutton FC
});

test("refuses without the cron secret", async ({ request }) => {
  expect((await request.get("/api/cron/learn-setup")).status()).toBe(401);
});

test("flag off: nothing is read, changed or sent", async ({ request }) => {
  expect(await sweep(request, "0")).toEqual({ enabled: false, considered: 0, outcomes: [] });
  expect((await org(A.org))!.rollingSquadEnabled).toBe(false);
  expect(await learning(A.org)).toBeNull();
  expect((await history(A.org))!.h).not.toBeNull();
});

test("flag on: the new club is read once, set up, told once; the organiser's own setting is left alone", async ({ request }) => {
  const r = await sweep(request);
  expect(r.outcomes.map((o) => o.orgId).sort()).toEqual([A.org, B.org]);

  // Club A: rolling squad switched on, recorded, chat deleted, one DM.
  expect((await org(A.org))!.rollingSquadEnabled).toBe(true);
  expect(await learning(A.org)).toMatchObject({ status: "applied", applied: [{ key: "rollingSquad" }], messageCount: rolling.history.length });
  expect((await history(A.org))!.h).toBeNull();
  const sent = await dms(A.phone);
  expect(sent).toHaveLength(1);
  expect(sent[0].refId).toBe(`${A.org}:setup-learned`);
  expect(sent[0].sendAfter).toBeNull();
  expect(sent[0].text).toContain(`I read the recent messages in "Tuesday Night 6s" to see how it runs`);
  expect(sent[0].text).toContain(`From messages like: "Same lot as last week, let me know if you can't do Tuesday"`);
  expect(sent[0].text).toMatch(/Undo or change: \S+\/r\//);

  // Club B: the organiser saved rolling squad on the website: untouched, no DM.
  expect((await org(B.org))!.rollingSquadEnabled).toBe(false);
  expect(await learning(B.org)).toMatchObject({ status: "nothing", applied: [] });
  expect(await dms(B.phone)).toEqual([]);

  // A club with no approvedAt is never read.
  expect(await learning(OLD.org)).toBeNull();
});

test("a second sweep does nothing: once per club", async ({ request }) => {
  const r = await sweep(request);
  expect(r.considered).toBe(0);
  expect(await dms(A.phone)).toHaveLength(1);
});
