/**
 * `scripts/set-match-result.ts` (2026-10-18), run against the test
 * database: dry run by default (writes nothing), --apply writes the score
 * and the Man of the Match through the shared writers, and an ambiguous or
 * unknown name is refused. For FNF's Fri 16 Oct match, recorded by hand
 * once the organisers confirm the result.
 *
 * Who a name is comes from who-is-who, as for a pick reported in HQ
 * (2026-11-16: since #574 the script passed it no answer, so every name
 * came back "unsure", which was not refused). Here who-is-who is the
 * stubbed suite's stand-in (`stubPersonPicker`, chosen by the extractor
 * stub seam the test env sets). One test turns the seam off with no API
 * key, so the call fails before any request: no model is ever called.
 */
import { execFileSync } from "node:child_process";
import { test, expect, resetDb } from "../fixtures";
import { ACTIVITY_ID, U } from "../helpers/constants";
import { REPO_ROOT } from "../helpers/env";

test.describe.configure({ mode: "serial" });

const MATCH_ID = "e2e-script-result-match";

function run(args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  try {
    const out = execFileSync("npx", ["tsx", "scripts/set-match-result.ts", "--match", MATCH_ID, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const failed = e as { status?: number; stdout?: string; stderr?: string };
    return { code: failed.status ?? -1, out: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
}

test.beforeAll(async ({ db }) => {
  resetDb();
  const kickoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "postMatchEndFlow", "updatedAt")
     VALUES ($1, $2, $3, 14, 'TEAMS_PUBLISHED', $3, false, now())`,
    [MATCH_ID, ACTIVITY_ID, kickoff],
  );
  let pos = 0;
  for (const u of [U.player, U.rater, U.omar1, U.omar2]) {
    await db.run(
      `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt") VALUES ($1, $2, $3, 'CONFIRMED', $4, now())`,
      [`e2e-script-att-${u}`, MATCH_ID, u, ++pos],
    );
  }
});

test.afterAll(async ({ db }) => {
  await db.run(`DELETE FROM "Match" WHERE id = $1`, [MATCH_ID]);
  resetDb();
});

test("dry run by default: prints the plan, writes nothing", async ({ db }) => {
  test.setTimeout(120_000);
  const r = run(["--score", "Yellow 7 Red 4", "--mom", "Pat"]);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain("score: Red 4, Yellow 7");
  expect(r.out).toContain("Man of the Match: Pat Player, recorded by Alex Admin");
  expect(r.out).toContain("DRY RUN");
  expect(await db.one(`SELECT "redScore", "yellowScore" FROM "Match" WHERE id = $1`, [MATCH_ID])).toEqual({ redScore: null, yellowScore: null });
  expect(await db.count(`SELECT COUNT(*) FROM "MoMVote" WHERE "matchId" = $1`, [MATCH_ID])).toBe(0);
});

test("an ambiguous or unknown name is refused, nothing written", async ({ db }) => {
  test.setTimeout(120_000);
  const amb = run(["--score", "Yellow 7 Red 4", "--mom", "Omar", "--apply"]);
  expect(amb.code).toBe(1);
  expect(amb.out).toContain('REFUSED: "Omar" could be Omar One or Omar Two');
  const unknown = run(["--mom", "Zed", "--apply"]);
  expect(unknown.code).toBe(1);
  expect(await db.one(`SELECT "redScore" FROM "Match" WHERE id = $1`, [MATCH_ID])).toEqual({ redScore: null });
  expect(await db.count(`SELECT COUNT(*) FROM "MoMVote" WHERE "matchId" = $1`, [MATCH_ID])).toBe(0);
});

test("--by is looked up the same way: an organiser by his first name records it; a player named as --by is refused", async () => {
  test.setTimeout(120_000);
  const ok = run(["--mom", "Pat", "--by", "Alex"]);
  expect(ok.code, ok.out).toBe(0);
  expect(ok.out).toContain("Man of the Match: Pat Player, recorded by Alex Admin");
  const notOrganiser = run(["--mom", "Pat", "--by", "Riley"]);
  expect(notOrganiser.code, notOrganiser.out).toBe(1);
  expect(notOrganiser.out).toContain('REFUSED: --by "Riley" is not one organiser of the club');
});

test("a name who-is-who could not answer for (its call failed) is refused with --apply, and nothing is written", async ({ db }) => {
  test.setTimeout(120_000);
  // The stub seam off and no key: the picker's call fails before any request.
  const r = run(["--score", "Yellow 7 Red 4", "--mom", "Pat", "--apply"], {
    MT_TEST_EXTRACTOR_STUB_FILE: "",
    MT_TEST_PERSON_PICKER_STUB: "",
    ANTHROPIC_API_KEY: "",
  });
  expect(r.code, r.out).toBe(1);
  expect(r.out).toContain('REFUSED: MatchTime could not say who "Pat" is');
  expect(await db.one(`SELECT "redScore", "yellowScore", status FROM "Match" WHERE id = $1`, [MATCH_ID])).toEqual({
    redScore: null,
    yellowScore: null,
    status: "TEAMS_PUBLISHED",
  });
  expect(await db.count(`SELECT COUNT(*) FROM "MoMVote" WHERE "matchId" = $1`, [MATCH_ID])).toBe(0);
});

test("--apply writes the score (COMPLETED) and one MoMVote by the organiser, the row every MoM reader counts", async ({ db }) => {
  test.setTimeout(120_000);
  const r = run(["--score", "Yellow 7 Red 4", "--mom", "Pat", "--apply"]);
  expect(r.code, r.out).toBe(0);
  expect(await db.one(`SELECT "redScore", "yellowScore", status FROM "Match" WHERE id = $1`, [MATCH_ID])).toEqual({
    redScore: 4,
    yellowScore: 7,
    status: "COMPLETED",
  });
  expect(await db.all(`SELECT "voterId", "playerId" FROM "MoMVote" WHERE "matchId" = $1`, [MATCH_ID])).toEqual([
    { voterId: U.admin, playerId: U.player },
  ]);
});
