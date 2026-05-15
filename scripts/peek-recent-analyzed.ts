import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  const start = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const rows = await db.analyzedMessage.findMany({
    where: { createdAt: { gte: start } },
    orderBy: { createdAt: "asc" },
  });
  console.log("Last 6h analyzed messages:", rows.length);
  for (const r of rows) {
    const u = r.authorUserId
      ? await db.user.findUnique({ where: { id: r.authorUserId }, select: { name: true } })
      : null;
    const t = r.createdAt.toLocaleString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    console.log(
      `  [${t}] handledBy=${r.handledBy} intent=${(r.intent || "-").padEnd(18)} action=${(r.action || "-").padEnd(8)} ` +
        `author=${u?.name ?? r.authorPhone ?? "(unresolved)"} body="${(r.body || "").slice(0, 60).replace(/\n/g, " ")}"`,
    );
    if (r.body?.toLowerCase().includes("in") && (r.body || "").trim().length < 30) {
      console.log(`      reasoning: ${(r.reasoning ?? "").slice(0, 200)}`);
    }
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
