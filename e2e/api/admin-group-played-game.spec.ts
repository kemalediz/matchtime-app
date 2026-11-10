/**
 * A TEAM CHANGE AFTER KICKOFF FIXES THE GAME JUST PLAYED (Kemal,
 * 2026-11-10), against a real Postgres and the real admin-group route.
 * No model is called: the shared router, the teams extractor and the HQ
 * squad reader are STUBBED (what the model would have read); everything
 * after them is the shipped code (`played-game-rules.ts`,
 * `team-proposal.ts`).
 *
 * Mon 9 Nov, Vets, kickoff 20:15: Luca played for CJ on Bibs, and once the
 * game was over every WhatsApp team path picked only a game not yet
 * played. Here the fixture club (E2E Test FC, weekly) played an hour ago
 * today, the game is COMPLETED with teams (Alex and Colin on Red, Pat and
 * Tom on Yellow), and next week's game is UPCOMING with no teams.
 *
 * Pinned: a tagged swap in HQ changes the played game, a replacement puts
 * the arrival in the replaced player's slot and makes him CONFIRMED for
 * that game, a plain squad change still goes to the next game, and nothing
 * is queued for the players' group.
 */
import { test, expect, resetDb } from "../fixtures";
import { ACTIVITY_ID, MATCH, ORG_ID, PHONE, SPORT_ID, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { changeReading, clearHqSquadReaderStub, clearPipelineStubs, engineOn, teamsFacts } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000043@g.us";
const ADMIN = PHONE.admin.replace(/^\+/, "");
const PLAYED = MATCH.upcoming;
const NEXT = "e2e-match-next-week";
// An hour ago, so the game is over; the spec needs it to be the same London
// day, so it does not run in the first hour and a bit after midnight London.
const KICKOFF = new Date(Date.now() - 60 * 60 * 1000);
const londonDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(d);
const SAME_DAY = londonDay(KICKOFF) === londonDay(new Date(Date.now() + 5 * 60 * 1000));

let seq = 0;
async function say(request: APIRequestContext, text: string) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", groupId: HQ, messageId: `e2e-agpg-${++seq}`, text, senderPhone: ADMIN, botMentioned: true, timestamp: String(Math.floor(Date.now() / 1000)) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const teamOf = async (db: TestDb, matchId: string, userId: string) =>
  (await db.one<{ team: string }>(`SELECT team::text AS team FROM "TeamAssignment" WHERE "matchId" = $1 AND "userId" = $2`, [matchId, userId]))?.team ?? null;
const statusOf = async (db: TestDb, matchId: string, userId: string) =>
  (await db.one<{ v: string }>(`SELECT status::text AS v FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [matchId, userId]))?.v ?? null;
const playersGroupJobs = (db: TestDb) => db.count(`SELECT count(*) FROM "BotJob" WHERE "orgId" = $1 AND kind = 'group'`, [ORG_ID]);

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group', "listAnnouncer" = 'organisers' WHERE id = $1`, [ORG_ID, HQ]);
  await db.run(`UPDATE "Sport" SET "playersPerTeam" = 2 WHERE id = $1`, [SPORT_ID]);
  // The game just played: an hour ago, COMPLETED, with its teams.
  await db.run(`UPDATE "Match" SET date = $2, "attendanceDeadline" = $3, status = 'COMPLETED' WHERE id = $1`, [
    PLAYED,
    KICKOFF.toISOString(),
    new Date(KICKOFF.getTime() - 5 * 60 * 60 * 1000).toISOString(),
  ]);
  await db.run(
    `INSERT INTO "TeamAssignment" (id,"matchId","userId",team) VALUES
       ('e2e-pg-1',$1,$2,'RED'),('e2e-pg-2',$1,$3,'RED'),('e2e-pg-3',$1,$4,'YELLOW'),('e2e-pg-4',$1,$5,'YELLOW')`,
    [PLAYED, U.admin, U.collector, U.player, U.third],
  );
  // Next week's game, no teams yet.
  await db.run(
    `INSERT INTO "Match" (id,"activityId",date,"maxPlayers",status,"attendanceDeadline","updatedAt") VALUES ($1,$2,$3,5,'UPCOMING',$4,now())`,
    [NEXT, ACTIVITY_ID, new Date(KICKOFF.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(), new Date(KICKOFF.getTime() + 7 * 24 * 60 * 60 * 1000 - 5 * 60 * 60 * 1000).toISOString()],
  );
  engineOn({
    "@Match Time swap Pat and Colin": { route: "balancer", facts: teamsFacts("swap", ["Pat", "Colin"]) },
    "@Match Time put Zara in for Tom": {
      route: "other_att",
      reading: changeReading([["Zara Zest", "in"], ["Tom Third", "out"]], { replaces: { "Zara Zest": "Tom Third" } }),
    },
    "@Match Time Ben is out": { route: "other_att", reading: changeReading([["Ben Bench", "out"]]) },
  });
});

test.afterAll(() => {
  clearPipelineStubs();
  clearHqSquadReaderStub();
  resetDb();
});

test("a swap after kickoff: the game just played changes, nothing for the players' group", async ({ request, db }) => {
  test.skip(!SAME_DAY, "needs the game an hour ago to be today in London");
  const out = await say(request, "@Match Time swap Pat and Colin");
  expect(out).toMatchObject({ handled: true, outcome: "teams-swapped" });
  expect(out.replyText).toMatch(/^This is today's game at \d\d:\d\d, already played\. Nothing is posted in the players' group\.\n\n✅ \*Final teams\*/);
  expect(await teamOf(db, PLAYED, U.player)).toBe("RED");
  expect(await teamOf(db, PLAYED, U.collector)).toBe("YELLOW");
  expect(await db.count(`SELECT count(*) FROM "TeamAssignment" WHERE "matchId" = $1`, [NEXT])).toBe(0);
  expect((await db.one<{ v: string }>(`SELECT status::text AS v FROM "Match" WHERE id = $1`, [PLAYED]))?.v).toBe("COMPLETED");
  expect(await playersGroupJobs(db)).toBe(0);
});

test("a replacement after kickoff: the arrival takes the slot and is confirmed for that game; the next game is untouched", async ({ request, db }) => {
  test.skip(!SAME_DAY, "needs the game an hour ago to be today in London");
  const out = await say(request, "@Match Time put Zara in for Tom");
  expect(out).toMatchObject({ handled: true, outcome: "teams-replaced" });
  expect(out.replyText).toContain("Zara Zest replaces Tom Third on Yellow");
  expect(await teamOf(db, PLAYED, U.extra)).toBe("YELLOW");
  expect(await teamOf(db, PLAYED, U.third)).toBeNull();
  expect(await statusOf(db, PLAYED, U.extra)).toBe("CONFIRMED");
  expect(await statusOf(db, PLAYED, U.third)).toBe("DROPPED");
  const events = await db.all<{ userId: string; cause: string; sourceRef: string }>(
    `SELECT "userId", cause::text AS cause, "sourceRef" FROM "AttendanceEvent" WHERE "matchId" = $1 AND "sourceRef" LIKE 'admin-group:%' ORDER BY "toStatus"::text`,
    [PLAYED],
  );
  expect(events.map((e) => [e.userId, e.cause])).toEqual([
    [U.extra, "admin-squad-edit"],
    [U.third, "admin-squad-edit"],
  ]);
  expect(await statusOf(db, NEXT, U.extra)).toBeNull();
  expect(await statusOf(db, NEXT, U.third)).toBeNull();
  expect(await playersGroupJobs(db)).toBe(0);
});

test("a plain squad change after kickoff is the next game's, never the played game's", async ({ request, db }) => {
  test.skip(!SAME_DAY, "needs the game an hour ago to be today in London");
  await say(request, "@Match Time Ben is out");
  expect(await statusOf(db, PLAYED, U.bench)).toBe("BENCH");
  expect(await db.count(`SELECT count(*) FROM "AttendanceEvent" WHERE "matchId" = $1 AND "userId" = $2 AND "sourceRef" LIKE 'admin-group:%'`, [PLAYED, U.bench])).toBe(0);
});
