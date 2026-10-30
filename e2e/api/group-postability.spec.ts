/**
 * A group MatchTime cannot post in (2026-10-14), against a real Postgres
 * and the real routes. See src/lib/group-postability.ts.
 *
 *   1. connect: an organiser adds MatchTime to a group only admins can send
 *      in. Not linked: the request stays dm_verified, the club stays draft,
 *      the owner hears nothing, the organiser gets ONE DM. MatchTime is
 *      then made an admin there (the Pi reports it): the link is finished.
 *   2. a live club's group becomes admin-only: a condition for the health
 *      page and ONE notice to the club's organisers; MatchTime promoted:
 *      the condition is resolved.
 *   3. a club's admin group MatchTime cannot post in: admin notices go to
 *      the owner by DM.
 *
 * Deterministic: nothing here calls a model.
 */
import { test, expect, resetDb } from "../fixtures";
import { ORG_ID } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { testDb, type TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const ON = { ...KEY, "x-mt-test-self-join": "1" };

const DRAFT_ORG = "e2e-gp-riverside";
const ALI = "e2e-gp-ali";
const ALI_PHONE = "447700900961";
const ANNOUNCE_GROUP = "120363610000000001@g.us";
const ADMIN_GROUP = "120363610000000002@g.us";

const BLOCKED = { announce: true, communityAnnounce: false, botIsAdmin: false };
const COMMUNITY = { announce: true, communityAnnounce: true, botIsAdmin: false };
const PROMOTED = { announce: true, communityAnnounce: false, botIsAdmin: true };

async function post(request: APIRequestContext, path: string, data: Record<string, unknown>, headers: Record<string, string> = ON) {
  const res = await request.post(path, { headers, data });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const connect = (db: TestDb) =>
  db.one<{ status: string; groupId: string | null; adderMatch: string | null }>(
    `SELECT status, "groupId", "adderMatch" FROM "ClubConnect" WHERE id = 'e2e-gp-cc'`,
  );
const orgStatus = (db: TestDb, id: string) =>
  db.one<{ approvalStatus: string }>(`SELECT "approvalStatus" FROM "Organisation" WHERE id = $1`, [id]);
const jobsTo = (db: TestDb, phone: string) =>
  db.all<{ text: string; refId: string; purpose: string }>(
    `SELECT text, "refId", purpose FROM "PlatformJob" WHERE phone = $1 ORDER BY "createdAt"`,
    [phone],
  );
const state = (db: TestDb, groupId: string) =>
  db.one<{ canPost: boolean; heldConnectId: string | null; noticeSentAt: Date | null; blockedSince: Date | null }>(
    `SELECT "canPost","heldConnectId","noticeSentAt","blockedSince" FROM "GroupPostState" WHERE "groupId" = $1`,
    [groupId],
  );
const alerts = (db: TestDb, kind: string) =>
  db.all<{ resolvedAt: Date | null }>(`SELECT "resolvedAt" FROM "OpsAlert" WHERE "orgId" = $1 AND kind = $2`, [ORG_ID, kind]);
const botJobs = (db: TestDb) =>
  db.all<{ kind: string; phone: string | null; text: string }>(
    `SELECT kind, phone, text FROM "BotJob" WHERE "orgId" = $1 ORDER BY "createdAt"`,
    [ORG_ID],
  );

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus",language,"createdAt","updatedAt")
     VALUES ($1,'Riverside FC',$1,$2,'draft','en',now(),now())`,
    [DRAFT_ORG, `${DRAFT_ORG}-invite`],
  );
  await db.run(
    `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt")
     VALUES ($1,'Ali Demir',$2,$3,true,true,now())`,
    [ALI, `${ALI}@e2e-test.invalid`, `+${ALI_PHONE}`],
  );
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role) VALUES ('e2e-gp-mem',$1,$2,'OWNER')`, [ALI, DRAFT_ORG]);
  await db.run(
    `INSERT INTO "ClubConnect" (id,"orgId","userId",phone,code,status,"issuedAt","expiresAt","dmAt","dmPhone","dmPhoneMatched","addWindowEndsAt","updatedAt")
     VALUES ('e2e-gp-cc',$1,$2,$3,'4GPX','dm_verified',now() - interval '10 minutes',now() + interval '50 minutes',now() - interval '5 minutes',$3,true,now() + interval '23 hours',now())`,
    [DRAFT_ORG, ALI, ALI_PHONE],
  );
});

test.afterAll(() => {
  resetDb();
});

test("connect: an add into an admin-only group is held, not linked; the organiser gets ONE DM", async ({ request, db }) => {
  const add = {
    groupId: ANNOUNCE_GROUP,
    groupSubject: "Riverside Announcements",
    addedByPhone: ALI_PHONE,
    participants: [{ phone: ALI_PHONE, pushname: "Ali" }],
    postability: BLOCKED,
  };
  const res = await post(request, "/api/whatsapp/bot-added", add);
  expect(res).toMatchObject({ selfJoin: "held-not-postable", ignored: "not-postable", silent: true, introText: null });
  expect((await connect(db))?.status).toBe("dm_verified");
  expect((await connect(db))?.groupId).toBeNull();
  expect((await orgStatus(db, DRAFT_ORG))?.approvalStatus).toBe("draft");
  expect(await jobsTo(db, E2E.APPROVER_PHONE)).toEqual([]);
  const dms = await jobsTo(db, ALI_PHONE);
  expect(dms).toHaveLength(1);
  expect(dms[0]).toMatchObject({ purpose: "connect-reply", refId: `e2e-gp-cc:not-postable:${ANNOUNCE_GROUP}` });
  expect(dms[0].text).toMatch(/only admins can send messages/);
  expect((await state(db, ANNOUNCE_GROUP))?.heldConnectId).toBe("e2e-gp-cc");

  // The Pi re-sends the add (a re-add): still held, still ONE DM.
  await post(request, "/api/whatsapp/bot-added", add);
  expect(await jobsTo(db, ALI_PHONE)).toHaveLength(1);
});

test("connect: the Pi's report that MatchTime is STILL not admin changes nothing", async ({ request, db }) => {
  const r = await post(request, "/api/whatsapp/group-postability", { groupId: ANNOUNCE_GROUP, ...BLOCKED }, KEY);
  expect(r).toMatchObject({ canPost: false, reason: "admin-only", stored: true });
  expect((await connect(db))?.status).toBe("dm_verified");
});

test("connect: MatchTime made admin there: the link is finished, the club pending, the owner's one DM", async ({ request, db }) => {
  const r = await post(request, "/api/whatsapp/group-postability", { groupId: ANNOUNCE_GROUP, ...PROMOTED }, KEY);
  expect(r).toMatchObject({ canPost: true, resumed: "linked" });
  expect(await connect(db)).toMatchObject({ status: "group_linked", groupId: ANNOUNCE_GROUP, adderMatch: "phone" });
  expect((await orgStatus(db, DRAFT_ORG))?.approvalStatus).toBe("pending");
  expect(await jobsTo(db, E2E.APPROVER_PHONE)).toHaveLength(1);
  expect((await state(db, ANNOUNCE_GROUP))?.heldConnectId).toBeNull();
  // The organiser's "I'm in" ack, on top of the earlier not-postable DM.
  expect((await jobsTo(db, ALI_PHONE)).map((j) => j.refId)).toContain("e2e-gp-cc:in-group");
});

test("a community announcements group: the self-join off path posts no intro and starts no session", async ({ request, db }) => {
  // 2026-10-30: the legacy in-group setup is deleted (unreachable in
  // production, SELF_JOIN_ENABLED=1), and with it its "MatchTime cannot
  // post here" branch: with self-join off, no group with no club gets an
  // intro or a session, postable or not.
  const group = "120363610000000009@g.us";
  const res = await post(request, "/api/whatsapp/bot-added", { groupId: group, groupSubject: "Club news", postability: COMMUNITY }, KEY);
  expect(res).toMatchObject({ ignored: "no-club", introText: null });
  const sessions = await db.all(`SELECT id FROM "OnboardingSession" WHERE "whatsappGroupId" = $1`, [group]);
  expect(sessions).toEqual([]);
});

test("a live club's group becomes admin-only: a health condition and ONE notice; promoted: resolved", async ({ request, db }) => {
  await db.run(`DELETE FROM "BotJob" WHERE "orgId" = $1`, [ORG_ID]);
  const blocked = await post(request, "/api/whatsapp/group-postability", { groupId: E2E.GROUP_ID, ...BLOCKED, canPost: false }, KEY);
  expect(blocked).toMatchObject({ canPost: false, clubs: 1 });
  expect(blocked.notices).toBe(1);
  expect(await alerts(db, "group-not-postable")).toEqual([{ resolvedAt: null }]);
  const first = await botJobs(db);
  expect(first.length).toBeGreaterThan(0);
  expect(first.every((j) => j.kind === "dm")).toBe(true);
  expect(first[0].text).toMatch(/only admins can send messages/);

  // Reported again (a Pi restart): no second notice, still one open condition.
  const again = await post(request, "/api/whatsapp/group-postability", { groupId: E2E.GROUP_ID, ...BLOCKED }, KEY);
  expect(again.notices).toBe(0);
  expect(await botJobs(db)).toHaveLength(first.length);
  expect(await alerts(db, "group-not-postable")).toHaveLength(1);

  // Promoted: resolved, the stretch cleared.
  await post(request, "/api/whatsapp/group-postability", { groupId: E2E.GROUP_ID, ...PROMOTED }, KEY);
  const rows = await alerts(db, "group-not-postable");
  expect(rows).toHaveLength(1);
  expect(rows[0].resolvedAt).not.toBeNull();
  expect(await state(db, E2E.GROUP_ID)).toMatchObject({ canPost: true, blockedSince: null });

  // Blocked again the same day (the setting flapped): the condition opens
  // again, but the organisers are not told a second time that day.
  const flap = await post(request, "/api/whatsapp/group-postability", { groupId: E2E.GROUP_ID, ...BLOCKED }, KEY);
  expect(flap.notices).toBe(0);
  expect((await alerts(db, "group-not-postable")).filter((a) => a.resolvedAt === null)).toHaveLength(1);
  await post(request, "/api/whatsapp/group-postability", { groupId: E2E.GROUP_ID, ...PROMOTED }, KEY);
});

test("a club's admin group MatchTime cannot post in: admin notices go by DM, not to the group", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET "adminChannelMode" = 'admin-group', "adminGroupId" = $2 WHERE id = $1`, [ORG_ID, ADMIN_GROUP]);
  await db.run(`DELETE FROM "BotJob" WHERE "orgId" = $1`, [ORG_ID]);
  const r = await post(request, "/api/whatsapp/group-postability", { groupId: ADMIN_GROUP, ...BLOCKED }, KEY);
  expect(r).toMatchObject({ canPost: false, adminGroups: 1, notices: 1 });
  const jobs = await botJobs(db);
  expect(jobs).toHaveLength(1);
  expect(jobs[0].kind).toBe("dm");
  expect(jobs[0].text).toMatch(/admin group/);
  await db.run(`UPDATE "Organisation" SET "adminChannelMode" = 'each-admin', "adminGroupId" = NULL WHERE id = $1`, [ORG_ID]);
});

test("refuses a body without the three settings, and a caller without the key", async ({ request }) => {
  const bad = await request.post("/api/whatsapp/group-postability", { headers: KEY, data: { groupId: ADMIN_GROUP, announce: true } });
  expect(bad.status()).toBe(400);
  const noKey = await request.post("/api/whatsapp/group-postability", { data: { groupId: ADMIN_GROUP, ...BLOCKED } });
  expect(noKey.status()).toBe(401);
});
