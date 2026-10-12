/**
 * GO-LIVE SLICE S1: the rails for "approved but setting up", against a
 * real Postgres and the real routes (go-live plan 2.1 and 2.2).
 *
 * A club that the owner has approved but whose organiser has not said GO
 * yet is APPROVED and SILENT: no post, no DM answer from a model, no
 * session, no fixture work on its group's messages. This spec puts one
 * club in that state by hand (nothing in production code does yet: that
 * is slice S3) and walks every route that acts for a group. The seeded
 * club, which stands in for Sutton FC, must behave exactly as before: it
 * is "live" by the column default.
 *
 * The one thing a setting-up club MAY do is have its group's chat read
 * once (the setup-learning sweep). That is proved here too, with the model
 * stubbed through the cron's test-only header.
 *
 * Deterministic end to end: no real model is called by anything here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "pg";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { ORG_ID, PHONE } from "../helpers/constants";
import { assertSafeTestDbUrl, E2E, E2E_DB_URL, REPO_ROOT } from "../helpers/env";
import { testDb, type TestDb } from "../helpers/test-db";
import { clearDmIntentStub, setDmIntentStub } from "../helpers/stub";

const execFileAsync = promisify(execFile);

test.describe.configure({ mode: "serial" });

const HEADERS = { "x-api-key": E2E.WHATSAPP_API_KEY };
const CRON = { authorization: `Bearer ${E2E.CRON_SECRET}` };

const HELD_ORG = "e2e-setup-held";
const HELD_GROUP = "120363900000000071@g.us";
const ORGANISER = "e2e-setup-organiser";
const ORGANISER_PHONE = "+447700900971";
const HELD_PLAYER = "e2e-setup-player";
const HELD_PLAYER_PHONE = "+447700900972";
/** In the held club AND in the seeded live club. */
const BOTH = "e2e-setup-both";
const BOTH_PHONE = "+447700900973";
/** LEFT the seeded live club; today only in the held club. */
const LEFT = "e2e-setup-left";
const LEFT_PHONE = "+447700900974";
const HELD_MATCH_SOON = "e2e-setup-match-soon";
const HELD_MATCH_LATE = "e2e-setup-match-late";

const MIGRATION = path.join(REPO_ROOT, "prisma", "migrations", "20261012120000_setup_hold", "migration.sql");

const rolling = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "src/lib/setup-learning/__fixtures__/rolling.json"), "utf8"),
) as { history: unknown[] };

const ROLLING_ANSWER = {
  regular_game: true,
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

let n = 0;
const msgId = () => `e2e-setup-hold-${Date.now()}-${++n}`;

async function post(request: APIRequestContext, url: string, data: unknown, headers: Record<string, string> = {}) {
  const res = await request.post(url, { headers: { ...HEADERS, ...headers }, data });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function orgs(request: APIRequestContext) {
  const res = await request.get("/api/whatsapp/orgs", { headers: HEADERS });
  expect(res.status(), await res.text()).toBe(200);
  return res.json() as Promise<{
    orgs: Array<{ id: string; whatsappGroupId: string }>;
    silentGroups: string[];
    adminGroups: Array<{ groupId: string; orgId: string }>;
  }>;
}

const dm = (request: APIRequestContext, phone: string, body: string) =>
  post(request, "/api/whatsapp/dm-reply", { phone, body, waMessageId: msgId(), authorName: null });

const heldJobs = (db: TestDb) => db.count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1`, [HELD_ORG]);
/** Platform-channel replies to the held club's organiser (slice S4). */
const organiserReplies = (db: TestDb) =>
  db.count(`SELECT COUNT(*) FROM "PlatformJob" WHERE phone = $1 AND purpose = 'setup-reply'`, [ORGANISER_PHONE.replace(/^\+/, "")]);
const heldSessions = (db: TestDb) =>
  db.count(`SELECT COUNT(*) FROM "OnboardingSession" WHERE "whatsappGroupId" = $1`, [HELD_GROUP]);
const heldClub = (db: TestDb) =>
  db.one<{ approvalStatus: string; setupStage: string; whatsappBotEnabled: boolean; rollingSquadEnabled: boolean }>(
    `SELECT "approvalStatus","setupStage","whatsappBotEnabled","rollingSquadEnabled" FROM "Organisation" WHERE id = $1`,
    [HELD_ORG],
  );
const aiSpend = (db: TestDb) =>
  db.all<{ costUsd: number; capUsd: number; calls: number; refusedCalls: number }>(
    `SELECT "costUsd","capUsd","calls","refusedCalls" FROM "OrgAiUsage" WHERE "orgId" = $1`,
    [HELD_ORG],
  );

async function user(db: TestDb, id: string, name: string, phone: string) {
  await db.run(
    `INSERT INTO "User" (id, name, email, "phoneNumber", onboarded, "isActive", "updatedAt") VALUES ($1,$2,$3,$4,true,true,now())`,
    [id, name, `${id}@e2e-test.invalid`, phone],
  );
}
const member = (db: TestDb, userId: string, orgId: string, role: string) =>
  db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1,$2,$3,$4)`, [`${userId}-${orgId}`, userId, orgId, role]);

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await user(db, ORGANISER, "Hana Organiser", ORGANISER_PHONE);
  await user(db, HELD_PLAYER, "Pia Player", HELD_PLAYER_PHONE);
  await user(db, BOTH, "Bo Both", BOTH_PHONE);
  // Approved an hour ago through self-join, its group linked, the bot OFF
  // (the CHECK constraint forbids anything else), waiting for GO.
  await db.run(
    `INSERT INTO "Organisation" ("id","name","slug","inviteCode","approvalStatus","approvedAt","whatsappGroupId",
       "whatsappBotEnabled","setupStage","language","createdAt","updatedAt")
     VALUES ($1,'Harbour FC',$1,$2,'approved',now() - interval '1 hour',$3,false,'setting-up','en',now(),now())`,
    [HELD_ORG, `${HELD_ORG}-invite`, HELD_GROUP],
  );
  await member(db, ORGANISER, HELD_ORG, "OWNER");
  await member(db, HELD_PLAYER, HELD_ORG, "PLAYER");
  await member(db, BOTH, HELD_ORG, "ADMIN");
  await member(db, BOTH, ORG_ID, "PLAYER");
  await user(db, LEFT, "Lee Left", LEFT_PHONE);
  await member(db, LEFT, HELD_ORG, "PLAYER");
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role, "leftAt") VALUES ($1,$2,$3,'PLAYER', now() - interval '30 days')`, [
    `${LEFT}-${ORG_ID}`,
    LEFT,
    ORG_ID,
  ]);
  await db.run(
    `INSERT INTO "Sport" ("id","orgId","name","playersPerTeam","positions","teamLabels","createdAt","updatedAt")
     VALUES ($1,$2,'Football 6-a-side',6,ARRAY['GK','DEF','MID','FWD'],ARRAY['Red','Yellow'],now(),now())`,
    [`${HELD_ORG}-sport`, HELD_ORG],
  );
  await db.run(
    `INSERT INTO "Activity" ("id","orgId","sportId","name","dayOfWeek","time","venue","isActive","deadlineHours","createdAt","updatedAt")
     VALUES ($1,$2,$3,'Weekly game',2,'21:00','Harbour Pitches',true,5,now(),now())`,
    [`${HELD_ORG}-activity`, HELD_ORG, `${HELD_ORG}-sport`],
  );
  // Fixtures the crons generated for it while it waits: one that is the
  // EARLIEST upcoming match of anybody's, and one that is the LATEST.
  for (const [id, when] of [
    [HELD_MATCH_SOON, "now() + interval '1 hour'"],
    [HELD_MATCH_LATE, "now() + interval '300 days'"],
  ]) {
    await db.run(
      `INSERT INTO "Match" (id,"activityId",date,"maxPlayers",status,"attendanceDeadline","updatedAt")
       VALUES ($1,$2,${when},12,'UPCOMING',${when},now())`,
      [id, `${HELD_ORG}-activity`],
    );
  }
  // The closed connect request, with the chat WhatsApp shared at the add.
  await db.run(
    `INSERT INTO "ClubConnect" ("id","orgId","userId","phone","code","status","expiresAt","groupId","groupSubject","linkedAt",
       "capturedHistory","updatedAt")
     VALUES ($1,$2,$3,$4,'7HB2','closed',now() + interval '1 hour',$5,'Harbour Tuesday 6s',now() - interval '2 hours',$6::jsonb,now())`,
    [`${HELD_ORG}-cc`, HELD_ORG, ORGANISER, ORGANISER_PHONE.replace(/^\+/, ""), HELD_GROUP, JSON.stringify(rolling.history)],
  );
});

test.afterAll(async () => {
  clearDmIntentStub();
  resetDb();
});

test.describe("the database invariant", () => {
  test("every pre-existing club is LIVE by the column default, with no go-live stamp (the Sutton FC shape)", async ({ db }) => {
    const row = await db.one(
      `SELECT "setupStage","liveAt","liveBy","setupAskedAt","setupRemovedAt","whatsappBotEnabled","approvalStatus"
       FROM "Organisation" WHERE id = $1`,
      [ORG_ID],
    );
    expect(row).toEqual({
      setupStage: "live",
      liveAt: null,
      liveBy: null,
      setupAskedAt: null,
      setupRemovedAt: null,
      whatsappBotEnabled: true,
      approvalStatus: "approved",
    });
    expect(await db.count(`SELECT COUNT(*) FROM "Organisation" WHERE "setupStage" <> 'live' AND id <> $1`, [HELD_ORG])).toBe(0);
  });

  test("the bot cannot be switched ON for a club that is setting up", async ({ db }) => {
    await expect(
      db.run(`UPDATE "Organisation" SET "whatsappBotEnabled" = true WHERE id = $1`, [HELD_ORG]),
    ).rejects.toThrow(/Organisation_bot_off_while_setting_up/);
  });

  test("a live club cannot be moved into setting-up while its bot is on", async ({ db }) => {
    await expect(
      db.run(`UPDATE "Organisation" SET "setupStage" = 'setting-up' WHERE id = $1`, [ORG_ID]),
    ).rejects.toThrow(/Organisation_bot_off_while_setting_up/);
  });

  test("only the two stages exist", async ({ db }) => {
    await expect(
      db.run(`UPDATE "Organisation" SET "setupStage" = 'paused' WHERE id = $1`, [HELD_ORG]),
    ).rejects.toThrow(/Organisation_setupStage_check/);
  });

  test("going live is one write: stage live and bot on together is allowed", async ({ db }) => {
    await db.run(`UPDATE "Organisation" SET "setupStage" = 'live', "whatsappBotEnabled" = true WHERE id = $1`, [HELD_ORG]);
    // And back, for the rest of this spec.
    await db.run(`UPDATE "Organisation" SET "setupStage" = 'setting-up', "whatsappBotEnabled" = false WHERE id = $1`, [HELD_ORG]);
    expect(await heldClub(db)).toMatchObject({ setupStage: "setting-up", whatsappBotEnabled: false });
  });
});

test.describe("the production SQL file", () => {
  test("applies to a database that has none of it, twice, and every existing row becomes live with no backfill", async () => {
    assertSafeTestDbUrl(E2E_DB_URL);
    const sql = readFileSync(MIGRATION, "utf8");
    // A dedicated connection, closed at the end: the search_path set here
    // must never reach a pooled connection another spec will use.
    const client = new Client({ connectionString: E2E_DB_URL });
    await client.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS s1_scratch CASCADE; CREATE SCHEMA s1_scratch; SET search_path TO s1_scratch`);
      await client.query(
        `CREATE TABLE "Organisation" (id TEXT PRIMARY KEY, "whatsappBotEnabled" BOOLEAN NOT NULL DEFAULT false);
         INSERT INTO "Organisation" (id, "whatsappBotEnabled") VALUES ('sutton', true), ('muted', false), ('other', true)`,
      );
      for (const pass of [1, 2]) {
        await client.query(sql);
        const rows = await client.query(
          `SELECT id, "setupStage", "liveAt", "liveBy", "setupAskedAt", "setupRemovedAt", "whatsappBotEnabled" FROM "Organisation" ORDER BY id`,
        );
        expect(rows.rows, `pass ${pass}`).toEqual([
          { id: "muted", setupStage: "live", liveAt: null, liveBy: null, setupAskedAt: null, setupRemovedAt: null, whatsappBotEnabled: false },
          { id: "other", setupStage: "live", liveAt: null, liveBy: null, setupAskedAt: null, setupRemovedAt: null, whatsappBotEnabled: true },
          { id: "sutton", setupStage: "live", liveAt: null, liveBy: null, setupAskedAt: null, setupRemovedAt: null, whatsappBotEnabled: true },
        ]);
        const checks = await client.query(
          `SELECT conname FROM pg_constraint
           WHERE conrelid = 's1_scratch."Organisation"'::regclass AND contype = 'c' ORDER BY conname`,
        );
        expect(checks.rows.map((r) => r.conname), `pass ${pass}`).toEqual([
          "Organisation_bot_off_while_setting_up",
          "Organisation_setupStage_check",
        ]);
      }
      // The lock timeout was SET LOCAL: it did not outlive the transaction.
      expect((await client.query(`SHOW lock_timeout`)).rows[0].lock_timeout).toBe("0");
      await expect(
        client.query(`UPDATE "Organisation" SET "setupStage" = 'setting-up' WHERE id = 'sutton'`),
      ).rejects.toThrow(/Organisation_bot_off_while_setting_up/);
      await client.query(`UPDATE "Organisation" SET "setupStage" = 'setting-up' WHERE id = 'muted'`);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS s1_scratch CASCADE`).catch(() => {});
      await client.end();
    }
  });

  test("applied over the real e2e schema it changes nothing", async ({ db }) => {
    await db.run(readFileSync(MIGRATION, "utf8"));
    expect(await heldClub(db)).toMatchObject({ setupStage: "setting-up", whatsappBotEnabled: false });
    expect(
      await db.count(
        `SELECT COUNT(*) FROM pg_constraint WHERE conname IN ('Organisation_setupStage_check','Organisation_bot_off_while_setting_up')`,
      ),
    ).toBe(2);
  });
});

test.describe("what the Pi is told", () => {
  test("/orgs: the setting-up club is not monitored and its group is silent; the live club is as before", async ({ request }) => {
    const body = await orgs(request);
    expect(body.orgs.map((o) => o.id)).toContain(ORG_ID);
    expect(body.orgs.map((o) => o.id)).not.toContain(HELD_ORG);
    expect(body.silentGroups).toContain(HELD_GROUP);
    expect(body.silentGroups).not.toContain(E2E.GROUP_ID);
  });

  test("due-posts for its group is refused, so nothing is ever dispatched; the live club's still answers", async ({ request }) => {
    const held = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(HELD_GROUP)}`, { headers: HEADERS });
    expect(held.status()).toBe(404);
    const live = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`, {
      headers: { ...HEADERS, "x-no-claim": "1" },
    });
    expect(live.status()).toBe(200);
  });
});

test.describe("the group routes are blind to it", () => {
  for (const body of ["IN", "@MatchTime setup", "@MatchTime who is playing this week?"]) {
    test(`a batch from its group ("${body}") is refused before any work`, async ({ request, db }) => {
      const res = await post(request, "/api/whatsapp/analyze", {
        groupId: HELD_GROUP,
        messages: [
          { waMessageId: msgId(), body, authorPhone: ORGANISER_PHONE.replace(/^\+/, ""), authorName: "Hana", timestamp: new Date().toISOString() },
        ],
      });
      expect(res.ignored).toBe("silent-group");
      expect(res.results).toEqual([]);
      expect(await heldSessions(db)).toBe(0);
      expect(await heldJobs(db)).toBe(0);
      expect(await db.count(`SELECT COUNT(*) FROM "Attendance" a JOIN "Match" m ON m.id = a."matchId" WHERE m."activityId" = $1`, [`${HELD_ORG}-activity`])).toBe(0);
    });
  }

  test("a re-add to its group posts no intro and opens no session (self-join off: the legacy path)", async ({ request, db }) => {
    // Added back by somebody MatchTime does not know: the silence rail.
    const res = await post(request, "/api/whatsapp/bot-added", {
      groupId: HELD_GROUP,
      groupSubject: "Harbour Tuesday 6s",
      addedByPhone: "447700900978",
    });
    expect(res.introText).toBeNull();
    expect(res.ignored).toBe("silent-group");
    expect(await heldSessions(db)).toBe(0);
    // Added back by its own organiser: the route's older "an approved
    // club's admin added me, wait for an admin group code" branch answers
    // first (it sits ahead of the silence rail, for every club). Silent
    // either way: no intro, no session.
    const own = await post(request, "/api/whatsapp/bot-added", {
      groupId: HELD_GROUP,
      groupSubject: "Harbour Tuesday 6s",
      addedByPhone: ORGANISER_PHONE.replace(/^\+/, ""),
    });
    expect(own).toMatchObject({ ignored: "admin-group-awaiting-code", silent: true, introText: null });
    expect(await heldSessions(db)).toBe(0);
    expect(await heldJobs(db)).toBe(0);
  });

  test("a re-add with self-join on is the approved club's own group: nothing starts, nothing is relinked", async ({ request, db }) => {
    const res = await post(
      request,
      "/api/whatsapp/bot-added",
      { groupId: HELD_GROUP, groupSubject: "Harbour Tuesday 6s", addedByPhone: ORGANISER_PHONE.replace(/^\+/, "") },
      { "x-mt-test-self-join": "1" },
    );
    expect(res).toMatchObject({ ignored: "live-org", selfJoin: "live-org", introText: null });
    expect(await heldClub(db)).toMatchObject({ approvalStatus: "approved", setupStage: "setting-up", whatsappBotEnabled: false });
    expect(await heldSessions(db)).toBe(0);
  });

  test("joins, leaves and a participant sync in its group do nothing", async ({ request, db }) => {
    const before = await db.count(`SELECT COUNT(*) FROM "Membership" WHERE "orgId" = $1`, [HELD_ORG]);
    expect(await post(request, "/api/whatsapp/group-join", { groupId: HELD_GROUP, phones: ["447700900979"] })).toMatchObject({
      ignored: "unknown-or-disabled-group",
    });
    expect(
      await post(request, "/api/whatsapp/group-leave", { groupId: HELD_GROUP, phones: [HELD_PLAYER_PHONE.replace(/^\+/, "")] }),
    ).toMatchObject({ ignored: "unknown-or-disabled-group" });
    expect(
      await post(request, "/api/whatsapp/sync-participants", {
        groupId: HELD_GROUP,
        participants: [{ phone: "447700900979", name: "New Person" }],
      }),
    ).toMatchObject({ ignored: "unknown-group" });
    expect(await db.count(`SELECT COUNT(*) FROM "Membership" WHERE "orgId" = $1`, [HELD_ORG])).toBe(before);
    expect(await db.count(`SELECT COUNT(*) FROM "Membership" WHERE "orgId" = $1 AND "leftAt" IS NOT NULL`, [HELD_ORG])).toBe(0);
    expect(await heldJobs(db)).toBe(0);
  });

  test("MatchTime's removal from its group: the club stays approved, setting up and silent, and the removal is recorded", async ({ request, db }) => {
    const removedAt = () => db.one<{ at: Date | null }>(`SELECT "setupRemovedAt" AS at FROM "Organisation" WHERE id = $1`, [HELD_ORG]);
    const res = await post(request, "/api/whatsapp/bot-removed", { groupId: HELD_GROUP });
    expect(res).toMatchObject({ ok: true, billing: "setting-up", setup: "removed", orgId: HELD_ORG });
    // Not back to draft, not live, and nothing for the group.
    expect(await heldClub(db)).toMatchObject({ approvalStatus: "approved", setupStage: "setting-up", whatsappBotEnabled: false });
    expect(await heldJobs(db)).toBe(0);
    expect((await removedAt())!.at).not.toBeNull();
    // (The whole removal path, GO refused and the re-add rules are in
    // setup-go-live.spec.ts and e2e/helpers/setup-removal-lib-tests.ts.)

    // The removal deleted the chat captured at the add (the group took
    // MatchTime out).
    expect(await db.one(`SELECT "capturedHistory" AS h FROM "ClubConnect" WHERE id = $1`, [`${HELD_ORG}-cc`])).toEqual({ h: null });

    // THE FIXTURE IS PUT BACK BY HAND for the tests further down, which
    // need this club in its group with its chat unread: the stamp is
    // cleared and the chat restored in SQL. (The real re-add also runs the
    // club's setup DM at once, which would close its reading here; that
    // path is covered in setup-go-live.spec.ts.)
    await db.run(`UPDATE "Organisation" SET "setupRemovedAt" = NULL WHERE id = $1`, [HELD_ORG]);
    await db.run(`UPDATE "ClubConnect" SET "capturedHistory" = $2::jsonb WHERE id = $1`, [`${HELD_ORG}-cc`, JSON.stringify(rolling.history)]);
    await db.run(`DELETE FROM "PlatformJob" WHERE purpose = 'setup-removed'`);
  });
});

test.describe("the admin group command", () => {
  test("typed in the setting-up club's PLAYERS' group it gets no reply at all", async ({ request }) => {
    const out = await post(request, "/api/whatsapp/admin-group-link", {
      groupId: HELD_GROUP,
      text: "@Match Time admin group ABCDEF",
      senderPhone: ORGANISER_PHONE.replace(/^\+/, ""),
    });
    expect(out).toMatchObject({ outcome: "ignored", replyText: null, reason: "club-setting-up" });
  });

  test("the live club's own group still gets today's refusal", async ({ request }) => {
    const out = await post(request, "/api/whatsapp/admin-group-link", {
      groupId: E2E.GROUP_ID,
      text: "@Match Time admin group ABCDEF",
      senderPhone: PHONE.admin.replace(/^\+/, ""),
    });
    expect(out.outcome).toBe("main-group");
    expect(out.replyText).toBe("This is *E2E Test FC*'s main group, so it can't be the admin group. Add me to a separate group for the admins.");
  });
});

test.describe("direct messages", () => {
  // Slice S4 (owner decision 8): the organiser is no longer met with
  // silence. The rail still stops the DM before any handler and any model;
  // what comes back is one fixed reply on the PLATFORM channel (the club's
  // own channel stays empty). e2e/api/setup-go-live.spec.ts has the texts.
  test("its organiser is stopped at the rail, told how to go live, and no model is asked", async ({ request, db }) => {
    const res = await dm(request, ORGANISER_PHONE, "hi, when do we play?");
    expect(res).toMatchObject({ handled: "setup-not-recognised", orgIds: [HELD_ORG] });
    expect(await heldJobs(db)).toBe(0);
    expect(await aiSpend(db)).toEqual([]);
    expect(await organiserReplies(db)).toBe(1);
  });

  test("an admin command from its organiser stops at the same rail", async ({ request, db }) => {
    const res = await dm(request, ORGANISER_PHONE, "cancel this week's game");
    expect(res.handled).toBe("setup-not-recognised");
    expect(await heldJobs(db)).toBe(0);
    expect(await aiSpend(db)).toEqual([]);
    expect(await organiserReplies(db)).toBe(2);
    expect(await heldClub(db)).toMatchObject({ setupStage: "setting-up", whatsappBotEnabled: false });
  });

  test("one of its players gets nothing back either", async ({ request, db }) => {
    const res = await dm(request, HELD_PLAYER_PHONE, "am I playing on Tuesday?");
    expect(res.ignored).toBe("club-setting-up");
    expect(await heldJobs(db)).toBe(0);
  });

  test("a member of the live club is NOT caught by the new rail", async ({ request }) => {
    const res = await dm(request, PHONE.player, "hi, when do we play?");
    expect(res.ignored).not.toBe("club-setting-up");
    expect(res.ignored).not.toBe("club-not-approved");
  });

  test("someone in a live club AND the setting-up one is NOT caught", async ({ request }) => {
    const res = await dm(request, BOTH_PHONE, "hi, when do we play?");
    expect(res.ignored).not.toBe("club-setting-up");
  });

  test("review fix 2: someone who LEFT a live club and is only in the setting-up one IS caught", async ({ request, db }) => {
    const before = await heldJobs(db);
    const res = await dm(request, LEFT_PHONE, "hi, when do we play?");
    expect(res.ignored).toBe("club-setting-up");
    expect(await heldJobs(db)).toBe(before);
  });

  test("deterministic help is answered first, for the organiser of the setting-up club", async ({ request, db }) => {
    const res = await dm(request, ORGANISER_PHONE, "help");
    expect(res).toMatchObject({ handled: "dm-help", orgId: HELD_ORG, audience: "admin" });
    // Slice S4 closed the gap pinned here before: the answer used to be
    // queued as the club's own DM job, which due-posts never dispatches
    // for a setting-up club. It now goes out on the platform channel, and
    // nothing at all is put on the club's.
    const before = await organiserReplies(db);
    expect(before).toBeGreaterThan(0);
    expect(await heldJobs(db)).toBe(0);
    expect(
      await db.one(`SELECT purpose, status, "sendAfter" FROM "PlatformJob" WHERE phone = $1 ORDER BY "createdAt" DESC, id DESC LIMIT 1`, [
        ORGANISER_PHONE.replace(/^\+/, ""),
      ]),
    ).toEqual({ purpose: "setup-reply", status: "queued", sendAfter: null });
  });
});

test.describe("review fix 2: in a live club AND a setting-up one, the setting-up club does not exist for club selection", () => {
  const RECRUIT = "can you get a few more players for this week";
  const heldAttendance = (db: TestDb) =>
    db.count(`SELECT COUNT(*) FROM "Attendance" WHERE "matchId" IN ($1,$2)`, [HELD_MATCH_SOON, HELD_MATCH_LATE]);
  const lastDmTo = (db: TestDb, phone: string) =>
    db.one<{ orgId: string }>(`SELECT "orgId" FROM "BotJob" WHERE kind = 'dm' AND phone = $1 ORDER BY "createdAt" DESC LIMIT 1`, [
      phone.replace(/^\+/, ""),
    ]);

  test("with no setting-up club the filter removes nobody: every other club passes it", async ({ db }) => {
    const all = await db.count(`SELECT COUNT(*) FROM "Membership" WHERE "orgId" <> $1`, [HELD_ORG]);
    const kept = await db.count(
      `SELECT COUNT(*) FROM "Membership" m JOIN "Organisation" o ON o.id = m."orgId" WHERE m."orgId" <> $1 AND o."setupStage" = 'live'`,
      [HELD_ORG],
    );
    expect(all).toBeGreaterThan(0);
    expect(kept).toBe(all);
  });

  test("an admin command (recruit) is never run for the setting-up club he runs", async ({ request, db }) => {
    // BOTH is an ADMIN only of the held club, whose fixture is the soonest
    // upcoming match. Before the fix the blast went to the held club.
    setDmIntentStub({ bodies: { [RECRUIT]: "recruit_blast" } });
    const before = await heldJobs(db);
    const res = await dm(request, BOTH_PHONE, RECRUIT);
    clearDmIntentStub();
    expect(res.handled).not.toBe("recruit-dm");
    expect(await heldJobs(db)).toBe(before);
    expect(await db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key LIKE $1`, [`${HELD_MATCH_SOON}:%`])).toBe(0);
  });

  test("a DM 'in' registers him on the LIVE club's match, never on the setting-up club's fixture", async ({ request, db }) => {
    const before = await heldJobs(db);
    await dm(request, BOTH_PHONE, "in");
    expect(await heldAttendance(db)).toBe(0);
    expect(await heldJobs(db)).toBe(before);
    expect(await db.count(`SELECT COUNT(*) FROM "Attendance" WHERE "userId" = $1`, [BOTH])).toBe(1);
    expect((await lastDmTo(db, BOTH_PHONE))?.orgId).toBe(ORG_ID);
  });

  test("a question is answered about the LIVE club, though the setting-up club has the latest match", async ({ request, db }) => {
    const before = await heldJobs(db);
    const res = await dm(request, BOTH_PHONE, "who is playing this week?");
    expect(res.handled).toBe("dm-qa");
    expect(await heldJobs(db)).toBe(before);
    expect((await lastDmTo(db, BOTH_PHONE))?.orgId).toBe(ORG_ID);
  });

  test("help is answered for the live club too", async ({ request, db }) => {
    const before = await heldJobs(db);
    const res = await dm(request, BOTH_PHONE, "help");
    expect(res).toMatchObject({ handled: "dm-help", orgId: ORG_ID, audience: "player" });
    expect(await heldJobs(db)).toBe(before);
  });
});

test.describe("review fix 1: closing an unfinished reading at go-live", () => {
  test("closeUnfinishedSetupLearning against a real Postgres, inside a transaction (tsx)", async () => {
    test.setTimeout(120_000);
    const { stdout, stderr } = await execFileAsync("npx", ["tsx", "e2e/helpers/club-setup-lib-tests.ts"], {
      cwd: REPO_ROOT,
      env: process.env,
      timeout: 110_000,
    }).catch((err: Error & { stdout?: string; stderr?: string }) => {
      throw new Error(`club-setup lib tests failed:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
    });
    expect(stdout, stderr).toContain("OK");
  });
});

test.describe("the one thing it may do: have its chat read", () => {
  async function sweep(request: APIRequestContext) {
    const res = await request.get("/api/cron/learn-setup", {
      headers: {
        ...CRON,
        "x-test-now": new Date().toISOString(),
        "x-mt-test-setup-learning": "1",
        "x-mt-test-setup-learning-stub": JSON.stringify(ROLLING_ANSWER),
      },
    });
    expect(res.status(), await res.text()).toBe(200);
    return res.json() as Promise<{ considered: number; outcomes: Array<{ orgId: string; outcome: { kind: string; status?: string } }> }>;
  }

  test("the sweep reads a setting-up club (bot off) and pays for it from the small setup-reading allowance", async ({ request, db }) => {
    const report = await sweep(request);
    const mine = report.outcomes.find((o) => o.orgId === HELD_ORG);
    expect(mine?.outcome).toMatchObject({ kind: "done", status: "applied" });
    // The setting was switched while the club is still setting up.
    expect(await heldClub(db)).toMatchObject({
      approvalStatus: "approved",
      setupStage: "setting-up",
      whatsappBotEnabled: false,
      rollingSquadEnabled: true,
    });
    // One call, booked against a ten-cent cap, not the free month's $2.00.
    const spend = await aiSpend(db);
    expect(spend).toHaveLength(1);
    expect(spend[0].calls).toBe(1);
    expect(spend[0].refusedCalls).toBe(0);
    expect(Number(spend[0].capUsd)).toBeCloseTo(0.1, 5);
    expect(Number(spend[0].costUsd)).toBeCloseTo(0.0145, 5);
  });

  test("the reading posted nothing in the group, and the group is still silent", async ({ request, db }) => {
    expect(await db.count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1 AND kind <> 'dm'`, [HELD_ORG])).toBe(0);
    const body = await orgs(request);
    expect(body.silentGroups).toContain(HELD_GROUP);
    expect(body.orgs.map((o) => o.id)).not.toContain(HELD_ORG);
  });

  test("a second sweep does not read it again", async ({ request, db }) => {
    const report = await sweep(request);
    expect(report.outcomes.find((o) => o.orgId === HELD_ORG)).toBeUndefined();
    expect((await aiSpend(db))[0].calls).toBe(1);
  });

  test("review fix 1: once it has gone live it is never read again, even with a reading still owed", async ({ request, db }) => {
    // A second club: its reading was deferred, then its organiser said GO.
    const LATE = "e2e-setup-late";
    await db.run(
      `INSERT INTO "Organisation" ("id","name","slug","inviteCode","approvalStatus","approvedAt","whatsappGroupId",
         "whatsappBotEnabled","setupStage","liveAt","liveBy","language","createdAt","updatedAt")
       VALUES ($1,'Late FC',$1,$2,'approved',now() - interval '2 hours','120363900000000072@g.us',true,'live',
         now() - interval '10 minutes','whatsapp:447700900975','en',now(),now())`,
      [LATE, `${LATE}-invite`],
    );
    await user(db, `${LATE}-owner`, "Lena Late", "+447700900975");
    await member(db, `${LATE}-owner`, LATE, "OWNER");
    await db.run(
      `INSERT INTO "ClubConnect" ("id","orgId","userId","phone","code","status","expiresAt","groupId","groupSubject","linkedAt",
         "capturedHistory","updatedAt")
       VALUES ($1,$2,$3,'447700900975','7LT2','closed',now() + interval '1 hour','120363900000000072@g.us','Late Tuesday 6s',
         now() - interval '3 hours',$4::jsonb,now())`,
      [`${LATE}-cc`, LATE, `${LATE}-owner`, JSON.stringify(rolling.history)],
    );
    await db.run(
      `INSERT INTO "ClubSetupLearning" (id,"orgId",status,reason,attempts,"updatedAt") VALUES ($1,$2,'deferred','model-error',1,now() - interval '15 minutes')`,
      [`${LATE}-learning`, LATE],
    );
    const report = await sweep(request);
    expect(report.outcomes.find((o) => o.orgId === LATE)).toBeUndefined();
    expect(
      await db.one(`SELECT "rollingSquadEnabled" FROM "Organisation" WHERE id = $1`, [LATE]),
    ).toEqual({ rollingSquadEnabled: false });
    expect(await db.one(`SELECT status, attempts FROM "ClubSetupLearning" WHERE "orgId" = $1`, [LATE])).toEqual({
      status: "deferred",
      attempts: 1,
    });
    expect(await db.count(`SELECT COUNT(*) FROM "OrgAiUsage" WHERE "orgId" = $1`, [LATE])).toBe(0);
  });

  test("its organiser's DMs still stop at the rail after the reading, and still spend nothing", async ({ request, db }) => {
    const res = await dm(request, ORGANISER_PHONE, "what did you change?");
    expect(res.handled).toBe("setup-not-recognised");
    const spend = await aiSpend(db);
    expect(spend[0].calls).toBe(1);
    expect(spend[0].refusedCalls).toBe(0);
  });
});
