import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  // Deploy of PR#13 (synthetic ids) was ~2026-08-30 14:50 UTC
  const since = new Date("2026-08-30T13:00:00Z");
  const rows = await db.analyzedMessage.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: "asc" } });
  console.log(`AnalyzedMessage since PR#13 deploy: ${rows.length}`);
  for (const r of rows) {
    const synth = r.waMessageId.startsWith("synthetic:");
    console.log(`  ${r.createdAt.toISOString()} id=${r.waMessageId.slice(0,42)} ${synth ? "<-- SYNTHETIC (real id unreadable)" : "<-- REAL id"}`);
    console.log(`      author=${r.authorName ?? "NULL"} phone=${r.authorPhone ?? "NULL"} userId=${r.authorUserId ?? "NULL <-- UNATTRIBUTED"} intent=${r.intent}`);
  }
  const unattributed = await db.analyzedMessage.count({ where: { createdAt: { gte: since }, authorUserId: null } });
  console.log(`\nUnattributed (authorUserId NULL) since deploy: ${unattributed}`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
