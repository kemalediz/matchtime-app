/**
 * A LATE JOINER'S PARTIAL COMMITMENT, END TO END (2026-11-16). The model
 * is stubbed (`setMonthlyReaderStub`: the reading it would give, keyed by
 * the message), so this proves what MatchTime DOES with a reading, through
 * the real routes and database, for $0.
 *
 * Somebody who joins a month already under way covers only the games
 * LEFT. When the games he commits to do not fit them (more than are left,
 * or a partial phrase whose count comes out at every game left), MatchTime
 * must not store "every game" and react ✅: it asks him once by DM which
 * of the games left he will play, stores nothing until he answers, and
 * then stores what he says.
 *
 *   typed:  "I'm in for <month> except the last week", the count equal to
 *           the games left: asked, then joined for what he answers;
 *   typed:  a count above the games left: asked; an answer that still
 *           does not fit leaves the question open; "all of them" joins;
 *   typed:  a partial count that fits: stored at once, with ✅;
 *   typed:  a full late join: every game left, with ✅;
 *   paste:  his own line on the month's list, "Dan except the last week":
 *           asked which games (never the plain "join for the games left?"),
 *           and joined for what he answers;
 *   Turkish: the same question, in Turkish.
 *
 * The month is NEXT calendar month, started part-way, so every one of its
 * games is still to play whatever today's date is.
 */
import type { APIRequestContext } from "@playwright/test";
import { formatInTimeZone } from "date-fns-tz";
import { tr as trLocale } from "date-fns/locale";
import { test, expect, resetDb } from "../fixtures";
import { clearMonthlyReaderStub, engineOn, setMonthlyReaderStub, stubCalls } from "../helpers/stub";
import { E2E } from "../helpers/env";
import { testDb, type TestDb } from "../helpers/test-db";
import { monthKickoffs, nextMonthStart } from "@/lib/month-signup-rules";
import { londonMonthStart } from "@/lib/squad-month-rules";
import { t } from "@/lib/i18n/t";
import { dayLabel } from "@/lib/i18n/dates";

test.describe.configure({ mode: "serial" });

const LONDON = "Europe/London";
const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const WEEKDAY = 1;
const NEXT = nextMonthStart(londonMonthStart(new Date()));
const KICKOFFS = monthKickoffs(NEXT, WEEKDAY, "20:00");
const LEFT = KICKOFFS.length;
const MONTH_NUMBER = Number(NEXT.slice(5, 7));
const MONTH_NAME = formatInTimeZone(KICKOFFS[0], LONDON, "MMMM");
const MONTH_LABEL = formatInTimeZone(KICKOFFS[0], LONDON, "MMMM yyyy");
const TR_MONTH_NAME = formatInTimeZone(KICKOFFS[0], LONDON, "MMMM", { locale: trLocale });

const EN = { org: "e2e-lj-org", group: "e2e-late-joiner@g.us", act: "e2e-lj-act", month: "e2e-lj-month", match: "e2e-lj-match", lang: "en" } as const;
const TR = { org: "e2e-lj-org-tr", group: "e2e-late-joiner-tr@g.us", act: "e2e-lj-act-tr", month: "e2e-lj-month-tr", match: "e2e-lj-match-tr", lang: "tr" } as const;
type Club = typeof EN | typeof TR;

const P = {
  rob: { id: "e2e-lj-rob", name: "Rob Hale", phone: "+447700940001" },
  alex: { id: "e2e-lj-alex", name: "Alex Carter", phone: "+447700940002" },
  will: { id: "e2e-lj-will", name: "Will Frost", phone: "+447700940003" },
  tom: { id: "e2e-lj-tom", name: "Tom Reed", phone: "+447700940004" },
  bilal: { id: "e2e-lj-bilal", name: "Bilal Aydin", phone: "+447700940005" },
  chris: { id: "e2e-lj-chris", name: "Chris Bell", phone: "+447700940006" },
  dan: { id: "e2e-lj-dan", name: "Dan Price", phone: "+447700940007" },
  ayse: { id: "e2e-lj-ayse", name: "Ayşe Kaya", phone: "+447700940008" },
  emre: { id: "e2e-lj-emre", name: "Emre Can", phone: "+447700940009" },
} as const;
type Person = (typeof P)[keyof typeof P];
const digits = (phone: string) => phone.replace(/^\+/, "");
let seq = 0;

async function say(request: APIRequestContext, club: Club, who: Person, body: string): Promise<{ handledBy: string; intent: string | null; react: string | null }> {
  const waMessageId = `e2e-lj-${Date.now()}-${++seq}`;
  const res = await request.post("/api/whatsapp/analyze", {
    headers: KEY,
    data: { groupId: club.group, messages: [{ waMessageId, body, authorPhone: digits(who.phone), authorName: who.name, timestamp: new Date().toISOString() }] },
  });
  expect(res.status(), await res.text()).toBe(200);
  const json = (await res.json()) as { results?: Array<{ waMessageId: string; handledBy: string; intent: string | null; react: string | null }>; ignored?: string };
  return json.results?.find((r) => r.waMessageId === waMessageId) ?? { handledBy: json.ignored ?? "none", intent: null, react: null };
}

async function dmReply(request: APIRequestContext, who: Person, body: string): Promise<Record<string, unknown>> {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: KEY,
    data: { phone: digits(who.phone), body, waMessageId: `e2e-lj-dm-${Date.now()}-${++seq}`, authorName: who.name },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/** The reader's raw answer for a typed sign-up of the sender's own. */
const signup = (games: number) => ({
  kind: "signup",
  month: 0,
  gameDay: 0,
  listOf: "",
  benchPart: false,
  lines: [],
  residual: "",
  choice: "in",
  signupMonth: MONTH_NUMBER,
  signupFor: "sender",
  signupWho: "",
  signupName: "",
  signupPaid: false,
  signupPaidPence: 0,
  days: [],
  games,
});
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
const monthList = (lines: unknown[]) => ({ ...signup(0), kind: "list", month: MONTH_NUMBER, listOf: "month", choice: "", signupMonth: 0, signupFor: "", lines });

const monthRow = (db: TestDb, club: Club, who: Person) =>
  db.one<{ kind: string; gamesCovered: number; gamesCommitted: number | null; out: boolean }>(
    `SELECT kind, "gamesCovered", "gamesCommitted", ("leftAt" IS NOT NULL) AS out FROM "SquadMonthMember" WHERE "monthId" = $1 AND "userId" = $2`,
    [club.month, who.id],
  );
const dms = (db: TestDb, club: Club, who: Person) =>
  db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2 ORDER BY "createdAt"`, [club.org, digits(who.phone)]);

const whichAsk = (lang: "en" | "tr") =>
  t(lang).msu_dm_join_which({
    month: lang === "en" ? MONTH_NAME : TR_MONTH_NAME,
    games: LEFT,
    dates: KICKOFFS.map((k) => dayLabel(lang, k)),
  });
const plainAsk = (lang: "en" | "tr") => t(lang).msu_dm_join_ask({ month: lang === "en" ? MONTH_NAME : TR_MONTH_NAME, games: LEFT, price: null });

let joined = 0;
/** Members in a fixed order, so the reader's refs are known: p1 is the first added. */
async function person(db: TestDb, club: Club, p: Person, role = "PLAYER") {
  await db.run(`INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [p.id, `${p.id}@e2e.test`, p.name, p.phone]);
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role, "createdAt") VALUES ($1, $2, $3, $4::"MemberRole", $5)`, [
    `mem-${p.id}`,
    p.id,
    club.org,
    role,
    new Date(Date.UTC(2026, 0, 1, 0, 0, ++joined)).toISOString(),
  ]);
}

async function makeClub(db: TestDb, club: Club, name: string) {
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled", "squadMode",
                                 "paygPricePence", "adminChannelMode", language, "updatedAt")
     VALUES ($1, $2, $1, $3, $4, true, 'monthly', 800, 'each-admin', $5, now())`,
    [club.org, name, `${club.org}-invite`, club.group, club.lang],
  );
  await db.run(
    `INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt")
     VALUES ($1, $2, 'Football', 6, ARRAY['GK','DEF','MID','FWD'], ARRAY['Bibs','Shirts'], now())`,
    [`${club.org}-sport`, club.org],
  );
  await db.run(
    `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "updatedAt")
     VALUES ($1, $2, $3, 'Monday 6-a-side', $4, '20:00', $5, 5, now())`,
    [club.act, club.org, `${club.org}-sport`, WEEKDAY, `Goals ${club.lang}`],
  );
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt")
     VALUES ($1, $2, $3, 12, 'UPCOMING', $3, now())`,
    [club.match, club.act, KICKOFFS[0].toISOString()],
  );
  // Started part-way by the organiser: under way, every game still to play.
  await db.run(
    `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "gamesPlayedBeforeStart",
                               "startedMidMonthAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4::date, 'running', $5, 0, now() - interval '1 hour', now() - interval '1 hour', now())`,
    [club.month, club.org, club.act, NEXT, LEFT],
  );
}

async function onMonth(db: TestDb, club: Club, who: Person, slot: number) {
  await db.run(
    `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, "gamesCovered", source, "updatedAt")
     VALUES ($1, $2, $3, 'regular', $4, $5, 'seed-list', now())`,
    [`${club.month}-${who.id}`, club.month, who.id, slot, LEFT],
  );
}

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await makeClub(db, EN, "Vets MNF");
  await person(db, EN, P.rob, "OWNER");
  for (const p of [P.alex, P.will, P.tom, P.bilal, P.chris, P.dan]) await person(db, EN, p);
  await onMonth(db, EN, P.rob, 1);
  await onMonth(db, EN, P.alex, 2);
  await makeClub(db, TR, "Pazartesi Halısaha");
  await person(db, TR, P.emre, "OWNER");
  await person(db, TR, P.ayse);
  await onMonth(db, TR, P.emre, 1);
  engineOn({});
});

test.afterAll(() => {
  clearMonthlyReaderStub();
  resetDb();
});

test("the month has more than one game left (the cases below need it)", () => {
  expect(LEFT).toBeGreaterThanOrEqual(4);
});

test("typed, 'except the last week' counted as every game left: no ✅, nothing stored, asked once which games; joined for what he answers", async ({ request, db }) => {
  const body = `I'm in for ${MONTH_NAME} except the last week`;
  // The reading counted against the month as a whole: the count comes out
  // at every game left, although he said he would miss one.
  setMonthlyReaderStub({ bodies: { [body]: signup(LEFT), "all but the last one": signup(LEFT - 1) } });
  const res = await say(request, EN, P.will, body);
  expect(res).toMatchObject({ handledBy: "fast-path", intent: "month_signup", react: null });
  expect(await monthRow(db, EN, P.will)).toBeNull();
  expect((await dms(db, EN, P.will)).map((d) => d.text)).toEqual([whichAsk("en")]);

  // The reader was given the games left, with their dates, and that he is not on the month yet.
  const turn = stubCalls(E2E.MONTHLY_READER_STUB_FILE).filter((c) => c.user.includes(body)).at(-1)?.user ?? "";
  expect(turn).toContain(`${LEFT} still to play: ${KICKOFFS.map((k) => formatInTimeZone(k, LONDON, "EEE d MMM")).join(", ")}.`);
  expect(turn).toContain(`The sender is not on the ${MONTH_LABEL} list yet.`);

  // Saying it again does not ask twice.
  await say(request, EN, P.will, body);
  expect(await dms(db, EN, P.will)).toHaveLength(1);

  expect(await dmReply(request, P.will, "all but the last one")).toMatchObject({ handled: "month-join-yes" });
  expect(await monthRow(db, EN, P.will)).toEqual({ kind: "regular", gamesCovered: LEFT, gamesCommitted: LEFT - 1, out: false });
});

test("typed, a count above the games left: asked; an answer that still does not fit leaves the question open; 'all of them' joins for every game left", async ({ request, db }) => {
  const body = `In for ${MONTH_NAME}, ${LEFT + 1} games`;
  setMonthlyReaderStub({ bodies: { [body]: signup(LEFT + 1), "hmm the usual": signup(LEFT), "all of them": signup(0) } });
  const res = await say(request, EN, P.tom, body);
  expect(res).toMatchObject({ intent: "month_signup", react: null });
  expect(await monthRow(db, EN, P.tom)).toBeNull();
  expect((await dms(db, EN, P.tom)).map((d) => d.text)).toEqual([whichAsk("en")]);

  expect(await dmReply(request, P.tom, "hmm the usual")).not.toMatchObject({ handled: "month-join-yes" });
  expect(await monthRow(db, EN, P.tom)).toBeNull();

  expect(await dmReply(request, P.tom, "all of them")).toMatchObject({ handled: "month-join-yes" });
  expect(await monthRow(db, EN, P.tom)).toEqual({ kind: "regular", gamesCovered: LEFT, gamesCommitted: null, out: false });
});

test("typed, a partial count that fits the games left: stored at once, with ✅, and no question", async ({ request, db }) => {
  const body = `I'm in for ${MONTH_NAME}, just two games`;
  setMonthlyReaderStub({ bodies: { [body]: signup(2) } });
  const res = await say(request, EN, P.bilal, body);
  expect(res).toMatchObject({ intent: "month_signup", react: "✅" });
  expect(await monthRow(db, EN, P.bilal)).toEqual({ kind: "regular", gamesCovered: LEFT, gamesCommitted: 2, out: false });
  expect((await dms(db, EN, P.bilal)).some((d) => d.text === whichAsk("en"))).toBe(false);
});

test("typed, a full late join: every game left, with ✅", async ({ request, db }) => {
  const body = `IN FOR ${MONTH_NAME.toUpperCase()}`;
  setMonthlyReaderStub({ bodies: { [body]: signup(0) } });
  const res = await say(request, EN, P.chris, body);
  expect(res).toMatchObject({ intent: "month_signup", react: "✅" });
  expect(await monthRow(db, EN, P.chris)).toEqual({ kind: "regular", gamesCovered: LEFT, gamesCommitted: null, out: false });
});

test("paste, his own line 'Dan except the last week' on the month's list: asked which games (not the plain join question), then joined for what he answers", async ({ request, db }) => {
  const body = [`List for ${MONTH_NAME}:`, "1. Rob Hale", "2. Alex Carter", "3. Dan except the last week"].join("\n");
  setMonthlyReaderStub({
    bodies: {
      // p1 Rob, p2 Alex, p7 Dan (the order they were added).
      [body]: monthList([line(1, "Rob Hale", { member: "p1" }), line(2, "Alex Carter", { member: "p2" }), line(3, "Dan", { member: "p7", games: LEFT })]),
      "not the last one": signup(LEFT - 1),
    },
  });
  const res = await say(request, EN, P.dan, body);
  const turn = stubCalls(E2E.MONTHLY_READER_STUB_FILE).filter((c) => c.user.includes(body)).at(-1)?.user ?? "";
  for (const ref of ["p1: Rob Hale", "p2: Alex Carter", "p7: Dan Price"]) expect(turn).toContain(ref);
  expect(res).toMatchObject({ handledBy: "fast-path", intent: "month_signup_list", react: null });
  expect(await monthRow(db, EN, P.dan)).toBeNull();
  const texts = (await dms(db, EN, P.dan)).map((d) => d.text);
  expect(texts).toEqual([whichAsk("en")]);
  expect(texts).not.toContain(plainAsk("en"));

  expect(await dmReply(request, P.dan, "not the last one")).toMatchObject({ handled: "month-join-yes" });
  expect(await monthRow(db, EN, P.dan)).toEqual({ kind: "regular", gamesCovered: LEFT, gamesCommitted: LEFT - 1, out: false });
});

test("Turkish: 'son hafta hariç' that does not fit is asked in Turkish, and nothing is stored", async ({ request, db }) => {
  const body = `${TR_MONTH_NAME} varım son hafta hariç`;
  setMonthlyReaderStub({ bodies: { [body]: signup(LEFT) } });
  const res = await say(request, TR, P.ayse, body);
  expect(res).toMatchObject({ intent: "month_signup", react: null });
  expect(await monthRow(db, TR, P.ayse)).toBeNull();
  expect((await dms(db, TR, P.ayse)).map((d) => d.text)).toEqual([whichAsk("tr")]);
});
