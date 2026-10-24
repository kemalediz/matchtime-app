/**
 * POOL SCENARIOS, LIVE: answering an offer in his own words with the REAL
 * model on the real DM route (slice L6, 2026-10-24). PAID: one reader call
 * per reply (Haiku 5.5, about $0.0001 each), on ANTHROPIC_API_KEY_DEV only.
 *
 *   MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/pool/offers-reply-words-live.spec.ts
 *
 * Someone in no club, so no other model on the route is asked: a yes in
 * English books his place, a Turkish no declines it, and a question gets
 * the offer's own facts. The stubbed twin is `offers-reply-words.spec.ts`.
 */
import { scenario, scenarios, liveOnly, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { at, near, openClub, organiserAsks, pollPlatform, poolPlayer, type PoolPlayerOpts } from "./offers-world";
import type { PoolWorld } from "./world";

const OPEN = { headers: { "x-mt-test-pool-open": "1" } };

async function offerTo(pool: PoolWorld, page: Page, key: string, name: string, player: Partial<PoolPlayerOpts> & { key: string }) {
  const club = await openClub(pool, key, { name, hq: true });
  const { key: pkey, ...opts } = player;
  const p = await poolPlayer(pool, pkey, { at: near(club), ...opts });
  await organiserAsks(pool, page, club, { places: 1, now: at(club.kickoff, -8) });
  await pollPlatform(pool, { now: at(club.kickoff, -8) });
  await pool.db.run(`UPDATE "PoolOffer" SET "sentAt" = $2 WHERE "userId" = $1`, [p.userId, new Date(Date.now() - 60_000)]);
  return { club, p };
}

scenarios("answering a pool offer in his own words (live model)", () => {
  scenario("EN: 'yeah go on, count me in' books his place", async ({ pool, page }) => {
    liveOnly();
    const { club, p } = await offerTo(pool, page, "fnf", "FNF", { key: "ali", name: "Ali Kaya" });
    const ex = await p.dm("yeah go on, count me in", OPEN);
    expect(ex.json).toMatchObject({ handled: "pool-reply-accept" });
    expect(ex.sent.find((m) => m.to === "ali")?.purpose).toBe("pool-placed");
    const row = await pool.db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [club.group.matchId, p.userId]);
    expect(row?.status).toBe("CONFIRMED");
  });

  scenario("TR: 'yok abi bu sefer olmaz' declines it", async ({ pool, page }) => {
    liveOnly();
    const { p } = await offerTo(pool, page, "gs", "Galata FC", { key: "can", name: "Can Demir", lang: "tr" });
    const ex = await p.dm("yok abi bu sefer olmaz", OPEN);
    expect(ex.json).toMatchObject({ handled: "pool-reply-decline" });
    expect(await pool.db.one(`SELECT outcome, "repliedVia" FROM "PoolOffer" WHERE "userId" = $1`, [p.userId])).toEqual({ outcome: "declined", repliedVia: "words" });
  });

  scenario("EN: 'how much is it and is there parking?' gets the offer's own facts", async ({ pool, page }) => {
    liveOnly();
    const { p } = await offerTo(pool, page, "cheam", "Cheam Lads", { key: "ben", name: "Ben Hill" });
    const ex = await p.dm("how much is it and is there parking?", OPEN);
    expect(ex.json).toMatchObject({ handled: "pool-reply-facts" });
    expect(ex.sent.find((m) => m.to === "ben")?.text).toMatch(/^Here's everything I know about this game:\n⚽ \*Cheam Lads\*/);
  });
});
