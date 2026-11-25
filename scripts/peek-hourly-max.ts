import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const rows: any = await db.$queryRawUnsafe(`
    SELECT date_trunc('hour', "createdAt") AS hr, COUNT(*)::int AS n
    FROM "SentNotification"
    WHERE kind IN ('group-message','group-poll','bench-prompt')
      AND "createdAt" > NOW() - INTERVAL '120 days'
    GROUP BY 1 ORDER BY n DESC LIMIT 8;`);
  console.log("=== busiest hours EVER for group-directed sends (120d) ===");
  for (const r of rows) console.log(`  ${new Date(r.hr).toISOString().slice(0,13)}h  ->  ${r.n} messages`);
  const max = rows[0]?.n ?? 0;
  console.log(`\nAll-time busiest hour: ${max}  (current cap 10, proposed 40)`);
  console.log(max >= 8 ? "  !! close to the cap — worth shipping the fix before match day" : "  cap is very unlikely to bite tomorrow");
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
