import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const blocks = await db.blockBooking.count();
  console.log(`blockBooking.count() -> ${blocks}  (client + DB agree)`);
  const m = await db.match.findFirst({ select: { id: true, blockBookingId: true } });
  console.log(`match.blockBookingId readable -> ${m ? "yes" : "no rows"}  value=${m?.blockBookingId ?? "null"}`);
  const all = await db.match.findMany({ take: 3 });
  console.log(`match.findMany() default-select works -> ${all.length} rows (this is the query that would have broken)`);
  await db.$disconnect();
}
main().catch((e) => { console.error("SCHEMA MISMATCH:", e.message); process.exit(1); });
