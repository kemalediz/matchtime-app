/**
 * HELP ABOUT THE PLAYER POOL, ASKED IN ANY WORDS, LIVE (2026-10-28): the
 * real router and the real question extractor on the real routes, no stub.
 * PAID: Haiku 5.5, a router and an extractor call per group message, one
 * extractor call per DM (about $0.0003 a message), on ANTHROPIC_API_KEY_DEV
 * only. Once each.
 *
 *   MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/pool/help-live.spec.ts
 *
 * The stubbed twin is `help.spec.ts`.
 */
import { scenario, scenarios, liveOnly, expect } from "./fixtures";

const OPEN = { "x-mt-test-pool-open": "1" };

scenarios("help about the pool, the real model", () => {
  scenario("players' group: '@Match Time how do I turn on the player pool?' gets the pool's help", async ({ pool }) => {
    liveOnly();
    const fnf = await pool.club("lfnf1", { name: "FNF", pool: { featurePlayerPool: true } });
    const ex = await fnf.post("pete", "@Match Time how do I turn on the player pool?", { tag: true, headers: OPEN });
    pool.expectSent(ex.sent, [{ to: "lfnf1.group", channel: "group", text: /The MatchTime player pool: how it works/ }]);
    expect(ex.sent[0].text).toContain("Play elsewhere too");
  });

  scenario("HQ: 'havuzu nasıl açarız' gets the pool's help for the organisers", async ({ pool }) => {
    liveOnly();
    const fnf = await pool.club("lfnf2", { name: "FNF", hq: true });
    const ex = await fnf.hq.say("owner", "havuzu nasıl açarız", { poolOpen: true });
    expect(ex.json).toMatchObject({ handled: true, outcome: "hq-help" });
    expect(ex.sent[0].text).toContain("The MatchTime player pool: how it works");
    expect(ex.sent[0].text).toMatch(/\/admin\/settings#player-pool$/);
  });

  scenario("DM: 'can I play for other teams near me?' gets how to join, privately", async ({ pool }) => {
    liveOnly();
    const fnf = await pool.club("lfnf3", { name: "FNF" });
    const ex = await fnf.member("pete").dm("can I play for other teams near me?", { headers: OPEN });
    expect(ex.json).toMatchObject({ handled: "dm-help", topic: "pool", audience: "player" });
    expect(ex.sent[0].text).toContain("Play elsewhere too");
  });
});
