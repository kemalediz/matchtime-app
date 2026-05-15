/**
 * One-off: register Erdal as BENCH for the May 19 match. The bot
 * announced "Erdal goes on the bench" earlier today but the LLM
 * emitted intent:question / action:reply, so no Attendance row was
 * written. Backfilling here so the words match reality.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { registerAttendance } from "../src/lib/attendance.ts";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const erdal = await db.user.findFirst({
    where: { name: { contains: "Erdal", mode: "insensitive" } },
    select: { id: true, name: true },
  });
  if (!erdal) { console.error("no Erdal"); process.exit(1); }

  const match = await db.match.findFirst({
    where: { status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] } },
    orderBy: { date: "asc" },
  });
  if (!match) { console.error("no upcoming match"); process.exit(1); }

  console.log(`Registering ${erdal.name} (${erdal.id}) for ${match.id} as forceBench…`);
  const result = await registerAttendance(erdal.id, match.id, { forceBench: true });
  console.log("Result:", result);

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
