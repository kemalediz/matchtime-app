import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { normalisePhone } from "@/lib/phone";

/**
 * Auto-normalise `User.phoneNumber` on EVERY write through this client.
 *
 * Why this exists (2026-05-25):
 *   Phone numbers historically got stored in multiple formats for the
 *   same human ("+447943789944", "07943 789944", "+44 7826 286403", …),
 *   which produced silent duplicate User rows. When a WhatsApp message
 *   arrived, sender-resolution would match the WRONG row (the one with
 *   no attendance), then cancelAttendance was a silent no-op, and the
 *   bot looked broken even though the LLM verdict was perfect.
 *   Documented in MDs/learnings.md.
 *
 * The defence is multi-layered:
 *   1. THIS extension — every Prisma write goes through normalisePhone.
 *      Defends against any TS/JS caller forgetting to normalise.
 *   2. A DB CHECK constraint on `User.phoneNumber` enforces E.164 at
 *      the storage layer, blocking even raw-SQL bypass. Installed by
 *      `scripts/normalise-phones-migration.ts --apply`.
 *   3. Existing data is migrated to canonical form by that same script
 *      (one-shot, idempotent; merges duplicates via mergePlayers core).
 *
 * Apply at the SINGLE PrismaClient instantiation so every importer of
 * `db` benefits automatically.
 */
function normaliseDataPhone<D extends { phoneNumber?: string | null }>(data: D): D {
  if (data && "phoneNumber" in data && data.phoneNumber !== undefined && data.phoneNumber !== null) {
    const n = normalisePhone(data.phoneNumber);
    // If normalisation returns null (junk input), we DON'T silently
    // null out the column — the DB CHECK constraint will reject the
    // write so the caller learns about it loudly. That's intentional.
    if (n !== null) data.phoneNumber = n;
  }
  return data;
}

function withPhoneNormalisation(client: PrismaClient) {
  return client.$extends({
    name: "auto-normalise-phone",
    query: {
      user: {
        async create({ args, query }) {
          args.data = normaliseDataPhone(args.data);
          return query(args);
        },
        async update({ args, query }) {
          if (args.data) args.data = normaliseDataPhone(args.data as { phoneNumber?: string | null });
          return query(args);
        },
        async upsert({ args, query }) {
          if (args.create) args.create = normaliseDataPhone(args.create);
          if (args.update) args.update = normaliseDataPhone(args.update as { phoneNumber?: string | null });
          return query(args);
        },
        async updateMany({ args, query }) {
          if (args.data) args.data = normaliseDataPhone(args.data as { phoneNumber?: string | null });
          return query(args);
        },
        async createMany({ args, query }) {
          if (Array.isArray(args.data)) {
            args.data = args.data.map((d) => normaliseDataPhone(d));
          } else {
            args.data = normaliseDataPhone(args.data);
          }
          return query(args);
        },
      },
    },
  });
}

type ExtendedDb = ReturnType<typeof withPhoneNormalisation>;

const globalForPrisma = globalThis as unknown as {
  prisma: ExtendedDb | undefined;
};

function createPrismaClient(): ExtendedDb {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const base = new PrismaClient({ adapter });
  return withPhoneNormalisation(base);
}

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
