import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { generateBlockOccurrences } from "../src/lib/block-booking.ts";

const APPLY = process.argv.includes("--apply");
const ACTIVITY_ID = "tuesday-7aside";
const START = "2026-09-01";
const END = "2026-10-27";
const COST_PER_MATCH = 142;

async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const act = await db.activity.findUnique({
    where: { id: ACTIVITY_ID },
    include: { sport: true, org: { select: { id: true, name: true } } },
  });
  if (!act) throw new Error("activity not found");

  const occ = generateBlockOccurrences({
    startDate: START, endDate: END,
    dayOfWeek: act.dayOfWeek, time: act.time, deadlineHours: act.deadlineHours,
  });

  console.log(`Activity: ${act.name} (${act.sport.name}, ${act.sport.playersPerTeam * 2} players) @ ${act.venue}`);
  console.log(`Block ${START} -> ${END}, ${act.time} London, £${COST_PER_MATCH}/match\n`);
  console.log(`${occ.length} matches:`);
  for (const o of occ) {
    const lon = o.kickoffUtc.toLocaleString("en-GB", { timeZone: "Europe/London", weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
    console.log(`  ${o.date}  London=${lon}  UTC=${o.kickoffUtc.toISOString()}`);
  }

  if (!APPLY) { console.log("\n(dry-run — pass --apply)"); await db.$disconnect(); return; }

  const block = await db.blockBooking.create({
    data: {
      orgId: act.org.id, activityId: act.id,
      startDate: new Date(`${START}T00:00:00Z`), endDate: new Date(`${END}T00:00:00Z`),
      time: act.time, costPerMatch: COST_PER_MATCH,
      notes: "Autumn block, 9 matches (25 Aug slot not used).",
    },
  });
  let created = 0;
  for (const o of occ) {
    const clash = await db.match.findFirst({
      where: { activityId: act.id, date: { gte: new Date(o.kickoffUtc.getTime() - 90*60000), lte: new Date(o.kickoffUtc.getTime() + 90*60000) } },
    });
    if (clash) { console.log(`  skip ${o.date} (existing match ${clash.id})`); continue; }
    await db.match.create({
      data: {
        activityId: act.id, blockBookingId: block.id, date: o.kickoffUtc,
        maxPlayers: act.sport.playersPerTeam * 2, attendanceDeadline: o.attendanceDeadline,
      },
    });
    created++;
  }
  console.log(`\nBlock ${block.id} created; ${created} matches generated.`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
