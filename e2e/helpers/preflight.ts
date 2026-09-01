/**
 * The gate the e2e orchestrator passes through before it touches
 * anything. Its whole job is to turn "quietly use somebody else's
 * resources" into "stop and say so".
 *
 * There were two silent-adoption paths and this closes both:
 *
 *   1. `playwright.config.ts` set `reuseExistingServer: true`, so a dev
 *      server started by ANOTHER checkout — quite possibly a live-LLM one
 *      with no `MT_TEST_LLM_STUB_FILE` — was adopted as if it were ours.
 *   2. `e2e/run.ts` caught a failed `pg.start()` and reused "the
 *      already-running embedded cluster", never checking whose it was.
 *      The embedded-postgres failure it swallowed is literally
 *      `undefined`, so the warning it printed carried no information.
 *
 * The rule now: the suite uses a Postgres it started, or one it can PROVE
 * is its own by reading `data_directory` back off the server and matching
 * it against this checkout's `.e2e/pgdata` (the crash-recovery case).
 * Anything else, and anything at all on the app port, aborts the run.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { Client } from "pg";
import { APP_PORT_ENV, DB_PORT_ENV } from "./ports";

/** Thrown when the suite refuses to start. Distinct from a test failure:
 *  nothing ran, and nothing was touched. */
export class E2EPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "E2EPreflightError";
  }
}

/** Is anything accepting connections on this port? */
export function portInUse(port: number, host = "127.0.0.1", timeoutMs = 750): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (inUse: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * The Next dev server's port must be FREE. There is no benign case: a
 * server we did not start has an env we did not choose — a different
 * DATABASE_URL, possibly no LLM stub at all — and serving the suite's
 * requests from it is exactly how a run reports plausible wrong numbers.
 */
export async function assertAppPortAvailable(port: number): Promise<void> {
  if (!(await portInUse(port))) return;
  throw new E2EPreflightError(
    `e2e: REFUSING to run — something is already listening on the app port ${port}, ` +
      `and this run did not start it.\n` +
      `  A dev server from another checkout has a different DATABASE_URL and may have no ` +
      `LLM stub at all; adopting it produces plausible, wrong results rather than an error.\n` +
      `  Who has it:  lsof -nP -iTCP:${port} -sTCP:LISTEN\n` +
      `  If it is a stale server of your own, kill it. If it belongs to another checkout, ` +
      `wait for it, or set ${APP_PORT_ENV} to a free port for this run.`,
  );
}

export type DbPortVerdict =
  /** Nothing there — start our own cluster. */
  | { kind: "free" }
  /** Our own cluster, left running by an earlier crashed run. Reuse it. */
  | { kind: "ours"; dataDir: string };

/**
 * Decide whether the embedded Postgres port is usable, by IDENTITY and
 * not by hope: if something is listening, we ask the server where its
 * data directory is and require it to be this checkout's.
 */
export async function inspectDbPort(opts: {
  port: number;
  dataDir: string;
  user: string;
  password: string;
  host?: string;
}): Promise<DbPortVerdict> {
  const host = opts.host ?? "127.0.0.1";
  if (!(await portInUse(opts.port, host))) return { kind: "free" };

  const client = new Client({
    host,
    port: opts.port,
    user: opts.user,
    password: opts.password,
    database: "postgres",
    connectionTimeoutMillis: 5_000,
  });

  let running: string;
  try {
    await client.connect();
    const res = await client.query<{ data_directory: string }>("SHOW data_directory");
    running = res.rows[0]?.data_directory ?? "";
  } catch (err) {
    throw new E2EPreflightError(
      `e2e: REFUSING to run — port ${opts.port} is occupied by something this suite ` +
        `cannot identify as its own Postgres (${(err as Error).message}).\n` +
        `  Expected this checkout's cluster at ${realpathOrSelf(opts.dataDir)}.\n` +
        `  Who has it:  lsof -nP -iTCP:${opts.port} -sTCP:LISTEN\n` +
        `  Set ${DB_PORT_ENV} to a free port if you need to run anyway.`,
    );
  } finally {
    await client.end().catch(() => {});
  }

  const expected = realpathOrSelf(opts.dataDir);
  if (realpathOrSelf(running) !== expected) {
    throw new E2EPreflightError(
      `e2e: REFUSING to run — port ${opts.port} is serving ANOTHER checkout's test database.\n` +
        `  running cluster: ${running}\n` +
        `  this checkout:   ${expected}\n` +
        `  Running against it would truncate that checkout's fixture world mid-run and ` +
        `silently corrupt both sets of results (this is the defect PR #32 documented).\n` +
        `  Wait for the other run to finish, or set ${DB_PORT_ENV} to a free port.`,
    );
  }
  return { kind: "ours", dataDir: running };
}

/** What a run writes into `.e2e/run.lock` while it holds this checkout. */
export interface RunLockInfo {
  pid: number;
  startedAt: string;
  checkout: string;
  appPort: number;
  dbPort: number;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * One run per checkout at a time. Per-checkout ports stop two CHECKOUTS
 * colliding; they do nothing about two runs in the SAME directory, which
 * share the ports, `.e2e/pgdata` and the LLM stub file, and which was
 * previously just as silent. Returns the release function.
 */
export function acquireRunLock(
  lockPath: string,
  info: Omit<RunLockInfo, "pid" | "startedAt">,
): () => void {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  let held: RunLockInfo | null = null;
  try {
    held = JSON.parse(readFileSync(lockPath, "utf8")) as RunLockInfo;
  } catch {
    held = null; // absent, or unreadable garbage — treat as free.
  }
  if (held && typeof held.pid === "number" && processAlive(held.pid)) {
    throw new E2EPreflightError(
      `e2e: REFUSING to run — another e2e run (pid ${held.pid}, started ${held.startedAt}) ` +
        `already owns this checkout.\n` +
        `  It holds app port ${held.appPort}, db port ${held.dbPort}, .e2e/pgdata and the LLM ` +
        `stub file; a second run here would truncate its fixture world mid-sweep.\n` +
        `  Wait for it, or if it is dead:  rm ${lockPath}`,
    );
  }
  const mine: RunLockInfo = { ...info, pid: process.pid, startedAt: new Date().toISOString() };
  writeFileSync(lockPath, `${JSON.stringify(mine, null, 2)}\n`);
  return () => {
    try {
      const now = JSON.parse(readFileSync(lockPath, "utf8")) as RunLockInfo;
      if (now.pid === process.pid) rmSync(lockPath, { force: true });
    } catch {
      // Already gone, or replaced by someone else. Nothing to release.
    }
  };
}
