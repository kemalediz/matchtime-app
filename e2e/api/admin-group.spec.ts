/**
 * SLICE 2a: the admin channel and the admin WhatsApp group, against a real
 * Postgres and the real routes. Plan:
 * MDs/friday-group-features-plan-2026-09-30.md, sections 2.2 to 2.5.
 *
 *   - a club on "each-admin" (every club before the migration, the
 *     fixture club and Sutton FC included) tells every admin by DM, as
 *     before;
 *   - adding MatchTime to the admins' HQ group does NOT start the in-group
 *     setup (the dev server runs with ONBOARDING_AUTOSTART=1, like prod);
 *   - "@Match Time admin group CODE" links it, answers only a real admin;
 *   - notices then follow the club's setting: the admin group (only for a
 *     Pi that says it can post there), or one person;
 *   - a message in the admin group reaches no model and no analysis;
 *   - MatchTime removed from the group: unlinked, the owner is told.
 *
 * Deterministic: nothing here calls a model.
 */
import { test, expect, resetDb } from "../fixtures";
import { ORG_ID, PHONE, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000001@g.us";
const NEW_CLUB_GROUP = "120363777000000002@g.us";
const ADMIN = PHONE.admin.replace(/^\+/, "");
const COLLECTOR = PHONE.collector.replace(/^\+/, "");
const STRANGER = "447700900977";
const JOINER = "447546111977";
// 12:00 London, inside the admin-group posting hours.
const NOON = "2026-10-01T11:00:00.000Z";

async function post(request: APIRequestContext, path: string, data: Record<string, unknown>) {
  const res = await request.post(path, { headers: KEY, data });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function duePosts(request: APIRequestContext, caps: boolean) {
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`, {
    headers: { ...KEY, "x-test-now": NOON, "x-no-claim": "1", ...(caps ? { "x-mt-pi-caps": "admin-group" } : {}) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).instructions as Array<Record<string, unknown>>;
}

const jobs = (db: TestDb) =>
  db.all<{ id: string; kind: string; phone: string | null; text: string }>(
    `SELECT id, kind, phone, text FROM "BotJob" WHERE "orgId" = $1 ORDER BY "createdAt"`,
    [ORG_ID],
  );

const org = (db: TestDb) =>
  db.one<{
    adminChannelMode: string;
    adminChannelUserId: string | null;
    adminGroupId: string | null;
    adminGroupSubject: string | null;
    adminGroupLinkCode: string | null;
  }>(
    `SELECT "adminChannelMode","adminChannelUserId","adminGroupId","adminGroupSubject","adminGroupLinkCode" FROM "Organisation" WHERE id = $1`,
    [ORG_ID],
  );

test.beforeAll(async ({ db }) => {
  resetDb();
  // A second admin with a phone, so "each admin" and "one person" differ.
  await db.run(`UPDATE "Membership" SET role = 'ADMIN' WHERE "orgId" = $1 AND "userId" = $2`, [ORG_ID, U.collector]);
});

test.afterAll(() => {
  resetDb();
});

test.beforeEach(async ({ db }) => {
  await db.run(`DELETE FROM "BotJob" WHERE "orgId" = $1`, [ORG_ID]);
});

test("Sutton unchanged: a club on each-admin tells every admin with a phone by DM, exactly as before", async ({ request, db }) => {
  expect((await org(db))?.adminChannelMode).toBe("each-admin");
  await post(request, "/api/whatsapp/group-join", { groupId: E2E.GROUP_ID, phones: [JOINER] });
  const rows = await jobs(db);
  expect(rows.map((j) => [j.kind, j.phone]).sort()).toEqual([
    ["dm", ADMIN],
    ["dm", COLLECTOR],
  ].sort());
  for (const j of rows) expect(j.text).toContain("joined *E2E Test FC*");
  // And no admin-group post for a Pi that could send one.
  expect((await duePosts(request, true)).filter((i) => i.kind === "admin-group-message")).toEqual([]);
});

test("the admins' HQ group: an add by an admin does NOT start setup; it waits, silent, for the code", async ({ request, db }) => {
  const out = await post(request, "/api/whatsapp/bot-added", {
    groupId: HQ,
    groupSubject: "E2E HQ",
    addedByPhone: ADMIN,
    participants: [{ phone: ADMIN }, { phone: COLLECTOR }],
  });
  expect(out).toMatchObject({ ignored: "admin-group-awaiting-code", silent: true, introText: null });
  expect(await db.all(`SELECT id FROM "OnboardingSession" WHERE "whatsappGroupId" = $1`, [HQ])).toEqual([]);
  const row = await db.one<{ awaitingAdminLink: boolean; leftAt: Date | null; subject: string | null }>(
    `SELECT "awaitingAdminLink","leftAt",subject FROM "UnsolicitedGroup" WHERE "groupId" = $1`,
    [HQ],
  );
  expect(row).toMatchObject({ awaitingAdminLink: true, leftAt: null, subject: "E2E HQ" });
  const orgs = await (await request.get("/api/whatsapp/orgs", { headers: KEY })).json();
  expect(orgs.silentGroups).toContain(HQ);
});

test("a stranger adding MatchTime to a group is still a new club: today's intro and session", async ({ request, db }) => {
  const out = await post(request, "/api/whatsapp/bot-added", {
    groupId: NEW_CLUB_GROUP,
    groupSubject: "Wednesday Ballers",
    addedByPhone: STRANGER,
    participants: [{ phone: STRANGER }],
  });
  expect(typeof out.introText).toBe("string");
  expect(await db.all(`SELECT id FROM "OnboardingSession" WHERE "whatsappGroupId" = $1`, [NEW_CLUB_GROUP])).toHaveLength(1);
});

test("the link code: nobody else is answered; a wrong code gets L2; the right one links and answers L1", async ({ request, db }) => {
  await db.run(
    `UPDATE "Organisation" SET "adminGroupLinkCode" = 'K7P3QX', "adminGroupLinkCodeExpiresAt" = now() + interval '1 hour' WHERE id = $1`,
    [ORG_ID],
  );
  const link = (text: string, senderPhone: string) =>
    post(request, "/api/whatsapp/admin-group-link", { groupId: HQ, text, senderPhone, botMentioned: false, messageId: "m", timestamp: NOON });

  expect(await link("@Match Time admin group K7P3QX", STRANGER)).toMatchObject({ outcome: "ignored", replyText: null });
  const wrong = await link("@Match Time admin group ZZZZZZ", ADMIN);
  expect(wrong.outcome).toBe("bad-code");
  expect(wrong.replyText).toMatch(/^That code isn't valid any more\./);
  expect((await org(db))?.adminGroupId).toBeNull();

  const ok = await link("@Match Time admin group k7p3qx", ADMIN);
  expect(ok).toMatchObject({
    outcome: "linked",
    replyText: "✅ Linked as the admin group for *E2E Test FC*.",
    adminGroup: { groupId: HQ, orgId: ORG_ID },
  });
  expect(await org(db)).toMatchObject({
    adminChannelMode: "admin-group",
    adminGroupId: HQ,
    adminGroupSubject: "E2E HQ",
    adminGroupLinkCode: null,
  });
  const cand = await db.one<{ leftAt: Date | null }>(`SELECT "leftAt" FROM "UnsolicitedGroup" WHERE "groupId" = $1`, [HQ]);
  expect(cand?.leftAt).not.toBeNull();

  // The Pi learns it; it is not silent any more.
  const orgs = await (await request.get("/api/whatsapp/orgs", { headers: KEY })).json();
  expect(orgs.adminGroups).toEqual([{ groupId: HQ, orgId: ORG_ID }]);
  expect(orgs.silentGroups).not.toContain(HQ);

  // The code is single use.
  expect((await link("@Match Time admin group K7P3QX", ADMIN)).replyText).toBeNull();
});

test("the club's own community group can't be the admin group (L3)", async ({ request }) => {
  const out = await post(request, "/api/whatsapp/admin-group-link", {
    groupId: E2E.GROUP_ID,
    text: "@Match Time admin group ABCDEF",
    senderPhone: ADMIN,
  });
  expect(out.outcome).toBe("main-group");
  expect(out.replyText).toBe("This is *E2E Test FC*'s main group, so it can't be the admin group. Add me to a separate group for the admins.");
});

test("notices follow the setting: the admin group for a capable Pi, the owner by DM for an older one", async ({ request, db }) => {
  await post(request, "/api/whatsapp/group-leave", { groupId: E2E.GROUP_ID, phones: [JOINER] });
  const rows = await jobs(db);
  expect(rows.map((j) => j.kind)).toEqual(["admin-group"]);
  // A plain link at most, never a personal sign-in link, in a group.
  expect(rows[0].text).not.toMatch(/\/r\/|\/s\//);

  const withCaps = await duePosts(request, true);
  const post1 = withCaps.find((i) => i.key === `botjob-${rows[0].id}`);
  expect(post1).toMatchObject({ kind: "admin-group-message", groupId: HQ, text: rows[0].text });

  const oldPi = await duePosts(request, false);
  const dm = oldPi.find((i) => i.key === `botjob-${rows[0].id}`);
  expect(dm).toMatchObject({ kind: "dm", phone: ADMIN, text: rows[0].text });
  expect(oldPi.some((i) => i.kind === "admin-group-message")).toBe(false);
});

test("a message in the admin group is acknowledged, analysed by nobody, answered by nobody", async ({ request, db }) => {
  const before = await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM "AnalyzedMessage"`);
  const out = await post(request, "/api/whatsapp/admin-group", {
    channel: "admin-group",
    groupId: HQ,
    messageId: "e2e-ag-1",
    text: "Wasim played well last week",
    senderPhone: ADMIN,
    timestamp: NOON,
  });
  expect(out).toMatchObject({ ok: true, ignored: "no-open-pick", replyText: null });
  const after = await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM "AnalyzedMessage"`);
  expect(after?.n).toBe(before?.n);
});

test("one person: only the chosen admin is told", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET "adminChannelMode" = 'one-person', "adminChannelUserId" = $2 WHERE id = $1`, [
    ORG_ID,
    U.collector,
  ]);
  await post(request, "/api/whatsapp/group-join", { groupId: E2E.GROUP_ID, phones: [JOINER] });
  expect((await jobs(db)).map((j) => [j.kind, j.phone])).toEqual([["dm", COLLECTOR]]);
  await db.run(`UPDATE "Organisation" SET "adminChannelMode" = 'admin-group', "adminChannelUserId" = NULL WHERE id = $1`, [ORG_ID]);
});

test("MatchTime removed from the admin group: unlinked, back to the owner, and the owner is told (L4)", async ({ request, db }) => {
  const out = await post(request, "/api/whatsapp/bot-removed", { groupId: HQ });
  expect(out).toMatchObject({ ok: true, adminGroup: "unlinked", orgId: ORG_ID });
  expect(await org(db)).toMatchObject({ adminChannelMode: "one-person", adminGroupId: null });
  expect((await jobs(db)).map((j) => [j.kind, j.phone, j.text])).toEqual([
    [
      "dm",
      ADMIN,
      "I was removed from *E2E Test FC*'s admin group, so admin messages now come to you by DM. You can link a group again in Settings.",
    ],
  ]);
  const orgs = await (await request.get("/api/whatsapp/orgs", { headers: KEY })).json();
  expect(orgs.adminGroups).toEqual([]);
});

test("slice 3's deadline summary follows the channel: one post in the admin group, not a DM", async ({ request, db }) => {
  // A Friday club with a Monday 21:00 drop-out deadline, its HQ group linked.
  const G = "e2e-ag-weekly@g.us";
  const HQ2 = "120363777000000021@g.us";
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled",
       "dropOutDeadlineDay", "dropOutDeadlineTime", "adminChannelMode", "adminGroupId", "adminGroupSubject", "updatedAt")
     VALUES ('e2e-ag-org', 'Friday FNF', 'e2e-ag-fnf', 'e2e-ag-invite', $1, true, 1, '21:00', 'admin-group', $2, 'FNF HQ', now())`,
    [G, HQ2],
  );
  await db.run(
    `INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt")
     VALUES ('e2e-ag-sport', 'e2e-ag-org', 'Football 9-a-side', 9, ARRAY['GK','DEF','MID','FWD'], ARRAY['Red','Yellow'], now())`,
  );
  await db.run(
    `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "updatedAt")
     VALUES ('e2e-ag-act', 'e2e-ag-org', 'e2e-ag-sport', 'Friday 9-a-side', 5, '20:30', 'Powerleague', 5, now())`,
  );
  await db.run(`INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ('e2e-ag-hamzah', 'e2e-ag-hamzah@e2e.test', 'Hamzah', '+447700930001', now())`);
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ('e2e-ag-mem', 'e2e-ag-hamzah', 'e2e-ag-org', 'OWNER')`);
  const kickoff = new Date("2027-01-15T20:30:00.000Z");
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt")
     VALUES ('e2e-ag-match', 'e2e-ag-act', $1, 18, 'UPCOMING', $2, now())`,
    [kickoff.toISOString(), new Date(kickoff.getTime() - 5 * 3600_000).toISOString()],
  );

  // Monday 21:05 London (GMT), a Pi that can post in admin groups.
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(G)}`, {
    headers: { ...KEY, "x-test-now": "2027-01-11T21:05:00.000Z", "x-mt-pi-caps": "admin-group" },
  });
  expect(res.status(), await res.text()).toBe(200);
  const instructions = (await res.json()).instructions as Array<{ kind: string; groupId?: string; text?: string }>;
  const summary = instructions.filter((i) => (i.text ?? "").startsWith("Drop-out deadline passed"));
  expect(summary).toHaveLength(1);
  expect(summary[0]).toMatchObject({ kind: "admin-group-message", groupId: HQ2 });
  const jobs = await db.all<{ kind: string }>(`SELECT kind FROM "BotJob" WHERE "orgId" = 'e2e-ag-org'`);
  expect(jobs.map((j) => j.kind)).toEqual(["admin-group"]);
});
