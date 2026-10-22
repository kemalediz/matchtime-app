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
 *   5. a plain "IN" in his GROUP soon after the ask, no own place (D5b,
 *      revised 2026-10-22): it counts for his own game, then one DM asks
 *      whether he meant the asking club's; tapping its link moves him over
 *      (on the asking club's list, off his own game automatically).
 *
 *   6. a nameless volunteer is asked for a name; his reply is READ (the
 *      stubbed name-reply model): a name puts him in, a withdrawal saves
 *      nothing and puts him nowhere, a question gets the question again.
 *
 * IN and OUT here are the DM resolver's free fast path and the stubbed
 * router/extractor/name-reply models: no model is called.
 */
import { test, expect, postAnalyze, resetDb, signInAs } from "../fixtures";
import { MATCH, ORG_ID, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { clearPipelineStubs, engineOn, selfIn, setVolunteerNameStub, clearVolunteerNameStub } from "../helpers/stub";
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

test("D5b (2026-10-22): a plain IN in his group counts for his own game, one DM asks about FNF's; tapping it moves him over", async ({ request, db }) => {
  await clearJobs(db);
  engineOn({ IN: { route: "self_att", facts: selfIn() } });
  const m = id();
  const res = await postAnalyze(request, [{ waMessageId: m, body: "IN", authorPhone: OMAR, authorName: "Omar One" }]);
  const r = (res.results as Array<{ waMessageId: string; reply?: string | null }>).find((x) => x.waMessageId === m)!;
  // The own game is the default: his IN is on his own club's sheet (its
  // bench here: the seeded squad is full by now).
  expect(["CONFIRMED", "BENCH"]).toContain(await rowOf(db, MATCH.upcoming, U.omar1));
  expect(await rowOf(db, ASKER_MATCH, U.omar1)).toBeUndefined();
  expect(r.reply ?? "").not.toContain("FNF");
  const [q, ...rest] = await dmsTo(db, OMAR);
  expect(rest).toEqual([]);
  expect(q?.orgId).toBe(ORG_ID);
  expect(q?.text).toMatch(/I've put you (IN|on the bench) for \*/);
  expect(q?.text).toContain("Did you mean *FNF Guests*'s game");
  expect(q?.text).toContain(LINK);

  // Asked once per ask: another IN in the group asks nothing new.
  const again = id();
  await postAnalyze(request, [{ waMessageId: again, body: "IN", authorPhone: OMAR, authorName: "Omar One" }]);
  expect(await dmsTo(db, OMAR)).toHaveLength(1);

  // He taps the link: on FNF's list (its bench, an organiser-pick club),
  // and his own IN undone automatically. FNF's game overlaps his own; the
  // own IN he is leaving never counts as the overlap.
  const tap = await postDm(request, OMAR, `IN (ref ${REF})`);
  expect(tap).toMatchObject({ ok: true, handled: "xask-dm-volunteer", outcome: "registered-bench" });
  expect(await rowOf(db, ASKER_MATCH, U.omar1)).toBe("BENCH");
  expect(await rowOf(db, MATCH.upcoming, U.omar1)).toBe("DROPPED");
  const after = (await dmsTo(db, OMAR)).map((d) => d.text);
  expect(after.some((t) => t.includes("FNF Guests*'s bench"))).toBe(true);
  expect(after.some((t) => /out/i.test(t) && !t.includes("FNF Guests"))).toBe(true);
});

// 2026-10-22, MT Test: a volunteer with an EMPTY User.name was listed as
// "(unnamed)". Now he is asked for a name before his place is written, and
// his next DM is that name.
test("a nameless volunteer: asked for a name first, nothing written; his reply names him and puts him in", async ({ request, db }) => {
  await clearJobs(db);
  const OMAR2 = "447700900012"; // U.omar2
  await db.run(`UPDATE "User" SET name = NULL WHERE id = $1`, [U.omar2]);
  const first = await postDm(request, OMAR2, `IN (ref ${REF})`);
  expect(first).toMatchObject({ handled: "xask-dm-name-ask", outcome: "asked-name" });
  expect(await rowOf(db, ASKER_MATCH, U.omar2)).toBeUndefined();
  const [q] = await dmsTo(db, OMAR2);
  expect(q).toMatchObject({ orgId: ORG_ID });
  expect(q.text).toContain("what name should I list you under?");
  expect(q.text).toContain("FNF Guests");

  setVolunteerNameStub({ bodies: { "Omar  Second": "name:Omar  Second" } });
  const second = await postDm(request, OMAR2, "  Omar  Second ");
  expect(second).toMatchObject({ handled: "xask-dm-volunteer", outcome: "registered-bench" });
  expect((await db.one<{ name: string | null }>(`SELECT name FROM "User" WHERE id = $1`, [U.omar2]))?.name).toBe("Omar Second");
  expect(await rowOf(db, ASKER_MATCH, U.omar2)).toBe("BENCH");
  expect(await groupPostsOf(db, ORG_ID)).toEqual([]);

  // The question is answered: his next DM is an ordinary one again.
  expect(await db.one(`SELECT 1 FROM "SentNotification" WHERE kind = 'xask-dm-name' AND key LIKE $1`, [`xask:name:${U.omar2}:%`])).toBeFalsy();
});

// 2026-10-22: his reply to the name question used to be taken as his name
// whatever it said, so "actually can't make it" became User.name and he was
// put IN. Now it is read: a question gets the question again, a withdrawal
// saves nothing and puts him nowhere.
test("a nameless volunteer who withdraws at the name question: no name saved, not on the list, a short ack", async ({ request, db }) => {
  await clearJobs(db);
  clearVolunteerNameStub();
  const DANNY = "447700900013"; // U.dup
  await db.run(`UPDATE "User" SET name = NULL WHERE id = $1`, [U.dup]);
  const first = await postDm(request, DANNY, `IN (ref ${REF})`);
  expect(first).toMatchObject({ handled: "xask-dm-name-ask", outcome: "asked-name" });

  // A question is not a name: asked again, nothing written, still open.
  const q = await postDm(request, DANNY, "which match?");
  expect(q).toMatchObject({ handled: "xask-dm-name-ask", outcome: "asked-name-again" });
  expect((await db.one<{ name: string | null }>(`SELECT name FROM "User" WHERE id = $1`, [U.dup]))?.name).toBeNull();
  expect(await rowOf(db, ASKER_MATCH, U.dup)).toBeUndefined();

  setVolunteerNameStub({ bodies: { "actually can't make it": "out" } });
  const out = await postDm(request, DANNY, "actually can't make it");
  expect(out).toMatchObject({ handled: "xask-dm-name-withdrawn", outcome: "withdrew" });
  expect((await db.one<{ name: string | null }>(`SELECT name FROM "User" WHERE id = $1`, [U.dup]))?.name).toBeNull();
  expect(await rowOf(db, ASKER_MATCH, U.dup)).toBeUndefined();
  expect(await db.one(`SELECT 1 FROM "SentNotification" WHERE kind = 'xask-dm-name' AND key LIKE $1`, [`xask:name:${U.dup}:%`])).toBeFalsy();
  const texts = (await dmsTo(db, DANNY)).map((d) => d.text);
  expect(texts).toHaveLength(3);
  expect(texts[1]).toContain("what name should I list you under?");
  expect(texts[2]).toContain("I haven't put you down for *FNF Guests*'s game");
  expect(await groupPostsOf(db, ORG_ID)).toEqual([]);
});
