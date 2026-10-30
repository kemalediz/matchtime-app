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
 *   • teams are built only on match day (a fact);
 *   • whether a message asks for teams is the teams extractor's reading
 *     (2026-10-30, no word test): the joke read as people put together
 *     (`swap` with a pairing, what the rewritten prompt gives) builds
 *     nothing and gets one line;
 *   • on match day "generate the teams" builds, and asking again
 *     replaces the sheet.
 *
 * The clear by message is gone with its word test (2026-10-30): the
 * teams extractor has no `clear` action yet, so "delete these teams" is
 * whatever the extractor reads it as. Pinned below for the reading that
 * matters most: it is never a build before match day.
 *
 * The router and the extractor are STUBBED: no model is called.
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

/** The joke as the rewritten teams prompt reads it: people put together. */
const JOKE_ROUTING = {
  route: "balancer",
  facts: { action: "swap", includeRefs: [], teamNames: [], swaps: [], moves: [], pairings: [["me", "these guys"]], swapSides: false },
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

  test("THE INCIDENT: the pairing joke builds nothing and gets one line", async ({ request, db }) => {
    engineOn({ [JOKE]: JOKE_ROUTING });
    const id = msgId();
    const res = await postAnalyze(request, [
      { waMessageId: id, body: JOKE, authorPhone: PHONE.admin, authorName: NAME.admin, botMentioned: true },
    ]);
    expect(await teamRows(db)).toBe(0);
    expect(await matchStatus(db)).toBe("UPCOMING");
    const r = resultFor(res, id);
    expect(r.reply).toBe("Sorry, I can't do that one yet.");
    expect(r.intent).not.toBe("generate_teams_request");
  });

  test("the pairing joke builds nothing on match day either", async ({ request, db }) => {
    await makeItMatchDay(db);
    engineOn({ [JOKE]: JOKE_ROUTING });
    const id = msgId();
    const res = await postAnalyze(request, [
      { waMessageId: id, body: JOKE, authorPhone: PHONE.admin, authorName: NAME.admin, botMentioned: true },
    ]);
    expect(await teamRows(db)).toBe(0);
    expect(await matchStatus(db)).toBe("UPCOMING");
    expect(resultFor(res, id).reply).toBe("Sorry, I can't do that one yet.");
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

  test("on match day, 'generate the teams' costs ONE teams extractor call (Sutton FC, 2026-10-20)", async ({
    request,
    db,
  }) => {
    // Production, batch f3898ab5: the teams extractor ran twice on this
    // message, once for the answer owner and once for team-ops, with the
    // same input and the same facts. Distinct prices make the ledger say
    // how many of each call were billed.
    await makeItMatchDay(db);
    await db.run(`DELETE FROM "OrgAiUsage"`);
    engineOn({ [GEN]: GEN_ROUTING }, { routerCostUsd: 0.01, extractorCostUsd: 0.001 });
    const id = msgId();
    await postAnalyze(request, [
      { waMessageId: id, body: GEN, authorPhone: PHONE.admin, authorName: NAME.admin, botMentioned: true },
    ]);
    expect(await teamRows(db)).toBe(4);

    const usage = await db.one<{ calls: number; costUsd: number }>(
      `SELECT SUM(calls)::int AS calls, SUM("costUsd") AS "costUsd" FROM "OrgAiUsage"`,
    );
    expect(Number(usage?.costUsd), "one router call and ONE extractor call").toBeCloseTo(0.011, 6);
    expect(usage?.calls).toBe(2);

    const row = await db.one<{ pipelineTrace: { extractions: Array<Record<string, unknown>> } }>(
      `SELECT "pipelineTrace" FROM "AnalyzedMessage" WHERE "waMessageId" = $1`,
      [id],
    );
    expect(row!.pipelineTrace.extractions).toHaveLength(1);
    expect(row!.pipelineTrace.extractions[0]).toMatchObject({
      owner: "answer",
      extractor: "teams",
      sharedWith: ["team_ops"],
      facts: { kind: "teams", action: "generate" },
    });
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

test.describe("'delete these teams' is never a build before match day", () => {
  test.beforeEach(async ({ db }) => {
    resetDb();
    await twoASide(db);
    await seedPublishedSheet(db);
  });

  test("even read as generate, nothing is rebuilt before match day and the sheet stands", async ({ request, db }) => {
    engineOn({ [CLEAR]: GEN_ROUTING });
    const id = msgId();
    const res = await postAnalyze(request, [
      { waMessageId: id, body: CLEAR, authorPhone: PHONE.admin, authorName: NAME.admin, botMentioned: true },
    ]);
    expect(await teamRows(db)).toBe(4);
    expect(await matchStatus(db)).toBe("TEAMS_PUBLISHED");
    expect(resultFor(res, id).reply).toBe("I'll build the teams on match day, just ask me then.");
  });
});
