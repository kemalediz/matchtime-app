/**
 * MONTHLY SQUAD, SLICE 5: THE WEEKLY FLOW, END TO END AGAINST POSTGRES.
 *
 * MDs/monthly-squad-plan-2026-10-05.md, sections 5 and 6.2. No model is
 * called anywhere in this file: the seeding and the posts are fixed code,
 * the pasted lists are read by the slice 1 reader, and the IN and OUT
 * messages go through the stubbed pipeline.
 *
 * One monthly club ("Vets MNF": 5 places, 4 regulars, a PAYG pool) runs a
 * week through the real routes, /api/whatsapp/analyze and
 * /api/whatsapp/due-posts (the latter on a pinned clock, x-test-now):
 *
 *   1. the month's regulars are put on the week's match, once, and the
 *      list is posted in the group's own format, once;
 *   2. a regular drops: "Paid but can't play", a credit, and the place is
 *      offered to the PAYG pool (one group line, a DM each);
 *   3. a PAYG player takes it: the vacated slot NUMBER, the offer closed,
 *      and the list re-posted once;
 *   4. a member pastes the list with a name added: registered, no model,
 *      and MatchTime does not post the same list straight back;
 *   5. a paste that changes SOMEBODY ELSE'S line is applied and that
 *      player gets a DM with the undo (D4); the undo works;
 *   6. an old copy cannot bring a dropped player back; the organisers are
 *      told once a day;
 *   7. a "(paid)" mark is a claim and never a confirmation (D3);
 *   8. after the match: no payment poll, and the collector is asked to
 *      confirm the PAYG price for the PAYG players only;
 *   9. a club on WEEKLY mode (the fixture club, Sutton FC's shape) is
 *      untouched by any of it;
 *  10. a muted club, a late paste and a dormant club change nothing, and
 *      a Turkish club's list is Turkish.
 *
 * analyze has no test clock, so the match is three days from the real
 * now; due-posts and the cron are pinned to tomorrow.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { formatInTimeZone } from "date-fns-tz";
import { tr as trLocale } from "date-fns/locale";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { engineOn, selfIn, selfOut } from "../helpers/stub";
import { E2E, REPO_ROOT } from "../helpers/env";
import { MATCH, NAME, ORG_ID, PHONE, U, londonAt } from "../helpers/constants";
import { testDb, type TestDb } from "../helpers/test-db";
import { buildPasteUndoDm, buildPaygPoolDm, buildPaygPoolGroupPost } from "@/lib/monthly-week-copy";
import { buildFeeConfirmPrompt } from "@/lib/dm-copy";

test.describe.configure({ mode: "serial" });

const COVERAGE_SQL = path.join(REPO_ROOT, "prisma", "sql", "attendance-event-coverage.sql");
const COVERAGE_TRIGGERS = ["attendance_requires_event_ins", "attendance_requires_event_upd", "attendance_requires_event_del"];

const ORG = "e2e-mw-org";
const GROUP = "e2e-monthly@g.us";
const ACT = "e2e-mw-act";
const MATCH_ID = "e2e-mw-match";
const LAST_WEEK = "e2e-mw-last-week";
const MONTH = "e2e-mw-month";

/** The week's match: three days from now, 20:00 London. */
const KICKOFF = londonAt(3, 20, 0);
const LONDON = "Europe/London";
const WHEN = formatInTimeZone(KICKOFF, LONDON, "EEE d MMM, HH:mm");
const MONTH_NAME = formatInTimeZone(KICKOFF, LONDON, "MMMM");
const MONTH_START = `${formatInTimeZone(KICKOFF, LONDON, "yyyy-MM")}-01`;
const WEEKDAY = Number(formatInTimeZone(KICKOFF, LONDON, "i")) % 7; // 0 = Sunday
const HEADER = `📋 List for ${MONTH_NAME}: ${WHEN}`;

/** Pinned polls: tomorrow, inside the day. */
const at = (hour: number, minute = 0) => londonAt(1, hour, minute);

const P = {
  rob: { id: "e2e-mw-rob", name: "Rob Hale", phone: "+447700920001" },
  alex: { id: "e2e-mw-alex", name: "Alex Carter", phone: "+447700920002" },
  bilal: { id: "e2e-mw-bilal", name: "Bilal Aydin", phone: "+447700920003" },
  chris: { id: "e2e-mw-chris", name: "Chris Bell", phone: "+447700920004" },
  dave: { id: "e2e-mw-dave", name: "Dave Stone", phone: "+447700920005" },
  omar: { id: "e2e-mw-omar", name: "Omar Khan", phone: "+447700920006" },
  will: { id: "e2e-mw-will", name: "Will Frost", phone: "+447700920007" },
  tom: { id: "e2e-mw-tom", name: "Tom Reed", phone: "+447700920008" },
} as const;
type Person = (typeof P)[keyof typeof P];
const digits = (phone: string) => phone.replace(/^\+/, "");

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
let seq = 0;
const msgId = () => `e2e-mw-${Date.now()}-${++seq}`;

interface Instruction {
  kind: string;
  key: string;
  text?: string;
  phone?: string;
  targetUser?: string;
  question?: string;
}

/** A real, claiming due-posts poll for a group, on a pinned clock. */
async function poll(request: APIRequestContext, now: Date, groupId = GROUP): Promise<Instruction[]> {
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(groupId)}`, {
    headers: { ...KEY, "x-test-now": now.toISOString() },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).instructions as Instruction[];
}

interface AnalyzeResult {
  waMessageId: string;
  handledBy: string;
  intent: string | null;
  react: string | null;
  reply: string | null;
}

/** One group message, the way the Pi forwards it. */
async function say(
  request: APIRequestContext,
  who: Person,
  body: string,
  opts: { groupId?: string; timestamp?: Date; botMentioned?: boolean } = {},
): Promise<AnalyzeResult> {
  const waMessageId = msgId();
  const res = await request.post("/api/whatsapp/analyze", {
    headers: KEY,
    data: {
      groupId: opts.groupId ?? GROUP,
      messages: [
        {
          waMessageId,
          body,
          authorPhone: digits(who.phone),
          authorName: who.name,
          timestamp: (opts.timestamp ?? new Date()).toISOString(),
          ...(opts.botMentioned ? { botMentioned: true } : {}),
        },
      ],
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  const json = (await res.json()) as { results?: AnalyzeResult[]; ignored?: string };
  return (json.results ?? []).find((r) => r.waMessageId === waMessageId) ?? {
    waMessageId,
    handledBy: json.ignored ?? "none",
    intent: null,
    react: null,
    reply: null,
  };
}

const listPosts = (instructions: Instruction[], matchId = MATCH_ID) =>
  instructions.filter((i) => i.key.startsWith(`${matchId}:month-list:`));

const rows = (db: TestDb, matchId = MATCH_ID) =>
  db.all<{ userId: string; status: string; position: number; paymentMethod: string | null }>(
    `SELECT "userId", status::text AS status, position, "paymentMethod" FROM "Attendance" WHERE "matchId" = $1 ORDER BY position, "userId"`,
    [matchId],
  );
const rowOf = async (db: TestDb, who: Person) => (await rows(db)).find((r) => r.userId === who.id);

const credits = (db: TestDb, orgId = ORG) =>
  db.all<{ userId: string; reason: string; games: number; earnedMatchId: string | null; earnedMonthId: string | null; voided: boolean }>(
    `SELECT "userId", reason, games, "earnedMatchId", "earnedMonthId", ("voidedAt" IS NOT NULL) AS voided
       FROM "SquadCredit" WHERE "orgId" = $1 ORDER BY "createdAt"`,
    [orgId],
  );

const offers = (db: TestDb) =>
  db.all<{ id: string; replacingUserId: string | null; claimedByUserId: string | null; open: boolean; outcome: string | null }>(
    `SELECT id, "replacingUserId", "claimedByUserId", ("resolvedAt" IS NULL) AS open, outcome
       FROM "BenchSlotOffer" WHERE "matchId" = $1 ORDER BY "createdAt"`,
    [MATCH_ID],
  );

const dms = (db: TestDb, who: Person, orgId = ORG) =>
  db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2 ORDER BY "createdAt"`, [
    orgId,
    digits(who.phone),
  ]);

/** Age every "list shown" row (keeping their order), so the 30-minute
 *  floor is not what a test is about. */
const ageListPosts = (db: TestDb) =>
  db.run(`UPDATE "SentNotification" SET "createdAt" = "createdAt" - interval '3 days' WHERE "matchId" = $1 AND key LIKE $2`, [
    MATCH_ID,
    `${MATCH_ID}:month-list:%`,
  ]);

/** The list as the group would write it, for a member to paste. */
function listText(slots: Array<string | null>, cantPlay: string[] = [], header = `List for ${MONTH_NAME}:`): string {
  const lines = [header, "", ...slots.map((name, i) => (name ? `${i + 1}. ${name}` : `${i + 1}.`))];
  if (cantPlay.length > 0) lines.push("", "Paid but can't play", ...cantPlay.map((n, i) => `${i + 1}. ${n}`));
  return lines.join("\n");
}

async function person(db: TestDb, orgId: string, p: { id: string; name: string; phone: string }, role = "PLAYER") {
  await db.run(`INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [
    p.id,
    `${p.id}@e2e.test`,
    p.name,
    p.phone,
  ]);
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1, $2, $3, $4::"MemberRole")`, [
    `mem-${p.id}`,
    p.id,
    orgId,
    role,
  ]);
}

async function club(
  db: TestDb,
  o: { org: string; group: string; act: string; sport: string; name: string; language?: string; collector?: string | null },
) {
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled", "squadMode",
                                 "paygPricePence", "adminChannelMode", language, "paymentCollectionEnabled",
                                 "paymentTrackingEnabled", "updatedAt")
     VALUES ($1, $2, $1, $3, $4, true, 'monthly', 800, 'each-admin', $5, $6, true, now())`,
    [o.org, o.name, `${o.org}-invite`, o.group, o.language ?? "en", o.collector != null],
  );
  await db.run(
    `INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt")
     VALUES ($1, $2, 'Basketball', 3, ARRAY['G','F','C'], ARRAY['Red','Yellow'], now())`,
    [o.sport, o.org],
  );
  await db.run(
    `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "updatedAt")
     VALUES ($1, $2, $3, 'Monday 7-a-side', $4, '20:00', 'Goals', 5, now())`,
    [o.act, o.org, o.sport, WEEKDAY],
  );
}

async function fixture(db: TestDb, id: string, activityId: string, date: Date, status: string, postMatchEndFlow = true) {
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "postMatchEndFlow", "updatedAt")
     VALUES ($1, $2, $3, 5, $4::"MatchStatus", $5, $6, now())`,
    [id, activityId, date.toISOString(), status, new Date(date.getTime() - 5 * 60 * 60 * 1000).toISOString(), postMatchEndFlow],
  );
}

/** A running month, started two days ago, with its members. */
async function month(
  db: TestDb,
  o: { id: string; org: string; act: string },
  members: Array<{ p: { id: string }; kind?: "regular" | "payg"; slot: number | null; paid?: boolean }>,
) {
  await db.run(
    `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "gamesPlayedBeforeStart",
                               "startedMidMonthAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4::date, 'running', 4, 1, now() - interval '2 days', now() - interval '2 days', now())`,
    [o.id, o.org, o.act, MONTH_START],
  );
  for (const m of members) {
    await db.run(
      `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, "gamesCovered", "paidClaimedAt", "paidClaimSource", source, "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'seed-list', now())`,
      [
        `${o.id}-${m.p.id}`,
        o.id,
        m.p.id,
        m.kind ?? "regular",
        m.slot,
        m.kind === "payg" ? 0 : 4,
        m.paid ? new Date().toISOString() : null,
        m.paid ? "organiser" : null,
      ],
    );
  }
}

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await club(db, { org: ORG, group: GROUP, act: ACT, sport: "e2e-mw-sport", name: "Vets MNF", collector: P.rob.id });
  await person(db, ORG, P.rob, "OWNER");
  for (const p of [P.alex, P.bilal, P.chris, P.dave, P.omar, P.will, P.tom]) await person(db, ORG, p);
  await db.run(`UPDATE "Organisation" SET "paymentHolderId" = $2 WHERE id = $1`, [ORG, P.rob.id]);

  // Last week's game: Will played per game (so he is in the PAYG pool).
  await fixture(db, LAST_WEEK, ACT, londonAt(-4, 20, 0), "COMPLETED", false);
  await db.run(
    `WITH a AS (
       INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt")
       VALUES ('e2e-mw-att-will', $1, $2, 'CONFIRMED', 1, now()) RETURNING "matchId", "userId"
     )
     INSERT INTO "AttendanceEvent" (id, "matchId", "userId", "orgId", "toStatus", "toPosition", cause, "actorKind")
     SELECT 'e2e-mw-ev-will', "matchId", "userId", $3, 'CONFIRMED', 1, 'test-fixture', 'system' FROM a`,
    [LAST_WEEK, P.will.id, ORG],
  );
  await fixture(db, MATCH_ID, ACT, KICKOFF, "UPCOMING");

  await month(db, { id: MONTH, org: ORG, act: ACT }, [
    { p: P.alex, slot: 1, paid: true },
    { p: P.bilal, slot: 2, paid: true },
    { p: P.chris, slot: 3 },
    { p: P.dave, slot: 4, paid: true },
    { p: P.omar, kind: "payg", slot: null },
  ]);

  engineOn({ "out sorry": { route: "self_att", facts: selfOut() }, "in": { route: "self_att", facts: selfIn() } });

  // THE COVERAGE GATE, armed for the whole file: every Attendance row
  // written, and every change of status or POSITION (the slot a fill-in
  // takes), must have its AttendanceEvent in the same transaction.
  await db.run(readFileSync(COVERAGE_SQL, "utf8"));
});

test.afterAll(async () => {
  const db = testDb();
  for (const t of COVERAGE_TRIGGERS) await db.run(`DROP TRIGGER IF EXISTS ${t} ON "Attendance"`);
  resetDb();
});

test("1. the regulars are put on the week's match, once, and the list is posted once", async ({ request, db }) => {
  const first = await poll(request, at(10));

  // Every regular, at their own slot number, paid for by the month.
  expect(await rows(db)).toEqual([
    { userId: P.alex.id, status: "CONFIRMED", position: 1, paymentMethod: "monthly" },
    { userId: P.bilal.id, status: "CONFIRMED", position: 2, paymentMethod: "monthly" },
    { userId: P.chris.id, status: "CONFIRMED", position: 3, paymentMethod: "monthly" },
    { userId: P.dave.id, status: "CONFIRMED", position: 4, paymentMethod: "monthly" },
  ]);
  const events = await db.all<{ cause: string; actorKind: string; sourceRef: string }>(
    `SELECT cause, "actorKind", "sourceRef" FROM "AttendanceEvent" WHERE "matchId" = $1`,
    [MATCH_ID],
  );
  expect(events).toHaveLength(4);
  for (const e of events) expect(e).toEqual({ cause: "monthly-squad", actorKind: "scheduler", sourceRef: MONTH });

  // THEIR format, in one message. Chris has not paid, so no mark.
  const posts = listPosts(first);
  expect(posts).toHaveLength(1);
  expect(posts[0].kind).toBe("group-message");
  expect(posts[0].text).toBe(
    [
      HEADER,
      "",
      "1. Alex Carter (paid)",
      "2. Bilal Aydin (paid)",
      "3. Chris Bell",
      "4. Dave Stone (paid)",
      "5.",
      "",
      "1 place open, £8 PAYG: say *IN* to take it.",
    ].join("\n"),
  );
  // The weekly-shaped posts are not sent alongside it.
  expect(first.some((i) => i.key.includes("announce-match") || i.key.includes("evening-update"))).toBe(false);

  // A second poll: nothing seeded twice, nothing posted twice.
  const second = await poll(request, at(10, 40));
  expect(listPosts(second)).toEqual([]);
  expect(await rows(db)).toHaveLength(4);
});

test("2. a regular drops: paid but can't play, a credit, and the place goes to the PAYG pool", async ({ request, db }) => {
  await ageListPosts(db);
  const res = await say(request, P.bilal, "out sorry");
  expect((await rowOf(db, P.bilal))?.status).toBe("DROPPED");

  // One game of credit, for this match, in this month (rule: any-miss).
  expect(await credits(db)).toEqual([
    { userId: P.bilal.id, reason: "missed", games: 1, earnedMatchId: MATCH_ID, earnedMonthId: MONTH, voided: false },
  ]);

  // Nobody is waiting, so the offer is for the PAYG pool.
  expect(await offers(db)).toEqual([
    { id: expect.any(String), replacingUserId: P.bilal.id, claimedByUserId: null, open: true, outcome: null },
  ]);

  const polled = await poll(request, at(11, 30));
  const offerId = (await offers(db))[0].id;
  const offer = polled.filter((i) => i.key.startsWith(`offer-${offerId}`));
  // ONE announcement for the slot, and a DM to each pay-as-you-go player:
  // Omar (PAYG this month) and Will (played per game last week). Tom has
  // never played and is not asked.
  expect(offer.map((i) => [i.kind, i.key])).toEqual([
    ["group-message", `offer-${offerId}`],
    ["dm", `offer-${offerId}:dm:${P.omar.id}`],
    ["dm", `offer-${offerId}:dm:${P.will.id}`],
  ]);
  expect(offer[0].text).toBe(buildPaygPoolGroupPost({ matchDate: KICKOFF, paygPricePence: 800, lang: "en" }));
  expect(offer[1].phone).toBe(digits(P.omar.phone));
  expect(offer[1].text).toBe(
    buildPaygPoolDm({ name: P.omar.name, activityName: "Monday 7-a-side", matchDate: KICKOFF, paygPricePence: 800, lang: "en" }),
  );

  // The drop itself is acknowledged with a react and no words; the
  // changed list reaches the group exactly once, on this poll.
  expect(res).toMatchObject({ intent: "out", reply: null });
  const changed = [
    HEADER,
    "",
    "1. Alex Carter (paid)",
    "2.",
    "3. Chris Bell",
    "4. Dave Stone (paid)",
    "5.",
    "",
    "Paid but can't play",
    "1. Bilal Aydin",
    "",
    "2 places open, £8 PAYG: say *IN* to take one.",
  ].join("\n");
  const posted = listPosts(polled);
  expect(posted).toHaveLength(1);
  expect(posted[0].text).toBe(changed);

  // Nothing again on the next poll.
  const again = await poll(request, at(11, 40));
  expect(listPosts(again)).toEqual([]);
  expect(again.some((i) => i.key.startsWith(`offer-${offerId}`))).toBe(false);
});

test("3. a PAYG player takes it: the vacated slot number, the offer closed, the list re-posted once", async ({ request, db }) => {
  await ageListPosts(db);
  const res = await say(request, P.omar, "in");

  // Slot 2, the number Bilal vacated, not the next number; and he pays per game.
  expect(await rowOf(db, P.omar)).toEqual({ userId: P.omar.id, status: "CONFIRMED", position: 2, paymentMethod: null });
  const took = await db.one<{ note: string; cause: string }>(
    `SELECT note, cause FROM "AttendanceEvent" WHERE "matchId" = $1 AND "userId" = $2 AND "toPosition" = 2`,
    [MATCH_ID, P.omar.id],
  );
  expect(took).toEqual({ cause: "monthly-squad", note: `took slot 2, vacated by ${P.bilal.id}` });
  expect(await offers(db)).toEqual([
    { id: expect.any(String), replacingUserId: P.bilal.id, claimedByUserId: P.omar.id, open: false, outcome: "claimed" },
  ]);
  // Bilal still misses the game: the credit stands.
  expect((await credits(db)).filter((c) => !c.voided)).toHaveLength(1);

  const changed = [
    HEADER,
    "",
    "1. Alex Carter (paid)",
    "2. Omar Khan (PAYG)",
    "3. Chris Bell",
    "4. Dave Stone (paid)",
    "5.",
    "",
    "Paid but can't play",
    "1. Bilal Aydin",
    "",
    "1 place open, £8 PAYG: say *IN* to take it.",
  ].join("\n");
  expect(res).toMatchObject({ intent: "in", react: "✅", reply: null });
  const polled = await poll(request, at(12, 30));
  const posted = listPosts(polled);
  expect(posted).toHaveLength(1);
  expect(posted[0].text).toBe(changed);
  expect(listPosts(await poll(request, at(12, 40)))).toEqual([]);
});

test("asked for the squad, MatchTime answers with the month's list, not the weekly roster", async ({ request, db }) => {
  await ageListPosts(db);
  const ASK = "@Match Time are we full for monday?";
  engineOn({
    [ASK]: { route: "question", facts: { topic: "count", personRef: null, statedCount: null } },
    "out sorry": { route: "self_att", facts: selfOut() },
    "in": { route: "self_att", facts: selfIn() },
  });
  const res = await say(request, P.alex, ASK, { botMentioned: true });
  expect(res.reply).toBe(
    [
      HEADER,
      "",
      "1. Alex Carter (paid)",
      "2. Omar Khan (PAYG)",
      "3. Chris Bell",
      "4. Dave Stone (paid)",
      "5.",
      "",
      "Paid but can't play",
      "1. Bilal Aydin",
      "",
      "1 place open, £8 PAYG: say *IN* to take it.",
    ].join("\n"),
  );
  expect(res.reply).not.toContain("*Playing:*");
  // The group has it now: the scheduler does not post the same list again.
  expect(listPosts(await poll(request, at(12, 50)))).toEqual([]);
});

test("the 30-minute floor: a change straight after a list post waits", async ({ request, db }) => {
  // The last list went out five minutes before this poll's clock.
  const latest = `(SELECT id FROM "SentNotification" WHERE "matchId" = $1 AND key LIKE $3 ORDER BY "createdAt" DESC LIMIT 1)`;
  await db.run(`UPDATE "SentNotification" SET "createdAt" = $2, kind = 'group-message' WHERE id = ${latest}`, [
    MATCH_ID,
    new Date(at(13).getTime() - 5 * 60 * 1000).toISOString(),
    `${MATCH_ID}:month-list:%`,
  ]);
  // The list changes behind the group's back (an admin screen, say).
  await db.run(
    `WITH a AS (UPDATE "Attendance" SET status = 'DROPPED' WHERE "matchId" = $1 AND "userId" = $2 RETURNING "matchId", "userId", position)
     INSERT INTO "AttendanceEvent" (id, "matchId", "userId", "orgId", "fromStatus", "toStatus", "toPosition", cause, "actorKind")
     SELECT 'e2e-mw-ev-chris-out', "matchId", "userId", $3, 'CONFIRMED', 'DROPPED', position, 'test-fixture', 'system' FROM a`,
    [MATCH_ID, P.chris.id, ORG],
  );

  expect(listPosts(await poll(request, at(13)))).toEqual([]);
  const later = listPosts(await poll(request, at(13, 30)));
  expect(later).toHaveLength(1);
  // Chris has not paid: listed apart from "Paid but can't play", and the
  // poll's sweep wrote him no credit.
  expect(later[0].text).toContain("Paid but can't play\n1. Bilal Aydin\n\nCan't play\n1. Chris Bell");
  expect((await credits(db)).map((c) => c.userId)).toEqual([P.bilal.id]);

  // Put the back-dated row behind the real ones again.
  await db.run(`UPDATE "SentNotification" SET "createdAt" = now() - interval '30 days' WHERE "matchId" = $1 AND "createdAt" > now()`, [MATCH_ID]);

  // He comes back: his own slot again.
  await ageListPosts(db);
  await say(request, P.chris, "in");
  expect(await rowOf(db, P.chris)).toMatchObject({ status: "CONFIRMED", position: 3 });
  await poll(request, at(14));
});

test("4. a member pastes the list with a name added: registered without a model, and not echoed back", async ({ request, db }) => {
  await ageListPosts(db);
  const analysed = await db.count(`SELECT COUNT(*) FROM "AnalyzedMessage" WHERE "orgId" = $1`, [ORG]);
  const body = listText(["Alex Carter (paid)", "Omar Khan (PAYG)", "Chris Bell", "Dave Stone (paid)", "Tom Reed"], ["Bilal Aydin"]);
  const res = await say(request, P.tom, body);

  // Read by the list reader, not routed: one row, intent monthly_list.
  expect(res).toMatchObject({ handledBy: "fast-path", intent: "monthly_list", react: "✅", reply: null });
  expect(await db.count(`SELECT COUNT(*) FROM "AnalyzedMessage" WHERE "orgId" = $1`, [ORG])).toBe(analysed + 1);
  expect(await rowOf(db, P.tom)).toEqual({ userId: P.tom.id, status: "CONFIRMED", position: 5, paymentMethod: null });

  // The squad is full now; the weekly "Squad complete" roster is not sent.
  expect(await db.count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1 AND kind = 'group'`, [ORG])).toBe(0);

  // The group has just seen this very list (Tom's paste), so MatchTime
  // does not post it again.
  expect(listPosts(await poll(request, at(14, 40)))).toEqual([]);

  // Pasting it again changes nothing and says nothing.
  const again = await say(request, P.alex, body);
  expect(again).toMatchObject({ handledBy: "fast-path", intent: "monthly_list", react: null, reply: null });
  expect(await rows(db)).toHaveLength(6);
});

test("5. D4: a paste that changes somebody else's line is applied, and that player gets a DM with the undo", async ({ request, db }) => {
  await ageListPosts(db);
  // Alex moves Dave under "Paid but can't play".
  const body = listText(["Alex Carter (paid)", "Omar Khan (PAYG)", "Chris Bell", null, "Tom Reed"], ["Bilal Aydin", "Dave Stone"]);
  const res = await say(request, P.alex, body);
  expect(res).toMatchObject({ intent: "monthly_list", react: "✅" });

  expect((await rowOf(db, P.dave))?.status).toBe("DROPPED");
  // Dave has paid (says paid), so the miss earns a credit.
  expect((await credits(db)).filter((c) => !c.voided).map((c) => c.userId)).toEqual([P.bilal.id, P.dave.id]);
  // The event says who did it.
  const ev = await db.one<{ cause: string; actorKind: string; actorUserId: string }>(
    `SELECT cause, "actorKind", "actorUserId" FROM "AttendanceEvent" WHERE "matchId" = $1 AND "userId" = $2 AND "toStatus" = 'DROPPED'`,
    [MATCH_ID, P.dave.id],
  );
  expect(ev).toEqual({ cause: "pasted-roster", actorKind: "member", actorUserId: P.alex.id });

  // Dave is told, with the one word that undoes it.
  expect((await dms(db, P.dave)).map((d) => d.text)).toEqual([
    buildPasteUndoDm({ change: "out-paid", actorName: P.alex.name, activityName: "Monday 7-a-side", matchDate: KICKOFF, lang: "en" }),
  ]);
  expect((await dms(db, P.dave))[0].text).toContain(`${P.alex.name} moved you to "Paid but can't play"`);
  // Alex changed nobody else's line: nobody else is told.
  for (const p of [P.alex, P.bilal, P.omar, P.tom]) expect(await dms(db, p)).toEqual([]);

  // The place goes to the pool again (Will is the only one left in it).
  const open = (await offers(db)).filter((o) => o.open);
  expect(open.map((o) => o.replacingUserId)).toEqual([P.dave.id]);

  // The paste showed the list as it now stands: not posted back.
  expect(listPosts(await poll(request, at(15)))).toEqual([]);

  // THE UNDO: Dave says IN. Back in his own slot, credit void, offer closed.
  await say(request, P.dave, "in");
  expect(await rowOf(db, P.dave)).toMatchObject({ status: "CONFIRMED", position: 4, paymentMethod: "monthly" });
  expect((await credits(db)).filter((c) => !c.voided).map((c) => c.userId)).toEqual([P.bilal.id]);
  expect((await offers(db)).filter((o) => o.open)).toEqual([]);
});

test("6. an old copy cannot bring back a player who dropped; the organisers are told once a day", async ({ request, db }) => {
  // Tom pastes the list as it was on day one: Bilal back in slot 2.
  const stale = listText(["Alex Carter (paid)", "Bilal Aydin (paid)", "Chris Bell", "Dave Stone (paid)", "Tom Reed"]);
  const before = await rows(db);
  const res = await say(request, P.tom, stale);
  expect(res).toMatchObject({ handledBy: "fast-path", intent: "monthly_list", react: null, reply: null });
  expect(await rows(db)).toEqual(before);
  expect((await rowOf(db, P.bilal))?.status).toBe("DROPPED");
  // Omar's name is simply missing from that copy: he is not taken out.
  expect((await rowOf(db, P.omar))?.status).toBe("CONFIRMED");

  const notices = () => db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND phone = $2 AND text LIKE '%older copy%'`, [ORG, digits(P.rob.phone)]);
  expect(await notices()).toHaveLength(1);
  expect((await notices())[0].text).toContain(`${P.tom.name} pasted an older copy of the list for ${WHEN}. I left Bilal Aydin as they were`);
  await say(request, P.tom, stale);
  expect(await notices()).toHaveLength(1);

  // Bilal himself CAN come back with a paste (and would lose the credit);
  // an admin can too. Here: the admin blanks Tom's line, which a member's
  // paste could not do.
  const adminBody = listText(["Alex Carter (paid)", "Omar Khan (PAYG)", "Chris Bell", "Dave Stone (paid)", null], ["Bilal Aydin"]);
  await say(request, P.rob, adminBody);
  expect((await rowOf(db, P.tom))?.status).toBe("DROPPED");
  // Tom is not a regular: no credit, and his DM says "took you off".
  expect((await credits(db)).filter((c) => !c.voided).map((c) => c.userId)).toEqual([P.bilal.id]);
  expect((await dms(db, P.tom)).map((d) => d.text)).toEqual([
    buildPasteUndoDm({ change: "out", actorName: P.rob.name, activityName: "Monday 7-a-side", matchDate: KICKOFF, lang: "en" }),
  ]);
});

test("7. D3: a (paid) mark on a pasted list is a claim, never a confirmation", async ({ request, db }) => {
  const paid = () =>
    db.one<{ claimed: boolean; source: string | null; pence: number | null; confirmed: boolean }>(
      `SELECT ("paidClaimedAt" IS NOT NULL) AS claimed, "paidClaimSource" AS source, "paidClaimedAmountPence" AS pence,
              ("paidAt" IS NOT NULL) AS confirmed
         FROM "SquadMonthMember" WHERE "monthId" = $1 AND "userId" = $2`,
      [MONTH, P.chris.id],
    );
  expect(await paid()).toEqual({ claimed: false, source: null, pence: null, confirmed: false });

  // Somebody else writes "(Paid £22.50)" on Chris's line.
  await ageListPosts(db);
  const body = listText(["Alex Carter (paid)", "Omar Khan (PAYG)", "Chris Bell (Paid £22.50)", "Dave Stone (paid)", null], ["Bilal Aydin"]);
  const res = await say(request, P.alex, body);
  expect(res).toMatchObject({ intent: "monthly_list", react: "✅" });
  expect(await paid()).toEqual({ claimed: true, source: "other-player", pence: 2250, confirmed: false });

  // The paste itself showed the group that line, so nothing is posted
  // back; the list MatchTime holds now shows him as paid (claimed is
  // enough to show it).
  expect(listPosts(await poll(request, at(16)))).toEqual([]);
  const preview = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(GROUP)}`, {
    headers: { ...KEY, "x-test-now": new Date(KICKOFF.getTime() - 11 * 60 * 60 * 1000).toISOString(), "x-no-claim": "1" },
  });
  const morning = listPosts((await preview.json()).instructions as Instruction[]);
  // 09:00 on match day: the once-a-morning post, whatever else.
  expect(morning).toHaveLength(1);
  expect(morning[0].text).toContain("3. Chris Bell (paid)");

  // A later copy WITHOUT the mark removes nothing.
  await say(request, P.tom, listText(["Alex Carter (paid)", "Omar Khan (PAYG)", "Chris Bell", "Dave Stone (paid)", null], ["Bilal Aydin"]));
  expect(await paid()).toEqual({ claimed: true, source: "other-player", pence: 2250, confirmed: false });
});

test("a list for another month, and a message that is not a list, are not read as this month's list", async ({ request, db }) => {
  const before = await rows(db);
  const other = MONTH_NAME === "November" ? "December" : "November";
  const res = await say(request, P.will, listText(["Alex Carter", "Will Frost", "Chris Bell", "Dave Stone"], [], `List for ${other}:`));
  expect(res.intent).not.toBe("monthly_list");
  expect(await rows(db)).toEqual(before);
});

test("8. after the match: no payment poll, and the PAYG price is confirmed for the PAYG players only", async ({ request, db }) => {
  const after = new Date(KICKOFF.getTime() + 90 * 60 * 1000);
  const polled = await poll(request, after);
  expect(polled.some((i) => i.key === `${MATCH_ID}:payment-poll`)).toBe(false);

  // Omar is the one per-game player on the squad (Tom was taken off).
  const ask = polled.filter((i) => i.key === `${MATCH_ID}:fee-ask`);
  expect(ask).toHaveLength(1);
  expect(ask[0].phone).toBe(digits(P.rob.phone));
  expect(ask[0].text).toBe(
    buildFeeConfirmPrompt({ perPlayer: 8, headcount: 1, matchName: "Monday 7-a-side", wasTotal: false, lang: "en" }),
  );
  const m = await db.one<{ pending: number | null; fee: number | null }>(
    `SELECT "feePendingConfirm" AS pending, "feePerPlayer" AS fee FROM "Match" WHERE id = $1`,
    [MATCH_ID],
  );
  expect(m).toEqual({ pending: 8, fee: null });
  // No list is posted for a match that has kicked off.
  expect(listPosts(polled)).toEqual([]);
});

test("9. WEEKLY: the fixture club (Sutton FC's shape) is untouched by any of it", async ({ request, db }) => {
  const before = await db.all(`SELECT "userId", status::text, position, "paymentMethod" FROM "Attendance" WHERE "matchId" = $1 ORDER BY position`, [
    MATCH.upcoming,
  ]);
  // The same shape of message in a weekly club: section 4's pasted-roster
  // rule decides it, exactly as before monthly mode existed.
  const body = listText([NAME.admin, NAME.collector, NAME.player, "Brand New Person"], [NAME.third]);
  const [res] = (await postAnalyze(request, [{ waMessageId: msgId(), body, authorPhone: PHONE.player, authorName: NAME.player }]))
    .results as AnalyzeResult[];
  expect(res.intent).not.toBe("monthly_list");
  expect(res.intent).toBe("pasted_roster");
  expect(
    await db.all(`SELECT "userId", status::text, position, "paymentMethod" FROM "Attendance" WHERE "matchId" = $1 ORDER BY position`, [
      MATCH.upcoming,
    ]),
  ).toEqual(before);
  expect(await db.count(`SELECT COUNT(*) FROM "User" WHERE name = 'Brand New Person'`)).toBe(0);

  // A weekly OUT: no credit, no monthly marker, no slot event.
  engineOn({ "out sorry": { route: "self_att", facts: selfOut() }, "in": { route: "self_att", facts: selfIn() } });
  await postAnalyze(request, [{ waMessageId: msgId(), body: "out sorry", authorPhone: PHONE.player, authorName: NAME.player }]);
  expect(await credits(db, ORG_ID)).toEqual([]);
  expect(await db.count(`SELECT COUNT(*) FROM "Attendance" a JOIN "Match" m ON m.id = a."matchId" JOIN "Activity" ac ON ac.id = m."activityId"
                          WHERE ac."orgId" = $1 AND a."paymentMethod" = 'monthly'`, [ORG_ID])).toBe(0);
  expect(await db.count(`SELECT COUNT(*) FROM "AttendanceEvent" WHERE "orgId" = $1 AND cause = 'monthly-squad'`, [ORG_ID])).toBe(0);

  // Its poll carries no list, and its match is never seeded by the month.
  const res2 = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`, {
    headers: { ...KEY, "x-test-now": at(10).toISOString(), "x-no-claim": "1" },
  });
  expect(res2.status()).toBe(200);
  const weekly = (await res2.json()).instructions as Instruction[];
  expect(weekly.some((i) => i.key.includes("month-list"))).toBe(false);
  expect(
    await db.one(`SELECT "rollingSeededAt" FROM "Match" WHERE id = $1`, [MATCH.upcoming]),
  ).toEqual({ rollingSeededAt: null });
  expect(U.player).toBeTruthy();
});

test.describe("10. guards, and Turkish", () => {
  const ORG2 = "e2e-mw2-org";
  const GROUP2 = "e2e-monthly-tr@g.us";
  const MATCH2 = "e2e-mw2-match";
  const Q = {
    ayse: { id: "e2e-mw2-ayse", name: "Ayşe Demir", phone: "+447700921001" },
    burak: { id: "e2e-mw2-burak", name: "Burak Kaya", phone: "+447700921002" },
  } as const;

  test.beforeAll(async () => {
    const db = testDb();
    await club(db, { org: ORG2, group: GROUP2, act: "e2e-mw2-act", sport: "e2e-mw2-sport", name: "Pazartesi", language: "tr" });
    await person(db, ORG2, Q.ayse, "OWNER");
    await person(db, ORG2, Q.burak);
    await fixture(db, MATCH2, "e2e-mw2-act", KICKOFF, "UPCOMING");
    await month(db, { id: "e2e-mw2-month", org: ORG2, act: "e2e-mw2-act" }, [
      { p: Q.ayse, slot: 1, paid: true },
      { p: Q.burak, slot: 2, paid: true },
    ]);
    await db.run(`UPDATE "Organisation" SET "dormantAt" = now() WHERE id = $1`, [ORG2]);
  });

  test("a dormant club is not seeded; once it is live again it is, on the cron, and its list is Turkish", async ({ request, db }) => {
    const cron = async () => {
      const res = await request.get("/api/cron/complete-matches", {
        headers: { authorization: `Bearer ${E2E.CRON_SECRET}`, "x-test-now": at(9).toISOString() },
      });
      expect(res.status(), await res.text()).toBe(200);
    };
    await cron();
    expect(await rows(db, MATCH2)).toEqual([]);

    await db.run(`UPDATE "Organisation" SET "dormantAt" = NULL WHERE id = $1`, [ORG2]);
    await cron();
    expect((await rows(db, MATCH2)).map((r) => [r.userId, r.status, r.position, r.paymentMethod])).toEqual([
      [Q.ayse.id, "CONFIRMED", 1, "monthly"],
      [Q.burak.id, "CONFIRMED", 2, "monthly"],
    ]);

    const posts = listPosts(await poll(request, at(10), GROUP2), MATCH2);
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toBe(
      [
        `📋 ${formatInTimeZone(KICKOFF, LONDON, "MMMM", { locale: trLocale })} listesi: ${formatInTimeZone(KICKOFF, LONDON, "d MMMM EEEE HH:mm", { locale: trLocale })}`,
        "",
        "1. Ayşe Demir (ödedi)",
        "2. Burak Kaya (ödedi)",
        "3.",
        "4.",
        "5.",
        "",
        "3 yer boş, maç başı £8 (PAYG): almak için *VARIM* yazın.",
      ].join("\n"),
    );
  });

  test("a muted club's paste changes nothing", async ({ request, db }) => {
    await db.run(`UPDATE "Organisation" SET "whatsappBotEnabled" = false WHERE id = $1`, [ORG2]);
    try {
      const body = ["Ekim listesi", "1. Ayşe Demir", "2."].join("\n");
      const res = await say(request, Q.ayse as unknown as Person, body, { groupId: GROUP2 });
      expect(res.handledBy).toBe("unknown-or-disabled-group");
      expect((await rows(db, MATCH2)).map((r) => r.status)).toEqual(["CONFIRMED", "CONFIRMED"]);
    } finally {
      await db.run(`UPDATE "Organisation" SET "whatsappBotEnabled" = true WHERE id = $1`, [ORG2]);
    }
  });

  test("a paste that arrives late is not acted on", async ({ request, db }) => {
    // Sent two hours ago, delivered now: the late-message guard holds it
    // out of every deterministic peel, this one included.
    const body = [`${formatInTimeZone(KICKOFF, LONDON, "MMMM")} list`, "1. Ayşe Demir", "2.", "", "Paid but can't play", "1. Burak Kaya"].join("\n");
    const res = await say(request, Q.ayse as unknown as Person, body, {
      groupId: GROUP2,
      timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    expect(res.intent).not.toBe("monthly_list");
    expect((await rows(db, MATCH2)).map((r) => r.status)).toEqual(["CONFIRMED", "CONFIRMED"]);
    expect(await credits(db, ORG2)).toEqual([]);

    // The same paste, on time, is applied (the owner is an admin).
    const onTime = await say(request, Q.ayse as unknown as Person, body, { groupId: GROUP2 });
    expect(onTime).toMatchObject({ intent: "monthly_list", react: "✅" });
    expect((await rows(db, MATCH2)).map((r) => [r.userId, r.status])).toEqual([
      [Q.ayse.id, "CONFIRMED"],
      [Q.burak.id, "DROPPED"],
    ]);
    // The undo DM is in the club's language.
    expect((await dms(db, Q.burak as unknown as Person, ORG2)).map((d) => d.text)).toEqual([
      buildPasteUndoDm({ change: "out-paid", actorName: Q.ayse.name, activityName: "Monday 7-a-side", matchDate: KICKOFF, lang: "tr" }),
    ]);
  });
});
