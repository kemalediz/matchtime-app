/**
 * POOL SCENARIOS: an organiser asks the MatchTime player pool in the
 * PLAYERS' group (local player pool L10, manager review of #410). Clubs
 * with no admin group (Friday MT Community) ask here.
 *
 * Real routes, real database, the model STUBBED ($0). The router says what
 * it really says for these words in the players' group (measured on the
 * dev key): `offer`, whose attendance extractor reports a bare "recruit"
 * side request; the admin extractor, asked before any blast
 * (`recruit-source.ts`), reads "recruit, from the pool". One stubbed blob
 * per body carries both shapes. A second path, the router saying
 * `admin_ops`, reaches the same door through the engine's `pool_ask` write.
 * Everything after is the shipped code: the engine's admin and tag gates,
 * the analyze route's batch-final pass and the same door as HQ
 * (`pool-ask-words.ts`, L5a's `requestPoolAsk`).
 *
 *   an organiser, pool on   one line, "Asking nearby players ... I'll let you
 *                           know", the offer queued, the ask `via: words`
 *   an organiser, pool off  the same helpful line HQ gives, nobody asked
 *   a player                today's behaviour for that route: nothing asked,
 *                           never a DM blast to the club's past players
 */
import { scenario, scenarios, stubbedOnly, expect } from "./fixtures";
import { near, offersOf, openClub, poolPlayer, type OpenClubOpts } from "./offers-world";
import type { PoolWorld } from "./world";
import type { SentMessage } from "./transcript";
import { clearPipelineStubs, facts } from "../../helpers/stub";

const ASK = "@Match Time ask the pool for a player";
const ASK_TR = "@Match Time havuzdan bir oyuncu bul";
const FACTS = {
  action: "recruit",
  payerRef: "",
  count: 0,
  coveredRefs: [],
  undo: false,
  matchDay: "",
  phrase: "",
  note: "",
  lookbackMatches: 0,
  playersFrom: "pool",
  clubRef: "",
  toMatchTime: true,
};

type Club = Awaited<ReturnType<typeof openClub>>;

/** A club with NO admin group, one place open. */
async function noHqClub(pool: PoolWorld, key: string, opts: OpenClubOpts & { language?: "en" | "tr" } = {}): Promise<Club> {
  const { language, ...clubOpts } = opts;
  const club = await openClub(pool, key, { name: "Friday MT Community", maxPlayers: 1, ...clubOpts });
  if (language) await pool.db.run(`UPDATE "Organisation" SET language = $2 WHERE id = $1`, [club.group.orgId, language]);
  return club;
}

// What the real router and extractors say for these words in the players' group.
const OFFER_FACTS = { ...facts([], { sideRequests: ["recruit"] }), ...FACTS };
const say = (club: Club, member: string, text: string, poolOpen = true, route: "offer" | "admin_ops" = "offer") =>
  club.post(member, text, { route, facts: route === "offer" ? OFFER_FACTS : FACTS, tag: true, headers: { "x-mt-test-pool-open": poolOpen ? "1" : "0" } });
const poolAsks = (pool: PoolWorld, club: Club) =>
  pool.db.all<{ via: string; approvedByUserId: string | null }>(`SELECT via, "approvedByUserId" FROM "PoolAsk" WHERE "orgId" = $1`, [club.group.orgId]);
const toMembers = (ms: readonly SentMessage[], club: Club) => ms.filter((m) => m.to.startsWith(`${club.key}.`) && m.to !== `${club.key}.group`);

scenarios("an organiser asks the MatchTime player pool in the players' group", () => {
  scenario.afterEach(() => clearPipelineStubs());

  scenario("no admin group, the pool on: one line in the group, the nearby player's offer, the ask via words by the organiser", async ({ pool }) => {
    stubbedOnly();
    const fmc = await noHqClub(pool, "fmc");
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fmc) });

    const ex = await say(fmc, "owner", ASK);

    const line = ex.sent.find((m) => m.to === "fmc.group");
    expect(line?.text).toMatch(/^🔎 Asking nearby players from the MatchTime player pool for 1 place on .+\. I'll let you know when one takes a place\.$/);
    expect(ex.sent.filter((m) => m.purpose === "pool-offer").map((m) => m.to)).toEqual(["ali"]);
    expect(toMembers(ex.sent, fmc)).toEqual([]);
    const owner = await pool.userOf(fmc.member("owner"));
    expect(await poolAsks(pool, fmc)).toEqual([{ via: "words", approvedByUserId: owner!.id }]);
    expect(await offersOf(pool, ali)).toHaveLength(1);
    pool.expectNoLeaks(fmc.secrets(), { to: ["ali"] });
  });

  scenario("Turkish club: the Turkish line", async ({ pool }) => {
    stubbedOnly();
    const tr = await noHqClub(pool, "trk", { language: "tr" });
    await poolPlayer(pool, "can", { lang: "tr", at: near(tr) });

    const ex = await say(tr, "owner", ASK_TR);

    expect(ex.sent.find((m) => m.to === "trk.group")?.text).toMatch(/MatchTime oyuncu havuzundaki yakın oyunculara soruyorum \(1 kişi\)\. Biri yer alınca size haber vereceğim\.$/);
    expect((await poolAsks(pool, tr)).map((a) => a.via)).toEqual(["words"]);
  });

  scenario("the pool off for the club (or switched off): the same helpful line as HQ, nobody asked, no DM", async ({ pool }) => {
    stubbedOnly();
    const off = await noHqClub(pool, "off", { pool: { featurePlayerPool: false } });
    await poolPlayer(pool, "bea", { at: near(off) });

    const ex = await say(off, "owner", ASK);
    expect(ex.sent.find((m) => m.to === "off.group")?.text).toBe(
      "The MatchTime player pool is not open for your club yet. I can ask your players' group if anyone can play instead.",
    );
    expect(ex.sent.filter((m) => m.channel === "dm")).toEqual([]);
    expect(await poolAsks(pool, off)).toEqual([]);

    const on = await noHqClub(pool, "sw");
    const closed = await say(on, "owner", ASK, false);
    expect(closed.sent.find((m) => m.to === "sw.group")?.text).toMatch(/^The MatchTime player pool is not open for your club yet\./);
    expect(await poolAsks(pool, on)).toEqual([]);
  });

  scenario("a player who is not an organiser asking: nothing asked, no DM blast, no pool offer", async ({ pool }) => {
    stubbedOnly();
    const fmc = await noHqClub(pool, "ply");
    await poolPlayer(pool, "dua", { at: near(fmc) });

    const ex = await say(fmc, "pete", ASK);

    expect(ex.sent.filter((m) => m.channel === "dm")).toEqual([]);
    expect(ex.sent.some((m) => /MatchTime player pool/.test(m.text))).toBe(false);
    expect(await poolAsks(pool, fmc)).toEqual([]);
  });

  scenario("the router calling it admin_ops: the engine's pool_ask write reaches the same door", async ({ pool }) => {
    stubbedOnly();
    const fmc = await noHqClub(pool, "ops");
    await poolPlayer(pool, "eda", { at: near(fmc) });

    const ex = await say(fmc, "owner", ASK, true, "admin_ops");

    expect(ex.sent.find((m) => m.to === "ops.group")?.text).toMatch(/^🔎 Asking nearby players from the MatchTime player pool for 1 place/);
    expect(ex.sent.filter((m) => m.purpose === "pool-offer").map((m) => m.to)).toEqual(["eda"]);
    expect(toMembers(ex.sent, fmc)).toEqual([]);
  });

  scenario("a plain shortage ask from an organiser is still the recruit blast to the club's own past players (unchanged)", async ({ pool }) => {
    stubbedOnly();
    const fmc = await noHqClub(pool, "blast");
    const SHORT = "@Match Time we need one more, can you find someone";
    // The admin extractor reads the club's own players.
    const ex = await fmc.post("owner", SHORT, {
      route: "offer",
      facts: { ...facts([], { sideRequests: ["recruit"] }), ...FACTS, playersFrom: "club" },
      tag: true,
      headers: { "x-mt-test-pool-open": "1" },
    });
    expect(await poolAsks(pool, fmc)).toEqual([]);
    expect(ex.sent.filter((m) => m.purpose === "pool-offer")).toEqual([]);
    // The recruit ran (this club has no past games, so it had nobody to DM),
    // and with the pool open the reply offers it (2026-10-28): a question,
    // nothing asked until the organiser answers.
    expect(ex.json).toMatchObject({
      results: [
        expect.objectContaining({
          reply: "None of your recent players are left to ask for *Friday MT Community*. Want me to ask the MatchTime player pool?",
        }),
      ],
    });
  });
});
