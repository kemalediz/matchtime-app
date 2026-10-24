/**
 * POOL SCENARIO: the platform cap with racing senders (slice L5a; L4's
 * design, `src/lib/pool/caps.ts` header). At most 20 pool DMs in any hour
 * across every club. Two Pi polls at the same moment (the duplicate
 * process class of 2026-07-19) with room for ONE: exactly one offer goes;
 * the rest wait, never dropped, and go once the hour has room again.
 * Its own file: the 19 earlier sends it pretends would crowd any other
 * scenario's hour. Model-free ($0).
 */
import { scenario, scenarios, expect } from "./fixtures";
import { at, near, openClub, organiserAsks, pastPoolSends, pollPlatform, poolPlayer } from "./offers-world";

scenarios("the platform cap", () => {
  scenario("19 pool DMs went in the last hour; two polls race for the one place left: one offer goes, two wait for the hour", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF" });
    for (const k of ["ali", "ben", "cem"]) await poolPlayer(pool, k, { at: near(fnf) });
    const t0 = at(fnf.kickoff, -8);
    await pastPoolSends(pool, fnf, 19, new Date(t0.getTime() - 10 * 60_000));

    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: t0 });
    expect(ex.sent.filter((m) => m.purpose === "pool-offer")).toHaveLength(3);

    pool.note("two pollers at once");
    const [a, b] = await Promise.all([pollPlatform(pool, { now: t0 }), pollPlatform(pool, { now: t0 })]);
    const handedOut = [...a.out, ...b.out].filter((m) => m.purpose === "pool-offer");
    expect(handedOut).toHaveLength(1);
    expect(await pool.db.count(`SELECT count(*) FROM "PoolOffer" WHERE "orgId" = $1 AND "sentAt" = $2`, [fnf.group.orgId, t0])).toBe(1);
    expect(await pool.db.count(`SELECT count(*) FROM "PoolOffer" WHERE "orgId" = $1 AND "sentAt" IS NULL AND outcome IS NULL`, [fnf.group.orgId])).toBe(2);

    pool.note("still inside the hour: nothing more");
    expect((await pollPlatform(pool, { now: new Date(t0.getTime() + 30 * 60_000) })).out.filter((m) => m.purpose === "pool-offer")).toEqual([]);

    pool.note("the earlier 19 are now over an hour old");
    const later = await pollPlatform(pool, { now: new Date(t0.getTime() + 51 * 60_000) });
    expect(later.out.filter((m) => m.purpose === "pool-offer")).toHaveLength(2);
  });
});
