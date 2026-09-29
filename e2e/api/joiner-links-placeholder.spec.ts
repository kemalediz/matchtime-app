/**
 * THE HAMZAH INCIDENT, replayed (Sutton FC, 2026-09-29), against a real
 * Postgres and the real routes.
 *
 *   07:57  Wasim wrote "Hamzah in". Hamzah was not a Sutton member, so the
 *          third-party registration made a NEW phoneless "Hamzah",
 *          confirmed him, and he got a team slot.
 *   22:51  The admin added the real Hamzah (phone known, a member of
 *          another club) to the WhatsApp group. group-join matched him by
 *          phone and gave him a Sutton membership of his own, and told
 *          the admin he had "rejoined" and been "re-activated".
 *
 * Now: the join merges the placeholder into him (one Hamzah, the match
 * and the team slot kept), the DM says "joined" with one line about the
 * link, and "rejoined" is reserved for a membership that had left.
 *
 * Also pinned: the third-party registration still never reaches into
 * another club by name (privacy), still reuses a FORMER member of this
 * club, ambiguous cases are suggested and never merged, and the
 * participant sweep links the same way group-join does.
 *
 * Deterministic: the router and extractor are stubbed, no model call.
 */
import { test, expect, postAnalyze, resetDb, asAdmin } from "../fixtures";
import { engineOn, otherFacts } from "../helpers/stub";
import { ORG_ID, MATCH, PHONE } from "../helpers/constants";
import { E2E } from "../helpers/env";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const OTHER_ORG = "e2e-jl-other";

const HAMZAH = { id: "e2e-jl-hamzah", name: "Hamzah", phone: "+447700900981" };
const KIERAN = { id: "e2e-jl-kieran", name: "Kieran Left", phone: "+447700900982" };
const YUSUF = { id: "e2e-jl-yusuf", name: "Yusuf", phone: "+447700900983" };
const REMY = { id: "e2e-jl-remy", name: "Remy Return", phone: "+447700900984" };
const SAMI = { id: "e2e-jl-sami", name: "Sami Sweep", phone: "+447700900985" };
const NINA = { id: "e2e-jl-nina", name: "Nina New", phone: "+447700900986" };

let n = 0;
const msgId = () => `e2e-jl-${Date.now()}-${++n}`;

async function insertUser(db: TestDb, u: { id: string; name: string; phone: string | null }, email?: string) {
  await db.run(
    `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,true,true,now(),now())`,
    [u.id, u.name, email ?? `${u.id}@e2e-test.invalid`, u.phone],
  );
}

async function insertMembership(db: TestDb, userId: string, orgId: string, extra: { leftAt?: string; provisional?: boolean } = {}) {
  await db.run(
    `INSERT INTO "Membership" (id,"userId","orgId",role,"leftAt","provisionallyAddedAt")
     VALUES ($1,$2,$3,'PLAYER',${extra.leftAt ?? "NULL"},${extra.provisional ? "now()" : "NULL"})`,
    [`${userId}-${orgId}-mem`, userId, orgId],
  );
}

async function groupJoin(request: APIRequestContext, phone: string) {
  const res = await request.post("/api/whatsapp/group-join", {
    headers: KEY,
    data: { groupId: E2E.GROUP_ID, phones: [phone] },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as { results: Array<{ link?: string; created: boolean; rejoined: boolean; userId: string }> };
}

/** The DM queued to the club owner (Alex Admin) most recently. */
async function lastAdminDm(db: TestDb): Promise<string> {
  const row = await db.one<{ text: string }>(
    `SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2 ORDER BY "createdAt" DESC LIMIT 1`,
    [ORG_ID, PHONE.admin.replace(/^\+/, "")],
  );
  return row?.text ?? "";
}

const orgUsersNamed = (db: TestDb, name: string) =>
  db.all<{ id: string; phoneNumber: string | null }>(
    `SELECT u.id, u."phoneNumber" FROM "User" u JOIN "Membership" m ON m."userId" = u.id
     WHERE m."orgId" = $1 AND lower(u.name) = lower($2) ORDER BY u.id`,
    [ORG_ID, name],
  );

test.beforeAll(async () => {
  resetDb();
  const { testDb } = await import("../helpers/test-db");
  const db = testDb();
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","createdAt","updatedAt")
     VALUES ($1,'Other Club',$1,'e2e-jl-other-invite',now(),now())`,
    [OTHER_ORG],
  );
  // Hamzah, Yusuf and Sami are MatchTime users from ANOTHER club only.
  for (const u of [HAMZAH, YUSUF, SAMI]) {
    await insertUser(db, u);
    await insertMembership(db, u.id, OTHER_ORG);
  }
  // Kieran and Remy were members of THIS club and left.
  for (const u of [KIERAN, REMY]) {
    await insertUser(db, u);
    await insertMembership(db, u.id, ORG_ID, { leftAt: "now() - interval '30 days'" });
  }
  // Nina is a MatchTime user with no club at all.
  await insertUser(db, NINA);
  // Two phoneless "Yusuf" placeholders in this club: ambiguous.
  for (const id of ["e2e-jl-yusuf-ph1", "e2e-jl-yusuf-ph2"]) {
    await insertUser(db, { id, name: "Yusuf", phone: null }, `provisional+yusuf-${id}@matchtime.local`);
    await insertMembership(db, id, ORG_ID, { provisional: true });
  }
  // One "Sami Sweep" placeholder, holding a squad place.
  await insertUser(db, { id: "e2e-jl-sami-ph", name: "Sami Sweep", phone: null }, "provisional+sami-sweep-x@matchtime.local");
  await insertMembership(db, "e2e-jl-sami-ph", ORG_ID, { provisional: true });
  await db.run(
    `INSERT INTO "Attendance" (id,"matchId","userId",status,position,"respondedAt","updatedAt") VALUES ('e2e-jl-sami-att',$1,'e2e-jl-sami-ph','BENCH',99,now(),now())`,
    [MATCH.upcoming],
  );
});

test.afterAll(() => {
  resetDb();
});

let placeholderId = "";

test("07:57 'Hamzah in': a phoneless placeholder is made; the other club's Hamzah is NOT matched by name", async ({ request, db }) => {
  const body = "Hamzah in";
  engineOn({ [body]: { route: "other_att", facts: otherFacts("Hamzah", "in") } });
  await postAnalyze(request, [
    { waMessageId: msgId(), body, authorPhone: PHONE.player.replace(/^\+/, ""), authorName: "Pat Player" },
  ]);

  const rows = await orgUsersNamed(db, "Hamzah");
  expect(rows).toHaveLength(1);
  expect(rows[0].phoneNumber).toBeNull();
  expect(rows[0].id).not.toBe(HAMZAH.id);
  placeholderId = rows[0].id;
  // Privacy: the other club's Hamzah was not given a membership here.
  expect(await db.count(`SELECT COUNT(*) FROM "Membership" WHERE "userId" = $1 AND "orgId" = $2`, [HAMZAH.id, ORG_ID])).toBe(0);

  const att = await db.one<{ status: string }>(
    `SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.upcoming, placeholderId],
  );
  expect(att).not.toBeNull();
  // The team sheet gives him a slot.
  await db.run(`INSERT INTO "TeamAssignment" (id,"matchId","userId",team) VALUES ('e2e-jl-ta',$1,$2,'RED')`, [
    MATCH.upcoming,
    placeholderId,
  ]);
});

test("22:51 the real Hamzah is added: ONE Hamzah, attendance and team slot kept, DM says joined + linked", async ({ request, db }) => {
  const before = await db.one<{ status: string }>(
    `SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.upcoming, placeholderId],
  );
  const out = await groupJoin(request, HAMZAH.phone);
  expect(out.results[0]).toMatchObject({ created: false, rejoined: false, link: "linked", userId: HAMZAH.id });

  const rows = await orgUsersNamed(db, "Hamzah");
  expect(rows).toEqual([{ id: HAMZAH.id, phoneNumber: HAMZAH.phone }]);
  expect(await db.count(`SELECT COUNT(*) FROM "User" WHERE id = $1`, [placeholderId])).toBe(0);

  const att = await db.one<{ status: string }>(
    `SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.upcoming, HAMZAH.id],
  );
  expect(att?.status).toBe(before?.status);
  const ta = await db.one<{ team: string }>(
    `SELECT team FROM "TeamAssignment" WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.upcoming, HAMZAH.id],
  );
  expect(ta?.team).toBe("RED");
  // Still a member of his other club, and exactly one membership here.
  expect(await db.count(`SELECT COUNT(*) FROM "Membership" WHERE "userId" = $1`, [HAMZAH.id])).toBe(2);

  const dm = await lastAdminDm(db);
  expect(dm).toContain("*Hamzah* joined *E2E Test FC*'s WhatsApp group");
  expect(dm).toMatch(/Linked to the \*Hamzah\* added on \d{1,2} \w+/);
  expect(dm).not.toMatch(/rejoined|re-activated/);
  expect(dm).not.toMatch(/[–—]/);
});

test("third-party 'Kieran Left in' reuses the FORMER member of this club and restores him", async ({ request, db }) => {
  const body = "Kieran Left in";
  engineOn({ [body]: { route: "other_att", facts: otherFacts("Kieran Left", "in") } });
  await postAnalyze(request, [
    { waMessageId: msgId(), body, authorPhone: PHONE.player.replace(/^\+/, ""), authorName: "Pat Player" },
  ]);
  expect(await orgUsersNamed(db, "Kieran Left")).toEqual([{ id: KIERAN.id, phoneNumber: KIERAN.phone }]);
  const mem = await db.one<{ leftAt: Date | null }>(
    `SELECT "leftAt" FROM "Membership" WHERE "userId" = $1 AND "orgId" = $2`,
    [KIERAN.id, ORG_ID],
  );
  expect(mem?.leftAt).toBeNull();
  expect(
    await db.count(`SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, KIERAN.id]),
  ).toBe(1);
});

test("two 'Yusuf' placeholders: no merge, the DM and /admin/players both suggest it", async ({ request, db, page }) => {
  const out = await groupJoin(request, YUSUF.phone);
  expect(out.results[0].link).toBe("suggest");
  expect((await orgUsersNamed(db, "Yusuf")).map((r) => r.id)).toEqual([
    YUSUF.id,
    "e2e-jl-yusuf-ph1",
    "e2e-jl-yusuf-ph2",
  ]);
  const dm = await lastAdminDm(db);
  expect(dm).toContain("*Yusuf* joined *E2E Test FC*'s WhatsApp group");
  expect(dm).toContain("They might be the same person as *Yusuf* and *Yusuf*");
  expect(dm).toContain("/admin/players");

  await asAdmin(page);
  const body = (await (await page.request.get("/api/players")).json()) as {
    duplicateSuggestions: Array<{ placeholderId: string; keepId: string }>;
  };
  expect(body.duplicateSuggestions.filter((d) => d.keepId === YUSUF.id).map((d) => d.placeholderId).sort()).toEqual([
    "e2e-jl-yusuf-ph1",
    "e2e-jl-yusuf-ph2",
  ]);
  // Hamzah's placeholder is gone, so nothing is suggested for him.
  expect(body.duplicateSuggestions.some((d) => d.keepId === HAMZAH.id)).toBe(false);
});

test("a membership that had LEFT says rejoined; a first membership with no placeholder says joined, no link line", async ({ request, db }) => {
  const again = await groupJoin(request, REMY.phone);
  expect(again.results[0]).toMatchObject({ rejoined: true, link: "none" });
  const dmAgain = await lastAdminDm(db);
  expect(dmAgain).toContain("*Remy Return* rejoined *E2E Test FC*'s WhatsApp group");
  expect(dmAgain).toContain("re-activated");

  const first = await groupJoin(request, NINA.phone);
  expect(first.results[0]).toMatchObject({ created: false, rejoined: false, link: "none" });
  const dmFirst = await lastAdminDm(db);
  expect(dmFirst).toContain("*Nina New* joined *E2E Test FC*'s WhatsApp group and is now on your player list.");
  expect(dmFirst).not.toMatch(/rejoined|re-activated|Linked|might be/);
});

test("the participant sweep links the same way: Sami's placeholder folds into Sami", async ({ request, db }) => {
  const res = await request.post("/api/whatsapp/sync-participants", {
    headers: KEY,
    data: { groupId: E2E.GROUP_ID, participants: [{ phone: SAMI.phone.replace(/^\+/, ""), pushname: "Sami" }] },
  });
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  expect(body.linkedPlaceholders).toBe(1);
  expect(await orgUsersNamed(db, "Sami Sweep")).toEqual([{ id: SAMI.id, phoneNumber: SAMI.phone }]);
  const att = await db.one<{ status: string }>(
    `SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.upcoming, SAMI.id],
  );
  expect(att?.status).toBe("BENCH");
});
