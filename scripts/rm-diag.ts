import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const r = await db.analyzedMessage.deleteMany({ where: { waMessageId: { startsWith: "DIAG_PROBE_" } } });
  console.log(`cleaned diagnostic rows: ${r.count}`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
