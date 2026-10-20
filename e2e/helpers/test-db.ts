/**
 * Spec-side access to the ISOLATED e2e database.
 *
 * Uses plain `pg` (not the Prisma client — Prisma 7's generated ESM-TS
 * client can't be loaded by Playwright's transpiler; it lives only in
 * the tsx world: run.ts / seed-cli.ts). Every connection is gated by
 * assertSafeTestDbUrl so specs can never touch a non-local DB.
 */
import { Pool, types } from "pg";
import { assertSafeTestDbUrl, E2E_DB_URL } from "./env";

/**
 * Prisma stores a DateTime in a `timestamp(3)` column (no zone) as the UTC
 * wall time. Plain `pg` reads and writes those as the MACHINE's local time,
 * which in British Summer Time put every instant a spec read an hour early
 * (monthly-squad.spec.ts, Tue 2026-10-20). These two keep the spec side
 * reading and writing the same instants Prisma does.
 */
export function parseUtcTimestamp(value: string): Date {
  return new Date(`${value.replace(" ", "T")}Z`);
}

export function toPgParam(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

const TIMESTAMP_OID = types.builtins.TIMESTAMP;

let _pool: Pool | null = null;

function pool(): Pool {
  if (!_pool) {
    const url = process.env.MT_E2E_DATABASE_URL ?? E2E_DB_URL;
    assertSafeTestDbUrl(url);
    _pool = new Pool({
      connectionString: url,
      max: 3,
      types: {
        getTypeParser: ((oid: number, format?: "text" | "binary") =>
          oid === TIMESTAMP_OID && format !== "binary" ? parseUtcTimestamp : types.getTypeParser(oid, format as "text")) as typeof types.getTypeParser,
      },
    });
  }
  return _pool;
}

export class TestDb {
  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await pool().query(sql, params.map(toPgParam));
    return res.rows as T[];
  }

  async one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.all<T>(sql, params);
    return rows[0] ?? null;
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    await pool().query(sql, params.map(toPgParam));
  }

  /** SELECT COUNT(*) helper — `sql` must select a single count column. */
  async count(sql: string, params: unknown[] = []): Promise<number> {
    const row = await this.one<Record<string, string | number>>(sql, params);
    if (!row) return 0;
    const v = Object.values(row)[0];
    return typeof v === "number" ? v : parseInt(String(v), 10);
  }
}

export function testDb(): TestDb {
  return new TestDb();
}
