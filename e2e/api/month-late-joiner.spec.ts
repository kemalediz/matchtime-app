/**
 * A PLAYER'S GAMES COUNT, END TO END (2026-11-16). The model is stubbed
 * (`setMonthlyReaderStub`: the reading it would give, keyed by the
 * message), so this proves what MatchTime DOES with a reading, through the
 * real routes and database, for $0.
 *
 * THE RULE: a count is checked against THE GAMES HE COVERS. A regular's
 * row's games; anybody joining or becoming a regular now (a newcomer, a
 * pay-as-you-go or bench player, somebody coming back) the games still to
 * play. A partial count that does not fit (at or above what he covers) is
 * never stored and never gets a ✅: he is asked which of the games he
 * covers he will play, and his answer is stored.
 *
 * The main club is the reviewers' setup: a PRICED month (£7.50 a game)
 * with 3 games left. It is NEXT calendar month, started part-way, with its
 * other weeks cancelled, so exactly 3 games are left whatever today's date.
 * Two more clubs run THIS month, on the real clock: one with a game already
 * played (games left fewer than the month's), one with none left.
 */
import type { APIRequestContext } from "@playwright/test";
import { formatInTimeZone } from "date-fns-tz";
import { tr as trLocale } from "date-fns/locale";
import { test, expect, resetDb } from "../fixtures";
import { clearMonthlyReaderStub, engineOn, setMonthlyReaderStub, stubCalls } from "../helpers/stub";
import { E2E } from "../helpers/env";
import { testDb, type TestDb } from "../helpers/test-db";
import { monthKickoffs, nextMonthStart, WAITING_NOTE } from "@/lib/month-signup-rules";
import { londonMonthStart } from "@/lib/squad-month-rules";
import { t } from "@/lib/i18n/t";
import { dayLabel } from "@/lib/i18n/dates";

test.describe.configure({ mode: "serial" });

const LONDON = "Europe/London";
const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const SHARE = 750;
const CUR = londonMonthStart(new Date());
const NEXT = nextMonthStart(CUR);

interface Club {
  org: string;
  group: string;
  act: string;
  month: string;
  lang: "en" | "tr";
  monthStart: string;
  weekday: number;
  time: string;
  /** The month's games: its calendar minus the weeks cancelled. */
  games: Date[];
  cancelled: Date[];
  priced: boolean;
}

/** A club on a month's calendar for one weekday, keeping `keep` of its weeks. */
function club(id: string, lang: "en" | "tr", monthStart: string, weekday: number, time: string, keep: (all: Date[]) => Date[], priced: boolean): Club {
  const all = monthKickoffs(monthStart, weekday, time);
  const games = keep(all);
  return {
    org: `e2e-lj-${id}`,
    group: `e2e-lj-${id}@g.us`,
    act: `e2e-lj-${id}-act`,
    month: `e2e-lj-${id}-month`,
    lang,
    monthStart,
    weekday,
    time,
    games,
    cancelled: all.filter((k) => !games.includes(k)),
    priced,
  };
}

// The reviewers' club: priced, 3 games left (next month, its other weeks cancelled).
const EN = club("en", "en", NEXT, 1, "20:00", (all) => all.slice(-3), true);
const TR = club("tr", "tr", NEXT, 1, "20:00", (all) => all.slice(-3), true);
// One game left.
const ONE = club("one", "en", NEXT, 1, "20:00", (all) => all.slice(-1), true);
// THIS month, a game already played: the weekday whose games leave the most
// still to play after at least one played (00:00, so today's counts as played).
const PLAYED = (() => {
  let best: Club | null = null;
  for (let wd = 0; wd < 7; wd++) {
    const c = club("played", "en", CUR, wd, "00:00", (all) => all, true);
    const left = c.games.filter((k) => k.getTime() > Date.now()).length;
    const played = c.games.length - left;
    if (played >= 1 && (!best || left > best.games.filter((k) => k.getTime() > Date.now()).length)) best = c;
  }
  return best;
})();
// THIS month, no game left: its future weeks cancelled.
const NONE_LEFT = (() => {
  for (let wd = 0; wd < 7; wd++) {
    const c = club("none", "en", CUR, wd, "00:00", (all) => all.filter((k) => k.getTime() < Date.now()), true);
    if (c.games.length > 0) return c;
  }
  return null;
})();

const leftOf = (c: Club) => c.games.filter((k) => k.getTime() > Date.now());
const monthName = (c: Club) => formatInTimeZone(c.games[0], LONDON, "MMMM", c.lang === "tr" ? { locale: trLocale } : undefined);
const monthLabel = (c: Club) => formatInTimeZone(c.games[0], LONDON, "MMMM yyyy");
const monthNumber = (c: Club) => Number(c.monthStart.slice(5, 7));
const LEFT = leftOf(EN).length;

const P = {
  rob: { id: "e2e-lj-rob", name: "Rob Hale", phone: "+447700940001" },
  alex: { id: "e2e-lj-alex", name: "Alex Carter", phone: "+447700940002" },
  will: { id: "e2e-lj-will", name: "Will Frost", phone: "+447700940003" },
  tom: { id: "e2e-lj-tom", name: "Tom Reed", phone: "+447700940004" },
  bilal: { id: "e2e-lj-bilal", name: "Bilal Aydin", phone: "+447700940005" },
  chris: { id: "e2e-lj-chris", name: "Chris Bell", phone: "+447700940006" },
  dan: { id: "e2e-lj-dan", name: "Dan Price", phone: "+447700940007" },
  pat: { id: "e2e-lj-pat", name: "Pat Payg", phone: "+447700940010" },
  bea: { id: "e2e-lj-bea", name: "Bea Bench", phone: "+447700940011" },
  olly: { id: "e2e-lj-olly", name: "Olly Out", phone: "+447700940012" },
  lee: { id: "e2e-lj-lee", name: "Lee Late", phone: "+447700940013" },
  kim: { id: "e2e-lj-kim", name: "Kim Later", phone: "+447700940014" },
  mo: { id: "e2e-lj-mo", name: "Mo Many", phone: "+447700940015" },
  emre: { id: "e2e-lj-emre", name: "Emre Can", phone: "+447700940008" },
  ayse: { id: "e2e-lj-ayse", name: "Ayşe Kaya", phone: "+447700940009" },
  sam: { id: "e2e-lj-sam", name: "Sam Single", phone: "+447700940020" },
  ivy: { id: "e2e-lj-ivy", name: "Ivy Played", phone: "+447700940021" },
  zoe: { id: "e2e-lj-zoe", name: "Zoe Zero", phone: "+447700940022" },
  own1: { id: "e2e-lj-own1", name: "Owner One", phone: "+447700940030" },
  own2: { id: "e2e-lj-own2", name: "Owner Two", phone: "+447700940031" },
  own3: { id: "e2e-lj-own3", name: "Owner Three", phone: "+447700940032" },
} as const;
type Person = (typeof P)[keyof typeof P];
const digits = (phone: string) => phone.replace(/^\+/, "");
let seq = 0;

async function say(request: APIRequestContext, c: Club, who: Person, body: string): Promise<{ handledBy: string; intent: string | null; react: string | null }> {
  const waMessageId = `e2e-lj-${Date.now()}-${++seq}`;
  const res = await request.post("/api/whatsapp/analyze", {
    headers: KEY,
    data: { groupId: c.group, messages: [{ waMessageId, body, authorPhone: digits(who.phone), authorName: who.name, timestamp: new Date().toISOString() }] },
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
const signup = (c: Club, games: number) => ({
  kind: "signup",
  month: 0,
  gameDay: 0,
  listOf: "",
  benchPart: false,
  lines: [],
  residual: "",
  choice: "in",
  signupMonth: monthNumber(c),
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
const monthList = (c: Club, lines: unknown[]) => ({ ...signup(c, 0), kind: "list", month: monthNumber(c), listOf: "month", choice: "", signupMonth: 0, signupFor: "", lines });

interface Row {
  kind: string;
  gamesCovered: number;
  gamesCommitted: number | null;
  amountDuePence: number | null;
  out: boolean;
  waiting: boolean;
}
const monthRow = (db: TestDb, c: Club, who: Person) =>
  db.one<Row>(
    `SELECT kind, "gamesCovered", "gamesCommitted", "amountDuePence", ("leftAt" IS NOT NULL) AS out, (note IS NOT DISTINCT FROM $3) AS waiting
       FROM "SquadMonthMember" WHERE "monthId" = $1 AND "userId" = $2`,
    [c.month, who.id, WAITING_NOTE],
  );
const dms = async (db: TestDb, c: Club, who: Person) =>
  (await db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2 ORDER BY "createdAt"`, [c.org, digits(who.phone)])).map((d) => d.text);
const readerTurn = (body: string) => stubCalls(E2E.MONTHLY_READER_STUB_FILE).filter((x) => x.user.includes(body)).at(-1)?.user ?? "";

/** The "which of them will you play?" question, for a joiner (the games left) or a regular on the month (his games). */
const whichAsk = (c: Club, dates: Date[], regular = false) =>
  t(c.lang)[regular ? "msu_dm_games_which" : "msu_dm_join_which"]({ month: monthName(c), games: dates.length, dates: dates.map((k) => dayLabel(c.lang, k)) });
const plainAsk = (c: Club, games: number) =>
  t(c.lang).msu_dm_join_ask({ month: monthName(c), games, price: c.priced ? `£${((SHARE * games) / 100).toFixed(2)}` : null });

let joined = 0;
/** Members in a fixed order, so the reader's refs are known: p1 is the first added. */
async function person(db: TestDb, c: Club, p: Person, role = "PLAYER") {
  await db.run(`INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ($1, $2, $3, $4, now()) ON CONFLICT (id) DO NOTHING`, [
    p.id,
    `${p.id}@e2e.test`,
    p.name,
    p.phone,
  ]);
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role, "createdAt") VALUES ($1, $2, $3, $4::"MemberRole", $5)`, [
    `mem-${c.org}-${p.id}`,
    p.id,
    c.org,
    role,
    new Date(Date.UTC(2026, 0, 1, 0, 0, ++joined)).toISOString(),
  ]);
}

async function makeClub(db: TestDb, c: Club, name: string) {
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled", "squadMode",
                                 "paygPricePence", "adminChannelMode", language, "paymentTrackingEnabled", "updatedAt")
     VALUES ($1, $2, $1, $3, $4, true, 'monthly', 800, 'each-admin', $5, true, now())`,
    [c.org, name, `${c.org}-invite`, c.group, c.lang],
  );
  await db.run(
    `INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt")
     VALUES ($1, $2, 'Football', 6, ARRAY['GK','DEF','MID','FWD'], ARRAY['Bibs','Shirts'], now())`,
    [`${c.org}-sport`, c.org],
  );
  await db.run(
    `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "updatedAt")
     VALUES ($1, $2, $3, 'Weekly 6-a-side', $4, $5, $6, 5, now())`,
    [c.act, c.org, `${c.org}-sport`, c.weekday, c.time, `Goals ${c.org}`],
  );
  for (const [i, k] of c.cancelled.entries()) {
    await db.run(
      `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt") VALUES ($1, $2, $3, 12, 'CANCELLED', $3, now())`,
      [`${c.org}-cancelled-${i}`, c.act, k.toISOString()],
    );
  }
  const next = leftOf(c)[0];
  if (next) {
    await db.run(
      `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt") VALUES ($1, $2, $3, 12, 'UPCOMING', $3, now())`,
      [`${c.org}-match`, c.act, next.toISOString()],
    );
  }
  // Started part-way by the organiser: under way.
  await db.run(
    `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "gamesPlayedBeforeStart",
                               "startedMidMonthAt", "sharePerGamePence", "pricedAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4::date, 'running', $5, 0, now() - interval '1 hour', $6, $7, now() - interval '1 hour', now())`,
    [c.month, c.org, c.act, c.monthStart, c.games.length, c.priced ? SHARE : null, c.priced ? new Date().toISOString() : null],
  );
}

async function onMonth(db: TestDb, c: Club, who: Person, o: { kind?: "regular" | "payg"; slot?: number | null; covered?: number; out?: boolean; waiting?: boolean } = {}) {
  const kind = o.kind ?? "regular";
  const covered = o.covered ?? (kind === "regular" ? c.games.length : 0);
  await db.run(
    `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, "gamesCovered", "amountDuePence", note, source, "leftAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'seed-list', $9, now())`,
    [
      `${c.month}-${who.id}`,
      c.month,
      who.id,
      kind,
      o.slot ?? null,
      covered,
      kind === "regular" && c.priced && !o.out ? covered * SHARE : null,
      o.waiting ? WAITING_NOTE : null,
      o.out ? new Date().toISOString() : null,
    ],
  );
}

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await makeClub(db, EN, "Vets MNF");
  await person(db, EN, P.rob, "OWNER");
  for (const p of [P.alex, P.will, P.tom, P.bilal, P.chris, P.dan, P.pat, P.bea, P.olly, P.lee, P.kim, P.mo]) await person(db, EN, p);
  await onMonth(db, EN, P.rob, { slot: 1 });
  await onMonth(db, EN, P.alex, { slot: 2 });
  await onMonth(db, EN, P.pat, { kind: "payg" });
  await onMonth(db, EN, P.bea, { kind: "payg", waiting: true });
  await onMonth(db, EN, P.olly, { slot: 3, out: true });
  await onMonth(db, EN, P.lee, { slot: 4, covered: LEFT });

  await makeClub(db, TR, "Pazartesi Halısaha");
  await person(db, TR, P.emre, "OWNER");
  await person(db, TR, P.ayse);
  await onMonth(db, TR, P.emre, { slot: 1 });

  await makeClub(db, ONE, "One Left FC");
  await person(db, ONE, P.own1, "OWNER");
  await person(db, ONE, P.sam);

  if (PLAYED) {
    await makeClub(db, PLAYED, "Played FC");
    await person(db, PLAYED, P.own2, "OWNER");
    await person(db, PLAYED, P.ivy);
  }
  if (NONE_LEFT) {
    await makeClub(db, NONE_LEFT, "None Left FC");
    await person(db, NONE_LEFT, P.own3, "OWNER");
    await person(db, NONE_LEFT, P.zoe);
  }
  engineOn({});
});

test.afterAll(() => {
  clearMonthlyReaderStub();
  resetDb();
});

test("the reviewers' month: priced at £7.50 a game, 3 games left", () => {
  expect(LEFT).toBe(3);
});

test("typed, 'except the last week' read as every game he covers: no ✅, nothing stored, asked once which games; 'yes' keeps what he said", async ({ request, db }) => {
  const body = `I'm in for ${monthName(EN)} except the last week`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 3), yes: signup(EN, 2) } });
  const res = await say(request, EN, P.will, body);
  expect(res).toMatchObject({ handledBy: "fast-path", intent: "month_signup", react: null });
  expect(await monthRow(db, EN, P.will)).toBeNull();
  expect(await dms(db, EN, P.will)).toEqual([whichAsk(EN, EN.games)]);

  // The reader was told what he covers: the 3 games still to play, with their dates.
  const turn = readerTurn(body);
  expect(turn).toContain(`3 still to play: ${EN.games.map((k) => formatInTimeZone(k, LONDON, "EEE d MMM")).join(", ")}.`);
  expect(turn).toContain(`THE SENDER COVERS in ${monthLabel(EN)}: 3 games, `);
  expect(turn).toContain("(not a regular on its list yet: joining now, the games still to play)");

  // Saying it again while the question is open asks nothing more.
  await say(request, EN, P.will, body);
  expect(await dms(db, EN, P.will)).toHaveLength(1);

  // His answer is read with what he said before it.
  expect(await dmReply(request, P.will, "yes")).toMatchObject({ handled: "month-join-yes" });
  expect(readerTurn("yes")).toContain(`RECENT CHAT (context only):\n  ${P.will.name}: ${body}`);
  expect(await monthRow(db, EN, P.will)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: 2, amountDuePence: 1500 });
});

test("typed, a count above what he covers: asked; an answer that still does not fit leaves the question open; 'all of them' joins for every game", async ({ request, db }) => {
  const body = `In for ${monthName(EN)}, 4 games`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 4), "hmm the usual": signup(EN, 3), "all of them": signup(EN, 0) } });
  expect(await say(request, EN, P.tom, body)).toMatchObject({ intent: "month_signup", react: null });
  expect(await monthRow(db, EN, P.tom)).toBeNull();
  expect(await dms(db, EN, P.tom)).toEqual([whichAsk(EN, EN.games)]);

  expect(await dmReply(request, P.tom, "hmm the usual")).not.toMatchObject({ handled: "month-join-yes" });
  expect(await monthRow(db, EN, P.tom)).toBeNull();

  expect(await dmReply(request, P.tom, "all of them")).toMatchObject({ handled: "month-join-yes" });
  expect(await monthRow(db, EN, P.tom)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: null, amountDuePence: 2250 });
});

test("typed, a partial count that fits: stored at once, with ✅, and no question", async ({ request, db }) => {
  const body = `I'm in for ${monthName(EN)}, just two games`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 2) } });
  expect(await say(request, EN, P.bilal, body)).toMatchObject({ intent: "month_signup", react: "✅" });
  expect(await monthRow(db, EN, P.bilal)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: 2, amountDuePence: 1500 });
  expect((await dms(db, EN, P.bilal)).some((d) => d.startsWith("📋 ") && d.includes("Which of them"))).toBe(false);
});

test("typed, a full late join: every game left, with ✅", async ({ request, db }) => {
  const body = `IN FOR ${monthName(EN).toUpperCase()}`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 0) } });
  expect(await say(request, EN, P.chris, body)).toMatchObject({ intent: "month_signup", react: "✅" });
  expect(await monthRow(db, EN, P.chris)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: null, amountDuePence: 2250 });
});

test("hole 1: a PAYG player becoming a regular covers the games left: 'except the last week' read as 2 is stored, with ✅", async ({ request, db }) => {
  const body = `I'm in for ${monthName(EN)} except the last week`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 2) } });
  expect(await say(request, EN, P.pat, body)).toMatchObject({ intent: "month_signup", react: "✅" });
  // He was told he covers the games left (not that he is on the list already).
  expect(readerTurn(body)).toContain(`THE SENDER COVERS in ${monthLabel(EN)}: 3 games, `);
  expect(await monthRow(db, EN, P.pat)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: 2, amountDuePence: 1500 });
});

test("hole 1: a bench player becoming a regular, 'except the last week' read as every game left: asked, nothing stored, no ✅", async ({ request, db }) => {
  const body = `In for ${monthName(EN)} except the last week please`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 3) } });
  expect(await say(request, EN, P.bea, body)).toMatchObject({ intent: "month_signup", react: null });
  expect(await monthRow(db, EN, P.bea)).toMatchObject({ kind: "payg", waiting: true, gamesCommitted: null });
  expect(await dms(db, EN, P.bea)).toEqual([whichAsk(EN, EN.games)]);
});

test("hole 2 and 4: 'yes except the last week' to the plain join question, read as every game: not stored as all, asked which games (its own question); then joined for what he says", async ({ request, db }) => {
  const body = `IN FOR ${monthName(EN).toUpperCase()} again`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 0), "yes except the last week": signup(EN, 3), "yes that's right": signup(EN, 2) } });
  // He was on the month and left: asked to confirm first.
  await say(request, EN, P.olly, body);
  expect(await dms(db, EN, P.olly)).toEqual([plainAsk(EN, 3)]);

  expect(await dmReply(request, P.olly, "yes except the last week")).toMatchObject({ handled: "month-join-asked" });
  expect(await monthRow(db, EN, P.olly)).toMatchObject({ out: true });
  expect(await dms(db, EN, P.olly)).toEqual([plainAsk(EN, 3), whichAsk(EN, EN.games)]);
  // His answer to the plain question is what the reader reads the next one with.
  expect(await dmReply(request, P.olly, "yes that's right")).toMatchObject({ handled: "month-join-yes" });
  expect(readerTurn("yes that's right")).toContain(`${P.olly.name}: yes except the last week`);
  expect(await monthRow(db, EN, P.olly)).toMatchObject({ kind: "regular", out: false, gamesCovered: 3, gamesCommitted: 2, amountDuePence: 1500 });
});

test("hole 3: a late joiner already on the list changing his games, read against the month (4 of his 3): no ✅, not stored, asked about HIS games; his answer is stored", async ({ request, db }) => {
  const body = `Actually I'm in for ${monthName(EN)} except the last week`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 4), "yes, first two": signup(EN, 2) } });
  expect(await say(request, EN, P.lee, body)).toMatchObject({ intent: "month_signup", react: null });
  expect(readerTurn(body)).toContain(`THE SENDER COVERS in ${monthLabel(EN)}: 3 games, `);
  expect(readerTurn(body)).toContain("(a regular on its list)");
  expect(await monthRow(db, EN, P.lee)).toMatchObject({ kind: "regular", gamesCommitted: null, amountDuePence: 2250 });
  expect(await dms(db, EN, P.lee)).toEqual([whichAsk(EN, EN.games, true)]);

  expect(await dmReply(request, P.lee, "yes, first two")).toMatchObject({ handled: "month-join-yes" });
  expect(await monthRow(db, EN, P.lee)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: 2, amountDuePence: 1500 });
});

test("paste, his own line 'Dan except the last week' on the month's list: asked which games; 'yes' keeps the line's count", async ({ request, db }) => {
  const body = [`List for ${monthName(EN)}:`, "1. Rob Hale", "2. Alex Carter", "3. Dan except the last week"].join("\n");
  setMonthlyReaderStub({
    bodies: {
      // p1 Rob, p2 Alex, p7 Dan (the order they were added).
      [body]: monthList(EN, [line(1, "Rob Hale", { member: "p1" }), line(2, "Alex Carter", { member: "p2" }), line(3, "Dan", { member: "p7", games: 4 })]),
      "yep": signup(EN, 2),
    },
  });
  const res = await say(request, EN, P.dan, body);
  for (const ref of ["p1: Rob Hale", "p2: Alex Carter", "p7: Dan Price"]) expect(readerTurn(body)).toContain(ref);
  expect(res).toMatchObject({ handledBy: "fast-path", intent: "month_signup_list", react: null });
  expect(await monthRow(db, EN, P.dan)).toBeNull();
  expect(await dms(db, EN, P.dan)).toEqual([whichAsk(EN, EN.games)]);

  expect(await dmReply(request, P.dan, "yep")).toMatchObject({ handled: "month-join-yes" });
  // His pasted list is what his answer is read with.
  expect(readerTurn("yep")).toContain("3. Dan except the last week");
  expect(await monthRow(db, EN, P.dan)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: 2, amountDuePence: 1500 });
});

test("hole 6: a listed game played before he answers: the answer is read against the dates the question listed, and the played one counts towards it", async ({ request, db }) => {
  const body = `Kim here, in for ${monthName(EN)} except the last week`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 3), "all but the last one": signup(EN, 2) } });
  expect(await say(request, EN, P.kim, body)).toMatchObject({ react: null });
  // As if asked a game earlier: the question listed one game now played and the next two.
  const played = new Date(Date.now() - 24 * 3600_000);
  const listed = [played, EN.games[0], EN.games[1]];
  const ask = await db.one<{ id: string; text: string }>(`SELECT id, text FROM "SentNotification" WHERE kind = 'month-join-which' AND "targetUser" = $1`, [P.kim.id]);
  const state = JSON.parse(ask!.text);
  const dm = whichAsk(EN, listed);
  await db.run(`UPDATE "SentNotification" SET text = $2 WHERE id = $1`, [ask!.id, JSON.stringify({ ...state, dm, dates: listed.map((d) => d.toISOString()) })]);
  await db.run(`UPDATE "BotJob" SET text = $2 WHERE "orgId" = $1 AND phone = $3 AND kind = 'dm'`, [EN.org, dm, digits(P.kim.phone)]);

  expect(await dmReply(request, P.kim, "all but the last one")).toMatchObject({ handled: "month-join-yes" });
  expect(readerTurn("all but the last one")).toContain(
    `THE SENDER COVERS in ${monthLabel(EN)}: 3 games, ${listed.map((d) => `${formatInTimeZone(d, LONDON, "EEE d MMM")}${d.getTime() < Date.now() ? " (played)" : ""}`).join(", ")} (as MatchTime's question to him listed them; count his answer against these).`,
  );
  // 2 of the 3 listed, the first already played: 1 more game, of the 3 he now covers.
  expect(await monthRow(db, EN, P.kim)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: 1, amountDuePence: 750 });
});

test("hole 4: the question is asked again after an earlier one expired, at most 3 times a month; after that the message goes on as before", async ({ request, db }) => {
  const body = `In for ${monthName(EN)} bar the last`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 3) } });
  const expire = () => db.run(`UPDATE "SentNotification" SET "createdAt" = now() - interval '3 days' WHERE kind = 'month-join-which' AND "targetUser" = $1`, [P.mo.id]);
  for (let i = 1; i <= 3; i++) {
    expect(await say(request, EN, P.mo, body)).toMatchObject({ intent: "month_signup", react: null });
    expect(await dms(db, EN, P.mo)).toHaveLength(i);
    await expire();
  }
  const fourth = await say(request, EN, P.mo, body);
  expect(fourth.intent).not.toBe("month_signup");
  expect(await dms(db, EN, P.mo)).toHaveLength(3);
  expect(await monthRow(db, EN, P.mo)).toBeNull();
});

test("hole 5: one game left, a count of 1 is that one game: every game, with ✅, never a question", async ({ request, db }) => {
  const body = `In for ${monthName(ONE)}, just the one game`;
  setMonthlyReaderStub({ bodies: { [body]: signup(ONE, 1) } });
  expect(await say(request, ONE, P.sam, body)).toMatchObject({ intent: "month_signup", react: "✅" });
  expect(await monthRow(db, ONE, P.sam)).toMatchObject({ kind: "regular", gamesCovered: 1, gamesCommitted: null, amountDuePence: 750 });
  expect(await dms(db, ONE, P.sam)).not.toContain(whichAsk(ONE, ONE.games));
});

test("hole 9: a game already played (games left fewer than the month's): his count is against the games left, and the reader sees the played one", async ({ request, db }) => {
  test.skip(!PLAYED || leftOf(PLAYED).length < 2, "needs a month this calendar month with a game played and two still to play");
  const c = PLAYED!;
  const left = leftOf(c).length;
  expect(left).toBeLessThan(c.games.length);
  const body = `I'm in for ${monthName(c)} except the last week`;
  setMonthlyReaderStub({ bodies: { [body]: signup(c, left - 1) } });
  expect(await say(request, c, P.ivy, body)).toMatchObject({ intent: "month_signup", react: "✅" });
  const turn = readerTurn(body);
  expect(turn).toContain(`${formatInTimeZone(c.games[0], LONDON, "EEE d MMM")} (played)`);
  expect(turn).toContain(`THE SENDER COVERS in ${monthLabel(c)}: ${left} games, `);
  expect(await monthRow(db, c, P.ivy)).toMatchObject({ kind: "regular", gamesCovered: left, gamesCommitted: left - 1, amountDuePence: (left - 1) * SHARE });
  // The same count against the month's games would have been every game left.
  setMonthlyReaderStub({ bodies: {} });
});

test("hole 8: no game left: a typed count is not swallowed as asked; it goes on as before, with no question and nothing stored", async ({ request, db }) => {
  test.skip(!NONE_LEFT, "needs a game already played this calendar month");
  const c = NONE_LEFT!;
  const body = `I'm in for ${monthName(c)} except the last week`;
  setMonthlyReaderStub({ bodies: { [body]: signup(c, 2) } });
  const res = await say(request, c, P.zoe, body);
  expect(res.intent).not.toBe("month_signup");
  expect(await dms(db, c, P.zoe)).toEqual([]);
  expect(await monthRow(db, c, P.zoe)).toBeNull();
});

test("Turkish: 'son hafta hariç' that does not fit is asked in Turkish, and nothing is stored", async ({ request, db }) => {
  const body = `${monthName(TR)} varım son hafta hariç`;
  setMonthlyReaderStub({ bodies: { [body]: signup(TR, 3) } });
  expect(await say(request, TR, P.ayse, body)).toMatchObject({ intent: "month_signup", react: null });
  expect(await monthRow(db, TR, P.ayse)).toBeNull();
  expect(await dms(db, TR, P.ayse)).toEqual([whichAsk(TR, TR.games)]);
});
