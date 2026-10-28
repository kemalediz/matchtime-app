/**
 * POOL SCENARIOS: a club member messages MatchTime, and an organiser talks
 * in HQ. TODAY'S BEHAVIOUR, the template for the member and organiser sides
 * of the pool (2026-10-24, slice L1): L3 (members opt in), L5 (organisers
 * approve a pool round), L8 (invitations) start from these.
 *
 * Model-free: help's topic is the question extractor's, stubbed here
 * (src/lib/dm-help.ts), and an untagged HQ message with no route from the
 * stub never reaches a writer. $0.
 */
import { LIVE, scenario, scenarios, stubbedOnly, expect } from "./fixtures";
import { clearPipelineStubs, helpOn } from "../../helpers/stub";

scenarios("a member and an organiser (today)", () => {
  scenario("a member's 'help' DM is answered privately, to him only", async ({ pool }) => {
    const fnf = await pool.club("fnf", { name: "Friday Night Football", hq: true });
    const pete = fnf.member("pete");
    if (!LIVE) helpOn({ help: {} });

    const ex = await pete.dm("help");
    if (!LIVE) clearPipelineStubs();

    pool.expectSent(ex.sent, [{ to: "fnf.pete", channel: "dm", text: /help/i }]);
    const others = pool.peopleOf("fnf").filter((p) => p.key !== pete.key);
    pool.expectNoLeaks(others.flatMap((p) => p.phoneVariants()), { in: ex.sent });
    expect(await pool.poolRowCounts()).toMatchObject({ PoolProfile: 0 });
  });

  scenario("an organiser's untagged chat in HQ about finding players gets no reply and asks nobody", async ({ pool }) => {
    stubbedOnly();
    const fnf = await pool.club("fnf", { name: "Friday Night Football", hq: true, pool: { featurePlayerPool: true } });
    await pool.stranger("ali");

    const ex = await fnf.hq.say("owner", "we're short again for friday, anyone know people nearby?");

    pool.expectSent(ex.sent, []);
    expect(await pool.poolRowCounts()).toMatchObject({ PoolAsk: 0, PoolOffer: 0 });
  });
});
