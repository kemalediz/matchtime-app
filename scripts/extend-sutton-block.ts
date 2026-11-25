import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { generateBlockOccurrences } from "../src/lib/block-booking.ts";

const APPLY = process.argv.includes("--apply");
const END = "2027-01-12"; // 20th Tuesday from 2026-09-01

async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const block = await db.blockBooking.findFirst({
    where: { activityId: "tuesday-7aside" },
    include: { activity: { include: { sport: true } } },
    orderBy: { createdAt: "desc" },
  });
  if (!block) throw new Error("block not found");
  const act = block.activity;

  const occ = generateBlockOccurrences({
    startDate: block.startDate.toISOString().slice(0, 10),
    endDate: END,
    dayOfWeek: act.dayOfWeek, time: act.time, deadlineHours: act.deadlineHours,
  });
  console.log(`Block ${block.id}: extending to ${END} -> ${occ.length} occurrences total`);

  if (!APPLY) { console.log("(dry-run)"); await db.$disconnect(); return; }

  await db.blockBooking.update({ where: { id: block.id }, data: { endDate: new Date(`${END}T00:00:00Z`), notes: "Autumn/winter block, 20 weeks." } });

  let created = 0;
  for (const o of occ) {
    const clash = await db.match.findFirst({
      where: { activityId: act.id, date: { gte: new Date(o.kickoffUtc.getTime() - 90*60000), lte: new Date(o.kickoffUtc.getTime() + 90*60000) } },
    });
    if (clash) continue;
    await db.match.create({
      data: { activityId: act.id, blockBookingId: block.id, date: o.kickoffUtc,
              maxPlayers: act.sport.playersPerTeam * 2, attendanceDeadline: o.attendanceDeadline },
    });
    created++;
  }
  const total = await db.match.count({ where: { blockBookingId: block.id } });
  console.log(`Added ${created}. Block now holds ${total} matches.`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
