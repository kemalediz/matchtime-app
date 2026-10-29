/**
 * THE MONTHLY READER, END TO END (2026-10-29, Vets MNF). The model reads a
 * monthly club's pasted lists and sign-ups; the route acts on what it
 * read. The model is stubbed here (`setMonthlyReaderStub`: the answer it
 * would give, keyed by the message), so this proves what MatchTime DOES
 * with a reading, through the real route and database, for $0:
 *
 *   B1. "Chris 3 only" on a pasted list: Chris commits to 3 games
 *       (`SquadMonthMember.gamesCommitted`, agent A's setter);
 *   B2. a guest on a pasted list ("Luca", brought by Alex) is added to the
 *       week as a new player, never matched to the member "Lucas", and
 *       Alex is told once who was added;
 *   B3. somebody not on a running month adds himself to the MONTH's list
 *       in the middle of it: he joins the month for the games left;
 *   B4. "I'm in for <month> except the last week": a sign-up in plain
 *       words, with the games committed;
 *   FAIL SAFE: a reading that fails changes nothing, and no name on the
 *       list is registered by any other path.
 */
import type { APIRequestContext } from "@playwright/test";
import { formatInTimeZone } from "date-fns-tz";
import { test, expect, resetDb } from "../fixtures";
import { clearMonthlyReaderStub, engineOn, setMonthlyReaderStub } from "../helpers/stub";
import { E2E } from "../helpers/env";
import { londonAt } from "../helpers/constants";
import { testDb, type TestDb } from "../helpers/test-db";
import { buildPasteGuestsAddedDm } from "@/lib/monthly-week-copy";
import { firstKickoffOf, nextMonthStart } from "@/lib/month-signup-rules";

test.describe.configure({ mode: "serial" });

const ORG = "e2e-mr-org";
const GROUP = "e2e-monthly-reader@g.us";
const ACT = "e2e-mr-act";
const MATCH_ID = "e2e-mr-match";
const MONTH = "e2e-mr-month";
const KICKOFF = londonAt(3, 20, 0);
const LONDON = "Europe/London";
const MONTH_NAME = formatInTimeZone(KICKOFF, LONDON, "MMMM");
const MONTH_NUMBER = Number(formatInTimeZone(KICKOFF, LONDON, "M"));
const MONTH_START = `${formatInTimeZone(KICKOFF, LONDON, "yyyy-MM")}-01`;
const WEEKDAY = Number(formatInTimeZone(KICKOFF, LONDON, "i")) % 7;
const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };

const P = {
  rob: { id: "e2e-mr-rob", name: "Rob Hale", phone: "+447700930001" },
  alex: { id: "e2e-mr-alex", name: "Alex Carter", phone: "+447700930002" },
  bilal: { id: "e2e-mr-bilal", name: "Bilal Aydin", phone: "+447700930003" },
  chris: { id: "e2e-mr-chris", name: "Chris Bell", phone: "+447700930004" },
  lucas: { id: "e2e-mr-lucas", name: "Lucas Moore", phone: "+447700930005" },
  will: { id: "e2e-mr-will", name: "Will Frost", phone: "+447700930006" },
  tom: { id: "e2e-mr-tom", name: "Tom Reed", phone: "+447700930007" },
} as const;
type Person = (typeof P)[keyof typeof P];
const digits = (phone: string) => phone.replace(/^\+/, "");
let seq = 0;

async function say(request: APIRequestContext, who: Person, body: string): Promise<{ handledBy: string; intent: string | null; react: string | null }> {
  const waMessageId = `e2e-mr-${Date.now()}-${++seq}`;
  const res = await request.post("/api/whatsapp/analyze", {
    headers: KEY,
    data: { groupId: GROUP, messages: [{ waMessageId, body, authorPhone: digits(who.phone), authorName: who.name, timestamp: new Date().toISOString() }] },
  });
  expect(res.status(), await res.text()).toBe(200);
  const json = (await res.json()) as { results?: Array<{ waMessageId: string; handledBy: string; intent: string | null; react: string | null }>; ignored?: string };
  return json.results?.find((r) => r.waMessageId === waMessageId) ?? { handledBy: json.ignored ?? "none", intent: null, react: null };
}

async function poll(request: APIRequestContext): Promise<void> {
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(GROUP)}`, {
    headers: { ...KEY, "x-test-now": londonAt(1, 10, 0).toISOString() },
  });
  expect(res.status(), await res.text()).toBe(200);
}

/** The reader's answer for one line (the schema's object). */
const line = (slot: number, name: string, over: Record<string, unknown> = {}) => ({
  section: "playing",
  slot,
  name,
  member: "",
  guest: false,
  host: "",
  games: 0,
  payg: false,
  paygDays: [],
  paid: false,
  paidPence: 0,
  concession: false,
  newbie: false,
  ...over,
});
const listAnswer = (lines: unknown[], over: Record<string, unknown> = {}) => ({
  kind: "list",
  month: MONTH_NUMBER,
  gameDay: 0,
  listOf: "week",
  lines,
  residual: "",
  choice: "",
  signupMonth: 0,
  days: [],
  games: 0,
  ...over,
});

async function person(db: TestDb, p: Person, role = "PLAYER") {
  await db.run(`INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [p.id, `${p.id}@e2e.test`, p.name, p.phone]);
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1, $2, $3, $4::"MemberRole")`, [`mem-${p.id}`, p.id, ORG, role]);
}

const attendance = (db: TestDb) =>
  db.all<{ userId: string; name: string; status: string }>(
    `SELECT a."userId", u.name, a.status::text AS status FROM "Attendance" a JOIN "User" u ON u.id = a."userId" WHERE a."matchId" = $1 ORDER BY a.position`,
    [MATCH_ID],
  );
const monthRow = (db: TestDb, who: Person) =>
  db.one<{ kind: string; slot: number | null; gamesCommitted: number | null; out: boolean }>(
    `SELECT kind, slot, "gamesCommitted", ("leftAt" IS NOT NULL) AS out FROM "SquadMonthMember" WHERE "monthId" = $1 AND "userId" = $2`,
    [MONTH, who.id],
  );
const dms = (db: TestDb, who: Person) =>
  db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2 ORDER BY "createdAt"`, [ORG, digits(who.phone)]);

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled", "squadMode",
                                 "paygPricePence", "adminChannelMode", language, "paymentTrackingEnabled", "updatedAt")
     VALUES ($1, 'Vets MNF', $1, $2, $3, true, 'monthly', 800, 'each-admin', 'en', true, now())`,
    [ORG, `${ORG}-invite`, GROUP],
  );
  await db.run(
    `INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt")
     VALUES ('e2e-mr-sport', $1, 'Football', 6, ARRAY['GK','DEF','MID','FWD'], ARRAY['Bibs','Shirts'], now())`,
    [ORG],
  );
  await db.run(
    `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "updatedAt")
     VALUES ($1, $2, 'e2e-mr-sport', 'Monday 6-a-side', $3, '20:00', 'Goals', 5, now())`,
    [ACT, ORG, WEEKDAY],
  );
  await person(db, P.rob, "OWNER");
  for (const p of [P.alex, P.bilal, P.chris, P.lucas, P.will, P.tom]) await person(db, p);
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "postMatchEndFlow", "updatedAt")
     VALUES ($1, $2, $3, 12, 'UPCOMING', $4, true, now())`,
    [MATCH_ID, ACT, KICKOFF.toISOString(), new Date(KICKOFF.getTime() - 5 * 3600_000).toISOString()],
  );
  await db.run(
    `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "gamesPlayedBeforeStart",
                               "startedMidMonthAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4::date, 'running', 4, 1, now() - interval '2 days', now() - interval '2 days', now())`,
    [MONTH, ORG, ACT, MONTH_START],
  );
  for (const [p, slot] of [[P.alex, 1], [P.bilal, 2], [P.chris, 3]] as const) {
    await db.run(
      `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, "gamesCovered", source, "updatedAt")
       VALUES ($1, $2, $3, 'regular', $4, 4, 'seed-list', now())`,
      [`${MONTH}-${p.id}`, MONTH, p.id, slot],
    );
  }
  engineOn({});
});

test.afterAll(() => {
  clearMonthlyReaderStub();
  resetDb();
});

const LIST = (extra: string[] = []) => [`List for ${MONTH_NAME}:`, "1. Alex", "2. Bilal", "3. Chris", ...extra].join("\n");

test("the week is seeded", async ({ request, db }) => {
  await poll(request);
  expect((await attendance(db)).map((r) => r.userId)).toEqual([P.alex.id, P.bilal.id, P.chris.id]);
});

test("B2: a guest on a member's paste is added as a new player of the week, never the member 'Lucas'; the member is told once", async ({ request, db }) => {
  const body = LIST(["4. Luca"]);
  setMonthlyReaderStub({
    bodies: {
      [body]: listAnswer([line(1, "Alex"), line(2, "Bilal"), line(3, "Chris"), line(4, "Luca", { guest: true, host: "sender" })]),
    },
  });
  const res = await say(request, P.alex, body);
  expect(res).toMatchObject({ handledBy: "fast-path", intent: "monthly_list", react: "✅" });
  const rows = await attendance(db);
  expect(rows.map((r) => r.name)).toEqual([P.alex.name, P.bilal.name, P.chris.name, "Luca"]);
  expect(rows.some((r) => r.userId === P.lucas.id)).toBe(false);
  const text = buildPasteGuestsAddedDm({ names: ["Luca"], matchDate: KICKOFF, lang: "en" });
  const alexDms = await dms(db, P.alex);
  expect(alexDms.filter((d) => d.text === text), JSON.stringify(alexDms)).toHaveLength(1);
  // The same paste again adds nobody twice and says nothing more.
  await say(request, P.alex, body);
  expect((await attendance(db)).filter((r) => r.name === "Luca")).toHaveLength(1);
});

test("B1: 'Chris 3 only' on his own paste: he commits to 3 games of the month", async ({ request, db }) => {
  const body = LIST().replace("3. Chris", "3. Chris 3 only");
  setMonthlyReaderStub({ bodies: { [body]: listAnswer([line(1, "Alex"), line(2, "Bilal"), line(3, "Chris", { games: 3 })]) } });
  await say(request, P.chris, body);
  expect(await monthRow(db, P.chris)).toMatchObject({ kind: "regular", gamesCommitted: 3 });
});

test("B1: the same note written by somebody else (not an organiser) changes nothing", async ({ request, db }) => {
  const body = LIST().replace("2. Bilal", "2. Bilal 2 only");
  setMonthlyReaderStub({ bodies: { [body]: listAnswer([line(1, "Alex"), line(2, "Bilal", { games: 2 }), line(3, "Chris")]) } });
  await say(request, P.alex, body);
  expect(await monthRow(db, P.bilal)).toMatchObject({ gamesCommitted: null });
});

test("B3: somebody not on the running month adds himself to the MONTH's list: he joins it for the games left", async ({ request, db }) => {
  const body = LIST(["4. Will"]);
  setMonthlyReaderStub({ bodies: { [body]: listAnswer([line(1, "Alex"), line(2, "Bilal"), line(3, "Chris"), line(4, "Will")], { listOf: "month" }) } });
  const res = await say(request, P.will, body);
  expect(res).toMatchObject({ handledBy: "fast-path", intent: "month_signup_list" });
  expect(await monthRow(db, P.will)).toMatchObject({ kind: "regular", out: false });
});

test("B4: 'in for <month> except the last week' joins the month with the games committed", async ({ request, db }) => {
  const body = `I'm in for ${MONTH_NAME} except the last week`;
  setMonthlyReaderStub({ bodies: { [body]: { ...listAnswer([]), kind: "signup", choice: "in", signupMonth: MONTH_NUMBER, games: 2 } } });
  const res = await say(request, P.tom, body);
  expect(res).toMatchObject({ handledBy: "fast-path", intent: "month_signup", react: "✅" });
  expect(await monthRow(db, P.tom)).toMatchObject({ kind: "regular", gamesCommitted: 2 });
});

test("an organiser's list for the COMING month in the players' group: the draft goes to him by DM (with '4 only'), nothing in the group", async ({ request, db }) => {
  // A second club with no month yet (Day 1: MatchTime joins while the
  // group is filling in its list for the coming month).
  const ORG2 = "e2e-mr-org2";
  const GROUP2 = "e2e-monthly-reader-2@g.us";
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled", "squadMode", "paygPricePence", "adminChannelMode", language, "updatedAt")
     VALUES ($1, 'Vets Two', $1, $2, $3, true, 'monthly', 800, 'each-admin', 'en', now())`,
    [ORG2, `${ORG2}-invite`, GROUP2],
  );
  await db.run(`INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt") VALUES ('e2e-mr-sport2', $1, 'Football', 6, ARRAY['GK'], ARRAY['A','B'], now())`, [ORG2]);
  await db.run(
    `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "updatedAt") VALUES ('e2e-mr-act2', $1, 'e2e-mr-sport2', 'Monday 6-a-side', 1, '20:00', 'Goals', 5, now())`,
    [ORG2],
  );
  const owner = { id: "e2e-mr2-owner", name: "Dave Owner", phone: "+447700931001" };
  const player = { id: "e2e-mr2-pat", name: "Pat Jones", phone: "+447700931002" };
  const sam = { id: "e2e-mr2-sam", name: "Sam Miles", phone: "+447700931003" };
  for (const [p, role] of [[owner, "OWNER"], [player, "PLAYER"], [sam, "PLAYER"]] as const) {
    await db.run(`INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [p.id, `${p.id}@e2e.test`, p.name, p.phone]);
    await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1, $2, $3, $4::"MemberRole")`, [`mem-${p.id}`, p.id, ORG2, role]);
  }
  // The coming month, as the seed door works it out: this month while its
  // first Monday is still to come, else the next.
  const cur = `${formatInTimeZone(new Date(), LONDON, "yyyy-MM")}-01`;
  const next = nextMonthStart(cur);
  const first = firstKickoffOf(cur, 1, "20:00");
  const coming = first && first.getTime() > Date.now() ? cur : next;
  const comingDate = new Date(`${coming}T12:00:00Z`);
  const comingName = formatInTimeZone(comingDate, LONDON, "MMMM");
  const body = `List for ${comingName}\n1. Dave\n2. smiler 4 only`;
  setMonthlyReaderStub({
    bodies: {
      [body]: listAnswer([line(1, "Dave"), line(2, "smiler", { games: 4 })], { listOf: "month", month: Number(coming.slice(5, 7)) }),
    },
  });
  const post = async (who: { phone: string; name: string }) => {
    const res = await request.post("/api/whatsapp/analyze", {
      headers: KEY,
      data: { groupId: GROUP2, messages: [{ waMessageId: `e2e-mr2-${Date.now()}-${++seq}`, body, authorPhone: digits(who.phone), authorName: who.name, timestamp: new Date().toISOString() }] },
    });
    expect(res.status(), await res.text()).toBe(200);
    return ((await res.json()) as { results?: Array<{ intent: string | null; react: string | null; reply: string | null }> }).results?.[0];
  };
  // "smiler" is matched by the alias the club has for Sam.
  await db.run(`INSERT INTO "UserAlias" (id, "orgId", "userId", alias, source) VALUES ('e2e-mr2-alias', $1, $2, 'smiler', 'manual')`, [ORG2, sam.id]);
  const res = await post(owner);
  expect(res).toMatchObject({ intent: "month_seed_list", react: null, reply: null });
  const proposal = await db.one<{ monthSeed: { rows: Array<{ userId: string; gamesCommitted: number | null }> } }>(
    `SELECT "monthSeed" FROM "AdminSquadProposal" WHERE "orgId" = $1 AND "resolvedAt" IS NULL ORDER BY "createdAt" DESC LIMIT 1`,
    [ORG2],
  );
  expect(proposal?.monthSeed.rows.map((r) => [r.userId, r.gamesCommitted])).toEqual([
    [owner.id, null],
    [sam.id, 4],
  ]);
  const ownerDms = await db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2`, [ORG2, digits(owner.phone)]);
  expect(ownerDms.some((d) => d.text.includes(comingName) && d.text.includes("/admin/months")), JSON.stringify(ownerDms)).toBe(true);
  // Nothing posted in the group.
  expect(await db.count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1 AND kind <> 'dm'`, [ORG2])).toBe(0);
  // A player posting the same list is not an organiser: no new draft.
  const before = await db.count(`SELECT COUNT(*) FROM "AdminSquadProposal" WHERE "orgId" = $1`, [ORG2]);
  expect((await post(player))?.intent).not.toBe("month_seed_list");
  expect(await db.count(`SELECT COUNT(*) FROM "AdminSquadProposal" WHERE "orgId" = $1`, [ORG2])).toBe(before);
});

test("FAIL SAFE: when the reading fails nothing changes, and no other path registers the list's names", async ({ request, db }) => {
  const body = LIST(["4. Ghost Player", "5. Another Ghost", "6. Third Ghost"]);
  setMonthlyReaderStub({ fail: [body] });
  const before = await attendance(db);
  const res = await say(request, P.alex, body);
  expect(res.intent).not.toBe("monthly_list");
  expect(await attendance(db)).toEqual(before);
  expect(await db.count(`SELECT COUNT(*) FROM "User" WHERE name LIKE '%Ghost%'`)).toBe(0);
});
