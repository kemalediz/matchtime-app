/**
 * POOL SCENARIOS: asking MatchTime about the player pool, in any words, in
 * the players' group, in HQ and by DM (2026-10-28).
 *
 * Help used to be read by a regex ("help" plus a known topic word), so
 * "how do I turn on the player pool?" got nothing. It is now read by the
 * shared question extractor everywhere (`how_it_works`, topic "pool"), and
 * every place answers with the one builder (`buildHelpReply`): what the
 * pool is, whether it is on for this club, and, for an organiser, how to
 * switch it, with a link straight to the card (`/admin/settings#player-pool`).
 *
 * Real routes, real database. The model is STUBBED ($0): the router's route
 * and the extractor's topic are what the stub says. Whether the real model
 * says them is the paid check (`scripts/live-check-question-extractor.ts`,
 * `scripts/live-check-help-routing.ts`).
 */
import { scenario, scenarios, stubbedOnly, expect } from "./fixtures";
import { clearPipelineStubs, helpOn } from "../../helpers/stub";

const OPEN = { "x-mt-test-pool-open": "1" };
const PLAYER_TEXT = /Turn on \*Play elsewhere too\* on your MatchTime profile/;

scenarios("help about the player pool, asked in any words", () => {
  scenario("players' group, a player: how to join, and that this club asks the pool", async ({ pool }) => {
    stubbedOnly();
    const fnf = await pool.club("fnf", { name: "FNF", pool: { featurePlayerPool: true } });
    const ask = "@Match Time can I play for other teams near me too?";
    helpOn({ [ask]: { feature: "pool" } });

    const ex = await fnf.post("pete", ask, { tag: true, headers: OPEN });

    pool.expectSent(ex.sent, [{ to: "fnf.group", channel: "group", text: PLAYER_TEXT }]);
    const reply = ex.sent[0].text;
    expect(reply).toContain("🌍 *The MatchTime player pool: how it works*");
    expect(reply).toContain("✅ This club also asks the pool when it's short.");
    // A player is never told how to switch it, and a group never gets a sign-in link.
    expect(reply).not.toContain("/admin/settings");
    expect(reply).not.toMatch(/[—–]/);
    clearPipelineStubs();
  });

  scenario("players' group, the owner, the pool off for the club: how to switch it on, public link to its card", async ({ pool }) => {
    stubbedOnly();
    const fnf = await pool.club("fnf", { name: "FNF" });
    const ask = "@Match Time how do I turn on the player pool?";
    helpOn({ [ask]: { feature: "pool" } });

    const ex = await fnf.post("owner", ask, { tag: true, headers: OPEN });

    pool.expectSent(ex.sent, [{ to: "fnf.group", channel: "group", text: /It's off for your club/ }]);
    expect(ex.sent[0].text).toMatch(/turn on \*Player pool\* here:\nhttps?:\/\/\S+\/admin\/settings#player-pool$/);
    expect(ex.sent[0].text).not.toContain("/r/");
    clearPipelineStubs();
  });

  scenario("HQ, the owner: how the pool works for the organisers; and the HQ menu lists asking the pool", async ({ pool }) => {
    stubbedOnly();
    const fnf = await pool.club("fnf", { name: "FNF", hq: true, pool: { featurePlayerPool: true } });
    const ask = "how does the player pool work?";
    const menu = "what can you do?";
    helpOn({ [ask]: { feature: "pool", route: "help" }, [menu]: { route: "help" } });

    const ex = await fnf.hq.say("owner", ask, { poolOpen: true });
    expect(ex.json).toMatchObject({ handled: true, outcome: "hq-help" });
    pool.expectSent(ex.sent, [{ to: "fnf.hq", channel: "hq", text: /It's on for your club/ }]);
    expect(ex.sent[0].text).toContain("*@Match Time ask the player pool for 2 players*");
    expect(ex.sent[0].text).toMatch(/\/admin\/settings#player-pool$/);

    const m = await fnf.hq.say("owner", menu, { poolOpen: true });
    expect(m.json).toMatchObject({ handled: true, outcome: "hq-help" });
    expect(m.sent[0].text).toContain("*MatchTime in your admin group*");
    expect(m.sent[0].text).toContain(`🌍 *"ask the player pool for 2 players"*`);

    // The platform switch off: no pool line in the menu.
    const off = await fnf.hq.say("owner", menu, { poolOpen: false });
    expect(off.sent[0].text).not.toContain("player pool");
    clearPipelineStubs();
  });

  scenario("DM, a player, in Turkish words: how to join, privately, to him only", async ({ pool }) => {
    stubbedOnly();
    const fnf = await pool.club("fnf", { name: "FNF", pool: { featurePlayerPool: true } });
    const pete = fnf.member("pete");
    helpOn({ "havuz nasıl açılır": { feature: "pool" } });

    const ex = await pete.dm("havuz nasıl açılır", { headers: OPEN });

    expect(ex.json).toMatchObject({ handled: "dm-help", topic: "pool", audience: "player" });
    pool.expectSent(ex.sent, [{ to: "fnf.pete", channel: "dm", text: PLAYER_TEXT }]);
    expect(ex.sent[0].text).not.toMatch(/https?:\/\//);
    clearPipelineStubs();
  });

  scenario("DM, the owner: a link that signs him straight in to the pool's card", async ({ pool }) => {
    stubbedOnly();
    const fnf = await pool.club("fnf", { name: "FNF" });
    const owner = fnf.member("owner");
    helpOn({ "how do I switch the pool on?": { feature: "pool" } });

    const ex = await owner.dm("how do I switch the pool on?", { headers: OPEN });

    expect(ex.json).toMatchObject({ handled: "dm-help", topic: "pool", audience: "admin" });
    pool.expectSent(ex.sent, [{ to: "fnf.owner", channel: "dm", text: /It's off for your club\. To switch it on, turn on \*Player pool\* here:/ }]);
    const link = ex.sent[0].text.match(/https?:\/\/\S+\/r\/\S+/)?.[0];
    expect(link, ex.sent[0].text).toBeTruthy();
    const code = link!.split("/r/")[1];
    const row = await pool.db.one<{ token: string }>(`SELECT token FROM "ShortLink" WHERE code = $1`, [code]);
    const body = (row?.token ?? code).split(".")[0];
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    expect(payload).toMatchObject({ purpose: "sign-in", nextPath: "/admin/settings#player-pool" });
    clearPipelineStubs();
  });

  scenario("a DM that is not a help question carries on as before (no help reply)", async ({ pool }) => {
    stubbedOnly();
    const fnf = await pool.club("fnf", { name: "FNF" });
    const pete = fnf.member("pete");
    clearPipelineStubs();

    const ex = await pete.dm("thanks mate", { headers: OPEN });

    expect(ex.json).not.toMatchObject({ handled: "dm-help" });
    expect(ex.sent.filter((s) => /how it works/.test(s.text))).toEqual([]);
  });
});
