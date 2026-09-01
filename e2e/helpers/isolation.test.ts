/**
 * The evidence that the e2e suite is isolated per checkout.
 *
 * These do not assert a config value — the hard-coded ports they replaced
 * would have passed that just as happily. They stand up REAL databases
 * from REAL working directories and check what each one can see, and they
 * drive the REAL orchestrator (`e2e/run.ts`) at a port somebody else
 * holds and check that it stops.
 *
 * Against the pre-fix code, the first test's two probes both die: the
 * second cannot bind 54311 because the first already has it, and the
 * first then times out at the barrier waiting for a peer that never
 * arrived. That is the defect, reproduced.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  E2EPreflightError,
  acquireRunLock,
  assertAppPortAvailable,
  inspectDbPort,
  portInUse,
} from "./preflight";
import { resolvePorts } from "./ports";

const REPO = process.cwd();
const SANDBOX = path.join(REPO, ".e2e", "isolation");
const PROBE = path.join(REPO, "e2e", "helpers", "isolation-probe.ts");
const RUNNER = path.join(REPO, "e2e", "run.ts");

const PG_CREDS = { user: "postgres", password: "postgres" };

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runNode(
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; timeoutMs?: number },
): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 60_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** A checkout is anything with a prisma/schema.prisma — that is the test
 *  `helpers/env.ts` already applies to `process.cwd()`. */
function makeCheckout(name: string): string {
  const dir = path.join(SANDBOX, name);
  mkdirSync(path.join(dir, "prisma"), { recursive: true });
  writeFileSync(path.join(dir, "prisma", "schema.prisma"), "// isolation-test stub\n");
  return dir;
}

/** Two checkouts whose derived ports are genuinely free right now, and
 *  which do not hash to the same slot. Colliding checkouts are a real and
 *  deliberate possibility — the preflight refusal below is what handles
 *  them — but they are not what THIS test is about. */
async function twoFreeCheckouts(): Promise<[string, string]> {
  const picked: string[] = [];
  const slots = new Set<number>();
  for (let i = 0; i < 60 && picked.length < 2; i++) {
    const dir = makeCheckout(`checkout-${i}`);
    const p = resolvePorts(dir, {});
    if (slots.has(p.slot)) continue;
    if (await portInUse(p.db)) continue;
    if (await portInUse(p.app)) continue;
    slots.add(p.slot);
    picked.push(dir);
  }
  if (picked.length < 2) throw new Error("isolation test: could not find two free checkout slots");
  return [picked[0], picked[1]];
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function listenOn(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((s) => s.end());
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

function closeServer(srv: net.Server): Promise<void> {
  return new Promise((resolve) => srv.close(() => resolve()));
}

async function startCluster(dir: string, port: number): Promise<EmbeddedPostgres> {
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    ...PG_CREDS,
    port,
    persistent: true,
    onLog: () => {},
    onError: () => {},
  });
  if (!existsSync(path.join(dir, "PG_VERSION"))) {
    mkdirSync(path.dirname(dir), { recursive: true });
    await pg.initialise();
  }
  await pg.start();
  return pg;
}

beforeAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(SANDBOX, { recursive: true });
});

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

describe("two checkouts running the suite at the same time", () => {
  it("do not share a database", async () => {
    const [alpha, beta] = await twoFreeCheckouts();
    const barrier = path.join(SANDBOX, "barrier");
    mkdirSync(barrier, { recursive: true });

    // Each probe brings up its checkout's embedded Postgres through the
    // real helpers/env.ts, writes a marker, and waits at the barrier
    // until the other one has done the same — so both clusters are up at
    // once, which is the case that used to break.
    const [a, b] = await Promise.all([
      runNode(["tsx", PROBE, "--marker=A", `--barrier=${barrier}`, "--peers=A,B"], {
        cwd: alpha,
        timeoutMs: 90_000,
      }),
      runNode(["tsx", PROBE, "--marker=B", `--barrier=${barrier}`, "--peers=A,B"], {
        cwd: beta,
        timeoutMs: 90_000,
      }),
    ]);

    expect(a.code, `probe A failed:\n${a.stderr}`).toBe(0);
    expect(b.code, `probe B failed:\n${b.stderr}`).toBe(0);

    const parse = (r: Ran) => {
      const m = r.stdout.match(/__PROBE__([^]*)__PROBE__/);
      if (!m) throw new Error(`no probe report in stdout:\n${r.stdout}\n${r.stderr}`);
      return JSON.parse(m[1]) as {
        root: string;
        dbPort: number;
        appPort: number;
        dataDir: string;
        seen: string[];
      };
    };
    const ra = parse(a);
    const rb = parse(b);

    // Different worlds, top to bottom.
    expect(ra.root).not.toBe(rb.root);
    expect(ra.dbPort).not.toBe(rb.dbPort);
    expect(ra.appPort).not.toBe(rb.appPort);
    expect(ra.dataDir).not.toBe(rb.dataDir);

    // The point of the whole exercise: neither run can see the other's
    // rows, so neither can truncate them.
    expect(ra.seen).toEqual(["A"]);
    expect(rb.seen).toEqual(["B"]);
  }, 180_000);

  it("get the same ports again on the next run, so a failure can be re-run", async () => {
    const [alpha] = await twoFreeCheckouts();
    expect(resolvePorts(alpha, {})).toEqual(resolvePorts(alpha, {}));
  }, 60_000);
});

describe("the preflight refuses resources it does not own", () => {
  it("rejects any listener on the app port", async () => {
    const port = await freePort();
    const srv = await listenOn(port);
    try {
      await expect(assertAppPortAvailable(port)).rejects.toBeInstanceOf(E2EPreflightError);
      await expect(assertAppPortAvailable(port)).rejects.toThrow(new RegExp(String(port)));
      await expect(assertAppPortAvailable(port)).rejects.toThrow(/MT_E2E_APP_PORT/);
    } finally {
      await closeServer(srv);
    }
    await expect(assertAppPortAvailable(port)).resolves.toBeUndefined();
  }, 60_000);

  it("rejects a Postgres on the db port whose data directory is another checkout's", async () => {
    const port = await freePort();
    const foreignDir = path.join(SANDBOX, "foreign-pgdata");
    const pg = await startCluster(foreignDir, port);
    try {
      const promise = inspectDbPort({
        port,
        dataDir: path.join(SANDBOX, "mine", "pgdata"),
        ...PG_CREDS,
      });
      await expect(promise).rejects.toBeInstanceOf(E2EPreflightError);
      await expect(
        inspectDbPort({ port, dataDir: path.join(SANDBOX, "mine", "pgdata"), ...PG_CREDS }),
      ).rejects.toThrow(/ANOTHER checkout/);
    } finally {
      await pg.stop().catch(() => {});
    }
  }, 120_000);

  it("still reuses THIS checkout's own cluster, left running by a crashed run", async () => {
    const port = await freePort();
    const ownDir = path.join(SANDBOX, "own-pgdata");
    const pg = await startCluster(ownDir, port);
    try {
      const verdict = await inspectDbPort({ port, dataDir: ownDir, ...PG_CREDS });
      expect(verdict.kind).toBe("ours");
    } finally {
      await pg.stop().catch(() => {});
    }
    expect(await inspectDbPort({ port, dataDir: ownDir, ...PG_CREDS })).toEqual({ kind: "free" });
  }, 120_000);

  it("refuses a second run in the same checkout", () => {
    const lock = path.join(SANDBOX, "run.lock");
    const info = { checkout: REPO, appPort: 1, dbPort: 2 };
    const release = acquireRunLock(lock, info);
    try {
      expect(() => acquireRunLock(lock, info)).toThrow(E2EPreflightError);
      expect(() => acquireRunLock(lock, info)).toThrow(/already owns this checkout/);
    } finally {
      release();
    }
    // Released — the next run may take it.
    acquireRunLock(lock, info)();
  });

  it("does not brick the checkout when a run is SIGKILLed", () => {
    // A lock left behind by a dead pid must be reclaimable, or one crash
    // costs everyone a manual `rm` they have no reason to know about.
    const lock = path.join(SANDBOX, "stale.lock");
    writeFileSync(
      lock,
      JSON.stringify({ pid: 2 ** 22, startedAt: "long ago", checkout: REPO, appPort: 1, dbPort: 2 }),
    );
    expect(() => acquireRunLock(lock, { checkout: REPO, appPort: 1, dbPort: 2 })()).not.toThrow();

    writeFileSync(lock, "not json at all");
    expect(() => acquireRunLock(lock, { checkout: REPO, appPort: 1, dbPort: 2 })()).not.toThrow();
  });

  it("hands the resolved ports to every child process", async () => {
    // run.ts, playwright.config.ts, the workers and the dev server are
    // separate processes. They must not each re-derive an answer.
    const { buildTestEnv } = (await import("./env")) as typeof import("./env");
    const env = buildTestEnv();
    const mine = resolvePorts(REPO);
    expect(env.MT_E2E_APP_PORT).toBe(String(mine.app));
    expect(env.MT_E2E_DB_PORT).toBe(String(mine.db));
    expect(env.DATABASE_URL).toContain(`:${mine.db}/`);
    expect(env.NEXT_PUBLIC_APP_URL).toContain(`:${mine.app}`);
  });
});

describe("e2e/run.ts", () => {
  const sandboxEnv = (appPort: number, dbPort: number) => ({
    MT_E2E_APP_PORT: String(appPort),
    MT_E2E_DB_PORT: String(dbPort),
    MT_E2E_RUN_LOCK: path.join(SANDBOX, "runner.lock"),
  });

  it("stops rather than adopt a dev server it did not start, and says which ports it used", async () => {
    const appPort = await freePort();
    const dbPort = await freePort();
    const srv = await listenOn(appPort);
    try {
      const r = await runNode(["tsx", RUNNER, "--list"], {
        cwd: REPO,
        env: sandboxEnv(appPort, dbPort),
        timeoutMs: 90_000,
      });
      expect(r.code, `expected a refusal, got:\n${r.stdout}\n${r.stderr}`).not.toBe(0);
      expect(r.stderr).toMatch(/REFUSING to run/);
      expect(r.stderr).toContain(String(appPort));
      // Debuggability: the run says where it lives before it does anything.
      expect(r.stdout).toContain(String(appPort));
      expect(r.stdout).toContain(String(dbPort));
      // And it did NOT go on to provision anything.
      expect(r.stdout).not.toMatch(/prisma db push|seeding fixture world/);
    } finally {
      await closeServer(srv);
    }
  }, 150_000);

  it("stops rather than run against another checkout's Postgres", async () => {
    const appPort = await freePort();
    const dbPort = await freePort();
    const foreignDir = path.join(SANDBOX, "foreign-runner-pgdata");
    const pg = await startCluster(foreignDir, dbPort);
    try {
      const r = await runNode(["tsx", RUNNER, "--list"], {
        cwd: REPO,
        env: sandboxEnv(appPort, dbPort),
        timeoutMs: 90_000,
      });
      expect(r.code, `expected a refusal, got:\n${r.stdout}\n${r.stderr}`).not.toBe(0);
      expect(r.stderr).toMatch(/REFUSING to run/);
      expect(r.stderr).toMatch(/ANOTHER checkout's test database/);
      expect(r.stderr).toContain(foreignDir);
      expect(r.stdout).not.toMatch(/prisma db push|seeding fixture world/);
    } finally {
      await pg.stop().catch(() => {});
    }
  }, 150_000);
});
