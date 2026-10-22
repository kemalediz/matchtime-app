/**
 * A PARTNER GUEST TAKEN OFF BY THE ASKING CLUB'S ORGANISERS, end to end
 * (Kemal, 2026-10-22).
 *
 * The seeded club is the ASKING club here. C1, a player of a partner club,
 * volunteered for its ask and has a place on its match (a guest Membership
 * and a CONFIRMED row, the prod shapes). Then the club's admin posts
 * "C1 OUT" in the club's own players' group. The router and the attendance
 * extractor are stubbed (they read it as a named third party's OUT, as the
 * model does); the route, the engine, `cancelAttendance` and the guest
 * check are the real code. No model is called.
 *
 *   1. C1 gets ONE DM from his own club, and is off the ask's volunteers;
 *   2. an ordinary member the admin takes off gets no DM, as ever;
 *   3. a replay of the same message sends C1 nothing more.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { MATCH, ORG_ID, U } from "../helpers/constants";
import { clearPipelineStubs, engineOn, otherFacts } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const PARTNER = "e2e-gr-partner";
const C1 = "e2e-gr-c1";
const C1_PHONE = "447700900781";
const ASK = "e2e-gr-ask";

let n = 0;
const msgId = () => `e2e-gr-${Date.now()}-${++n}`;
const dmsTo = async (db: TestDb, phone: string) =>
  (await db.all<{ text: string; orgId: string }>(`SELECT text, "orgId" FROM "BotJob" WHERE kind = 'dm' AND phone = $1 ORDER BY "createdAt"`, [phone])) ?? [];
const rowOf = async (db: TestDb, userId: string) =>
  (await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, userId]))?.status;
const volunteers = async (db: TestDb) => (await db.one<{ v: string[] }>(`SELECT "volunteerUserIds" AS v FROM "PartnerAsk" WHERE id = $1`, [ASK]))?.v;

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus","createdAt","updatedAt")
     VALUES ($1,'Friday Lenders',$1,$2,'approved',now(),now())`,
    [PARTNER, `${PARTNER}-invite`],
  );
  await db.run(`INSERT INTO "User" (id,name,email,"phoneNumber","isActive","updatedAt") VALUES ($1,'C1',$2,$3,true,now())`, [
    C1,
    `wa-sync+${C1}@matchtime.local`,
    `+${C1_PHONE}`,
  ]);
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role,"createdAt") VALUES ('e2e-gr-home',$1,$2,'PLAYER',now())`, [C1, PARTNER]);
  await db.run(
    `INSERT INTO "Membership" (id,"userId","orgId",role,"guestFromOrgId","guestMatchId","createdAt") VALUES ('e2e-gr-guest',$1,$2,'PLAYER',$3,$4,now())`,
    [C1, ORG_ID, PARTNER, MATCH.upcoming],
  );
  await db.run(`INSERT INTO "Attendance" (id,"matchId","userId",status,position,"updatedAt") VALUES ('e2e-gr-a1',$1,$2,'CONFIRMED',50,now())`, [
    MATCH.upcoming,
    C1,
  ]);
  await db.run(
    `INSERT INTO "ClubPartnership" (id,"askerOrgId","partnerOrgId",status,"askerAcceptedAt","partnerAcceptedAt","createdByUserId","createdAt","updatedAt")
     VALUES ('e2e-gr-pair',$1,$2,'active',now(),now(),$3,now(),now())`,
    [ORG_ID, PARTNER, U.admin],
  );
  const m = await db.one<{ date: Date }>(`SELECT date FROM "Match" WHERE id = $1`, [MATCH.upcoming]);
  await db.run(
    `INSERT INTO "PartnerAsk" (id,"partnershipId","askerOrgId","partnerOrgId","matchId",places,status,"requestedVia","postedAt","postWaMessageId","postBy","closesAt","volunteerUserIds","createdAt","updatedAt")
     VALUES ($1,'e2e-gr-pair',$2,$3,$4,1,'posted','button',now(),'3EB0GRASK',$5,$6,ARRAY[$7]::text[],now(),now())`,
    [ASK, ORG_ID, PARTNER, MATCH.upcoming, new Date(m!.date.getTime() - 4 * 3600_000), m!.date, C1],
  );
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test("an admin's 'C1 OUT' in the asking club's group: C1 gets one DM from his club, and is off the volunteers", async ({ request, db }) => {
  engineOn({ "C1 OUT": { route: "other_att", facts: otherFacts("C1", "out") } });
  const id = msgId();
  await postAnalyze(request, [{ waMessageId: id, body: "C1 OUT", authorPhone: "447700900001", authorName: "Alex Admin" }]);
  expect(await rowOf(db, C1)).toBe("DROPPED");
  await expect.poll(() => volunteers(db), { timeout: 10_000 }).toEqual([]);
  const dms = await dmsTo(db, C1_PHONE);
  expect(dms).toHaveLength(1);
  expect(dms[0].orgId).toBe(PARTNER);
  expect(dms[0].text).toMatch(/^\*E2E Test FC\*'s organisers have taken you off their game on .+\. Thanks for offering 🙏$/);
  expect(dms[0].text).not.toMatch(/\+?4477009/);
});

test("a replay of the same message sends C1 nothing more", async ({ request, db }) => {
  engineOn({ "C1 OUT": { route: "other_att", facts: otherFacts("C1", "out") } });
  await postAnalyze(request, [{ waMessageId: msgId(), body: "C1 OUT", authorPhone: "447700900001", authorName: "Alex Admin" }]);
  expect(await dmsTo(db, C1_PHONE)).toHaveLength(1);
});

test("an ordinary member the admin takes off gets no DM, as ever", async ({ request, db }) => {
  engineOn({ "Pat OUT": { route: "other_att", facts: otherFacts("Pat Player", "out") } });
  const before = (await dmsTo(db, "447700900003")).length;
  await postAnalyze(request, [{ waMessageId: msgId(), body: "Pat OUT", authorPhone: "447700900001", authorName: "Alex Admin" }]);
  expect(await rowOf(db, U.player)).toBe("DROPPED");
  const after = await dmsTo(db, "447700900003");
  expect(after.filter((d) => /taken you off/.test(d.text))).toHaveLength(0);
  expect(after.length).toBe(before);
});
