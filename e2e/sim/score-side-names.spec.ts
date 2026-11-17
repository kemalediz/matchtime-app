/**
 * Group-simulator scenarios: THE SCORE, WHATEVER THE CLUB CALLS ITS SIDES
 * (2026-11-17, Vets).
 *
 * The incident, 16 Nov 22:14: "@Match Time bibs 9, no bibs 4" after the
 * game. The router read it as an instruction (admin_ops), the admin
 * extractor said "other", and MatchTime answered "can't do that", twice.
 * The sides were only "Red" and "Yellow" in MatchTime's data.
 *
 * Through the REAL analyze route and a REAL test database, with the
 * router and the score extractor STUBBED with the raw JSON the live model
 * returns (never MT_SIM_LIVE_LLM). What runs for real: the awaited-score
 * line the router is shown, the extractor's THE GAME block, the parser,
 * the names placed before the engine, the engine, the question and its
 * row, the answer, the score write, the names remembered, the reply.
 *
 *   first time      one question, the answer "red" records Red 9 Yellow 4
 *                   and remembers bibs = Red, no bibs = Yellow FOR THAT GAME
 *   next week       MatchTime asks again, saying what it was last time (the
 *                   side that wears the bibs changes week to week: review of
 *                   #620), unless the club has named its sides
 *   a captain       "Dan's team won 5-3" records using Dan's line-up
 *   unchanged       "Red 9 Yellow 4" records as it always did
 *   banter          "great game lads" after the game stays silent
 *
 * Every person is made up; numbers are Ofcom's drama range.
 */
import { readFileSync } from "node:fs";
import { test, expect, resetDb } from "../fixtures";
import type { APIRequestContext } from "@playwright/test";
import type { TestDb } from "../helpers/test-db";
import { E2E } from "../helpers/env";
import { clearExtractorStub, clearRouterStub } from "../helpers/stub";
import { createGroup, type SimGroup, type SimPlayerSpec } from "./group";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

/** Six made-up players. Each group gets its own block of Ofcom drama
 *  numbers (+44 7700 9004xx), since a number is on one user only. */
let groupNo = 0;
const players = (n: number): SimPlayerSpec[] =>
  [
    { key: "ava", name: "Ava Stone", role: "OWNER" as const },
    { key: "ben", name: "Ben Cole", role: "ADMIN" as const },
    { key: "cal", name: "Cal Dunn" },
    { key: "dan", name: "Dan Hale" },
    { key: "eve", name: "Eve Long" },
    { key: "fay", name: "Fay Moss" },
  ].map((p, i) => ({ ...p, phone: `+4477009004${n}${i + 1}` }));
const TEAMS = { ava: "RED", ben: "RED", eve: "RED", cal: "YELLOW", dan: "YELLOW", fay: "YELLOW" } as const;

/** The score extractor's raw answer: every schema field, as the model sends it. */
const score = (o: Record<string, unknown>) => ({
  route: "score",
  facts: {
    hasScore: true,
    first: 0,
    second: 0,
    firstTeam: "",
    secondTeam: "",
    winner: "",
    loser: "",
    teamSides: [],
    momRef: "",
    correction: false,
    swapped: false,
    otherGame: false,
    ...o,
  },
});

function callsOf(file: string): Array<{ label?: string; user: string }> {
  try {
    return readFileSync(`${file}.calls`, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { label?: string; user: string });
  } catch {
    return [];
  }
}
const lastRouterTurn = () => callsOf(E2E.ROUTER_STUB_FILE).at(-1)?.user ?? "";
const lastScoreTurn = () => callsOf(E2E.EXTRACTOR_STUB_FILE).filter((c) => c.label === "extractor:score").at(-1)?.user ?? "";

async function newGroup(request: APIRequestContext, db: TestDb): Promise<SimGroup> {
  const g = await createGroup(request, db, {
    players: players(groupNo++),
    maxPlayers: 6,
    upcomingMatch: false,
    completedMatch: {
      hoursAgo: 3,
      status: "TEAMS_PUBLISHED",
      redScore: null,
      yellowScore: null,
      confirmedKeys: Object.keys(TEAMS),
      teams: { ...TEAMS },
    },
  });
  return g.attach(request);
}

const matchRow = (g: SimGroup, id: string) =>
  g.db.one<{ redScore: number | null; yellowScore: number | null; status: string }>(
    `SELECT "redScore", "yellowScore", status FROM "Match" WHERE id = $1`,
    [id],
  );

/** Next week's game: a later played match on the same activity, unscored. */
async function nextWeek(g: SimGroup): Promise<string> {
  const id = `${g.orgId}-next`;
  const date = new Date(Date.now() - 2 * 3_600_000);
  await g.db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline",
                          "redScore", "yellowScore", "postMatchEndFlow", "updatedAt")
     VALUES ($1, $2, $3, $4, 'TEAMS_PUBLISHED', $5, NULL, NULL, true, now())`,
    [id, g.activityId, date, g.maxPlayers, new Date(date.getTime() - 5 * 3_600_000)],
  );
  let pos = 0;
  for (const [key, team] of Object.entries(TEAMS)) {
    const p = g.player(key);
    await g.db.run(
      `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt") VALUES ($1, $2, $3, 'CONFIRMED', $4, now())`,
      [`${id}-att-${key}`, id, p.userId, ++pos],
    );
    await g.db.run(`INSERT INTO "TeamAssignment" (id, "matchId", "userId", team) VALUES ($1, $2, $3, $4)`, [
      `${id}-ta-${key}`,
      id,
      p.userId,
      team,
    ]);
  }
  return id;
}

(LIVE ? test.describe.skip : test.describe)("the score, whatever the club calls its sides", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(resetDb);
  test.beforeEach(() => {
    clearRouterStub();
    clearExtractorStub();
  });
  test.afterEach(() => {
    clearRouterStub();
    clearExtractorStub();
  });

  test("banter after the game is silent, and the router was told the score is awaited", async ({ request, db }) => {
    const g = await newGroup(request, db);
    const r = await g.post("eve", "great game lads", { route: "none" });
    expect(r.reply).toBeNull();
    expect(r.react).toBeNull();
    expect(r.groupPosts).toEqual([]);
    expect(lastRouterTurn()).toContain("MATCHTIME IS WAITING for the score of the club's last game");
    expect(lastRouterTurn()).toContain("Its two sides are Red and Yellow.");
    expect((await matchRow(g, g.completedMatchId!))?.redScore).toBeNull();
  });

  test("first time: one question; the answer records Red 9 Yellow 4 and is remembered for that game; next week it asks again with the hint", async ({ request, db }) => {
    const g = await newGroup(request, db);
    const BODY = "@Match Time bibs 9, no bibs 4";

    // ── the incident ──────────────────────────────────────────────────
    const asked = await g.post("ava", BODY, { tag: true, ...score({ first: 9, second: 4, firstTeam: "bibs", secondTeam: "no bibs" }) });
    expect(lastRouterTurn()).toContain("MATCHTIME IS WAITING for the score");
    expect(lastScoreTurn()).toContain('red: MatchTime calls it "Red"; players');
    expect(asked.reply).toBe('9 - 4, thanks. Which team was "bibs": Red or Yellow?');
    expect(asked.reply ?? "").not.toMatch(/can't|cannot/i);
    expect((await matchRow(g, g.completedMatchId!))?.redScore).toBeNull();
    const ask = await g.db.one<{ key: string; text: string | null }>(
      `SELECT key, text FROM "SentNotification" WHERE kind = 'score-ask' AND "matchId" = $1`,
      [g.completedMatchId],
    );
    expect(ask?.key).toBe(`${g.completedMatchId}:score-ask:9-4`);
    expect(JSON.parse(ask!.text!)).toEqual({ name: "bibs", other: "no bibs" });

    // ── the answer ────────────────────────────────────────────────────
    const answered = await g.post("ava", "@Match Time red", {
      tag: true,
      ...score({ hasScore: false, teamSides: [{ team: "bibs", side: "red" }] }),
    });
    expect(lastRouterTurn()).toContain("MATCHTIME IS WAITING to hear from this sender which team won");
    expect(answered.reply).toBe("Got it 👍 *Red (bibs)* won 9 - 4 against Yellow (no bibs). Recorded.");
    expect(await matchRow(g, g.completedMatchId!)).toMatchObject({ redScore: 9, yellowScore: 4, status: "COMPLETED" });
    const names = await g.db.one<{ text: string }>(
      `SELECT text FROM "SentNotification" WHERE kind = 'score-side-names' AND "matchId" = $1`,
      [g.completedMatchId],
    );
    expect(JSON.parse(names!.text)).toEqual({ red: ["bibs"], yellow: ["no bibs"] });
    // The question is closed by the write.
    expect(await g.db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE kind = 'score-ask' AND "matchId" = $1`, [g.completedMatchId])).toBe(0);

    // ── next week: asked again, last week's answer only a hint ─────────
    const next = await nextWeek(g);
    const again = await g.post("ben", BODY, { tag: true, ...score({ first: 9, second: 4, firstTeam: "bibs", secondTeam: "no bibs" }) });
    expect(lastRouterTurn()).not.toContain("also calls");
    expect(lastScoreTurn()).not.toContain('called it "bibs"');
    expect(again.reply).toBe('9 - 4, thanks. Which team was "bibs" this time: Red or Yellow? Last time it was Red.');
    expect((await matchRow(g, next))?.redScore).toBeNull();
    // This week the bibs were Yellow: the answer records it that way.
    const flipped = await g.post("ben", "@Match Time yellow", { tag: true, ...score({ hasScore: false, teamSides: [{ team: "bibs", side: "yellow", player: "" }] }) });
    expect(flipped.reply).toBe("Got it 👍 *Yellow (bibs)* won 9 - 4 against Red (no bibs). Recorded.");
    expect(await matchRow(g, next)).toMatchObject({ redScore: 4, yellowScore: 9, status: "COMPLETED" });
    const nextNames = await g.db.one<{ text: string }>(
      `SELECT text FROM "SentNotification" WHERE kind = 'score-side-names' AND "matchId" = $1`,
      [next],
    );
    expect(JSON.parse(nextNames!.text)).toEqual({ red: ["no bibs"], yellow: ["bibs"] });
  });

  test("a club that has named its sides records straight away, whatever earlier games said", async ({ request, db }) => {
    const g = await newGroup(request, db);
    await g.db.run(`UPDATE "Organisation" SET "teamLabels" = ARRAY['Bibs','No bibs'] WHERE id = $1`, [g.orgId]);
    const r = await g.post("ava", "@Match Time bibs 9, no bibs 4", { tag: true, ...score({ first: 9, second: 4, firstTeam: "bibs", secondTeam: "no bibs" }) });
    expect(r.reply).toBe("Got it 👍 *Bibs* won 9 - 4 against No bibs. Recorded.");
    expect(await matchRow(g, g.completedMatchId!)).toMatchObject({ redScore: 9, yellowScore: 4, status: "COMPLETED" });
  });

  test("\"Dan's team won 5-3\" records using Dan's side, with no question", async ({ request, db }) => {
    const g = await newGroup(request, db);
    const r = await g.post("cal", "@Match Time Dan's team won 5-3", {
      tag: true,
      ...score({ first: 5, second: 3, winner: "Dan's team", teamSides: [{ team: "Dan's team", side: "unknown", player: "Dan Hale" }] }),
    });
    // THE GAME listed Dan Hale on yellow: code places the side by that line-up.
    expect(lastScoreTurn()).toMatch(/yellow: MatchTime calls it "Yellow"; players [^\n]*Dan Hale/);
    expect(r.reply).toBe("Got it 👍 *Yellow* won 5 - 3 against Red. Recorded.");
    expect(await matchRow(g, g.completedMatchId!)).toMatchObject({ redScore: 3, yellowScore: 5 });
    // A player's team is never stored.
    expect(await g.db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE kind = 'score-side-names' AND "matchId" = $1`, [g.completedMatchId])).toBe(0);
  });

  test("\"Red 9 Yellow 4\" is unchanged", async ({ request, db }) => {
    const g = await newGroup(request, db);
    const r = await g.post("eve", "Red 9 Yellow 4", score({ first: 9, second: 4, firstTeam: "Red", secondTeam: "Yellow" }));
    expect(r.react).toBe("👍");
    expect(await matchRow(g, g.completedMatchId!)).toMatchObject({ redScore: 9, yellowScore: 4, status: "COMPLETED" });
    expect(await g.db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE kind = 'score-side-names' AND "matchId" = $1`, [g.completedMatchId])).toBe(0);
  });
});
