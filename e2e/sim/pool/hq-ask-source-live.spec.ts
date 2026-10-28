/**
 * WHERE THE PLAYERS COME FROM, ASKED IN HQ, LIVE (2026-10-28): the real
 * router and the real admin extractor on the real HQ route, no stub. PAID:
 * Haiku 5.5, a router and an extractor call per message (about $0.001 a
 * message), on ANTHROPIC_API_KEY_DEV only.
 *
 *   MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/pool/hq-ask-source-live.spec.ts
 *
 * A club with a partner club and the pool: an ask that does not say where
 * from gets the one question; "the pool" then asks the pool, "partners"
 * the partner club. The stubbed twin is `hq-ask-source.spec.ts`.
 */
import { scenario, scenarios, liveOnly, expect } from "./fixtures";
import { near, openClub, poolPlayer } from "./offers-world";
import type { PoolWorld } from "./world";
import { londonDateTimeToUtc, formatLondon } from "../../../src/lib/london-time";

type Club = Awaited<ReturnType<typeof openClub>>;
const QUESTION = "Who shall I ask for players: your players' group, your partner clubs, or the MatchTime player pool?";

async function hqClub(pool: PoolWorld, key: string, partnerKey: string): Promise<Club> {
  const club = await openClub(pool, key, { name: "FNF", hq: true, maxPlayers: 1 });
  const kickoff = londonDateTimeToUtc(formatLondon(new Date(Date.now() + 48 * 3600_000), "yyyy-MM-dd"), "20:00");
  await pool.db.run(`UPDATE "Match" SET date = $2, "attendanceDeadline" = $2 WHERE id = $1`, [club.group.matchId, kickoff]);
  await pool.db.run(`UPDATE "Organisation" SET "partnerAskCutoffHours" = 2, "partnerAskWhen" = 'on-request' WHERE id = $1`, [club.group.orgId]);
  const partner = await pool.club(partnerKey, { name: "Cheam Lads", upcomingMatch: false });
  await pool.db.run(
    `INSERT INTO "ClubPartnership" (id, "askerOrgId", "partnerOrgId", status, "partnerApproval", "askerAcceptedAt", "partnerAcceptedAt", "createdByUserId", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'active', 'each-ask', now(), now(), $4, now(), now())`,
    [`sim-pship-${partnerKey}-${Date.now()}`, club.group.orgId, partner.group.orgId, (await pool.userOf(club.member("owner")))!.id],
  );
  return Object.assign(club, { kickoff });
}

const at = (club: Club, hoursBefore: number, plusMin = 0) => new Date(club.kickoff.getTime() - hoursBefore * 3600_000 + plusMin * 60_000);

scenarios("players asked for in HQ with no source named (live model)", () => {
  scenario("'@Match Time we need a player for Thursday' -> the question -> 'the pool' -> the pool is asked", async ({ pool }) => {
    liveOnly();
    const fnf = await hqClub(pool, "lsrc1", "lcheam1");
    await poolPlayer(pool, "lali", { name: "Ali Kaya", at: near(fnf) });
    const asked = await fnf.hq.say("owner", "@Match Time we need a player for Thursday", { now: at(fnf, 30), poolOpen: true });
    expect(asked.sent.find((m) => m.to === "lsrc1.hq")?.text).toBe(QUESTION);
    const answered = await fnf.hq.say("owner", "the pool", { now: at(fnf, 30, 2), poolOpen: true });
    expect(answered.json).toMatchObject({ outcome: "hq-pool-asked" });
    expect(await pool.db.all(`SELECT via FROM "PoolAsk" WHERE "orgId" = $1`, [fnf.group.orgId])).toEqual([{ via: "words" }]);
    expect(await pool.db.all(`SELECT id FROM "PartnerAsk" WHERE "askerOrgId" = $1`, [fnf.group.orgId])).toEqual([]);
  });

  scenario("'@Match Time bize oyuncu bul' -> the question -> 'partner kulüplere' -> the partner club is asked", async ({ pool }) => {
    liveOnly();
    const fnf = await hqClub(pool, "lsrc2", "lcheam2");
    const asked = await fnf.hq.say("owner", "@Match Time bize oyuncu bul", { now: at(fnf, 30), poolOpen: true });
    expect(asked.json).toMatchObject({ outcome: "hq-ask-source" });
    const answered = await fnf.hq.say("owner", "partner kulüplere", { now: at(fnf, 30, 1), poolOpen: true });
    expect(answered.json).toMatchObject({ outcome: "xask-words-asked" });
    expect(await pool.db.all(`SELECT "requestedVia" FROM "PartnerAsk" WHERE "askerOrgId" = $1`, [fnf.group.orgId])).toEqual([{ requestedVia: "hq" }]);
    expect(await pool.db.all(`SELECT id FROM "PoolAsk" WHERE "orgId" = $1`, [fnf.group.orgId])).toEqual([]);
  });

  scenario("an explicit pool ask goes straight to the pool, no question", async ({ pool }) => {
    liveOnly();
    const fnf = await hqClub(pool, "lsrc3", "lcheam3");
    await poolPlayer(pool, "lbea", { at: near(fnf) });
    const ex = await fnf.hq.say("owner", "@Match Time ask the player pool for one", { now: at(fnf, 30), poolOpen: true });
    expect(ex.json).toMatchObject({ outcome: "hq-pool-asked" });
  });
});
