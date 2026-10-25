/**
 * How the e2e orchestrator brings the isolated test database to the schema.
 *
 * `.e2e/pgdata` persists between runs, so the test database a checkout
 * built last week still has every column the schema has since dropped.
 * `prisma db push` refuses to drop a column that holds values unless it is
 * given `--accept-data-loss`; after PR #411 retired seven User columns, every
 * older checkout stopped at that prompt before a single spec ran.
 *
 * The data in that database is a seeded fixture world, rebuilt on every
 * run, so losing it costs nothing. The flag is therefore always passed, but
 * ONLY after `assertSafeTestDbUrl` has proved the URL is a loopback address
 * with no hosted provider in it. This is the one place in the harness that
 * may name the flag (schema-push.test.ts fails if another file does).
 */
import { assertSafeTestDbUrl } from "./env";

export function schemaPushArgs(url: string | undefined): string[] {
  assertSafeTestDbUrl(url);
  return ["prisma", "db", "push", "--accept-data-loss"];
}
