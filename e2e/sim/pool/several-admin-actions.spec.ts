/**
 * POOL SCENARIOS: ONE MESSAGE, SEVERAL ADMIN ACTIONS, IN ORDER (Sutton FC,
 * 2026-11-23 14:44).
 *
 * The owner wrote "@Match Time switch to 5aside, then invite local player
 * pool for the remaining slots". MatchTime switched Tuesday's game to
 * 5-a-side ("Done: Tuesday is 5-a-side now, 10 places. I've posted the new
 * list.") and never asked the pool for the 3 open places, nor said so: the
 * admin extractor's prompt allowed exactly one action.
 *
 * Now the admin extractor lists every action (stubbed here as the model's
 * list, $0); the admin owner does each, in order, through the shipped
 * cores: the switch through `format-switch-words.ts`, then the pool through
 * the engine's `pool_ask` write and the route's batch-final pass
 * (`pool-ask-words.ts`), which counts the places left at the NEW size. The
 * group gets ONE reply carrying both lines.
 *
 * Real routes, real database, the model stubbed. People and numbers made up.
 */
import { scenario, scenarios, stubbedOnly, expect } from "./fixtures";
import { near, openClub, poolPlayer } from "./offers-world";
import type { PoolWorld } from "./world";
import { clearPipelineStubs } from "../../helpers/stub";

const INCIDENT = "@Match Time switch to 5aside, then invite local player pool for the remaining slots";
const INCIDENT_TR = "@Match Time 5'e 5 yap, sonra kalan yerler için yakındaki havuzdan oyuncu çağır";
const OTHER_PART = "@Match Time switch to 5aside and order new bibs";

/** One action of the admin extractor's list, every field present. */
const action = (o: Record<string, unknown>) => ({
  words: "",
  payerRef: "",
  count: 0,
  coveredRefs: [],
  undo: false,
  matchDay: "",
  pastGame: false,
  phrase: "",
  remindAt: "",
  note: "",
  lookbackMatches: 0,
  playersFrom: [],
  clubRef: "",
  venueName: "",
  venueChoice: 0,
  breakMonths: [],
  playMonths: [],
  quietOff: false,
  quietFrom: "",
  quietTo: "",
  minPlayers: 0,
  maxPlayers: 0,
  fullTeams: false,
  openSquadOff: false,
  size: 0,
  aSide: false,
  game: 0,
  newDay: "",
  newTime: "",
  everyWeek: false,
  coverage: "",
  ...o,
});
const SWITCH_5 = action({ action: "switch_format", words: "switch to 5aside", size: 5, aSide: true });
const POOL = action({ action: "recruit", words: "invite local player pool for the remaining slots", playersFrom: ["pool"] });

const SEVEN = ["owner", "alice", "brian", "pete", "dan", "felix", "greg"];

/** A 7-a-side club with no admin group, 7 confirmed of 14, that may play 5,
 *  6 or 7 a side; the pool open, its venue set. */
async function suttonLike(pool: PoolWorld, key: string, language: "en" | "tr" = "en") {
  const club = await openClub(pool, key, {
    name: "Sutton Sim FC",
    maxPlayers: 14,
    attendance: SEVEN.map((k) => ({ key: k, status: "CONFIRMED" as const })),
  });
  await pool.db.run(`UPDATE "Activity" SET "minPlayers" = 10, "maxPlayers" = 14 WHERE id = $1`, [club.group.activityId]);
  if (language !== "en") await pool.db.run(`UPDATE "Organisation" SET language = $2 WHERE id = $1`, [club.group.orgId, language]);
  return club;
}

const matchSize = async (pool: PoolWorld, matchId: string) =>
  (await pool.db.one<{ maxPlayers: number }>(`SELECT "maxPlayers" FROM "Match" WHERE id = $1`, [matchId]))!.maxPlayers;
const poolAsks = (pool: PoolWorld, orgId: string) =>
  pool.db.all<{ via: string; places: number }>(`SELECT via, places FROM "PoolAsk" WHERE "orgId" = $1`, [orgId]);

scenarios("one message asks for several admin actions (Sutton FC, 2026-11-23)", () => {
  scenario.afterEach(() => clearPipelineStubs());

  scenario("the incident: switched to 5-a-side, THEN the pool asked for the 3 places left, ONE reply with both", async ({ pool }) => {
    stubbedOnly();
    const club = await suttonLike(pool, "sut");
    await poolPlayer(pool, "ali", { at: near(club) });

    const ex = await club.post("owner", INCIDENT, {
      route: "admin_ops",
      facts: { toMatchTime: true, actions: [SWITCH_5, POOL] },
      tag: true,
      headers: { "x-mt-test-pool-open": "1" },
    });

    // Every action carried out, the second against the state the first left.
    expect(await matchSize(pool, club.group.matchId!)).toBe(10);
    expect(await poolAsks(pool, club.group.orgId)).toEqual([{ via: "words", places: 3 }]);
    expect(ex.sent.filter((m) => m.purpose === "pool-offer").map((m) => m.to)).toEqual(["ali"]);

    // ONE reply: the switch's line, then the pool's.
    const reply = (ex.json.results as Array<{ reply: string | null }>)[0].reply ?? "";
    console.log(`[several-admin-actions] the one reply:\n${reply}`);
    const blocks = reply.split("\n\n");
    expect(blocks[0]).toMatch(/5-a-side now, 10 places/);
    expect(blocks[blocks.length - 1]).toMatch(/^🔎 Asking nearby players from the MatchTime player pool for 3 places on .+\./);
    expect(reply).not.toMatch(/couldn't do/);
  });

  scenario("Turkish: the same two actions, the Turkish lines", async ({ pool }) => {
    stubbedOnly();
    const club = await suttonLike(pool, "trs", "tr");
    await poolPlayer(pool, "can", { lang: "tr", at: near(club) });

    const ex = await club.post("owner", INCIDENT_TR, {
      route: "admin_ops",
      facts: { toMatchTime: true, actions: [{ ...SWITCH_5, words: "5'e 5 yap" }, { ...POOL, words: "kalan yerler için havuzdan oyuncu çağır" }] },
      tag: true,
      headers: { "x-mt-test-pool-open": "1" },
    });

    expect(await matchSize(pool, club.group.matchId!)).toBe(10);
    expect((await poolAsks(pool, club.group.orgId)).map((a) => a.places)).toEqual([3]);
    const reply = (ex.json.results as Array<{ reply: string | null }>)[0].reply ?? "";
    console.log(`[several-admin-actions] TR reply:\n${reply}`);
    expect(reply).toMatch(/MatchTime oyuncu havuzundaki yakın oyunculara soruyorum \(3 kişi\)/);
  });

  scenario("an action MatchTime has no action for: the switch done, and the one reply names the rest in the owner's words", async ({ pool }) => {
    stubbedOnly();
    const club = await suttonLike(pool, "oth");

    const ex = await club.post("owner", OTHER_PART, {
      route: "admin_ops",
      facts: { toMatchTime: true, actions: [SWITCH_5, action({ action: "other", words: "order new bibs" })] },
      tag: true,
    });

    expect(await matchSize(pool, club.group.matchId!)).toBe(10);
    const reply = (ex.json.results as Array<{ reply: string | null }>)[0].reply ?? "";
    expect(reply).toMatch(/5-a-side now, 10 places/);
    expect(reply).toContain('I couldn\'t do this part of your message: "order new bibs". Please ask me for it on its own.');
  });

  scenario("a player who is not an organiser: nothing switched, nobody asked, each action's refusal", async ({ pool }) => {
    stubbedOnly();
    const club = await suttonLike(pool, "ply");
    await poolPlayer(pool, "dua", { at: near(club) });

    const ex = await club.post("pete", INCIDENT, {
      route: "admin_ops",
      facts: { toMatchTime: true, actions: [SWITCH_5, POOL] },
      tag: true,
      headers: { "x-mt-test-pool-open": "1" },
    });

    expect(await matchSize(pool, club.group.matchId!)).toBe(14);
    expect(await poolAsks(pool, club.group.orgId)).toEqual([]);
    expect(ex.sent.filter((m) => m.purpose === "pool-offer")).toEqual([]);
    const reply = (ex.json.results as Array<{ reply: string | null }>)[0].reply ?? "";
    expect(reply).toMatch(/^Only .+ can change that\.\n\nOnly .+ can ask for players\.$/);
  });
});
