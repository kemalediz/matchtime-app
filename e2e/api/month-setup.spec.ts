/**
 * MONTHLY SQUAD SET-UP, VETS MNF'S DAY 1 (2026-10-29), END TO END AGAINST
 * POSTGRES. The router is STUBBED (`engineOn`: a YES routes "approve");
 * no model is called.
 *
 *   1. A club that has just switched to monthly, with no month before:
 *      when next month's list is due MatchTime posts NO list of its own
 *      (the group has one going), creates no month, and tells the
 *      organisers once what to do. A season break month opens nothing
 *      and says nothing.
 *   2. The WhatsApp door: an organiser pastes the group's list for next
 *      month in the admin group; MatchTime reads it, asks for YES; the YES
 *      starts the month from it, in sign-up, its games made; MatchTime
 *      does not post the list straight back, and posts it once somebody
 *      changes it.
 */
import type { APIRequestContext } from "@playwright/test";
import { formatInTimeZone } from "date-fns-tz";
import { test, expect, resetDb } from "../fixtures";
import { engineOn, clearPipelineStubs } from "../helpers/stub";
import { E2E } from "../helpers/env";
import { testDb, type TestDb } from "../helpers/test-db";
import { listOpensAt, monthKickoffs, nextMonthStart } from "@/lib/month-signup-rules";
import { londonMonthStart } from "@/lib/squad-month-rules";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const LONDON = "Europe/London";
const CUR = londonMonthStart(new Date());
const NEXT = nextMonthStart(CUR);
const WEEKDAY = 1;
const FIRST = monthKickoffs(NEXT, WEEKDAY, "20:30")[0];
const MONTH_NAME = formatInTimeZone(FIRST, LONDON, "MMMM");
const OPENS = listOpensAt(FIRST, 7);
const after = (mins: number) => new Date(OPENS.getTime() + mins * 60_000);

const A = { org: "e2e-ms-a", group: "e2e-ms-a@g.us", act: "e2e-ms-a-act", sport: "e2e-ms-a-sport" };
const B = { org: "e2e-ms-b", group: "e2e-ms-b@g.us", hq: "120363777000000077@g.us", act: "e2e-ms-b-act", sport: "e2e-ms-b-sport" };

const P = {
  davideA: { id: "e2e-ms-davide-a", name: "Davide De Souza", phone: "+447700940001" },
  davide: { id: "e2e-ms-davide", name: "Davide Silva", phone: "+447700940011" },
  steff: { id: "e2e-ms-steff", name: "Steff Jones", phone: "+447700940012" },
  dan: { id: "e2e-ms-dan", name: "Dan Price", phone: "+447700940013" },
  shane: { id: "e2e-ms-shane", name: "Shane Walcott", phone: "+447700940014" },
  ben: { id: "e2e-ms-ben", name: "Ben Hart", phone: "+447700940015" },
} as const;
type Person = (typeof P)[keyof typeof P];
const digits = (phone: string) => phone.replace(/^\+/, "");

interface Instruction {
  kind: string;
  key: string;
  text?: string;
}

async function poll(request: APIRequestContext, now: Date, groupId: string): Promise<Instruction[]> {
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(groupId)}`, {
    headers: { ...KEY, "x-test-now": now.toISOString() },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).instructions as Instruction[];
}

let seq = 0;
async function hq(request: APIRequestContext, text: string, who: Person, extra: Record<string, unknown> = {}) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", groupId: B.hq, messageId: `e2e-ms-hq-${++seq}`, text, senderPhone: digits(who.phone), timestamp: String(Math.floor(Date.now() / 1000)), ...extra },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function say(request: APIRequestContext, who: Person, body: string, groupId: string) {
  const waMessageId = `e2e-ms-${Date.now()}-${++seq}`;
  const res = await request.post("/api/whatsapp/analyze", {
    headers: KEY,
    data: { groupId, messages: [{ waMessageId, body, authorPhone: digits(who.phone), authorName: who.name, timestamp: new Date().toISOString() }] },
  });
  expect(res.status(), await res.text()).toBe(200);
}

async function person(db: TestDb, orgId: string, p: Person, role = "PLAYER") {
  await db.run(`INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [p.id, `${p.id}@e2e.test`, p.name, p.phone]);
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1, $2, $3, $4::"MemberRole")`, [`mem-${p.id}`, p.id, orgId, role]);
}

async function club(db: TestDb, o: { org: string; group: string; act: string; sport: string }, extra: { hq?: string } = {}) {
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled", "squadMode",
                                 "paygPricePence", "adminChannelMode", "adminGroupId", language, "monthListOpensDaysBefore", "updatedAt")
     VALUES ($1, 'Vets MNF', $1, $2, $3, true, 'monthly', 800, $4, $5, 'en', 7, now())`,
    [o.org, `${o.org}-invite`, o.group, extra.hq ? "admin-group" : "each-admin", extra.hq ?? null],
  );
  await db.run(
    `INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt")
     VALUES ($1, $2, 'Football', 8, ARRAY['GK','DEF'], ARRAY['Red','Yellow'], now())`,
    [o.sport, o.org],
  );
  await db.run(
    `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "updatedAt")
     VALUES ($1, $2, $3, 'Monday night', $4, '20:30', 'Goals', 5, now())`,
    [o.act, o.org, o.sport, WEEKDAY],
  );
}

const monthRow = (db: TestDb, org: string) =>
  db.one<{ id: string; status: string; listOpenedAt: Date | null; startedByUserId: string | null; gamesScheduled: number }>(
    `SELECT id, status, "listOpenedAt", "startedByUserId", "gamesScheduled" FROM "SquadMonth" WHERE "orgId" = $1 AND "monthStart" = $2::date`,
    [org, NEXT],
  );
const listPosts = (i: Instruction[], org: string) => i.filter((x) => x.key.startsWith(`org-${org}:msu:list:`));
const dmsTo = (db: TestDb, org: string, who: Person) =>
  db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2 ORDER BY "createdAt"`, [org, digits(who.phone)]);

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await club(db, A);
  await person(db, A.org, P.davideA, "OWNER");
  await club(db, B, { hq: B.hq });
  await person(db, B.org, P.davide, "OWNER");
  for (const p of [P.steff, P.dan, P.shane, P.ben]) await person(db, B.org, p);
  // Club B already has THIS month (so the list in its admin group can only
  // be for next month, whatever today's date).
  await db.run(
    `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "closedAt", "updatedAt")
     VALUES ('e2e-ms-b-cur', $1, $2, $3::date, 'closed', 4, now(), now())`,
    [B.org, B.act, CUR],
  );
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test("1. a club new to monthly: next month's list is due, MatchTime posts none, creates no month, and tells the organiser once", async ({ request, db }) => {
  // A season break month first: nothing at all, not even the notice.
  await db.run(`UPDATE "Organisation" SET "seasonBreakMonths" = ARRAY[$2]::text[] WHERE id = $1`, [A.org, NEXT.slice(0, 7)]);
  expect(listPosts(await poll(request, after(5), A.group), A.org)).toEqual([]);
  expect(await monthRow(db, A.org)).toBeNull();
  expect(await dmsTo(db, A.org, P.davideA)).toEqual([]);
  expect(await db.count(`SELECT COUNT(*) FROM "Match" m JOIN "Activity" a ON a.id = m."activityId" WHERE a."orgId" = $1`, [A.org])).toBe(0);

  // Not a break month: held, and the organiser is told, once.
  await db.run(`UPDATE "Organisation" SET "seasonBreakMonths" = ARRAY[]::text[] WHERE id = $1`, [A.org]);
  expect(listPosts(await poll(request, after(6), A.group), A.org)).toEqual([]);
  expect(listPosts(await poll(request, after(7), A.group), A.org)).toEqual([]);
  expect(await monthRow(db, A.org)).toBeNull();
  const told = await dmsTo(db, A.org, P.davideA);
  expect(told).toHaveLength(1);
  expect(told[0].text).toContain(`The list for ${MONTH_NAME} is due to open, but this is MatchTime's first month with your group`);
  expect(told[0].text).toContain(`Until then I post nothing about ${MONTH_NAME}.`);
  expect(told[0].text).not.toMatch(/[—–]/);

  // Never started: the month's first game (made by the weekly cron) is not
  // run the weekly way beside the group's own list (PR #464 review).
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt")
     VALUES ('e2e-ms-a-g1', $1, $2, 16, 'UPCOMING', $2, now())`,
    [A.act, FIRST.toISOString()],
  );
  // 10:00 London two days before: the weekly "say IN" announcement's window.
  for (const hoursBefore of [58.5, 34.5]) {
    const out = await poll(request, new Date(FIRST.getTime() - hoursBefore * 3600_000), A.group);
    expect(out.filter((i) => i.kind === "group-message"), `${hoursBefore}h before`).toEqual([]);
  }
  // The day before the first game, one more nudge to the organiser.
  await poll(request, new Date(FIRST.getTime() - 23 * 3600_000), A.group);
  await poll(request, new Date(FIRST.getTime() - 22.5 * 3600_000), A.group);
  const again = await dmsTo(db, A.org, P.davideA);
  expect(again).toHaveLength(2);
  expect(again[1].text).toContain(`Reminder: ${MONTH_NAME} starts tomorrow and has not been started here yet`);
});

test("2. the admin group door: the organiser's pasted list starts next month after his YES, and MatchTime does not post it back", async ({ request, db }) => {
  engineOn({ YES: { route: "approve" } });
  const list = [`List for ${MONTH_NAME}`, "1. Davide", "2. Steff", "3. Dan", "4. Shane", "5. Zed"].join("\n");
  const asked = await hq(request, list, P.davide);
  expect(asked).toMatchObject({ handled: true, outcome: "month-seed-proposed" });
  expect(asked.replyText).toContain(`I read your list for ${MONTH_NAME}: 4 players`);
  expect(asked.replyText).toContain("Not known to me yet: Zed");
  expect(asked.replyText).toContain(`Reply YES to start ${MONTH_NAME} with them.`);
  // Nothing is written before the YES.
  expect(await monthRow(db, B.org)).toBeNull();

  const yes = await hq(request, "YES", P.davide, { quotedText: asked.replyText, quotedFromMatchTime: true });
  expect(yes).toMatchObject({ handled: true, outcome: "month-seed-applied" });
  expect(yes.replyText).toContain(`${MONTH_NAME} is started with 4 players`);

  const month = await monthRow(db, B.org);
  expect(month).toMatchObject({ status: "open", startedByUserId: P.davide.id });
  expect(month!.listOpenedAt).not.toBeNull();
  const members = await db.all<{ userId: string; kind: string; slot: number; source: string; gamesCovered: number }>(
    `SELECT "userId", kind, slot, source, "gamesCovered" FROM "SquadMonthMember" WHERE "monthId" = $1 ORDER BY slot`,
    [month!.id],
  );
  expect(members.map((m) => [m.userId, m.kind, m.slot, m.source])).toEqual([
    [P.davide.id, "regular", 1, "seed-list"],
    [P.steff.id, "regular", 2, "seed-list"],
    [P.dan.id, "regular", 3, "seed-list"],
    [P.shane.id, "regular", 4, "seed-list"],
  ]);
  expect(new Set(members.map((m) => m.gamesCovered))).toEqual(new Set([month!.gamesScheduled]));
  // A second YES starts nothing twice.
  expect((await hq(request, "YES", P.davide)).outcome).not.toBe("month-seed-applied");

  // The group's own list: not posted straight back.
  // An hour before sign-up ends (two days before the first game, 18:30 London): in waking hours.
  const ends = new Date(Math.max(month!.listOpenedAt!.getTime() + 2 * 3600_000, FIRST.getTime() - 2 * 86_400_000));
  const now = new Date(ends.getTime() - 3600_000);
  expect(listPosts(await poll(request, now, B.group), B.org)).toEqual([]);
  // Somebody joins through a sign-up door: now the list differs, and is posted once.
  await say(request, P.ben, `IN FOR ${MONTH_NAME.toUpperCase()}`, B.group);
  const posted = listPosts(await poll(request, new Date(now.getTime() + 60_000), B.group), B.org);
  expect(posted).toHaveLength(1);
  expect(posted[0].text).toContain("5. Ben Hart");
});
