import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const matches = await db.match.findMany({
    where: {
      activity: { org: { slug: "sutton-fc" } },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] as any },
    },
    include: { activity: { include: { sport: true } } },
    orderBy: { date: "asc" },
  });

  console.log(`UPCOMING sutton-fc matches (${matches.length}):\n`);
  for (const m of matches) {
    const confirmed = await db.attendance.count({
      where: { matchId: m.id, status: "CONFIRMED" },
    });
    console.log(
      `id=${m.id}  ${m.activity.name}  date=${m.date.toISOString()}  maxPlayers=${m.maxPlayers}  confirmed=${confirmed}`,
    );
  }

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
