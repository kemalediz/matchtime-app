/**
 * A PLAYER'S GAMES COUNT, END TO END (2026-11-16). The model is stubbed
 * (`setMonthlyReaderStub`: the reading it would give, keyed by the
 * message), so this proves what MatchTime DOES with a reading, through the
 * real routes and database, for $0.
 *
 * THE RULE: a count is checked against THE GAMES HE COVERS. A regular's
 * row's games (a leaver who paid keeps his); anybody joining or becoming a
 * regular now (a newcomer, a pay-as-you-go or bench player) the games still
 * to play. A regular's count is never below the games he has played. A
 * count that does not fit is never stored and never gets a ✅: the player
 * whose games they are is asked which of them he will play, and his answer
 * is stored. When nobody can be asked, the message is consumed and the
 * organisers are told once, in the admin channel.
 *
 * The main club is the reviewers' setup: a PRICED month (£7.50 a game)
 * with 3 games left. It is NEXT calendar month, started part-way, with its
 * other weeks cancelled, so exactly 3 games are left whatever today's date.
 * Others: Turkish; one game left; a month still in sign-up; a full month
 * (two places); and two clubs on THIS month, on the real clock: one with
 * games already played, one with none left.
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
  /** "running" (started part-way) or "open" (in sign-up). */
  status: "running" | "open";
  perTeam: number;
}

function club(
  id: string,
  o: { lang?: "en" | "tr"; monthStart: string; weekday?: number; time?: string; keep?: (all: Date[]) => Date[]; status?: "running" | "open"; perTeam?: number },
): Club {
  const all = monthKickoffs(o.monthStart, o.weekday ?? 1, o.time ?? "20:00");
  const games = (o.keep ?? ((x) => x))(all);
  return {
    org: `e2e-lj-${id}`,
    group: `e2e-lj-${id}@g.us`,
    act: `e2e-lj-${id}-act`,
    month: `e2e-lj-${id}-month`,
    lang: o.lang ?? "en",
    monthStart: o.monthStart,
    weekday: o.weekday ?? 1,
    time: o.time ?? "20:00",
    games,
    cancelled: all.filter((k) => !games.includes(k)),
    priced: true,
    status: o.status ?? "running",
    perTeam: o.perTeam ?? 6,
  };
}

// The reviewers' club: priced, 3 games left (next month, its other weeks cancelled).
// Room for everybody below (20 regular places).
const EN = club("en", { monthStart: NEXT, keep: (all) => all.slice(-3), perTeam: 10 });
const TR = club("tr", { lang: "tr", monthStart: NEXT, keep: (all) => all.slice(-3) });
const ONE = club("one", { monthStart: NEXT, keep: (all) => all.slice(-1) });
// Next month, still in sign-up: every game to play.
const SU = club("su", { monthStart: NEXT, status: "open" });
// Two regular places only, both taken; 3 games left.
const FULL = club("full", { monthStart: NEXT, keep: (all) => all.slice(-3), perTeam: 1 });
// THIS month, games already played: the weekday whose games leave the most
// still to play after at least two played (00:00, so today's counts as played).
const PLAYED = (() => {
  let best: Club | null = null;
  for (let wd = 0; wd < 7; wd++) {
    const c = club("played", { monthStart: CUR, weekday: wd, time: "00:00" });
    const left = c.games.filter((k) => k.getTime() > Date.now()).length;
    if (c.games.length - left >= 2 && (!best || left > best.games.filter((k) => k.getTime() > Date.now()).length)) best = c;
  }
  return best;
})();
// THIS month, no game left: its future weeks cancelled.
const NONE_LEFT = (() => {
  for (let wd = 0; wd < 7; wd++) {
    const c = club("none", { monthStart: CUR, weekday: wd, time: "00:00", keep: (all) => all.filter((k) => k.getTime() < Date.now()) });
    if (c.games.length > 0) return c;
  }
  return null;
})();

const leftOf = (c: Club) => c.games.filter((k) => k.getTime() > Date.now());
const pastOf = (c: Club) => c.games.filter((k) => k.getTime() <= Date.now());
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
  kit: { id: "e2e-lj-kit", name: "Kit Later", phone: "+447700940016" },
  seq: { id: "e2e-lj-seq", name: "Sid Sequence", phone: "+447700940017" },
  zak: { id: "e2e-lj-zak", name: "Zak Added", phone: "+447700940018" },
  pam: { id: "e2e-lj-pam", name: "Pam Paid", phone: "+447700940019" },
  pia: { id: "e2e-lj-pia", name: "Pia Confirmed", phone: "+447700940033" },
  emre: { id: "e2e-lj-emre", name: "Emre Can", phone: "+447700940008" },
  ayse: { id: "e2e-lj-ayse", name: "Ayşe Kaya", phone: "+447700940009" },
  sam: { id: "e2e-lj-sam", name: "Sam Single", phone: "+447700940020" },
  ivy: { id: "e2e-lj-ivy", name: "Ivy Played", phone: "+447700940021" },
  rex: { id: "e2e-lj-rex", name: "Rex Regular", phone: "+447700940023" },
  zoe: { id: "e2e-lj-zoe", name: "Zoe Zero", phone: "+447700940022" },
  sue: { id: "e2e-lj-sue", name: "Sue Owner", phone: "+447700940024" },
  lea: { id: "e2e-lj-lea", name: "Lea Two", phone: "+447700940025" },
  nia: { id: "e2e-lj-nia", name: "Nia New", phone: "+447700940026" },
  fay: { id: "e2e-lj-fay", name: "Fay First", phone: "+447700940027" },
  fin: { id: "e2e-lj-fin", name: "Fin Second", phone: "+447700940028" },
  ben: { id: "e2e-lj-ben", name: "Ben Bench", phone: "+447700940029" },
  own1: { id: "e2e-lj-own1", name: "Owner One", phone: "+447700940030" },
  own2: { id: "e2e-lj-own2", name: "Owner Two", phone: "+447700940031" },
  own3: { id: "e2e-lj-own3", name: "Owner Three", phone: "+447700940032" },
} as const;
type Person = (typeof P)[keyof typeof P];
const digits = (phone: string) => phone.replace(/^\+/, "");
let seq = 0;

/** The EN club's members in the order they are added: p1 is the first. */
const EN_ORDER: Person[] = [P.rob, P.alex, P.will, P.tom, P.bilal, P.chris, P.dan, P.pat, P.bea, P.olly, P.lee, P.kim, P.mo, P.kit, P.seq, P.zak, P.pam, P.pia];
const refOf = (who: Person) => `p${EN_ORDER.indexOf(who) + 1}`;

async function say(
  request: APIRequestContext,
  c: Club,
  who: Person,
  body: string,
  extra: Record<string, unknown> = {},
): Promise<{ handledBy: string; intent: string | null; react: string | null }> {
  const waMessageId = `e2e-lj-${Date.now()}-${++seq}`;
  const res = await request.post("/api/whatsapp/analyze", {
    headers: KEY,
    data: { groupId: c.group, messages: [{ waMessageId, body, authorPhone: digits(who.phone), authorName: who.name, timestamp: new Date().toISOString(), ...extra }] },
  });
  expect(res.status(), await res.text()).toBe(200);
  const json = (await res.json()) as { results?: Array<{ waMessageId: string; handledBy: string; intent: string | null; react: string | null }>; ignored?: string };
  return json.results?.find((r) => r.waMessageId === waMessageId) ?? { handledBy: json.ignored ?? "none", intent: null, react: null };
}

async function dmReply(request: APIRequestContext, who: Person, body: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: KEY,
    data: { phone: digits(who.phone), body, waMessageId: `e2e-lj-dm-${Date.now()}-${++seq}`, authorName: who.name, ...extra },
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

/** "Which of them will you play?" to a joiner: the games left. */
const whichAsk = (c: Club, dates: Date[]) =>
  t(c.lang).msu_dm_join_which({ month: monthName(c), games: dates.length, dates: dates.map((k) => dayLabel(c.lang, k)) });
/** The same to a player whose games come from his row: only those still to play are listed. */
const gamesAsk = (c: Club, covers: number, played: number, dates: Date[]) =>
  t(c.lang).msu_dm_games_which({ month: monthName(c), games: covers, played, dates: dates.map((k) => dayLabel(c.lang, k)) });
const plainAsk = (c: Club, games: number) =>
  t(c.lang).msu_dm_join_ask({ month: monthName(c), games, price: c.priced ? `£${((SHARE * games) / 100).toFixed(2)}` : null });
/** The organisers' one line in the admin channel (each-admin: a DM to each owner). */
const hqLine = (c: Club, who: Person, words: string) => t(c.lang).msu_admin_games_unrecorded({ name: who.name, month: monthName(c), words });

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
     VALUES ($1, $2, 'Football', $3, ARRAY['GK','DEF','MID','FWD'], ARRAY['Bibs','Shirts'], now())`,
    [`${c.org}-sport`, c.org, c.perTeam],
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
  // The games already played are matches of the month, COMPLETED.
  for (const [i, k] of pastOf(c).entries()) {
    await db.run(
      `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt") VALUES ($1, $2, $3, 12, 'COMPLETED', $3, now())`,
      [`${c.org}-played-${i}`, c.act, k.toISOString()],
    );
  }
  const next = leftOf(c)[0];
  if (next) {
    await db.run(
      `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt") VALUES ($1, $2, $3, 12, 'UPCOMING', $3, now())`,
      [`${c.org}-match`, c.act, next.toISOString()],
    );
  }
  const running = c.status === "running";
  await db.run(
    `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "gamesPlayedBeforeStart",
                               "startedMidMonthAt", "listOpenedAt", "sharePerGamePence", "pricedAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4::date, $5, $6, 0, $7, $8, $9, $10, now() - interval '1 hour', now())`,
    [
      c.month,
      c.org,
      c.act,
      c.monthStart,
      c.status,
      c.games.length,
      running ? new Date(Date.now() - 3600_000).toISOString() : null,
      running ? null : new Date(Date.now() - 3600_000).toISOString(),
      c.priced ? SHARE : null,
      c.priced ? new Date().toISOString() : null,
    ],
  );
}

async function onMonth(
  db: TestDb,
  c: Club,
  who: Person,
  /** paid: "claimed" (says paid) or "confirmed" (the collector confirmed it). */
  o: { kind?: "regular" | "payg"; slot?: number | null; covered?: number; out?: boolean; waiting?: boolean; paid?: "claimed" | "confirmed" } = {},
) {
  const kind = o.kind ?? "regular";
  const covered = o.covered ?? (kind === "regular" ? c.games.length : 0);
  const col = o.paid === "claimed" ? `"paidClaimedAt", "paidClaimedAmountPence"` : `"paidAt", "paidAmountPence"`;
  await db.run(
    `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, "gamesCovered", "amountDuePence", note, source, "leftAt", ${col}, "joinedAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'seed-list', $9, $10, $11, $12::date - interval '1 day', now())`,
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
      o.paid ? new Date().toISOString() : null,
      o.paid ? covered * SHARE : null,
      c.monthStart,
    ],
  );
}

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await makeClub(db, EN, "Vets MNF");
  await person(db, EN, P.rob, "OWNER");
  for (const p of EN_ORDER.slice(1)) await person(db, EN, p);
  await onMonth(db, EN, P.rob, { slot: 1 });
  await onMonth(db, EN, P.alex, { slot: 2 });
  await onMonth(db, EN, P.pat, { kind: "payg" });
  await onMonth(db, EN, P.bea, { kind: "payg", waiting: true });
  await onMonth(db, EN, P.olly, { slot: 3, out: true });
  await onMonth(db, EN, P.lee, { slot: 4, covered: LEFT });
  // Left after paying for 2 games: he keeps them.
  await onMonth(db, EN, P.pam, { slot: 5, out: true, covered: 2, paid: "claimed" });
  // Left after the collector CONFIRMED his payment for 2 games: only an organiser changes those.
  await onMonth(db, EN, P.pia, { slot: 6, out: true, covered: 2, paid: "confirmed" });

  await makeClub(db, TR, "Pazartesi Halısaha");
  await person(db, TR, P.emre, "OWNER");
  await person(db, TR, P.ayse);
  await onMonth(db, TR, P.emre, { slot: 1 });

  await makeClub(db, ONE, "One Left FC");
  await person(db, ONE, P.own1, "OWNER");
  await person(db, ONE, P.sam);

  await makeClub(db, SU, "Signup FC");
  await person(db, SU, P.sue, "OWNER");
  await person(db, SU, P.lea);
  await person(db, SU, P.nia);
  await onMonth(db, SU, P.sue, { slot: 1 });
  // A regular whose row covers 3 of the month's games.
  await onMonth(db, SU, P.lea, { slot: 2, covered: 3 });

  await makeClub(db, FULL, "Full FC");
  await person(db, FULL, P.fay, "OWNER");
  await person(db, FULL, P.fin);
  await person(db, FULL, P.ben);
  await onMonth(db, FULL, P.fay, { slot: 1 });
  await onMonth(db, FULL, P.fin, { slot: 2 });

  if (PLAYED) {
    await makeClub(db, PLAYED, "Played FC");
    await person(db, PLAYED, P.own2, "OWNER");
    await person(db, PLAYED, P.ivy);
    await person(db, PLAYED, P.rex);
    // Rex: a regular for the whole month, who played every game so far.
    await onMonth(db, PLAYED, P.rex, { slot: 1 });
    for (const [i] of pastOf(PLAYED).entries()) {
      await db.run(`INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt") VALUES ($1, $2, $3, 'CONFIRMED', 1, now())`, [
        `e2e-lj-rex-att-${i}`,
        `${PLAYED.org}-played-${i}`,
        P.rex.id,
      ]);
    }
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

  const turn = readerTurn(body);
  expect(turn).toContain(`3 still to play: ${EN.games.map((k) => formatInTimeZone(k, LONDON, "EEE d MMM")).join(", ")}.`);
  expect(turn).toContain(`THE SENDER COVERS in ${monthLabel(EN)}: 3 games, `);
  expect(turn).toContain("(not a regular on its list yet: joining now, the games still to play)");
  // Every regular's cover is in the context, by ref.
  expect(turn).toContain(`Games each regular on it covers: ${P.rob.name} (${refOf(P.rob)}) 3, ${P.alex.name} (${refOf(P.alex)}) 3, ${P.lee.name} (${refOf(P.lee)}) 3.`);

  await say(request, EN, P.will, body);
  expect(await dms(db, EN, P.will)).toHaveLength(1);

  expect(await dmReply(request, P.will, "yes")).toMatchObject({ handled: "month-join-yes" });
  const answer = readerTurn("yes");
  expect(answer).toContain(`RECENT CHAT (context only):\n  ${P.will.name}: ${body}`);
  expect(answer).toContain("THE MESSAGE is his DM to MatchTime, answering its question above.");
  expect(await monthRow(db, EN, P.will)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: 2, amountDuePence: 1500 });
});

test("hole 6: answers that never fit are asked about again, at most 3 times; then the answer is consumed and the organisers are told once", async ({ request, db }) => {
  const body = `In for ${monthName(EN)}, 4 games`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 4), "hmm the usual": signup(EN, 3), "still the usual": signup(EN, 3), "the usual again": signup(EN, 3) } });
  expect(await say(request, EN, P.tom, body)).toMatchObject({ intent: "month_signup", react: null });
  expect(await dmReply(request, P.tom, "hmm the usual")).toMatchObject({ handled: "month-join-asked" });
  expect(await dmReply(request, P.tom, "still the usual")).toMatchObject({ handled: "month-join-asked" });
  expect(await dms(db, EN, P.tom)).toEqual([whichAsk(EN, EN.games), whichAsk(EN, EN.games), whichAsk(EN, EN.games)]);
  expect(await dmReply(request, P.tom, "the usual again")).toMatchObject({ handled: "month-join-noted" });
  expect(await monthRow(db, EN, P.tom)).toBeNull();
  expect((await dms(db, EN, P.rob)).filter((d) => d === hqLine(EN, P.tom, "the usual again"))).toHaveLength(1);
});

test("typed, a partial count that fits: stored at once, with ✅, and no question", async ({ request, db }) => {
  const body = `I'm in for ${monthName(EN)}, just two games`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 2) } });
  expect(await say(request, EN, P.bilal, body)).toMatchObject({ intent: "month_signup", react: "✅" });
  expect(await monthRow(db, EN, P.bilal)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: 2, amountDuePence: 1500 });
  expect((await dms(db, EN, P.bilal)).some((d) => d.includes("Which of them"))).toBe(false);
});

test("typed, a full late join: every game left, with ✅", async ({ request, db }) => {
  const body = `IN FOR ${monthName(EN).toUpperCase()}`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 0) } });
  expect(await say(request, EN, P.chris, body)).toMatchObject({ intent: "month_signup", react: "✅" });
  expect(await monthRow(db, EN, P.chris)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: null, amountDuePence: 2250 });
});

test("a PAYG player becoming a regular covers the games left: 'except the last week' read as 2 is stored, with ✅", async ({ request, db }) => {
  const body = `I'm in for ${monthName(EN)} except the last week`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 2) } });
  expect(await say(request, EN, P.pat, body)).toMatchObject({ intent: "month_signup", react: "✅" });
  expect(readerTurn(body)).toContain(`THE SENDER COVERS in ${monthLabel(EN)}: 3 games, `);
  expect(await monthRow(db, EN, P.pat)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: 2, amountDuePence: 1500 });
});

test("a bench player becoming a regular, read as every game left: asked, nothing stored, no ✅", async ({ request, db }) => {
  const body = `In for ${monthName(EN)} except the last week please`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 3) } });
  expect(await say(request, EN, P.bea, body)).toMatchObject({ intent: "month_signup", react: null });
  expect(await monthRow(db, EN, P.bea)).toMatchObject({ kind: "payg", waiting: true, gamesCommitted: null });
  expect(await dms(db, EN, P.bea)).toEqual([whichAsk(EN, EN.games)]);
});

test("'yes except the last week' to the plain join question, read as every game: asked which games (its own question); then joined for what he says", async ({ request, db }) => {
  const body = `IN FOR ${monthName(EN).toUpperCase()} again`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 0), "yes except the last week": signup(EN, 3), "yes that's right": signup(EN, 2) } });
  await say(request, EN, P.olly, body);
  expect(await dms(db, EN, P.olly)).toEqual([plainAsk(EN, 3)]);
  expect(await dmReply(request, P.olly, "yes except the last week")).toMatchObject({ handled: "month-join-asked" });
  expect(await monthRow(db, EN, P.olly)).toMatchObject({ out: true });
  expect(await dms(db, EN, P.olly)).toEqual([plainAsk(EN, 3), whichAsk(EN, EN.games)]);
  expect(await dmReply(request, P.olly, "yes that's right")).toMatchObject({ handled: "month-join-yes" });
  expect(readerTurn("yes that's right")).toContain(`${P.olly.name}: yes except the last week`);
  expect(await monthRow(db, EN, P.olly)).toMatchObject({ kind: "regular", out: false, gamesCovered: 3, gamesCommitted: 2, amountDuePence: 1500 });
});

test("a late joiner already on the list changing his games, read against the month (4 of his 3): no ✅, not stored, asked about HIS games; his answer is stored", async ({ request, db }) => {
  const body = `Actually I'm in for ${monthName(EN)} except the last week`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 4), "yes, first two": signup(EN, 2) } });
  expect(await say(request, EN, P.lee, body)).toMatchObject({ intent: "month_signup", react: null });
  expect(readerTurn(body)).toContain("(a regular on its list)");
  expect(await monthRow(db, EN, P.lee)).toMatchObject({ kind: "regular", gamesCommitted: null, amountDuePence: 2250 });
  expect(await dms(db, EN, P.lee)).toEqual([gamesAsk(EN, 3, 0, EN.games)]);
  expect(await dmReply(request, P.lee, "yes, first two")).toMatchObject({ handled: "month-join-yes" });
  expect(await monthRow(db, EN, P.lee)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: 2, amountDuePence: 1500 });
});

test("paste, his own line 'Dan except the last week' on the month's list: asked which games; 'yes' keeps the line's count", async ({ request, db }) => {
  const body = [`List for ${monthName(EN)}:`, "1. Rob Hale", "2. Alex Carter", "3. Dan except the last week"].join("\n");
  setMonthlyReaderStub({
    bodies: {
      [body]: monthList(EN, [line(1, "Rob Hale", { member: refOf(P.rob) }), line(2, "Alex Carter", { member: refOf(P.alex) }), line(3, "Dan", { member: refOf(P.dan), games: 4 })]),
      yep: signup(EN, 2),
    },
  });
  const res = await say(request, EN, P.dan, body);
  expect(res).toMatchObject({ handledBy: "fast-path", intent: "month_signup_list", react: null });
  expect(await monthRow(db, EN, P.dan)).toBeNull();
  expect(await dms(db, EN, P.dan)).toEqual([whichAsk(EN, EN.games)]);
  expect(await dmReply(request, P.dan, "yep")).toMatchObject({ handled: "month-join-yes" });
  expect(readerTurn("yep")).toContain("3. Dan except the last week");
  expect(await monthRow(db, EN, P.dan)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: 2, amountDuePence: 1500 });
});

/** As if asked a game earlier: the question listed one game now played, and the next two. */
async function askedAGameAgo(db: TestDb, who: Person): Promise<void> {
  const listed = [new Date(Date.now() - 24 * 3600_000), EN.games[0], EN.games[1]];
  const ask = await db.one<{ id: string; text: string }>(`SELECT id, text FROM "SentNotification" WHERE kind = 'month-join-which' AND "targetUser" = $1`, [who.id]);
  const dm = whichAsk(EN, listed);
  await db.run(`UPDATE "SentNotification" SET text = $2 WHERE id = $1`, [ask!.id, JSON.stringify({ ...JSON.parse(ask!.text), dm, dates: listed.map((d) => d.toISOString()) })]);
  await db.run(`UPDATE "BotJob" SET text = $2 WHERE "orgId" = $1 AND phone = $3 AND kind = 'dm'`, [EN.org, dm, digits(who.phone)]);
}

test("hole 3: a listed game played before he answers: never a guess ('just the last one'); asked again with the dates now left, and that answer is stored", async ({ request, db }) => {
  const body = `Kim here, in for ${monthName(EN)} except the last week`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 3), "just the last one": signup(EN, 1), "all of them": signup(EN, 0) } });
  await say(request, EN, P.kim, body);
  await askedAGameAgo(db, P.kim);
  expect(await dmReply(request, P.kim, "just the last one")).toMatchObject({ handled: "month-join-asked" });
  expect(await monthRow(db, EN, P.kim)).toBeNull();
  expect((await dms(db, EN, P.kim)).at(-1)).toBe(whichAsk(EN, EN.games));
  expect(await dmReply(request, P.kim, "all of them")).toMatchObject({ handled: "month-join-yes" });
  expect(await monthRow(db, EN, P.kim)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: null, amountDuePence: 2250 });
});

test("hole 3: the same with 'the last two': asked again, nothing stored", async ({ request, db }) => {
  const body = `Kit here, in for ${monthName(EN)} except the last week`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 3), "the last two": signup(EN, 2) } });
  await say(request, EN, P.kit, body);
  await askedAGameAgo(db, P.kit);
  expect(await dmReply(request, P.kit, "the last two")).toMatchObject({ handled: "month-join-asked" });
  expect(await monthRow(db, EN, P.kit)).toBeNull();
  expect(await dms(db, EN, P.kit)).toHaveLength(2);
});

test("hole 4: a count that fits closes the open question: 3, 4, 2, then 'all of them' to the closed question leaves 2", async ({ request, db }) => {
  const [a, b, c] = [`Sid in ${monthName(EN)} bar the last`, `Sid in ${monthName(EN)}, 4 games`, `Sid in ${monthName(EN)}, 2 games`];
  setMonthlyReaderStub({ bodies: { [a]: signup(EN, 3), [b]: signup(EN, 4), [c]: signup(EN, 2), "all of them": signup(EN, 0) } });
  expect(await say(request, EN, P.seq, a)).toMatchObject({ react: null });
  expect(await say(request, EN, P.seq, b)).toMatchObject({ react: null });
  expect(await say(request, EN, P.seq, c)).toMatchObject({ react: "✅" });
  // Quoting the question itself, so it is what he answers (not the join DM since).
  expect(await dmReply(request, P.seq, "all of them", { quotedText: whichAsk(EN, EN.games), quotedFromMatchTime: true })).not.toMatchObject({ handled: "month-join-yes" });
  expect(await monthRow(db, EN, P.seq)).toMatchObject({ kind: "regular", gamesCommitted: 2, amountDuePence: 1500 });
});

test("hole 6: after 3 questions a month a typed count is consumed, never passed on, and the organisers are told once", async ({ request, db }) => {
  const body = `In for ${monthName(EN)} bar the last`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 3) } });
  const expire = () => db.run(`UPDATE "SentNotification" SET "createdAt" = now() - interval '3 days' WHERE kind = 'month-join-which' AND "targetUser" = $1`, [P.mo.id]);
  for (let i = 1; i <= 3; i++) {
    expect(await say(request, EN, P.mo, body)).toMatchObject({ intent: "month_signup", react: null });
    expect(await dms(db, EN, P.mo)).toHaveLength(i);
    await expire();
  }
  for (let i = 0; i < 2; i++) expect(await say(request, EN, P.mo, body)).toMatchObject({ handledBy: "fast-path", intent: "month_signup", react: null });
  expect(await dms(db, EN, P.mo)).toHaveLength(3);
  expect(await monthRow(db, EN, P.mo)).toBeNull();
  expect((await dms(db, EN, P.rob)).filter((d) => d === hqLine(EN, P.mo, body))).toHaveLength(1);
});

test("hole 9: an organiser's add with a count that does not fit HIS games: he is added, the count is not, and HE is asked", async ({ request, db }) => {
  const body = `@Match Time add Zak to the ${monthName(EN)} list, 4 games`;
  setMonthlyReaderStub({ bodies: { [body]: { ...signup(EN, 4), signupFor: "other", signupWho: refOf(P.zak), signupName: "Zak" } } });
  const robBefore = (await dms(db, EN, P.rob)).length;
  await say(request, EN, P.rob, body, { botMentioned: true });
  expect(await monthRow(db, EN, P.zak)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: null });
  expect(await dms(db, EN, P.zak)).toContain(gamesAsk(EN, 3, 0, EN.games));
  expect((await dms(db, EN, P.rob)).slice(robBefore).some((d) => d.includes("Which of them"))).toBe(false);
});

test("hole 10: a leaver who paid for 2 games comes back: his count is checked against the 2 he keeps", async ({ request, db }) => {
  const body = `In for ${monthName(EN)} again except the last week`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 2), "yes please": signup(EN, 1) } });
  expect(await say(request, EN, P.pam, body)).toMatchObject({ react: null });
  expect(await dms(db, EN, P.pam)).toEqual([gamesAsk(EN, 2, 0, EN.games.slice(-2))]);
  expect(await dmReply(request, P.pam, "yes please")).toMatchObject({ handled: "month-join-yes" });
  expect(await monthRow(db, EN, P.pam)).toMatchObject({ kind: "regular", out: false, gamesCovered: 2, gamesCommitted: 1 });
});

test("hole 10: a leaver whose payment for 2 games was CONFIRMED: only an organiser changes his games, so nothing is asked or stored; the organisers are told once", async ({ request, db }) => {
  const body = `Pia in for ${monthName(EN)} again, just the one game`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 1) } });
  expect(await say(request, EN, P.pia, body)).toMatchObject({ handledBy: "fast-path", intent: "month_signup", react: null });
  expect(await monthRow(db, EN, P.pia)).toMatchObject({ out: true, gamesCommitted: null });
  expect(await dms(db, EN, P.pia)).toEqual([]);
  expect((await dms(db, EN, P.rob)).filter((d) => d === hqLine(EN, P.pia, body))).toHaveLength(1);
});

test("hole 1: an organiser's list line about a regular covering 3 ('Lea except the last week' read as 4): not stored, LEA is asked, the organiser hears nothing more", async ({ request, db }) => {
  const body = [`List for ${monthName(SU)}:`, "1. Sue Owner", "2. Lea except the last week"].join("\n");
  setMonthlyReaderStub({ bodies: { [body]: monthList(SU, [line(1, "Sue Owner", { member: "p1" }), line(2, "Lea", { member: "p2", games: 4 })]) } });
  const res = await say(request, SU, P.sue, body);
  expect(readerTurn(body)).toContain(`Games each regular on it covers: ${P.sue.name} (p1) ${SU.games.length}, ${P.lea.name} (p2) 3.`);
  expect(res).toMatchObject({ react: null });
  expect(await monthRow(db, SU, P.lea)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: null });
  expect(await dms(db, SU, P.lea)).toEqual([gamesAsk(SU, 3, 0, SU.games.slice(-3))]);
  expect(await dms(db, SU, P.sue)).toEqual([]);
});

test("hole 2: a newcomer's paste for a month in sign-up, his count read as every game: nothing stored (not even his place), asked which games, no ✅", async ({ request, db }) => {
  const body = [`List for ${monthName(SU)}:`, "1. Sue Owner", "2. Lea Two", "3. Nia except the last week"].join("\n");
  setMonthlyReaderStub({
    bodies: { [body]: monthList(SU, [line(1, "Sue Owner", { member: "p1" }), line(2, "Lea Two", { member: "p2" }), line(3, "Nia", { member: "p3", games: SU.games.length })]) },
  });
  const res = await say(request, SU, P.nia, body);
  expect(res).toMatchObject({ intent: "month_signup_list", react: null });
  expect(await monthRow(db, SU, P.nia)).toBeNull();
  expect(await dms(db, SU, P.nia)).toEqual([whichAsk(SU, SU.games)]);
});

test("hole 8: a count that fits, for somebody who lands on the bench: kept on his row for when he becomes a regular", async ({ request, db }) => {
  const body = `In for ${monthName(FULL)}, just two games`;
  setMonthlyReaderStub({ bodies: { [body]: signup(FULL, 2) } });
  await say(request, FULL, P.ben, body);
  expect(await monthRow(db, FULL, P.ben)).toMatchObject({ kind: "payg", waiting: true, gamesCommitted: 2 });
});

test("hole 5: one game left, a count of 1 is that one game: every game, with ✅, never a question", async ({ request, db }) => {
  const body = `In for ${monthName(ONE)}, just the one game`;
  setMonthlyReaderStub({ bodies: { [body]: signup(ONE, 1) } });
  expect(await say(request, ONE, P.sam, body)).toMatchObject({ intent: "month_signup", react: "✅" });
  expect(await monthRow(db, ONE, P.sam)).toMatchObject({ kind: "regular", gamesCovered: 1, gamesCommitted: null, amountDuePence: 750 });
  expect(await dms(db, ONE, P.sam)).not.toContain(whichAsk(ONE, ONE.games));
});

test("games already played (games left fewer than the month's): a joiner's count is against the games left, and the reader sees the played ones", async ({ request, db }) => {
  test.skip(!PLAYED || leftOf(PLAYED).length < 2, "needs a month this calendar month with two games played and two still to play");
  const c = PLAYED!;
  const left = leftOf(c).length;
  const body = `I'm in for ${monthName(c)} except the last week`;
  setMonthlyReaderStub({ bodies: { [body]: signup(c, left - 1) } });
  expect(await say(request, c, P.ivy, body)).toMatchObject({ intent: "month_signup", react: "✅" });
  const turn = readerTurn(body);
  expect(turn).toContain(`${formatInTimeZone(c.games[0], LONDON, "EEE d MMM")} (played)`);
  expect(turn).toContain(`THE SENDER COVERS in ${monthLabel(c)}: ${left} games, `);
  expect(await monthRow(db, c, P.ivy)).toMatchObject({ kind: "regular", gamesCovered: left, gamesCommitted: left - 1, amountDuePence: (left - 1) * SHARE });
});

test("holes 5 and 7: a full-month regular who has played his games types '1 game': asked, with only the games left listed; his answer adds the games behind him", async ({ request, db }) => {
  test.skip(!PLAYED || leftOf(PLAYED).length < 2, "needs a month this calendar month with two games played and two still to play");
  const c = PLAYED!;
  const [covers, played, left] = [c.games.length, pastOf(c).length, leftOf(c)];
  const body = `In for ${monthName(c)}, 1 game`;
  setMonthlyReaderStub({ bodies: { [body]: signup(c, 1), "just the last one": signup(c, 1) } });
  expect(await say(request, c, P.rex, body)).toMatchObject({ intent: "month_signup", react: null });
  expect(await monthRow(db, c, P.rex)).toMatchObject({ gamesCommitted: null });
  expect(await dms(db, c, P.rex)).toEqual([gamesAsk(c, covers, played, left)]);
  expect(await dmReply(request, P.rex, "just the last one")).toMatchObject({ handled: "month-join-yes" });
  expect(await monthRow(db, c, P.rex)).toMatchObject({ kind: "regular", gamesCovered: covers, gamesCommitted: played + 1, amountDuePence: (played + 1) * SHARE });
});

test("hole 6: no game left: a typed count is consumed, never passed on, and the organisers are told once", async ({ request, db }) => {
  test.skip(!NONE_LEFT, "needs a game already played this calendar month");
  const c = NONE_LEFT!;
  const body = `I'm in for ${monthName(c)} except the last week`;
  setMonthlyReaderStub({ bodies: { [body]: signup(c, 2) } });
  expect(await say(request, c, P.zoe, body)).toMatchObject({ handledBy: "fast-path", intent: "month_signup", react: null });
  expect(await dms(db, c, P.zoe)).toEqual([]);
  expect(await monthRow(db, c, P.zoe)).toBeNull();
  expect(await dms(db, c, P.own3)).toEqual([hqLine(c, P.zoe, body)]);
});

test("Turkish: 'son hafta hariç' that does not fit is asked in Turkish, and nothing is stored", async ({ request, db }) => {
  const body = `${monthName(TR)} varım son hafta hariç`;
  setMonthlyReaderStub({ bodies: { [body]: signup(TR, 3) } });
  expect(await say(request, TR, P.ayse, body)).toMatchObject({ intent: "month_signup", react: null });
  expect(await monthRow(db, TR, P.ayse)).toBeNull();
  expect(await dms(db, TR, P.ayse)).toEqual([whichAsk(TR, TR.games)]);
});
