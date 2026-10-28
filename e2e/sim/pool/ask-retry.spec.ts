/**
 * POOL SCENARIOS: a refused ask, asked again once the venue is set (Kemal,
 * 2026-10-28). The real case, MT Test: no admin group; the organiser asked
 * in the players' group "ask the player pool ... for extra players for the
 * next match" at 15:37; the pool refused (the game had no venue); he set
 * the venue on the web at 15:39 and then had to say "added the venue
 * location", which MatchTime could not act on.
 *
 * Now: the refusal is remembered (`PoolAskRetry`); the organiser's venue
 * save on /admin/activities (the confirm line's "Add the place", a pasted
 * map link, the real server action) asks the pool again on its own, ONCE,
 * and posts the result in the players' group under one line saying why.
 * A second save posts nothing.
 *
 * Real routes, real database, the model STUBBED ($0), Google never asked
 * (a map link carries its coordinates).
 */
import type { Page } from "@playwright/test";
import { scenario, scenarios, stubbedOnly, expect } from "./fixtures";
import { near, offersOf, openClub, poolPlayer, type OpenClubOpts, type Spot } from "./offers-world";
import type { PoolWorld } from "./world";
import type { SentMessage } from "./transcript";
import { clearPipelineStubs, engineOn, facts } from "../../helpers/stub";
import { signInAs } from "../../fixtures";

const ASK = "@Match Time ask the player pool for extra players for the next match";
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
const OFFER_FACTS = { ...facts([], { sideRequests: ["recruit"] }), ...FACTS };
const NO_VENUE = expect.stringMatching(
  /^\*Player pool:\* I couldn't ask nearby players yet: MatchTime doesn't know where .+ plays, and pool players are found by how close they live to the pitch\. Set the venue on your weekly game here and I'll ask the pool straight away: \S+\/admin\/activities$/,
);

type Club = Awaited<ReturnType<typeof openClub>>;

/** MT Test: no admin group, no venue linked to its game, one place open. */
async function mtTest(pool: PoolWorld, key: string, opts: OpenClubOpts & { language?: "en" | "tr" } = {}): Promise<Club> {
  const { language, ...clubOpts } = opts;
  const club = await openClub(pool, key, { name: "MT Test", maxPlayers: 1, venue: null, ...clubOpts });
  if (language) await pool.db.run(`UPDATE "Organisation" SET language = $2 WHERE id = $1`, [club.group.orgId, language]);
  return club;
}

const askInGroup = (club: Club, text = ASK) => club.post("owner", text, { route: "offer", facts: OFFER_FACTS, tag: true });

const retryRows = (pool: PoolWorld, club: Club) =>
  pool.db.all<{ refusal: string; askedIn: string; claimedAt: Date | null; outcome: string | null; places: number }>(
    `SELECT refusal, "askedIn", "claimedAt", outcome, places FROM "PoolAskRetry" WHERE "orgId" = $1`,
    [club.group.orgId],
  );

/** The organiser on /admin/activities: the venue line's "Add the place" (or "Change"), a pasted map link. */
async function saveVenueOnWeb(pool: PoolWorld, page: Page, club: Club, at: Spot, opts: { racing?: boolean } = {}): Promise<void> {
  const owner = await pool.userOf(club.member("owner"));
  await signInAs(page, owner!.id, "/admin/activities");
  pool.log({ kind: "in", from: `${club.key}.owner`, channel: "dm", text: `(web) venue set to ${at.lat},${at.lng}` });
  const line = page.getByTestId(`venue-loc-${club.group.activityId}`);
  await expect(line).toBeVisible({ timeout: 30_000 });
  // The page speaks the club's language: English or Turkish labels.
  if (!(await line.getByTestId("venue-loc-form").isVisible())) await line.getByRole("button", { name: /^(Change|Add the place|Değiştir|Yeri ekle)$/ }).click();
  await line.getByLabel(/^(Address or map link|Adres veya harita bağlantısı)$/).fill(`https://www.google.com/maps/place/MT+Pitch/@${at.lat},${at.lng},17z`);
  await line.getByRole("button", { name: /^(Find place|Yeri bul)$/ }).click();
  // Two saves racing: the page answers when its own save is done.
  // Two saves racing: either may land last, so only "a place is linked" is waited for here.
  if (opts.racing) {
    await expect.poll(async () => (await pool.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM "VenueLookup" WHERE "activityId" = $1 AND kind = 'pin'`, [club.group.activityId]))?.n ?? 0, { timeout: 20_000 }).toBeGreaterThan(0);
    return;
  }
  await expect
    .poll(async () => (await pool.db.one<{ venueId: string | null; lat: number | null }>(
      `SELECT a."venueId", v.lat FROM "Activity" a LEFT JOIN "Venue" v ON v.id = a."venueId" WHERE a.id = $1`,
      [club.group.activityId],
    ))?.lat, { timeout: 20_000 })
    .toBeCloseTo(at.lat, 5);
}

/** What MatchTime queued in the club's players' group from now on, waiting up to `ms` for `want` posts. */
async function groupPostsWithin(pool: PoolWorld, club: Club, want: number, ms: number): Promise<SentMessage[]> {
  const got: SentMessage[] = [];
  const until = Date.now() + ms;
  while (Date.now() < until) {
    got.push(...(await pool.collect()).filter((m) => m.to === `${club.key}.group`));
    if (got.length >= want) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  return got;
}

scenarios("a refused pool ask is asked again once the venue is set", () => {
  scenario.afterEach(() => clearPipelineStubs());

  scenario("MT Test: refused no venue; the venue saved on the web asks again, one post in the group; a second save posts nothing", async ({ pool, page }) => {
    stubbedOnly();
    const mt = await mtTest(pool, "mtt");
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(mt) });

    // 15:37: the ask, refused for the venue.
    const ex = await askInGroup(mt);
    expect(ex.sent.find((m) => m.to === "mtt.group")?.text).toEqual(NO_VENUE);
    expect(await offersOf(pool, ali)).toHaveLength(0);
    expect(await retryRows(pool, mt)).toEqual([{ refusal: "no-venue", askedIn: "group", claimedAt: null, outcome: null, places: 1 }]);

    // 15:39: the venue set on the web. Nobody says "done".
    await saveVenueOnWeb(pool, page, mt, mt.spot);
    const posts = await groupPostsWithin(pool, mt, 1, 20_000);
    expect(posts.map((m) => m.text)).toEqual([
      expect.stringMatching(
        /^Your pitch is set, so I've asked the player pool now:\n🔎 Asking nearby players from the MatchTime player pool for 1 place on .+\. I'll let you know when one takes a place\.$/,
      ),
    ]);
    expect(pool.sent.filter((m) => m.purpose === "pool-offer").map((m) => m.to)).toEqual(["ali"]);
    expect(await offersOf(pool, ali)).toHaveLength(1);
    const owner = await pool.userOf(mt.member("owner"));
    expect(await pool.db.all(`SELECT via, "approvedByUserId" FROM "PoolAsk" WHERE "orgId" = $1`, [mt.group.orgId])).toEqual([
      { via: "words", approvedByUserId: owner!.id },
    ]);
    expect(await retryRows(pool, mt)).toEqual([expect.objectContaining({ claimedAt: expect.any(Date), outcome: "hq-pool-asked" })]);

    // The venue saved again: nothing more.
    await saveVenueOnWeb(pool, page, mt, near(mt));
    expect(await groupPostsWithin(pool, mt, 1, 4_000)).toEqual([]);
    expect(await pool.db.all(`SELECT id FROM "PoolAsk" WHERE "orgId" = $1`, [mt.group.orgId])).toHaveLength(1);
    pool.expectNoLeaks(mt.secrets(), { to: ["ali"] });
  });

  scenario("asked again and refused again (nobody near the new venue): the reason is posted once, nothing more kept", async ({ pool, page }) => {
    stubbedOnly();
    const mt = await mtTest(pool, "far");

    const ex = await askInGroup(mt);
    expect(ex.sent.find((m) => m.to === "far.group")?.text).toEqual(NO_VENUE);

    await saveVenueOnWeb(pool, page, mt, mt.spot);
    const posts = await groupPostsWithin(pool, mt, 1, 20_000);
    expect(posts.map((m) => m.text)).toEqual([
      expect.stringMatching(/^Your pitch is set, so I tried the player pool again:\n\*Player pool:\* (nobody new to ask\. Of the pool players near .+, 1 lives further away than they travel\.|I didn't ask anyone: no pool player near your pitch is free to be asked for this game right now\.) I can ask your players' group instead\.$/),
    ]);
    expect(await retryRows(pool, mt)).toEqual([expect.objectContaining({ claimedAt: expect.any(Date), outcome: "hq-pool-not-asked" })]);

    await saveVenueOnWeb(pool, page, mt, near(mt));
    expect(await groupPostsWithin(pool, mt, 1, 4_000)).toEqual([]);
  });

  scenario("Turkish club: the Turkish line on top of the Turkish reply", async ({ pool, page }) => {
    stubbedOnly();
    const tr = await mtTest(pool, "trk", { language: "tr" });
    await poolPlayer(pool, "can", { lang: "tr", at: near(tr) });

    await askInGroup(tr, "@Match Time havuzdan bir sonraki maç için oyuncu bul");
    await saveVenueOnWeb(pool, page, tr, tr.spot);
    const posts = await groupPostsWithin(pool, tr, 1, 20_000);
    expect(posts.map((m) => m.text)).toEqual([
      expect.stringMatching(/^Sahanız kaydedildi, oyuncu havuzuna şimdi sordum:\n[\s\S]*MatchTime oyuncu havuzundaki yakın oyunculara soruyorum \(1 kişi\)/),
    ]);
  });

  scenario("asked in the admin group: the retry is posted back in the admin group, never in the players' group", async ({ pool, page }) => {
    stubbedOnly();
    const fnf = await mtTest(pool, "hqc", { name: "FNF", hq: true });
    const ali = await poolPlayer(pool, "eli", { at: near(fnf) });
    const HQ_ASK = "@Match Time ask the pool for a player";
    pool.arm(() => engineOn({ [HQ_ASK]: { route: "ask_group", facts: FACTS } }));

    const ex = await fnf.hq.say("owner", HQ_ASK);
    expect(ex.sent.find((m) => m.to === "hqc.hq")?.text).toEqual(NO_VENUE);
    expect(await retryRows(pool, fnf)).toEqual([expect.objectContaining({ askedIn: "hq", claimedAt: null })]);

    await saveVenueOnWeb(pool, page, fnf, fnf.spot);
    const posts: SentMessage[] = [];
    const until = Date.now() + 20_000;
    while (Date.now() < until && posts.length === 0) {
      posts.push(...(await pool.collect()).filter((m) => m.to === "hqc.hq" || m.to === "hqc.group"));
      if (posts.length === 0) await new Promise((r) => setTimeout(r, 300));
    }
    expect(posts.map((m) => [m.to, m.text])).toEqual([
      ["hqc.hq", expect.stringMatching(/^Your pitch is set, so I've asked the player pool now:\n🔎 Asking nearby players from the MatchTime player pool for 1 place on .+\. I'll tell you here when one takes a place\.$/)],
    ]);
    expect(await offersOf(pool, ali)).toHaveLength(1);
  });

  scenario("two venue saves at once: the pool is asked once, one post", async ({ pool, page, browser }) => {
    stubbedOnly();
    const mt = await mtTest(pool, "two");
    await poolPlayer(pool, "fay", { at: near(mt) });
    await askInGroup(mt);

    const other = await browser.newPage();
    try {
      await Promise.all([saveVenueOnWeb(pool, page, mt, mt.spot, { racing: true }), saveVenueOnWeb(pool, other, mt, near(mt), { racing: true })]);
    } finally {
      await other.close();
    }
    const posts = await groupPostsWithin(pool, mt, 2, 8_000);
    expect(posts).toHaveLength(1);
    expect(await pool.db.all(`SELECT id FROM "PoolAsk" WHERE "orgId" = $1`, [mt.group.orgId])).toHaveLength(1);
  });

  scenario("a refusal the club cannot fix by a setting (the pool closed for it) is never kept, and a venue save posts nothing", async ({ pool, page }) => {
    stubbedOnly();
    const off = await mtTest(pool, "off", { pool: { featurePlayerPool: false } });
    await askInGroup(off);
    expect(await retryRows(pool, off)).toEqual([]);
    await saveVenueOnWeb(pool, page, off, off.spot);
    expect(await groupPostsWithin(pool, off, 1, 4_000)).toEqual([]);
  });
});
