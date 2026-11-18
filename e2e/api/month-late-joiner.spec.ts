/**
 * A PLAYER'S GAMES COUNT, END TO END (2026-11-16). The model is stubbed
 * (`setMonthlyReaderStub`: the reading it would give, keyed by the
 * message), so this proves what MatchTime DOES with a reading, through the
 * real routes and database, for $0.
 *
 * THE RULE: a count is read against THE GAMES HE COVERS. A regular's
 * row's games (a leaver who paid keeps his); anybody joining or becoming a
 * regular now (a newcomer, a pay-as-you-go or bench player) the games still
 * to play. Every door gives the count to the one setter's FIT RULE: a count
 * below what he covers is stored as read; at or above it is every game he
 * covers (never more); below the games he has played is the games played.
 * Nobody is ever asked "which games?" (cut 2026-11-16). When what is stored
 * is not what was said, the organisers are told once, in the admin channel.
 * NOBODY IS CHARGED FOR A GAME HE DID NOT COMMIT TO: every amount below is
 * the share times the games he said (or played), never more.
 *
 * The main club is the reviewers' setup: a PRICED month (£7.50 a game)
 * with 3 games left. It is NEXT calendar month, started part-way, with its
 * other weeks cancelled, so exactly 3 games are left whatever today's date.
 * Others: Turkish; one game left; a month still in sign-up; a full month
 * (two places); an open-squad club; a month with no price; and two clubs
 * on THIS month, on the real clock: one with games already played, one
 * with none left.
 */
import type { APIRequestContext } from "@playwright/test";
import { formatInTimeZone } from "date-fns-tz";
import { tr as trLocale } from "date-fns/locale";
import { test, expect, resetDb, signInAs } from "../fixtures";
import { clearMonthlyReaderStub, engineOn, setMonthlyReaderStub, stubCalls } from "../helpers/stub";
import { E2E } from "../helpers/env";
import { testDb, type TestDb } from "../helpers/test-db";
import { monthKickoffs, nextMonthStart, WAITING_NOTE } from "@/lib/month-signup-rules";
import { londonMonthStart } from "@/lib/squad-month-rules";
import { t } from "@/lib/i18n/t";

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
  openSquad: boolean;
}

function club(
  id: string,
  o: {
    lang?: "en" | "tr";
    monthStart: string;
    weekday?: number;
    time?: string;
    keep?: (all: Date[]) => Date[];
    status?: "running" | "open";
    perTeam?: number;
    priced?: boolean;
    openSquad?: boolean;
  },
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
    priced: o.priced ?? true,
    status: o.status ?? "running",
    perTeam: o.perTeam ?? 6,
    openSquad: o.openSquad ?? false,
  };
}

// The reviewers' club: priced, 3 games left (next month, its other weeks cancelled).
// Room for everybody below (20 regular places).
const EN = club("en", { monthStart: NEXT, keep: (all) => all.slice(-3), perTeam: 14 });
const TR = club("tr", { lang: "tr", monthStart: NEXT, keep: (all) => all.slice(-3) });
const ONE = club("one", { monthStart: NEXT, keep: (all) => all.slice(-1) });
// Next month, still in sign-up: every game to play.
const SU = club("su", { monthStart: NEXT, status: "open" });
// Two regular places only, both taken; 3 games left.
const FULL = club("full", { monthStart: NEXT, keep: (all) => all.slice(-3), perTeam: 1 });
// Next month, in sign-up, a regular with "N-1 only" stored (a week is cancelled later).
const SM = club("sm", { monthStart: NEXT, status: "open" });
// Next month, running, 3 games left: its week is seeded by the poll, for a WEEK paste.
const WK = club("wk", { monthStart: NEXT, keep: (all) => all.slice(-3) });
// An OPEN SQUAD club (#623): two places by its sport, both taken, but no limit; 3 games left.
const OPEN = club("open", { monthStart: NEXT, keep: (all) => all.slice(-3), perTeam: 1, openSquad: true });
// A month with NO price; 3 games left.
const FREE = club("free", { monthStart: NEXT, keep: (all) => all.slice(-3), priced: false });
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
  // Round 4 (2026-11-16).
  lu: { id: "e2e-lj-lu", name: "Lu Locked", phone: "+447700940040" },
  exa: { id: "e2e-lj-exa", name: "Exa Expired", phone: "+447700940041" },
  oz: { id: "e2e-lj-oz", name: "Oz Out", phone: "+447700940042" },
  pal: { id: "e2e-lj-pal", name: "Pal Paid", phone: "+447700940043" },
  kay: { id: "e2e-lj-kay", name: "Kay Kickoff", phone: "+447700940044" },
  pip: { id: "e2e-lj-pip", name: "Pip Played", phone: "+447700940045" },
  rio: { id: "e2e-lj-rio", name: "Rio Restate", phone: "+447700940046" },
  rae: { id: "e2e-lj-rae", name: "Rae Equal", phone: "+447700940047" },
  sol: { id: "e2e-lj-sol", name: "Sol Other", phone: "+447700940048" },
  cy: { id: "e2e-lj-cy", name: "Cy Confirmed", phone: "+447700940049" },
  smi: { id: "e2e-lj-smi", name: "Smi Smith", phone: "+447700940050" },
  own4: { id: "e2e-lj-own4", name: "Owner Four", phone: "+447700940051" },
  bo: { id: "e2e-lj-bo", name: "Bo Bench", phone: "+447700940052" },
  // Round 5 (2026-11-16).
  wil: { id: "e2e-lj-wil", name: "Wil Tentative", phone: "+447700940060" },
  cal: { id: "e2e-lj-cal", name: "Cal Plain", phone: "+447700940061" },
  poe: { id: "e2e-lj-poe", name: "Poe Pool", phone: "+447700940062" },
  pay: { id: "e2e-lj-pay", name: "Pay Link", phone: "+447700940063" },
  oth: { id: "e2e-lj-oth", name: "Oth Club", phone: "+447700940064" },
  pax: { id: "e2e-lj-pax", name: "Pax Paid", phone: "+447700940065" },
  pea: { id: "e2e-lj-pea", name: "Pea Paid", phone: "+447700940066" },
  ede: { id: "e2e-lj-ede", name: "Ede Edge", phone: "+447700940067" },
  lex: { id: "e2e-lj-lex", name: "Lex Late", phone: "+447700940068" },
  lum: { id: "e2e-lj-lum", name: "Lum Set", phone: "+447700940069" },
  max: { id: "e2e-lj-max", name: "Max Missed", phone: "+447700940070" },
  mia: { id: "e2e-lj-mia", name: "Mia Missed", phone: "+447700940071" },
  wes: { id: "e2e-lj-wes", name: "Wes Owner", phone: "+447700940072" },
  nn: { id: "e2e-lj-nn", name: "", phone: "+447700940073" },
  // 2026-11-18: open squad and no price.
  own5: { id: "e2e-lj-own5", name: "Owner Five", phone: "+447700940080" },
  ola: { id: "e2e-lj-ola", name: "Ola Open", phone: "+447700940081" },
  oli: { id: "e2e-lj-oli", name: "Oli Open", phone: "+447700940082" },
  own6: { id: "e2e-lj-own6", name: "Owner Six", phone: "+447700940083" },
  fen: { id: "e2e-lj-fen", name: "Fen Free", phone: "+447700940084" },
  // Review of #610 (2026-11-18).
  bex: { id: "e2e-lj-bex", name: "Bex Bench", phone: "+447700940090" },
  bry: { id: "e2e-lj-bry", name: "Bry Bench", phone: "+447700940091" },
} as const;
type Person = (typeof P)[keyof typeof P];
const digits = (phone: string) => phone.replace(/^\+/, "");
let seq = 0;

/** The EN club's members in the order they are added: p1 is the first. */
const EN_ORDER: Person[] = [P.rob, P.alex, P.will, P.tom, P.bilal, P.chris, P.dan, P.pat, P.bea, P.olly, P.lee, P.kim, P.mo, P.kit, P.seq, P.zak, P.pam, P.pia, P.lu, P.exa, P.oz, P.pal, P.kay, P.wil, P.cal, P.poe, P.pay, P.oth, P.pax, P.pea, P.ede];
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

/** The club's due-posts poll: what runs the month's sweeps. */
async function poll(request: APIRequestContext, c: Club): Promise<void> {
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(c.group)}`, { headers: KEY });
  expect(res.status(), await res.text()).toBe(200);
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

/** The organisers' one line (each-admin: a DM to each owner) when what was stored is not what was said. */
const fittedLine = (c: Club, who: Person, p: { said: number; covers: number; played: number; stored: number; words: string }) =>
  t(c.lang).msu_admin_games_fitted({ name: who.name, month: monthName(c), ...p });
/** ... and when his payment is confirmed, so his games were left as they are. */
const unrecordedLine = (c: Club, who: Person, games: number, words: string) => t(c.lang).msu_admin_games_unrecorded({ name: who.name, month: monthName(c), games, words });
/** "Join <month> for the games left?", or for the N of them he said (`of`), priced for those. */
const plainAsk = (c: Club, games: number, of: number | null = null) =>
  t(c.lang).msu_dm_join_ask({ month: monthName(c), games, of, price: c.priced ? `£${((SHARE * (of ?? games)) / 100).toFixed(2)}` : null });
/** Every organisers' line about his games, to any owner of the club. */
const gamesLines = async (db: TestDb, c: Club, owner: Person, who: Person) => (await dms(db, c, owner)).filter((d) => d.includes(who.name) && d.includes(monthName(c)) && /recorded|left his games|kaydettim|değiştirmedim/.test(d));
/** No DM ever asks him which games (the question was cut, 2026-11-16). */
const noQuestion = async (db: TestDb, c: Club, who: Person) => expect((await dms(db, c, who)).filter((d) => /Which of them|Will you play it|Hangilerinde|Oynayacak mısın/.test(d))).toEqual([]);

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
                                 "paygPricePence", "adminChannelMode", language, "paymentTrackingEnabled", "openSquad", "updatedAt")
     VALUES ($1, $2, $1, $3, $4, true, 'monthly', 800, 'each-admin', $5, true, $6, now())`,
    [c.org, name, `${c.org}-invite`, c.group, c.lang, c.openSquad],
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
  // Leavers who never paid.
  await onMonth(db, EN, P.oz, { slot: 11, out: true });
  await onMonth(db, EN, P.exa, { slot: 12, out: true });
  // Review of #610: leavers who never paid.
  await onMonth(db, EN, P.kay, { slot: 13, out: true });
  await onMonth(db, EN, P.cal, { slot: 14, out: true });
  await onMonth(db, EN, P.wil, { slot: 15, out: true });
  await onMonth(db, EN, P.lee, { slot: 4, covered: LEFT });
  // Left after the collector CONFIRMED his payment for 2 games: only an organiser changes those.
  await onMonth(db, EN, P.pia, { slot: 6, out: true, covered: 2, paid: "confirmed" });
  // Leavers who say they paid for 2 games; Pea with "1 game" still on her row.
  await onMonth(db, EN, P.pax, { slot: 9, out: true, covered: 2, paid: "claimed" });
  await onMonth(db, EN, P.pea, { slot: 10, out: true, covered: 2, paid: "claimed" });
  await db.run(`UPDATE "SquadMonthMember" SET "gamesCommitted" = 1 WHERE "monthId" = $1 AND "userId" = $2`, [EN.month, P.pea.id]);

  await makeClub(db, TR, "Pazartesi Halısaha");
  await person(db, TR, P.emre, "OWNER");
  await person(db, TR, P.ayse);
  await person(db, TR, P.oth);
  await onMonth(db, TR, P.emre, { slot: 1 });

  await makeClub(db, ONE, "One Left FC");
  await person(db, ONE, P.own1, "OWNER");
  await person(db, ONE, P.sam);

  await makeClub(db, SU, "Signup FC");
  await person(db, SU, P.sue, "OWNER");
  await person(db, SU, P.lea);
  await person(db, SU, P.nia);
  await onMonth(db, SU, P.sue, { slot: 1 });
  // A regular whose row covers 3 of the month's games (p2).
  await onMonth(db, SU, P.lea, { slot: 2, covered: 3 });
  // A club player not on the month (p4), and a regular whose payment was confirmed (p5).
  await person(db, SU, P.sol);
  await person(db, SU, P.cy);
  await onMonth(db, SU, P.cy, { slot: 3, paid: "confirmed" });

  await makeClub(db, FULL, "Full FC");
  await person(db, FULL, P.fay, "OWNER");
  await person(db, FULL, P.fin);
  await person(db, FULL, P.ben);
  await person(db, FULL, P.bo);
  await onMonth(db, FULL, P.fay, { slot: 1 });
  await onMonth(db, FULL, P.fin, { slot: 2 });
  // On the bench with "2 games" kept from an earlier sign-up.
  await onMonth(db, FULL, P.bo, { kind: "payg", waiting: true });
  // Review of #610: two who will land on the bench, for an organiser to place.
  await person(db, FULL, P.bex);
  await person(db, FULL, P.bry);
  await db.run(`UPDATE "SquadMonthMember" SET "gamesCommitted" = 2 WHERE "monthId" = $1 AND "userId" = $2`, [FULL.month, P.bo.id]);

  await makeClub(db, WK, "Week FC");
  await person(db, WK, P.wes, "OWNER");
  await onMonth(db, WK, P.wes, { slot: 1 });

  await makeClub(db, SM, "Smiler FC");
  await person(db, SM, P.own4, "OWNER");
  await person(db, SM, P.smi);
  await onMonth(db, SM, P.own4, { slot: 1 });
  // "N-1 only", stored.
  await onMonth(db, SM, P.smi, { slot: 2 });
  await db.run(`UPDATE "SquadMonthMember" SET "gamesCommitted" = $3 WHERE "monthId" = $1 AND "userId" = $2`, [SM.month, P.smi.id, SM.games.length - 1]);

  // An OPEN SQUAD club (#623): no limit, no bench. Two places would be full.
  await makeClub(db, OPEN, "Open FC");
  await person(db, OPEN, P.own5, "OWNER");
  await person(db, OPEN, P.ola);
  await person(db, OPEN, P.oli);
  await onMonth(db, OPEN, P.own5, { slot: 1 });
  await onMonth(db, OPEN, P.ola, { slot: 2 });
  // A month with NO price.
  await makeClub(db, FREE, "Free FC");
  await person(db, FREE, P.own6, "OWNER");
  await person(db, FREE, P.fen);
  await onMonth(db, FREE, P.own6, { slot: 1 });

  if (PLAYED) {
    await makeClub(db, PLAYED, "Played FC");
    await person(db, PLAYED, P.own2, "OWNER");
    await person(db, PLAYED, P.ivy);
    // Rex, Rio and Rae: regulars for the whole month who played every game
    // so far. Rio has "one fewer than played" stored.
    for (const p of [P.rex, P.rio, P.rae]) await person(db, PLAYED, p);
    await onMonth(db, PLAYED, P.rex, { slot: 1 });
    await onMonth(db, PLAYED, P.rio, { slot: 2 });
    await onMonth(db, PLAYED, P.rae, { slot: 3 });
    await db.run(`UPDATE "SquadMonthMember" SET "gamesCommitted" = $3 WHERE "monthId" = $1 AND "userId" = $2`, [PLAYED.month, P.rio.id, pastOf(PLAYED).length - 1]);
    for (const p of [P.rex, P.rio, P.rae]) {
      for (const [i] of pastOf(PLAYED).entries()) {
        await db.run(`INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt") VALUES ($1, $2, $3, 'CONFIRMED', 1, now())`, [
          `e2e-lj-${p.id}-att-${i}`,
          `${PLAYED.org}-played-${i}`,
          p.id,
        ]);
      }
    }
    // Pip (review of #610, item 1): a regular for the whole month, "2 only",
    // says he paid £15, played the first game, left, missed the second.
    await person(db, PLAYED, P.pip);
    await onMonth(db, PLAYED, P.pip, { slot: 4, out: true, paid: "claimed" });
    await db.run(`UPDATE "SquadMonthMember" SET "gamesCommitted" = 2, "paidClaimedAmountPence" = $3 WHERE "monthId" = $1 AND "userId" = $2`, [PLAYED.month, P.pip.id, 2 * SHARE]);
    await db.run(`INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt") VALUES ($1, $2, $3, 'CONFIRMED', 1, now())`, [
      `e2e-lj-${P.pip.id}-att-0`,
      `${PLAYED.org}-played-0`,
      P.pip.id,
    ]);
    // Mia: a regular for the whole month who missed the first game played.
    await person(db, PLAYED, P.mia);
    await onMonth(db, PLAYED, P.mia, { slot: 6 });
    for (const [i] of pastOf(PLAYED).entries()) {
      if (i === 0) continue;
      await db.run(`INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt") VALUES ($1, $2, $3, 'CONFIRMED', 1, now())`, [
        `e2e-lj-${P.mia.id}-att-${i}`,
        `${PLAYED.org}-played-${i}`,
        P.mia.id,
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

test("typed, 'except the last week' read against the 3 games left as 2: stored at once, £15, ✅, nothing asked, the organisers told nothing", async ({ request, db }) => {
  const body = `I'm in for ${monthName(EN)} except the last week`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 2) } });
  expect(await say(request, EN, P.will, body)).toMatchObject({ handledBy: "fast-path", intent: "month_signup", react: "✅" });
  expect(await monthRow(db, EN, P.will)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: 2, amountDuePence: 1500 });
  await noQuestion(db, EN, P.will);
  expect(await gamesLines(db, EN, P.rob, P.will)).toEqual([]);

  // What the reader was told: the games still to play, and what HE covers.
  const turn = readerTurn(body);
  expect(turn).toContain(`3 still to play: ${EN.games.map((k) => formatInTimeZone(k, LONDON, "EEE d MMM")).join(", ")}.`);
  expect(turn).toContain(`THE SENDER COVERS in ${monthLabel(EN)}: 3 games, `);
  expect(turn).toContain("(not a regular on its list yet: joining now, the games still to play)");
  // Every regular's cover is in the context, by ref, ordered by name then id.
  expect(turn).toContain(`Games each regular on it covers: ${P.alex.name} (${refOf(P.alex)}) 3, ${P.lee.name} (${refOf(P.lee)}) 3, ${P.rob.name} (${refOf(P.rob)}) 3.`);
  // Nothing of a question about his games.
  expect(turn).not.toContain("answering its question");
});

test("typed, a full late join: every game left, £22.50, ✅", async ({ request, db }) => {
  const body = `IN FOR ${monthName(EN).toUpperCase()}`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 0) } });
  expect(await say(request, EN, P.chris, body)).toMatchObject({ intent: "month_signup", react: "✅" });
  expect(await monthRow(db, EN, P.chris)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: null, amountDuePence: 2250 });
});

test("a count of exactly the games he covers is every game: nothing to tell the organisers", async ({ request, db }) => {
  const body = `In for ${monthName(EN)}, 3 games`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 3) } });
  expect(await say(request, EN, P.bilal, body)).toMatchObject({ intent: "month_signup", react: "✅" });
  expect(await monthRow(db, EN, P.bilal)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: null, amountDuePence: 2250 });
  expect(await gamesLines(db, EN, P.rob, P.bilal)).toEqual([]);
});

test("a count ABOVE the games he covers (4 of his 3): every game he covers, never more; the organisers are told once per count, quoting him", async ({ request, db }) => {
  const body = `In for ${monthName(EN)}, 4 games`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 4) } });
  expect(await say(request, EN, P.tom, body)).toMatchObject({ intent: "month_signup", react: "✅" });
  expect(await monthRow(db, EN, P.tom)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: null, amountDuePence: 2250 });
  await say(request, EN, P.tom, body);
  expect(await gamesLines(db, EN, P.rob, P.tom)).toEqual([fittedLine(EN, P.tom, { said: 4, covers: 3, played: 0, stored: 3, words: body })]);
  await noQuestion(db, EN, P.tom);
});

test("a PAYG player becoming a regular covers the games left: 'except the last week' read as 2 is stored, £15, ✅", async ({ request, db }) => {
  const body = `I'm in for ${monthName(EN)} except the last week`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 2) } });
  expect(await say(request, EN, P.pat, body)).toMatchObject({ intent: "month_signup", react: "✅" });
  expect(readerTurn(body)).toContain(`THE SENDER COVERS in ${monthLabel(EN)}: 3 games, `);
  expect(await monthRow(db, EN, P.pat)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: 2, amountDuePence: 1500 });
});

test("a bench player given a place by his own message: his count is stored, £15", async ({ request, db }) => {
  const body = `In for ${monthName(EN)} except the last week please`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 2) } });
  expect(await say(request, EN, P.bea, body)).toMatchObject({ intent: "month_signup", react: "✅" });
  expect(await monthRow(db, EN, P.bea)).toMatchObject({ kind: "regular", waiting: false, gamesCovered: 3, gamesCommitted: 2, amountDuePence: 1500 });
});

test("'yes except the last week' to the plain join question: joined for the 2 he says, £15", async ({ request, db }) => {
  const body = `IN FOR ${monthName(EN).toUpperCase()} again`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 0), "yes except the last week": signup(EN, 2) } });
  await say(request, EN, P.olly, body);
  expect(await dms(db, EN, P.olly)).toEqual([plainAsk(EN, 3)]);
  expect(await dmReply(request, P.olly, "yes except the last week")).toMatchObject({ handled: "month-join-yes" });
  expect(await monthRow(db, EN, P.olly)).toMatchObject({ kind: "regular", out: false, gamesCovered: 3, gamesCommitted: 2, amountDuePence: 1500 });
  await noQuestion(db, EN, P.olly);
});

test("a late joiner already on the list changing his games: counted against HIS 3; 2 is stored; then 4 is every game, and the organisers told", async ({ request, db }) => {
  const a = `Actually I'm in for ${monthName(EN)} except the last week`;
  const b = `Actually ${monthName(EN)}, 4 games`;
  setMonthlyReaderStub({ bodies: { [a]: signup(EN, 2), [b]: signup(EN, 4) } });
  expect(await say(request, EN, P.lee, a)).toMatchObject({ intent: "month_signup", react: "✅" });
  expect(readerTurn(a)).toContain("(a regular on its list)");
  expect(await monthRow(db, EN, P.lee)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: 2, amountDuePence: 1500 });
  expect(await say(request, EN, P.lee, b)).toMatchObject({ intent: "month_signup", react: "✅" });
  expect(await monthRow(db, EN, P.lee)).toMatchObject({ gamesCommitted: null, amountDuePence: 2250 });
  expect(await gamesLines(db, EN, P.rob, P.lee)).toEqual([fittedLine(EN, P.lee, { said: 4, covers: 3, played: 0, stored: 3, words: b })]);
});

test("paste, his own line 'Dan except the last week' on a month under way: the join question says HIS 2 games and their price; his plain 'yes' joins him for those 2, £15", async ({ request, db }) => {
  const body = [`List for ${monthName(EN)}:`, "1. Rob Hale", "2. Alex Carter", "3. Dan except the last week"].join("\n");
  setMonthlyReaderStub({
    bodies: {
      [body]: monthList(EN, [line(1, "Rob Hale", { member: refOf(P.rob) }), line(2, "Alex Carter", { member: refOf(P.alex) }), line(3, "Dan", { member: refOf(P.dan), games: 2 })]),
      yes: signup(EN, 0),
    },
  });
  expect(await say(request, EN, P.dan, body)).toMatchObject({ handledBy: "fast-path", intent: "month_signup_list" });
  expect(await monthRow(db, EN, P.dan)).toBeNull();
  expect(await dms(db, EN, P.dan)).toEqual([plainAsk(EN, 3, 2)]);
  expect(await dmReply(request, P.dan, "yes")).toMatchObject({ handled: "month-join-yes" });
  expect(await monthRow(db, EN, P.dan)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: 2, amountDuePence: 1500 });
  await noQuestion(db, EN, P.dan);
});

test("typed by a leaver, 'IN again except the last week': the join question says his 2; his plain 'yes' joins him for 2, £15", async ({ request, db }) => {
  const body = `IN FOR ${monthName(EN)} again except the last week`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 2), "yes mate": signup(EN, 0) } });
  await say(request, EN, P.oz, body);
  expect(await dms(db, EN, P.oz)).toEqual([plainAsk(EN, 3, 2)]);
  expect(await dmReply(request, P.oz, "yes mate")).toMatchObject({ handled: "month-join-yes" });
  expect(await monthRow(db, EN, P.oz)).toMatchObject({ kind: "regular", out: false, gamesCovered: 3, gamesCommitted: 2, amountDuePence: 1500 });
});

test("the join question with his 2, answered 'yes, just one': his own newer count wins, £7.50", async ({ request, db }) => {
  const body = `IN FOR ${monthName(EN)} once more except the last week`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 2), "yes, just one": signup(EN, 1) } });
  await say(request, EN, P.exa, body);
  expect(await dms(db, EN, P.exa)).toEqual([plainAsk(EN, 3, 2)]);
  expect(await dmReply(request, P.exa, "yes, just one")).toMatchObject({ handled: "month-join-yes" });
  expect(await monthRow(db, EN, P.exa)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: 1, amountDuePence: 750 });
});

test("review item 2: the join question asked when 4 games were left ('except the last week', 3); a game is played; his plain 'yes' is asked again with today's numbers (2 of the 3, £15), and that yes joins him for 2", async ({ request, db }) => {
  const body = `IN FOR ${monthName(EN)} again except the last week`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 2), yes: signup(EN, 0) } });
  await say(request, EN, P.kay, body);
  expect(await dms(db, EN, P.kay)).toEqual([plainAsk(EN, 3, 2)]);
  // As if asked a game ago: 4 left then, his count 3 of them.
  const m = await db.one<{ id: string; text: string }>(`SELECT id, text FROM "SentNotification" WHERE kind = 'month-join-ask-games' AND "targetUser" = $1`, [P.kay.id]);
  expect(JSON.parse(m!.text)).toMatchObject({ games: 2, left: 3 });
  await db.run(`UPDATE "SentNotification" SET text = $2 WHERE id = $1`, [m!.id, JSON.stringify({ games: 3, words: body, left: 4 })]);
  expect(await dmReply(request, P.kay, "yes")).toMatchObject({ handled: "month-join-asked" });
  expect(await monthRow(db, EN, P.kay)).toMatchObject({ out: true });
  expect(await dms(db, EN, P.kay)).toEqual([plainAsk(EN, 3, 2), plainAsk(EN, 3, 2)]);
  expect(await dmReply(request, P.kay, "yes")).toMatchObject({ handled: "month-join-yes" });
  expect(await monthRow(db, EN, P.kay)).toMatchObject({ kind: "regular", out: false, gamesCovered: 3, gamesCommitted: 2, amountDuePence: 1500 });
});

test("review item 2: a newer message with a different count while the question is open: the old question is closed and he is asked again with the new count; yes is 1 game, £7.50", async ({ request, db }) => {
  const a = `IN FOR ${monthName(EN)} again except the last week`;
  const b = `Actually ${monthName(EN)} again, just one game`;
  setMonthlyReaderStub({ bodies: { [a]: signup(EN, 2), [b]: signup(EN, 1), "yes please": signup(EN, 0) } });
  await say(request, EN, P.cal, a);
  await say(request, EN, P.cal, b);
  expect(await dms(db, EN, P.cal)).toEqual([plainAsk(EN, 3, 2), plainAsk(EN, 3, 1)]);
  // The same count again asks nothing more.
  await say(request, EN, P.cal, b);
  expect(await dms(db, EN, P.cal)).toHaveLength(2);
  expect(await dmReply(request, P.cal, "yes please")).toMatchObject({ handled: "month-join-yes" });
  expect(await monthRow(db, EN, P.cal)).toMatchObject({ kind: "regular", gamesCommitted: 1, amountDuePence: 750 });
});

test("review item 6: a count at or above the games left is not in the join question, and the organisers are told; 'yes, all 3' to '2 of the 3' is every game, £22.50", async ({ request, db }) => {
  const four = `IN FOR ${monthName(EN)} again, 4 games`;
  setMonthlyReaderStub({ bodies: { [four]: signup(EN, 4) } });
  await say(request, EN, P.wil, four);
  expect(await dms(db, EN, P.wil)).toEqual([plainAsk(EN, 3)]);
  expect(await gamesLines(db, EN, P.rob, P.wil)).toEqual([fittedLine(EN, P.wil, { said: 4, covers: 3, played: 0, stored: 3, words: four })]);

  const list = [`List for ${monthName(EN)}:`, "1. Rob Hale", "2. Pay Link except the last week"].join("\n");
  setMonthlyReaderStub({
    bodies: { [list]: monthList(EN, [line(1, "Rob Hale", { member: refOf(P.rob) }), line(2, "Pay Link", { member: refOf(P.pay), games: 2 })]), "yes, all 3": signup(EN, 3) },
  });
  await say(request, EN, P.pay, list);
  expect(await dms(db, EN, P.pay)).toEqual([plainAsk(EN, 3, 2)]);
  expect(await dmReply(request, P.pay, "yes, all 3")).toMatchObject({ handled: "month-join-yes" });
  expect(await monthRow(db, EN, P.pay)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: null, amountDuePence: 2250 });
});

test("an organiser's add with 2 games: on the list for 2 at once, £15, ✅", async ({ request, db }) => {
  const body = `@Match Time add Zak to the ${monthName(EN)} list, 2 games`;
  setMonthlyReaderStub({ bodies: { [body]: { ...signup(EN, 2), signupFor: "other", signupWho: refOf(P.zak), signupName: "Zak" } } });
  expect(await say(request, EN, P.rob, body, { botMentioned: true })).toMatchObject({ react: "✅" });
  expect(await monthRow(db, EN, P.zak)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: 2, amountDuePence: 1500 });
  await noQuestion(db, EN, P.zak);
});

test("an organiser's add with 4 games (of his 3): every game he covers, never more; the organisers told, quoting the organiser", async ({ request, db }) => {
  const body = `@Match Time add Kim to the ${monthName(EN)} list, 4 games`;
  setMonthlyReaderStub({ bodies: { [body]: { ...signup(EN, 4), signupFor: "other", signupWho: refOf(P.kim), signupName: "Kim" } } });
  expect(await say(request, EN, P.rob, body, { botMentioned: true })).toMatchObject({ react: "✅" });
  expect(await monthRow(db, EN, P.kim)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: null, amountDuePence: 2250 });
  expect(await gamesLines(db, EN, P.rob, P.kim)).toEqual([fittedLine(EN, P.kim, { said: 4, covers: 3, played: 0, stored: 3, words: body })]);
});

test("a leaver who says he paid for 2 answers the plain join question 'yes except the last week' (2 of the 3 left): counted from now, so every game of the 2 he keeps", async ({ request, db }) => {
  const body = `IN FOR ${monthName(EN).toUpperCase()} again please`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 0), "yes except the last week": signup(EN, 2) } });
  await say(request, EN, P.pax, body);
  // No new amount for somebody who has paid.
  expect(await dms(db, EN, P.pax)).toEqual([t("en").msu_dm_join_ask({ month: monthName(EN), games: 3, price: null })]);
  expect(await dmReply(request, P.pax, "yes except the last week")).toMatchObject({ handled: "month-join-yes" });
  expect(await monthRow(db, EN, P.pax)).toMatchObject({ kind: "regular", out: false, gamesCovered: 2, gamesCommitted: null });
});

test("a leaver who paid, with an old '1 game' on her row, back for 'all of them': the old count is cleared", async ({ request, db }) => {
  const body = `Pea in for ${monthName(EN)} again`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 0), "all of them please": signup(EN, 0) } });
  await say(request, EN, P.pea, body);
  expect(await dmReply(request, P.pea, "all of them please")).toMatchObject({ handled: "month-join-yes" });
  expect(await monthRow(db, EN, P.pea)).toMatchObject({ kind: "regular", out: false, gamesCovered: 2, gamesCommitted: null });
});

test("a leaver whose payment for 2 games was CONFIRMED: only an organiser changes his games, so nothing is stored and the organisers are told once", async ({ request, db }) => {
  const body = `Pia in for ${monthName(EN)} again, just the one game`;
  setMonthlyReaderStub({ bodies: { [body]: signup(EN, 1), "yes just the one": signup(EN, 1) } });
  await say(request, EN, P.pia, body);
  // The join question first (a leaver: his 1 of the 3 left, no new amount), then his answer.
  expect(await dms(db, EN, P.pia)).toEqual([t("en").msu_dm_join_ask({ month: monthName(EN), games: 3, of: 1, price: null })]);
  expect(await dmReply(request, P.pia, "yes just the one")).toMatchObject({ handled: "month-join-yes" });
  expect(await monthRow(db, EN, P.pia)).toMatchObject({ kind: "regular", out: false, gamesCovered: 2, gamesCommitted: null });
  expect(await gamesLines(db, EN, P.rob, P.pia)).toEqual([unrecordedLine(EN, P.pia, 1, "yes just the one")]);
});

test("an organiser's list line about a regular covering 3 ('Lea except the last week' read as 2): stored 2 against HER games", async ({ request, db }) => {
  const body = [`List for ${monthName(SU)}:`, "1. Sue Owner", "2. Lea except the last week"].join("\n");
  setMonthlyReaderStub({ bodies: { [body]: monthList(SU, [line(1, "Sue Owner", { member: "p1" }), line(2, "Lea", { member: "p2", games: 2 })]) } });
  await say(request, SU, P.sue, body);
  expect(readerTurn(body)).toContain(`Games each regular on it covers: ${P.cy.name} (p5) ${SU.games.length}, ${P.lea.name} (p2) 3, ${P.sue.name} (p1) ${SU.games.length}.`);
  expect(await monthRow(db, SU, P.lea)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: 2 });
  await noQuestion(db, SU, P.lea);
});

test("a newcomer's paste in sign-up, her own line 'except the last week': on the month for one fewer than all", async ({ request, db }) => {
  const n = SU.games.length;
  const body = [`List for ${monthName(SU)}:`, "1. Sue Owner", "2. Lea Two", "3. Nia except the last week"].join("\n");
  setMonthlyReaderStub({ bodies: { [body]: monthList(SU, [line(1, "Sue Owner", { member: "p1" }), line(2, "Lea Two", { member: "p2" }), line(3, "Nia", { member: "p3", games: n - 1 })]) } });
  await say(request, SU, P.nia, body);
  expect(await monthRow(db, SU, P.nia)).toMatchObject({ kind: "regular", gamesCovered: n, gamesCommitted: n - 1 });
  await noQuestion(db, SU, P.nia);
});

test("a count on a paste for a regular whose payment is CONFIRMED: not stored; the organisers are told once, quoting HIS line, not the whole list", async ({ request, db }) => {
  const body = [`List for ${monthName(SU)}:`, "1. Sue Owner", "2. Lea Two", "5. Cy Confirmed 2 only"].join("\n");
  setMonthlyReaderStub({ bodies: { [body]: monthList(SU, [line(1, "Sue Owner", { member: "p1" }), line(2, "Lea Two", { member: "p2" }), line(5, "Cy Confirmed", { member: "p5", games: 2 })]) } });
  await say(request, SU, P.cy, body);
  await say(request, SU, P.cy, body);
  expect(await monthRow(db, SU, P.cy)).toMatchObject({ gamesCommitted: null });
  expect(await gamesLines(db, SU, P.sue, P.cy)).toEqual([unrecordedLine(SU, P.cy, 2, "5. Cy Confirmed 2 only")]);
});

test("'smiler N-1 only' re-pasted after a week is cancelled: the same count, so nothing changes and nobody is told; the covers line shows the games there are", async ({ request, db }) => {
  const n = SM.games.length;
  await db.run(`INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt") VALUES ('e2e-lj-sm-cancel', $1, $2, 12, 'CANCELLED', $2, now())`, [
    SM.act,
    SM.games[n - 1].toISOString(),
  ]);
  const body = [`List for ${monthName(SM)}:`, "1. Owner Four", `2. Smi ${n - 1} only`].join("\n");
  setMonthlyReaderStub({ bodies: { [body]: monthList(SM, [line(1, "Owner Four", { member: "p1" }), line(2, "Smi", { member: "p2", games: n - 1 })]) } });
  await say(request, SM, P.smi, body);
  expect(readerTurn(body)).toContain(`${P.smi.name} (p2) ${n - 1}`);
  expect(await monthRow(db, SM, P.smi)).toMatchObject({ gamesCommitted: n - 1 });
  expect(await dms(db, SM, P.smi)).toEqual([]);
  expect(await dms(db, SM, P.own4)).toEqual([]);
});

test("a count for somebody who lands on the bench: kept on his row (no amount) for when he becomes a regular", async ({ request, db }) => {
  const body = `In for ${monthName(FULL)}, just two games`;
  setMonthlyReaderStub({ bodies: { [body]: signup(FULL, 2) } });
  await say(request, FULL, P.ben, body);
  expect(await monthRow(db, FULL, P.ben)).toMatchObject({ kind: "payg", waiting: true, gamesCommitted: 2, amountDuePence: null });
});

test("a bench player's kept count, then his own plain 'IN' when a place opens: his latest word is every game, so the old count is cleared, £22.50", async ({ request, db }) => {
  await db.run(`UPDATE "SquadMonthMember" SET "leftAt" = now() WHERE "monthId" = $1 AND "userId" = $2`, [FULL.month, P.fin.id]);
  const body = `IN FOR ${monthName(FULL).toUpperCase()}`;
  setMonthlyReaderStub({ bodies: { [body]: signup(FULL, 0) } });
  expect(await say(request, FULL, P.bo, body)).toMatchObject({ intent: "month_signup", react: "✅" });
  expect(await monthRow(db, FULL, P.bo)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: null, amountDuePence: 2250 });
});

test("review item 3: an organiser gives two bench players a place on the months page: the count kept while the games left are unchanged (£15); one stored when 4 were left is fitted to the games left now (£7.50) and the organisers are told once", async ({ request, db, page }) => {
  const mine = `In for ${monthName(FULL)}, just two games`;
  setMonthlyReaderStub({ bodies: { [mine]: signup(FULL, 2) } });
  for (const who of [P.bex, P.bry]) {
    await say(request, FULL, who, mine);
    expect(await monthRow(db, FULL, who)).toMatchObject({ kind: "payg", waiting: true, gamesCommitted: 2 });
  }
  // Bry's count was stored when 4 games were left (one has been played since).
  const marker = await db.one<{ id: string; text: string }>(`SELECT id, text FROM "SentNotification" WHERE kind = 'month-bench-games' AND "targetUser" = $1`, [P.bry.id]);
  expect(JSON.parse(marker!.text)).toMatchObject({ games: 2, left: 3 });
  await db.run(`UPDATE "SentNotification" SET text = $2 WHERE id = $1`, [marker!.id, JSON.stringify({ games: 2, left: 4 })]);
  // Two places open; the organiser makes each a regular on /admin/months.
  await db.run(`UPDATE "SquadMonthMember" SET "leftAt" = now() WHERE "monthId" = $1 AND "userId" = ANY($2)`, [FULL.month, [P.fay.id, P.bo.id]]);
  await signInAs(page, P.fay.id, "/admin/months");
  for (const who of [P.bex, P.bry]) {
    await page.locator(`[data-testid="month-member"][data-user="${who.id}"]`).first().getByTestId("member-make-regular").click();
    await expect.poll(async () => (await monthRow(db, FULL, who))?.kind, { timeout: 15_000 }).toBe("regular");
  }
  expect(await monthRow(db, FULL, P.bex)).toMatchObject({ kind: "regular", waiting: false, gamesCovered: 3, gamesCommitted: 2, amountDuePence: 1500 });
  expect(await monthRow(db, FULL, P.bry)).toMatchObject({ kind: "regular", waiting: false, gamesCovered: 3, gamesCommitted: 1, amountDuePence: 750 });
  expect(await gamesLines(db, FULL, P.fay, P.bex)).toEqual([]);
  expect(await gamesLines(db, FULL, P.fay, P.bry)).toEqual([fittedLine(FULL, P.bry, { said: 2, covers: 3, played: 0, stored: 1, words: "" })]);
});

test("one game left, a count of 1 is that one game: every game, £7.50", async ({ request, db }) => {
  const body = `In for ${monthName(ONE)}, just the one game`;
  setMonthlyReaderStub({ bodies: { [body]: signup(ONE, 1) } });
  expect(await say(request, ONE, P.sam, body)).toMatchObject({ intent: "month_signup", react: "✅" });
  expect(await monthRow(db, ONE, P.sam)).toMatchObject({ kind: "regular", gamesCovered: 1, gamesCommitted: null, amountDuePence: 750 });
  expect(await gamesLines(db, ONE, P.own1, P.sam)).toEqual([]);
});

test("an OPEN SQUAD club (no limit, no bench): a late joiner past the old limit is a regular for the 2 he says, £15", async ({ request, db }) => {
  const body = `I'm in for ${monthName(OPEN)} except the last week`;
  setMonthlyReaderStub({ bodies: { [body]: signup(OPEN, 2) } });
  expect(await say(request, OPEN, P.oli, body)).toMatchObject({ intent: "month_signup", react: "✅" });
  expect(await monthRow(db, OPEN, P.oli)).toMatchObject({ kind: "regular", waiting: false, gamesCovered: 3, gamesCommitted: 2, amountDuePence: 1500 });
});

test("a month with NO price: the count is stored, and no amount is made up", async ({ request, db }) => {
  const body = `I'm in for ${monthName(FREE)} except the last week`;
  setMonthlyReaderStub({ bodies: { [body]: signup(FREE, 2) } });
  expect(await say(request, FREE, P.fen, body)).toMatchObject({ intent: "month_signup", react: "✅" });
  expect(await monthRow(db, FREE, P.fen)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: 2, amountDuePence: null });
});

test("games already played: a joiner's count is against the games left, and the reader sees the played ones", async ({ request, db }) => {
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

test("a full-month regular who has played P games types '1 game': stored is P, the games he played (never fewer); the organisers are told", async ({ request, db }) => {
  test.skip(!PLAYED || leftOf(PLAYED).length < 2, "needs a month this calendar month with two games played and two still to play");
  const c = PLAYED!;
  const [covers, played] = [c.games.length, pastOf(c).length];
  const body = `In for ${monthName(c)}, 1 game`;
  setMonthlyReaderStub({ bodies: { [body]: signup(c, 1) } });
  expect(await say(request, c, P.rex, body)).toMatchObject({ intent: "month_signup", react: "✅" });
  expect(await monthRow(db, c, P.rex)).toMatchObject({ gamesCovered: covers, gamesCommitted: played, amountDuePence: played * SHARE });
  expect(await gamesLines(db, c, P.own2, P.rex)).toEqual([fittedLine(c, P.rex, { said: 1, covers, played, stored: played, words: body })]);
  await noQuestion(db, c, P.rex);
});

test("a count equal to the games he has played, with games left: stored as said (he is never charged for one he did not commit to)", async ({ request, db }) => {
  test.skip(!PLAYED || leftOf(PLAYED).length < 2, "needs a month this calendar month with two games played and two still to play");
  const c = PLAYED!;
  const played = pastOf(c).length;
  const body = `Rae in for ${monthName(c)}, ${played} games`;
  setMonthlyReaderStub({ bodies: { [body]: signup(c, played) } });
  expect(await say(request, c, P.rae, body)).toMatchObject({ intent: "month_signup", react: "✅" });
  expect(await monthRow(db, c, P.rae)).toMatchObject({ gamesCommitted: played, amountDuePence: played * SHARE });
  expect(await gamesLines(db, c, P.own2, P.rae)).toEqual([]);
});

test("review item 1: a leaver who said he paid (\"2 only\", £15), played game 1, left and missed game 2, answers a plain yes: the games he played plus the games left, never every game, and his count is never wiped", async ({ request, db }) => {
  test.skip(!PLAYED || leftOf(PLAYED).length < 2, "needs a month this calendar month with two games played and two still to play");
  const c = PLAYED!;
  const [n, left] = [c.games.length, leftOf(c).length];
  const body = `IN FOR ${monthName(c).toUpperCase()} again`;
  setMonthlyReaderStub({ bodies: { [body]: signup(c, 0), yes: signup(c, 0) } });
  await say(request, c, P.pip, body);
  expect(await dmReply(request, P.pip, "yes")).toMatchObject({ handled: "month-join-yes" });
  const want = 1 + left >= n ? null : 1 + left;
  expect(await monthRow(db, c, P.pip)).toMatchObject({ kind: "regular", out: false, gamesCovered: n, gamesCommitted: want, amountDuePence: (want ?? n) * SHARE });
  // Never the whole month he did not commit to.
  expect((await monthRow(db, c, P.pip))!.gamesCommitted).not.toBeNull();
});

test("Mia missed a played game: her count of the games she played plus one is stored as read", async ({ request, db }) => {
  test.skip(!PLAYED || leftOf(PLAYED).length < 2, "needs a month this calendar month with two games played and two still to play");
  const c = PLAYED!;
  const want = pastOf(c).length - 1 + 1;
  const body = `Mia in for ${monthName(c)}, ${want} games`;
  setMonthlyReaderStub({ bodies: { [body]: signup(c, want) } });
  expect(await say(request, c, P.mia, body)).toMatchObject({ react: "✅" });
  expect(await monthRow(db, c, P.mia)).toMatchObject({ gamesCommitted: want, amountDuePence: want * SHARE });
});

test("no game left: a newcomer's count gives no game to charge", async ({ request, db }) => {
  test.skip(!NONE_LEFT, "needs a game already played this calendar month");
  const c = NONE_LEFT!;
  const body = `I'm in for ${monthName(c)} except the last week`;
  setMonthlyReaderStub({ bodies: { [body]: signup(c, 2) } });
  await say(request, c, P.zoe, body);
  const row = await monthRow(db, c, P.zoe);
  // Whatever the row, nothing is owed for games that were never his.
  expect(row?.amountDuePence ?? 0).toBe(0);
  expect(row?.gamesCovered ?? 0).toBe(0);
});

test("an organiser's WEEK paste with his own line 'except the last week': his 2 stored, ✅, nothing asked", async ({ request, db }) => {
  await poll(request, WK);
  const seeded = await db.one<{ rollingSeededAt: Date | null }>(`SELECT "rollingSeededAt" FROM "Match" WHERE id = $1`, [`${WK.org}-match`]);
  test.skip(!seeded?.rollingSeededAt, "the week was not seeded by the poll");
  const day = Number(formatInTimeZone(WK.games[0], LONDON, "d"));
  const body = [`List for ${monthName(WK)} ${day}:`, "1. Wes Owner except the last week"].join("\n");
  const weekList = { ...monthList(WK, [line(1, "Wes Owner", { member: "p1", games: 2 })]), listOf: "week", gameDay: day };
  setMonthlyReaderStub({ bodies: { [body]: weekList } });
  await say(request, WK, P.wes, body);
  expect(await monthRow(db, WK, P.wes)).toMatchObject({ gamesCovered: 3, gamesCommitted: 2, amountDuePence: 1500 });
  await noQuestion(db, WK, P.wes);
});

test("Turkish: 'son hafta hariç' read as 2 is stored; a count above her games is every game and the organisers are told in Turkish", async ({ request, db }) => {
  const a = `${monthName(TR)} varım son hafta hariç`;
  const b = `${monthName(TR)} varım, 4 maç`;
  setMonthlyReaderStub({ bodies: { [a]: signup(TR, 2), [b]: signup(TR, 4) } });
  expect(await say(request, TR, P.ayse, a)).toMatchObject({ intent: "month_signup", react: "✅" });
  expect(await monthRow(db, TR, P.ayse)).toMatchObject({ kind: "regular", gamesCovered: 3, gamesCommitted: 2 });
  await say(request, TR, P.ayse, b);
  expect(await monthRow(db, TR, P.ayse)).toMatchObject({ gamesCommitted: null });
  expect(await gamesLines(db, TR, P.emre, P.ayse)).toEqual([fittedLine(TR, P.ayse, { said: 4, covers: 3, played: 0, stored: 3, words: b })]);
  await noQuestion(db, TR, P.ayse);
});
