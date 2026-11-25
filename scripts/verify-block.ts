import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const block = await db.blockBooking.findFirst({ where: { activityId: "tuesday-7aside" }, orderBy: { createdAt: "desc" } });
  const ms = await db.match.findMany({ where: { blockBookingId: block.id }, orderBy: { date: "asc" } });
  console.log(`Block: ${block.startDate.toISOString().slice(0,10)} -> ${block.endDate.toISOString().slice(0,10)}  £${block.costPerMatch}/match  (${ms.length} matches)\n`);
  ms.forEach((m: any, i: number) => {
    const lon = m.date.toLocaleString("en-GB", { timeZone: "Europe/London", weekday: "short", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    console.log(`${String(i+1).padStart(2)}. ${lon}  [${m.status}] max=${m.maxPlayers}  utc=${m.date.toISOString().slice(11,16)}`);
  });
  console.log(`\nTotal owed to venue: £${(block.costPerMatch * ms.length).toFixed(2)}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
