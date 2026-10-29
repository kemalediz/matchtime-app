/**
 * POOL SCENARIOS: A MONTHLY CLUB'S WEEK (Vets MNF, 2026-10-29). Real
 * routes, real database, the real offer page; model-free ($0).
 *
 * Vets MNF play on monthly lists: prepaid regulars are put on each Monday,
 * a regular away frees a place, and they hunt fillers ("We need 2 more").
 * The MatchTime pool and partner clubs work for such a club, in its order:
 *
 *   - the club's own bench and PAYG players have the place first: the
 *     automatic ask waits until the week is seeded, the place offered to
 *     the club's PAYG players, and their hour is up;
 *   - the pool offer states the club's PAYG price (what he pays there);
 *   - a pool guest who takes the place is a PAYG player of that one game:
 *     the away regular's slot number, on the week's list as "(PAYG)", no
 *     month membership, no credit, no "paid by the month" mark;
 *   - an organiser's tagged ask before the week is seeded asks for the
 *     places really open, not every place of the match.
 */
import { scenario, scenarios, stubbedOnly, expect } from "./fixtures";
import { londonOn, near, openClub, pollPlatform, poolPlayer, tapLinkIn, tapOffer, type OpenClubOpts } from "./offers-world";
import type { PoolWorld } from "./world";
import { E2E } from "../../helpers/env";
import { clearPipelineStubs, facts } from "../../helpers/stub";
import { formatLondon } from "@/lib/london-time";

const PI = { "x-api-key": E2E.WHATSAPP_API_KEY };

const ROSTER = [
  { key: "owner", name: "Davide Owner", role: "OWNER" as const },
  { key: "pete", name: "Pete Power" },
  { key: "dan", name: "Dan Drummer" },
  { key: "felix", name: "Felix Fox" },
  { key: "greg", name: "Greg Gale" },
];

type Club = Awaited<ReturnType<typeof openClub>> & { monthId?: string };

/** A monthly club: 4 places, regulars owner, pete, dan and felix in slots
 *  1 to 4 (felix away this week when `felixAway`), greg its PAYG player,
 *  £8 PAYG, the automatic pool ask on at 12:00. */
async function monthlyClub(pool: PoolWorld, key: string, opts: OpenClubOpts & { felixAway?: boolean; maxPlayers?: number } = {}): Promise<Club & { monthId: string }> {
  const { felixAway, ...clubOpts } = opts;
  const club = await openClub(pool, key, {
    name: "Vets MNF",
    maxPlayers: 4,
    players: ROSTER,
    feePerPlayer: 6,
    ...clubOpts,
    pool: { featurePlayerPool: true, poolAutoAsk: true, ...(clubOpts.pool ?? {}) },
  });
  const orgId = club.group.orgId;
  await pool.db.run(
    `UPDATE "Organisation" SET "squadMode" = 'monthly', "paygPricePence" = 800, "partnerAskTime" = '12:00', "partnerAskWhen" = 'off', language = 'en' WHERE id = $1`,
    [orgId],
  );
  const monthId = `sim-month-${key}-${Date.now()}`;
  const monthStart = `${formatLondon(club.kickoff, "yyyy-MM")}-01`;
  await pool.db.run(
    `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "gamesPlayedBeforeStart", "startedMidMonthAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4::date, 'running', 4, 0, now() - interval '2 days', now() - interval '2 days', now())`,
    [monthId, orgId, club.group.activityId, monthStart],
  );
  const members: Array<{ key: string; kind: "regular" | "payg"; slot: number | null; away?: boolean }> = [
    { key: "owner", kind: "regular", slot: 1 },
    { key: "pete", kind: "regular", slot: 2 },
    { key: "dan", kind: "regular", slot: 3 },
    { key: "felix", kind: "regular", slot: 4, away: felixAway },
    { key: "greg", kind: "payg", slot: null },
  ];
  for (const m of members) {
    const userId = club.group.player(m.key).userId;
    await pool.db.run(
      `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, "gamesCovered", "paidAt", "absentMatchIds", source, "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'seed-list', now())`,
      [`${monthId}-${m.key}`, monthId, userId, m.kind, m.slot, m.kind === "payg" ? 0 : 4, m.kind === "regular" ? new Date() : null, m.away ? [club.group.matchId] : []],
    );
  }
  return Object.assign(club, { monthId });
}

interface Instruction {
  kind: string;
  key: string;
  text?: string;
  phone?: string;
  targetUser?: string;
}

/** The scheduler's poll at `now` (the automatic ask and the month's sweep run in it). */
async function schedulerPoll(pool: PoolWorld, club: Club, now: Date): Promise<{ instructions: Instruction[] }> {
  pool.note(`(the scheduler polls ${club.key} at ${now.toISOString()})`);
  const res = await pool.request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(club.group.groupId)}`, {
    headers: { ...PI, "x-mt-platform-jobs": "1", "x-test-now": now.toISOString(), "x-mt-test-pool-open": "1" },
  });
  expect(res.status(), await res.text()).toBe(200);
  const { instructions } = (await res.json()) as { instructions: Instruction[] };
  await pool.collect();
  return { instructions };
}

/** The real clock wrote these rows; the scenario's clock is match day. */
async function stampClubTold(pool: PoolWorld, club: Club, at: Date): Promise<void> {
  const m = club.group.matchId;
  await pool.db.run(`UPDATE "BenchSlotOffer" SET "createdAt" = $2 WHERE "matchId" = $1`, [m, at]);
  await pool.db.run(`UPDATE "SentNotification" SET "createdAt" = $2 WHERE "matchId" = $1 AND (key LIKE $3 OR key LIKE $4)`, [m, at, `${m}:payg-pool-%`, `${m}:month-list:%`]);
}

const poolAsksOf = (pool: PoolWorld, club: Club) =>
  pool.db.all<{ via: string; places: number }>(`SELECT via, places FROM "PoolAsk" WHERE "orgId" = $1`, [club.group.orgId]);

scenarios("the MatchTime player pool for a monthly club's week", () => {
  scenario.afterEach(() => clearPipelineStubs());

  scenario("a regular away: the club's PAYG players first, then the pool an hour later at the PAYG price; the guest is that week's PAYG player", async ({ pool, page }) => {
    const vets = await monthlyClub(pool, "vets", { felixAway: true });
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(vets) });
    const greg = vets.group.player("greg");
    const t0 = londonOn(vets.kickoff, 0, "12:05");

    pool.note("match day, the club's time: the week is seeded and the place goes to the club's PAYG player; the pool is not asked");
    const first = await schedulerPoll(pool, vets, t0);
    expect(first.instructions.some((i) => i.kind === "dm" && i.targetUser === greg.userId && /£8/.test(i.text ?? ""))).toBe(true);
    expect(await poolAsksOf(pool, vets)).toEqual([]);
    const seeded = await pool.db.all<{ userId: string; status: string; position: number; paymentMethod: string | null }>(
      `SELECT "userId", status, position, "paymentMethod" FROM "Attendance" WHERE "matchId" = $1 ORDER BY position`,
      [vets.group.matchId],
    );
    expect(seeded.map((r) => [r.position, r.status])).toEqual([
      [1, "CONFIRMED"],
      [2, "CONFIRMED"],
      [3, "CONFIRMED"],
      [4, "DROPPED"],
    ]);
    await stampClubTold(pool, vets, t0);

    pool.note("half an hour later: still the club's hour");
    await schedulerPoll(pool, vets, londonOn(vets.kickoff, 0, "12:40"));
    expect(await poolAsksOf(pool, vets)).toEqual([]);

    pool.note("an hour after the club's players were told, nobody took it: the pool is asked for the one place");
    const t1 = londonOn(vets.kickoff, 0, "13:10");
    await schedulerPoll(pool, vets, t1);
    expect(await poolAsksOf(pool, vets)).toEqual([{ via: "auto", places: 1 }]);
    const { out } = await pollPlatform(pool, { now: t1 });
    const offer = out.find((m) => m.to === "ali" && m.purpose === "pool-offer");
    expect(offer?.text).toMatch(/needs 1 player/);
    expect(offer?.text).toMatch(/💷 £8 match fee/);

    pool.note("Ali takes it: the away regular's slot, a PAYG player of this game only");
    expect(await tapOffer(pool, page, tapLinkIn(offer!), "yes")).toBe("in");
    await pool.collect();
    expect(
      await pool.db.one(`SELECT status, position, "paymentMethod" FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [vets.group.matchId, ali.userId]),
    ).toEqual({ status: "CONFIRMED", position: 4, paymentMethod: null });
    expect(await pool.db.count(`SELECT count(*) FROM "SquadMonthMember" WHERE "monthId" = $1 AND "userId" = $2`, [vets.monthId, ali.userId])).toBe(0);
    expect(await pool.db.count(`SELECT count(*) FROM "SquadCredit" WHERE "orgId" = $1 AND "userId" = $2`, [vets.group.orgId, ali.userId])).toBe(0);
    expect(await pool.db.count(`SELECT count(*) FROM "BenchSlotOffer" WHERE "matchId" = $1 AND "resolvedAt" IS NULL`, [vets.group.matchId])).toBe(0);

    pool.note("the week's list shows him in slot 4 as PAYG, Felix under paid but can't play");
    const after = await schedulerPoll(pool, vets, londonOn(vets.kickoff, 0, "13:45"));
    const list = after.instructions.find((i) => i.kind === "group-message" && /📋 List for/.test(i.text ?? ""));
    expect(list?.text).toMatch(/\n4\. Ali Kaya \(PAYG\)\n/);
    expect(list?.text).toMatch(/Paid but can't play\n1\. Felix Fox/);
    expect(list?.text).not.toMatch(/places? open/);
    // The month's sweep ran on that poll: he is still not "paid by the month".
    expect((await pool.db.one<{ paymentMethod: string | null }>(`SELECT "paymentMethod" FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [vets.group.matchId, ali.userId]))?.paymentMethod).toBeNull();
    expect(await pool.db.count(`SELECT count(*) FROM "SquadCredit" WHERE "orgId" = $1 AND "userId" = $2`, [vets.group.orgId, ali.userId])).toBe(0);
  });

  scenario("somebody on the club's bench: the pool is not asked", async ({ pool }) => {
    const vets = await monthlyClub(pool, "vbn", { felixAway: true });
    await poolPlayer(pool, "bo", { at: near(vets) });
    const t0 = londonOn(vets.kickoff, 0, "12:05");
    await schedulerPoll(pool, vets, t0);
    // Greg asked for the bench rather than the place.
    await pool.db.run(
      `WITH a AS (INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt") VALUES ($1, $2, $3, 'BENCH', 9, now()) RETURNING "matchId", "userId", status, position)
       INSERT INTO "AttendanceEvent" (id, "matchId", "userId", "orgId", "toStatus", "toPosition", cause, "actorKind") SELECT $4, "matchId", "userId", $5, status, position, 'test-fixture', 'system' FROM a`,
      [`sim-vbn-greg-att`, vets.group.matchId, vets.group.player("greg").userId, `sim-vbn-greg-ev`, vets.group.orgId],
    );
    await schedulerPoll(pool, vets, londonOn(vets.kickoff, 0, "15:00"));
    expect(await poolAsksOf(pool, vets)).toEqual([]);
  });

  scenario("an organiser's tagged ask before the week is seeded: only the place really open is asked for", async ({ pool }) => {
    stubbedOnly();
    // 5 places, 4 regulars not yet put on the match: one place is open, not five.
    const vets = await monthlyClub(pool, "vtg", { maxPlayers: 5 });
    await poolPlayer(pool, "cem", { at: near(vets) });
    const FACTS = {
      action: "recruit",
      payerRef: "",
      count: 0,
      coveredRefs: [],
      undo: false,
      matchDay: "",
      phrase: "",
      note: "",
      lookbackMatches: 0,
      playersFrom: "pool",
      clubRef: "",
      toMatchTime: true,
    };
    const ex = await vets.post("owner", "@Match Time find 2 players from the pool for Monday", {
      route: "offer",
      facts: { ...facts([], { sideRequests: ["recruit"] }), ...FACTS },
      tag: true,
      headers: { "x-mt-test-pool-open": "1" },
    });
    expect(ex.sent.find((m) => m.to === "vtg.group")?.text).toMatch(/for 1 place on /);
    expect(await poolAsksOf(pool, vets)).toEqual([{ via: "words", places: 1 }]);
  });
});
