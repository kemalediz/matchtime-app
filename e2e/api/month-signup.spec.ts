/**
 * MONTHLY SQUAD, SLICE 3: THE MONTH OPENS AND PEOPLE SIGN UP, END TO END
 * AGAINST POSTGRES.
 *
 * MDs/monthly-squad-plan-2026-10-05.md, sections 4.1 and 6.2. No model is
 * called anywhere in this file: the list is opened and posted by fixed
 * code, a pasted list is read by the slice 1 reader, and the typed
 * sign-up is a fixed vocabulary.
 *
 * One monthly club ("Vets MNF": 4 regular places) through the real
 * routes, /api/whatsapp/analyze and /api/whatsapp/due-posts (the latter
 * on a pinned clock, x-test-now). The month is NEXT calendar month, so it
 * is in the future for analyze, which has no test clock:
 *
 *   1. nothing happens before the list is due;
 *   2. when it is due the month's matches exist, the month is created
 *      once (two polls at the same moment), this month's regulars are
 *      carried over, and the list is posted once, under its own key;
 *   3. door 1, a pasted list: the sender adds themselves, nobody else is
 *      added and no player is ever created;
 *   4. every place taken: the next person waits, they are told, and the
 *      organisers are told once;
 *   5. door 2, "PAYG FOR <MONTH> <dates>" and "OUT FOR <MONTH>"; a plain
 *      sentence about the month is not a sign-up;
 *   6. the list is re-posted when it changes, once, and not after a
 *      member's paste that shows the same list;
 *   7. a club on WEEKLY mode is untouched; a muted club and a dormant
 *      club open nothing; a Turkish club's list is Turkish;
 *   8. two days before the first game sign-up ends: the month is
 *      "running", the regulars are on the first game and the WEEK's list
 *      is posted. Until kick-off "IN FOR <MONTH>" and a pasted "List for
 *      <Month>" from a newcomer still join the MONTH (never game one as a
 *      one-off), and MatchTime's own sign-up list pasted back is never
 *      read as the week's list.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { formatInTimeZone } from "date-fns-tz";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { engineOn } from "../helpers/stub";
import { E2E, E2E_BASE_URL, REPO_ROOT } from "../helpers/env";
import { ORG_ID } from "../helpers/constants";
import { testDb, type TestDb } from "../helpers/test-db";
import { listOpensAt, monthKickoffs, nextMonthStart, signupEndsAt } from "@/lib/month-signup-rules";
import { buildSignupPasteOthersDm, buildSignupWaitingAdminNotice, buildSignupWaitingDm } from "@/lib/month-signup-copy";
import { londonMonthStart } from "@/lib/squad-month-rules";

test.describe.configure({ mode: "serial" });

const COVERAGE_SQL = path.join(REPO_ROOT, "prisma", "sql", "attendance-event-coverage.sql");
const COVERAGE_TRIGGERS = ["attendance_requires_event_ins", "attendance_requires_event_upd", "attendance_requires_event_del"];

const ORG = "e2e-su-org";
const GROUP = "e2e-signup@g.us";
const ACT = "e2e-su-act";
const ORG2 = "e2e-su-org-tr";
const GROUP2 = "e2e-signup-tr@g.us";
const ACT2 = "e2e-su-act-tr";
const CUR_MONTH = "e2e-su-month-cur";

const LONDON = "Europe/London";
const CUR = londonMonthStart(new Date());
const NEXT = nextMonthStart(CUR);
/** The fixture's weekday: Monday. */
const WEEKDAY = 1;
/** The fixture's dates in the month. The LAST one is cancelled before the
 *  list opens: it is not a game anybody signs up or pays for. */
const CALENDAR = monthKickoffs(NEXT, WEEKDAY, "20:00");
const CANCELLED = CALENDAR[CALENDAR.length - 1];
const KICKOFFS = CALENDAR.slice(0, -1);
const FIRST = KICKOFFS[0];
const DAYS = KICKOFFS.map((k) => Number(formatInTimeZone(k, LONDON, "d")));
const MONTH_NAME = formatInTimeZone(FIRST, LONDON, "MMMM");
const PREV_NAME = formatInTimeZone(new Date(`${CUR}T12:00:00.000Z`), LONDON, "MMMM");
/** 7 days before the first game, 10:00 London. */
const OPENS = listOpensAt(FIRST, 7);
/** Two days before the first game. */
const ENDS = signupEndsAt(new Date(OPENS.getTime() + 5 * 60_000), FIRST);
const after = (mins: number) => new Date(OPENS.getTime() + mins * 60_000);

const P = {
  rob: { id: "e2e-su-rob", name: "Rob Hale", phone: "+447700930001" },
  alex: { id: "e2e-su-alex", name: "Alex Carter", phone: "+447700930002" },
  bilal: { id: "e2e-su-bilal", name: "Bilal Aydin", phone: "+447700930003" },
  chris: { id: "e2e-su-chris", name: "Chris Bell", phone: "+447700930004" },
  dan: { id: "e2e-su-dan", name: "Dan Price", phone: "+447700930005" },
  eve: { id: "e2e-su-eve", name: "Eve Stone", phone: "+447700930006" },
  will: { id: "e2e-su-will", name: "Will Frost", phone: "+447700930007" },
  omar: { id: "e2e-su-omar", name: "Omar Khan", phone: "+447700930008" },
  gone: { id: "e2e-su-gone", name: "Gone Away", phone: "+447700930009" },
  off: { id: "e2e-su-off", name: "Taken Off", phone: "+447700930010" },
  ayse: { id: "e2e-su-ayse", name: "Ayşe Kaya", phone: "+447700930011" },
  ned: { id: "e2e-su-ned", name: "Ned Flynn", phone: "+447700930012" },
} as const;
type Person = (typeof P)[keyof typeof P];
const digits = (phone: string) => phone.replace(/^\+/, "");

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
let seq = 0;
const msgId = () => `e2e-su-${Date.now()}-${++seq}`;

interface Instruction {
  kind: string;
  key: string;
  text?: string;
  phone?: string;
}

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

async function say(request: APIRequestContext, who: Person, body: string, groupId = GROUP, quotedBody?: string): Promise<AnalyzeResult> {
  const waMessageId = msgId();
  const res = await request.post("/api/whatsapp/analyze", {
    headers: KEY,
    data: {
      groupId,
      messages: [
        {
          waMessageId,
          body,
          authorPhone: digits(who.phone),
          authorName: who.name,
          timestamp: new Date().toISOString(),
          ...(quotedBody ? { quotedBody } : {}),
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

const monthOf = (db: TestDb, org = ORG) =>
  db.one<{ id: string; status: string; gamesScheduled: number; listOpenedAt: Date | null; activityId: string }>(
    `SELECT id, status, "gamesScheduled", "listOpenedAt", "activityId" FROM "SquadMonth" WHERE "orgId" = $1 AND "monthStart" = $2::date`,
    [org, NEXT],
  );

const members = async (db: TestDb, org = ORG) =>
  db.all<{ userId: string; kind: string; slot: number | null; note: string | null; out: boolean; source: string; gamesCovered: number; paygMatchIds: string[] }>(
    `SELECT m."userId", m.kind, m.slot, m.note, (m."leftAt" IS NOT NULL) AS out, m.source, m."gamesCovered", m."paygMatchIds"
       FROM "SquadMonthMember" m JOIN "SquadMonth" s ON s.id = m."monthId"
      WHERE s."orgId" = $1 AND s."monthStart" = $2::date ORDER BY m.slot NULLS LAST, m."userId"`,
    [org, NEXT],
  );
const memberOf = async (db: TestDb, who: Person) => (await members(db)).find((m) => m.userId === who.id);

/** The org's matches, the cancelled week left out. */
const matchesOf = (db: TestDb, org = ORG) =>
  db.all<{ id: string; date: Date; maxPlayers: number }>(
    `SELECT m.id, m.date, m."maxPlayers" FROM "Match" m JOIN "Activity" a ON a.id = m."activityId"
      WHERE a."orgId" = $1 AND m.status <> 'CANCELLED' ORDER BY m.date`,
    [org],
  );

const dms = (db: TestDb, who: Person, org = ORG) =>
  db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2 ORDER BY "createdAt"`, [org, digits(who.phone)]);

const users = (db: TestDb) => db.count(`SELECT COUNT(*) FROM "User"`);

const listPosts = (instructions: Instruction[], org = ORG) => instructions.filter((i) => i.key.startsWith(`org-${org}:msu:list:`));

/** Age every "list shown" row, so the 30-minute floor is not what a test is about. */
const ageListPosts = (db: TestDb) =>
  db.run(`UPDATE "SentNotification" SET "createdAt" = "createdAt" - interval '3 days' WHERE key LIKE $1`, [`org-${ORG}:msu:list:%`]);

const footer = (carried: boolean) => [
  `${carried ? `Regulars from ${PREV_NAME} are on already. ` : ""}Not in for ${MONTH_NAME}? Say *OUT FOR ${MONTH_NAME.toUpperCase()}*.`,
  `Want a place for ${MONTH_NAME}? Copy the list and add your name, or say *IN FOR ${MONTH_NAME.toUpperCase()}*.`,
  `Playing some weeks only? Add your name with (PAYG), or (PAYG ${DAYS[1]} only).`,
  `Or sign up here: ${E2E_BASE_URL}/month`,
  `Names in by ${formatInTimeZone(ENDS, LONDON, "EEE d MMM, HH:mm")}. Price and payment details follow once numbers are in.`,
];
const header = `📋 List for ${MONTH_NAME} (${DAYS.length} Mondays: ${DAYS.join(", ")})`;

async function person(db: TestDb, orgId: string, p: { id: string; name: string; phone: string }, role = "PLAYER") {
  await db.run(`INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [
    p.id,
    `${p.id}@e2e.test`,
    p.name,
    p.phone,
  ]);
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1, $2, $3, $4::"MemberRole")`, [`mem-${p.id}`, p.id, orgId, role]);
}

async function club(db: TestDb, o: { org: string; group: string; act: string; sport: string; name: string; language?: string }) {
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled", "squadMode",
                                 "paygPricePence", "adminChannelMode", language, "monthListOpensDaysBefore", "updatedAt")
     VALUES ($1, $2, $1, $3, $4, true, 'monthly', 800, 'each-admin', $5, 7, now())`,
    [o.org, o.name, `${o.org}-invite`, o.group, o.language ?? "en"],
  );
  await db.run(
    `INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt")
     VALUES ($1, $2, 'Basketball', 2, ARRAY['G','F'], ARRAY['Red','Yellow'], now())`,
    [o.sport, o.org],
  );
  await db.run(
    `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "updatedAt")
     VALUES ($1, $2, $3, 'Monday 7-a-side', $4, '20:00', 'Goals', 5, now())`,
    [o.act, o.org, o.sport, WEEKDAY],
  );
}

/** This month's month, running, as the organiser started it: the carry-over's source. */
async function currentMonth(db: TestDb) {
  await db.run(
    `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "gamesPlayedBeforeStart",
                               "startedMidMonthAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4::date, 'running', 4, 4, now() - interval '2 days', now() - interval '2 days', now())`,
    [CUR_MONTH, ORG, ACT, CUR],
  );
  const rows: Array<[Person, string, number | null, boolean]> = [
    [P.bilal, "regular", 2, false],
    [P.alex, "regular", 1, false],
    [P.chris, "regular", 5, false],
    [P.omar, "payg", null, false],
    [P.gone, "regular", 3, false],
    [P.off, "regular", 4, true],
  ];
  for (const [p, kind, slot, off] of rows) {
    await db.run(
      `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, "gamesCovered", source, "leftAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, 'seed-tick', $7, now())`,
      [`${CUR_MONTH}-${p.id}`, CUR_MONTH, p.id, kind, slot, kind === "payg" ? 0 : 4, off ? new Date().toISOString() : null],
    );
  }
}

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await club(db, { org: ORG, group: GROUP, act: ACT, sport: "e2e-su-sport", name: "Vets MNF" });
  await person(db, ORG, P.rob, "OWNER");
  for (const p of [P.alex, P.bilal, P.chris, P.dan, P.eve, P.will, P.omar, P.gone, P.off, P.ned]) await person(db, ORG, p);
  // "Gone Away" has left the group since.
  await db.run(`UPDATE "Membership" SET "leftAt" = now() WHERE "userId" = $1`, [P.gone.id]);
  await currentMonth(db);
  // The organiser cancelled the month's last week before the list opened.
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt")
     VALUES ('e2e-su-cancelled', $1, $2, 4, 'CANCELLED', $2, now())`,
    [ACT, CANCELLED.toISOString()],
  );

  await club(db, { org: ORG2, group: GROUP2, act: ACT2, sport: "e2e-su-sport-tr", name: "Pazartesi Halısaha", language: "tr" });
  await person(db, ORG2, P.ayse, "OWNER");

  // Anything the fixed vocabulary does not read goes to the stubbed pipeline as chat.
  engineOn({});
  await db.run(readFileSync(COVERAGE_SQL, "utf8"));
});

test.afterAll(async () => {
  const db = testDb();
  for (const t of COVERAGE_TRIGGERS) await db.run(`DROP TRIGGER IF EXISTS ${t} ON "Attendance"`);
  resetDb();
});

test("1. before the list is due nothing is opened, created or posted", async ({ request, db }) => {
  const out = await poll(request, new Date(OPENS.getTime() - 60 * 60_000));
  expect(await monthOf(db)).toBeNull();
  expect(await matchesOf(db)).toEqual([]);
  expect(listPosts(out)).toEqual([]);
});

test("2. when it is due: the month's matches exist, the month is created ONCE, the regulars are carried over and the list is posted once", async ({
  request,
  db,
}) => {
  const usersBefore = await users(db);
  // Two polls at the same moment (two Pi processes): one month, one post.
  const [a, b] = await Promise.all([poll(request, after(5)), poll(request, after(5))]);

  const month = await monthOf(db);
  expect(month).toMatchObject({ status: "open", gamesScheduled: KICKOFFS.length, activityId: ACT });
  expect(await db.count(`SELECT COUNT(*) FROM "SquadMonth" WHERE "orgId" = $1 AND "monthStart" = $2::date`, [ORG, NEXT])).toBe(1);

  // Every game of the month (not the cancelled week), at its London kick-off, at the format's size.
  const games = await matchesOf(db);
  expect(games.map((g) => new Date(g.date).toISOString())).toEqual(KICKOFFS.map((k) => k.toISOString()));
  expect(games.every((g) => g.maxPlayers === 4)).toBe(true);

  // This month's regulars, in slot order, renumbered. Not the PAYG player,
  // not the one who left the group, not the one taken off the month.
  expect(await members(db)).toEqual([
    { userId: P.alex.id, kind: "regular", slot: 1, note: null, out: false, source: "carry-over", gamesCovered: KICKOFFS.length, paygMatchIds: [] },
    { userId: P.bilal.id, kind: "regular", slot: 2, note: null, out: false, source: "carry-over", gamesCovered: KICKOFFS.length, paygMatchIds: [] },
    { userId: P.chris.id, kind: "regular", slot: 3, note: null, out: false, source: "carry-over", gamesCovered: KICKOFFS.length, paygMatchIds: [] },
  ]);

  const posts = [...listPosts(a), ...listPosts(b)];
  expect(posts).toHaveLength(1);
  expect(posts[0].kind).toBe("group-message");
  expect(posts[0].key.startsWith(`org-${ORG}:msu:list:${month!.id}:`)).toBe(true);
  expect(posts[0].key.endsWith(":0")).toBe(true);
  expect(posts[0].text).toBe([header, "", "1. Alex Carter", "2. Bilal Aydin", "3. Chris Bell", "4.", "", ...footer(true)].join("\n"));

  // Nothing weekly-shaped beside it, nobody created, nothing touched this month.
  for (const i of [...a, ...b]) {
    expect(i.key, i.key).not.toContain("announce-match");
    expect(i.key, i.key).not.toContain("month-list");
  }
  expect(await users(db)).toBe(usersBefore);
  expect(await db.count(`SELECT COUNT(*) FROM "Attendance" a JOIN "Match" m ON m.id = a."matchId" JOIN "Activity" x ON x.id = m."activityId" WHERE x."orgId" = $1`, [ORG])).toBe(0);

  // The next poll: nothing again.
  const again = await poll(request, after(7));
  expect(listPosts(again)).toEqual([]);
  expect(await matchesOf(db)).toHaveLength(KICKOFFS.length);
});

test("3. door 1, a pasted list: the sender adds themselves; nobody else is added, and no player is created", async ({ request, db }) => {
  const usersBefore = await users(db);
  const res = await say(
    request,
    P.dan,
    [`List for ${MONTH_NAME}`, "", "1. Alex", "2. Bilal", "3. Chris", "4. Dan", "5. Bibs", "6. Will"].join("\n"),
  );
  expect(res).toMatchObject({ handledBy: "fast-path", intent: "month_signup_list", react: "✅", reply: null });
  expect(await memberOf(db, P.dan)).toMatchObject({ kind: "regular", slot: 4, out: false, source: "paste", gamesCovered: KICKOFFS.length });
  // Will is a club player, but he did not paste it. Bibs is nobody.
  expect(await memberOf(db, P.will)).toBeUndefined();
  expect(await users(db)).toBe(usersBefore);
  expect((await dms(db, P.dan)).map((d) => d.text)).toEqual([
    buildSignupPasteOthersDm({ names: ["Bibs", "Will"], monthDate: FIRST, lang: "en" }),
  ]);
  // Nothing is said in the group, and no model read it.
  const row = await db.one<{ handledBy: string; intent: string }>(`SELECT "handledBy", intent FROM "AnalyzedMessage" WHERE "waMessageId" = $1`, [res.waMessageId]);
  expect(row).toEqual({ handledBy: "fast-path", intent: "month_signup_list" });
});

test("4. every place taken: the next person waits, is told, and the organisers are told ONCE", async ({ request, db }) => {
  const eve = await say(request, P.eve, [`List for ${MONTH_NAME}`, "1. Alex", "2. Bilal", "3. Chris", "4. Dan", "5. Eve"].join("\n"));
  expect(eve).toMatchObject({ handledBy: "fast-path", react: "✅" });
  expect(await memberOf(db, P.eve)).toMatchObject({ kind: "payg", slot: null, note: "waiting for a regular place", gamesCovered: 0 });
  expect((await dms(db, P.eve)).map((d) => d.text)).toEqual([buildSignupWaitingDm({ name: P.eve.name, monthDate: FIRST, max: 4, lang: "en" })]);

  const will = await say(request, P.will, `IN FOR ${MONTH_NAME.toUpperCase()}`);
  expect(will).toMatchObject({ handledBy: "fast-path", intent: "month_signup", react: "✅", reply: null });
  expect(await memberOf(db, P.will)).toMatchObject({ kind: "payg", slot: null, note: "waiting for a regular place" });

  // One notice for the month, about the first to wait, with the page to act on.
  const toRob = (await dms(db, P.rob)).map((d) => d.text);
  expect(toRob).toHaveLength(1);
  const link = toRob[0].slice(toRob[0].lastIndexOf("http"));
  expect(toRob[0]).toBe(buildSignupWaitingAdminNotice({ name: P.eve.name, monthDate: FIRST, max: 4, link, lang: "en" }));

  // Saying it again changes nothing and tells nobody again.
  const repeat = await say(request, P.will, `in for ${MONTH_NAME}`);
  expect(repeat).toMatchObject({ handledBy: "fast-path", intent: "month_signup" });
  expect(await dms(db, P.will)).toHaveLength(1);
  expect(await dms(db, P.rob)).toHaveLength(1);
});

test("5. door 2: PAYG with dates, OUT and back IN; a sentence about the month is not a sign-up", async ({ request, db }) => {
  const games = await matchesOf(db);
  const omar = await say(request, P.omar, `PAYG for ${MONTH_NAME} ${DAYS[1]} and ${DAYS[2]}`);
  expect(omar).toMatchObject({ handledBy: "fast-path", intent: "month_signup", react: "✅" });
  const row = await memberOf(db, P.omar);
  expect(row).toMatchObject({ kind: "payg", slot: null, note: null, out: false, source: "reply" });
  expect([...row!.paygMatchIds].sort()).toEqual([games[1].id, games[2].id].sort());

  const out = await say(request, P.bilal, `Out for ${MONTH_NAME}`);
  expect(out).toMatchObject({ handledBy: "fast-path", intent: "month_signup", react: "✅" });
  // The row is kept, flagged; nothing is deleted.
  expect(await memberOf(db, P.bilal)).toMatchObject({ kind: "regular", slot: 2, out: true, source: "carry-over" });

  // Not the fixed words: the pipeline has it, exactly as before.
  for (const body of [`who is in for ${MONTH_NAME}?`, `I'm in for ${MONTH_NAME} if my knee holds`]) {
    const res = await say(request, P.chris, body);
    expect(res.intent, body).not.toBe("month_signup");
  }
  expect(await memberOf(db, P.chris)).toMatchObject({ kind: "regular", slot: 3, out: false });

  // A bare "IN" counts as a reply to the month's list (when the Pi forwards the quoted message).
  // A reply to the WEEK's list, or to a list somebody typed, is not one.
  for (const notTheSignupList of [`📋 List for ${MONTH_NAME}: Mon 2, 20:00\n\n1. Alex Carter\n2.`, `List for ${MONTH_NAME}\n1. Alex Carter\n2.`]) {
    expect((await say(request, P.bilal, "IN", GROUP, notTheSignupList)).intent).not.toBe("month_signup");
    expect(await memberOf(db, P.bilal)).toMatchObject({ out: true });
  }
  const quoted = await say(request, P.bilal, "IN", GROUP, `${header}\n\n1. Alex Carter\n2.`);
  expect(quoted).toMatchObject({ handledBy: "fast-path", intent: "month_signup", react: "✅" });
  expect(await memberOf(db, P.bilal)).toMatchObject({ kind: "regular", slot: 2, out: false });
});

test("6. the list is re-posted when it has changed, once, and not after a paste that shows it", async ({ request, db }) => {
  // (The 30-minute floor is pinned in the unit tests: here the rows are
  // stamped with the real clock and the polls with a pinned one.)
  const out = listPosts(await poll(request, after(40)));
  expect(out).toHaveLength(1);
  expect(out[0].key.endsWith(":1")).toBe(true);
  const text = [
    header,
    "",
    "1. Alex Carter",
    "2. Bilal Aydin",
    "3. Chris Bell",
    "4. Dan Price",
    `5. Omar Khan (PAYG ${DAYS[1]}, ${DAYS[2]})`,
    "",
    "Reserves",
    "1. Eve Stone",
    "2. Will Frost",
    "",
    ...footer(true),
  ].join("\n");
  expect(out[0].text).toBe(text);
  // Posted once: the next poll has nothing.
  expect(listPosts(await poll(request, after(41)))).toEqual([]);

  // A copy with Chris's own line blanked does NOT take him off the month:
  // it may be an old copy, or one somebody else edited.
  await ageListPosts(db);
  const blanked = await say(request, P.chris, text.replace("3. Chris Bell", "3."));
  expect(blanked).toMatchObject({ handledBy: "fast-path", intent: "month_signup_list", react: null });
  expect(await memberOf(db, P.chris)).toMatchObject({ kind: "regular", slot: 3, out: false });
  // He says so, and then pastes the list as it now stands: the group has seen it.
  expect(await say(request, P.chris, `OUT FOR ${MONTH_NAME.toUpperCase()}`)).toMatchObject({ intent: "month_signup", react: "✅" });
  expect(await memberOf(db, P.chris)).toMatchObject({ out: true });
  const pasted = await say(request, P.chris, text.replace("3. Chris Bell", "3."));
  expect(pasted).toMatchObject({ handledBy: "fast-path", intent: "month_signup_list" });
  expect(listPosts(await poll(request, after(120)))).toEqual([]);
  expect(await db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE kind = 'signup-list-seen' AND key LIKE $1`, [`org-${ORG}:msu:list:%`])).toBe(1);
});

test("7. a WEEKLY club is untouched; a muted club and a dormant club open nothing; a Turkish list is Turkish", async ({ request, db }) => {
  // The fixture club (Sutton FC's shape) is on weekly: no month, no read of one, and the words are not a sign-up.
  const weeklyGroup = (await db.one<{ g: string }>(`SELECT "whatsappGroupId" AS g FROM "Organisation" WHERE id = $1`, [ORG_ID]))!.g;
  const weeklyPlayer = (await db.one<{ id: string; name: string; phone: string }>(
    `SELECT u.id, u.name, u."phoneNumber" AS phone FROM "User" u JOIN "Membership" m ON m."userId" = u.id
      WHERE m."orgId" = $1 AND u."phoneNumber" IS NOT NULL LIMIT 1`,
    [ORG_ID],
  ))!;
  const weekly = await say(request, weeklyPlayer as unknown as Person, `IN FOR ${MONTH_NAME.toUpperCase()}`, weeklyGroup);
  expect(weekly.intent).not.toBe("month_signup");
  const weeklyList = await say(request, weeklyPlayer as unknown as Person, [`List for ${MONTH_NAME}`, "1. Alex", "2. Bilal", "3. Chris", "4. Dan"].join("\n"), weeklyGroup);
  expect(weeklyList.intent).not.toBe("month_signup_list");
  const weeklyPosts = await poll(request, after(5), weeklyGroup);
  expect(weeklyPosts.some((i) => i.key.includes(":msu:"))).toBe(false);
  expect(await db.count(`SELECT COUNT(*) FROM "SquadMonth" WHERE "orgId" = $1`, [ORG_ID])).toBe(0);

  // Dormant: nothing is opened for it.
  await db.run(`UPDATE "Organisation" SET "dormantAt" = now() WHERE id = $1`, [ORG2]);
  await poll(request, after(5), GROUP2);
  expect(await monthOf(db, ORG2)).toBeNull();
  expect(await matchesOf(db, ORG2)).toEqual([]);

  // (A club that is not approved cannot have the bot switched on at all:
  // the database refuses it, "Organisation_bot_requires_approval". So for
  // these routes "not approved" IS the muted case below.)
  // Muted: the poll is refused, and a typed sign-up is not read.
  await db.run(`UPDATE "Organisation" SET "dormantAt" = NULL, "whatsappBotEnabled" = false WHERE id = $1`, [ORG2]);
  const muted = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(GROUP2)}`, { headers: { ...KEY, "x-test-now": after(5).toISOString() } });
  expect(muted.status()).toBe(404);
  expect((await say(request, P.ayse, `${MONTH_NAME} varım`, GROUP2)).handledBy).toBe("unknown-or-disabled-group");
  expect(await monthOf(db, ORG2)).toBeNull();

  // Live again, in Turkish, with nobody to carry over.
  await db.run(`UPDATE "Organisation" SET "whatsappBotEnabled" = true WHERE id = $1`, [ORG2]);
  const tr = listPosts(await poll(request, after(5), GROUP2), ORG2);
  expect(tr).toHaveLength(1);
  const lines = tr[0].text!.split("\n");
  const trMonth = formatInTimeZone(FIRST, LONDON, "MMMM", { locale: (await import("date-fns/locale")).tr });
  // (This club cancelled nothing: every date of the month is a game.)
  const allDays = CALENDAR.map((k) => Number(formatInTimeZone(k, LONDON, "d")));
  expect(lines[0]).toBe(`📋 ${trMonth} listesi (${allDays.length} Pazartesi: ${allDays.join(", ")})`);
  expect(lines.slice(2, 6)).toEqual(["1.", "2.", "3.", "4."]);
  expect(tr[0].text).not.toContain("ayının daimi oyuncuları");
  expect(tr[0].text).not.toMatch(/[—–]/);
  // The Turkish words sign her up.
  const ayse = await say(request, P.ayse, `${trMonth} varım`, GROUP2);
  expect(ayse).toMatchObject({ handledBy: "fast-path", intent: "month_signup", react: "✅" });
  expect((await members(db, ORG2)).map((m) => [m.userId, m.kind, m.slot])).toEqual([[P.ayse.id, "regular", 1]]);
});

test("8. two days before the first game sign-up ends: the month runs, and until kick-off people still join the MONTH", async ({ request, db }) => {
  const games = await matchesOf(db);
  const month = (await monthOf(db))!;

  // One minute before: still sign-up.
  await poll(request, new Date(ENDS.getTime() - 60_000));
  expect((await monthOf(db))!.status).toBe("open");

  const out = await poll(request, new Date(ENDS.getTime() + 60_000));
  expect((await monthOf(db))!.status).toBe("running");
  // No more sign-up list. The WEEK's list instead, for the first game.
  expect(listPosts(out)).toEqual([]);
  const week = out.filter((i) => i.key.startsWith(`${games[0].id}:month-list:`));
  expect(week).toHaveLength(1);
  expect(week[0].text!.split("\n").slice(2, 6)).toEqual(["1. Alex Carter", "2. Bilal Aydin", "3.", "4. Dan Price"]);

  const squad = () =>
    db.all<{ userId: string; status: string; position: number; paymentMethod: string | null }>(
      `SELECT "userId", status::text AS status, position, "paymentMethod" FROM "Attendance" WHERE "matchId" = $1 ORDER BY position`,
      [games[0].id],
    );
  // The regulars (Chris said out for the month), each at their own number, paid for by the month.
  expect(await squad()).toEqual([
    { userId: P.alex.id, status: "CONFIRMED", position: 1, paymentMethod: "monthly" },
    { userId: P.bilal.id, status: "CONFIRMED", position: 2, paymentMethod: "monthly" },
    { userId: P.dan.id, status: "CONFIRMED", position: 4, paymentMethod: "monthly" },
  ]);
  // Nothing on a later game yet.
  expect(await db.count(`SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1`, [games[1].id])).toBe(0);

  // Will has been waiting; a place is free now. "IN FOR" makes him a
  // regular at the free number AND puts him on the first game.
  const will = await say(request, P.will, `IN FOR ${MONTH_NAME.toUpperCase()}`);
  expect(will).toMatchObject({ handledBy: "fast-path", intent: "month_signup", react: "✅" });
  expect(await memberOf(db, P.will)).toMatchObject({ kind: "regular", slot: 3, note: null, gamesCovered: KICKOFFS.length });
  expect((await squad()).find((r) => r.userId === P.will.id)).toEqual({ userId: P.will.id, status: "CONFIRMED", position: 3, paymentMethod: "monthly" });

  // Dan says out for the month: off the month, and off the game.
  const dan = await say(request, P.dan, `out for ${MONTH_NAME}`);
  expect(dan).toMatchObject({ handledBy: "fast-path", intent: "month_signup" });
  expect(await memberOf(db, P.dan)).toMatchObject({ out: true });
  expect((await squad()).find((r) => r.userId === P.dan.id)).toMatchObject({ status: "DROPPED" });

  // A NEWCOMER pastes "List for <Month>" with his name on it. He joins the
  // MONTH as a regular (and so goes on game one as one), not game one as
  // a pay-as-you-go one-off.
  const ned = await say(request, P.ned, [`List for ${MONTH_NAME}`, "1. Alex Carter", "2. Bilal Aydin", "3. Will Frost", "4. Ned"].join("\n"));
  expect(ned).toMatchObject({ handledBy: "fast-path", intent: "month_signup_list", react: "✅" });
  expect(await memberOf(db, P.ned)).toMatchObject({ kind: "regular", slot: 4, out: false, source: "paste", gamesCovered: KICKOFFS.length });
  expect((await squad()).find((r) => r.userId === P.ned.id)).toEqual({ userId: P.ned.id, status: "CONFIRMED", position: 4, paymentMethod: "monthly" });

  // MatchTime's own SIGN-UP list, pasted back now, is the month's list and
  // never the week's: Omar (PAYG, numbered on it) is not put on game one,
  // and nobody's week changes.
  const before = await squad();
  const own = await say(
    request,
    P.eve,
    [header, "", "1. Alex Carter", "2. Bilal Aydin", "3.", "4. Dan Price", `5. Omar Khan (PAYG ${DAYS[1]}, ${DAYS[2]})`, "", ...footer(true)].join("\n"),
  );
  expect(own.intent).toBe("month_signup_list");
  expect(await squad()).toEqual(before);
  expect(await db.count(`SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [games[0].id, P.omar.id])).toBe(0);

  // A closed month takes no sign-up at all.
  await db.run(`UPDATE "SquadMonth" SET status = 'closed' WHERE id = $1`, [month.id]);
  const late = await say(request, P.eve, `IN FOR ${MONTH_NAME.toUpperCase()}`);
  expect(late.intent).not.toBe("month_signup");
  expect(await memberOf(db, P.eve)).toMatchObject({ kind: "payg", note: "waiting for a regular place" });
});

test("9. a month STARTED PART-WAY is not in sign-up: a pasted week's list and IN FOR do not sign anybody up for it", async ({ request, db }) => {
  // A second fixture-less world: a club whose organiser started this month
  // part-way. MatchTime holds one match of it (the next game), and none
  // of the games played before.
  const ORG3 = "e2e-su-org-mid";
  const GROUP3 = "e2e-signup-mid@g.us";
  const ACT3 = "e2e-su-act-mid";
  await club(db, { org: ORG3, group: GROUP3, act: ACT3, sport: "e2e-su-sport-mid", name: "Midmonth FC" });
  const reg = { id: "e2e-su-mid-reg", name: "Rhys Regular", phone: "+447700930021" };
  const reg2 = { id: "e2e-su-mid-reg2", name: "Sol Second", phone: "+447700930023" };
  const neo = { id: "e2e-su-mid-neo", name: "Neo Newcomer", phone: "+447700930022" };
  for (const p of [reg, reg2, neo]) await person(db, ORG3, p);
  const next = new Date(Date.now() + 3 * 24 * 60 * 60_000);
  const monthStart = `${formatInTimeZone(next, LONDON, "yyyy-MM")}-01`;
  const monthName = formatInTimeZone(next, LONDON, "MMMM");
  const weekday = Number(formatInTimeZone(next, LONDON, "i")) % 7;
  await db.run(`UPDATE "Activity" SET "dayOfWeek" = $2 WHERE id = $1`, [ACT3, weekday]);
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt")
     VALUES ('e2e-su-mid-match', $1, $2, 4, 'UPCOMING', $2, now())`,
    [ACT3, next.toISOString()],
  );
  await db.run(
    `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "gamesPlayedBeforeStart",
                               "startedMidMonthAt", "createdAt", "updatedAt")
     VALUES ('e2e-su-mid-month', $1, $2, $3::date, 'running', 4, 0, now() - interval '1 hour', now() - interval '1 hour', now())`,
    [ORG3, ACT3, monthStart],
  );
  for (const [i, p] of [reg, reg2].entries()) {
    await db.run(
      `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, "gamesCovered", source, "updatedAt")
       VALUES ($1, 'e2e-su-mid-month', $2, 'regular', $3, 4, 'seed-tick', now())`,
      [`e2e-su-mid-${p.id}`, p.id, i + 1],
    );
  }
  const onMonth = () => db.count(`SELECT COUNT(*) FROM "SquadMonthMember" WHERE "monthId" = 'e2e-su-mid-month'`);

  // "IN FOR <this month>": the month has started, so this is not a sign-up.
  const typed = await say(request, neo as unknown as Person, `IN FOR ${monthName.toUpperCase()}`, GROUP3);
  expect(typed.intent).not.toBe("month_signup");
  // The week's list, headed with the month, with his name on it: the
  // WEEK's reader has it. He is not signed up for the month, nor put on a
  // waiting list for it.
  const pasted = await say(request, neo as unknown as Person, [`List for ${monthName}`, "1. Rhys Regular", "2. Sol Second", "3. Neo"].join("\n"), GROUP3);
  expect(pasted.intent).not.toBe("month_signup_list");
  expect(await onMonth()).toBe(2);
});
