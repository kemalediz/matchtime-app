/**
 * THE 2026-09-24 SUTTON FC INCIDENT, END TO END THROUGH THE REAL ROUTE.
 *
 *   Thu 22:51 BST  Kemal: "@Match Time put me in the same team with these
 *                  guys in the match 😀"  (a joke, after a chemistry table)
 *                  → router `balancer`, teams extractor `generate` with
 *                    the pairing ["me", "these guys"], and the balancer
 *                    BUILT the teams for Tue 29 Sep, five days early.
 *   Thu 22:52 BST  Kemal: "@Match Time delete these teams, early to form
 *                  them, there is still 5 days"
 *                  → router `admin_ops`, admin extractor `other`, and
 *                    NOTHING happened and nobody was told.
 *
 * Kemal's rules, pinned here against Postgres:
 *
 *   • a pairing preference builds nothing;
 *   • "generate the teams" before match day gets a polite reply and
 *     builds nothing;
 *   • on match day it builds, and asking again replaces the sheet;
 *   • an admin's "clear the teams" clears; a non-admin's is refused.
 *
 * The router and the extractor are STUBBED with the verdicts production
 * actually produced (from the AnalyzedMessage rows): no model is called.
 * The clear is a deterministic peel before the router, so its messages
 * carry no stub at all; if they needed one this would test the wrong code.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { engineOn } from "../helpers/stub";
import { U, PHONE, MATCH, NAME, SPORT_ID, londonAt } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

let n = 0;
const msgId = () => `e2e-teamsreq-${Date.now()}-${++n}`;

const JOKE = "@Match Time put me in the same team with these guys in the match 😀";
const GEN = "@Match Time generate the teams";
const REGEN = "@Match Time regenerate the teams";
const CLEAR = "@Match Time delete these teams, early to form them, there is still 5 days";

/** The extractor's facts for the joke, verbatim from production. */
const JOKE_ROUTING = {
  route: "balancer",
  facts: { action: "generate", includeRefs: [], teamNames: null, swaps: [], pairings: [["me", "these guys"]] },
};
const GEN_ROUTING = {
  route: "balancer",
  facts: { action: "generate", includeRefs: [], teamNames: null, swaps: [], pairings: [] },
};

async function teamRows(db: TestDb): Promise<number> {
  return db.count(`SELECT COUNT(*) FROM "TeamAssignment" WHERE "matchId" = $1`, [MATCH.upcoming]);
}

async function matchStatus(db: TestDb): Promise<string | undefined> {
  return (
    await db.one<{ v: string }>(`SELECT status::text AS v FROM "Match" WHERE id = $1`, [MATCH.upcoming])
  )?.v;
}

/** The seeded sport is 5-a-side; the seed has 4 confirmed. 2-a-side
 *  lets the real balancer build from the seeded squad. */
async function twoASide(db: TestDb): Promise<void> {
  await db.run(`UPDATE "Sport" SET "playersPerTeam" = 2 WHERE id = $1`, [SPORT_ID]);
}

/** Move the upcoming match to TODAY (London), late evening. ISO
 *  strings, not Dates: the columns are `timestamp` without a zone and
 *  hold UTC, and node-postgres would serialise a Date in local time. */
async function makeItMatchDay(db: TestDb): Promise<void> {
  const kickoff = londonAt(0, 22, 0);
  await db.run(`UPDATE "Match" SET date = $2, "attendanceDeadline" = $3 WHERE id = $1`, [
    MATCH.upcoming,
    kickoff.toISOString(),
    new Date(kickoff.getTime() - 5 * 60 * 60 * 1000).toISOString(),
  ]);
}

/** A published sheet, the state the noon cron left on 25 Sep. */
async function seedPublishedSheet(db: TestDb): Promise<void> {
  const rows: Array<[string, string]> = [
    [U.admin, "RED"],
    [U.player, "RED"],
    [U.collector, "YELLOW"],
    [U.third, "YELLOW"],
  ];
  for (const [userId, team] of rows) {
    await db.run(
      `INSERT INTO "TeamAssignment" (id, "matchId", "userId", team) VALUES ($1, $2, $3, $4::"Team")`,
      [`e2e-ta-teamsreq-${userId}`, MATCH.upcoming, userId, team],
    );
  }
  await db.run(`UPDATE "Match" SET status = 'TEAMS_PUBLISHED' WHERE id = $1`, [MATCH.upcoming]);
}

function resultFor(res: { results: Array<Record<string, unknown>> }, id: string) {
  const r = res.results.find((x) => x.waMessageId === id);
  expect(r, JSON.stringify(res.results)).toBeTruthy();
  return r as { reply: string | null; intent: string };
}

test.describe("teams are built only on a clear ask, only on match day", () => {
  test.beforeEach(async ({ db }) => {
    resetDb();
    await twoASide(db);
  });

  test("THE INCIDENT: the pairing joke five days early builds nothing", async ({ request, db }) => {
    engineOn({ [JOKE]: JOKE_ROUTING });
    const id = msgId();
    const res = await postAnalyze(request, [
      { waMessageId: id, body: JOKE, authorPhone: PHONE.admin, authorName: NAME.admin, botMentioned: true },
    ]);
    expect(await teamRows(db)).toBe(0);
    expect(await matchStatus(db)).toBe("UPCOMING");
    const r = resultFor(res, id);
    expect(r.reply).toBe("I only build the teams on match day, when someone asks me to generate them.");
    expect(r.intent).not.toBe("generate_teams_request");
  });

  test("the pairing joke builds nothing on match day either", async ({ request, db }) => {
    await makeItMatchDay(db);
    engineOn({ [JOKE]: JOKE_ROUTING });
    await postAnalyze(request, [
      { waMessageId: msgId(), body: JOKE, authorPhone: PHONE.admin, authorName: NAME.admin, botMentioned: true },
    ]);
    expect(await teamRows(db)).toBe(0);
    expect(await matchStatus(db)).toBe("UPCOMING");
  });

  test("'generate the teams' before match day gets the polite reply and builds nothing", async ({
    request,
    db,
  }) => {
    engineOn({ [GEN]: GEN_ROUTING });
    const id = msgId();
    const res = await postAnalyze(request, [
      { waMessageId: id, body: GEN, authorPhone: PHONE.admin, authorName: NAME.admin, botMentioned: true },
    ]);
    expect(await teamRows(db)).toBe(0);
    expect(await matchStatus(db)).toBe("UPCOMING");
    expect(resultFor(res, id).reply).toBe("I'll build the teams on match day, just ask me then.");
  });

  test("on match day, 'generate the teams' builds them", async ({ request, db }) => {
    await makeItMatchDay(db);
    engineOn({ [GEN]: GEN_ROUTING });
    const id = msgId();
    const res = await postAnalyze(request, [
      { waMessageId: id, body: GEN, authorPhone: PHONE.admin, authorName: NAME.admin, botMentioned: true },
    ]);
    const r = resultFor(res, id);
    expect(await teamRows(db), JSON.stringify(res.results)).toBe(4);
    expect(await matchStatus(db)).toBe("TEAMS_GENERATED");
    expect(r.intent).toBe("generate_teams_request");
    expect(r.reply).toContain(NAME.admin);
  });

  test("on match day, asking again REPLACES an existing sheet", async ({ request, db }) => {
    await makeItMatchDay(db);
    await seedPublishedSheet(db);
    // A stale slot for somebody who is not confirmed: a real rebuild
    // cannot keep it.
    await db.run(
      `INSERT INTO "TeamAssignment" (id, "matchId", "userId", team) VALUES ($1, $2, $3, 'RED'::"Team")`,
      ["e2e-ta-teamsreq-stale", MATCH.upcoming, U.bench],
    );
    engineOn({ [REGEN]: GEN_ROUTING });
    await postAnalyze(request, [
      { waMessageId: msgId(), body: REGEN, authorPhone: PHONE.admin, authorName: NAME.admin, botMentioned: true },
    ]);
    expect(await teamRows(db)).toBe(4);
    expect(
      await db.count(`SELECT COUNT(*) FROM "TeamAssignment" WHERE "matchId" = $1 AND "userId" = $2`, [
        MATCH.upcoming,
        U.bench,
      ]),
    ).toBe(0);
    expect(await matchStatus(db)).toBe("TEAMS_GENERATED");
  });
});

test.describe("an admin can clear the teams", () => {
  test.beforeEach(async ({ db }) => {
    resetDb();
    await seedPublishedSheet(db);
  });

  test("THE INCIDENT MESSAGE from the admin clears the sheet and says so in one line", async ({
    request,
    db,
  }) => {
    const id = msgId();
    const res = await postAnalyze(request, [
      { waMessageId: id, body: CLEAR, authorPhone: PHONE.admin, authorName: NAME.admin, botMentioned: true },
    ]);
    expect(await teamRows(db)).toBe(0);
    expect(await matchStatus(db)).toBe("UPCOMING");
    const r = resultFor(res, id);
    expect(r.reply).toBe("Teams cleared. I'll build new ones on match day when asked.");
    expect(r.intent).toBe("clear_teams_request");
  });

  test("a NON-ADMIN asking is refused politely and the sheet is untouched", async ({ request, db }) => {
    const id = msgId();
    const res = await postAnalyze(request, [
      {
        waMessageId: id,
        body: "@Match Time clear the teams",
        authorPhone: PHONE.rater, // Riley Rater, an ordinary member
        authorName: NAME.rater,
        botMentioned: true,
      },
    ]);
    expect(await teamRows(db)).toBe(4);
    expect(await matchStatus(db)).toBe("TEAMS_PUBLISHED");
    expect(resultFor(res, id).reply).toBe("Only an admin can clear the teams.");
  });

  test("clearing when there are no teams says so, and nothing else happens", async ({ request, db }) => {
    await db.run(`DELETE FROM "TeamAssignment" WHERE "matchId" = $1`, [MATCH.upcoming]);
    await db.run(`UPDATE "Match" SET status = 'UPCOMING' WHERE id = $1`, [MATCH.upcoming]);
    const id = msgId();
    const res = await postAnalyze(request, [
      { waMessageId: id, body: "@Match Time scrap the teams", authorPhone: PHONE.admin, authorName: NAME.admin, botMentioned: true },
    ]);
    expect(resultFor(res, id).reply).toBe("There are no teams to clear.");
  });
});
