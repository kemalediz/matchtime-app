/**
 * SEVERAL PLACES, AND THE QUESTION, IN THE PLAYERS' GROUP, LIVE
 * (2026-10-28): the real router and the real extractors on the real analyze
 * route, no stub. PAID: Haiku 5.5, two or three calls per message (about
 * $0.001 a call), on ANTHROPIC_API_KEY_DEV only.
 *
 *   MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/pool/group-ask-source-live.spec.ts
 *
 * Friday MT Community's own words: "@Match Time find me players feom
 * partner clubs and player pool" asks the partner club and the pool joins
 * that round; an unclear ask gets the question, and "the pool" then asks
 * the pool. The stubbed twin is `group-ask-source.spec.ts`.
 */
import { scenario, scenarios, liveOnly, expect } from "./fixtures";
import { near, openClub, poolPlayer } from "./offers-world";
import type { PoolWorld } from "./world";

type Club = Awaited<ReturnType<typeof openClub>>;
const QUESTION = "Who shall I ask for players: your recent players, your partner clubs, or the MatchTime player pool?";

async function noHqClub(pool: PoolWorld, key: string, partnerKey: string): Promise<Club> {
  const club = await openClub(pool, key, { name: "Friday MT Community", maxPlayers: 1, kickoffInHours: 48 });
  await pool.db.run(`UPDATE "Organisation" SET "partnerAskCutoffHours" = 2, "partnerAskWhen" = 'on-request' WHERE id = $1`, [club.group.orgId]);
  const partner = await pool.club(partnerKey, { name: "Cheam Lads", upcomingMatch: false });
  await pool.db.run(
    `INSERT INTO "ClubPartnership" (id, "askerOrgId", "partnerOrgId", status, "partnerApproval", "askerAcceptedAt", "partnerAcceptedAt", "createdByUserId", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'active', 'each-ask', now(), now(), $4, now(), now())`,
    [`sim-pship-${partnerKey}-${Date.now()}`, club.group.orgId, partner.group.orgId, (await pool.userOf(club.member("owner")))!.id],
  );
  return club;
}

const say = (club: Club, member: string, text: string, tag = true) => club.post(member, text, { tag, headers: { "x-mt-test-pool-open": "1" } });

scenarios("players asked for in the players' group (live model)", () => {
  scenario("the live case: 'find me players feom partner clubs and player pool' -> the partner club asked, the pool joins its round", async ({ pool }) => {
    liveOnly();
    const fmc = await noHqClub(pool, "lgas1", "lgcheam1");
    await poolPlayer(pool, "lgali1", { at: near(fmc) });
    const ex = await say(fmc, "owner", "@Match Time find me players feom partner clubs and player pool");
    const xasks = await pool.db.all<{ roundId: string | null }>(`SELECT "roundId" FROM "PartnerAsk" WHERE "askerOrgId" = $1`, [fmc.group.orgId]);
    expect(xasks).toHaveLength(1);
    expect(await pool.db.all(`SELECT via, "roundId" FROM "PoolAsk" WHERE "orgId" = $1`, [fmc.group.orgId])).toEqual([{ via: "words", roundId: xasks[0].roundId }]);
    const line = ex.sent.find((m) => m.to === "lgas1.group")?.text ?? "";
    expect(line).toMatch(/Cheam Lads/);
    expect(line).toMatch(/MatchTime player pool/);
    expect(line).not.toMatch(/No new players|None of your recent players/);
  });

  scenario("'@Match Time find us a player for Friday' -> the question -> 'the pool' -> the pool is asked", async ({ pool }) => {
    liveOnly();
    const fmc = await noHqClub(pool, "lgas2", "lgcheam2");
    await poolPlayer(pool, "lgbea2", { at: near(fmc) });
    const asked = await say(fmc, "owner", "@Match Time find us a player for Friday");
    expect(asked.sent.find((m) => m.to === "lgas2.group")?.text).toBe(QUESTION);
    expect(await pool.db.all(`SELECT id FROM "PoolAsk" WHERE "orgId" = $1`, [fmc.group.orgId])).toEqual([]);
    await say(fmc, "owner", "the pool", false);
    expect(await pool.db.all(`SELECT via FROM "PoolAsk" WHERE "orgId" = $1`, [fmc.group.orgId])).toEqual([{ via: "words" }]);
    expect(await pool.db.all(`SELECT id FROM "PartnerAsk" WHERE "askerOrgId" = $1`, [fmc.group.orgId])).toEqual([]);
  });
});
