/**
 * THE 2026-09-29 SUTTON FC LATE COPY, END TO END THROUGH THE REAL ROUTE.
 *
 *   ~11:30 UTC  the admin: "@Match Time generate the teams. Put me on red
 *               team." Baileys could not decrypt it (a CIPHERTEXT stub).
 *   22:00:38    WhatsApp delivered a readable copy, 10.5 hours later and
 *               after the match. The route treated it as fresh and told
 *               the group "I'll build the teams on match day, just ask me
 *               then."
 *
 * The rule (Kemal approved), pinned against Postgres: a message whose
 * ORIGINAL timestamp is more than 30 minutes old records attendance
 * silently (the registration react is kept) and executes nothing else,
 * and the batch leaves one `late-message` event on /admin/health. Never
 * a DM. A fresh copy of the same message still works exactly as before.
 *
 * Router and extractor are STUBBED; no model is called.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { engineOn, selfIn, selfOut } from "../helpers/stub";
import { U, PHONE, MATCH, NAME, SPORT_ID, londonAt } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

let n = 0;
const msgId = () => `e2e-late-${Date.now()}-${++n}`;

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const sentAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

const INCIDENT = "@Match Time generate the teams. Put me on red team.";
const GEN_ROUTING = {
  route: "balancer",
  facts: { action: "generate", includeRefs: [], teamNames: null, swaps: [], pairings: [["me", "red"]] },
};
const PLAIN_GEN = "@Match Time generate the teams";
const PLAIN_GEN_ROUTING = {
  route: "balancer",
  facts: { action: "generate", includeRefs: [], teamNames: null, swaps: [], pairings: [] },
};

type Result = { waMessageId: string; reply: string | null; react: string | null; intent: string | null };
function resultFor(res: { results: Result[] }, id: string): Result {
  const r = res.results.find((x) => x.waMessageId === id);
  expect(r, JSON.stringify(res.results)).toBeTruthy();
  return r!;
}

const teamRows = (db: TestDb) =>
  db.count(`SELECT COUNT(*) FROM "TeamAssignment" WHERE "matchId" = $1`, [MATCH.upcoming]);
const lateAlerts = (db: TestDb) =>
  db.all<{ title: string; detail: string; severity: string }>(
    `SELECT title, detail, severity::text AS severity FROM "OpsAlert" WHERE kind = 'late-message'`,
  );
const dmCount = (db: TestDb) => db.count(`SELECT COUNT(*) FROM "BotJob" WHERE kind = 'dm'`);
const analyzed = (db: TestDb, id: string) =>
  db.one<{ handledBy: string; reasoning: string }>(
    `SELECT "handledBy", reasoning FROM "AnalyzedMessage" WHERE "waMessageId" = $1`,
    [id],
  );
const status = (db: TestDb, userId: string) =>
  db.one<{ status: string }>(`SELECT status::text AS status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [
    MATCH.upcoming,
    userId,
  ]);

/** The seed's completed pay match kicked off 3 hours ago. Move it back
 *  two days so a 10.5-hour-old message is late but NOT overtaken by a
 *  kickoff, which is the incident's own path through the gate. */
async function noRecentKickoff(db: TestDb): Promise<void> {
  await db.run(`UPDATE "Match" SET date = $2 WHERE id = $1`, [
    MATCH.pay,
    new Date(Date.now() - 48 * HOUR).toISOString(),
  ]);
}

async function makeItMatchDay(db: TestDb): Promise<void> {
  await db.run(`UPDATE "Sport" SET "playersPerTeam" = 2 WHERE id = $1`, [SPORT_ID]);
  const kickoff = londonAt(0, 23, 30);
  await db.run(`UPDATE "Match" SET date = $2, "attendanceDeadline" = $3 WHERE id = $1`, [
    MATCH.upcoming,
    kickoff.toISOString(),
    new Date(kickoff.getTime() - 5 * HOUR).toISOString(),
  ]);
}

test.describe("a message that arrives more than 30 minutes late", () => {
  test.beforeEach(async ({ db }) => {
    resetDb();
    await noRecentKickoff(db);
  });

  test("THE INCIDENT: the 10.5-hour-old copy gets no reply, builds nothing, and is recorded for /admin/health", async ({
    request,
    db,
  }) => {
    engineOn({ [INCIDENT]: GEN_ROUTING });
    const dmsBefore = await dmCount(db);
    const id = msgId();
    const res = await postAnalyze(request, [
      {
        waMessageId: id,
        body: INCIDENT,
        authorPhone: PHONE.admin,
        authorName: NAME.admin,
        botMentioned: true,
        timestamp: sentAgo(10.5 * HOUR),
      },
    ]);
    const r = resultFor(res, id);
    expect(r.reply).toBeNull();
    expect(r.react).toBeNull();
    expect(await teamRows(db)).toBe(0);
    expect((await analyzed(db, id))?.handledBy).toBe("late-message");

    const alerts = await lateAlerts(db);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("info");
    expect(alerts[0].detail).toContain("10h 30m late");
    expect(alerts[0].detail).toContain("generate the teams");
    expect(alerts[0].detail).toContain("not executed");
    expect(alerts[0].title + alerts[0].detail).not.toMatch(/[—–]/);
    // Never a DM.
    expect(await dmCount(db)).toBe(dmsBefore);
  });

  test("the same message sent just now still gets its answer", async ({ request, db }) => {
    engineOn({ [INCIDENT]: GEN_ROUTING });
    const id = msgId();
    const res = await postAnalyze(request, [
      { waMessageId: id, body: INCIDENT, authorPhone: PHONE.admin, authorName: NAME.admin, botMentioned: true },
    ]);
    // Not match day: today's (unchanged) polite line.
    expect(resultFor(res, id).reply).toBe("I'll build the teams on match day, just ask me then.");
    expect(await lateAlerts(db)).toHaveLength(0);
  });

  test("on match day a late 'generate the teams' builds nothing, and a fresh one builds them", async ({
    request,
    db,
  }) => {
    await makeItMatchDay(db);
    engineOn({ [PLAIN_GEN]: PLAIN_GEN_ROUTING });
    const late = msgId();
    const lateRes = await postAnalyze(request, [
      {
        waMessageId: late,
        body: PLAIN_GEN,
        authorPhone: PHONE.admin,
        authorName: NAME.admin,
        botMentioned: true,
        timestamp: sentAgo(45 * MIN),
      },
    ]);
    expect(resultFor(lateRes, late).reply).toBeNull();
    expect(await teamRows(db)).toBe(0);

    const fresh = msgId();
    const freshRes = await postAnalyze(request, [
      { waMessageId: fresh, body: PLAIN_GEN, authorPhone: PHONE.admin, authorName: NAME.admin, botMentioned: true },
    ]);
    expect(await teamRows(db), JSON.stringify(freshRes.results)).toBe(4);
    expect(resultFor(freshRes, fresh).intent).toBe("generate_teams_request");
  });

  test("a late deterministic peel (an admin's 'clear the teams') is not executed either", async ({
    request,
    db,
  }) => {
    for (const [userId, team] of [
      [U.admin, "RED"],
      [U.player, "YELLOW"],
    ] as const) {
      await db.run(
        `INSERT INTO "TeamAssignment" (id, "matchId", "userId", team) VALUES ($1, $2, $3, $4::"Team")`,
        [`e2e-ta-late-${userId}`, MATCH.upcoming, userId, team],
      );
    }
    const id = msgId();
    const res = await postAnalyze(request, [
      {
        waMessageId: id,
        body: "@Match Time clear the teams",
        authorPhone: PHONE.admin,
        authorName: NAME.admin,
        botMentioned: true,
        timestamp: sentAgo(90 * MIN),
      },
    ]);
    expect(resultFor(res, id).reply).toBeNull();
    expect(await teamRows(db)).toBe(2);
    // The peel never saw it. (With no router stub it is routed `unsure`,
    // which the attendance engine owns and on which it finds nothing.)
    expect((await analyzed(db, id))?.handledBy).not.toBe("fast-path");
    expect((await lateAlerts(db))).toHaveLength(1);
  });

  test("a late IN is recorded, keeps its ✅, and says nothing", async ({ request, db }) => {
    engineOn({ "in for tuesday": { route: "self_att", facts: selfIn() } });
    const id = msgId();
    const res = await postAnalyze(request, [
      {
        waMessageId: id,
        body: "in for tuesday",
        authorPhone: PHONE.fresh,
        authorName: NAME.fresh,
        timestamp: sentAgo(45 * MIN),
      },
    ]);
    const r = resultFor(res, id);
    expect(["CONFIRMED", "BENCH"]).toContain((await status(db, U.fresh))?.status);
    expect(["✅", "🪑"]).toContain(r.react);
    expect(r.reply).toBeNull();
    const alerts = await lateAlerts(db);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].detail).toContain("attendance recorded");
  });

  test("a late question in the same batch as a fresh IN: the question is silent, the IN works", async ({
    request,
    db,
  }) => {
    const ASK = "@Match Time who is playing tuesday?";
    engineOn({
      [ASK]: { route: "question" },
      in: { route: "self_att", facts: selfIn() },
    });
    const ask = msgId();
    const inId = msgId();
    const res = await postAnalyze(request, [
      {
        waMessageId: ask,
        body: ASK,
        authorPhone: PHONE.rater,
        authorName: NAME.rater,
        botMentioned: true,
        timestamp: sentAgo(2 * HOUR),
      },
      { waMessageId: inId, body: "in", authorPhone: PHONE.extra, authorName: NAME.extra },
    ]);
    expect(resultFor(res, ask).reply).toBeNull();
    expect(resultFor(res, ask).react).toBeNull();
    expect(["CONFIRMED", "BENCH"]).toContain((await status(db, U.extra))?.status);
    expect(resultFor(res, inId).react).not.toBeNull();
  });
});

test.describe("a late attendance change overtaken by a kickoff", () => {
  test.beforeEach(() => {
    resetDb();
  });

  test("an OUT sent before a match that has since kicked off is not recorded, and is reported", async ({
    request,
    db,
  }) => {
    // The seed's pay match kicked off 3 hours ago; this OUT was sent 4.
    engineOn({ "out sorry": { route: "self_att", facts: selfOut() } });
    const id = msgId();
    const res = await postAnalyze(request, [
      {
        waMessageId: id,
        body: "out sorry",
        authorPhone: PHONE.player,
        authorName: NAME.player,
        timestamp: sentAgo(4 * HOUR),
      },
    ]);
    const r = resultFor(res, id);
    expect(r.reply).toBeNull();
    expect(r.react).toBeNull();
    expect((await status(db, U.player))?.status).toBe("CONFIRMED");
    expect((await analyzed(db, id))?.handledBy).toBe("late-message");
    const alerts = await lateAlerts(db);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].detail).toContain("a match kicked off");
  });
});
