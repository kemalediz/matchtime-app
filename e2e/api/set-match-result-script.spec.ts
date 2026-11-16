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
 * ANTHROPIC_API_KEY_DEV empty (the script refuses before any call) or point
 * ANTHROPIC_BASE_URL at `fakeAnthropic`, a server in THIS process on
 * 127.0.0.1 that records the key each request carries and answers (or
 * rejects) it. No request leaves the machine, and the tests see which key
 * would have been billed.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect, resetDb } from "../fixtures";
import { ACTIVITY_ID, ORG_ID, U } from "../helpers/constants";
import { REPO_ROOT } from "../helpers/env";
import type { TestDb } from "../helpers/test-db";
import { costOf } from "@/lib/pipeline/llm";
import { WHO_IS_WHO_CALL } from "@/lib/pipeline/who-is-who";

/** What the fake API says each answered call used: priced from the real table. */
const FAKE_USAGE = { input_tokens: 20_000, output_tokens: 400 };
const FAKE_CALL_USD = costOf(WHO_IS_WHO_CALL.model, { inputTokens: FAKE_USAGE.input_tokens, outputTokens: FAKE_USAGE.output_tokens, cacheReadTokens: 0, cacheWriteTokens: 0 });

test.describe.configure({ mode: "serial" });

const MATCH_ID = "e2e-script-result-match";
/** A second organiser (ADMIN): --by must pick him, not the first owner. */
const SUE = { id: "e2e-script-sue", name: "Sue Second" };
/** A member who did NOT play, namesake of Riley Rater who did. */
const RILEY2 = { id: "e2e-script-riley2", name: "Riley Rowe" };

const PROD_KEY = "sk-ant-e2e-PRODUCTION-sentinel";
const DEV_KEY = "sk-ant-e2e-DEV-sentinel";
/** The stub seam off: the script's own path to the model. */
const SEAM_OFF = { MT_TEST_EXTRACTOR_STUB_FILE: "", MT_TEST_PERSON_PICKER_STUB: "", ANTHROPIC_API_KEY: "" };
/** ...with no dev key at all. */
const NO_KEY = { ...SEAM_OFF, ANTHROPIC_API_KEY_DEV: "" };
/** ...as `node --env-file=.env` would leave it if .env held BOTH keys, the API being `fakeAnthropic` at `url`. */
const bothKeys = (url: string) => ({ ...SEAM_OFF, ANTHROPIC_API_KEY: PROD_KEY, ANTHROPIC_API_KEY_DEV: DEV_KEY, ANTHROPIC_BASE_URL: url });

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
  /** Both streams, for messages that may go to either. */
  out: string;
}

/** A child process, ASYNC so `fakeAnthropic` (in this process) can answer it. */
function spawnRun(cmd: string, args: string[], env: Record<string, string>): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr, out: `${stdout}${stderr}` }));
  });
}

const run = (args: string[], env: Record<string, string> = {}) => spawnRun("npx", ["tsx", "scripts/set-match-result.ts", "--match", MATCH_ID, ...args], env);

/** The documented invocation the script prints for a re-run. */
const DOCUMENTED = "node --env-file=.env ./node_modules/.bin/tsx scripts/set-match-result.ts ";

/**
 * A stand-in for the Anthropic API on 127.0.0.1. Records the `x-api-key`
 * of every request. "answer": a who-is-who answer by first name (one
 * member is that member, several are ambiguous), with `FAKE_USAGE`, so the
 * call is priced. "reject": a 400, which the SDK does not retry. "hang":
 * takes the request and never answers.
 */
async function fakeAnthropic(mode: "answer" | "reject" | "hang") {
  const keys: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      keys.push(String(req.headers["x-api-key"] ?? ""));
      if (mode === "hang") return;
      res.setHeader("content-type", "application/json");
      if (mode === "reject") {
        res.statusCode = 400;
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "e2e fake API: rejected" } }));
        return;
      }
      const parsed = JSON.parse(body) as { model: string; messages: Array<{ content: string | Array<{ type: string; text?: string }> }> };
      const text = parsed.messages.flatMap((m) => (typeof m.content === "string" ? [m.content] : m.content.map((c) => c.text ?? ""))).join("\n");
      const first = (s: string) => s.trim().split(/\s+/)[0].toLowerCase();
      const members = [...text.matchAll(/^\s+(p\d+): ("(?:[^"\\]|\\.)*")/gm)].map((m) => ({ ref: m[1], name: JSON.parse(m[2]) as string }));
      const people = [...text.matchAll(/^\s+(n\d+)(?: \(WhatsApp name\))?: ("(?:[^"\\]|\\.)*")/gm)].map((n) => {
        const hits = members.filter((m) => first(m.name) === first(JSON.parse(n[2]) as string));
        return hits.length === 1
          ? { id: n[1], verdict: "member", member: hits[0].ref, candidates: [] }
          : hits.length > 1
            ? { id: n[1], verdict: "ambiguous", member: "", candidates: hits.map((h) => h.ref) }
            : { id: n[1], verdict: "none", member: "", candidates: [] };
      });
      res.end(
        JSON.stringify({
          id: "msg_e2e_fake",
          type: "message",
          role: "assistant",
          model: parsed.model,
          content: [{ type: "text", text: JSON.stringify({ people }) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { ...FAKE_USAGE, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    keys,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Refused before the database is read: the first line it prints names the club. */
function refusedBeforeDb(r: Ran, message: string): void {
  expect(r.code, r.out).toBe(1);
  expect(r.stderr).toContain(`REFUSED: ${message}`);
  expect(r.stdout, "the match was read").not.toContain("E2E Test FC");
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
  const r = await run(["--score", "Yellow 7 Red 4", "--mom", "Pat"]);
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain("score: Red 4, Yellow 7");
  expect(r.stdout).toContain("Man of the Match: Pat Player, recorded by Alex Admin");
  expect(r.stdout).toContain("DRY RUN");
  await nothingWritten(db);
});

test("an ambiguous or unknown name is refused, nothing written", async ({ db }) => {
  test.setTimeout(120_000);
  const amb = await run(["--score", "Yellow 7 Red 4", "--mom", "Omar", "--apply"]);
  expect(amb.code).toBe(1);
  expect(amb.stderr).toContain('REFUSED: "Omar" could be Omar One or Omar Two');
  // With a score too: refused means the score is not written either.
  const unknown = await run(["--score", "Yellow 7 Red 4", "--mom", "Zed", "--apply"]);
  expect(unknown.code, unknown.out).toBe(1);
  expect(unknown.stderr).toContain(`REFUSED: "Zed" is not one of the match's players. Nothing written.`);
  await nothingWritten(db);
});

test("arguments are read strictly, before the database: a flag with no value, an empty one, --flag=value, an unknown or repeated flag, a stray word, --by without --mom", async ({ db }) => {
  test.setTimeout(180_000);
  const score = ["--score", "Yellow 7 Red 4"];
  const cases: Array<[string[], string]> = [
    [[...score, "--mom", "", "--apply"], "--mom needs a value"],
    [[...score, "--mom", "   ", "--apply"], "--mom needs a value"],
    [[...score, "--apply", "--mom"], "--mom needs a value"],
    [[...score, "--mom", "--apply"], "--mom needs a value"],
    [[...score, "--mom=Pat", "--apply"], `"--mom=Pat": write the value after a space (--mom <value>)`],
    [[...score, "--mom", "Pat", "--by", "", "--apply"], "--by needs a value"],
    [[...score, "--mom", "Pat", "--mom", "Omar", "--apply"], "--mom is given twice"],
    [[...score, "--mom", "Pat", "--apply", "--apply"], "--apply is given twice"],
    [[...score, "--moom", "Pat", "--apply"], `unknown flag "--moom"`],
    [[...score, "Pat", "--apply"], `unexpected "Pat"`],
    [[...score, "--by", "Alex", "--apply"], "--by says who records the Man of the Match: it needs --mom"],
  ];
  for (const [args, message] of cases) refusedBeforeDb(await run(args), message);
  // The match id is a flag like any other: twice is refused too.
  refusedBeforeDb(await spawnRun("npx", ["tsx", "scripts/set-match-result.ts", "--match", MATCH_ID, "--match", "other", ...score], {}), "--match is given twice");
  await nothingWritten(db);
});

test("--by without --mom makes no who-is-who call", async ({ db }) => {
  test.setTimeout(120_000);
  const api = await fakeAnthropic("answer");
  try {
    refusedBeforeDb(await run(["--score", "Yellow 7 Red 4", "--by", "Alex", "--apply"], bothKeys(api.url)), "--by says who records the Man of the Match: it needs --mom");
    expect(api.keys, "requests made").toEqual([]);
  } finally {
    await api.close();
  }
  await nothingWritten(db);
});

test("a test stub variable outside the harness's own database is refused before anything is read", async ({ db }) => {
  test.setTimeout(120_000);
  // Never connected to: the refusal comes first. (Neither could be reached
  // if it were not: an .invalid host, and a closed loopback port that is
  // not the harness's.)
  for (const url of ["postgresql://ops:secret@db.example.invalid:5432/matchtime", "postgresql://postgres:postgres@127.0.0.1:9/matchtime"]) {
    const r = await run(["--score", "Yellow 7 Red 4", "--mom", "Pat", "--apply"], { DATABASE_URL: url, MT_TEST_EXTRACTOR_STUB_FILE: "/tmp/e2e-stub.json", MT_TEST_PERSON_PICKER_STUB: "" });
    // (The worker's env carries the suite's other MT_TEST_* files too: all are named.)
    refusedBeforeDb(r, "test stub variables are set (");
    expect(r.stderr).toMatch(/MT_TEST_EXTRACTOR_STUB_FILE[^)]*\) and DATABASE_URL is not the e2e harness's database/);
    expect(r.stderr).not.toMatch(/MT_TEST_PERSON_PICKER_STUB[,)]/);
    expect(r.out).not.toContain("secret");
  }
  await nothingWritten(db);
});

test("a name who-is-who is never asked about ('me': nobody to look up) is refused as unsure, nothing written", async ({ db }) => {
  test.setTimeout(120_000);
  const r = await run(["--score", "Yellow 7 Red 4", "--mom", "me", "--apply"]);
  expect(r.code, r.out).toBe(1);
  expect(r.stderr).toContain('REFUSED: MatchTime could not say who "me" is');
  await nothingWritten(db);
});

test("who-is-who is shown the WHOLE club: a namesake who did not play makes the name ambiguous, nothing written", async ({ db }) => {
  test.setTimeout(120_000);
  // Only Riley Rater played. Shown the players alone, "Riley" would be him.
  const r = await run(["--score", "Yellow 7 Red 4", "--mom", "Riley", "--apply"]);
  expect(r.code, r.out).toBe(1);
  expect(r.stderr).toMatch(/REFUSED: "Riley" could be (?:Riley Rater or Riley Rowe|Riley Rowe or Riley Rater)\./);
  await nothingWritten(db);
});

test("--by is looked up the same way: each organiser by his first name records it; a player named as --by is refused", async () => {
  test.setTimeout(120_000);
  const alex = await run(["--mom", "Pat", "--by", "Alex"]);
  expect(alex.code, alex.out).toBe(0);
  expect(alex.stdout).toContain("Man of the Match: Pat Player, recorded by Alex Admin");
  // Not the first owner (the default): the ADMIN --by names.
  const sue = await run(["--mom", "Pat", "--by", "Sue"]);
  expect(sue.code, sue.out).toBe(0);
  expect(sue.stdout).toContain("Man of the Match: Pat Player, recorded by Sue Second");
  const notOrganiser = await run(["--mom", "Pat", "--by", "Pat"]);
  expect(notOrganiser.code, notOrganiser.out).toBe(1);
  expect(notOrganiser.stderr).toContain('REFUSED: --by "Pat" is not one organiser of the club');
});

test("with no ANTHROPIC_API_KEY_DEV, --mom and --by are refused at once, naming the key; nothing written", async ({ db }) => {
  test.setTimeout(120_000);
  for (const args of [["--score", "Yellow 7 Red 4", "--mom", "Pat", "--apply"], ["--score", "Yellow 7 Red 4", "--mom", "Pat", "--by", "Alex", "--apply"]]) {
    const r = await run(args, NO_KEY);
    expect(r.code, r.out).toBe(1);
    expect(r.stderr, args.join(" ")).toContain("REFUSED: --mom and --by are looked up by who-is-who, a model call on ANTHROPIC_API_KEY_DEV, and it is not set");
    // Before anything else: not even the match is read.
    expect(r.stdout).not.toContain("E2E Test FC");
  }
  await nothingWritten(db);
});

test("the call goes on the DEV key, never the production one, even with both loaded; its calls and cost are printed", async ({ db }) => {
  test.setTimeout(120_000);
  const api = await fakeAnthropic("answer");
  try {
    const r = await run(["--score", "Yellow 7 Red 4", "--mom", "Pat", "--by", "Sue"], bothKeys(api.url));
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain("Man of the Match: Pat Player, recorded by Sue Second");
    expect(api.keys, "one who-is-who request, on the dev key").toEqual([DEV_KEY]);
    // The exact price of the fake's known usage, from the real price table.
    const usd = (FAKE_CALL_USD ?? 0).toFixed(4);
    expect(usd, "the fake's usage must cost something, or this proves nothing").not.toBe("0.0000");
    expect(r.stdout).toContain(`  who-is-who: 1 call, $${usd} on the dev key (ANTHROPIC_API_KEY_DEV)\n`);
    expect(r.out).not.toContain(PROD_KEY);
  } finally {
    await api.close();
  }
  await nothingWritten(db);
});

test("the production-key guard itself: with the key NOT dropped at start (test seam), the model client is refused, no request is made", async ({ db }) => {
  test.setTimeout(120_000);
  const api = await fakeAnthropic("answer");
  try {
    const r = await run(["--score", "Yellow 7 Red 4", "--mom", "Pat", "--apply"], { ...bothKeys(api.url), MT_TEST_KEEP_PRODUCTION_KEY: "1" });
    expect(r.code, r.out).toBe(1);
    expect(r.stderr).toContain("ANTHROPIC_API_KEY is still set in this process");
    expect(api.keys, "requests made").toEqual([]);
  } finally {
    await api.close();
  }
  await nothingWritten(db);
});

test("an API that takes the call and never answers: refused as timed out within the script's limit, nothing written", async ({ db }) => {
  test.setTimeout(120_000);
  const api = await fakeAnthropic("hang");
  try {
    const started = Date.now();
    const r = await run(["--score", "Yellow 7 Red 4", "--mom", "Pat", "--apply"], { ...bothKeys(api.url), MT_TEST_WHO_IS_WHO_TIMEOUT_MS: "1500" });
    expect(r.code, r.out).toBe(1);
    expect(r.stderr).toContain('REFUSED: who-is-who could not answer for "Pat" (the call failed (timed out after 1.5s))');
    expect(api.keys.length, "the call reached the API").toBeGreaterThan(0);
    // The whole run, tsx start-up included, well inside the SDK's own minutes.
    expect(Date.now() - started).toBeLessThan(60_000);
  } finally {
    await api.close();
  }
  await nothingWritten(db);
});

test("with neither --mom nor --by there is no who-is-who call, and no key is needed", async ({ db }) => {
  test.setTimeout(120_000);
  const noKey = await run(["--score", "Yellow 7 Red 4"], NO_KEY);
  expect(noKey.code, noKey.out).toBe(0);
  expect(noKey.stdout).toContain("score: Red 4, Yellow 7");
  // With a key and an API to reach, still no request, and nothing said about one on either stream.
  const api = await fakeAnthropic("answer");
  try {
    const r = await run(["--score", "Yellow 7 Red 4"], bothKeys(api.url));
    expect(r.code, r.out).toBe(0);
    expect(api.keys, "requests made").toEqual([]);
    expect(r.stdout).not.toMatch(/who-is-who/);
    expect(r.stderr).not.toMatch(/who-is-who/);
  } finally {
    await api.close();
  }
  await nothingWritten(db);
});

test("when who-is-who's call fails, --mom and --by are refused SAYING the call failed, and nothing is written", async ({ db }) => {
  test.setTimeout(180_000);
  const api = await fakeAnthropic("reject");
  try {
    const mom = await run(["--score", "Yellow 7 Red 4", "--mom", "Pat", "--apply"], bothKeys(api.url));
    expect(mom.code, mom.out).toBe(1);
    expect(mom.stderr).toContain('REFUSED: who-is-who could not answer for "Pat" (the call failed)');
    expect(mom.stdout).toContain("who-is-who: 0 calls, $0.0000 on the dev key");
    const by = await run(["--score", "Yellow 7 Red 4", "--mom", "Pat", "--by", "Alex", "--apply"], bothKeys(api.url));
    expect(by.code, by.out).toBe(1);
    expect(by.stderr).toContain('REFUSED: who-is-who could not answer for "Pat" and "Alex" (the call failed)');
    expect(by.out).not.toContain("not one organiser");
    expect(api.keys.length).toBeGreaterThan(0);
    expect(new Set(api.keys)).toEqual(new Set([DEV_KEY]));
  } finally {
    await api.close();
  }
  await nothingWritten(db);
});

test("if the Man of the Match write fails after the score, the script says what was written and prints a re-run that finishes it, idempotently", async ({ db }) => {
  test.setTimeout(180_000);
  // setMatchMom cannot share the score's transaction (it opens its own), so
  // the failure is made real: the database refuses this match's MoMVote.
  await db.run(`CREATE OR REPLACE FUNCTION e2e_script_mom_fails() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'e2e: MoMVote refused'; END $$ LANGUAGE plpgsql`);
  await db.run(
    `CREATE TRIGGER e2e_script_mom_fails BEFORE INSERT ON "MoMVote" FOR EACH ROW WHEN (NEW."matchId" = '${MATCH_ID}') EXECUTE FUNCTION e2e_script_mom_fails()`,
  );
  // A name with every character a shell cares about; who-is-who still reads it as Pat.
  const said = `Pat 'the cat' "P" $HOME`;
  let rerun = "";
  try {
    const r = await run(["--score", "Yellow 5 Red 3", "--mom", said, "--by", "Sue", "--apply"]);
    expect(r.code, r.out).toBe(1);
    expect(r.stderr).toContain("PARTLY WRITTEN: the score IS recorded (Red 3, Yellow 5; the match is COMPLETED), but the Man of the Match (Pat Player) was NOT written.");
    expect(await db.one(`SELECT "redScore", "yellowScore", status FROM "Match" WHERE id = $1`, [MATCH_ID])).toEqual({ redScore: 3, yellowScore: 5, status: "COMPLETED" });
    expect(await db.count(`SELECT COUNT(*) FROM "MoMVote" WHERE "matchId" = $1`, [MATCH_ID])).toBe(0);
    rerun = r.stderr.split("\n").map((l) => l.trim()).find((l) => l.startsWith(DOCUMENTED)) ?? "";
    expect(rerun, r.stderr).toBe(`${DOCUMENTED}--match '${MATCH_ID}' --mom 'Pat '\\''the cat'\\'' "P" $HOME' --by 'Sue' --apply`);
  } finally {
    await db.run(`DROP TRIGGER IF EXISTS e2e_script_mom_fails ON "MoMVote"`);
    await db.run(`DROP FUNCTION IF EXISTS e2e_script_mom_fails()`);
  }
  // The printed command, through a real shell (tsx run directly: the test
  // env already holds what --env-file would load). Twice: same end state.
  const viaShell = rerun.replace("node --env-file=.env ./node_modules/.bin/tsx ", "npx tsx ");
  for (const attempt of [1, 2]) {
    const again = await spawnRun("sh", ["-c", viaShell], {});
    expect(again.code, `attempt ${attempt}: ${again.out}`).toBe(0);
    expect(again.stdout).toContain("Man of the Match: Pat Player, recorded by Sue Second");
    expect(await db.one(`SELECT "redScore", "yellowScore", status FROM "Match" WHERE id = $1`, [MATCH_ID])).toEqual({ redScore: 3, yellowScore: 5, status: "COMPLETED" });
    expect(await db.all(`SELECT "voterId", "playerId" FROM "MoMVote" WHERE "matchId" = $1`, [MATCH_ID])).toEqual([{ voterId: SUE.id, playerId: U.player }]);
  }
  // Back to unplayed for the next test.
  await db.run(`DELETE FROM "MoMVote" WHERE "matchId" = $1`, [MATCH_ID]);
  await db.run(`UPDATE "Match" SET "redScore" = NULL, "yellowScore" = NULL, status = 'TEAMS_PUBLISHED' WHERE id = $1`, [MATCH_ID]);
});

test("--apply writes the score (COMPLETED) and one MoMVote by the organiser, the row every MoM reader counts", async ({ db }) => {
  test.setTimeout(120_000);
  const r = await run(["--score", "Yellow 7 Red 4", "--mom", "Pat", "--apply"]);
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
