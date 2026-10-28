/**
 * "SET THE PITCH" AND "TRY AGAIN" BY WHATSAPP (2026-10-28, Kemal: every
 * admin feature also works by an owner or admin tagging MatchTime).
 *
 * The real case, MT Test 15:38 to 15:40 UTC: "@Match Time ask the player
 * pool and partner clubs for extra players" was refused for want of a
 * venue; the organiser fixed it and said "@Match Time added the venue
 * location", and heard "I can't change that by message".
 *
 * Real routes, real database, the model STUBBED ($0): the router's route
 * and the admin extractor's facts are what the stub says (what the real
 * model says for these words is the paid check,
 * scripts/live-check-admin-retry-venue.ts). Google's Places answers are
 * stubbed too (`setGeocodeStub`). Everything after is the shipped code: the
 * tag and organiser gates, `venue-from-words.ts` choosing and setting the
 * place, the stored ask read back from the first message's pipeline trace
 * (`refused-ask-retry.ts`), and the pool door (`pool-ask-words.ts`).
 *
 *   players' group, no HQ    ask refused, pitch set, try again: the ask goes out
 *   Turkish, several places  the numbered list, then "@Match Time 2" sets it
 *   a player tagging         the organisers-only line, nothing set
 *   nothing to try again     one short line, never "I can't change that"
 *   HQ                        the same three steps from the organisers' group
 */
import { scenario, scenarios, stubbedOnly, expect } from "./fixtures";
import { near, openClub, poolPlayer, type OpenClubOpts } from "./offers-world";
import type { PoolWorld } from "./world";
import { clearPipelineStubs, engineOn } from "../../helpers/stub";
import { googlePlace, placeDetailsBody, placesSuggestions, setGeocodeStub } from "../../helpers/geocode-stub";

const BASE = { payerRef: "", count: 0, coveredRefs: [], undo: false, matchDay: "", pastGame: false, phrase: "", note: "", lookbackMatches: 0, playersFrom: [], clubRef: "", venueName: "", venueChoice: 0, toMatchTime: true };
const ASK_FACTS = { ...BASE, action: "recruit", playersFrom: ["pool"] };
const pitchFacts = (venueName: string, venueChoice = 0) => ({ ...BASE, action: "set_venue", venueName, venueChoice });
const RETRY_FACTS = { ...BASE, action: "retry_ask" };

const ASK = "@Match Time ask the player pool for extra players for the next match";
const PITCH = "@Match Time our pitch is Goals Sutton";
const RETRY = "@Match Time done, try again";

type Club = Awaited<ReturnType<typeof openClub>>;

/** A club with no geocoded venue (so the pool refuses), the pool on, one place open. */
async function noVenueClub(pool: PoolWorld, key: string, opts: OpenClubOpts & { language?: "en" | "tr" } = {}): Promise<Club> {
  const { language, ...clubOpts } = opts;
  const club = await openClub(pool, key, { name: "MT Test", maxPlayers: 1, venue: null, ...clubOpts });
  if (language) await pool.db.run(`UPDATE "Organisation" SET language = $2 WHERE id = $1`, [club.group.orgId, language]);
  return club;
}

/** Google's Places answers for "Goals Sutton", placed at the club's own spot. */
function googleKnows(club: Club, places: Array<{ placeId: string; main: string; secondary: string; address: string }>, input = "goals sutton"): void {
  setGeocodeStub({
    geocode: { "*": { body: googlePlace({ placeId: "ChIJukpoint00000", address: "Sutton, UK", lat: club.spot.lat, lng: club.spot.lng }) } },
    places: {
      autocomplete: { [input]: { body: placesSuggestions(places) } },
      details: Object.fromEntries(places.map((p) => [p.placeId, { body: placeDetailsBody({ placeId: p.placeId, name: p.main, address: p.address, lat: club.spot.lat, lng: club.spot.lng }) }])),
    },
  });
}
const GOALS = { placeId: "ChIJgoalssutton0001", main: "Goals Sutton", secondary: "Oxford Road, Sutton, UK", address: "Oxford Rd, Sutton SM1 2AA, UK" };
const GOALS_2 = { placeId: "ChIJgoalssutton0002", main: "Goals Sutton", secondary: "Sutton Common Road, Sutton, UK", address: "Sutton Common Rd, Sutton SM3 9PQ, UK" };

const venueOf = (pool: PoolWorld, club: Club) =>
  pool.db.one<{ venue: string; placeId: string | null; confirmed: boolean; home: string | null }>(
    `SELECT a.venue, v."placeId", a."venueConfirmedAt" IS NOT NULL AS confirmed, (SELECT hv."placeId" FROM "Organisation" o LEFT JOIN "Venue" hv ON hv.id = o."homeVenueId" WHERE o.id = a."orgId") AS home
       FROM "Activity" a LEFT JOIN "Venue" v ON v.id = a."venueId" WHERE a.id = $1`,
    [club.group.activityId],
  );
const poolAsks = (pool: PoolWorld, club: Club) => pool.db.all<{ via: string }>(`SELECT via FROM "PoolAsk" WHERE "orgId" = $1`, [club.group.orgId]);
/** MatchTime's reply in the players' group: the last line it posted there
 *  for this message (a squad post the same request queued comes first). */
const groupLine = (sent: ReadonlyArray<{ to: string; text: string }>, club: Club) => sent.filter((m) => m.to === `${club.key}.group`).at(-1)?.text ?? null;
const pg = (club: Club, member: string, text: string, facts: Record<string, unknown>, route = "admin_ops") =>
  club.post(member, text, { route, facts, tag: true, headers: { "x-mt-test-pool-open": "1" } });

scenarios("set the pitch, and try again after a refusal, by WhatsApp", () => {
  scenario.afterEach(() => clearPipelineStubs());

  scenario("players' group, no HQ: the ask is refused for want of a venue, the pitch is set, try again asks the pool", async ({ pool }) => {
    stubbedOnly();
    const mt = await noVenueClub(pool, "mtt");
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(mt) });
    googleKnows(mt, [GOALS]);

    const refused = await pg(mt, "owner", ASK, ASK_FACTS);
    expect(groupLine(refused.sent, mt)).toMatch(/venue/i);
    expect(await poolAsks(pool, mt)).toEqual([]);

    const set = await pg(mt, "owner", PITCH, pitchFacts("Goals Sutton"));
    expect(groupLine(set.sent, mt)).toBe(
      "📍 Done, your pitch is *Goals Sutton*, Oxford Rd, Sutton SM1 2AA, UK.\nNot the right place? Change it here: " +
        `${process.env.NEXTAUTH_URL?.replace(/\/+$/, "") ?? "https://matchtime.ai"}/admin/settings#club-venue`,
    );
    // Set where the web sets it: the game's venue (unconfirmed: one clear
    // match, not a pick) and the club's home venue.
    expect(await venueOf(pool, mt)).toEqual({ venue: "Goals Sutton", placeId: GOALS.placeId, confirmed: false, home: GOALS.placeId });

    // The router sends it to `question` (as the paid check saw): read anyway,
    // as the organisers' follow-up to their own ask a minute ago.
    const again = await pg(mt, "owner", RETRY, RETRY_FACTS, "question");
    expect(groupLine(again.sent, mt)).toMatch(/^🔎 Asking nearby players from the MatchTime player pool for 1 place/);
    expect(again.sent.filter((m) => m.purpose === "pool-offer").map((m) => m.to)).toEqual(["ali"]);
    expect(await poolAsks(pool, mt)).toEqual([{ via: "words" }]);
    pool.expectNoLeaks(mt.secrets(), { to: ["ali"] });
  });

  scenario("Turkish club, two places of that name: the numbered list in Turkish, then \"@Match Time 2\" sets the second, confirmed", async ({ pool }) => {
    stubbedOnly();
    const tr = await noVenueClub(pool, "trk", { language: "tr" });
    googleKnows(tr, [GOALS, GOALS_2]);

    const list = await pg(tr, "owner", "@Match Time sahamız Goals Sutton", pitchFacts("Goals Sutton"));
    expect(groupLine(list.sent, tr)).toBe(
      "*Goals Sutton* için birden fazla yer buldum. Hangisi?\n1. Goals Sutton, Oxford Road, Sutton, UK\n2. Goals Sutton, Sutton Common Road, Sutton, UK\n\nNumarasıyla beni etiketleyin, örneğin: *@Match Time 1*",
    );
    expect((await venueOf(pool, tr))?.placeId).toBeNull();

    // "@Match Time 2", routed `question`: found as the answer to the list by
    // its position, looked up again for the list's own words.
    const picked = await pg(tr, "owner", "@Match Time 2", pitchFacts("", 2), "question");
    expect(groupLine(picked.sent, tr)).toMatch(/^📍 Tamam, sahanız \*Goals Sutton\*, Sutton Common Rd, Sutton SM3 9PQ, UK\./);
    expect(await venueOf(pool, tr)).toEqual({ venue: "Goals Sutton", placeId: GOALS_2.placeId, confirmed: true, home: GOALS_2.placeId });
  });

  scenario("a player tagging MatchTime with the pitch, or to try again: the organisers-only line, nothing set or asked", async ({ pool }) => {
    stubbedOnly();
    const mt = await noVenueClub(pool, "ply");
    googleKnows(mt, [GOALS]);

    const pitch = await pg(mt, "pete", PITCH, pitchFacts("Goals Sutton"));
    expect(groupLine(pitch.sent, mt)).toMatch(/^Only .+ can change that/);
    expect((await venueOf(pool, mt))?.placeId).toBeNull();

    const retry = await pg(mt, "pete", RETRY, RETRY_FACTS);
    expect(groupLine(retry.sent, mt)).toMatch(/^Only .+ can change that/);
    expect(await poolAsks(pool, mt)).toEqual([]);
  });

  scenario("try again with nothing asked before: one short line, never the generic \"I can't change that by message\"", async ({ pool }) => {
    stubbedOnly();
    const mt = await noVenueClub(pool, "none");
    const r = await pg(mt, "owner", RETRY, RETRY_FACTS);
    expect(groupLine(r.sent, mt)).toBe("👍 Thanks. There's nothing of mine waiting to try again.");
  });

  scenario("nothing found on the map: said, with the settings link, nothing set", async ({ pool }) => {
    stubbedOnly();
    const mt = await noVenueClub(pool, "nf");
    googleKnows(mt, [], "nowhere park");
    const r = await pg(mt, "owner", "@Match Time our pitch is Nowhere Park", pitchFacts("Nowhere Park"));
    expect(groupLine(r.sent, mt)).toMatch(/^I couldn't find \*Nowhere Park\* on the map\. You can set your pitch here: .+\/admin\/settings#club-venue$/);
    expect((await venueOf(pool, mt))?.placeId).toBeNull();
  });

  scenario("HQ: the same three steps from the organisers' group, nothing in the players' group", async ({ pool }) => {
    stubbedOnly();
    const fnf = await noVenueClub(pool, "hq", { name: "FNF", hq: true });
    const bea = await poolPlayer(pool, "bea", { name: "Bea Lane", at: near(fnf) });
    // Its own place id: the shared Venue row of an id keeps the first
    // scenario's position (places are shared across clubs by id).
    const HQ_GOALS = { ...GOALS, placeId: "ChIJgoalssuttonhq01" };
    googleKnows(fnf, [HQ_GOALS]);
    pool.arm(() =>
      engineOn({
        [ASK]: { route: "admin_ops", facts: ASK_FACTS },
        [PITCH]: { route: "admin_ops", facts: pitchFacts("Goals Sutton") },
        // ask_group, as the live router routed it in HQ.
        [RETRY]: { route: "ask_group", facts: RETRY_FACTS },
      }),
    );

    const refused = await fnf.hq.say("owner", ASK, { poolOpen: true });
    expect(refused.sent.find((m) => m.to === "hq.hq")?.text).toMatch(/venue/i);
    const set = await fnf.hq.say("owner", PITCH, { poolOpen: true });
    expect(set.sent.find((m) => m.to === "hq.hq")?.text).toMatch(/^📍 Done, your pitch is \*Goals Sutton\*, Oxford Rd, Sutton SM1 2AA, UK\./);
    expect(await venueOf(pool, fnf)).toEqual({ venue: "Goals Sutton", placeId: HQ_GOALS.placeId, confirmed: false, home: HQ_GOALS.placeId });
    const again = await fnf.hq.say("owner", RETRY, { poolOpen: true });
    expect(again.sent.find((m) => m.to === "hq.hq")?.text).toMatch(/^🔎 Asking nearby players from the MatchTime player pool for 1 place/);
    expect(again.sent.filter((m) => m.purpose === "pool-offer").map((m) => m.to)).toEqual(["bea"]);
    expect(pool.sent.filter((m) => m.to === "hq.group")).toEqual([]);
  });
});
