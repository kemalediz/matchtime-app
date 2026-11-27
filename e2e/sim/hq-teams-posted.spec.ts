/**
 * THE ORGANISERS' OWN TEAMS, POSTED UNTAGGED IN HQ (FNF, 2026-11-27).
 *
 * FNF HQ, Fri 27 Nov 2026, a 9-a-side game with 18 confirmed: an admin
 * wrote the night's two teams to the other admins, untagged,
 *
 *   Captains:
 *
 *   Alamgir, Yorel, Wasim, Shehryar, Rafi, Feroz, Hamza, Mojib, Yaseen
 *
 *   Imti, Mo, Akram, Niro, Clarence, Imz, AH, Seb, Umar
 *
 * then asked a human for the graphic. MatchTime's TeamAssignment rows
 * stayed on its own earlier split. Kemal: "examine the messages going
 * forward to setup teams, this group is manually doing the teams, not
 * using MT". Now an organiser's untagged message that writes out both
 * teams becomes the teams, final, with nothing said anywhere; ordinary HQ
 * chat stays untouched and silent; a sheet with a name MatchTime cannot
 * place on one confirmed player writes nothing.
 *
 * FNF's own roster (`helpers/fnf-club.ts`): "Hamza" plays, "Hamzah" (the
 * owner) does not; "Umar" plays, "Umar Noor" does not; "AH" is the club's
 * alias for Abdul-Hafeez.
 *
 *   STUBBED (always runs): the teams extractor is stubbed (what the real
 *     model reads is the LIVE block and scripts/live-check-hq-teams-posted.ts),
 *     who-is-who is the test stand-in. Proves the route, the write, the
 *     silence and the refusals, through the real HQ door.
 *   LIVE (MT_SIM_LIVE_LLM=1, spends ANTHROPIC_API_KEY_DEV): the REAL teams
 *     extractor and who-is-who on the incident and on ordinary chat.
 *
 *   npx tsx e2e/run.ts sim/hq-teams-posted.spec.ts
 *   MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/hq-teams-posted.spec.ts
 */
import { test, expect, resetDb } from "../fixtures";
import { MATCH, ORG_ID, PHONE, U } from "../helpers/constants";
import { FNF_HQ, fnfIdOf, seedFnfClub } from "../helpers/fnf-club";
import { E2E } from "../helpers/env";
import { clearPipelineStubs, setExtractorStub, setRouterStub, stubCalls } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };

const RED = ["Alamgir", "Yorel", "Wasim", "Shehryar", "Rafi", "Feroz", "Hamza", "Mojib", "Yaseen"];
const YELLOW_WRITTEN = ["Imti", "Mo", "Akram", "Niro", "Clarence", "Imz", "AH", "Seb", "Umar"];
const YELLOW = ["Imti", "Mo", "Akram", "Niro", "Clarence", "Imz", "Abdul-Hafeez", "Seb", "Umar"];
const INCIDENT = `Captains:\n\n${RED.join(", ")}\n\n${YELLOW_WRITTEN.join(", ")}`;
const CHAT = "who's bringing the bibs tonight?";
const GRAPHIC_ASK = "@Raihan please do graphic for the teams";

/** MatchTime's own earlier split: the first nine of the squad red. */
const SQUAD = [...RED, ...YELLOW];
const MT_SPLIT: Array<[string, "RED" | "YELLOW"]> = SQUAD.map((n, i) => [n, i % 2 === 0 ? "RED" : "YELLOW"]);

async function seed(db: TestDb): Promise<void> {
  await seedFnfClub(db, { playing: SQUAD, bench: ["Hamzah", "Umar Noor"] });
  for (const [i, [name, team]] of MT_SPLIT.entries()) {
    await db.run(`INSERT INTO "TeamAssignment" (id, "matchId", "userId", team) VALUES ($1, $2, $3, $4::"Team")`, [`e2e-fnf-ta-${i}`, MATCH.upcoming, fnfIdOf(name), team]);
  }
  await db.run(`UPDATE "Match" SET status = 'TEAMS_GENERATED' WHERE id = $1`, [MATCH.upcoming]);
}

async function teamsNow(db: TestDb): Promise<Record<string, string>> {
  const rows = await db.all<{ userId: string; team: string }>(`SELECT "userId", team::text AS team FROM "TeamAssignment" WHERE "matchId" = $1`, [MATCH.upcoming]);
  return Object.fromEntries(rows.map((r) => [r.userId, r.team]));
}
const expected = (red: string[], yellow: string[]) =>
  Object.fromEntries([...red.map((n) => [fnfIdOf(n), "RED"]), ...yellow.map((n) => [fnfIdOf(n), "YELLOW"])]);
const mtSplit = () => Object.fromEntries(MT_SPLIT.map(([n, t]) => [fnfIdOf(n), t]));

const matchStatus = async (db: TestDb) => (await db.one<{ status: string }>(`SELECT status::text AS status FROM "Match" WHERE id = $1`, [MATCH.upcoming]))?.status;
const jobsSince = async (db: TestDb, since: Date) =>
  (await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM "BotJob" WHERE "orgId" = $1 AND "createdAt" >= $2`, [ORG_ID, since]))?.n ?? -1;

let seq = 0;
async function say(
  request: APIRequestContext,
  text: string,
  opts: { phone?: string; tagged?: boolean } = {},
): Promise<{ replyText: string | null; react?: string | null; outcome?: string; messageId: string }> {
  const messageId = `e2e-hq-posted-${Date.now()}-${++seq}`;
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: {
      channel: "admin-group",
      botMentioned: opts.tagged === true,
      groupId: FNF_HQ,
      messageId,
      text,
      senderPhone: (opts.phone ?? PHONE.admin).replace(/^\+/, ""),
      senderName: "Imz",
      timestamp: String(Math.floor(Date.now() / 1000)),
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  return { ...(await res.json()), messageId };
}

const setRaw = (sides: { red: string[]; yellow: string[] }) => ({
  action: "set",
  includeRefs: [],
  teamNames: [],
  swaps: [],
  moves: [],
  pairings: [],
  apart: [],
  sides,
  form: [],
  toMatchTime: false,
});
const showRaw = { action: "show", includeRefs: [], teamNames: [], swaps: [], moves: [], pairings: [], apart: [], sides: { red: [], yellow: [] }, form: [], toMatchTime: false };

test.describe("the organisers' own teams, posted untagged in HQ (stubbed)", () => {
  test.describe.configure({ mode: "serial" });
  test.afterAll(() => {
    clearPipelineStubs();
    resetDb();
  });

  test("the incident: the posted teams become the teams, final, nothing said, no tick, nothing queued", async ({ request, db }) => {
    resetDb();
    await seed(db);
    setRouterStub({});
    setExtractorStub({ byExtractor: { teams: { [INCIDENT]: setRaw({ red: RED, yellow: YELLOW_WRITTEN }) } } });
    const since = new Date(Date.now() - 1000);
    const out = await say(request, INCIDENT);
    expect(out.replyText ?? null).toBeNull();
    expect(out.react ?? null).toBeNull();
    expect(out.outcome).toBe("hq-teams-posted");
    expect(await teamsNow(db)).toEqual(expected(RED, YELLOW));
    // "Hamza" is Hamza, not the owner Hamzah; "Umar" is Umar, not Umar Noor.
    expect((await teamsNow(db))[fnfIdOf("Hamzah")]).toBeUndefined();
    expect((await teamsNow(db))[fnfIdOf("Umar Noor")]).toBeUndefined();
    expect(await matchStatus(db)).toBe("TEAMS_PUBLISHED");
    const proposal = await db.one<{ state: string; by: string | null }>(`SELECT state, "approvedByUserId" AS by FROM "AdminTeamProposal" WHERE "matchId" = $1`, [MATCH.upcoming]);
    expect(proposal).toEqual({ state: "approved", by: U.admin });
    // Nothing for HQ, nothing for the players' group.
    expect(await jobsSince(db, since)).toBe(0);
    // No router call: the teams extractor alone reads it.
    expect(stubCalls(E2E.ROUTER_STUB_FILE)).toHaveLength(0);
    const row = await db.one<{ outcome: string | null }>(`SELECT "hqOutcome" AS outcome FROM "AdminGroupMessage" WHERE "waMessageId" = $1`, [out.messageId]);
    expect(row?.outcome).toBe("hq-teams-posted");
  });

  test("a later posted sheet replaces the earlier one", async ({ request, db }) => {
    const swapped = { red: [...RED.slice(0, 8), "Imti"], yellow: ["Yaseen", ...YELLOW_WRITTEN.slice(1)] };
    const LATER = `Change: ${swapped.red.join(", ")}\n\n${swapped.yellow.join(", ")}`;
    setExtractorStub({ byExtractor: { teams: { [LATER]: setRaw(swapped) } } });
    const out = await say(request, LATER);
    expect(out.replyText ?? null).toBeNull();
    expect(out.outcome).toBe("hq-teams-posted");
    expect(await teamsNow(db)).toEqual(expected(swapped.red, ["Yaseen", ...YELLOW.slice(1)]));
  });

  test("ordinary HQ chat, and the graphic asked of a person: untouched and silent", async ({ request, db }) => {
    resetDb();
    await seed(db);
    setRouterStub({});
    setExtractorStub({ byExtractor: { teams: { [CHAT]: showRaw, [GRAPHIC_ASK]: showRaw } } });
    const since = new Date(Date.now() - 1000);
    for (const text of [CHAT, GRAPHIC_ASK]) {
      const out = await say(request, text);
      expect(out.replyText ?? null).toBeNull();
      expect(out.react ?? null).toBeNull();
    }
    expect(await teamsNow(db)).toEqual(mtSplit());
    expect(await matchStatus(db)).toBe("TEAMS_GENERATED");
    expect(await jobsSince(db, since)).toBe(0);
  });

  test("a name it cannot place on one confirmed player: nothing written, nothing said", async ({ request, db }) => {
    resetDb();
    await seed(db);
    // "Zed" is nobody in the club, in place of Umar.
    const bad = { red: RED, yellow: [...YELLOW_WRITTEN.slice(0, 8), "Zed"] };
    const TEXT = `${bad.red.join(", ")}\n\n${bad.yellow.join(", ")}`;
    setExtractorStub({ byExtractor: { teams: { [TEXT]: setRaw(bad) } } });
    const since = new Date(Date.now() - 1000);
    const out = await say(request, TEXT);
    expect(out.replyText ?? null).toBeNull();
    expect(out.react ?? null).toBeNull();
    expect(out.outcome).toBe("hq-teams-posted-not-applied");
    expect(await teamsNow(db)).toEqual(mtSplit());
    expect(await jobsSince(db, since)).toBe(0);
  });

  test("a name two members could be: never guessed, nothing written", async ({ request, db }) => {
    resetDb();
    await seed(db);
    setExtractorStub({
      byExtractor: { teams: { [INCIDENT]: setRaw({ red: RED, yellow: YELLOW_WRITTEN }) } },
      people: { [INCIDENT]: { Umar: { verdict: "ambiguous", names: ["Umar", "Umar Noor"] } } },
    });
    const out = await say(request, INCIDENT);
    expect(out.replyText ?? null).toBeNull();
    expect(out.outcome).toBe("hq-teams-posted-not-applied");
    expect(await teamsNow(db)).toEqual(mtSplit());
  });

  test("the same teams from someone who is not an organiser: never read", async ({ request, db }) => {
    resetDb();
    await seed(db);
    await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role, "createdAt") VALUES ('e2e-fnf-mem-pat', $1, $2, 'PLAYER', now())`, [U.player, ORG_ID]);
    setExtractorStub({ byExtractor: { teams: { [INCIDENT]: setRaw({ red: RED, yellow: YELLOW_WRITTEN }) } } });
    const out = await say(request, INCIDENT, { phone: PHONE.player });
    expect(out.replyText ?? null).toBeNull();
    expect(await teamsNow(db)).toEqual(mtSplit());
    expect(stubCalls(E2E.EXTRACTOR_STUB_FILE)).toHaveLength(0);
  });
});

(LIVE ? test.describe : test.describe.skip)("the organisers' own teams, LIVE (real teams extractor and who-is-who)", () => {
  test.describe.configure({ mode: "serial" });
  test.afterAll(() => resetDb());

  const usage = async (db: TestDb) =>
    db.one<{ calls: number; cost: number }>(`SELECT coalesce(sum(calls), 0)::int AS calls, coalesce(sum("costUsd"), 0)::float AS cost FROM "OrgAiUsage" WHERE "orgId" = $1`, [ORG_ID]);

  test("the incident: set, Hamza is Hamza and Umar is Umar, silent", async ({ request, db }) => {
    resetDb();
    await seed(db);
    const out = await say(request, INCIDENT);
    const u = await usage(db);
    console.log(`[hq-posted-live] ${JSON.stringify({ case: "incident", outcome: out.outcome ?? null, reply: out.replyText ?? null, calls: u?.calls ?? 0, costUsd: u?.cost ?? 0 })}`);
    expect(out.replyText ?? null).toBeNull();
    expect(out.outcome).toBe("hq-teams-posted");
    expect(await teamsNow(db)).toEqual(expected(RED, YELLOW));
  });

  test("ordinary chat: untouched and silent", async ({ request, db }) => {
    resetDb();
    await seed(db);
    for (const text of [CHAT, GRAPHIC_ASK]) {
      const out = await say(request, text);
      expect(out.replyText ?? null).toBeNull();
      expect(out.react ?? null).toBeNull();
    }
    const u = await usage(db);
    console.log(`[hq-posted-live] ${JSON.stringify({ case: "chat", calls: u?.calls ?? 0, costUsd: u?.cost ?? 0 })}`);
    expect(await teamsNow(db)).toEqual(mtSplit());
  });
});
