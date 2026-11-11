/**
 * A READ-ONLY database client for harnesses that read production (the
 * UNIFIED_ANSWERS A/B, 2026-11-10). Import it FIRST, before anything that
 * imports `src/lib/db.ts`: it puts a Prisma client on `globalThis.prisma`,
 * which `db.ts` then uses instead of making its own.
 *
 * Every write operation (create, update, upsert, delete and their many
 * forms, and raw executes) THROWS before it reaches the database. No SET is
 * ever sent (Kemal's rule: a leaked session SET once broke prod writes).
 * Code that mints something while reading (a pay link) fails at that write
 * and is left out, which callers already treat as a failed read.
 */
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { PrismaPg } from "@prisma/adapter-pg";

const WRITES = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
  "executeRaw",
  "executeRawUnsafe",
  "$executeRaw",
  "$executeRawUnsafe",
]);

export const refusedWrites: string[] = [];

const base = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const readOnly = base.$extends({
  name: "read-only-harness",
  query: {
    async $allOperations({ operation, model, args, query }) {
      if (WRITES.has(operation)) {
        refusedWrites.push(`${model ?? "raw"}.${operation}`);
        throw new Error(`READ-ONLY HARNESS: refused ${model ?? "raw"}.${operation}`);
      }
      return query(args);
    },
  },
});

(globalThis as unknown as { prisma: unknown }).prisma = readOnly;

/** Proves the guard before anything runs: a delete that would match nothing
 *  anyway must be refused here, not sent. */
export async function assertReadOnly(): Promise<void> {
  const db = (globalThis as unknown as { prisma: typeof readOnly }).prisma;
  try {
    await db.botJob.deleteMany({ where: { id: "__never_an_id__" } });
  } catch (err) {
    if (/READ-ONLY HARNESS/.test((err as Error).message)) return;
    throw err;
  }
  throw new Error("the read-only guard did not refuse a delete");
}
