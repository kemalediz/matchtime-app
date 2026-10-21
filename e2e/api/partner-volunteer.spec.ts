/**
 * A partner club's player volunteers by REPLYING to the ask, end to end
 * (cross-club ask, slice S3, 2026-10-16; plan 3.6 and 3.7).
 *
 * The seeded club plays the PARTNER here (Sutton FC's shape): its group
 * received another club's ask. With the router and the attendance
 * extractor stubbed (they read "IN" as an IN, as they always do), the
 * target is decided by the quoted post:
 *
 *   1. "IN" replying to the ask: a guest on the ASKING club's match (on its
 *      bench, an organiser-pick club), labelled; nothing on his own match;
 *   2. the same "IN" with no reply: his own club's match, exactly as ever;
 *   3. a player in his own club's game at an overlapping time: refused,
 *      nothing written on the asking club's match;
 *   4. "OUT" replying to the ask: off the asking club's match again.
 *
 * 2026-10-21 (Kemal): volunteering adds no noise to the partner group.
 * Every answer to him goes by DM (a BotJob of HIS club to his number);
 * his group gets no reply at all.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { MATCH, ORG_ID, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { clearPipelineStubs, engineOn, selfIn, selfOut } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const ASKER = "e2e-xvol-fnf";
const ASKER_MATCH = "e2e-xvol-match";
const ASK = "e2e-xvol-ask";
const POST = `true_${E2E.GROUP_ID}_3EB0XVOLASK`;

type Result = { waMessageId: string; reply?: string | null; intent?: string | null };
let n = 0;
const id = () => `e2e-xvol-${Date.now()}-${++n}`;
/** The DMs queued to this number are cleared before a case, so this reads
 *  what that case sent. */
const clearDms = (db: TestDb, phone: string) => db.run(`DELETE FROM "BotJob" WHERE kind = 'dm' AND phone = $1`, [phone]);
const dmTo = async (db: TestDb, phone: string) =>
  (await db.one<{ text: string }>(`SELECT text FROM "BotJob" WHERE kind = 'dm' AND phone = $1 ORDER BY "createdAt" DESC LIMIT 1`, [phone]))?.text ?? null;
const rowOf = async (db: TestDb, matchId: string, userId: string) =>
  (await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [matchId, userId]))?.status;

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
  // FNF's organiser, to be told who answered.
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role,"createdAt") VALUES ('e2e-xvol-owner',$1,$2,'OWNER',now())`, [U.admin, ASKER]);
  await db.run(
    `INSERT INTO "Sport" (id,"orgId",name,"playersPerTeam",positions,"teamLabels","createdAt","updatedAt")
     VALUES ('e2e-xvol-sport',$1,'Football 9-a-side',9,ARRAY['GK','DEF','MID','FWD'],ARRAY['Red','Yellow'],now(),now())`,
    [ASKER],
  );
  await db.run(
    `INSERT INTO "Activity" (id,"orgId","sportId",name,"dayOfWeek",time,venue,"createdAt","updatedAt")
     VALUES ('e2e-xvol-act',$1,'e2e-xvol-sport','Friday 9-a-side',5,'20:30','Goals Sutton',now(),now())`,
    [ASKER],
  );
  await db.run(
    `INSERT INTO "Match" (id,"activityId",date,"maxPlayers","attendanceDeadline","createdAt","updatedAt")
     VALUES ($1,'e2e-xvol-act',$2,18,$2,now(),now())`,
    [ASKER_MATCH, kickoff],
  );
  await db.run(
    `INSERT INTO "ClubPartnership" (id,"askerOrgId","partnerOrgId",status,"askerAcceptedAt","partnerAcceptedAt","createdByUserId","createdAt","updatedAt")
     VALUES ('e2e-xvol-pair',$1,$2,'active',now(),now(),$3,now(),now())`,
    [ASKER, ORG_ID, U.admin],
  );
  await db.run(
    `INSERT INTO "PartnerAsk" (id,"partnershipId","askerOrgId","partnerOrgId","matchId",places,status,"requestedVia","postedAt","postWaMessageId","postBy","closesAt","createdAt","updatedAt")
     VALUES ($1,'e2e-xvol-pair',$2,$3,$4,1,'posted','button',$8,$5,$6,$7,now(),now())`,
    // Posted two hours ago (UTC wall time: the column has no time zone), so
    // D5b's one-hour question (slice S5b) is not what these cases test.
    [ASK, ASKER, ORG_ID, ASKER_MATCH, POST, new Date(kickoff.getTime() - 4 * 3600_000), kickoff, new Date(Date.now() - 2 * 3600_000).toISOString().replace("Z", "")],
  );
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test("IN replying to the ask: a guest on the asking club's bench, labelled; nothing on his own match", async ({ request, db }) => {
  engineOn({ IN: { route: "self_att", facts: selfIn() } });
  await clearDms(db, "447700900009");
  const m = id();
  const res = await postAnalyze(request, [
    { waMessageId: m, body: "IN", authorPhone: "447700900009", authorName: "Ian Innes", quotedBody: "⚽ *FNF Guests* need 1 player", quotedFromMatchTime: true, quotedMessageId: "3EB0XVOLASK" },
  ]);
  const r = (res.results as Result[]).find((x) => x.waMessageId === m)!;
  expect(await rowOf(db, ASKER_MATCH, U.fresh)).toBe("BENCH");
  expect(await rowOf(db, MATCH.upcoming, U.fresh)).toBeUndefined();
  // Silent in his group; told by DM.
  expect(r.reply ?? null).toBeNull();
  expect(await dmTo(db, "447700900009")).toContain("FNF Guests*'s bench");
  const mem = await db.one<{ guestFromOrgId: string | null; guestMatchId: string | null; leftAt: Date | null }>(
    `SELECT "guestFromOrgId","guestMatchId","leftAt" FROM "Membership" WHERE "userId" = $1 AND "orgId" = $2`,
    [U.fresh, ASKER],
  );
  expect(mem).toEqual({ guestFromOrgId: ORG_ID, guestMatchId: ASKER_MATCH, leftAt: null });
  const ask = await db.one<{ v: string[] }>(`SELECT "volunteerUserIds" AS v FROM "PartnerAsk" WHERE id = $1`, [ASK]);
  expect(ask?.v).toEqual([U.fresh]);
  const ev = await db.one<{ cause: string }>(`SELECT cause FROM "AttendanceEvent" WHERE "matchId" = $1 AND "userId" = $2 ORDER BY "at" DESC LIMIT 1`, [ASKER_MATCH, U.fresh]);
  expect(ev?.cause).toBe("partner-ask");
  // The asking club's organisers are told, by name and club.
  const told = await db.one<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [ASKER]);
  expect(told?.text ?? "").toContain("answered your ask");
});

test("the same IN with no reply is an IN for his own club's match, as ever", async ({ request, db }) => {
  engineOn({ IN: { route: "self_att", facts: selfIn() } });
  await postAnalyze(request, [{ waMessageId: id(), body: "IN", authorPhone: "447700900010", authorName: "Zara Zest" }]);
  expect(await rowOf(db, MATCH.upcoming, U.extra)).toBeTruthy();
  expect(await rowOf(db, ASKER_MATCH, U.extra)).toBeUndefined();
});

test("a player in his own club's game at an overlapping time is refused, nothing written there", async ({ request, db }) => {
  engineOn({ IN: { route: "self_att", facts: selfIn() } });
  await clearDms(db, "447700900003");
  const m = id();
  const res = await postAnalyze(request, [
    { waMessageId: m, body: "IN", authorPhone: "447700900003", authorName: "Pat Player", quotedFromMatchTime: true, quotedMessageId: "3EB0XVOLASK" },
  ]);
  const r = (res.results as Result[]).find((x) => x.waMessageId === m)!;
  expect(r.reply ?? null).toBeNull();
  expect(await dmTo(db, "447700900003")).toContain("so I can't put you on");
  expect(await rowOf(db, ASKER_MATCH, U.player)).toBeUndefined();
  expect(await rowOf(db, MATCH.upcoming, U.player)).toBe("CONFIRMED");
});

test("OUT replying to the ask takes him off the asking club's match", async ({ request, db }) => {
  engineOn({ OUT: { route: "self_att", facts: selfOut() } });
  const m = id();
  await postAnalyze(request, [
    { waMessageId: m, body: "OUT", authorPhone: "447700900009", authorName: "Ian Innes", quotedFromMatchTime: true, quotedMessageId: "3EB0XVOLASK" },
  ]);
  expect(await rowOf(db, ASKER_MATCH, U.fresh)).toBe("DROPPED");
  expect(await rowOf(db, MATCH.upcoming, U.fresh)).toBeUndefined();
});

test("M1 (review, Kemal): a partner club with NO upcoming game of its own still lends: the reply registers", async ({ request, db }) => {
  await db.run(`UPDATE "Match" SET status = 'CANCELLED' WHERE id = $1`, [MATCH.upcoming]);
  engineOn({ IN: { route: "self_att", facts: selfIn() } });
  await clearDms(db, "447700900010");
  const m = id();
  const res = await postAnalyze(request, [
    { waMessageId: m, body: "IN", authorPhone: "447700900010", authorName: "Zara Zest", quotedFromMatchTime: true, quotedMessageId: "3EB0XVOLASK" },
  ]);
  const r = (res.results as Result[]).find((x) => x.waMessageId === m)!;
  expect(await rowOf(db, ASKER_MATCH, U.extra)).toBe("BENCH");
  expect(r.reply ?? null).toBeNull();
  expect(await dmTo(db, "447700900010")).toContain("bench");
});
