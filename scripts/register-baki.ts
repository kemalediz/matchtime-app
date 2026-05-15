/**
 * One-off: register Baki for the May 19 match. His "In" at 10:14 was
 * silently dropped because pushname "ba" was ambiguous between Baki
 * and Başar; the UserAlias["ba"] → Baki row that should have
 * disambiguated wasn't consulted on the ambiguity path. Fixed in the
 * route, but Baki still needs his slot.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { registerAttendance } from "../src/lib/attendance.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  const baki = await db.user.findFirst({
    where: { name: { equals: "Baki", mode: "insensitive" } },
    select: { id: true, name: true },
  });
  if (!baki) { console.error("no Baki"); process.exit(1); }
  const match = await db.match.findFirst({
    where: { status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] } },
    orderBy: { date: "asc" },
  });
  if (!match) { console.error("no upcoming match"); process.exit(1); }
  console.log(`Registering ${baki.name} (${baki.id}) for ${match.id}…`);
  const result = await registerAttendance(baki.id, match.id);
  console.log("Result:", result);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
