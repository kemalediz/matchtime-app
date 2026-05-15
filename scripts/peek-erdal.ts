/**
 * Verify whether the LLM's "Erdal goes on the bench" actually
 * materialised as a DB row (vs just being narrative text).
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const erdal = await db.user.findFirst({
    where: { name: { contains: "Erdal", mode: "insensitive" } },
    select: { id: true, name: true },
  });
  console.log("Erdal user:", erdal);

  const nextMatch = await db.match.findFirst({
    where: {
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
    },
    orderBy: { date: "asc" },
    include: {
      attendances: {
        include: { user: { select: { name: true } } },
        orderBy: { position: "asc" },
      },
    },
  });
  if (!nextMatch) { console.log("no upcoming match"); process.exit(0); }

  console.log(`\nNext match: ${nextMatch.id} | ${nextMatch.date.toISOString()} | status=${nextMatch.status}`);
  console.log(`Total attendances: ${nextMatch.attendances.length}`);
  for (const a of nextMatch.attendances) {
    const me = erdal && a.userId === erdal.id ? " ← Erdal" : "";
    console.log(`  ${a.status.padEnd(10)} pos=${a.position} ${a.user.name}${me}`);
  }

  if (erdal) {
    const erdalAtt = nextMatch.attendances.find((a) => a.userId === erdal.id);
    console.log(`\nErdal's attendance for next match: ${erdalAtt ? erdalAtt.status : "NONE (not registered)"}`);
  }

  // Latest analysed message from Erdal-shaped sender to see how the
  // LLM actually handled it.
  if (erdal) {
    const recent = await db.analyzedMessage.findMany({
      where: { OR: [{ authorUserId: erdal.id }, { body: { contains: "Erdal", mode: "insensitive" } }] },
      orderBy: { createdAt: "desc" },
      take: 6,
    });
    console.log(`\nLast 6 AnalyzedMessage rows mentioning Erdal:`);
    for (const r of recent) {
      console.log(`  [${r.createdAt.toISOString().slice(0, 19)}] handledBy=${r.handledBy} intent=${r.intent} action=${r.action} authorUserId=${r.authorUserId} body="${(r.body ?? "").slice(0, 80).replace(/\n/g, " ")}" reasoning="${(r.reasoning ?? "").slice(0, 240)}"`);
    }
  }

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
