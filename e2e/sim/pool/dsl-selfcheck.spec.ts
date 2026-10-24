/**
 * SELF-CHECK of the pool scenario DSL (2026-10-24, slice L1): the platform
 * channel plumbing every pool DM will travel by, proven before any pool DM
 * exists. A PlatformJob is written straight into the test database (as
 * `queuePlatformDm` writes one) and the world must: see it once, address it
 * to the right person with its purpose and hold time, and hand it out
 * through the Pi's real poll exactly once. $0.
 */
import { scenario, scenarios, expect } from "./fixtures";

scenarios("the pool DSL itself", () => {
  scenario("a queued platform DM is seen once, addressed by name, and dispatched once", async ({ pool }) => {
    const ali = await pool.stranger("ali");
    const held = new Date(Date.now() + 3_600_000);
    await pool.db.run(
      `INSERT INTO "PlatformJob" (id, kind, phone, text, purpose, "sendAfter", "updatedAt") VALUES ($1, 'dm', $2, 'held offer', 'otp', $3, now()), ($4, 'dm', $2, 'now offer', 'otp', NULL, now())`,
      [`pool-dsl-held-${Date.now()}`, ali.phone.replace(/^\+/, ""), held, `pool-dsl-now-${Date.now()}`],
    );

    const seen = await pool.collect();
    pool.expectSent(seen, [
      { to: "ali", channel: "dm", purpose: "otp", text: "held offer", sendAfter: held },
      { to: "ali", channel: "dm", purpose: "otp", text: "now offer", sendAfter: null },
    ]);
    pool.expectSent(await pool.collect(), []);

    const out = await pool.dispatchPlatform();
    pool.expectSent(out.filter((m) => m.to === "ali"), [{ to: "ali", text: "now offer" }]);
    expect((await pool.dispatchPlatform()).filter((m) => m.to === "ali")).toEqual([]);
    expect(pool.transcript()).toContain("MatchTime -> ali (dm, otp, after ");
  });
});
