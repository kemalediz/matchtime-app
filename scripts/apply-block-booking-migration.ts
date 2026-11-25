import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
const APPLY = process.argv.includes("--apply");
async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const pre: any = await db.$queryRawUnsafe(`SELECT to_regclass('"BlockBooking"')::text AS t;`);
  const preCol: any = await db.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_name='Match' AND column_name='blockBookingId';`);
  console.log(`BEFORE: BlockBooking table=${pre[0].t ?? "MISSING"}  Match.blockBookingId=${preCol[0].n ? "present" : "MISSING"}`);
  if (!APPLY) { console.log("(dry-run — pass --apply)"); await db.$disconnect(); return; }

  await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "BlockBooking" (
    "id" TEXT NOT NULL, "orgId" TEXT NOT NULL, "activityId" TEXT NOT NULL,
    "startDate" DATE NOT NULL, "endDate" DATE NOT NULL, "time" TEXT NOT NULL,
    "costPerMatch" DOUBLE PRECISION, "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BlockBooking_pkey" PRIMARY KEY ("id"));`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "BlockBooking_orgId_idx" ON "BlockBooking"("orgId");`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "BlockBooking_activityId_idx" ON "BlockBooking"("activityId");`);
  await db.$executeRawUnsafe(`ALTER TABLE "Match" ADD COLUMN IF NOT EXISTS "blockBookingId" TEXT;`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Match_blockBookingId_idx" ON "Match"("blockBookingId");`);
  // FKs (guarded — re-running is a no-op)
  await db.$executeRawUnsafe(`DO $$ BEGIN
    ALTER TABLE "BlockBooking" ADD CONSTRAINT "BlockBooking_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await db.$executeRawUnsafe(`DO $$ BEGIN
    ALTER TABLE "Match" ADD CONSTRAINT "Match_blockBookingId_fkey" FOREIGN KEY ("blockBookingId") REFERENCES "BlockBooking"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);

  const post: any = await db.$queryRawUnsafe(`SELECT to_regclass('"BlockBooking"')::text AS t;`);
  const postCol: any = await db.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_name='Match' AND column_name='blockBookingId';`);
  const matches: any = await db.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "Match";`);
  console.log(`AFTER:  BlockBooking table=${post[0].t}  Match.blockBookingId=${postCol[0].n ? "present" : "MISSING"}  (Match rows intact: ${matches[0].n})`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
