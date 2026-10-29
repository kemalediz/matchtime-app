/**
 * POOL SCENARIOS: a pool player joining or leaving a game is shown where
 * the whole club can see it (Kemal, 2026-10-29): "it needs to be shown in
 * the group, either HQ group or players group, depending on the type of
 * the football club". Real routes, real database, the real offer page;
 * model-free ($0).
 *
 *   - a club with no admin group: ONE post in the players' group, worded
 *     for everyone and without the turn-up record, and NO admin DM; giving
 *     the place back is one more group post.
 *   - an organiser-pick club with no admin group: the bench post says how
 *     an organiser puts him in.
 *   - a Turkish club with no admin group: the post in Turkish.
 *   - a club with HQ: the HQ notice, unchanged (turn-up line kept),
 *     nothing in the players' group.
 */
import { scenario, scenarios, expect } from "./fixtures";
import { at, near, openClub, organiserAsks, pollPlatform, poolPlayer, tapLinkIn, tapOffer } from "./offers-world";
import type { PoolClub, PoolWorld } from "./world";

/** Quiet hours off, so the players' group post is not held. */
async function noQuietHours(pool: PoolWorld, club: PoolClub): Promise<void> {
  await pool.db.run(`UPDATE "Organisation" SET "quietHoursEnabled" = false WHERE id = $1`, [club.group.orgId]);
}

const TURN_UP = /New to MatchTime|MatchTime games|turned up|MatchTime'da yeni/;

scenarios("a pool player joining is shown in the club's group", () => {
  scenario("a club with no admin group: ONE players' group post, no turn-up line, no admin DM; giving it back is one more post", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF" });
    await noQuietHours(pool, fnf);
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf) });
    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    await pollPlatform(pool, { now: at(fnf.kickoff, -8) });

    expect(await tapOffer(pool, page, tapLinkIn(ex.sent[0]), "yes")).toBe("in");
    const sent = await pool.collect();
    pool.expectSent(sent, [
      { to: "fnf.group", channel: "group", text: /^🙋 Ali K from the MatchTime player pool has joined the squad for \w{3} \d+ \w{3}, 20:00\.$/ },
      { to: "ali", channel: "dm", purpose: "pool-placed", text: /✅ You're in: \*FNF\*/ },
    ]);
    expect(sent.filter((m) => m.channel === "dm" && m.to !== "ali")).toEqual([]);
    for (const m of sent.filter((x) => x.channel === "group")) expect(m.text).not.toMatch(TURN_UP);
    pool.expectNoLeaks(ali.phoneVariants(), { to: ["fnf.group"] });

    pool.note("he gives the place back: one more post in the group, still no admin DM");
    expect(await tapOffer(pool, page, tapLinkIn(ex.sent[0]), "pull-out")).toBe("withdrawn");
    const out = await pool.collect();
    pool.expectSent(out, [{ to: "fnf.group", channel: "group", text: /^Ali K from the MatchTime player pool can no longer play on .*\. The place is open again\.$/ }]);
    expect(out.filter((m) => m.channel === "dm")).toEqual([]);
  });

  scenario("an organiser-pick club with no admin group: the bench post says how an organiser puts him in", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", benchPickMode: "organiser" });
    await noQuietHours(pool, fnf);
    await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf) });
    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    await pollPlatform(pool, { now: at(fnf.kickoff, -8) });

    expect(await tapOffer(pool, page, tapLinkIn(ex.sent[0]), "yes")).toBe("bench");
    const sent = await pool.collect();
    pool.expectSent(sent, [
      {
        to: "fnf.group",
        channel: "group",
        text: /^🙋 Ali K from the MatchTime player pool is on the bench for .*\. The organisers pick who plays from the bench\. Organisers, to put Ali K in, tag me and say so, for example \*@Match Time put Ali K in\*$/,
      },
      { to: "ali", purpose: "pool-placed", text: /📝 You're on the bench for \*FNF\*/ },
    ]);
    expect(sent.filter((m) => m.channel === "dm" && m.to !== "ali")).toEqual([]);
    for (const m of sent) expect(m.text).not.toMatch(/waiting list|for you to pick/i);
  });

  scenario("a Turkish club with no admin group: the post in Turkish, no turn-up line", async ({ pool, page }) => {
    const gs = await openClub(pool, "gs", { name: "Galata FC" });
    await pool.db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [gs.group.orgId]);
    await noQuietHours(pool, gs);
    await poolPlayer(pool, "can", { name: "Can Demir", at: near(gs) });
    const ex = await organiserAsks(pool, page, gs, { places: 1, now: at(gs.kickoff, -8) });
    await pollPlatform(pool, { now: at(gs.kickoff, -8) });

    expect(await tapOffer(pool, page, tapLinkIn(ex.sent[0]), "yes")).toBe("in");
    const sent = await pool.collect();
    const group = sent.filter((m) => m.to === "gs.group");
    expect(group.map((m) => m.text)).toEqual([expect.stringMatching(/^🙋 MatchTime oyuncu havuzundan Can D, .* maçı için kadroya katıldı\.$/)]);
    expect(sent.filter((m) => m.channel === "dm" && m.to !== "can")).toEqual([]);
    expect(group[0].text).not.toMatch(TURN_UP);
  });

  scenario("a club with HQ: the HQ notice as before, turn-up line kept, nothing in the players' group", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    await noQuietHours(pool, fnf);
    await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf) });
    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    await pollPlatform(pool, { now: at(fnf.kickoff, -8) });

    expect(await tapOffer(pool, page, tapLinkIn(ex.sent[0]), "yes")).toBe("in");
    const sent = await pool.collect();
    pool.expectSent(sent, [
      { to: "fnf.hq", channel: "hq", text: /^🙋 Ali K from the MatchTime player pool took a place for \w{3} \d+ \w{3}, 20:00\. New to MatchTime\.$/ },
      { to: "ali", channel: "dm", purpose: "pool-placed", text: /✅ You're in: \*FNF\*/ },
    ]);
    expect(sent.filter((m) => m.channel === "group")).toEqual([]);
  });
});
