/**
 * A QUESTION IN THE SAME BATCH AS A SQUAD CHANGE: THE BATCH'S SQUAD POST IS
 * NEVER SWALLOWED (PR #604, 2026-11-15/16).
 *
 * Found by this spec (item 5 of the #595 review): with UNIFIED_ANSWERS on,
 * "Ian Innes is in" (from an admin) beside "@Match Time who's on the bench?"
 * lost the squad post. The route put the `[SQUAD]` marker on the LAST reply
 * that speaks, the unified answer; the squad composition skips that intent;
 * and the last-line strip removed the unrendered marker (traced with a
 * temporary log, 2026-11-15). The same happened beside any reply the
 * composition skips (the open answer, help, stats answers, ...).
 *
 * Fixed (`squad-post-carrier.ts`): the marker goes on the last speaking reply
 * the composition renders, else on the message that changed the squad. So
 * the batch sends ONE squad post on the IN and the question's own answer
 * beside it, never two squad posts.
 *
 * AND NEVER TWO TEAM SHEETS (review of #604, 2026-11-16): once teams exist
 * the squad post the composition renders IS the team sheet, so "Ian Innes is
 * in" beside "@Match Time show the teams" (teams out) or "generate the teams"
 * (match day) sent the sheet twice. A batch that already posts a sheet has no
 * squad post carrier. Every case below counts what the group receives: squad
 * posts AND team sheets.
 *
 * ROUND 2 (2026-11-16): "posts a sheet" is what a reply RENDERS, never its
 * intent. The team intents also carry "No teams generated yet", "I'll build
 * the teams on match day" and "Can't build teams right now", which hold no
 * sheet: those must neither stop the squad post nor strip the batch's only
 * sheet. And "show the teams" beside a swap sends only the swap's sheet.
 *
 * ROUND 3: a swap DEFERRED because no teams exist says only the deferral (no
 * sheet); a replacement's sheet counts only when its slot move landed; and of
 * two team writes in one batch only the last write's sheet goes out.
 *
 * ROUND 5 (scaled back): several team WRITES in one batch send their sheets
 * as main does, each true when sent (two writes, two sheets). Only a shown
 * sheet that copies a written one is dropped. A batch whose writes leave no
 * teams (a clear) keeps its squad post. A replacement whose slot move did
 * not land says who is out and who is in, never the sheet the database
 * refused. And a team sheet the squad post becomes names who is in the
 * squad with no team yet.
 *
 * The router, the extractors and the answers are STUBBED by message body
 * (`engineOn`); the engine, the batch, the composer and the analyze route are
 * the real code against a real Postgres. No model call, $0. The seed's
 * upcoming match is 4 of 5 with Ben Bench on the bench; Ian Innes is a member
 * with no row yet. Made-up people.
 *
 * The batch that has a squad post is one whose change moves someone else's
 * row ("Ian Innes is in", from Alex Admin): a plain self IN posts no squad
 * (the roster post is demand driven, engine.ts 2026-09-09).
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { MATCH, SPORT_ID, U, londonAt } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { engineOn, clearPipelineStubs, facts, helpFacts, otherClaim, otherFacts, selfIn } from "../helpers/stub";

test.describe.configure({ mode: "default" });

const FLAG = "x-mt-test-unified-answers";
const IN = "IN";
const BENCH_Q = "@Match Time who's on the bench?";
const BENCH_ANSWER = "Ben Bench is on the bench.";
const ADD_IAN = "Ian Innes is in";
const ALEX = { authorPhone: "447700900001", authorName: "Alex Admin" };
const IAN = { authorPhone: "447700900009", authorName: "Ian Innes" };
const PAT = { authorPhone: "447700900003", authorName: "Pat Player" };
const OPEN_Q = "@Match Time is it cold tonight?";
const OPEN_ANSWER = "I can't see the weather from here.";
const HELP_Q = "@Match Time help";
const BENCH_POST = "*Bench (1):*\n1. Ben Bench";
const SHOW = "@Match Time show the teams";
const GEN = "@Match Time generate the teams";
const COUNT_Q = "@Match Time how many are we?";
const WHO_Q = "@Match Time who's playing?";
const LIST_Q = "@Match Time send the list";
const SWAP = "@Match Time swap Pat with Ian";
const SWAP_PT = "@Match Time swap Pat with Tom";
const SWAP_IZ = "@Match Time swap Ian with Zara";
const SIDES = "@Match Time swap the colours";
const IAN_AND_SWAP = "@Match Time Ian Innes is in, and swap Pat with Tom";
const REPLACE = "Ian Innes is replacing Pat";
const SWAP_READ = (moves: string[]) => ({ action: "swap", includeRefs: [], teamNames: [], swaps: [], moves, pairings: [], swapSides: false });
const SWAP_AT = "@Match Time swap Alex with Tom";
const GEN_ZORK = "@Match Time generate the teams and include Zork";
const REPLACE_AND_SWAP = "Ian Innes is replacing Pat, and swap Alex with Tom";
const CLEAR = "@Match Time clear the teams";
const UNSLOTTED_IAN = "In the squad, not on a team yet: *Ian Innes*.";

type Result = { waMessageId: string; reply?: string | null; react?: string | null; intent?: string | null };

let n = 0;
const msgId = () => `e2e-unified-batch-${Date.now()}-${++n}`;

async function batch(
  request: APIRequestContext,
  unified: boolean,
  first: { body: string; authorPhone: string; authorName: string; botMentioned?: boolean } = { body: IN, ...IAN },
  question = BENCH_Q,
) {
  const inId = msgId();
  const askId = msgId();
  const res = await request.post("/api/whatsapp/analyze", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY, [FLAG]: unified ? "1" : "0" },
    data: {
      groupId: E2E.GROUP_ID,
      messages: [
        { waMessageId: inId, ...first, botMentioned: first.botMentioned ?? false, timestamp: new Date().toISOString() },
        { waMessageId: askId, body: question, ...PAT, botMentioned: true, timestamp: new Date().toISOString() },
      ],
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  const results = (await res.json()).results as Result[];
  const spoke = results.filter((r) => (r.reply ?? "").length > 0);
  return { results, spoke, inR: results.find((r) => r.waMessageId === inId)!, askR: results.find((r) => r.waMessageId === askId)! };
}

const arm = () =>
  engineOn({
    [IN]: { route: "self_att", facts: selfIn() },
    [ADD_IAN]: { route: "other_att", facts: otherFacts("Ian Innes", "in") },
    // Both extractor shapes: the old one reads `topic`, the unified one `kind`.
    [BENCH_Q]: {
      route: "question",
      facts: { topic: "bench", kind: "other", personRef: "", statedCount: -1, table: "none", listSize: -1, listEnd: "top", period: "none", periodCount: -1, periodUnit: "none", feature: "none", badge: "none", answer: BENCH_ANSWER },
    },
    [OPEN_Q]: {
      route: "question",
      facts: { topic: "other", kind: "other", personRef: "", statedCount: -1, table: "none", listSize: -1, listEnd: "top", period: "none", periodCount: -1, periodUnit: "none", feature: "none", badge: "none", answer: OPEN_ANSWER },
    },
    [HELP_Q]: { route: "question", facts: helpFacts() },
    [COUNT_Q]: {
      route: "question",
      facts: { topic: "count", kind: "other", personRef: "", statedCount: -1, table: "none", listSize: -1, listEnd: "top", period: "none", periodCount: -1, periodUnit: "none", feature: "none", badge: "none", answer: "4 of 5." },
    },
    [WHO_Q]: {
      route: "question",
      facts: { topic: "squad", kind: "list", personRef: "", statedCount: -1, table: "none", listSize: -1, listEnd: "top", period: "none", periodCount: -1, periodUnit: "none", feature: "none", badge: "none" },
    },
    [LIST_Q]: {
      route: "question",
      facts: { topic: "squad", kind: "list", personRef: "", statedCount: -1, table: "none", listSize: -1, listEnd: "top", period: "none", periodCount: -1, periodUnit: "none", feature: "none", badge: "none" },
    },
    [SWAP]: { route: "balancer", facts: SWAP_READ(["Pat", "Ian"]) },
    [SWAP_PT]: { route: "balancer", facts: SWAP_READ(["Pat", "Tom"]) },
    [SWAP_IZ]: { route: "balancer", facts: SWAP_READ(["Ian", "Zara"]) },
    [SIDES]: { route: "balancer", facts: { ...SWAP_READ([]), swapSides: true } },
    [SWAP_AT]: { route: "balancer", facts: SWAP_READ(["Alex", "Tom"]) },
    [CLEAR]: { route: "balancer", facts: { action: "clear", includeRefs: [], teamNames: null, swaps: [], pairings: [] } },
    [GEN_ZORK]: { route: "balancer", facts: { action: "generate", includeRefs: ["Zork"], teamNames: null, swaps: [], pairings: [] } },
    // One message: a replacement (attendance) and a swap (its team half).
    [REPLACE_AND_SWAP]: { route: "other_att", facts: { ...facts([otherClaim("Ian Innes", "in", { replaces: "Pat Player" }), otherClaim("Pat Player", "out")]), sideRequests: ["teams"], ...SWAP_READ(["Alex", "Tom"]) } },
    [`@Match Time ${REPLACE_AND_SWAP}`]: {
      route: "other_att",
      facts: {
        ...facts([otherClaim("Ian Innes", "in", { replaces: "Pat Player" }), otherClaim("Pat Player", "out")]),
        sideRequests: ["teams"],
        ...SWAP_READ(["Alex", "Tom"]),
      },
    },
    // One message, two halves: Ian in (attendance) and a swap (the teams).
    [IAN_AND_SWAP]: { route: "other_att", facts: { ...otherFacts("Ian Innes", "in"), sideRequests: ["teams"], ...SWAP_READ(["Pat", "Tom"]) } },
    // A replacement: Ian takes Pat's place, and his slot.
    [REPLACE]: { route: "other_att", facts: facts([otherClaim("Ian Innes", "in", { replaces: "Pat Player" }), otherClaim("Pat Player", "out")]) },
    [SHOW]: { route: "balancer", facts: { action: "show", includeRefs: [], teamNames: null, swaps: [], pairings: [] } },
    [GEN]: { route: "balancer", facts: { action: "generate", includeRefs: [], teamNames: null, swaps: [], pairings: [] } },
  });

/** What the group receives: every squad post and every team sheet, counted
 *  across all the replies (one reply could carry both). */
const count = (spoke: Result[], marker: string) => spoke.reduce((n, r) => n + ((r.reply ?? "").split(marker).length - 1), 0);
/** A team sheet, whatever its heading ("*Teams for ...*", or a swap's
 *  "Updated teams:"): the first team's heading on a line of its own,
 *  "*Red*:" or a swap sheet's "*Red*". */
const SHEET_HEADING = /^\*Red\*:?\s*$/gm;
const sheetsIn = (spoke: Result[]) => spoke.reduce((n, r) => n + ((r.reply ?? "").match(SHEET_HEADING) ?? []).length, 0);
const received = (spoke: Result[]) => ({ squadPosts: count(spoke, "*Playing:*"), teamSheets: sheetsIn(spoke), sends: spoke.length });

/** The match's teams are made and published (two a side, Ian not in them). */
async function teamsOut(db: { run: (q: string, p: unknown[]) => Promise<unknown> }) {
  for (const [userId, team] of [[U.admin, "RED"], [U.player, "RED"], [U.collector, "YELLOW"], [U.third, "YELLOW"]] as const) {
    await db.run(`INSERT INTO "TeamAssignment" (id, "matchId", "userId", team) VALUES ($1, $2, $3, $4::"Team")`, [`e2e-uab-${userId}`, MATCH.upcoming, userId, team]);
  }
  await db.run(`UPDATE "Match" SET status = 'TEAMS_PUBLISHED' WHERE id = $1`, [MATCH.upcoming]);
}

/** The match is tonight, so the teams can be made now: two a side, or more
 *  a side than the squad holds (the balancer refuses: not enough players). */
async function matchDay(db: { run: (q: string, p: unknown[]) => Promise<unknown> }, playersPerTeam = 2) {
  const k = londonAt(0, 22, 0);
  await db.run(`UPDATE "Match" SET date = $2, "attendanceDeadline" = $3 WHERE id = $1`, [MATCH.upcoming, k.toISOString(), new Date(k.getTime() - 5 * 3600e3).toISOString()]);
  await db.run(`UPDATE "Sport" SET "playersPerTeam" = $2 WHERE id = $1`, [SPORT_ID, playersPerTeam]);
}

/** Pat pulled out after the teams were made; Ian is in with no slot. */
async function patOutIanIn(db: { run: (q: string, p: unknown[]) => Promise<unknown> }) {
  await db.run(`UPDATE "Attendance" SET status = 'DROPPED' WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, U.player]);
  await db.run(
    `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "respondedAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'CONFIRMED', 6, now(), now(), now())
     ON CONFLICT ("matchId", "userId") DO UPDATE SET status = 'CONFIRMED'`,
    [`e2e-att-uab-${U.fresh}`, MATCH.upcoming, U.fresh],
  );
}

/** Ian and Zara are in the squad with no team slot (the teams are made). */
async function inWithNoSlot(db: { run: (q: string, p: unknown[]) => Promise<unknown> }, userIds: string[]) {
  let pos = 10;
  for (const userId of userIds) {
    await db.run(
      `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "respondedAt", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 'CONFIRMED', $4, now(), now(), now())
       ON CONFLICT ("matchId", "userId") DO UPDATE SET status = 'CONFIRMED'`,
      [`e2e-att-uab-noslot-${userId}`, MATCH.upcoming, userId, ++pos],
    );
  }
}

/** Any number of messages, in this order; `tagged` per message. */
async function many(request: APIRequestContext, unified: boolean, msgs: Array<{ body: string; from: typeof ALEX; tagged?: boolean }>) {
  const ids = msgs.map(() => msgId());
  const res = await request.post("/api/whatsapp/analyze", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY, [FLAG]: unified ? "1" : "0" },
    data: {
      groupId: E2E.GROUP_ID,
      messages: msgs.map((m, i) => ({ waMessageId: ids[i], body: m.body, ...m.from, botMentioned: m.tagged ?? true, timestamp: new Date().toISOString() })),
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  const results = (await res.json()).results as Result[];
  return { results, spoke: results.filter((r) => (r.reply ?? "").length > 0), of: (i: number) => results.find((r) => r.waMessageId === ids[i])! };
}

const DEFERRED = /Teams aren't generated yet/;

/** Two tagged messages from two people, in this order. */
async function pair(request: APIRequestContext, unified: boolean, a: { body: string; from: typeof ALEX }, b: { body: string; from: typeof ALEX }) {
  const aId = msgId();
  const bId = msgId();
  const res = await request.post("/api/whatsapp/analyze", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY, [FLAG]: unified ? "1" : "0" },
    data: {
      groupId: E2E.GROUP_ID,
      messages: [
        { waMessageId: aId, body: a.body, ...a.from, botMentioned: true, timestamp: new Date().toISOString() },
        { waMessageId: bId, body: b.body, ...b.from, botMentioned: true, timestamp: new Date().toISOString() },
      ],
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  const results = (await res.json()).results as Result[];
  return { results, spoke: results.filter((r) => (r.reply ?? "").length > 0), aR: results.find((r) => r.waMessageId === aId)!, bR: results.find((r) => r.waMessageId === bId)! };
}

const NOT_MATCH_DAY = "I'll build the teams on match day, just ask me then.";

/** How many team slots the match holds now. */
async function sheetRowCount(db: { all: <T>(q: string, p: unknown[]) => Promise<T[]> }) {
  const rows = await db.all<{ c: number }>(`SELECT count(*)::int AS c FROM "TeamAssignment" WHERE "matchId" = $1`, [MATCH.upcoming]);
  return rows[0]?.c ?? 0;
}

async function statusOf(db: { all: <T>(q: string, p: unknown[]) => Promise<T[]> }, userId: string) {
  const rows = await db.all<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, userId]);
  return rows[0]?.status ?? null;
}

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test.beforeEach(() => resetDb());

test("flag OFF: the bench question waits, and the batch's ONE squad post (naming the bench) answers it", async ({ request, db }) => {
  arm();
  const { spoke, askR, inR } = await batch(request, false, { body: ADD_IAN, ...ALEX });
  expect(await statusOf(db, U.fresh)).toBe("CONFIRMED");
  expect(spoke).toHaveLength(1);
  expect(askR.reply ?? null).toBeNull();
  expect(inR.reply).toContain(BENCH_POST);
});

test("flag ON: ONE squad post (on the IN, naming the bench) and the unified answer, never two posts", async ({ request, db }) => {
  arm();
  const { spoke, askR, inR } = await batch(request, true, { body: ADD_IAN, ...ALEX });
  expect(await statusOf(db, U.fresh)).toBe("CONFIRMED");
  expect(received(spoke)).toEqual({ squadPosts: 1, teamSheets: 0, sends: 2 });
  expect(inR.reply).toContain(BENCH_POST);
  expect(inR.reply).toContain("5/5");
  expect(askR.intent).toBe("unified_answer");
  expect(askR.reply).toBe(BENCH_ANSWER);
  // One reply per message, and the unified answer is not repeated.
  expect(spoke).toHaveLength(2);
  expect(spoke.filter((r) => (r.reply ?? "").includes(BENCH_ANSWER))).toHaveLength(1);
});

test("flag ON, a plain IN beside the question (no squad post in this batch either way): ONE send", async ({ request }) => {
  arm();
  const { spoke, askR, inR } = await batch(request, true);
  expect(inR.react).toBe("✅");
  expect(spoke).toHaveLength(1);
  expect(askR.reply).toBe(BENCH_ANSWER);
});

test("flag OFF, the open answer beside the squad change: ONE squad post on the IN, and the open answer", async ({ request }) => {
  arm();
  const { spoke, askR, inR } = await batch(request, false, { body: ADD_IAN, ...ALEX }, OPEN_Q);
  expect(received(spoke)).toEqual({ squadPosts: 1, teamSheets: 0, sends: 2 });
  expect(inR.reply).toContain(BENCH_POST);
  expect(askR.intent).toBe("open_answer");
  expect(askR.reply).toBe(OPEN_ANSWER);
});

test("help beside the squad change: ONE squad post on the IN, and the help untouched", async ({ request }) => {
  arm();
  const { spoke, askR, inR } = await batch(request, false, { body: ADD_IAN, ...ALEX }, HELP_Q);
  expect(received(spoke)).toEqual({ squadPosts: 1, teamSheets: 0, sends: 2 });
  expect(inR.reply).toContain(BENCH_POST);
  expect(askR.intent).toBe("help");
  expect(askR.reply ?? "").not.toContain("*Playing:*");
  expect(askR.reply ?? "").not.toContain("[SQUAD]");
});

for (const unified of [true, false]) {
  test(`teams out: "Ian Innes is in" + "show the teams" sends ONE team sheet, no squad post (flag ${unified ? "ON" : "OFF"})`, async ({ request, db }) => {
    await teamsOut(db);
    arm();
    const { spoke, askR, inR } = await batch(request, unified, { body: ADD_IAN, ...ALEX }, SHOW);
    expect(await statusOf(db, U.fresh)).toBe("CONFIRMED");
    expect(received(spoke), JSON.stringify(spoke)).toEqual({ squadPosts: 0, teamSheets: 1, sends: 1 });
    expect(askR.intent).toBe("show_teams_request");
    expect(inR.reply ?? null).toBeNull();
  });

  test(`match day: "Ian Innes is in" + "generate the teams" sends ONE team sheet, no squad post (flag ${unified ? "ON" : "OFF"})`, async ({ request, db }) => {
    await matchDay(db);
    arm();
    const { spoke, askR, inR } = await batch(request, unified, { body: ADD_IAN, ...ALEX }, GEN);
    expect(received(spoke), JSON.stringify(spoke)).toEqual({ squadPosts: 0, teamSheets: 1, sends: 1 });
    expect(askR.intent).toBe("generate_teams_request");
    expect(inR.reply ?? null).toBeNull();
  });
}


test("teams out, flag OFF: 'show the teams' + 'how many are we?' (a squad answer the composition renders as the sheet) sends ONE team sheet", async ({ request, db }) => {
  await teamsOut(db);
  arm();
  const { spoke, inR: showR, askR } = await batch(request, false, { body: SHOW, ...ALEX, botMentioned: true }, COUNT_Q);
  expect(showR.intent).toBe("show_teams_request");
  expect(received(spoke), JSON.stringify(spoke)).toEqual({ squadPosts: 0, teamSheets: 1, sends: 1 });
  expect(showR.reply).toContain("*Teams for");
  // The question is answered by the sheet beside it, never "I didn't catch that".
  expect(askR.intent).not.toBe("not_understood");
});

// ── ROUND 2 (2026-11-16): a team intent that renders NO sheet ──────────

test("REGRESSION, flag ON: teams out, 'send the list' + a refused 'make teams' (not match day): the list's sheet still goes out", async ({ request, db }) => {
  await teamsOut(db);
  arm();
  const { spoke, aR, bR } = await pair(request, true, { body: LIST_Q, from: PAT }, { body: GEN, from: ALEX });
  expect(received(spoke), JSON.stringify(spoke)).toEqual({ squadPosts: 0, teamSheets: 1, sends: 2 });
  expect(sheetsIn([aR])).toBe(1);
  expect(bR.reply).toBe(NOT_MATCH_DAY);
  expect(aR.intent).not.toBe("not_understood");
});

for (const [what, body] of [["how many are we?", COUNT_Q], ["who's playing?", WHO_Q]] as const) {
  test(`REGRESSION, flag OFF: teams out, '${what}' + a refused 'make teams': the answer's sheet still goes out`, async ({ request, db }) => {
    await teamsOut(db);
    arm();
    const { spoke, aR, bR } = await pair(request, false, { body, from: PAT }, { body: GEN, from: ALEX });
    expect(received(spoke), JSON.stringify(spoke)).toEqual({ squadPosts: 0, teamSheets: 1, sends: 2 });
    expect(sheetsIn([aR])).toBe(1);
    expect(bR.reply).toBe(NOT_MATCH_DAY);
    expect(aR.intent).not.toBe("not_understood");
  });
}

for (const unified of [true, false]) {
  const flag = unified ? "ON" : "OFF";

  test(`no teams made: 'Ian Innes is in' + 'show the teams' ("No teams generated yet"): ONE squad post, no sheet (flag ${flag})`, async ({ request }) => {
    arm();
    const { spoke, askR, inR } = await batch(request, unified, { body: ADD_IAN, ...ALEX }, SHOW);
    expect(received(spoke), JSON.stringify(spoke)).toEqual({ squadPosts: 1, teamSheets: 0, sends: 2 });
    expect(inR.reply).toContain(BENCH_POST);
    expect(askR.reply).toMatch(/^No teams generated yet\./);
  });

  test(`before match day: 'Ian Innes is in' + 'make the teams' ("I'll build the teams on match day"): ONE squad post, no sheet (flag ${flag})`, async ({ request }) => {
    arm();
    const { spoke, askR, inR } = await batch(request, unified, { body: ADD_IAN, ...ALEX }, GEN);
    expect(received(spoke), JSON.stringify(spoke)).toEqual({ squadPosts: 1, teamSheets: 0, sends: 2 });
    expect(inR.reply).toContain(BENCH_POST);
    expect(askR.reply).toBe(NOT_MATCH_DAY);
  });

  test(`match day, too few players: 'Ian Innes is in' + 'make the teams' ("Can't build teams right now"): ONE squad post, no sheet (flag ${flag})`, async ({ request, db }) => {
    await matchDay(db, 6);
    arm();
    const { spoke, askR, inR } = await batch(request, unified, { body: ADD_IAN, ...ALEX }, GEN);
    expect(received(spoke), JSON.stringify(spoke)).toEqual({ squadPosts: 1, teamSheets: 0, sends: 2 });
    expect(inR.reply).toContain("*Playing:*");
    expect(askR.reply).toMatch(/^Can't build teams right now: not enough confirmed players/);
  });

  test(`a swap + 'show the teams': ONE sheet, the one after the swap (flag ${flag})`, async ({ request, db }) => {
    await teamsOut(db);
    await patOutIanIn(db);
    arm();
    const { spoke, aR, bR } = await pair(request, unified, { body: SWAP, from: ALEX }, { body: SHOW, from: PAT });
    expect(aR.intent, JSON.stringify(spoke)).toBe("team_swap");
    expect(received(spoke), JSON.stringify(spoke)).toEqual({ squadPosts: 0, teamSheets: 1, sends: 1 });
    // The sheet that goes out is the swap's: Ian holds Pat's place.
    expect(aR.reply).toContain("Ian Innes");
    expect(aR.reply).not.toMatch(/^\d+\. Pat Player$/m);
    // The show is answered by it: no reply of its own, never "I didn't catch that".
    expect(bR.reply ?? null).toBeNull();
    expect(bR.intent).not.toBe("not_understood");
  });
}

// ── ROUND 3 (2026-11-16): the deferred swap, the replacement, two writes ──

for (const unified of [true, false]) {
  const flag = unified ? "ON" : "OFF";

  test(`teams out: a DEFERRED swap (neither holds a slot) + 'show the teams': the shown sheet AND the deferral (flag ${flag})`, async ({ request, db }) => {
    await teamsOut(db);
    await inWithNoSlot(db, [U.fresh, U.extra]);
    arm();
    const { spoke, of } = await many(request, unified, [{ body: SWAP_IZ, from: ALEX }, { body: SHOW, from: PAT }]);
    expect(received(spoke), JSON.stringify(spoke)).toEqual({ squadPosts: 0, teamSheets: 1, sends: 2 });
    expect(of(0).reply).toMatch(DEFERRED);
    expect(sheetsIn([of(1)])).toBe(1);
  });

  test(`no teams: 'Ian Innes is in, and swap Pat with Tom' (deferred): ONE send, the squad post and the deferral (flag ${flag})`, async ({ request }) => {
    arm();
    const { spoke, of } = await many(request, unified, [{ body: IAN_AND_SWAP, from: ALEX }]);
    expect(received(spoke), JSON.stringify(spoke)).toEqual({ squadPosts: 1, teamSheets: 0, sends: 1 });
    expect(of(0).reply).toContain(BENCH_POST);
    expect(of(0).reply).toMatch(DEFERRED);
  });

  test(`teams out: 'Ian Innes is in, and swap Pat with Tom': ONE send, the swap's sheet, no squad post (flag ${flag})`, async ({ request, db }) => {
    await teamsOut(db);
    arm();
    const { spoke, of } = await many(request, unified, [{ body: IAN_AND_SWAP, from: ALEX }]);
    expect(received(spoke), JSON.stringify(spoke)).toEqual({ squadPosts: 0, teamSheets: 1, sends: 1 });
    expect(of(0).reply).not.toMatch(DEFERRED);
  });

  test(`no teams: 'Ian Innes is in' + a separate deferred swap: ONE send, the deferral with the squad post after it (flag ${flag})`, async ({ request }) => {
    arm();
    const { spoke, of } = await many(request, unified, [{ body: ADD_IAN, from: ALEX, tagged: false }, { body: SWAP_PT, from: ALEX }]);
    // The deferral is the last reply that speaks and is no sheet, so it
    // carries the squad post (the batch's one send), as any reply does.
    expect(received(spoke), JSON.stringify(spoke)).toEqual({ squadPosts: 1, teamSheets: 0, sends: 1 });
    expect(of(1).reply).toMatch(DEFERRED);
    expect(of(1).reply).toContain(BENCH_POST);
  });

  test(`teams out: a replacement + 'show the teams': ONE sheet, the replacement's (flag ${flag})`, async ({ request, db }) => {
    await teamsOut(db);
    arm();
    const { spoke, of } = await many(request, unified, [{ body: REPLACE, from: ALEX, tagged: false }, { body: SHOW, from: PAT }]);
    expect(received(spoke), JSON.stringify(spoke)).toEqual({ squadPosts: 0, teamSheets: 1, sends: 1 });
    expect(of(0).reply).toMatch(/takes (his|her|their) place/);
    expect(of(1).reply ?? null).toBeNull();
    expect(of(1).intent).not.toBe("not_understood");
  });

}

test(`no teams, flag OFF: 'Ian Innes is in' + a deferred swap + "who's on the bench?": the squad post answers the bench question`, async ({ request }) => {
  arm();
  const { spoke, of } = await many(request, false, [{ body: ADD_IAN, from: ALEX, tagged: false }, { body: SWAP_PT, from: ALEX }, { body: BENCH_Q, from: PAT }]);
  expect(received(spoke), JSON.stringify(spoke)).toEqual({ squadPosts: 1, teamSheets: 0, sends: 1 });
  expect(of(1).reply).toContain(BENCH_POST);
  expect(of(2).reply ?? null).toBeNull();
  expect(of(2).intent).not.toBe("not_understood");
});

for (const [what, body] of [["who's playing?", WHO_Q], ["how many are we?", COUNT_Q]] as const) {
  test(`teams out, flag OFF: a replacement + '${what}': ONE sheet, the replacement's`, async ({ request, db }) => {
    await teamsOut(db);
    arm();
    const { spoke, of } = await many(request, false, [{ body: REPLACE, from: ALEX, tagged: false }, { body, from: PAT }]);
    expect(received(spoke), JSON.stringify(spoke)).toEqual({ squadPosts: 0, teamSheets: 1, sends: 1 });
    expect(of(0).reply).toMatch(/takes (his|her|their) place/);
    expect(of(1).intent).not.toBe("not_understood");
  });
}

// ── ROUND 5 (2026-11-16): two team WRITES send their sheets, as main does ──
// Each send is asserted as main sends it: every write's own reply, whole.
// (Verified byte-identical to main by running these cases on main's sources
// the same day.)

const REPLACEMENT_POST = /^🔁 \*Pat is out\*\. \*Ian\* takes his place and his spot in \*Red\*\.\n\n⚽ \*Teams for [^\n]+\n\n\*Red\*:\n1\. Alex Admin\n2\. Ian Innes  \(replacing Pat\)\n\n\*Yellow\*:\n1\. Colin Collector\n2\. Tom Third\n\nObjections\? An admin can ask me to regenerate the teams\.$/;
const COLOURS_SWAPPED = /^🎨 Swapped the colours\. Same teams, sides flipped:\n\n\*Red\*\n/;
const ALEX_TOM_SWAPPED = /^🔁 Swapped \*Alex Admin\* and \*Tom Third\*, nobody dropped\. Updated teams:\n\n\*Red\*\n/;
const GENERATED = /^⚽ \*Teams for [^\n]+\n\n\*Red\*:\n/;

for (const unified of [true, false]) {
  const flag = unified ? "ON" : "OFF";

  test(`teams out: a replacement + swap the colours: TWO sends, each its own sheet, as main (flag ${flag})`, async ({ request, db }) => {
    await teamsOut(db);
    arm();
    const { spoke, of } = await many(request, unified, [{ body: REPLACE, from: ALEX, tagged: false }, { body: SIDES, from: ALEX }]);
    expect(received(spoke), JSON.stringify(spoke)).toEqual({ squadPosts: 0, teamSheets: 2, sends: 2 });
    expect(of(0).reply).toMatch(REPLACEMENT_POST);
    expect(of(1).reply).toMatch(COLOURS_SWAPPED);
  });

  test(`teams out: a replacement + swap Alex with Tom: TWO sends, each its own sheet, as main (flag ${flag})`, async ({ request, db }) => {
    await teamsOut(db);
    arm();
    const { spoke, of } = await many(request, unified, [{ body: REPLACE, from: ALEX, tagged: false }, { body: SWAP_AT, from: ALEX }]);
    expect(received(spoke), JSON.stringify(spoke)).toEqual({ squadPosts: 0, teamSheets: 2, sends: 2 });
    expect(of(0).reply).toMatch(REPLACEMENT_POST);
    expect(of(1).reply).toMatch(ALEX_TOM_SWAPPED);
  });

  test(`match day: regenerate + swap the colours: TWO sends, the teams made then the colours swapped, as main (flag ${flag})`, async ({ request, db }) => {
    await teamsOut(db);
    await matchDay(db);
    arm();
    const { spoke, of } = await many(request, unified, [{ body: GEN, from: ALEX }, { body: SIDES, from: ALEX }]);
    expect(received(spoke), JSON.stringify(spoke)).toEqual({ squadPosts: 0, teamSheets: 2, sends: 2 });
    expect(of(0).reply).toMatch(GENERATED);
    expect(of(1).reply).toMatch(COLOURS_SWAPPED);
  });

  test(`match day: generate (with a name it can't place) + swap the colours: TWO sends, the note kept, as main (flag ${flag})`, async ({ request, db }) => {
    await matchDay(db);
    arm();
    const { spoke, of } = await many(request, unified, [{ body: GEN_ZORK, from: ALEX }, { body: SIDES, from: ALEX }]);
    expect(received(spoke), JSON.stringify(spoke)).toEqual({ squadPosts: 0, teamSheets: 2, sends: 2 });
    expect(of(0).reply).toMatch(GENERATED);
    expect((of(0).reply ?? "").trimEnd().endsWith("_(couldn't find Zork in the roster, ignored)_")).toBe(true);
    expect(of(1).reply).toMatch(COLOURS_SWAPPED);
  });

  test(`teams out: ONE message "Ian Innes is replacing Pat, and swap Alex with Tom": ONE send carrying both sheets, as main (flag ${flag})`, async ({ request, db }) => {
    await teamsOut(db);
    arm();
    // Tagged: the team half of a message is a team change, which needs the tag.
    const { spoke, of } = await many(request, unified, [{ body: `@Match Time ${REPLACE_AND_SWAP}`, from: ALEX }]);
    expect(received(spoke), JSON.stringify(spoke)).toEqual({ squadPosts: 0, teamSheets: 2, sends: 1 });
    const text = of(0).reply ?? "";
    expect(text.startsWith("🔁 *Pat is out*. *Ian* takes his place and his spot in *Red*.")).toBe(true);
    expect(text).toContain("\n\n🔁 Swapped *Alex Admin* and *Tom Third*, nobody dropped. Updated teams:");
  });

  test(`teams out: 'Ian Innes is in' + swap Pat with Tom + clear the teams: the clear leaves no teams, so the squad post still goes out (flag ${flag})`, async ({ request, db }) => {
    await teamsOut(db);
    arm();
    const { spoke, of } = await many(request, unified, [
      { body: ADD_IAN, from: ALEX, tagged: false },
      { body: SWAP_PT, from: ALEX },
      { body: CLEAR, from: ALEX },
    ]);
    expect(await sheetRowCount(db)).toBe(0);
    expect(received(spoke).squadPosts, JSON.stringify(spoke)).toBe(1);
    expect(spoke.map((r) => r.reply ?? "").join("\n")).toContain(BENCH_POST);
    expect(of(1).reply ?? "").toMatch(/^🔁 Swapped \*Pat Player\* and \*Tom Third\*/);
  });

  test(`teams out: "Ian Innes is in" alone: the squad post is the team sheet AND names Ian, in the squad but on no team (flag ${flag})`, async ({ request, db }) => {
    await teamsOut(db);
    arm();
    const { spoke, of } = await many(request, unified, [{ body: ADD_IAN, from: ALEX, tagged: false }]);
    expect(received(spoke), JSON.stringify(spoke)).toEqual({ squadPosts: 0, teamSheets: 1, sends: 1 });
    expect((of(0).reply ?? "").trimEnd().endsWith(UNSLOTTED_IAN)).toBe(true);
  });
}

test(`teams out, flag OFF: "Ian Innes is in" + "how many are we?": ONE sheet, naming Ian as in the squad on no team`, async ({ request, db }) => {
  await teamsOut(db);
  arm();
  const { spoke } = await many(request, false, [{ body: ADD_IAN, from: ALEX, tagged: false }, { body: COUNT_Q, from: PAT }]);
  expect(received(spoke), JSON.stringify(spoke)).toEqual({ squadPosts: 0, teamSheets: 1, sends: 1 });
  expect(spoke[0].reply).toContain(UNSLOTTED_IAN);
});
