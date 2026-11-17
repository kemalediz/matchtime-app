/**
 * WHEN A PLACE OPENS, THE FIRST ON THE BENCH MOVES UP (2026-11-17).
 *
 * ── THE INCIDENT: Sutton FC, Tue 17 Nov 2026, 13:33 London ───────────
 *
 * The 21:30 7-a-side, 14 places, full, with Recai on the bench. The
 * organiser wrote "ok @David is out in this case" and, in the same batch,
 * "@Match Time what is the list?". MatchTime:
 *   1. answered "13/14, need 1 more 🙏" with "Bench (1): Recai" under it;
 *   2. posted "🎟 A slot just opened … *First to claim it plays.*" tagging
 *      Recai alone;
 *   3. waited for the organiser to write "Recai is IN".
 * The players laughed.
 *
 * Driven here through the real routes (analyze, then a scheduler tick),
 * model-free: the router and the extractor are stubbed ($0). Made-up
 * people, 07700 900xxx numbers.
 */
import { test, expect, resetDb } from "../fixtures";
import { createGroup, type SimGroup, type SimPlayerSpec } from "./group";
import { londonAt } from "../helpers/constants";
import { claim, clearExtractorStub, clearRouterStub, facts, otherFacts } from "../helpers/stub";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

/** Ofcom's drama range, 07700 900xxx, in a block no other spec uses. */
let nextPhone = 340;
function phone(): string {
  const n = nextPhone++;
  return `+447700900${String(n).padStart(3, "0")}`;
}

function roster(): SimPlayerSpec[] {
  return [
    { key: "owner", name: "Oscar Owner", role: "OWNER", phone: phone() },
    { key: "alice", name: "Alice Admin", role: "ADMIN", phone: phone() },
    { key: "pete", name: "Pete Power", phone: phone() },
    { key: "dan", name: "Dan Drummer", phone: phone() },
    { key: "felix", name: "Felix Fox", phone: phone() },
    { key: "greg", name: "Greg Gale", phone: phone() },
    { key: "henry", name: "Henry Hill", phone: phone() },
    { key: "quinn", name: "Quinn Quick", phone: phone() },
    { key: "ryan", name: "Ryan Reef", phone: phone() },
  ];
}

const SEVEN = ["owner", "alice", "pete", "dan", "felix", "greg", "henry"] as const;

const DROP = "ok @Pete is out in this case";
const LIST = "@Match Time what is the list?";
const QUINN_OUT = "sorry lads cant make it after all";

/** A full 7 with the given players waiting on the bench, kickoff tonight. */
async function fullSquad(request: Parameters<typeof createGroup>[0], db: Parameters<typeof createGroup>[1], bench: string[]): Promise<SimGroup> {
  const g = await createGroup(request, db, {
    maxPlayers: 7,
    players: roster(),
    upcomingMatch: { hoursFromNow: 8 },
    attendance: [...SEVEN.map((key) => ({ key, status: "CONFIRMED" as const })), ...bench.map((key) => ({ key, status: "BENCH" as const }))],
  });
  return g;
}

/** The organiser's drop and his list question, in one batch, as on the day. */
async function dropAndAsk(g: SimGroup) {
  return g.postBatch([
    { player: "alice", body: DROP, route: "other_att", facts: otherFacts("Pete", "out") },
    { player: "alice", body: LIST, tag: true, route: "question", facts: { topic: "squad", personRef: null, statedCount: null } },
  ]);
}

/** Everything the group could read from the analyze call. */
function groupTexts(res: { results: Array<{ reply: string | null }>; groupPosts: string[] }): string[] {
  return [...res.results.map((r) => r.reply ?? "").filter((t) => t.length > 0), ...res.groupPosts];
}

async function botJobs(g: SimGroup, db: Parameters<typeof createGroup>[1], kind: string) {
  return db.all<{ phone: string | null; text: string; matchId: string | null }>(
    `SELECT phone, text, "matchId" FROM "BotJob" WHERE "orgId" = $1 AND kind = $2 ORDER BY "createdAt" ASC`,
    [g.orgId, kind],
  );
}

(LIVE ? test.describe.skip : test.describe)("the bench fills an open place (2026-11-17)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(resetDb);
  test.afterEach(() => {
    clearRouterStub();
    clearExtractorStub();
  });

  test("THE INCIDENT: drop + 'what is the list?' → he moves up, is DMed, the list is full, no race", async ({ request, db }) => {
    const g = await fullSquad(request, db, ["quinn"]);
    const res = await dropAndAsk(g);

    // The rows: Pete out, Quinn in, nobody waiting, no offer.
    expect((await g.attendanceOf("pete"))?.status).toBe("DROPPED");
    expect((await g.attendanceOf("quinn"))?.status).toBe("CONFIRMED");
    expect(await g.counts()).toMatchObject({ confirmed: 7, bench: 0 });
    expect(await g.openOffers()).toEqual([]);

    // The list the organiser asked for, read from the database after the
    // drop: full, Quinn on it, and never "need 1 more".
    const said = groupTexts(res).join("\n\n");
    expect(said).toContain("7/7");
    expect(said).toContain("Quinn Quick");
    expect(said).not.toMatch(/need \*?\d+ more/);
    expect(said).not.toMatch(/first to claim/i);

    // The group is told who moved up, once.
    const posts = await botJobs(g, db, "group");
    const movedUp = posts.filter((p) => p.text.includes("moves up from the bench"));
    expect(movedUp).toHaveLength(1);
    expect(movedUp[0].text).toContain("⬆️ *Quinn Quick* moves up from the bench, replacing *Pete Power*");

    // Quinn is DMed: he is in, and OUT passes the place on.
    const dms = (await botJobs(g, db, "dm")).filter((d) => d.phone === g.player("quinn").phone!.replace(/^\+/, ""));
    expect(dms).toHaveLength(1);
    expect(dms[0].text).toContain("you were first on the bench, so you're in now");
    expect(dms[0].text).toContain("reply *OUT* here");

    // The scheduler has no race to post.
    const tick = await g.duePosts(londonAt(0, 13, 35), { claim: true });
    expect(tick.filter((i) => i.kind === "bench-prompt")).toEqual([]);
    expect(tick.filter((i) => /first to claim|slot just opened/i.test(i.text ?? ""))).toEqual([]);
  });

  test("two on the bench: the first in bench order moves up, the second waits", async ({ request, db }) => {
    const g = await fullSquad(request, db, ["quinn", "ryan"]);
    await dropAndAsk(g);
    expect((await g.attendanceOf("quinn"))?.status).toBe("CONFIRMED");
    expect((await g.attendanceOf("ryan"))?.status).toBe("BENCH");
    expect(await g.openOffers()).toEqual([]);
    const tick = await g.duePosts(londonAt(0, 13, 35), { claim: true });
    expect(tick.filter((i) => i.kind === "bench-prompt")).toEqual([]);
  });

  test("a named replacement keeps his place: 'Ryan in for Pete' with Quinn first on the bench", async ({ request, db }) => {
    // The batch's writes land first (Pete out, Ryan in), then the bench
    // fills what is left: nothing. Quinn is not jumped in ahead of the
    // player the organiser named.
    const g = await fullSquad(request, db, ["quinn", "ryan"]);
    await g.postBatch([
      {
        player: "alice",
        body: "@Match Time Ryan in for Pete",
        tag: true,
        route: "other_att",
        facts: facts([
          claim({ subject: "other", personRef: "Pete", personNamed: true, polarity: "out" }),
          claim({ subject: "other", personRef: "Ryan", personNamed: true, polarity: "in" }),
        ]),
      },
    ]);
    expect((await g.attendanceOf("pete"))?.status).toBe("DROPPED");
    expect((await g.attendanceOf("ryan"))?.status).toBe("CONFIRMED");
    expect((await g.attendanceOf("quinn"))?.status).toBe("BENCH");
    expect(await g.counts()).toMatchObject({ confirmed: 7, bench: 1 });
    expect((await botJobs(g, db, "dm")).filter((d) => d.text.includes("first on the bench"))).toEqual([]);
  });

  test("a named replacement from outside the bench keeps his place too", async ({ request, db }) => {
    const g = await fullSquad(request, db, ["quinn"]);
    await g.postBatch([
      {
        player: "alice",
        body: "@Match Time Ryan is replacing Pete",
        tag: true,
        route: "other_att",
        facts: facts([
          claim({ subject: "other", personRef: "Pete", personNamed: true, polarity: "out" }),
          claim({ subject: "other", personRef: "Ryan Reef", personNamed: true, polarity: "in" }),
        ]),
      },
    ]);
    expect((await g.attendanceOf("ryan"))?.status).toBe("CONFIRMED");
    expect((await g.attendanceOf("quinn"))?.status).toBe("BENCH");
  });

  test("the moved-up player says OUT: the next one on the bench moves up", async ({ request, db }) => {
    const g = await fullSquad(request, db, ["quinn", "ryan"]);
    await dropAndAsk(g);
    await g.postBatch([{ player: "quinn", body: QUINN_OUT, route: "self_att", facts: facts([claim({ polarity: "out" })]) }]);
    expect((await g.attendanceOf("quinn"))?.status).toBe("DROPPED");
    expect((await g.attendanceOf("ryan"))?.status).toBe("CONFIRMED");
    expect(await g.counts()).toMatchObject({ confirmed: 7, bench: 0 });
    const dms = (await botJobs(g, db, "dm")).filter((d) => d.phone === g.player("ryan").phone!.replace(/^\+/, ""));
    expect(dms).toHaveLength(1);
    expect(dms[0].text).toContain("you're in now");
  });

  test("the moved-up player says OUT with nobody left: the place is open, no offer, no race", async ({ request, db }) => {
    const g = await fullSquad(request, db, ["quinn"]);
    await dropAndAsk(g);
    await g.postBatch([{ player: "quinn", body: QUINN_OUT, route: "self_att", facts: facts([claim({ polarity: "out" })]) }]);
    expect(await g.counts()).toMatchObject({ confirmed: 6, bench: 0 });
    expect(await g.openOffers()).toEqual([]);
    const tick = await g.duePosts(londonAt(0, 13, 40), { claim: true });
    expect(tick.filter((i) => i.kind === "bench-prompt" || /first to claim/i.test(i.text ?? ""))).toEqual([]);
  });

  test("an organiser-pick club keeps its behaviour: nobody moves up by itself, no race", async ({ request, db }) => {
    const g = await fullSquad(request, db, ["quinn"]);
    await db.run(`UPDATE "Organisation" SET "benchPickMode" = 'organiser' WHERE id = $1`, [g.orgId]);
    await dropAndAsk(g);
    expect((await g.attendanceOf("quinn"))?.status).toBe("BENCH");
    expect(await g.openOffers()).toEqual([]);
    expect((await botJobs(g, db, "group")).filter((p) => p.text.includes("moves up from the bench"))).toEqual([]);
    expect((await botJobs(g, db, "dm")).filter((d) => d.text.includes("you're in now"))).toEqual([]);
  });

  test("the scheduler heals a squad left short beside a bench by any other path", async ({ request, db }) => {
    const g = await fullSquad(request, db, ["quinn"]);
    // Pete dropped behind MatchTime's back (a direct write, as a race or a
    // path outside the attendance functions would leave it).
    await db.run(`UPDATE "Attendance" SET status = 'DROPPED' WHERE "matchId" = $1 AND "userId" = $2`, [g.matchId, g.player("pete").userId]);
    const tick = await g.duePosts(londonAt(0, 13, 35), { claim: true });
    expect((await g.attendanceOf("quinn"))?.status).toBe("CONFIRMED");
    expect(tick.filter((i) => /need \*?\d+ more/.test(i.text ?? "") && /Bench/.test(i.text ?? ""))).toEqual([]);
  });

  test("a monthly club: the first on the bench moves up and takes the away regular's slot number", async ({ request, db }) => {
    const g = await fullSquad(request, db, ["quinn"]);
    await db.run(`UPDATE "Organisation" SET "squadMode" = 'monthly', "paygPricePence" = 800 WHERE id = $1`, [g.orgId]);
    const kickoff = (await db.one<{ date: Date }>(`SELECT date FROM "Match" WHERE id = $1`, [g.matchId]))!.date;
    const monthStart = `${kickoff.toISOString().slice(0, 7)}-01`;
    const monthId = `sim-month-${g.orgId}`;
    await db.run(
      `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "gamesPlayedBeforeStart", "startedMidMonthAt", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4::date, 'running', 4, 0, now() - interval '2 days', now() - interval '2 days', now())`,
      [monthId, g.orgId, g.activityId, monthStart],
    );
    // The seven are the month's regulars in slots 1 to 7; Quinn pays per game.
    for (const [i, key] of SEVEN.entries()) {
      await db.run(
        `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, "gamesCovered", "paidAt", "absentMatchIds", source, "updatedAt")
         VALUES ($1, $2, $3, 'regular', $4, 4, now(), '{}', 'seed-list', now())`,
        [`${monthId}-${key}`, monthId, g.player(key).userId, i + 1],
      );
      await db.run(`UPDATE "Attendance" SET position = $1 WHERE "matchId" = $2 AND "userId" = $3`, [i + 1, g.matchId, g.player(key).userId]);
    }
    await db.run(
      `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, "gamesCovered", "paidAt", "absentMatchIds", source, "updatedAt")
       VALUES ($1, $2, $3, 'payg', NULL, 0, NULL, '{}', 'seed-list', now())`,
      [`${monthId}-quinn`, monthId, g.player("quinn").userId],
    );
    await db.run(`UPDATE "Attendance" SET position = 8 WHERE "matchId" = $1 AND "userId" = $2`, [g.matchId, g.player("quinn").userId]);
    await db.run(`UPDATE "Match" SET "rollingSeededAt" = now() WHERE id = $1`, [g.matchId]);

    await dropAndAsk(g);
    const quinn = await db.one<{ status: string; position: number }>(
      `SELECT status, position FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
      [g.matchId, g.player("quinn").userId],
    );
    expect(quinn?.status).toBe("CONFIRMED");
    // Pete was regular number 3: Quinn plays in his slot.
    expect(quinn?.position).toBe(3);
    expect(await g.openOffers()).toEqual([]);
    const tick = await g.duePosts(londonAt(0, 13, 35), { claim: true });
    expect(tick.filter((i) => i.kind === "bench-prompt" || /first to claim/i.test(i.text ?? ""))).toEqual([]);
  });
});
