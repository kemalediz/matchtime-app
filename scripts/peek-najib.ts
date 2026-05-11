/**
 * Investigate what happened to Najib's "In" message on May 8.
 *   - Find users named Najib
 *   - Look up the AnalyzedMessage rows where body = "In" / "in" from May 7-9
 *   - Check current attendance state for the May 12 match
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  console.log("=== Users named Najib ===");
  const users = await db.user.findMany({
    where: { name: { contains: "Najib", mode: "insensitive" } },
    select: { id: true, name: true, phoneNumber: true, email: true, createdAt: true },
  });
  for (const u of users) {
    console.log(`  ${u.id} | name="${u.name}" | phone=${u.phoneNumber} | email=${u.email} | createdAt=${u.createdAt.toISOString()}`);
  }

  console.log("\n=== AnalyzedMessage rows around May 8 with 'in'-shaped body ===");
  const start = new Date("2026-05-07T00:00:00Z");
  const end = new Date("2026-05-12T12:00:00Z");
  const messages = await db.analyzedMessage.findMany({
    where: {
      createdAt: { gte: start, lt: end },
      body: { mode: "insensitive", contains: "in" },
    },
    orderBy: { createdAt: "asc" },
  });
  for (const m of messages) {
    if (!m.body || m.body.trim().length > 25) continue; // skip long messages
    console.log(
      `  [${m.createdAt.toISOString().slice(0, 19)}] handledBy=${m.handledBy} intent=${m.intent} action=${m.action} ` +
        `authorUserId=${m.authorUserId} authorPhone=${m.authorPhone} body="${m.body.replace(/\n/g, " ")}" ` +
        `reasoning="${(m.reasoning ?? "").slice(0, 200)}"`,
    );
  }

  console.log("\n=== Sutton's next/most-recent match ===");
  const matches = await db.match.findMany({
    where: { date: { gte: new Date("2026-05-04") } },
    orderBy: { date: "asc" },
    take: 5,
    include: {
      activity: { select: { name: true, orgId: true } },
      attendances: {
        include: { user: { select: { name: true } } },
        orderBy: { position: "asc" },
      },
    },
  });
  for (const m of matches) {
    console.log(`\n  Match ${m.id} | ${m.activity.name} | ${m.date.toISOString()} | status=${m.status}`);
    for (const a of m.attendances) {
      console.log(`    ${a.status.padEnd(10)} pos=${a.position} ${a.user.name} (userId=${a.userId})`);
    }
  }

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
