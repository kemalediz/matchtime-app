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
 * stub seam the test env sets).
 *
 * NO MODEL IS EVER CALLED. The tests that turn the seam off either leave
 * ANTHROPIC_API_KEY_DEV empty (the script refuses before any call) or give
 * it a dummy value with ANTHROPIC_BASE_URL on a closed local port (`DEAD`),
 * so the call fails on this machine and no request leaves it.
 */
import { execFileSync } from "node:child_process";
import { test, expect, resetDb } from "../fixtures";
import { ACTIVITY_ID, ORG_ID, U } from "../helpers/constants";
import { REPO_ROOT } from "../helpers/env";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const MATCH_ID = "e2e-script-result-match";
/** A second organiser (ADMIN): --by must pick him, not the first owner. */
const SUE = { id: "e2e-script-sue", name: "Sue Second" };
/** A member who did NOT play, namesake of Riley Rater who did. */
const RILEY2 = { id: "e2e-script-riley2", name: "Riley Rowe" };

/** The stub seam off: the script's own path to the model. */
const SEAM_OFF = { MT_TEST_EXTRACTOR_STUB_FILE: "", MT_TEST_PERSON_PICKER_STUB: "", ANTHROPIC_API_KEY: "" };
/** ...with no key at all. */
const NO_KEY = { ...SEAM_OFF, ANTHROPIC_API_KEY_DEV: "" };
/** ...with a key that can only reach a closed port here: every call fails locally. */
const DEAD = { ...SEAM_OFF, ANTHROPIC_API_KEY_DEV: "sk-ant-e2e-not-a-key", ANTHROPIC_BASE_URL: "http://127.0.0.1:9" };

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

const nothingWritten = async (db: TestDb) => {
  expect(await db.one(`SELECT "redScore", "yellowScore", status FROM "Match" WHERE id = $1`, [MATCH_ID])).toEqual({
    redScore: null,
    yellowScore: null,
    status: "TEAMS_PUBLISHED",
  });
  expect(await db.count(`SELECT COUNT(*) FROM "MoMVote" WHERE "matchId" = $1`, [MATCH_ID])).toBe(0);
};

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
  for (const [p, role] of [[SUE, "ADMIN"], [RILEY2, "PLAYER"]] as const) {
    await db.run(`INSERT INTO "User" (id, email, name, "updatedAt") VALUES ($1, $2, $3, now())`, [p.id, `${p.id}@e2e.test`, p.name]);
    await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1, $2, $3, $4::"MemberRole")`, [`mem-${p.id}`, p.id, ORG_ID, role]);
  }
});

test.afterAll(async ({ db }) => {
  await db.run(`DROP TRIGGER IF EXISTS e2e_script_mom_fails ON "MoMVote"`);
  await db.run(`DROP FUNCTION IF EXISTS e2e_script_mom_fails()`);
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
  await nothingWritten(db);
});

test("an ambiguous or unknown name is refused, nothing written", async ({ db }) => {
  test.setTimeout(120_000);
  const amb = run(["--score", "Yellow 7 Red 4", "--mom", "Omar", "--apply"]);
  expect(amb.code).toBe(1);
  expect(amb.out).toContain('REFUSED: "Omar" could be Omar One or Omar Two');
  const unknown = run(["--mom", "Zed", "--apply"]);
  expect(unknown.code).toBe(1);
  await nothingWritten(db);
});

test("who-is-who is shown the WHOLE club: a namesake who did not play makes the name ambiguous, nothing written", async ({ db }) => {
  test.setTimeout(120_000);
  // Only Riley Rater played. Shown the players alone, "Riley" would be him.
  const r = run(["--score", "Yellow 7 Red 4", "--mom", "Riley", "--apply"]);
  expect(r.code, r.out).toBe(1);
  expect(r.out).toMatch(/REFUSED: "Riley" could be (?:Riley Rater or Riley Rowe|Riley Rowe or Riley Rater)\./);
  await nothingWritten(db);
});

test("--by is looked up the same way: each organiser by his first name records it; a player named as --by is refused", async () => {
  test.setTimeout(120_000);
  const alex = run(["--mom", "Pat", "--by", "Alex"]);
  expect(alex.code, alex.out).toBe(0);
  expect(alex.out).toContain("Man of the Match: Pat Player, recorded by Alex Admin");
  // Not the first owner (the default): the ADMIN --by names.
  const sue = run(["--mom", "Pat", "--by", "Sue"]);
  expect(sue.code, sue.out).toBe(0);
  expect(sue.out).toContain("Man of the Match: Pat Player, recorded by Sue Second");
  const notOrganiser = run(["--mom", "Pat", "--by", "Pat"]);
  expect(notOrganiser.code, notOrganiser.out).toBe(1);
  expect(notOrganiser.out).toContain('REFUSED: --by "Pat" is not one organiser of the club');
});

test("with no ANTHROPIC_API_KEY_DEV, --mom and --by are refused at once, naming the key; nothing written", async ({ db }) => {
  test.setTimeout(120_000);
  for (const args of [["--score", "Yellow 7 Red 4", "--mom", "Pat", "--apply"], ["--score", "Yellow 7 Red 4", "--by", "Alex", "--apply"]]) {
    const r = run(args, NO_KEY);
    expect(r.code, r.out).toBe(1);
    expect(r.out, args.join(" ")).toContain("REFUSED: --mom and --by are looked up by who-is-who, a model call on ANTHROPIC_API_KEY_DEV, and it is not set");
    // Before anything else: not even the match is read.
    expect(r.out).not.toContain("E2E Test FC");
  }
  await nothingWritten(db);
});

test("with neither --mom nor --by there is no who-is-who call, and no key is needed", async ({ db }) => {
  test.setTimeout(120_000);
  const noKey = run(["--score", "Yellow 7 Red 4"], NO_KEY);
  expect(noKey.code, noKey.out).toBe(0);
  expect(noKey.out).toContain("score: Red 4, Yellow 7");
  // A call would fail here (closed port) and say so: it is not made.
  const dead = run(["--score", "Yellow 7 Red 4"], DEAD);
  expect(dead.code, dead.out).toBe(0);
  expect(dead.out).not.toMatch(/who-is-who/);
  await nothingWritten(db);
});

test("when who-is-who's call fails, --mom and --by are refused SAYING the call failed, and nothing is written", async ({ db }) => {
  test.setTimeout(180_000);
  const mom = run(["--score", "Yellow 7 Red 4", "--mom", "Pat", "--apply"], DEAD);
  expect(mom.code, mom.out).toBe(1);
  expect(mom.out).toContain('REFUSED: who-is-who could not answer for "Pat" (the call failed)');
  const by = run(["--score", "Yellow 7 Red 4", "--by", "Alex", "--apply"], DEAD);
  expect(by.code, by.out).toBe(1);
  expect(by.out).toContain('REFUSED: who-is-who could not answer for "Alex" (the call failed)');
  expect(by.out).not.toContain("not one organiser");
  await nothingWritten(db);
});

test("if the Man of the Match write fails after the score was written, the script says exactly what was written", async ({ db }) => {
  test.setTimeout(120_000);
  // setMatchMom cannot share the score's transaction (it opens its own), so
  // the failure is made real: the database refuses this match's MoMVote.
  await db.run(`CREATE OR REPLACE FUNCTION e2e_script_mom_fails() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'e2e: MoMVote refused'; END $$ LANGUAGE plpgsql`);
  await db.run(
    `CREATE TRIGGER e2e_script_mom_fails BEFORE INSERT ON "MoMVote" FOR EACH ROW WHEN (NEW."matchId" = '${MATCH_ID}') EXECUTE FUNCTION e2e_script_mom_fails()`,
  );
  try {
    const r = run(["--score", "Yellow 5 Red 3", "--mom", "Pat", "--apply"]);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("PARTLY WRITTEN: the score IS recorded (Red 3, Yellow 5; the match is COMPLETED), but the Man of the Match (Pat Player) was NOT");
    expect(r.out).toContain('Re-run with --mom "Pat" --apply (and no --score) to record him.');
    expect(await db.one(`SELECT "redScore", "yellowScore", status FROM "Match" WHERE id = $1`, [MATCH_ID])).toEqual({
      redScore: 3,
      yellowScore: 5,
      status: "COMPLETED",
    });
    expect(await db.count(`SELECT COUNT(*) FROM "MoMVote" WHERE "matchId" = $1`, [MATCH_ID])).toBe(0);
  } finally {
    await db.run(`DROP TRIGGER IF EXISTS e2e_script_mom_fails ON "MoMVote"`);
    await db.run(`DROP FUNCTION IF EXISTS e2e_script_mom_fails()`);
    // Back to unplayed for the next test.
    await db.run(`UPDATE "Match" SET "redScore" = NULL, "yellowScore" = NULL, status = 'TEAMS_PUBLISHED' WHERE id = $1`, [MATCH_ID]);
  }
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
