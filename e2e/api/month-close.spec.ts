/**
 * MONTHLY SQUAD, SLICE 6: CANCELLED WEEKS, LEAVING AND JOINING PART-WAY,
 * AND THE MONTH CLOSE, END TO END AGAINST POSTGRES.
 *
 * MDs/monthly-squad-plan-2026-10-05.md, sections 4.4 and 7. No model is
 * called anywhere in this file: the credits, the close and the summary are
 * fixed code, and "IN FOR <MONTH>" is read from a fixed vocabulary.
 *
 * One monthly club ("Vets MNF": 6 places, 4 regulars, a PAYG player) runs
 * NEXT calendar month through the real routes: /api/whatsapp/due-posts on
 * a pinned clock (x-test-now) and /api/whatsapp/analyze on the real one.
 * The month was started by its organiser (plan 4.5), so it counts as
 * under way on the real clock too.
 *
 *   1. a called-off game credits every regular charged for it, ONCE: a
 *      regular who paid keeps the credit, one who has not has it taken off
 *      this month at once. Polling again, and two polls at the same
 *      moment, write nothing more;
 *   2. restoring the game takes the credits back; cancelling it again
 *      writes them again; a credit an organiser removed is never rewritten;
 *   3. a regular who paid and left the group is owed the games left. The
 *      organisers are told once. His row and his payment are untouched;
 *   4. "IN FOR <MONTH>" after the month has started joins it for the games
 *      left, with the amount, and the game called off before he joined is
 *      not credited to him;
 *   5. the morning after the last game the month is closed ONCE and the
 *      summary goes to the organisers once, with the worked numbers;
 *   6. a closed month is frozen, and its last game still gets no payment
 *      poll;
 *   7. nothing dated before a mid-month start is touched, and a dormant
 *      club is left alone;
 *   8. a WEEKLY club (the fixture club, Sutton FC's shape) is untouched.
 */
import { formatInTimeZone } from "date-fns-tz";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { engineOn } from "../helpers/stub";
import { E2E } from "../helpers/env";
import { ORG_ID } from "../helpers/constants";
import { testDb, type TestDb } from "../helpers/test-db";
import { londonDateTimeToUtc } from "@/lib/london-time";
import { buildLeaverNotice, buildMidMonthJoinDm, buildMonthSummaryLines } from "@/lib/month-close-copy";
import { pounds } from "@/lib/month-payment-copy";
import { summariseMonth } from "@/lib/month-close-rules";
import { monthKickoffs, nextMonthStart } from "@/lib/month-signup-rules";
import { londonMonthStart } from "@/lib/squad-month-rules";

test.describe.configure({ mode: "serial" });

const ORG = "e2e-mc-org";
const GROUP = "e2e-monthclose@g.us";
const ACT = "e2e-mc-act";
const MONTH = "e2e-mc-month";
const ORG2 = "e2e-mc2-org";
const GROUP2 = "e2e-monthclose2@g.us";
const ACT2 = "e2e-mc2-act";
const MONTH2 = "e2e-mc2-month";

const LONDON = "Europe/London";
const NEXT = nextMonthStart(londonMonthStart(new Date()));
const MONTH_DATE = new Date(`${NEXT}T12:00:00.000Z`);
const MONTH_NAME = formatInTimeZone(MONTH_DATE, LONDON, "MMMM");
/** Mondays, 20:00 London. */
const G = monthKickoffs(NEXT, 1, "20:00");
const N = G.length;
/** Wednesdays, 20:00 London (the second club). */
const W = monthKickoffs(NEXT, 3, "20:00");
const SHARE = 750;
const matchId = (i: number) => `e2e-mc-match-${i}`;
const match2Id = (i: number) => `e2e-mc2-match-${i}`;
/** The game that is called off. */
const OFF = 2;

/** A London wall-clock moment `days` after a kick-off's day. */
function at(kickoff: Date, days: number, time: string): Date {
  const d = new Date(`${formatInTimeZone(kickoff, LONDON, "yyyy-MM-dd")}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return londonDateTimeToUtc(d.toISOString().slice(0, 10), time);
}

const P = {
  rob: { id: "e2e-mc-rob", name: "Rob Hale", phone: "+447700950001" },
  adam: { id: "e2e-mc-adam", name: "Adam Admin", phone: "+447700950002" },
  alex: { id: "e2e-mc-alex", name: "Alex Carter", phone: "+447700950003" },
  bilal: { id: "e2e-mc-bilal", name: "Bilal Aydin", phone: "+447700950004" },
  carl: { id: "e2e-mc-carl", name: "Carl Young", phone: "+447700950005" },
  dev: { id: "e2e-mc-dev", name: "Dev Patel", phone: "+447700950006" },
  omar: { id: "e2e-mc-omar", name: "Omar Khan", phone: "+447700950007" },
  tom: { id: "e2e-mc-tom", name: "Tom Reed", phone: "+447700950008" },
  wes: { id: "e2e-mc-wes", name: "Wes Lane", phone: "+447700950009" },
} as const;
type Person = (typeof P)[keyof typeof P];
const digits = (phone: string) => phone.replace(/^\+/, "");

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
let seq = 0;
const msgId = () => `e2e-mc-${Date.now()}-${++seq}`;

interface Instruction {
  kind: string;
  key: string;
  text?: string;
}

async function poll(request: APIRequestContext, now: Date, groupId = GROUP): Promise<Instruction[]> {
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(groupId)}`, {
    headers: { ...KEY, "x-test-now": now.toISOString() },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).instructions as Instruction[];
}

/** A group message, the way the Pi forwards it. */
async function say(request: APIRequestContext, who: Person, body: string): Promise<{ handledBy: string; intent: string | null; react: string | null }> {
  const waMessageId = msgId();
  const res = await request.post("/api/whatsapp/analyze", {
    headers: KEY,
    data: { groupId: GROUP, messages: [{ waMessageId, body, authorPhone: digits(who.phone), authorName: who.name, timestamp: new Date().toISOString() }] },
  });
  expect(res.status(), await res.text()).toBe(200);
  const json = (await res.json()) as { results?: Array<{ waMessageId: string; handledBy: string; intent: string | null; react: string | null }> };
  return (json.results ?? []).find((r) => r.waMessageId === waMessageId) ?? { handledBy: "none", intent: null, react: null };
}

interface CreditRow {
  userId: string;
  reason: string;
  earnedMatchId: string | null;
  appliedMonthId: string | null;
  voidedAt: Date | null;
  voidedById: string | null;
}
const credits = (db: TestDb, org = ORG) =>
  db.all<CreditRow>(
    `SELECT "userId", reason, "earnedMatchId", "appliedMonthId", "voidedAt", "voidedById" FROM "SquadCredit" WHERE "orgId" = $1 ORDER BY "createdAt", "userId"`,
    [org],
  );
const live = (rows: CreditRow[], reason: string) => rows.filter((c) => c.reason === reason && c.voidedAt === null);
const names = (rows: CreditRow[]) => rows.map((c) => c.userId.replace("e2e-mc-", "")).sort();

const member = (db: TestDb, who: Person, month = MONTH) =>
  db.one<{ kind: string; slot: number | null; gamesCovered: number; creditsApplied: number; amountDuePence: number | null; paidAt: Date | null; leftAt: Date | null }>(
    `SELECT kind, slot, "gamesCovered", "creditsApplied", "amountDuePence", "paidAt", "leftAt" FROM "SquadMonthMember" WHERE "monthId" = $1 AND "userId" = $2`,
    [month, who.id],
  );

const dms = (db: TestDb, who: { phone: string }, org = ORG) =>
  db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2 ORDER BY "createdAt"`, [org, digits(who.phone)]);

async function person(db: TestDb, p: { id: string; name: string; phone: string }, org: string, role = "PLAYER") {
  await db.run(`INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [p.id, `${p.id}@e2e.test`, p.name, p.phone]);
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1, $2, $3, $4::"MemberRole")`, [`mem-${org}-${p.id}`, p.id, org, role]);
}

async function club(db: TestDb, o: { org: string; group: string; act: string; sport: string; dayOfWeek: number }) {
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled", "squadMode", "paygPricePence",
                                 "adminChannelMode", language, "updatedAt")
     VALUES ($1, 'Vets MNF', $1, $2, $3, true, 'monthly', 800, 'each-admin', 'en', now())`,
    [o.org, `${o.org}-invite`, o.group],
  );
  await db.run(
    `INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt")
     VALUES ($1, $2, 'Basketball', 3, ARRAY['G','F'], ARRAY['Red','Yellow'], now())`,
    [o.sport, o.org],
  );
  await db.run(
    `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "updatedAt")
     VALUES ($1, $2, $3, 'Monday 7-a-side', $4, '20:00', 'Goals', 5, now())`,
    [o.act, o.org, o.sport, o.dayOfWeek],
  );
}

async function game(db: TestDb, id: string, act: string, kickoff: Date) {
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt") VALUES ($1, $2, $3, 6, 'UPCOMING', $4, now())`,
    [id, act, kickoff.toISOString(), new Date(kickoff.getTime() - 5 * 60 * 60 * 1000).toISOString()],
  );
}

const setStatus = (db: TestDb, id: string, status: string) =>
  db.run(`UPDATE "Match" SET status = $2::"MatchStatus", "updatedAt" = $3 WHERE id = $1`, [id, status, new Date().toISOString()]);

test.beforeAll(async () => {
  resetDb();
  const db = testDb();

  // ── Club 1: Mondays. The month was started by its organiser an hour ago.
  await club(db, { org: ORG, group: GROUP, act: ACT, sport: "e2e-mc-sport", dayOfWeek: 1 });
  await person(db, P.rob, ORG, "OWNER");
  await person(db, P.adam, ORG, "ADMIN");
  for (const p of [P.alex, P.bilal, P.carl, P.dev, P.omar, P.tom]) await person(db, p, ORG);
  await db.run(`UPDATE "Organisation" SET "paymentHolderId" = $2 WHERE id = $1`, [ORG, P.rob.id]);
  for (const [i, k] of G.entries()) await game(db, matchId(i), ACT, k);
  await db.run(
    `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "sharePerGamePence", "pricedAt", "payByAt",
                               "summarySentAt", "startedMidMonthAt", "startedByUserId", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4::date, 'running', $5, $6, $8, $9, $9, $8, $7, $8, now())`,
    // Instants from this process, not the database's now(): the columns
    // carry no time zone.
    [MONTH, ORG, ACT, NEXT, N, SHARE, P.rob.id, new Date(Date.now() - 60 * 60 * 1000).toISOString(), new Date(Date.now() - 30 * 60 * 1000).toISOString()],
  );
  const due = SHARE * N;
  // slot, paid: "confirmed" | "claimed" | "none".
  const rows: Array<[Person, string, number | null, string]> = [
    [P.alex, "regular", 1, "confirmed"],
    [P.bilal, "regular", 2, "claimed"],
    [P.carl, "regular", 3, "none"],
    [P.dev, "regular", 4, "confirmed"],
    [P.omar, "payg", null, "none"],
  ];
  for (const [p, kind, slot, paid] of rows) {
    const regular = kind === "regular";
    await db.run(
      `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, "gamesCovered", "amountDuePence", "paidClaimedAt", "paidClaimSource",
                                       "paidAt", "paidAmountPence", "paidConfirmedByUserId", source, "joinedAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'seed-tick', now() - interval '1 day', now())`,
      [
        `${MONTH}-${p.id}`,
        MONTH,
        p.id,
        kind,
        slot,
        regular ? N : 0,
        regular ? due : null,
        paid === "claimed" ? new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() : null,
        paid === "claimed" ? "dm" : null,
        paid === "confirmed" ? new Date().toISOString() : null,
        paid === "confirmed" ? due : null,
        paid === "confirmed" ? P.rob.id : null,
      ],
    );
  }

  // ── Club 2: Wednesdays. Its month starts here the day before its SECOND
  //    game, so the first game is not the month's business.
  await club(db, { org: ORG2, group: GROUP2, act: ACT2, sport: "e2e-mc2-sport", dayOfWeek: 3 });
  await person(db, P.wes, ORG2, "OWNER");
  for (const [i, k] of W.entries()) await game(db, match2Id(i), ACT2, k);
  await db.run(
    `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "gamesPlayedBeforeStart", "startedMidMonthAt",
                               "startedByUserId", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4::date, 'running', $5, 1, $6, $7, $8, now())`,
    [MONTH2, ORG2, ACT2, NEXT, W.length, at(W[1], -1, "09:00").toISOString(), P.wes.id, new Date(Date.now() - 60 * 60 * 1000).toISOString()],
  );
  await db.run(
    `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, "gamesCovered", "paidAt", "paidAmountPence", "paidConfirmedByUserId", source,
                                     "joinedAt", "updatedAt")
     VALUES ($1, $2, $3, 'regular', 1, $4, now(), 3000, $3, 'seed-tick', now() - interval '1 day', now())`,
    [`${MONTH2}-${P.wes.id}`, MONTH2, P.wes.id, W.length],
  );
  engineOn({});
});
test.afterAll(() => resetDb());

/** Two days before the first game, hour by hour: each poll its own hour. */
const before = (hour: number, minute = 5) => at(G[0], -2, `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
/** The day after the first game. */
const after = (hour: number, minute = 5) => at(G[0], 1, `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);

test("1. a called-off game credits every regular charged for it, once", async ({ request, db }) => {
  await setStatus(db, matchId(OFF), "CANCELLED");
  await poll(request, before(10));

  const now = await credits(db);
  expect(now.every((c) => c.reason === "cancelled-week" && c.earnedMatchId === matchId(OFF))).toBe(true);
  // The four regulars. Never the PAYG player, never somebody who is not on the month.
  expect(names(live(now, "cancelled-week"))).toEqual(["alex", "bilal", "carl", "dev"]);
  // Paid, or says so: the credit is kept for a later month.
  for (const p of [P.alex, P.bilal, P.dev]) {
    expect(now.find((c) => c.userId === p.id)!.appliedMonthId).toBeNull();
    expect(await member(db, p)).toMatchObject({ creditsApplied: 0, amountDuePence: SHARE * N });
  }
  // Not paid yet: it comes off this month at once. He is never asked to
  // pay for a game that is not played.
  expect(now.find((c) => c.userId === P.carl.id)!.appliedMonthId).toBe(MONTH);
  expect(await member(db, P.carl)).toMatchObject({ creditsApplied: 1, amountDuePence: SHARE * (N - 1), gamesCovered: N });

  // The same hour again, then two polls at the same moment in the next
  // one: nothing more is written.
  await poll(request, before(10, 30));
  await Promise.all([poll(request, before(11)), poll(request, before(11))]);
  expect(await credits(db)).toHaveLength(4);
  expect(await member(db, P.carl)).toMatchObject({ creditsApplied: 1, amountDuePence: SHARE * (N - 1) });
});

test("2. restoring the game takes the credits back, cancelling again writes them again, and a removed credit is never rewritten", async ({ request, db }) => {
  await setStatus(db, matchId(OFF), "UPCOMING");
  await poll(request, before(12));
  let now = await credits(db);
  expect(live(now, "cancelled-week")).toEqual([]);
  // Taken back by MatchTime, not by a person: nobody's name is on it.
  expect(now.every((c) => c.voidedAt !== null && c.voidedById === null)).toBe(true);
  // The game is back on what Carl is asked for.
  expect(await member(db, P.carl)).toMatchObject({ creditsApplied: 0, amountDuePence: SHARE * N });

  await setStatus(db, matchId(OFF), "CANCELLED");
  await poll(request, before(13));
  now = await credits(db);
  expect(now).toHaveLength(8);
  expect(names(live(now, "cancelled-week"))).toEqual(["alex", "bilal", "carl", "dev"]);
  expect(await member(db, P.carl)).toMatchObject({ creditsApplied: 1, amountDuePence: SHARE * (N - 1) });

  // An organiser removes Alex's. It is not written again, on any later poll.
  await db.run(
    `UPDATE "SquadCredit" SET "voidedAt" = now(), "voidedById" = $2, "voidNote" = 'he played another night instead'
      WHERE "orgId" = $1 AND "userId" = $3 AND "voidedAt" IS NULL`,
    [ORG, P.rob.id, P.alex.id],
  );
  await poll(request, before(14));
  await poll(request, before(15));
  now = await credits(db);
  expect(now).toHaveLength(8);
  expect(names(live(now, "cancelled-week"))).toEqual(["bilal", "carl", "dev"]);
});

test("3. a regular who paid and left is owed the games left: the organisers are told once, and his payment is untouched", async ({ request, db }) => {
  // The first game is played, and Dev leaves the group the morning after.
  await setStatus(db, matchId(0), "COMPLETED");
  await db.run(`UPDATE "Membership" SET "leftAt" = $3 WHERE "orgId" = $1 AND "userId" = $2`, [ORG, P.dev.id, after(9, 0).toISOString()]);
  await poll(request, after(15));

  const left = live(await credits(db), "left-mid-month").filter((c) => c.userId === P.dev.id);
  // One for every game still to play when he left. Not the game already
  // played, and not the one called off: he holds that credit already.
  const expected = G.map((_, i) => i).filter((i) => i > 0 && i !== OFF);
  expect(left.map((c) => c.earnedMatchId).sort()).toEqual(expected.map(matchId).sort());

  // LEAVING DESTROYS NOTHING: his row, his payment and his earlier credit stand.
  expect(await member(db, P.dev)).toMatchObject({ kind: "regular", leftAt: null, amountDuePence: SHARE * N });
  expect((await member(db, P.dev))!.paidAt).not.toBeNull();
  expect(names(live(await credits(db), "cancelled-week"))).toEqual(["bilal", "carl", "dev"]);

  // The organisers are told what he is owed, and that MatchTime refunds nobody.
  const owedGames = expected.length + 1;
  const notice = buildLeaverNotice({ name: P.dev.name, monthDate: MONTH_DATE, games: owedGames, pence: SHARE * owedGames, link: "", lang: "en" });
  for (const admin of [P.rob, P.adam]) {
    const got = (await dms(db, admin)).filter((d) => d.text.includes("has left"));
    expect(got).toHaveLength(1);
    expect(got[0].text.startsWith(notice)).toBe(true);
    expect(got[0].text).toContain("MatchTime refunds nobody.");
  }
  // Dev himself is sent nothing, and nothing is refunded by itself.
  expect(await dms(db, P.dev)).toEqual([]);
  expect(await db.count(`SELECT COUNT(*) FROM "SquadMonthMember" WHERE "monthId" = $1 AND "refundedPence" > 0`, [MONTH])).toBe(0);

  // Later polls: nothing more is written, and nobody is told again.
  await poll(request, after(16));
  expect(live(await credits(db), "left-mid-month")).toHaveLength(expected.length);
  expect((await dms(db, P.rob)).filter((d) => d.text.includes("has left"))).toHaveLength(1);

  // ONE LIVE CREDIT PER PLAYER PER GAME. Leaving does not take him off a
  // squad he was on, so an organiser now drops him from the next game. He
  // already holds that game's credit (he left): no "missed" one beside it.
  await db.run(
    `WITH a AS (
       INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "paymentMethod", "updatedAt")
       VALUES ('e2e-mc-att-dev-next', $1, $2, 'DROPPED', 4, 'monthly', now()) RETURNING "matchId", "userId", status, position
     )
     INSERT INTO "AttendanceEvent" (id, "matchId", "userId", "orgId", "toStatus", "toPosition", cause, "actorKind")
     SELECT 'e2e-mc-ev-dev-next', "matchId", "userId", $3, status, position, 'test-fixture', 'system' FROM a`,
    [matchId(1), P.dev.id, ORG],
  );
  await poll(request, after(16, 20));
  await poll(request, after(16, 40));
  const forNext = (await credits(db)).filter((c) => c.userId === P.dev.id && c.earnedMatchId === matchId(1) && c.voidedAt === null);
  expect(forNext.map((c) => c.reason)).toEqual(["left-mid-month"]);
  // The database refuses a second one outright, whoever writes it.
  await expect(
    db.run(`INSERT INTO "SquadCredit" (id, "orgId", "userId", games, reason, "earnedMatchId") VALUES ('e2e-mc-dup', $1, $2, 1, 'missed', $3)`, [ORG, P.dev.id, matchId(1)]),
  ).rejects.toThrow(/SquadCredit_one_live_per_game/);
});

test("4. \"IN FOR <MONTH>\" after the month has started joins it for the games left", async ({ request, db }) => {
  // Out, or pay-as-you-go, in a month under way is still the organiser's.
  await say(request, P.alex, `OUT FOR ${MONTH_NAME.toUpperCase()}`);
  expect(await member(db, P.alex)).toMatchObject({ kind: "regular", leftAt: null, slot: 1 });
  await say(request, P.tom, `PAYG FOR ${MONTH_NAME.toUpperCase()}`);
  expect(await member(db, P.tom)).toBeNull();

  const res = await say(request, P.tom, `IN FOR ${MONTH_NAME.toUpperCase()}`);
  expect(res).toMatchObject({ handledBy: "fast-path", intent: "month_signup", react: "✅" });
  // A regular from the next game: charged for the games that are left
  // (the calendar minus the week that is off), at the month's share.
  const left = N - 1;
  // (Dev has left the group, so his number, 4, is free: the existing rule.)
  expect(await member(db, P.tom)).toMatchObject({ kind: "regular", slot: 4, gamesCovered: left, creditsApplied: 0, amountDuePence: SHARE * left, paidAt: null });

  // He is told the games and the amount, once; so are the organisers.
  expect((await dms(db, P.tom)).map((d) => d.text)).toEqual([
    buildMidMonthJoinDm({ name: P.tom.name, monthDate: MONTH_DATE, games: left, amountDuePence: SHARE * left, collectorName: P.rob.name, lang: "en" }),
  ]);
  for (const admin of [P.rob, P.adam]) {
    expect((await dms(db, admin)).filter((d) => d.text.startsWith(`📋 ${P.tom.name} joined ${MONTH_NAME} part-way: ${left} games, ${pounds(SHARE * left)} to pay.`))).toHaveLength(1);
  }
  // Saying it again changes nothing and sends nothing.
  await say(request, P.tom, `IN FOR ${MONTH_NAME.toUpperCase()}`);
  expect(await dms(db, P.tom)).toHaveLength(1);

  // The game was called off BEFORE he joined: his games were counted
  // without it, so he gets no credit for it. When it was called off is on
  // record: touching the cancelled match's row afterwards changes nothing.
  await db.run(`UPDATE "Match" SET "updatedAt" = $2 WHERE id = $1`, [matchId(OFF), new Date(Date.now() + 60_000).toISOString()]);
  await poll(request, after(17));
  expect((await credits(db)).filter((c) => c.userId === P.tom.id)).toEqual([]);
  expect(await member(db, P.tom)).toMatchObject({ creditsApplied: 0, amountDuePence: SHARE * left });
});

/** The morning after the month's last game. */
const closing = (hour: number, minute = 5) => at(G[N - 1], 1, `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
const summaries = async (db: TestDb, who: { phone: string }) => (await dms(db, who)).filter((d) => d.text.startsWith(`📒 ${MONTH_NAME} summary (`));

test("5. the morning after the last game the month is closed once, and the summary goes out once", async ({ request, db }) => {
  // The rest of the month is played. Omar played the second game pay-as-you-go.
  for (let i = 1; i < N; i++) if (i !== OFF) await setStatus(db, matchId(i), "COMPLETED");
  await db.run(`UPDATE "Match" SET "feePerPlayer" = 8 WHERE id = $1`, [matchId(1)]);
  await db.run(
    `WITH a AS (
       INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt")
       VALUES ('e2e-mc-att-omar', $1, $2, 'CONFIRMED', 6, now()) RETURNING "matchId", "userId", status, position
     )
     INSERT INTO "AttendanceEvent" (id, "matchId", "userId", "orgId", "toStatus", "toPosition", cause, "actorKind")
     SELECT 'e2e-mc-ev-omar', "matchId", "userId", $3, status, position, 'test-fixture', 'system' FROM a`,
    [matchId(1), P.omar.id, ORG],
  );

  // Not at night, and not before 08:00 the morning after.
  await poll(request, at(G[N - 1], 0, "23:05"));
  await poll(request, closing(7));
  expect((await db.one<{ status: string }>(`SELECT status FROM "SquadMonth" WHERE id = $1`, [MONTH]))!.status).toBe("running");

  // Two polls at the same moment: one close, one summary.
  await Promise.all([poll(request, closing(8)), poll(request, closing(8))]);
  const month = await db.one<{ status: string; closedAt: Date | null }>(`SELECT status, "closedAt" FROM "SquadMonth" WHERE id = $1`, [MONTH]);
  expect(month!.status).toBe("closed");
  expect(month!.closedAt).not.toBeNull();

  // THE NUMBERS, against the month as it was played.
  const left = N - 1;
  const expected = buildMonthSummaryLines({
    monthDate: MONTH_DATE,
    lang: "en",
    summary: summariseMonth({
      gamesPlayed: N - 1,
      regulars: [
        { name: P.alex.name, amountDuePence: SHARE * N, paid: "confirmed", paidPence: SHARE * N, refundedPence: 0 },
        { name: P.bilal.name, amountDuePence: SHARE * N, paid: "claimed", paidPence: null, refundedPence: 0 },
        { name: P.carl.name, amountDuePence: SHARE * left, paid: "none", paidPence: null, refundedPence: 0 },
        { name: P.tom.name, amountDuePence: SHARE * left, paid: "none", paidPence: null, refundedPence: 0 },
      ],
      payg: [{ name: P.omar.name, date: G[1], feePence: 800, paid: false }],
      // Bilal's credit for the week that was off. Alex's was removed, Carl's
      // came off this month, and what Dev holds is owed to him as money.
      carried: [{ name: P.bilal.name, games: 1 }],
      creditsUsed: 1,
      leavers: [{ name: P.dev.name, games: left, pence: SHARE * left }],
    }),
  });
  for (const admin of [P.rob, P.adam]) {
    const got = await summaries(db, admin);
    expect(got).toHaveLength(1);
    expect(got[0].text.split("\n").slice(0, expected.length)).toEqual(expected);
    expect(got[0].text.split("\n").at(-1)).toMatch(/^The full month: http/);
  }
  // Sanity on the worked lines themselves.
  expect(expected).toContain(`Says paid, not confirmed: 1 (${P.bilal.name} ${pounds(SHARE * N)}).`);
  expect(expected).toContain("PAYG: 1 game played, £8 (0 paid).");
  expect(expected).toContain(`Credits carried to a later month: 1 game (${P.bilal.name}).`);
  // Nobody but the organisers is sent it.
  expect(await summaries(db, P.alex)).toEqual([]);

  // The next hour, and the next day: still closed once, still one summary.
  await poll(request, closing(9));
  await poll(request, at(G[N - 1], 2, "10:05"));
  expect(await summaries(db, P.rob)).toHaveLength(1);
});

test("6. a closed month is frozen, and its last game still gets no payment poll", async ({ request, db }) => {
  const before = await credits(db);
  // After the close an organiser takes Bilal off the last game. In a
  // running month that is a credit; in a closed one nothing is written.
  await db.run(
    `WITH a AS (
       INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "paymentMethod", "updatedAt")
       VALUES ('e2e-mc-att-bilal-last', $1, $2, 'DROPPED', 2, 'monthly', now()) RETURNING "matchId", "userId", status, position
     )
     INSERT INTO "AttendanceEvent" (id, "matchId", "userId", "orgId", "toStatus", "toPosition", cause, "actorKind")
     SELECT 'e2e-mc-ev-bilal-last', "matchId", "userId", $3, status, position, 'test-fixture', 'system' FROM a`,
    [matchId(N - 1), P.bilal.id, ORG],
  );
  // The club tracks payments, so a weekly club's played game WOULD get the
  // payment poll now.
  await db.run(`UPDATE "Organisation" SET "paymentTrackingEnabled" = true WHERE id = $1`, [ORG]);
  const instructions = await poll(request, closing(12));
  await poll(request, closing(13));
  expect(await credits(db)).toEqual(before);

  // The scheduler still knows the month's games were a month's: no payment
  // poll asking the regulars, who paid for the month, to pay again.
  const monthMatches = G.map((_, i) => matchId(i));
  expect(instructions.filter((i) => monthMatches.some((id) => i.key.startsWith(`${id}:payment-poll`)))).toEqual([]);
});

test("6b. a \"PAID ALL\" for the closed month's last list is answered, and marks nobody", async ({ request, db }) => {
  // Bilal's claim was on the collector's daily list while the month ran.
  expect(await db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key LIKE $1`, [`org-${ORG}:mpy:digest:${MONTH}:%`])).toBeGreaterThan(0);
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: KEY,
    data: { phone: digits(P.rob.phone), body: "PAID ALL", waMessageId: msgId(), authorName: P.rob.name },
  });
  expect(res.status(), await res.text()).toBe(200);
  expect(((await res.json()) as { handled?: string }).handled).toBe("month-paid-closed");
  const answer = (await dms(db, P.rob)).at(-1)!.text;
  expect(answer.startsWith(`${MONTH_NAME} is closed, so I marked nobody. Confirm a payment that arrived late here: http`)).toBe(true);
  expect(answer).toContain(`/month/collect?month=${NEXT}`);
  // Nobody was confirmed by it, in this month or any other.
  expect(await db.count(`SELECT COUNT(*) FROM "SquadMonthMember" m JOIN "SquadMonth" s ON s.id = m."monthId" WHERE s."orgId" = $1 AND m."userId" = $2 AND m."paidAt" IS NOT NULL`, [ORG, P.bilal.id])).toBe(0);
});

test("6c. a summary that did not go out after the close is sent by a later sweep, never lost", async ({ request, db }) => {
  // As if the send had failed after the month was closed: the summary's
  // own claim is released, and the queued messages never existed.
  await db.run(`DELETE FROM "SentNotification" WHERE key = $1`, [`org-${ORG}:mcl:summary:${MONTH}`]);
  await db.run(`DELETE FROM "BotJob" WHERE "orgId" = $1 AND text LIKE $2`, [ORG, `📒 ${MONTH_NAME} summary (%`]);
  expect(await summaries(db, P.rob)).toEqual([]);
  await poll(request, closing(16));
  expect(await summaries(db, P.rob)).toHaveLength(1);
  expect(await summaries(db, P.adam)).toHaveLength(1);
  // And once it has gone, not again.
  await poll(request, closing(17));
  expect(await summaries(db, P.rob)).toHaveLength(1);
  expect((await db.one<{ status: string }>(`SELECT status FROM "SquadMonth" WHERE id = $1`, [MONTH]))!.status).toBe("closed");
});

test("7. nothing dated before a mid-month start is touched, and a dormant club is left alone", async ({ request, db }) => {
  // The first Wednesday is BEFORE the month started here; the third is after.
  await setStatus(db, match2Id(0), "CANCELLED");
  await setStatus(db, match2Id(2), "CANCELLED");
  await poll(request, at(W[1], -1, "10:05"), GROUP2);
  let now = await credits(db, ORG2);
  expect(now.map((c) => [c.userId, c.reason, c.earnedMatchId])).toEqual([[P.wes.id, "cancelled-week", match2Id(2)]]);

  // Dormant: another game is called off, and nothing is written for it.
  await setStatus(db, match2Id(3), "CANCELLED");
  await db.run(`UPDATE "Organisation" SET "dormantAt" = now() WHERE id = $1`, [ORG2]);
  await poll(request, at(W[1], -1, "11:05"), GROUP2);
  expect(await credits(db, ORG2)).toHaveLength(1);

  // Awake again: the next hour's sweep writes it.
  await db.run(`UPDATE "Organisation" SET "dormantAt" = NULL WHERE id = $1`, [ORG2]);
  await poll(request, at(W[1], -1, "12:05"), GROUP2);
  now = await credits(db, ORG2);
  expect(live(now, "cancelled-week").map((c) => c.earnedMatchId).sort()).toEqual([match2Id(2), match2Id(3)]);

  // A RESTORED game whose credit was already used against ANOTHER month:
  // the credit is taken back there and that month asks for one game more.
  // Never silently kept, and the payment itself is not touched.
  const LATER = "e2e-mc2-later";
  await db.run(
    `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "sharePerGamePence", "pricedAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4::date, 'open', 4, 500, $5, $5, now())`,
    [LATER, ORG2, ACT2, nextMonthStart(NEXT), new Date().toISOString()],
  );
  await db.run(
    `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, "gamesCovered", "creditsApplied", "amountDuePence", "paidAt", "paidAmountPence",
                                     "paidConfirmedByUserId", source, "updatedAt")
     VALUES ('e2e-mc2-later-wes', $1, $2, 'regular', 1, 4, 1, 1500, $3, 1500, $2, 'carry-over', now())`,
    [LATER, P.wes.id, new Date().toISOString()],
  );
  await db.run(`UPDATE "SquadCredit" SET "appliedMonthId" = $1, "appliedAt" = $4 WHERE "orgId" = $2 AND "earnedMatchId" = $3`, [LATER, ORG2, match2Id(2), new Date().toISOString()]);
  await setStatus(db, match2Id(2), "UPCOMING");
  await poll(request, at(W[1], -1, "13:05"), GROUP2);
  const spent = (await credits(db, ORG2)).find((c) => c.earnedMatchId === match2Id(2))!;
  expect(spent.voidedAt).not.toBeNull();
  const later = await db.one<{ creditsApplied: number; amountDuePence: number; paidAmountPence: number; paidAt: Date | null }>(
    `SELECT "creditsApplied", "amountDuePence", "paidAmountPence", "paidAt" FROM "SquadMonthMember" WHERE id = 'e2e-mc2-later-wes'`,
  );
  // He paid £15 for three games; he is now asked for four: owes £5 more.
  expect(later).toMatchObject({ creditsApplied: 0, amountDuePence: 2000, paidAmountPence: 1500 });
  expect(later!.paidAt).not.toBeNull();
});

test("8. WEEKLY: the fixture club (Sutton FC's shape) is untouched by any of it", async ({ request, db }) => {
  // A weekly club with a cancelled game, polled on the same clock.
  await db.run(`UPDATE "Match" SET status = 'CANCELLED' WHERE id IN (SELECT m.id FROM "Match" m JOIN "Activity" a ON a.id = m."activityId" WHERE a."orgId" = $1 LIMIT 1)`, [ORG_ID]);
  await poll(request, closing(14), E2E.GROUP_ID);
  await poll(request, closing(15), E2E.GROUP_ID);
  expect(await credits(db, ORG_ID)).toEqual([]);
  expect(await db.count(`SELECT COUNT(*) FROM "SquadMonth" WHERE "orgId" = $1`, [ORG_ID])).toBe(0);
  // Not even the hourly marker: the sweep is never entered for it.
  expect(await db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key LIKE $1`, [`org-${ORG_ID}:monthly-close-sweep:%`])).toBe(0);
  expect(await db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key LIKE $1`, [`org-${ORG_ID}:mcl:%`])).toBe(0);
  // The monthly clubs do have theirs.
  expect(await db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key LIKE $1`, [`org-${ORG}:monthly-close-sweep:%`])).toBe(1);
});
