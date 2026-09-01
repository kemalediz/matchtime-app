/**
 * Where this checkout's e2e suite runs.
 *
 * WHY THIS EXISTS. `helpers/env.ts` used to hard-code 3105 (Next dev)
 * and 54311 (embedded Postgres), and `playwright.config.ts` set
 * `reuseExistingServer: true`. Two checkouts of this repo — two git
 * worktrees, two agents, a clone next to the original — running
 * `npm run test:e2e` at the same time therefore shared BOTH the database
 * and the dev server. One run's `resetDb()` truncated the other's world
 * mid-sweep; a live-mode dev server (no `MT_TEST_LLM_STUB_FILE`) served
 * the other run's stubbed requests as noise. NEITHER RUN ERRORED. Both
 * reported plausible, wrong numbers: the same commit measured 26/35 and
 * then 9/35 on consecutive corpus sweeps, and three measurements —
 * including a paid live sweep — had to be thrown away.
 *
 * THE FIX. Each checkout gets its own port pair, derived from the
 * absolute path of the checkout. Derived rather than dynamically
 * allocated because:
 *
 *   - it is REPRODUCIBLE. The same checkout gets the same ports on every
 *     run, so `.e2e/pgdata` is always reachable at the same address,
 *     `psql` from a second terminal keeps working, and a failure can be
 *     re-run against the same environment. A free-port allocator makes
 *     every run a new world and every rerun a different one.
 *   - it cannot RACE. "Find a free port, then bind it" has a window in
 *     which someone else binds it; a derived port has no window, because
 *     the process that owns the checkout is the only one asking for it.
 *
 * Its one weakness is the mirror image: two checkouts whose paths hash to
 * the same slot still collide. That is why `helpers/preflight.ts` refuses
 * to start on a port it does not own instead of quietly reusing it, and
 * why the collision is reported with the override to escape it. A loud
 * 1-in-{@link PORT_SPAN} failure is a far better trade than a silent
 * always-collision.
 *
 * Overrides, for that case and for CI matrices:
 *   MT_E2E_APP_PORT   Next dev server
 *   MT_E2E_DB_PORT    embedded Postgres
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

/** The historical fixed ports. Now the bottom of each checkout's range,
 *  so a derived port still looks like an e2e port at a glance. */
export const PORT_BASE = { app: 3105, db: 54311 } as const;

/** How many checkouts the allocator can separate. 3105–3304 / 54311–54510. */
export const PORT_SPAN = 200;

export const APP_PORT_ENV = "MT_E2E_APP_PORT";
export const DB_PORT_ENV = "MT_E2E_DB_PORT";

export type PortSource = "env" | "checkout";

export interface ResolvedPorts {
  app: number;
  db: number;
  appSource: PortSource;
  dbSource: PortSource;
  /** 0…PORT_SPAN-1: the slot this checkout hashes to. */
  slot: number;
  /** The canonical checkout path the slot was derived from. */
  checkout: string;
}

/** Absolute, symlink-resolved, no trailing separator — so that the same
 *  checkout reached by two spellings gets one slot, not two. */
function canonicalise(checkoutRoot: string): string {
  const abs = path.resolve(checkoutRoot);
  let real = abs;
  try {
    real = realpathSync(abs);
  } catch {
    // The path need not exist (unit tests pass hypothetical checkouts).
  }
  return real.length > 1 ? real.replace(/[/\\]+$/, "") : real;
}

/** The deterministic slot for a checkout. Stable across runs, machines
 *  and node versions — it is a SHA-256 of the path, nothing else. */
export function checkoutSlot(checkoutRoot: string): number {
  const digest = createHash("sha256").update(canonicalise(checkoutRoot)).digest();
  return digest.readUInt32BE(0) % PORT_SPAN;
}

function readOverride(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  name: string,
): number | null {
  const raw = env[name];
  if (raw === undefined) return null;
  // An empty or malformed override is a mistake, and the one thing this
  // module must never do is quietly fall back to a shared default.
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(
      `e2e: ${name}="${raw}" is not a port number. Unset it, or set it to an integer in 1024–65535.`,
    );
  }
  const port = Number(raw.trim());
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`e2e: ${name}=${raw} is out of range. Use an integer in 1024–65535.`);
  }
  return port;
}

export function resolvePorts(
  checkoutRoot: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): ResolvedPorts {
  const slot = checkoutSlot(checkoutRoot);
  const appOverride = readOverride(env, APP_PORT_ENV);
  const dbOverride = readOverride(env, DB_PORT_ENV);
  const app = appOverride ?? PORT_BASE.app + slot;
  const db = dbOverride ?? PORT_BASE.db + slot;
  if (app === db) {
    throw new Error(
      `e2e: the dev server and the database cannot use the same port (${app}). ` +
        `Check ${APP_PORT_ENV} / ${DB_PORT_ENV}.`,
    );
  }
  return {
    app,
    db,
    appSource: appOverride === null ? "checkout" : "env",
    dbSource: dbOverride === null ? "checkout" : "env",
    slot,
    checkout: canonicalise(checkoutRoot),
  };
}

/** The one line every run prints, so anyone reading a log — or a stale
 *  scoreboard someone pasted into a PR — can tell which world it ran in. */
export function describePorts(p: ResolvedPorts): string {
  const how = (s: PortSource, envName: string) =>
    s === "env" ? `${envName} override` : `slot ${p.slot} of ${PORT_SPAN}`;
  return (
    `checkout ${p.checkout}\n` +
    `[e2e] app  http://localhost:${p.app}  (${how(p.appSource, APP_PORT_ENV)})\n` +
    `[e2e] db   127.0.0.1:${p.db}  (${how(p.dbSource, DB_PORT_ENV)})\n` +
    `[e2e] ports are derived per checkout; override with ${APP_PORT_ENV} / ${DB_PORT_ENV}`
  );
}
