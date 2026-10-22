/**
 * Asking two partner clubs for ONE player, end to end on a real database
 * (partner discovery P4, 2026-10-22). Plan:
 * MDs/partner-discovery-plan-2026-10-21.md, section 4.
 *
 * The asking club ("FNF Round") is FIRST-COME and asks two partners in one
 * round for 1 player: the seeded club (whose players volunteer) and a
 * second partner. Real routes (`/api/whatsapp/dm-reply`), real Postgres:
 *
 *   1. two volunteers DM "IN (ref ...)" AT THE SAME TIME, one wanted:
 *      exactly one gets the place (the lock per match), the other is told
 *      the place has gone and is left with nothing;
 *   2. the place that filled the round closes BOTH asks as filled at once,
 *      and each partner group gets its one "place is filled" line.
 *
 * The DM resolver's coded IN is its free fast path: no model is called.
 */
import { test, expect, resetDb } from "../fixtures";
import { MATCH, ORG_ID, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import type { TestDb } from "../helpers/test-db";
import { askRefCode } from "../../src/lib/partner-ask-ref";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const ASKER = "e2e-xr-fnf";
const OTHER = "e2e-xr-cheam";
const ASKER_MATCH = "e2e-xr-match";
const ASK_A = "e2e-xr-ask-a";
const ASK_B = "e2e-xr-ask-b";
const ROUND = "e2e-xr-round";
const REF = askRefCode(ASK_A);

const IAN = "447700900009"; // U.fresh
const ZARA = "447700900010"; // U.extra

let n = 0;
const id = () => `e2e-xr-${Date.now()}-${++n}`;
const rowOf = async (db: TestDb, matchId: string, userId: string) =>
  (await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [matchId, userId]))?.status;

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
  // Two days after the seeded club's own game: no overlap for its players.
  const kickoff = new Date(own!.date.getTime() + 48 * 3600_000);
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus","createdAt","updatedAt")
     VALUES ($1,'FNF Round',$1,$2,'approved',now(),now())`,
    [ASKER, `${ASKER}-invite`],
  );
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus","whatsappGroupId","whatsappBotEnabled","createdAt","updatedAt")
     VALUES ($1,'Cheam Round',$1,$2,'approved','120363999000000081@g.us',true,now(),now())`,
    [OTHER, `${OTHER}-invite`],
  );
  await db.run(
    `INSERT INTO "Sport" (id,"orgId",name,"playersPerTeam",positions,"teamLabels","createdAt","updatedAt")
     VALUES ('e2e-xr-sport',$1,'Football 7-a-side',7,ARRAY['GK','DEF','MID','FWD'],ARRAY['Red','Yellow'],now(),now())`,
    [ASKER],
  );
  await db.run(
    `INSERT INTO "Activity" (id,"orgId","sportId",name,"dayOfWeek",time,venue,"isActive","createdAt","updatedAt")
     VALUES ('e2e-xr-act',$1,'e2e-xr-sport','Sunday 7-a-side',0,'10:00','Round Park',true,now(),now())`,
    [ASKER],
  );
  // 14 places, none taken: plenty open, but the round asks for ONE.
  await db.run(
    `INSERT INTO "Match" (id,"activityId",date,"maxPlayers","attendanceDeadline","createdAt","updatedAt")
     VALUES ($1,'e2e-xr-act',$2,14,$2,now(),now())`,
    [ASKER_MATCH, kickoff],
  );
  for (const [pair, partner] of [
    ["e2e-xr-pair-a", ORG_ID],
    ["e2e-xr-pair-b", OTHER],
  ]) {
    await db.run(
      `INSERT INTO "ClubPartnership" (id,"askerOrgId","partnerOrgId",status,"askerAcceptedAt","partnerAcceptedAt","createdByUserId","createdAt","updatedAt")
       VALUES ($1,$2,$3,'active',now(),now(),$4,now(),now())`,
      [pair, ASKER, partner, U.admin],
    );
  }
  const postBy = new Date(kickoff.getTime() - 4 * 3600_000);
  for (const [ask, pair, partner, wamid] of [
    [ASK_A, "e2e-xr-pair-a", ORG_ID, `true_${E2E.GROUP_ID}_3EB0XRASKA`],
    [ASK_B, "e2e-xr-pair-b", OTHER, "true_120363999000000081@g.us_3EB0XRASKB"],
  ]) {
    await db.run(
      `INSERT INTO "PartnerAsk" (id,"partnershipId","askerOrgId","partnerOrgId","matchId",places,"roundId",status,"requestedVia","postedAt","postWaMessageId","postBy","closesAt","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,1,$6,'posted','button',now(),$7,$8,$9,now(),now())`,
      [ask, pair, ASKER, partner, ASKER_MATCH, ROUND, wamid, postBy, kickoff],
    );
  }
  await db.run(`DELETE FROM "BotJob"`);
});

test.afterAll(() => {
  resetDb();
});

test("two volunteers at once, one wanted: exactly one place; the other is told the place has gone, with nothing left of him", async ({ request, db }) => {
  const [a, b] = await Promise.all([postDm(request, IAN, `IN (ref ${REF})`), postDm(request, ZARA, `IN (ref ${REF})`)]);
  const outcomes = [a.outcome, b.outcome].sort();
  expect(outcomes, JSON.stringify([a, b])).toEqual(["closed", "registered-in"]);

  const confirmed = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM "Attendance" WHERE "matchId" = $1 AND status = 'CONFIRMED'`, [ASKER_MATCH]);
  expect(confirmed?.n).toBe(1);
  const [winner, loser] = a.outcome === "registered-in" ? [U.fresh, U.extra] : [U.extra, U.fresh];
  const loserPhone = loser === U.fresh ? IAN : ZARA;
  expect(await rowOf(db, ASKER_MATCH, winner)).toBe("CONFIRMED");
  expect(await rowOf(db, ASKER_MATCH, loser)).toBeUndefined();
  // No guest membership for the one who was too late, and he is off the ask.
  const mem = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM "Membership" WHERE "userId" = $1 AND "orgId" = $2`, [loser, ASKER]);
  expect(mem?.n).toBe(0);
  const vols = await db.one<{ v: string[] }>(`SELECT "volunteerUserIds" AS v FROM "PartnerAsk" WHERE id = $1`, [ASK_A]);
  expect(vols?.v).toEqual([winner]);
  const dm = await db.one<{ text: string }>(`SELECT text FROM "BotJob" WHERE kind = 'dm' AND phone = $1 ORDER BY "createdAt" DESC LIMIT 1`, [loserPhone]);
  expect(dm?.text).toBe("*FNF Round*'s place has gone now, thanks for offering.");
});

test("the place that filled the round closes BOTH asks as filled at once; each partner group hears its one line", async ({ db }) => {
  const asks = await db.all<{ id: string; status: string; reason: string | null }>(`SELECT id, status, reason FROM "PartnerAsk" WHERE "roundId" = $1 ORDER BY id`, [ROUND]);
  expect(asks).toEqual([
    { id: ASK_A, status: "filled", reason: "filled" },
    { id: ASK_B, status: "filled", reason: "filled" },
  ]);
  const lines = await db.all<{ orgId: string; text: string }>(`SELECT "orgId", text FROM "BotJob" WHERE kind = 'group' ORDER BY "orgId"`);
  expect(lines).toEqual(
    [
      { orgId: OTHER, text: "✅ *FNF Round*'s place is filled, thanks all 🙌" },
      { orgId: ORG_ID, text: "✅ *FNF Round*'s place is filled, thanks all 🙌" },
    ].sort((x, y) => x.orgId.localeCompare(y.orgId)),
  );
});
