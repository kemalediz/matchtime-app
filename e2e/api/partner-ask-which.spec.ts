/**
 * D5b end to end (cross-club ask, slice S5b), REVISED 2026-10-22 (Kemal): a
 * plain "IN" (no reply) under an hour after a partner club's ask, from a
 * player with no row on his own club's game, counts for his OWN game; then
 * ONE DM asks whether he meant the partner club's game, with the ask's
 * tap-to-DM link. The group hears nothing about it. A player with a row
 * hears nothing new.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { MATCH, ORG_ID, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { clearPipelineStubs, engineOn, selfIn } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const ASKER = "e2e-xwh-fnf";
const ASKER_MATCH = "e2e-xwh-match";
type Result = { waMessageId: string; reply?: string | null };
let n = 0;
const id = () => `e2e-xwh-${Date.now()}-${++n}`;
const rowOf = async (db: TestDb, matchId: string, userId: string) =>
  (await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [matchId, userId]))?.status;

test.beforeAll(async ({ db }) => {
  resetDb();
  const own = await db.one<{ date: Date }>(`SELECT date FROM "Match" WHERE id = $1`, [MATCH.upcoming]);
  const kickoff = new Date(own!.date.getTime() + 3 * 3600_000);
  await db.run(`INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus","createdAt","updatedAt") VALUES ($1,'FNF Which',$1,$2,'approved',now(),now())`, [ASKER, `${ASKER}-i`]);
  await db.run(`INSERT INTO "Sport" (id,"orgId",name,"playersPerTeam",positions,"teamLabels","createdAt","updatedAt") VALUES ('e2e-xwh-sport',$1,'Football',9,ARRAY['MID'],ARRAY['Red','Yellow'],now(),now())`, [ASKER]);
  await db.run(`INSERT INTO "Activity" (id,"orgId","sportId",name,"dayOfWeek",time,venue,"createdAt","updatedAt") VALUES ('e2e-xwh-act',$1,'e2e-xwh-sport','Friday',5,'20:30','Goals',now(),now())`, [ASKER]);
  await db.run(`INSERT INTO "Match" (id,"activityId",date,"maxPlayers","attendanceDeadline","createdAt","updatedAt") VALUES ($1,'e2e-xwh-act',$2,18,$2,now(),now())`, [ASKER_MATCH, kickoff]);
  await db.run(
    `INSERT INTO "ClubPartnership" (id,"askerOrgId","partnerOrgId",status,"askerAcceptedAt","partnerAcceptedAt","createdByUserId","createdAt","updatedAt") VALUES ('e2e-xwh-pair',$1,$2,'active',now(),now(),$3,now(),now())`,
    [ASKER, ORG_ID, U.admin],
  );
  await db.run(
    `INSERT INTO "PartnerAsk" (id,"partnershipId","askerOrgId","partnerOrgId","matchId",places,status,"requestedVia","postedAt","postWaMessageId","postBy","closesAt","createdAt","updatedAt")
     VALUES ('e2e-xwh-ask','e2e-xwh-pair',$1,$2,$3,1,'posted','button',$7,$4,$5,$6,now(),now())`,
    // UTC wall time: the column has no time zone and the test DB session is London.
    [ASKER, ORG_ID, ASKER_MATCH, `true_${E2E.GROUP_ID}_3EB0XWH`, new Date(kickoff.getTime() - 4 * 3600_000), kickoff, new Date(Date.now() - 10 * 60_000).toISOString().replace("Z", "")],
  );
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

const dmsTo = (db: TestDb, phone: string) => db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE kind = 'dm' AND phone = $1`, [phone]);

test("no row on his own game (2026-10-22): his IN counts for his own game, then ONE DM about FNF's; asked once", async ({ request, db }) => {
  engineOn({ IN: { route: "self_att", facts: selfIn() } });
  await db.run(`DELETE FROM "BotJob" WHERE kind = 'dm' AND phone = '447700900009'`);
  const first = id();
  const res = await postAnalyze(request, [{ waMessageId: first, body: "IN", authorPhone: "447700900009", authorName: "Ian Innes" }]);
  const r = (res.results as Result[]).find((x) => x.waMessageId === first)!;
  expect(r.reply ?? "").not.toContain("FNF Which");
  expect(await rowOf(db, MATCH.upcoming, U.fresh)).toBe("CONFIRMED");
  expect(await rowOf(db, ASKER_MATCH, U.fresh)).toBeUndefined();
  const dms = await dmsTo(db, "447700900009");
  expect(dms).toHaveLength(1);
  expect(dms[0].text).toContain("I've put you IN for *");
  expect(dms[0].text).toContain("Did you mean *FNF Which*'s game");
  expect(dms[0].text).toContain(`https://wa.me/${E2E.MATCHTIME_WA_NUMBER}?text=`);
  expect(dms[0].text).not.toMatch(/—|–/);

  const second = id();
  await postAnalyze(request, [{ waMessageId: second, body: "IN", authorPhone: "447700900009", authorName: "Ian Innes" }]);
  expect(await dmsTo(db, "447700900009")).toHaveLength(1);
  expect(await rowOf(db, MATCH.upcoming, U.fresh)).toBe("CONFIRMED");
  expect(await rowOf(db, ASKER_MATCH, U.fresh)).toBeUndefined();
});

test("a player who already has a row on his own game hears nothing new", async ({ request, db }) => {
  engineOn({ IN: { route: "self_att", facts: selfIn() } });
  const m = id();
  const res = await postAnalyze(request, [{ waMessageId: m, body: "IN", authorPhone: "447700900003", authorName: "Pat Player" }]);
  const r = (res.results as Result[]).find((x) => x.waMessageId === m)!;
  expect(r.reply ?? "").not.toContain("Is that IN for");
  expect((await dmsTo(db, "447700900003")).filter((d) => d.text.includes("FNF Which"))).toEqual([]);
});
