/**
 * POOL SCENARIOS from the second review of PR #400 (slice L5a,
 * 2026-10-24). Model-free ($0).
 *
 *   2   the Pi's "sent" report is lost: the holder's tap still works (his
 *       link proves the DM reached him), and a sweep takes a job claimed 5
 *       minutes ago as delivered, so the offer's clock runs and it can end
 *       "ignored".
 *   4   a backlog of other platform DMs never starves pool offers (one
 *       reserved place per poll); a pool row with nothing to send is failed,
 *       never claimed.
 */
import { scenario, scenarios, expect } from "./fixtures";
import { nextMsgId } from "../group";
import { at, near, offersOf, openClub, organiserAsks, pollPlatform, poolPlayer, proveOffer, tapLinkIn, tapOffer } from "./offers-world";

scenarios("second review of #400: the fixes", () => {
  scenario("2: the 'sent' report is lost: his own tap still takes the place", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const ali = await poolPlayer(pool, "ali", { at: near(fnf) });
    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    const { out } = await pollPlatform(pool, { now: at(fnf.kickoff, -8), report: "none" });
    expect(out.filter((m) => m.to === "ali")).toHaveLength(1);
    expect((await offersOf(pool, ali))[0].sentAt).toBeNull();
    await page.context().clearCookies();

    expect(await proveOffer(pool, page, tapLinkIn(ex.sent[0]))).toBe("open");
    expect((await offersOf(pool, ali))[0].sentAt).toEqual(at(fnf.kickoff, -8));
    expect(await tapOffer(pool, page, tapLinkIn(ex.sent[0]), "yes")).toBe("in");
  });

  scenario("2: the report is lost and he never taps: five minutes on, the sweep takes it as delivered, and his own time can run out", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF" });
    const ali = await poolPlayer(pool, "ali", { at: near(fnf) });
    const t0 = at(fnf.kickoff, -30);
    await organiserAsks(pool, page, fnf, { places: 1, now: t0 });
    await pollPlatform(pool, { now: t0, report: "none" });

    await pollPlatform(pool, { now: new Date(t0.getTime() + 4 * 60_000), report: "none" });
    expect((await offersOf(pool, ali))[0].sentAt).toBeNull();
    await pollPlatform(pool, { now: new Date(t0.getTime() + 6 * 60_000), report: "none" });
    expect((await offersOf(pool, ali))[0].sentAt).toEqual(t0);

    await pollPlatform(pool, { now: new Date(t0.getTime() + 6 * 3600_000 + 60_000), report: "none" });
    expect((await offersOf(pool, ali))[0].outcome).toBe("ignored");
  });

  scenario("4: a backlog of other platform DMs: the pool offer still gets its reserved place in the poll", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF" });
    await poolPlayer(pool, "ali", { at: near(fnf) });
    const owner = fnf.member("owner");
    const t0 = at(fnf.kickoff, -8);
    for (let i = 0; i < 8; i++) {
      await pool.db.run(
        `INSERT INTO "PlatformJob" (id, kind, phone, text, purpose, status, "createdAt", "updatedAt") VALUES ($1, 'dm', $2, 'a setup note', 'connect-reply', 'queued', $3, now())`,
        [`sim-backlog-${nextMsgId()}`, owner.phone.replace(/^\+/, ""), new Date(t0.getTime() - 3600_000)],
      );
    }
    await pool.collect();
    await organiserAsks(pool, page, fnf, { places: 1, now: t0 });

    const { out } = await pollPlatform(pool, { now: t0, report: "none" });
    expect(out).toHaveLength(5);
    expect(out.filter((m) => m.purpose === "pool-offer").map((m) => m.to)).toEqual(["ali"]);
  });

  scenario("4: a pool row with nothing to send is failed, never claimed, and its offer ends cancelled", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF" });
    const ali = await poolPlayer(pool, "ali", { at: near(fnf) });
    const t0 = at(fnf.kickoff, -8);
    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: t0 });
    await pool.db.run(`UPDATE "PlatformJob" SET text = '' WHERE id = $1`, [ex.sent[0].id]);

    const { out } = await pollPlatform(pool, { now: t0 });
    expect(out.filter((m) => m.id === ex.sent[0].id)).toEqual([]);
    expect(await pool.db.one(`SELECT status FROM "PlatformJob" WHERE id = $1`, [ex.sent[0].id])).toEqual({ status: "failed" });
    expect((await offersOf(pool, ali))[0]).toMatchObject({ outcome: "cancelled", sentAt: null });
  });
});
