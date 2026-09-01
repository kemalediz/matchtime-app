/**
 * e2e orchestrator — the ONLY supported way to run the suite.
 *
 *   npm run test:e2e            → full run (DB up → schema → seed → playwright → DB down)
 *   npm run test:e2e -- <args>  → args forwarded to `playwright test`
 *   npm run test:e2e:ui         → same but with --ui
 *
 * What it does, in order:
 *   0. Resolves THIS CHECKOUT's ports (helpers/ports.ts), prints them,
 *      takes the per-checkout run lock, and refuses to start if either
 *      port is held by anything this run did not start (helpers/
 *      preflight.ts). Two checkouts running the suite at once used to
 *      share both the database and the dev server and report plausible,
 *      wrong numbers without either run erroring — see PR #34.
 *   0b. Checks the MODEL seam against the mode (helpers/live-llm.ts).
 *      A live run proves it can reach Anthropic — and spends one token
 *      doing it — before any work starts; a stubbed run proves it
 *      cannot. A keyless `test:corpus:live` used to score 8/47 in four
 *      seconds and PASS, every case having fallen through to
 *      `offlineVerdict`. For live runs every model call is then metered
 *      on the way out, so the run can state what it really cost and
 *      fail if the answer is nothing.
 *   1. Starts an EMBEDDED Postgres (binaries from the `embedded-postgres`
 *      npm package) on this checkout's db port, data dir under .e2e/ —
 *      fully isolated, no Docker, no system Postgres, no prod anywhere.
 *   2. `prisma db push` against that DB (this repo uses db push, not
 *      migrations — see prisma.config.ts) + `prisma generate` if needed.
 *   3. Seeds the fixture world (e2e/helpers/seed.ts).
 *   4. Writes .env.e2e (gitignored) documenting the test DB URL + ports.
 *   5. Runs `playwright test` with the full test env (helpers/env.ts);
 *      Playwright's webServer boots `next dev` on this checkout's app
 *      port with that env, and never reuses a server it did not start.
 *   6. Stops the embedded Postgres (data dir persists for fast re-runs).
 */
import { config as loadEnv } from "dotenv";
loadEnv(); // load repo-root .env so process.env.ANTHROPIC_API_KEY is set before helpers/env reads it

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import {
  E2E,
  E2E_DB_URL,
  E2E_PORTS,
  REPO_ROOT,
  assertSafeTestDbUrl,
  buildTestEnv,
} from "./helpers/env";
import { describePorts } from "./helpers/ports";
import {
  E2EPreflightError,
  acquireRunLock,
  assertAppPortAvailable,
  inspectDbPort,
} from "./helpers/preflight";
import {
  LIVE_ENV_FLAG,
  assertLiveLlmReady,
  assertSeamMatchesMode,
  describeProbe,
  isLiveRun,
} from "./helpers/live-llm";
import { AnthropicMeter } from "./replay/meter";

/**
 * The LLM half of the pre-flight, and the mirror image of the port
 * half: refuse to produce a measurement the run cannot actually make.
 *
 * Checked against the env the SERVER UNDER TEST will really see —
 * `{ ...process.env, ...buildTestEnv() }` — because the bug this exists
 * for lived in the gap between the overlay we send and the environment
 * the child inherits.
 */
async function assertLlmSeamReady(): Promise<void> {
  const childEnv = { ...process.env, ...buildTestEnv() };
  if (!isLiveRun()) {
    assertSeamMatchesMode("stub", childEnv);
    console.log(
      `[e2e] LLM: STUBBED — verdicts come from ${E2E.LLM_STUB_FILE}; ` +
        `ANTHROPIC_API_KEY is pinned empty, so this run cannot call a model or spend anything.`,
    );
    return;
  }
  console.log("[e2e] LLM: LIVE requested — checking the seam before spending anything…");
  console.log(describeProbe(await assertLiveLlmReady({ childEnv })));
}

/** Thrown when a live run finishes without ever having called the model.
 *  Not a test failure — the tests may all have "passed"; that is the
 *  problem. */
class NotActuallyLiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotActuallyLiveError";
  }
}

/**
 * The self-describing half. A live run says, in its own output, exactly
 * how much model it used — and if the answer is "none", the run fails
 * no matter what Playwright reported. Zero calls plus a green Playwright
 * is the exact shape of the false green: a passing tick over a sweep
 * that never left the machine.
 */
function assertMeterSawTraffic(meter: AnthropicMeter, playwrightExitCode: number): void {
  const calls = meter.all;
  if (calls.length === 0) {
    const skipped = playwrightExitCode === 0;
    throw new NotActuallyLiveError(
      `e2e: this run declared ${LIVE_ENV_FLAG}=1 but made ZERO calls to the model.\n` +
        (skipped
          ? `  Playwright exited 0, so this would otherwise have been reported as a passing ` +
            `LIVE sweep. It measured nothing.\n`
          : `  Playwright also failed, so the run was broken before it got that far.\n`) +
        `  Either every spec selected was skipped (a live spec skips unless it is the one you ` +
        `named), or the server under test never reached analyzeBatch's model path.\n` +
        `  Check the spec selection, and that no MT_TEST_LLM_STUB_FILE is set in your shell.`,
    );
  }
  const sum = (f: (c: (typeof calls)[number]) => number) => calls.reduce((a, c) => a + f(c), 0);
  const n = (x: number) => x.toLocaleString("en-GB");
  console.log(
    `[e2e] LLM: LIVE confirmed — ${n(calls.length)} model call(s) billed: ` +
      `${n(sum((c) => c.inputTokens))} in / ${n(sum((c) => c.outputTokens))} out / ` +
      `${n(sum((c) => c.cacheReadTokens))} cache-read / ` +
      `${n(sum((c) => c.cacheWrite1hTokens + c.cacheWrite5mTokens))} cache-write tokens, ` +
      `$${sum((c) => c.costUsd).toFixed(4)} across ${[...new Set(calls.map((c) => c.model))].join(", ")}.`,
  );
}

function run(cmd: string, args: string[], env: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<number> {
  // Say where this run lives BEFORE anything else, so every log, report
  // and pasted scoreboard can be traced back to the world it came from.
  console.log(`[e2e] ${describePorts(E2E_PORTS)}`);

  // Is the model seam wired the way the flag claims? This runs BEFORE
  // the run lock, before Postgres, before anything is written — a run
  // that cannot reach the model it says it is measuring must cost
  // nothing and change nothing. See helpers/live-llm.ts for the four
  // holes this closes and the false green that motivated them.
  await assertLlmSeamReady();

  assertSafeTestDbUrl(E2E_DB_URL);
  mkdirSync(path.dirname(E2E.DATA_DIR), { recursive: true });

  // Preflight comes before any side effect: nothing is written and no
  // process is started until we know the resources are ours.
  const releaseLock = acquireRunLock(E2E.RUN_LOCK, {
    checkout: REPO_ROOT,
    appPort: E2E.APP_PORT,
    dbPort: E2E.DB_PORT,
  });
  try {
    return await runSuite();
  } finally {
    releaseLock();
  }
}

async function runSuite(): Promise<number> {
  await assertAppPortAvailable(E2E.APP_PORT);
  const dbPort = await inspectDbPort({
    port: E2E.DB_PORT,
    dataDir: E2E.DATA_DIR,
    user: E2E.DB_USER,
    password: E2E.DB_PASSWORD,
  });

  // Document the URL for humans / ad-hoc psql (gitignored).
  writeFileSync(
    path.join(REPO_ROOT, ".env.e2e"),
    `# Generated by e2e/run.ts — ISOLATED local test database (embedded Postgres).\n` +
      `# Never points at prod. Safe to delete; recreated on every run.\n` +
      `# Ports are derived from this checkout's path (e2e/helpers/ports.ts).\n` +
      `DATABASE_URL=${E2E_DB_URL}\nDIRECT_URL=${E2E_DB_URL}\n` +
      `MT_E2E_APP_PORT=${E2E.APP_PORT}\nMT_E2E_DB_PORT=${E2E.DB_PORT}\n`,
  );

  const pg = new EmbeddedPostgres({
    databaseDir: E2E.DATA_DIR,
    user: E2E.DB_USER,
    password: E2E.DB_PASSWORD,
    port: E2E.DB_PORT,
    persistent: true,
    onLog: () => {},
    onError: () => {},
  });

  // The ONLY cluster this run will use is one it started, or one the
  // preflight proved is this checkout's own (left up by a crashed run).
  // The previous code caught a failed start() and reused whatever was on
  // the port without checking whose it was — and embedded-postgres
  // rejects with `undefined`, so the warning it printed said nothing.
  let weStartedPg = false;
  if (dbPort.kind === "ours") {
    console.log(`[e2e] reusing this checkout's cluster, already running at ${dbPort.dataDir}.`);
  } else {
    if (!existsSync(path.join(E2E.DATA_DIR, "PG_VERSION"))) {
      console.log("[e2e] initialising embedded Postgres cluster…");
      await pg.initialise();
    }
    console.log(`[e2e] starting embedded Postgres on 127.0.0.1:${E2E.DB_PORT}…`);
    try {
      await pg.start();
    } catch (err) {
      // embedded-postgres rejects with `undefined` on a bind failure.
      throw new E2EPreflightError(
        `e2e: could not start the embedded Postgres on 127.0.0.1:${E2E.DB_PORT} ` +
          `(data dir ${E2E.DATA_DIR}).\n` +
          `  Something took the port between the preflight and the start, or the cluster ` +
          `is damaged.\n` +
          `  Who has it:  lsof -nP -iTCP:${E2E.DB_PORT} -sTCP:LISTEN\n` +
          `  underlying error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    weStartedPg = true;
  }

  try {
    // Ensure the test database exists.
    const client = pg.getPgClient("postgres");
    await client.connect();
    const existsRes = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [E2E.DB_NAME]);
    if (existsRes.rowCount === 0) {
      await client.query(`CREATE DATABASE ${E2E.DB_NAME}`);
      console.log(`[e2e] created database ${E2E.DB_NAME}`);
    }
    await client.end();

    const dbEnv = { DATABASE_URL: E2E_DB_URL, DIRECT_URL: E2E_DB_URL };

    // Prisma client (src/generated/prisma) — generate if missing.
    if (!existsSync(path.join(REPO_ROOT, "src", "generated", "prisma"))) {
      console.log("[e2e] generating Prisma client…");
      const gen = await run("npx", ["prisma", "generate"], dbEnv);
      if (gen !== 0) return gen;
    }

    console.log("[e2e] applying schema (prisma db push)…");
    const push = await run("npx", ["prisma", "db", "push"], dbEnv);
    if (push !== 0) return push;

    console.log("[e2e] seeding fixture world…");
    const seedCode = await run("npx", ["tsx", "e2e/helpers/seed-cli.ts"], {
      MT_E2E_DATABASE_URL: E2E_DB_URL,
    });
    if (seedCode !== 0) return seedCode;

    // ── the wire, for live runs ──────────────────────────────────────
    // A live sweep has to be able to SHOW it was live. The metering
    // proxy already exists (e2e/replay/meter.ts) and forwards every
    // Anthropic call verbatim while banking the `usage` block, so every
    // live run now goes through it: the orchestrator can then state how
    // many calls were really made and what they cost — and refuse the
    // run outright if the answer is none.
    //   MT_REPLAY_METER_PORT → the replay spec owns its own proxy; leave it be.
    //   MT_E2E_NO_METER=1    → opt out (the reach assertion in the live
    //                          specs is then the only backstop).
    let meter: AnthropicMeter | null = null;
    if (isLiveRun() && !process.env.MT_REPLAY_METER_PORT && process.env.MT_E2E_NO_METER !== "1") {
      meter = new AnthropicMeter();
      const url = await meter.listen(0);
      process.env.MT_E2E_LIVE_METER_PORT = new URL(url).port;
      console.log(`[e2e] LLM: metering every model call through ${url} (measured, not estimated).`);
    }

    console.log("[e2e] running Playwright…");
    const pwArgs = ["playwright", "test", ...process.argv.slice(2)];
    try {
      const code = await run("npx", pwArgs, { ...buildTestEnv(), MT_E2E: "1" });
      if (meter) assertMeterSawTraffic(meter, code);
      return code;
    } finally {
      await meter?.close();
    }
  } finally {
    if (weStartedPg) {
      console.log("[e2e] stopping embedded Postgres…");
      await pg.stop().catch(() => {});
    }
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    // A preflight refusal is a decision, not a crash: print the message
    // it was written to be read, not a stack trace nobody needs.
    if (err instanceof E2EPreflightError || err instanceof NotActuallyLiveError)
      console.error(`\n${err.message}\n`);
    else console.error("[e2e] fatal:", err);
    process.exit(1);
  },
);
