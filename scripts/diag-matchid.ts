import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const rows = await db.sentNotification.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 7*24*3600*1000) }, kind: "group-message" },
    orderBy: { createdAt: "asc" },
  });
  console.log("=== group-message SentNotifications: is matchId set? ===");
  for (const r of rows) {
    const flag = r.matchId ? "OK  " : "NULL"; // NULL => invisible to sentKeys => LOOPS
    console.log(`${flag}  ${r.createdAt.toISOString()}  matchId=${r.matchId ?? "NULL"}  key=${r.key.slice(0,60)}`);
  }
  const nulls = rows.filter((r:any)=>!r.matchId && !r.key.startsWith("org-"));
  console.log(`\nRows invisible to the dedupe set (matchId NULL, non-org key): ${nulls.length}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
