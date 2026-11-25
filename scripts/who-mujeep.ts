import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  console.log("=== AnalyzedMessage authorNames matching muj/moj ===");
  const am = await db.analyzedMessage.findMany({
    where: { OR: [{ authorName: { contains: "muj", mode:"insensitive" } }, { authorName: { contains: "moj", mode:"insensitive" } }] },
    select: { authorName: true, authorPhone: true, authorUserId: true, createdAt: true },
    orderBy: { createdAt: "desc" }, take: 8,
  });
  for (const r of am) console.log(`  ${r.createdAt.toISOString().slice(0,10)} name="${r.authorName}" phone=${r.authorPhone} userId=${r.authorUserId}`);
  console.log("\n=== UserAlias rows matching muj/moj ===");
  const al = await db.userAlias.findMany({ where: { alias: { contains: "m", mode:"insensitive" } }, take: 50 });
  for (const a of al) if (/muj|moj/i.test(a.alias)) console.log(`  alias="${a.alias}" -> userId=${a.userId}`);
  const mojib = await db.user.findFirst({ where: { name: "Mojib" }, select: { id: true, name: true, phoneNumber: true } });
  console.log(`\nMojib user: ${JSON.stringify(mojib)}`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
