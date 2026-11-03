/**
 * A MONTHLY CLUB WHOSE MONTH IS NOT STARTED YET (Vets MNF, 2026-11-03).
 *
 * MatchTime joined the group on 2 Nov, the evening of November's first
 * Monday. On 3 Nov three players said IN and became weekly confirmations,
 * and the owner's posted "MNF November" list opened nothing: the seed door
 * only knew the NEXT month. Kemal: for a monthly club the squad STARTS from
 * the posted monthly list; nobody joins by saying IN before it exists.
 *
 *   1. an IN, tagged or not, writes nothing and says nothing (no tick, no
 *      reply, no "I didn't catch that") while no month covers the game;
 *   2. the organiser's list for THIS month, already under way, is drafted
 *      for this month (not the next) and goes to him by DM; his yes starts
 *      the month part-way, with the games already played counted.
 *
 * Every model step is stubbed: $0.
 */
import type { APIRequestContext } from "@playwright/test";
import { formatInTimeZone } from "date-fns-tz";
import { test, expect, resetDb } from "../fixtures";
import { clearMonthlyReaderStub, engineOn, selfIn, setMonthlyReaderStub, setMonthSeedReplyStub } from "../helpers/stub";
import { E2E } from "../helpers/env";
import { testDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const ORG = "e2e-mns-org";
const GROUP = "e2e-monthly-not-started@g.us";
const ACT = "e2e-mns-act";
const MATCH_ID = "e2e-mns-match";
const LONDON = "Europe/London";
const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const digits = (phone: string) => phone.replace(/^\+/, "");

const owner = { id: "e2e-mns-owner", name: "Davide Sousa", phone: "+447700932001" };
const cj = { id: "e2e-mns-cj", name: "Cj Barber", phone: "+447700932002" };
const steff = { id: "e2e-mns-steff", name: "Steff", phone: "+447700932003" };

// The fixture plays on the weekday of the 1st, at 23:59: by the 2nd its
// first game of this month is always played, and games are left until the
// last of those weekdays. Outside that window the part-way test is skipped.
const now = new Date();
const cur = `${formatInTimeZone(now, LONDON, "yyyy-MM")}-01`;
const curName = formatInTimeZone(new Date(`${cur}T12:00:00Z`), LONDON, "MMMM");
const curNumber = Number(cur.slice(5, 7));
const WEEKDAY = new Date(`${cur}T12:00:00Z`).getUTCDay();
const dayOfMonth = Number(formatInTimeZone(now, LONDON, "d"));
const lastOccurrence = (() => {
  const days = new Date(Date.UTC(Number(cur.slice(0, 4)), curNumber, 0)).getUTCDate();
  let d = 1;
  while (d + 7 <= days) d += 7;
  return d;
})();
const underWayWithGamesLeft = dayOfMonth >= 2 && dayOfMonth <= lastOccurrence;
// The next game: a week from now (a registration match must exist).
const KICKOFF = new Date(now.getTime() + 7 * 24 * 3600_000);

let seq = 0;
async function say(request: APIRequestContext, who: typeof owner, body: string, opts: { tagged?: boolean } = {}) {
  const waMessageId = `e2e-mns-${Date.now()}-${++seq}`;
  const res = await request.post("/api/whatsapp/analyze", {
    headers: KEY,
    data: {
      groupId: GROUP,
      messages: [
        {
          waMessageId,
          body,
          authorPhone: digits(who.phone),
          authorName: who.name,
          timestamp: new Date().toISOString(),
          ...(opts.tagged ? { botMentioned: true } : {}),
        },
      ],
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  const json = (await res.json()) as { results?: Array<{ waMessageId: string; handledBy: string; intent: string | null; react: string | null; reply: string | null }> };
  return json.results?.find((r) => r.waMessageId === waMessageId);
}

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled", "squadMode", "paygPricePence", "adminChannelMode", language, "updatedAt")
     VALUES ($1, 'Vets Not Started', $1, $2, $3, true, 'monthly', 800, 'each-admin', 'en', now())`,
    [ORG, `${ORG}-invite`, GROUP],
  );
  await db.run(`INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt") VALUES ('e2e-mns-sport', $1, 'Football', 7, ARRAY['GK'], ARRAY['A','B'], now())`, [ORG]);
  await db.run(
    `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "updatedAt") VALUES ($1, $2, 'e2e-mns-sport', 'Football 7-a-side', $3, '23:59', 'Goals', 5, now())`,
    [ACT, ORG, WEEKDAY],
  );
  for (const [p, role] of [[owner, "OWNER"], [cj, "PLAYER"], [steff, "PLAYER"]] as const) {
    await db.run(`INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [p.id, `${p.id}@e2e.test`, p.name, p.phone]);
    await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1, $2, $3, $4::"MemberRole")`, [`mem-${p.id}`, p.id, ORG, role]);
  }
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt") VALUES ($1, $2, $3, 14, 'UPCOMING', $4, now())`,
    [MATCH_ID, ACT, KICKOFF.toISOString(), new Date(KICKOFF.getTime() - 5 * 3600_000).toISOString()],
  );
  engineOn({
    IN: { route: "self_att", facts: selfIn() },
    "@Match Time I'm in": { route: "self_att", facts: selfIn() },
  });
});

test.afterAll(() => {
  clearMonthlyReaderStub();
  resetDb();
});

test("1. an IN before the month's list exists writes nothing and says nothing", async ({ request, db }) => {
  setMonthlyReaderStub({ bodies: {} });
  const plain = await say(request, cj, "IN");
  expect(plain).toMatchObject({ react: null, reply: null });
  const tagged = await say(request, steff, "@Match Time I'm in", { tagged: true });
  expect(tagged).toMatchObject({ react: null, reply: null });
  expect(tagged?.intent).not.toBe("not_understood");
  expect(await db.count(`SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1`, [MATCH_ID])).toBe(0);
  expect(await db.count(`SELECT COUNT(*) FROM "AttendanceEvent" WHERE "matchId" = $1`, [MATCH_ID])).toBe(0);
  const rows = await db.all<{ reasoning: string }>(`SELECT reasoning FROM "AnalyzedMessage" WHERE "orgId" = $1`, [ORG]);
  expect(rows.every((r) => r.reasoning.includes("no month for this game yet")), JSON.stringify(rows)).toBe(true);
  // Nothing queued for anybody, organisers included.
  expect(await db.count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1`, [ORG])).toBe(0);
});

test("2. the organiser's list for THIS month, already under way, starts it part-way after his yes", async ({ request, db }) => {
  test.skip(!underWayWithGamesLeft, "needs a day of the month after the first game and before the last");
  const body = `MNF ${curName}\n\n1. Davide (paid)\n2. Steff (paid 4 only)\n3. CJ (Paid)`;
  const ln = (slot: number, name: string, over: Record<string, unknown> = {}) => ({
    section: "playing", slot, name, member: "", guest: false, host: "", games: 0, payg: false, paygDays: [], paid: true, paidPence: 0, concession: false, newbie: false, ...over,
  });
  // As the reader may read it with no month to compare against: the week's.
  setMonthlyReaderStub({
    bodies: {
      [body]: { kind: "list", month: curNumber, gameDay: 0, listOf: "week", lines: [ln(1, "Davide"), ln(2, "Steff", { games: 4 }), ln(3, "CJ")], residual: "", choice: "", signupMonth: 0, signupFor: "", days: [], games: 0 },
    },
  });
  const res = await say(request, owner, body);
  expect(res).toMatchObject({ intent: "month_seed_list", react: null, reply: null });
  const proposal = await db.one<{ monthStart: string; monthSeed: { gamesPlayed: number; rows: Array<{ userId: string }> } }>(
    `SELECT "monthStart", "monthSeed" FROM "AdminSquadProposal" WHERE "orgId" = $1 AND "resolvedAt" IS NULL ORDER BY "createdAt" DESC LIMIT 1`,
    [ORG],
  );
  expect(proposal?.monthStart).toBe(cur);
  expect(proposal?.monthSeed.gamesPlayed).toBeGreaterThanOrEqual(1);
  expect(proposal?.monthSeed.rows.map((r) => r.userId).sort()).toEqual([cj.id, owner.id, steff.id].sort());
  // Nothing in the group; the draft went to him by DM.
  expect(await db.count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1 AND kind <> 'dm'`, [ORG])).toBe(0);
  const dms = await db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2`, [ORG, digits(owner.phone)]);
  expect(dms.some((d) => d.text.includes(curName)), JSON.stringify(dms)).toBe(true);

  setMonthSeedReplyStub({ bodies: { "go ahead": JSON.stringify({ answer: "yes", changes: [], confidence: 0.97 }) } });
  const yes = await request.post("/api/whatsapp/dm-reply", { headers: KEY, data: { phone: digits(owner.phone), body: "go ahead", waMessageId: `e2e-mns-dm-${++seq}`, authorName: owner.name } });
  expect(yes.status(), await yes.text()).toBe(200);
  expect(await yes.json()).toMatchObject({ handled: "month-seed-started", monthStart: cur });
  const month = await db.one<{ played: number; scheduled: number; partWay: boolean }>(
    `SELECT "gamesPlayedBeforeStart" AS played, "gamesScheduled" AS scheduled, ("startedMidMonthAt" IS NOT NULL) AS "partWay" FROM "SquadMonth" WHERE "orgId" = $1`,
    [ORG],
  );
  expect(month?.partWay).toBe(true);
  expect(month?.played).toBeGreaterThanOrEqual(1);
  expect(month!.played).toBeLessThan(month!.scheduled);
});

test("3. a match whose month is in SIGN-UP behaves exactly as before: the IN is the engine's, written as on main", async ({ request, db }) => {
  // Review of #502: only a month with no row at all holds an IN back.
  const ORG3 = "e2e-mns-org3";
  const GROUP3 = "e2e-monthly-not-started-3@g.us";
  const match3 = "e2e-mns-match3";
  const p3 = { id: "e2e-mns3-pat", name: "Pat Signup", phone: "+447700932101" };
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled", "squadMode", "paygPricePence", "adminChannelMode", language, "updatedAt")
     VALUES ($1, 'Vets Sign-up', $1, $2, $3, true, 'monthly', 800, 'each-admin', 'en', now())`,
    [ORG3, `${ORG3}-invite`, GROUP3],
  );
  await db.run(`INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt") VALUES ('e2e-mns-sport3', $1, 'Football', 7, ARRAY['GK'], ARRAY['A','B'], now())`, [ORG3]);
  await db.run(
    `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "updatedAt") VALUES ('e2e-mns-act3', $1, 'e2e-mns-sport3', 'Football 7-a-side', $2, '23:59', 'Goals', 5, now())`,
    [ORG3, KICKOFF.getUTCDay()],
  );
  await db.run(`INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [p3.id, `${p3.id}@e2e.test`, p3.name, p3.phone]);
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1, $2, $3, 'PLAYER'::"MemberRole")`, [`mem-${p3.id}`, p3.id, ORG3]);
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt") VALUES ($1, 'e2e-mns-act3', $2, 14, 'UPCOMING', $3, now())`,
    [match3, KICKOFF.toISOString(), new Date(KICKOFF.getTime() - 5 * 3600_000).toISOString()],
  );
  const kickoffMonth = `${formatInTimeZone(KICKOFF, LONDON, "yyyy-MM")}-01`;
  await db.run(
    `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "gamesPlayedBeforeStart", "listOpenedAt", "createdAt", "updatedAt")
     VALUES ('e2e-mns-month3', $1, 'e2e-mns-act3', $2::date, 'open', 4, 0, now(), now(), now())`,
    [ORG3, kickoffMonth],
  );
  setMonthlyReaderStub({ bodies: {} });
  const waMessageId = `e2e-mns3-${Date.now()}`;
  const res = await request.post("/api/whatsapp/analyze", {
    headers: KEY,
    data: { groupId: GROUP3, messages: [{ waMessageId, body: "IN", authorPhone: digits(p3.phone), authorName: p3.name, timestamp: new Date().toISOString() }] },
  });
  expect(res.status(), await res.text()).toBe(200);
  const row = await db.one<{ handledBy: string; action: string | null; reasoning: string }>(
    `SELECT "handledBy", action, reasoning FROM "AnalyzedMessage" WHERE "waMessageId" = $1`,
    [waMessageId],
  );
  expect(row?.reasoning).not.toContain("no month for this game yet");
  // What main does with it (checked against origin/main on 2026-11-03).
  expect(row).toMatchObject({ handledBy: "attendance-engine", action: "IN" });
  expect(await db.count(`SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [match3, p3.id])).toBe(1);
});
