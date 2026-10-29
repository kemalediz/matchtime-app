/**
 * A MESSAGE TAGGED TO MATCHTIME IS NEVER MET WITH SILENCE (MT Test,
 * 2026-10-29). The owner tagged "@Match Time invite players from pool" in a
 * club with no admin group. Half the time the router says `offer`, whose
 * attendance extractor reports `claims: [], sideRequests: ["chase"]`, and
 * MatchTime said nothing at all, twice.
 *
 *   the owner's tagged chase   a request to find players: the words name
 *                              the pool, so the pool is asked (#452)
 *   a member's tagged gibberish  the "not understood" line, pointing to help
 *   a member's tagged thanks   banter (the router's `none`): silent, as ever
 *   a member's untagged chase  silent, as ever
 *
 * Real routes, real database, the model STUBBED ($0). One stubbed blob per
 * body carries both the attendance extractor's shape and the admin
 * extractor's (`recruit-source.ts` reads where the players come from).
 */
import { scenario, scenarios, stubbedOnly, expect } from "./fixtures";
import { near, offersOf, openClub, poolPlayer } from "./offers-world";
import type { PoolWorld } from "./world";
import { clearPipelineStubs, facts } from "../../helpers/stub";

const ASK = "@Match Time invite players from pool";
const ADMIN_FACTS = { payerRef: "", count: 0, coveredRefs: [], undo: false, matchDay: "", pastGame: false, phrase: "", note: "", lookbackMatches: 0, clubRef: "" };
const CHASE_FROM_POOL = { ...facts([], { sideRequests: ["chase"] }), action: "recruit", ...ADMIN_FACTS, playersFrom: ["pool"], toMatchTime: true };
const NOT_UNDERSTOOD = "I didn't catch what you'd like me to do. Type *@Match Time help* to see what I can do.";
const NOT_UNDERSTOOD_TR = "Ne yapmamı istediğinizi anlayamadım. Neler yapabildiğimi görmek için *@Match Time yardım* yazın.";

type Club = Awaited<ReturnType<typeof openClub>>;

async function noHqClub(pool: PoolWorld, key: string, language: "en" | "tr" = "en"): Promise<Club> {
  const club = await openClub(pool, key, { name: "MT Test", maxPlayers: 1 });
  await pool.db.run(`UPDATE "Organisation" SET language = $2 WHERE id = $1`, [club.group.orgId, language]);
  return club;
}
const poolAsks = (pool: PoolWorld, club: Club) =>
  pool.db.all<{ via: string }>(`SELECT via FROM "PoolAsk" WHERE "orgId" = $1`, [club.group.orgId]);
const groupLines = (club: Club, sent: readonly { to: string; text?: string }[]) => sent.filter((m) => m.to === `${club.key}.group`).map((m) => m.text);

scenarios("a message tagged to MatchTime is never met with silence", () => {
  scenario.afterEach(() => clearPipelineStubs());

  scenario("the owner's tagged 'invite players from pool', routed offer with a bare chase: the pool is asked", async ({ pool }) => {
    stubbedOnly();
    const mt = await noHqClub(pool, "tns1");
    const ali = await poolPlayer(pool, "alitns1", { at: near(mt) });

    const ex = await mt.post("owner", ASK, { route: "offer", facts: CHASE_FROM_POOL, tag: true, headers: { "x-mt-test-pool-open": "1" } });

    expect(groupLines(mt, ex.sent)).toEqual([expect.stringMatching(/^🔎 Asking nearby players from the MatchTime player pool for 1 place on /)]);
    expect(ex.sent.filter((m) => m.purpose === "pool-offer").map((m) => m.to)).toEqual(["alitns1"]);
    expect((await poolAsks(pool, mt)).map((a) => a.via)).toEqual(["words"]);
    expect(await offersOf(pool, ali)).toHaveLength(1);
  });

  scenario("a member's same tagged chase is not a request to find players: nobody asked, and never silent", async ({ pool }) => {
    stubbedOnly();
    const mt = await noHqClub(pool, "tns2");
    await poolPlayer(pool, "bentns2", { at: near(mt) });

    const ex = await mt.post("pete", ASK, { route: "offer", facts: CHASE_FROM_POOL, tag: true, headers: { "x-mt-test-pool-open": "1" } });

    expect(await poolAsks(pool, mt)).toEqual([]);
    expect(ex.sent.filter((m) => m.channel === "dm")).toEqual([]);
    expect(groupLines(mt, ex.sent)).toEqual([NOT_UNDERSTOOD]);
  });

  scenario("a member's tagged gibberish: the not-understood line, pointing to help", async ({ pool }) => {
    stubbedOnly();
    const mt = await noHqClub(pool, "tns3");
    const ex = await mt.post("pete", "@Match Time flibble the wotsit", { route: "unsure", facts: facts([]), tag: true });
    expect(groupLines(mt, ex.sent)).toEqual([NOT_UNDERSTOOD]);
  });

  scenario("Turkish club: the Turkish line", async ({ pool }) => {
    stubbedOnly();
    const tr = await noHqClub(pool, "tns4", "tr");
    const ex = await tr.post("pete", "@Match Time şunu bunu yap", { route: "unsure", facts: facts([]), tag: true });
    expect(groupLines(tr, ex.sent)).toEqual([NOT_UNDERSTOOD_TR]);
  });

  scenario("handled silently stays silent: tagged thanks (banter), and the same gibberish untagged", async ({ pool }) => {
    stubbedOnly();
    const mt = await noHqClub(pool, "tns5");
    const thanks = await mt.post("pete", "@Match Time thanks mate", { route: "none", facts: facts([]), tag: true });
    expect(groupLines(mt, thanks.sent)).toEqual([]);
    const untagged = await mt.post("pete", "flibble the wotsit", { route: "unsure", facts: facts([]), tag: false });
    expect(groupLines(mt, untagged.sent)).toEqual([]);
    const nudge = await mt.post("pete", "@all we need more players pls", { route: "offer", facts: facts([], { sideRequests: ["chase"] }), tag: false });
    expect(groupLines(mt, nudge.sent)).toEqual([]);
  });
});
