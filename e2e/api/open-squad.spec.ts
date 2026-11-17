/**
 * NO SQUAD LIMIT, END TO END (2026-11-17, the Vets: "the main squad will
 * always expand or shrink without any limits and a bench, as the pitch is
 * quite big to allow anyone"; then "no 7, 8, 9 or 10-a-side, just a simple
 * main squad list" with a minimum and no maximum).
 *
 * Against a real Postgres and the real routes (/api/whatsapp/analyze,
 * /api/whatsapp/due-posts, /api/whatsapp/admin-group). The router and the
 * extractors are STUBBED ($0): what the real model reads "@Match Time no
 * limit on the squad" as is the paid check. Everything after is shipped
 * code.
 *
 *   A. a monthly club with the setting on (the Vets' shape):
 *        1. the regulars are seeded and the list has no format in its title
 *           and an invitation in place of "N places open"; nothing offered
 *        2. INs past the format's places are all in, never the bench
 *        3. an OUT shrinks the squad: no offer, no "place open" line, and
 *           the re-posted list keeps the invitation
 *   B. the fixture club (weekly), switched by tagging MatchTime:
 *        4. an organiser switches it on: Ben, waiting on the bench, is in;
 *           an IN past the places is in
 *        5. a player tagging it hears who can; untagged, nothing
 *        6. an organiser puts the limit back (in the admin group): nobody
 *           is bumped, and the next IN goes on the bench
 */
import type { APIRequestContext } from "@playwright/test";
import { formatInTimeZone } from "date-fns-tz";
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { engineOn, selfIn, selfOut } from "../helpers/stub";
import { E2E } from "../helpers/env";
import { MATCH, NAME, ORG_ID, PHONE, U, londonAt } from "../helpers/constants";
import { testDb, type TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const LONDON = "Europe/London";
const digits = (phone: string) => phone.replace(/^\+/, "");
let seq = 0;
const msgId = () => `e2e-os-${Date.now()}-${++seq}`;

// ── A. A monthly club with no squad limit ─────────────────────────────

const ORG = "e2e-os-org";
const GROUP = "e2e-open-squad@g.us";
const ACT = "e2e-os-act";
const SPORT = "e2e-os-sport";
const MATCH_ID = "e2e-os-match";
const MONTH = "e2e-os-month";
const KICKOFF = londonAt(3, 20, 0);
const MONTH_NAME = formatInTimeZone(KICKOFF, LONDON, "MMMM");
const MONTH_START = `${formatInTimeZone(KICKOFF, LONDON, "yyyy-MM")}-01`;
const WEEKDAY = Number(formatInTimeZone(KICKOFF, LONDON, "i")) % 7;
/** No "3-a-side": the activity is "Football 3-a-side", the title is "Football". */
const HEADER = `📋 *Football, ${formatInTimeZone(KICKOFF, LONDON, "EEE d MMM 'at' HH:mm")}*`;
const INVITE = "Anyone else, say *IN* to play, £8.";
const ALL_IN = "You're all in, no need to say anything. Can't make it? Say *Out*.";
const at = (hour: number, minute = 0) => londonAt(1, hour, minute);

const P = {
  rob: { id: "e2e-os-rob", name: "Rob Hale", phone: "+447700930001" },
  alex: { id: "e2e-os-alex", name: "Alex Carter", phone: "+447700930002" },
  bilal: { id: "e2e-os-bilal", name: "Bilal Aydin", phone: "+447700930003" },
  chris: { id: "e2e-os-chris", name: "Chris Bell", phone: "+447700930004" },
  dave: { id: "e2e-os-dave", name: "Dave Stone", phone: "+447700930005" },
  zee: { id: "e2e-os-zee", name: "Zeeshan Ali", phone: "+447700930006" },
  will: { id: "e2e-os-will", name: "Will Frost", phone: "+447700930007" },
  tom: { id: "e2e-os-tom", name: "Tom Reed", phone: "+447700930008" },
} as const;
type Person = (typeof P)[keyof typeof P];

interface Instruction {
  kind: string;
  key: string;
  text?: string;
}
interface AnalyzeResult {
  waMessageId: string;
  intent: string | null;
  react: string | null;
  reply: string | null;
}

async function poll(request: APIRequestContext, now: Date): Promise<Instruction[]> {
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(GROUP)}`, {
    headers: { ...KEY, "x-test-now": now.toISOString() },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).instructions as Instruction[];
}

async function say(request: APIRequestContext, who: Person, body: string): Promise<AnalyzeResult> {
  const waMessageId = msgId();
  const res = await request.post("/api/whatsapp/analyze", {
    headers: KEY,
    data: {
      groupId: GROUP,
      messages: [{ waMessageId, body, authorPhone: digits(who.phone), authorName: who.name, timestamp: new Date().toISOString() }],
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  const json = (await res.json()) as { results?: AnalyzeResult[] };
  return (json.results ?? []).find((r) => r.waMessageId === waMessageId) ?? { waMessageId, intent: null, react: null, reply: null };
}

const rows = (db: TestDb, matchId: string) =>
  db.all<{ userId: string; status: string }>(
    `SELECT "userId", status::text AS status FROM "Attendance" WHERE "matchId" = $1 ORDER BY position, "userId"`,
    [matchId],
  );
const statusOf = async (db: TestDb, matchId: string, userId: string) => (await rows(db, matchId)).find((r) => r.userId === userId)?.status;
const offers = (db: TestDb, matchId: string) => db.all<{ id: string }>(`SELECT id FROM "BenchSlotOffer" WHERE "matchId" = $1`, [matchId]);
const listPosts = (instructions: Instruction[]) => instructions.filter((i) => i.key.startsWith(`${MATCH_ID}:month-list:`));
const ageListPosts = (db: TestDb) =>
  db.run(`UPDATE "SentNotification" SET "createdAt" = "createdAt" - interval '3 days' WHERE "matchId" = $1 AND key LIKE $2`, [
    MATCH_ID,
    `${MATCH_ID}:month-list:%`,
  ]);

async function person(db: TestDb, p: Person, role = "PLAYER") {
  await db.run(`INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [p.id, `${p.id}@e2e.test`, p.name, p.phone]);
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1, $2, $3, $4::"MemberRole")`, [`mem-${p.id}`, p.id, ORG, role]);
}

test.describe("A. a monthly club with no squad limit", () => {
  test.beforeAll(async () => {
    resetDb();
    const db = testDb();
    await db.run(
      `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled", "squadMode",
                                   "paygPricePence", "adminChannelMode", language, "openSquad", "updatedAt")
       VALUES ($1, 'Monday night vets', $1, $2, $3, true, 'monthly', 800, 'each-admin', 'en', true, now())`,
      [ORG, `${ORG}-invite`, GROUP],
    );
    await db.run(
      `INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt")
       VALUES ($1, $2, 'Football', 3, ARRAY['GK','DEF','FWD'], ARRAY['Red','Yellow'], now())`,
      [SPORT, ORG],
    );
    // A 3-a-side format (6 places) with a minimum of 4.
    await db.run(
      `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "minPlayers", "updatedAt")
       VALUES ($1, $2, $3, 'Football 3-a-side', $4, '20:00', 'Goals', 5, 4, now())`,
      [ACT, ORG, SPORT, WEEKDAY],
    );
    await db.run(
      `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt")
       VALUES ($1, $2, $3, 6, 'UPCOMING', $4, now())`,
      [MATCH_ID, ACT, KICKOFF.toISOString(), new Date(KICKOFF.getTime() - 5 * 3600_000).toISOString()],
    );
    await person(db, P.rob, "OWNER");
    for (const p of [P.alex, P.bilal, P.chris, P.dave, P.zee, P.will, P.tom]) await person(db, p);
    await db.run(
      `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "gamesPlayedBeforeStart",
                                 "startedMidMonthAt", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4::date, 'running', 4, 1, now() - interval '2 days', now() - interval '2 days', now())`,
      [MONTH, ORG, ACT, MONTH_START],
    );
    for (const [i, p] of [P.alex, P.bilal, P.chris, P.dave].entries()) {
      await db.run(
        `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, "gamesCovered", source, "updatedAt")
         VALUES ($1, $2, $3, 'regular', $4, 4, 'seed-list', now())`,
        [`${MONTH}-${p.id}`, MONTH, p.id, i + 1],
      );
    }
    await db.run(
      `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, "gamesCovered", source, "updatedAt")
       VALUES ($1, $2, $3, 'payg', NULL, 0, 'seed-list', now())`,
      [`${MONTH}-${P.zee.id}`, MONTH, P.zee.id],
    );
    engineOn({ in: { route: "self_att", facts: selfIn() }, "out sorry": { route: "self_att", facts: selfOut() } });
  });

  test.afterAll(() => resetDb());

  test("1. the regulars are seeded; the list has no format and invites anyone else; nothing is offered", async ({ request, db }) => {
    const first = await poll(request, at(10));
    expect(await rows(db, MATCH_ID)).toEqual(
      [P.alex, P.bilal, P.chris, P.dave].map((p) => ({ userId: p.id, status: "CONFIRMED" })),
    );
    const posts = listPosts(first);
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toBe(
      [HEADER, "", `*${MONTH_NAME} squad:*`, "1. Alex", "2. Bilal", "3. Chris", "4. Dave", "", `*Pay as you go:* ${INVITE}`, "", ALL_IN].join("\n"),
    );
    // Two of six places are "free" by the format, but there are no places:
    // no offer, no pay-as-you-go DMs, no "place open" line.
    expect(await offers(db, MATCH_ID)).toEqual([]);
    expect(first.filter((i) => i.key.includes("payg-pool"))).toEqual([]);
    for (const i of first) expect(i.text ?? "").not.toMatch(/place open|places open|squad is full|3-a-side/i);
  });

  test("2. INs past the format's places are all in with ✅, never the bench", async ({ request, db }) => {
    for (const p of [P.zee, P.will, P.tom]) {
      const r = await say(request, p, "in");
      expect(r.react, `${p.name}: ${JSON.stringify(r)}`).toBe("✅");
    }
    // Four regulars and three more: seven on a six-place format.
    const all = await rows(db, MATCH_ID);
    expect(all.filter((r) => r.status === "CONFIRMED")).toHaveLength(7);
    expect(all.filter((r) => r.status === "BENCH")).toEqual([]);
  });

  test("3. an OUT shrinks the squad: no offer, no \"place open\"; the list keeps the invitation", async ({ request, db }) => {
    await ageListPosts(db);
    const out = await say(request, P.bilal, "out sorry");
    expect(out.react).toBe("👋");
    expect(await statusOf(db, MATCH_ID, P.bilal.id)).toBe("DROPPED");
    expect(await offers(db, MATCH_ID)).toEqual([]);

    const next = await poll(request, at(12));
    const list = listPosts(next);
    expect(list).toHaveLength(1);
    const text = list[0].text!;
    expect(text.startsWith(HEADER)).toBe(true);
    // Tom, past the format's six places, sits in the number Bilal vacated
    // (the month's own rule), read the same way the reply path reads it.
    expect(text).toContain("*Pay as you go:*\n4. Tom\n5. Zeeshan\n6. Will\n" + INVITE);
    expect(text).toContain("*Can't play:*\n1. Bilal");
    for (const i of next) expect(i.text ?? "").not.toMatch(/place open|places open|squad is full|First to say|Bench/i);
  });

  test("4. switched off mid-month by the owner's tag: nobody is bumped, and the month keeps room for every regular (review of #623)", async ({ request, db }) => {
    // Four more regulars sign: eight regulars on a six-place format.
    for (const [i, p] of [P.zee, P.will, P.tom].entries()) {
      await db.run(`UPDATE "SquadMonthMember" SET kind = 'regular', slot = $3, "gamesCovered" = 4 WHERE "monthId" = $1 AND "userId" = $2`, [MONTH, p.id, 5 + i]);
      await db.run(
        `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, "gamesCovered", source, "updatedAt")
         VALUES ($1, $2, $3, 'regular', $4, 4, 'seed-list', now()) ON CONFLICT ("monthId", "userId") DO NOTHING`,
        [`${MONTH}-${p.id}`, MONTH, p.id, 5 + i],
      );
    }
    const before = (await rows(db, MATCH_ID)).filter((r) => r.status === "CONFIRMED").length;
    const OFF_MSG = "@Match Time put the limit and the bench back";
    engineOn({ [OFF_MSG]: { route: "admin_ops", facts: { action: "open_squad", openSquadOff: true, toMatchTime: true } } });
    const waMessageId = msgId();
    const res = await request.post("/api/whatsapp/analyze", {
      headers: KEY,
      data: { groupId: GROUP, messages: [{ waMessageId, body: OFF_MSG, authorPhone: digits(P.rob.phone), authorName: P.rob.name, timestamp: new Date().toISOString(), botMentioned: true }] },
    });
    expect(res.status(), await res.text()).toBe(200);
    const reply = ((await res.json()).results as AnalyzeResult[]).find((r) => r.waMessageId === waMessageId);
    expect(reply?.intent).toBe("open-squad-off");
    expect((await db.one<{ on: boolean }>(`SELECT "openSquad" AS on FROM "Organisation" WHERE id = $1`, [ORG]))!.on).toBe(false);
    // Nobody bumped from this week's game.
    const after = await rows(db, MATCH_ID);
    expect(after.filter((r) => r.status === "CONFIRMED")).toHaveLength(before);
    expect(after.filter((r) => r.status === "BENCH")).toEqual([]);
    // The month keeps room for its seven regulars still in the group (Bilal is out this week, still a regular).
    const floor = await db.one<{ floor: number | null }>(`SELECT "regularCapFloor" AS floor FROM "SquadMonth" WHERE id = $1`, [MONTH]);
    expect(floor?.floor).toBeGreaterThanOrEqual(7);
  });
});

// ── B. The fixture club, switched by tagging MatchTime ────────────────

const ON = "@Match Time no limit on the squad";
const OFF = "@Match Time put the limit and the bench back";
const UNTAGGED = "no limit on the squad would be nice";
const HQ = "120363777000000081@g.us";
const openSquadFacts = (fields: Record<string, unknown> = {}) => ({
  route: "admin_ops",
  facts: { action: "open_squad", openSquadOff: false, toMatchTime: true, ...fields },
});

async function pg(request: APIRequestContext, body: string, who: keyof typeof PHONE = "admin", tagged = true) {
  const waMessageId = msgId();
  const res = await postAnalyze(request, [{ waMessageId, body, authorPhone: PHONE[who], authorName: NAME[who], botMentioned: tagged }]);
  const mine = res.results.filter((r: { waMessageId: string }) => r.waMessageId === waMessageId);
  expect(mine, JSON.stringify(res.results)).toHaveLength(1);
  return mine[0] as { reply: string | null; intent: string; react?: string | null };
}
async function hq(request: APIRequestContext, text: string) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", botMentioned: true, groupId: HQ, messageId: `e2e-os-hq-${++seq}`, text, senderPhone: digits(PHONE.admin), timestamp: String(Math.floor(Date.now() / 1000)) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json() as Promise<{ outcome: string; replyText: string | null }>;
}
const openSquadOn = async (db: TestDb) => (await db.one<{ on: boolean }>(`SELECT "openSquad" AS on FROM "Organisation" WHERE id = $1`, [ORG_ID]))!.on;

test.describe("B. switched by tagging MatchTime", () => {
  test.beforeAll(() => {
    resetDb();
  });
  test.beforeEach(() => {
    engineOn({
      [ON]: openSquadFacts(),
      [OFF]: openSquadFacts({ openSquadOff: true }),
      [UNTAGGED]: openSquadFacts({ toMatchTime: false }),
      in: { route: "self_att", facts: selfIn() },
    });
  });
  test.afterAll(() => resetDb());

  test("4. an organiser switches it on: Ben comes in from the bench, and an IN past the places is in", async ({ request, db }) => {
    // The fixture match: 5 places, 4 in, Ben on the bench.
    expect(await statusOf(db, MATCH.upcoming, U.bench)).toBe("BENCH");
    const on = await pg(request, ON);
    expect(on.intent).toBe("open-squad-on");
    expect(on.reply).toContain("✅ Done: no squad limit and no bench from now on.");
    expect(on.reply).toContain("Ben Bench was on the bench and is in now.");
    expect(on.reply).not.toMatch(/a-side/);
    expect(await openSquadOn(db)).toBe(true);
    expect(await statusOf(db, MATCH.upcoming, U.bench)).toBe("CONFIRMED");

    // 5 in on 5 places; Ian and Zara come in past them.
    for (const who of ["fresh", "extra"] as const) {
      const r = await pg(request, "in", who, false);
      expect(r.react, JSON.stringify(r)).toBe("✅");
    }
    const all = await rows(db, MATCH.upcoming);
    expect(all.filter((r) => r.status === "CONFIRMED")).toHaveLength(7);
    expect(all.filter((r) => r.status === "BENCH")).toEqual([]);
  });

  test("4b. teams made: a late IN joins the smaller side with one post of the redrawn sheet; a drop moves nobody (review of #623)", async ({ request, db }) => {
    engineOn({ in: { route: "self_att", facts: selfIn() }, out: { route: "self_att", facts: selfOut() } });
    // The seven in, on a sheet of 4 Red and 3 Yellow.
    const sheet: Array<[string, string]> = [
      [U.admin, "RED"],
      [U.collector, "RED"],
      [U.player, "RED"],
      [U.third, "RED"],
      [U.bench, "YELLOW"],
      [U.fresh, "YELLOW"],
      [U.extra, "YELLOW"],
    ];
    for (const [i, [userId, team]] of sheet.entries()) {
      await db.run(`INSERT INTO "TeamAssignment" (id, "matchId", "userId", team) VALUES ($1, $2, $3, $4::"Team")`, [`e2e-os-ta-${i}`, MATCH.upcoming, userId, team]);
    }
    const teamOf = async (userId: string) =>
      (await db.one<{ team: string }>(`SELECT team::text AS team FROM "TeamAssignment" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, userId]))?.team ?? null;

    const rater = await pg(request, "in", "rater", false);
    expect(rater.react, JSON.stringify(rater)).toBe("✅");
    expect(await teamOf(U.rater)).toBe("YELLOW");
    expect(rater.reply ?? "").toContain("joins *Yellow*");

    const omar = await pg(request, "in", "omar1", false);
    expect(omar.react).toBe("✅");
    expect(await teamOf(U.omar1)).not.toBeNull();

    const seats = async () => (await db.all<{ n: number }>(`SELECT count(*)::int AS n FROM "TeamAssignment" WHERE "matchId" = $1`, [MATCH.upcoming]))[0].n;
    const before = await seats();
    const out = await pg(request, "out", "rater", false);
    expect(out.react).toBe("👋");
    expect(await seats()).toBe(before);
    expect(await teamOf(U.rater)).toBe("YELLOW");
    expect(out.reply ?? "").not.toContain("joins");
  });

  test("4c. the safety net: a bench row left while the setting is on is promoted by the scheduler's sweep", async ({ request, db }) => {
    await db.run(
      `WITH a AS (
         INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt")
         VALUES ('e2e-os-dup', $1, $2, 'BENCH', 30, now()) RETURNING "matchId", "userId", status, position
       )
       INSERT INTO "AttendanceEvent" (id, "matchId", "userId", "orgId", "toStatus", "toPosition", cause, "actorKind")
       SELECT 'e2e-os-dup-ev', "matchId", "userId", $3, status, position, 'test-fixture', 'system' FROM a`,
      [MATCH.upcoming, U.dup, ORG_ID],
    );
    expect(await statusOf(db, MATCH.upcoming, U.dup)).toBe("BENCH");
    const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`, { headers: KEY });
    expect(res.status(), await res.text()).toBe(200);
    expect(await statusOf(db, MATCH.upcoming, U.dup)).toBe("CONFIRMED");
  });

  test("5. a player tagging it hears who can; untagged, nothing changes and nothing is said", async ({ request, db }) => {
    await db.run(`UPDATE "Organisation" SET "openSquad" = false WHERE id = $1`, [ORG_ID]);
    const player = await pg(request, ON, "player");
    expect(player.reply).toMatch(/^Only .+ can change that\.$/);
    expect(await openSquadOn(db)).toBe(false);
    const untagged = await pg(request, UNTAGGED, "admin", false);
    expect(untagged.reply ?? null).toBeNull();
    expect(await openSquadOn(db)).toBe(false);
  });

  test("6. the limit put back in the admin group: nobody is bumped, and the next IN goes on the bench", async ({ request, db }) => {
    await db.run(`UPDATE "Organisation" SET "openSquad" = true, "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
    // Past the five places, as tests 4 to 4c left it.
    const before = (await rows(db, MATCH.upcoming)).filter((r) => r.status === "CONFIRMED").length;
    expect(before).toBeGreaterThan(5);

    const off = await hq(request, OFF);
    expect(off.outcome).toBe("hq-open-squad-off");
    expect(off.replyText).toContain("the squad has a limit again");
    expect(off.replyText).toContain("Everyone already in stays in");
    expect(await openSquadOn(db)).toBe(false);
    expect((await rows(db, MATCH.upcoming)).filter((r) => r.status === "CONFIRMED")).toHaveLength(before);

    // The places are the format's again: Olivia's IN goes on the bench.
    const r = await pg(request, "in", "opt", false);
    expect(r.react, JSON.stringify(r)).toBe("🪑");
    expect(await statusOf(db, MATCH.upcoming, U.opt)).toBe("BENCH");
  });
});
