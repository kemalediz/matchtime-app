/**
 * A stand-in for one `npm run test:e2e` invocation, small enough to run
 * two of them at once inside a unit test.
 *
 * It does the only part of the orchestrator that matters for isolation:
 * resolve this checkout's e2e configuration through the REAL
 * `helpers/env.ts` (so `process.cwd()` decides the ports and the data
 * directory, exactly as it does in `e2e/run.ts`), bring up the embedded
 * Postgres, write a marker row, wait at a barrier until every peer probe
 * has written its own marker — so all the clusters are up at the same
 * time, which is the contended case — and then report what it can see.
 *
 * Run it with `cwd` set to the checkout under test:
 *
 *   npx tsx <repo>/e2e/helpers/isolation-probe.ts --marker=A \
 *     --barrier=/path/to/barrier --peers=A,B
 *
 * It prints one line of JSON between __PROBE__ sentinels on stdout.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
// Deliberately imports ONLY the long-standing surface of helpers/env.ts,
// so the same probe runs against the pre-fix code and demonstrates the
// collision it was written to catch.
import { E2E, E2E_DB_URL, REPO_ROOT } from "./env";

function arg(name: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) throw new Error(`isolation-probe: missing --${name}=`);
  return hit.slice(name.length + 3);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const marker = arg("marker");
  const barrier = arg("barrier");
  const peers = arg("peers").split(",");

  const pg = new EmbeddedPostgres({
    databaseDir: E2E.DATA_DIR,
    user: E2E.DB_USER,
    password: E2E.DB_PASSWORD,
    port: E2E.DB_PORT,
    persistent: true,
    onLog: () => {},
    onError: () => {},
  });

  if (!existsSync(path.join(E2E.DATA_DIR, "PG_VERSION"))) {
    mkdirSync(path.dirname(E2E.DATA_DIR), { recursive: true });
    await pg.initialise();
  }
  await pg.start();

  try {
    const admin = pg.getPgClient("postgres");
    await admin.connect();
    const exists = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [E2E.DB_NAME]);
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${E2E.DB_NAME}`);
    await admin.end();

    const db = pg.getPgClient(E2E.DB_NAME);
    await db.connect();
    await db.query(`CREATE TABLE IF NOT EXISTS isolation_marker (name text PRIMARY KEY)`);
    await db.query(`INSERT INTO isolation_marker (name) VALUES ($1) ON CONFLICT DO NOTHING`, [
      marker,
    ]);

    // Barrier: hold every cluster up simultaneously. If two checkouts
    // shared a port, one of them would already have failed to start —
    // and if they somehow shared a cluster, the SELECT below sees it.
    mkdirSync(barrier, { recursive: true });
    writeFileSync(path.join(barrier, `${marker}.ready`), String(process.pid));
    const deadline = Date.now() + 30_000;
    for (;;) {
      const ready = new Set(readdirSync(barrier).filter((f) => f.endsWith(".ready")));
      if (peers.every((p) => ready.has(`${p}.ready`))) break;
      if (Date.now() > deadline) throw new Error(`isolation-probe(${marker}): barrier timed out`);
      await sleep(50);
    }

    const seen = await db.query<{ name: string }>(`SELECT name FROM isolation_marker ORDER BY name`);
    await db.end();

    process.stdout.write(
      `__PROBE__${JSON.stringify({
        marker,
        root: REPO_ROOT,
        dbPort: E2E.DB_PORT,
        appPort: E2E.APP_PORT,
        dataDir: E2E.DATA_DIR,
        dbUrl: E2E_DB_URL,
        seen: seen.rows.map((r) => r.name),
      })}__PROBE__\n`,
    );
  } finally {
    await pg.stop().catch(() => {});
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
