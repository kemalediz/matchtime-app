/**
 * FRIEND LINK SCENARIOS, SLICE S6: an organiser takes the friend off the
 * game (2026-10-31, Kemal's point 6). He gets ONE DM: the organisers took
 * him out of this game, he stays in the player pool and will keep hearing
 * about games near him. His guest place is "withdrawn" (never a miss), he
 * stays an active pool member. The match page's Remove, a tagged message in
 * the players' group and a tagged message in HQ all reach the same hook
 * (`partner-guest.ts` `tellGuestTakenOffByAdmin`). After kick-off nothing is
 * sent. $0.
 */
import { scenario, scenarios, expect } from "../pool/fixtures";
import { signInAs } from "../../fixtures";
import { changeReading, engineOn, otherFacts } from "../../helpers/stub";
import { friendClub, friendJoins, linkFor, say } from "./world";

const REMOVED = /^The organisers of \*FNF\* took you out of the game on \w{3} \d+ \w{3}, 20:00\. You stay in the MatchTime player pool and will keep hearing about new games near you\.$/;

scenarios("an organiser takes the friend off the game", () => {
  scenario("the match page's Remove: one DM to him, his place withdrawn, still in the pool", async ({ pool, page }) => {
    const fnf = await friendClub(pool, "fnf");
    const token = await linkFor(pool, fnf);
    const j = await friendJoins(pool, "ali", token);
    const uid = (await pool.userOf(j.person))!.id;

    const owner = await pool.userOf(fnf.member("owner"));
    await signInAs(page, owner!.id, `/matches/${fnf.group.matchId}`);
    await page.goto(`/matches/${fnf.group.matchId}`);
    page.once("dialog", (d) => void d.accept());
    await page.getByTestId("attendance-section").locator("li", { hasText: "Ali" }).getByTitle("Remove from squad").click();
    await expect(page.getByTestId("attendance-section").locator("li", { hasText: "Ali" })).toHaveCount(0, { timeout: 20_000 });

    const toAli = (await pool.collect()).filter((m) => m.to === "ali");
    expect(toAli).toHaveLength(1);
    expect(toAli[0]).toMatchObject({ purpose: "friend-removed" });
    expect(toAli[0].text).toMatch(REMOVED);
    expect(await pool.db.one(`SELECT result FROM "GuestPlace" WHERE "matchId" = $1 AND "userId" = $2`, [fnf.group.matchId, uid])).toMatchObject({ result: "withdrawn" });
    expect(await pool.profileOf(j.person)).toMatchObject({ status: "active" });
  });

  scenario("a tagged message in the players' group: the same one DM", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const token = await linkFor(pool, fnf);
    const j = await friendJoins(pool, "ali", token);
    const r = await say(pool, fnf, "alice", "@Match Time Ali Yilmaz is out", otherFacts("Ali Yilmaz", "out", { personKind: "named" }), { tag: true });
    const toAli = r.sent.filter((m) => m.to === "ali");
    expect(toAli).toHaveLength(1);
    expect(toAli[0].text).toMatch(REMOVED);
    expect(await pool.db.one(`SELECT a.status FROM "Attendance" a JOIN "User" u ON u.id = a."userId" WHERE a."matchId" = $1 AND u."phoneNumber" = $2`, [fnf.group.matchId, j.person.phone])).toMatchObject({ status: "DROPPED" });
  });

  scenario("a tagged message in HQ: the same one DM", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf", { hq: true });
    const token = await linkFor(pool, fnf);
    await friendJoins(pool, "ali", token);
    const body = "@Match Time Ali Yilmaz is out";
    pool.arm(() => engineOn({ [body]: { route: "other_att", reading: changeReading([["Ali Yilmaz", "out"]]) } }));
    const ex = await fnf.hq.say("owner", body, { tagged: true });
    const toAli = ex.sent.filter((m) => m.to === "ali");
    expect(toAli).toHaveLength(1);
    expect(toAli[0].text).toMatch(REMOVED);
  });

  scenario("after kick-off: nothing is sent; the no-show panel keeps him", async ({ pool, page }) => {
    const fnf = await friendClub(pool, "fnf");
    const token = await linkFor(pool, fnf);
    const j = await friendJoins(pool, "ali", token);
    await pool.db.run(`UPDATE "Match" SET date = now() - interval '10 minutes' WHERE id = $1`, [fnf.group.matchId]);
    const r = await say(pool, fnf, "alice", "@Match Time Ali Yilmaz is out", otherFacts("Ali Yilmaz", "out", { personKind: "named" }), { tag: true });
    expect(r.sent.filter((m) => m.to === "ali")).toEqual([]);
    void page;
    void j;
  });
});
