/**
 * A partner club's player volunteers BY DM, end to end (Kemal, 2026-10-21).
 *
 * Volunteering must add no noise to the partner club's group: the only
 * thing it sees is the ask. The ask carries a tap-to-DM link to MatchTime
 * prefilled "IN (ref K7Q2)", K7Q2 the ask's code. The seeded club plays the
 * PARTNER (Sutton FC's shape). Real routes, real database:
 *
 *   1. the coded DM "IN (ref ...)": a guest on the ASKING club's bench,
 *      labelled, nothing on his own match, answered by DM, nothing for the
 *      partner group;
 *   2. consent (D7): the asking club's owner sees his name, never his phone;
 *   3. the coded DM "OUT (ref ...)": off the asking club's match, by DM;
 *   4. a private "IN" with NO code while the ask is open and he has no place
 *      in his own game: ONE question with the link, nothing written; his
 *      next "IN" is his own game's;
 *   5. a plain "IN" in his GROUP soon after the ask, no own place (D5b): the
 *      question goes to him by DM, the group hears nothing.
 *
 * IN and OUT here are the DM resolver's free fast path and the stubbed
 * router/extractor: no model is called.
 */
import { test, expect, postAnalyze, resetDb, signInAs } from "../fixtures";
import { MATCH, ORG_ID, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { clearPipelineStubs, engineOn, selfIn } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";
import { askRefCode } from "../../src/lib/partner-ask-ref";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const ASKER = "e2e-xdm-fnf";
const ASKER_OWNER = "e2e-xdm-fnf-owner";
const ASKER_MATCH = "e2e-xdm-match";
const ASK = "e2e-xdm-ask";
const POST = `true_${E2E.GROUP_ID}_3EB0XDMASK`;
const REF = askRefCode(ASK);
const LINK = `https://wa.me/${E2E.MATCHTIME_WA_NUMBER}?text=${encodeURIComponent(`IN (ref ${REF})`)}`;

const IAN = "447700900009"; // U.fresh, Ian Innes
const ZARA = "447700900010"; // U.extra, Zara Zest
const OMAR = "447700900011"; // U.omar1, Omar One

let n = 0;
const id = () => `e2e-xdm-${Date.now()}-${++n}`;
const rowOf = async (db: TestDb, matchId: string, userId: string) =>
  (await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [matchId, userId]))?.status;
const clearJobs = (db: TestDb) => db.run(`DELETE FROM "BotJob"`);
const dmsTo = async (db: TestDb, phone: string) =>
  (await db.all<{ text: string; orgId: string }>(`SELECT text, "orgId" FROM "BotJob" WHERE kind = 'dm' AND phone = $1 ORDER BY "createdAt"`, [phone])).map((r) => r);
const groupPostsOf = async (db: TestDb, orgId: string) =>
  db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE kind <> 'dm' AND "orgId" = $1`, [orgId]);

async function postDm(request: APIRequestContext, phone: string, body: string) {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { phone, body, waMessageId: id(), authorName: null },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

test.beforeAll(async ({ db }) => {
  resetDb();
  const own = await db.one<{ date: Date }>(`SELECT date FROM "Match" WHERE id = $1`, [MATCH.upcoming]);
  // FNF's game, 30 minutes after the seeded club's own, organiser pick.
  const kickoff = new Date(own!.date.getTime() + 30 * 60_000);
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus","benchPickMode","createdAt","updatedAt")
     VALUES ($1,'FNF Guests',$1,$2,'approved','organiser',now(),now())`,
    [ASKER, `${ASKER}-invite`],
  );
  // FNF's own owner, a member of FNF only, for the consent check.
  await db.run(
    `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt") VALUES ($1,'Fay Fnf',$2,'+447700900991',true,true,now())`,
    [ASKER_OWNER, `${ASKER_OWNER}@e2e-test.invalid`],
  );
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role,"createdAt") VALUES ('e2e-xdm-owner-mem',$1,$2,'OWNER',now())`, [ASKER_OWNER, ASKER]);
  await db.run(
    `INSERT INTO "Sport" (id,"orgId",name,"playersPerTeam",positions,"teamLabels","createdAt","updatedAt")
     VALUES ('e2e-xdm-sport',$1,'Football 9-a-side',9,ARRAY['GK','DEF','MID','FWD'],ARRAY['Red','Yellow'],now(),now())`,
    [ASKER],
  );
  await db.run(
    `INSERT INTO "Activity" (id,"orgId","sportId",name,"dayOfWeek",time,venue,"isActive","createdAt","updatedAt")
     VALUES ('e2e-xdm-act',$1,'e2e-xdm-sport','Friday 9-a-side',5,'20:30','Goals Sutton',true,now(),now())`,
    [ASKER],
  );
  await db.run(
    `INSERT INTO "Match" (id,"activityId",date,"maxPlayers","attendanceDeadline","createdAt","updatedAt")
     VALUES ($1,'e2e-xdm-act',$2,18,$2,now(),now())`,
    [ASKER_MATCH, kickoff],
  );
  await db.run(
    `INSERT INTO "ClubPartnership" (id,"askerOrgId","partnerOrgId",status,"askerAcceptedAt","partnerAcceptedAt","createdByUserId","createdAt","updatedAt")
     VALUES ('e2e-xdm-pair',$1,$2,'active',now(),now(),$3,now(),now())`,
    [ASKER, ORG_ID, U.admin],
  );
  await db.run(
    `INSERT INTO "PartnerAsk" (id,"partnershipId","askerOrgId","partnerOrgId","matchId",places,status,"requestedVia","postedAt","postWaMessageId","postBy","closesAt","createdAt","updatedAt")
     VALUES ($1,'e2e-xdm-pair',$2,$3,$4,1,'posted','button',$8,$5,$6,$7,now(),now())`,
    // Posted ten minutes ago (UTC wall time: the column has no time zone),
    // inside D5b's one-hour window.
    [ASK, ASKER, ORG_ID, ASKER_MATCH, POST, new Date(kickoff.getTime() - 4 * 3600_000), kickoff, new Date(Date.now() - 10 * 60_000).toISOString().replace("Z", "")],
  );
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test("the coded DM: a guest on the asking club's bench, answered by DM, nothing for the partner group", async ({ request, db }) => {
  await clearJobs(db);
  const r = await postDm(request, IAN, `IN (ref ${REF})`);
  expect(r).toMatchObject({ ok: true, handled: "xask-dm-volunteer", outcome: "registered-bench" });
  expect(await rowOf(db, ASKER_MATCH, U.fresh)).toBe("BENCH");
  expect(await rowOf(db, MATCH.upcoming, U.fresh)).toBeUndefined();
  const mem = await db.one<{ guestFromOrgId: string | null; guestMatchId: string | null }>(
    `SELECT "guestFromOrgId","guestMatchId" FROM "Membership" WHERE "userId" = $1 AND "orgId" = $2`,
    [U.fresh, ASKER],
  );
  expect(mem).toEqual({ guestFromOrgId: ORG_ID, guestMatchId: ASKER_MATCH });
  const ev = await db.one<{ cause: string }>(`SELECT cause FROM "AttendanceEvent" WHERE "matchId" = $1 AND "userId" = $2 ORDER BY "at" DESC LIMIT 1`, [ASKER_MATCH, U.fresh]);
  expect(ev?.cause).toBe("partner-ask");
  // His answer is a DM of HIS club; the partner group gets nothing.
  const dms = await dmsTo(db, IAN);
  expect(dms).toHaveLength(1);
  expect(dms[0]).toMatchObject({ orgId: ORG_ID });
  expect(dms[0].text).toContain("FNF Guests*'s bench");
  expect(await groupPostsOf(db, ORG_ID)).toEqual([]);
});

test("consent (D7): the asking club's owner sees his name and club, never his phone", async ({ page, db }) => {
  await signInAs(page, ASKER_OWNER);
  const res = await page.request.get("/api/players?includeFormer=1");
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { players?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
  const players = Array.isArray(body) ? body : (body.players ?? []);
  const ian = players.find((p) => p.id === U.fresh || (p.user as { id?: string } | undefined)?.id === U.fresh);
  expect(ian, JSON.stringify(players).slice(0, 400)).toBeTruthy();
  expect(JSON.stringify(ian)).not.toContain("447700900009");
  expect(ian?.phoneNumber ?? null).toBeNull();
  // And the stored number is untouched: one global user, MatchTime uses it to DM him.
  expect((await db.one<{ p: string }>(`SELECT "phoneNumber" AS p FROM "User" WHERE id = $1`, [U.fresh]))?.p).toBe("+447700900009");
});

test("the coded OUT: off the asking club's match, answered by DM", async ({ request, db }) => {
  await clearJobs(db);
  const r = await postDm(request, IAN, `OUT (ref ${REF})`);
  expect(r).toMatchObject({ handled: "xask-dm-volunteer", outcome: "withdrawn" });
  expect(await rowOf(db, ASKER_MATCH, U.fresh)).toBe("DROPPED");
  expect((await dmsTo(db, IAN))[0]?.text).toContain("off *FNF Guests*'s list");
  expect(await groupPostsOf(db, ORG_ID)).toEqual([]);
});

test("a private IN with no code while the ask is open and no own place: one question with the link, nothing written; the next IN is his own game's", async ({ request, db }) => {
  await clearJobs(db);
  const first = await postDm(request, ZARA, "IN");
  expect(first).toMatchObject({ handled: "xask-dm-which-in" });
  expect(await rowOf(db, ASKER_MATCH, U.extra)).toBeUndefined();
  expect(await rowOf(db, MATCH.upcoming, U.extra)).toBeUndefined();
  const [q] = await dmsTo(db, ZARA);
  expect(q.text).toContain("FNF Guests");
  expect(q.text).toContain(LINK);
  // Asked once: the same IN again is for his own club's game, as ever.
  const second = await postDm(request, ZARA, "IN");
  expect(second).toMatchObject({ handled: "dm-self-attendance" });
  expect(await rowOf(db, MATCH.upcoming, U.extra)).toBeTruthy();
  expect(await rowOf(db, ASKER_MATCH, U.extra)).toBeUndefined();
});

test("D5b: a plain IN in his group soon after the ask, no own place: the question goes by DM, the group hears nothing", async ({ request, db }) => {
  await clearJobs(db);
  engineOn({ IN: { route: "self_att", facts: selfIn() } });
  const m = id();
  const res = await postAnalyze(request, [{ waMessageId: m, body: "IN", authorPhone: OMAR, authorName: "Omar One" }]);
  const r = (res.results as Array<{ waMessageId: string; reply?: string | null }>).find((x) => x.waMessageId === m)!;
  expect(r.reply ?? null).toBeNull();
  expect(await rowOf(db, MATCH.upcoming, U.omar1)).toBeUndefined();
  expect(await rowOf(db, ASKER_MATCH, U.omar1)).toBeUndefined();
  const [q] = await dmsTo(db, OMAR);
  expect(q?.text).toContain(LINK);
  expect(q?.text).toContain("just say IN in the group again");
});
