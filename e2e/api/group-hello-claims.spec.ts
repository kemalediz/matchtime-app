/**
 * THE GROUP HELLO'S CLAIMS, PROVED END TO END (2026-11-03).
 *
 * The welcome MatchTime posts in a new group (`src/lib/group-hello.ts`,
 * the `sj_hello_*` strings in `src/lib/i18n/strings.en.ts`) tells players
 * what MatchTime does. Each test below is titled after one of those claims
 * and drives the behaviour through the real routes against the isolated
 * e2e Postgres: /api/whatsapp/analyze, /api/whatsapp/due-posts on a pinned
 * clock (x-test-now, x-no-claim), the real rate page and the cron route.
 *
 * The router and every extractor are STUBBED (`helpers/stub.ts`): no model
 * is called anywhere in this file, $0.
 *
 * Organiser-chosen Man of the Match is proved in
 * `e2e/api/mom-organisers-pick.spec.ts` and is not repeated here.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { formatInTimeZone } from "date-fns-tz";
import { test, expect, postAnalyze, resetDb, signInAs } from "../fixtures";
import { engineOn, otherFacts, selfIn, facts, claim } from "../helpers/stub";
import { E2E } from "../helpers/env";
import { MATCH, NAME, ORG_ID, PHONE, SPORT_ID, U, londonAt } from "../helpers/constants";
import { testDb, type TestDb } from "../helpers/test-db";
import { buildMomAnnouncement } from "@/lib/mom-announcement";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const LONDON = "Europe/London";
const digits = (phone: string) => phone.replace(/^\+/, "");
let seq = 0;
const msgId = () => `e2e-hello-${Date.now()}-${++seq}`;

interface Instruction {
  kind: string;
  key: string;
  text?: string;
  phone?: string;
  question?: string;
  targetUser?: string;
}

/** A due-posts poll on a pinned clock that claims nothing. */
async function due(request: APIRequestContext, now: Date, groupId = E2E.GROUP_ID): Promise<Instruction[]> {
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(groupId)}`, {
    headers: { ...KEY, "x-test-now": now.toISOString(), "x-no-claim": "1" },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()).instructions ?? []) as Instruction[];
}

/** Every instruction that would be a Man of the Match poll in the group. */
const momPolls = (all: Instruction[]) =>
  all.filter((i) => i.key.includes("mom-poll") || (i.kind.includes("poll") && /mom|man of the match/i.test(`${i.key} ${i.question ?? ""}`)));

function resultFor(res: { results: Array<Record<string, unknown>> }, id: string) {
  const r = res.results.find((x) => x.waMessageId === id);
  expect(r, JSON.stringify(res.results)).toBeTruthy();
  return r as { reply: string | null; intent: string | null; react: string | null };
}

/** Submit the rate page as `userId`, optionally scoring one player and
 *  picking Man of the Match. Lands on /profile/stats. */
async function rateAs(
  page: Page,
  userId: string,
  opts: { score?: { name: string; value: number }; mom?: string } = {},
): Promise<void> {
  await page.context().clearCookies();
  await signInAs(page, userId);
  await page.goto(`/matches/${MATCH.rate}/rate`);
  await expect(page.getByRole("button", { name: /submit/i })).toBeVisible({ timeout: 30_000 });
  if (opts.score) {
    const value = String(opts.score.value);
    await page
      .locator("div.bg-white")
      .filter({ hasText: opts.score.name })
      .filter({ has: page.getByRole("button", { name: value, exact: true }) })
      .first()
      .getByRole("button", { name: value, exact: true })
      .click();
  }
  if (opts.mom) {
    await page.locator("div.border-amber-200").getByRole("button", { name: new RegExp(opts.mom) }).first().click();
  }
  await page.getByRole("button", { name: /submit/i }).click();
  await page.waitForURL("**/profile/stats", { timeout: 30_000 });
}

// ═════════════════════════════════════════════════════════════════════
// THE FIXTURE CLUB (weekly): ratings, Man of the Match, teams, reminders
// ═════════════════════════════════════════════════════════════════════
//
// MATCH.rate was played yesterday at 20:00 London: Riley, Pat, Tom, Sam
// and Olivia played. In the seed Pat rated Riley, and Tom rated Riley and
// Pat; Riley, Sam and Olivia have not rated.

test.describe("the fixture club", () => {
  test.beforeEach(() => {
    resetDb();
  });

  test.afterAll(() => {
    resetDb();
  });

  test("Man of the Match: a player picks on the private rating link the morning after, and the winner is announced in the group (no poll)", async ({
    page,
    request,
    db,
  }) => {
    const seen: Instruction[] = [];
    const poll = async (now: Date) => {
      const out = await due(request, now);
      seen.push(...out);
      return out;
    };
    const RATE_DM = `${MATCH.rate}:rate-dm:${U.rater}`;
    const MOM_KEY = `${MATCH.rate}:mom-announcement`;

    // Not before 08:00 London the morning after.
    expect((await poll(londonAt(0, 7, 30))).filter((i) => i.key.includes(":rate-dm:"))).toEqual([]);

    // From 08:00: a private DM to Riley asking him to rate and pick MoM.
    const dm = (await poll(londonAt(0, 8, 30))).find((i) => i.key === RATE_DM);
    expect(dm).toMatchObject({ kind: "dm", phone: digits(PHONE.rater) });
    expect(dm?.text).toContain("Rate your teammates and pick Man of the Match.");

    // Riley picks Pat on the real rate page (submitMoMVote / ratings action).
    await rateAs(page, U.rater, { mom: NAME.player });
    expect(await db.all(`SELECT "voterId", "playerId" FROM "MoMVote" WHERE "matchId" = $1`, [MATCH.rate])).toEqual([
      { voterId: U.rater, playerId: U.player },
    ]);

    // EARLY TRIGGER: announced once every confirmed player with a phone has
    // engaged (rated or voted). Sam and Olivia have not yet: nothing.
    expect((await poll(londonAt(0, 10, 0))).find((i) => i.key === MOM_KEY)).toBeUndefined();

    // Sam and Olivia submit their ratings on the same page (no MoM pick).
    await rateAs(page, U.stale);
    await rateAs(page, U.opt);

    // Now everyone has engaged: the winner is announced in the group.
    const post = (await poll(londonAt(0, 10, 0))).find((i) => i.key === MOM_KEY);
    expect(post).toMatchObject({ kind: "group-message" });
    expect(post?.text).toBe(
      buildMomAnnouncement({ mvpLabel: "Man of the Match", activityName: "E2E 5-a-side", tally: [{ name: NAME.player, votes: 1 }], lang: "en" }),
    );
    expect(post?.text).toContain(NAME.player);

    // At no point did MatchTime post a Man of the Match poll in the group.
    expect(momPolls(seen)).toEqual([]);
  });

  test("Ratings: you can't rate yourself, and a player's form rating is updated as soon as a rating comes in (no weekly job)", async ({
    page,
  }) => {
    // Riley's club rating from the seed: an 8 and a 7.
    await page.context().clearCookies();
    await signInAs(page, U.rater, "/profile/stats");
    await page.waitForURL("**/profile/stats", { timeout: 30_000 });
    await expect(page.getByText("7.5", { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/Provisional: 2 ratings/).first()).toBeVisible();

    // Riley's own rate page does not list Riley.
    await page.goto(`/matches/${MATCH.rate}/rate`);
    const main = page.getByRole("main");
    await expect(main.getByText(NAME.player).first()).toBeVisible({ timeout: 30_000 });
    await expect(main.getByText(NAME.rater)).toHaveCount(0);

    // Sam gives Riley a 10 on the rate page.
    await rateAs(page, U.stale, { score: { name: NAME.rater, value: 10 } });

    // Riley's page, straight after, with no cron or job in between:
    // (8 + 7 + 10) / 3 = 8.3 from three ratings.
    await page.context().clearCookies();
    await signInAs(page, U.rater, "/profile/stats");
    await page.waitForURL("**/profile/stats", { timeout: 30_000 });
    await expect(page.getByText("8.3", { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/rated by 3 players/).first()).toBeVisible();
    await expect(page.getByText(/Provisional: 2 ratings/)).toHaveCount(0);
    await expect(page.getByText("7.5", { exact: false })).toHaveCount(0);
  });

  // ── Fair teams ────────────────────────────────────────────────────

  const MAKE = "@Match Time make the teams";
  const MAKE_ROUTING = {
    route: "balancer",
    facts: { action: "generate", includeRefs: [], teamNames: null, swaps: [], pairings: [] },
  };

  const teamRows = (db: TestDb) =>
    db.all<{ userId: string; team: string }>(`SELECT "userId", team::text AS team FROM "TeamAssignment" WHERE "matchId" = $1`, [
      MATCH.upcoming,
    ]);
  const status = async (db: TestDb) =>
    (await db.one<{ v: string }>(`SELECT status::text AS v FROM "Match" WHERE id = $1`, [MATCH.upcoming]))?.v;

  /** Move the upcoming match to `daysOffset` London days from today, 22:00. */
  async function kickoffIn(db: TestDb, daysOffset: number): Promise<Date> {
    const kickoff = londonAt(daysOffset, 22, 0);
    await db.run(`UPDATE "Match" SET date = $2, "attendanceDeadline" = $3 WHERE id = $1`, [
      MATCH.upcoming,
      kickoff.toISOString(),
      new Date(kickoff.getTime() - 5 * 60 * 60 * 1000).toISOString(),
    ]);
    return kickoff;
  }

  /** 2-a-side, so the seeded 4 confirmed make two full sides; and ratings
   *  that make one split clearly the fair one: Alex and Colin strong, Pat
   *  and Tom weak. Given on the completed PAY match. */
  async function squadWithRatings(db: TestDb): Promise<void> {
    await db.run(`UPDATE "Sport" SET "playersPerTeam" = 2 WHERE id = $1`, [SPORT_ID]);
    const scores: Array<[string, string, number]> = [
      [U.rater, U.admin, 10],
      [U.fresh, U.admin, 10],
      [U.rater, U.collector, 10],
      [U.fresh, U.collector, 10],
      [U.rater, U.player, 2],
      [U.fresh, U.player, 2],
      [U.rater, U.third, 2],
      [U.fresh, U.third, 2],
    ];
    for (const [rater, player, score] of scores) {
      await db.run(`INSERT INTO "Rating" (id, "matchId", "raterId", "playerId", score) VALUES ($1, $2, $3, $4, $5)`, [
        `e2e-hello-r-${rater}-${player}`,
        MATCH.pay,
        rater,
        player,
        score,
      ]);
    }
  }

  test("Fair teams: a player (not an organiser) who tags MatchTime on match day gets two balanced sides; a day early nothing is built", async ({
    request,
    db,
  }) => {
    await squadWithRatings(db);
    engineOn({ [MAKE]: MAKE_ROUTING });

    // The day before: a polite line, nothing built.
    await kickoffIn(db, 1);
    const early = msgId();
    const r1 = await postAnalyze(request, [{ waMessageId: early, body: MAKE, authorPhone: PHONE.player, authorName: NAME.player, botMentioned: true }]);
    expect(resultFor(r1, early).reply).toBe("I'll build the teams on match day, just ask me then.");
    expect(await teamRows(db)).toEqual([]);
    expect(await status(db)).toBe("UPCOMING");

    // Match day: Pat (a PLAYER, not an admin) asks, and the teams are built.
    await kickoffIn(db, 0);
    const id = msgId();
    const r2 = await postAnalyze(request, [{ waMessageId: id, body: MAKE, authorPhone: PHONE.player, authorName: NAME.player, botMentioned: true }]);
    const r = resultFor(r2, id);
    const rows = await teamRows(db);
    expect(rows, JSON.stringify(r2.results)).toHaveLength(4);
    expect(await status(db)).toBe("TEAMS_GENERATED");
    expect(r.intent).toBe("generate_teams_request");

    // Balanced by the ratings: the two strong players are on opposite sides.
    const side = new Map(rows.map((x) => [x.userId, x.team]));
    expect(side.get(U.admin)).not.toBe(side.get(U.collector));
    expect(side.get(U.player)).not.toBe(side.get(U.third));
  });

  test("Fair teams: no scheduled job builds the teams, only a tag does (due-posts on match day and the old generate-teams cron build nothing)", async ({
    request,
    db,
  }) => {
    await squadWithRatings(db);
    await kickoffIn(db, 0);

    // The scheduler through match day, untagged: no teams.
    for (const [h, m] of [
      [9, 0],
      [12, 0],
      [17, 0],
      [20, 30],
    ] as const) {
      await due(request, londonAt(0, h, m));
    }
    expect(await teamRows(db)).toEqual([]);
    expect(await status(db)).toBe("UPCOMING");

    // The cron that used to build them at noon.
    const cron = await request.get("/api/cron/generate-teams", { headers: { authorization: `Bearer ${E2E.CRON_SECRET}` } });
    expect(cron.status(), await cron.text()).toBe(200);
    expect(await teamRows(db)).toEqual([]);
    expect(await status(db)).toBe("UPCOMING");
  });

  // ── Remind me ─────────────────────────────────────────────────────

  test("Remind me: a player tags MatchTime 'remind me Thursday' and gets a DM on Thursday", async ({ request, db }) => {
    const BODY = "@Match Time remind me Thursday";
    // The next Thursday after today, London; a day with no time is 09:00.
    let d = 1;
    while (Number(formatInTimeZone(londonAt(d, 12, 0), LONDON, "i")) !== 4) d++;
    const sendAt = londonAt(d, 9, 0);
    const remindAt = `${formatInTimeZone(sendAt, LONDON, "yyyy-MM-dd")} 09:00`;
    engineOn({
      [BODY]: {
        route: "admin_ops",
        facts: {
          action: "reminder",
          payerRef: "",
          count: 0,
          coveredRefs: [],
          undo: false,
          matchDay: "",
          phrase: "Thursday",
          remindAt,
          note: "",
          lookbackMatches: 0,
          playersFrom: "",
          clubRef: "",
          toMatchTime: true,
        },
      },
    });

    const id = msgId();
    const res = await postAnalyze(request, [{ waMessageId: id, body: BODY, authorPhone: PHONE.player, authorName: NAME.player, botMentioned: true }]);
    expect(resultFor(res, id).reply, JSON.stringify(res.results)).toBeTruthy();

    // Stored: one DM to Pat, held until Thursday 09:00.
    const jobs = await db.all<{ id: string; phone: string; text: string; sendAfter: Date }>(
      `SELECT id, phone, text, "sendAfter" FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2`,
      [ORG_ID, digits(PHONE.player)],
    );
    expect(jobs).toHaveLength(1);
    expect(new Date(jobs[0].sendAfter).toISOString()).toBe(sendAt.toISOString());
    const key = `botjob-${jobs[0].id}`;

    // Not before its time; then the scheduler DMs him.
    expect((await due(request, new Date(sendAt.getTime() - 60_000))).find((i) => i.key === key)).toBeUndefined();
    const out = (await due(request, new Date(sendAt.getTime() + 60_000))).find((i) => i.key === key);
    expect(out).toMatchObject({ kind: "dm", phone: digits(PHONE.player), text: jobs[0].text });
  });
});

// ═════════════════════════════════════════════════════════════════════
// A MONTHLY CLUB: the organiser's guest, a pay-as-you-go In, a friend link
// ═════════════════════════════════════════════════════════════════════
//
// The world of `monthly-week.spec.ts`, cut down: 6 places, 4 regulars who
// paid for the running month, a non-regular (Tom) and the owner (Rob).
// The week's match is three days from now (analyze has no test clock).

test.describe("a monthly club", () => {
  const ORG = "e2e-hc-org";
  const GROUP = "e2e-hello-claims@g.us";
  const ACT = "e2e-hc-act";
  const MATCH_ID = "e2e-hc-match";
  const MONTH = "e2e-hc-month";
  const KICKOFF = londonAt(3, 20, 0);
  const MONTH_START = `${formatInTimeZone(KICKOFF, LONDON, "yyyy-MM")}-01`;
  const WEEKDAY = Number(formatInTimeZone(KICKOFF, LONDON, "i")) % 7;

  const P = {
    rob: { id: "e2e-hc-rob", name: "Rob Hale", phone: "+447700930001" },
    alex: { id: "e2e-hc-alex", name: "Alex Carter", phone: "+447700930002" },
    bilal: { id: "e2e-hc-bilal", name: "Bilal Aydin", phone: "+447700930003" },
    chris: { id: "e2e-hc-chris", name: "Chris Bell", phone: "+447700930004" },
    dave: { id: "e2e-hc-dave", name: "Dave Stone", phone: "+447700930005" },
    tom: { id: "e2e-hc-tom", name: "Tom Reed", phone: "+447700930006" },
  } as const;
  type Person = (typeof P)[keyof typeof P];

  const GUEST = "David Ediz is IN";
  const FRIEND = "+1";

  async function say(request: APIRequestContext, who: Person, body: string) {
    const waMessageId = msgId();
    const res = await request.post("/api/whatsapp/analyze", {
      headers: KEY,
      data: {
        groupId: GROUP,
        messages: [{ waMessageId, body, authorPhone: digits(who.phone), authorName: who.name, timestamp: new Date().toISOString() }],
      },
    });
    expect(res.status(), await res.text()).toBe(200);
    const json = (await res.json()) as { results?: Array<{ waMessageId: string; react: string | null; reply: string | null; intent: string | null }> };
    return json.results?.find((r) => r.waMessageId === waMessageId) ?? null;
  }

  const rows = (db: TestDb) =>
    db.all<{ userId: string; status: string; paymentMethod: string | null }>(
      `SELECT "userId", status::text AS status, "paymentMethod" FROM "Attendance" WHERE "matchId" = $1 ORDER BY position, "userId"`,
      [MATCH_ID],
    );

  test.beforeAll(async () => {
    resetDb();
    const db = testDb();
    await db.run(
      `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled", "squadMode",
                                   "paygPricePence", "adminChannelMode", language, "paymentCollectionEnabled",
                                   "paymentTrackingEnabled", "updatedAt")
       VALUES ($1, 'Hello Vets', $1, $2, $3, true, 'monthly', 800, 'each-admin', 'en', false, true, now())`,
      [ORG, `${ORG}-invite`, GROUP],
    );
    await db.run(
      `INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt")
       VALUES ('e2e-hc-sport', $1, 'Football', 3, ARRAY['GK','DEF','FWD'], ARRAY['Red','Yellow'], now())`,
      [ORG],
    );
    await db.run(
      `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "updatedAt")
       VALUES ($1, $2, 'e2e-hc-sport', 'Monday 6-a-side', $3, '20:00', 'Goals', 5, now())`,
      [ACT, ORG, WEEKDAY],
    );
    for (const p of Object.values(P)) {
      await db.run(`INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [
        p.id,
        `${p.id}@e2e.test`,
        p.name,
        p.phone,
      ]);
      await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1, $2, $3, $4::"MemberRole")`, [
        `mem-${p.id}`,
        p.id,
        ORG,
        p.id === P.rob.id ? "OWNER" : "PLAYER",
      ]);
    }
    await db.run(
      `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "postMatchEndFlow", "updatedAt")
       VALUES ($1, $2, $3, 6, 'UPCOMING', $4, true, now())`,
      [MATCH_ID, ACT, KICKOFF.toISOString(), new Date(KICKOFF.getTime() - 5 * 60 * 60 * 1000).toISOString()],
    );
    await db.run(
      `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "gamesPlayedBeforeStart",
                                 "startedMidMonthAt", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4::date, 'running', 4, 1, now() - interval '2 days', now() - interval '2 days', now())`,
      [MONTH, ORG, ACT, MONTH_START],
    );
    for (const [i, p] of [P.alex, P.bilal, P.chris, P.dave].entries()) {
      await db.run(
        `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, "gamesCovered", "paidClaimedAt", "paidClaimSource", source, "updatedAt")
         VALUES ($1, $2, $3, 'regular', $4, 4, now(), 'organiser', 'seed-list', now())`,
        [`${MONTH}-${p.id}`, MONTH, p.id, i + 1],
      );
    }

    engineOn({
      in: { route: "self_att", facts: selfIn() },
      [GUEST]: { route: "other_att", facts: otherFacts("David Ediz", "in", { personKind: "named" }) },
      [FRIEND]: {
        route: "offer",
        facts: facts([claim({ subject: "other", personRef: "+1", personNamed: false, personKind: "placeholder", polarity: "in" })]),
      },
    });
  });

  test.afterAll(() => {
    resetDb();
  });

  test("Monthly squad: the month's regulars are in every game without saying In", async ({ request, db }) => {
    // The scheduler puts the regulars on the week's match.
    await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(GROUP)}`, {
      headers: { ...KEY, "x-test-now": londonAt(1, 10, 0).toISOString() },
    });
    expect(await rows(db)).toEqual(
      [P.alex, P.bilal, P.chris, P.dave].map((p) => ({ userId: p.id, status: "CONFIRMED", paymentMethod: "monthly" })),
    );
  });

  test("Bringing a friend: a regular says a friend is coming and is DMed a friend link; nobody is added", async ({ request, db }) => {
    const before = await rows(db);
    const users = await db.count(`SELECT COUNT(*) FROM "User"`);
    const r = await say(request, P.alex, FRIEND);
    expect(r?.react, JSON.stringify(r)).toBe("✉️");

    const dms = await db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2`, [ORG, digits(P.alex.phone)]);
    expect(dms).toHaveLength(1);
    expect(dms[0].text).toMatch(/link for your friend/);
    expect(dms[0].text).toMatch(/https?:\/\/\S+\/play\/f\/\S+/);
    expect(await db.all(`SELECT "issuedByUserId" FROM "FriendLink" WHERE "orgId" = $1`, [ORG])).toEqual([{ issuedByUserId: P.alex.id }]);

    expect(await rows(db)).toEqual(before);
    expect(await db.count(`SELECT COUNT(*) FROM "User"`)).toBe(users);
  });

  test("Organiser's guest: the organiser says 'David Ediz is IN' and David is added to the game as a provisional player", async ({ request, db }) => {
    await say(request, P.rob, GUEST);
    const david = await db.one<{ id: string; provisional: boolean }>(
      `SELECT u.id, (m."provisionallyAddedAt" IS NOT NULL) AS provisional
         FROM "User" u JOIN "Membership" m ON m."userId" = u.id AND m."orgId" = $1
        WHERE u.name = 'David Ediz'`,
      [ORG],
    );
    expect(david, "David Ediz was not created in the club").not.toBeNull();
    expect(david?.provisional).toBe(true);
    const row = (await rows(db)).find((x) => x.userId === david!.id);
    expect(row?.status).toBe("CONFIRMED");
    // No friend link for an organiser's guest.
    expect(await db.count(`SELECT COUNT(*) FROM "FriendLink" WHERE "orgId" = $1 AND "issuedByUserId" = $2`, [ORG, P.rob.id])).toBe(0);
  });

  test("Not a regular: when a place is open he says In (no tag) and takes it, paying for that game only", async ({ request, db }) => {
    const r = await say(request, P.tom, "in");
    expect(r?.react, JSON.stringify(r)).toBe("✅");
    const row = (await rows(db)).find((x) => x.userId === P.tom.id);
    // In the game, and not on the month's payment: per game (null), not "monthly".
    expect(row).toEqual({ userId: P.tom.id, status: "CONFIRMED", paymentMethod: null });
    // He did not become a regular of the month.
    expect(
      await db.count(`SELECT COUNT(*) FROM "SquadMonthMember" WHERE "monthId" = $1 AND "userId" = $2 AND kind = 'regular'`, [MONTH, P.tom.id]),
    ).toBe(0);
  });
});
