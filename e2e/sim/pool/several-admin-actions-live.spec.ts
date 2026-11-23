/**
 * ONE MESSAGE, SEVERAL ADMIN ACTIONS, LIVE (Sutton FC, 2026-11-23 14:44):
 * the real router and the real admin extractor on the real analyze route,
 * no stub. PAID: Haiku 5.5, two calls (about $0.001), on
 * ANTHROPIC_API_KEY_DEV only.
 *
 *   MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/pool/several-admin-actions-live.spec.ts
 *
 * The owner's own words: the game switched to 5-a-side, THEN the pool asked
 * for the 3 places left at the new size, and ONE reply carrying both. The
 * stubbed twin is `several-admin-actions.spec.ts`.
 */
import { scenario, scenarios, liveOnly, expect } from "./fixtures";
import { near, openClub, poolPlayer } from "./offers-world";

const INCIDENT = "@Match Time switch to 5aside, then invite local player pool for the remaining slots";
const SEVEN = ["owner", "alice", "brian", "pete", "dan", "felix", "greg"];

scenarios("several admin actions in one message (live model)", () => {
  scenario("the incident, word for word: 5-a-side, then the pool for the 3 places left, one reply", async ({ pool }) => {
    liveOnly();
    const club = await openClub(pool, "lsut", {
      name: "Sutton Sim FC",
      maxPlayers: 14,
      attendance: SEVEN.map((k) => ({ key: k, status: "CONFIRMED" as const })),
    });
    await pool.db.run(`UPDATE "Activity" SET "minPlayers" = 10, "maxPlayers" = 14 WHERE id = $1`, [club.group.activityId]);
    await poolPlayer(pool, "lali", { at: near(club) });

    const ex = await club.post("owner", INCIDENT, { tag: true, headers: { "x-mt-test-pool-open": "1" } });
    // What the router and the extractors read, as stored on the message's row.
    const row = await pool.db.one<{ handledBy: string; intent: string | null; reasoning: string | null; pipelineTrace: unknown }>(
      `SELECT "handledBy", intent, reasoning, "pipelineTrace" FROM "AnalyzedMessage" WHERE body = $1 ORDER BY "createdAt" DESC LIMIT 1`,
      [INCIDENT],
    );
    console.log(`[several-admin-actions live] ${row?.handledBy} ${row?.intent}\n${row?.reasoning}\n${JSON.stringify(row?.pipelineTrace, null, 1)}`);

    const size = await pool.db.one<{ maxPlayers: number }>(`SELECT "maxPlayers" FROM "Match" WHERE id = $1`, [club.group.matchId]);
    expect(size?.maxPlayers).toBe(10);
    expect(await pool.db.all(`SELECT via, places FROM "PoolAsk" WHERE "orgId" = $1`, [club.group.orgId])).toEqual([{ via: "words", places: 3 }]);
    expect(ex.sent.filter((m) => m.purpose === "pool-offer").map((m) => m.to)).toEqual(["lali"]);
    const reply = (ex.json.results as Array<{ reply: string | null }>)[0].reply ?? "";
    console.log(`[several-admin-actions live] the one reply:\n${reply}`);
    expect(reply).toMatch(/5-a-side now, 10 places/);
    expect(reply).toMatch(/MatchTime player pool for 3 places/);
    expect(reply).not.toMatch(/couldn't do/);
  });
});
