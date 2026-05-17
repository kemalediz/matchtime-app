/**
 * Creates a throwaway COMPLETED match dated yesterday so Kemal can
 * preview the rating page end-to-end. Seeded with 14 confirmed
 * attendances (Kemal + 13 active players), 7v7 Red/Yellow assignments,
 * final score 5-3.
 *
 * postMatchEndFlow = false so the bot won't touch it — no polls, no
 * DMs, no MoM announcement. Purely a canvas for testing the UI.
 *
 * Run:
 *   node --env-file=.env --import tsx scripts/create-test-match.ts
 *
 * To clean up later:
 *   node --env-file=.env --import tsx scripts/create-test-match.ts --delete
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const OWNER_EMAIL = "kemal.ediz@cressoft.io";
const ORG_SLUG = "sutton-fc";
const NAME_TAG = "[TEST] Rating preview"; // findable marker

async function main() {
  const deleteMode = process.argv.includes("--delete");

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const org = await db.organisation.findUnique({ where: { slug: ORG_SLUG } });
  if (!org) throw new Error("Org not found");

  if (deleteMode) {
    // Match records don't have a name of their own, but our test Activity does.
    const testActivity = await db.activity.findFirst({
      where: { orgId: org.id, name: NAME_TAG },
    });
    if (testActivity) {
      await db.match.deleteMany({ where: { activityId: testActivity.id } });
      await db.playerActivityPosition.deleteMany({ where: { activityId: testActivity.id } });
      await db.activity.delete({ where: { id: testActivity.id } });
      console.log(`Deleted test activity + matches.`);
    } else {
      console.log("No test activity to delete.");
    }
    await db.$disconnect();
    return;
  }

  // Use the existing Football 7-a-side sport
  const sport = await db.sport.findFirst({
    where: { orgId: org.id, preset: "football-7aside" },
  });
  if (!sport) throw new Error("football-7aside sport not found");

  // Create a dedicated test activity so this match is segregated from the
  // real Tuesday 7-a-side. Using isActive=false so it doesn't clutter any
  // active lists.
  const activity = await db.activity.upsert({
    where: { id: "test-rating-preview" },
    update: { isActive: false },
    create: {
      id: "test-rating-preview",
      orgId: org.id,
      sportId: sport.id,
      name: NAME_TAG,
      dayOfWeek: 1,
      time: "21:30",
      venue: "N/A",
      isActive: false,
      matchDurationMins: 60,
      ratingWindowHours: 120,
    },
  });

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(21, 30, 0, 0);

  // Clean any prior test match
  await db.match.deleteMany({ where: { activityId: activity.id } });

  const match = await db.match.create({
    data: {
      activityId: activity.id,
      date: yesterday,
      maxPlayers: 14,
      status: "COMPLETED",
      attendanceDeadline: new Date(yesterday.getTime() - 5 * 60 * 60 * 1000),
      redScore: 5,
      yellowScore: 3,
      postMatchEndFlow: false, // bot stays silent on this match
    },
  });

  // Pick 14 players: Kemal + 13 active roster
  const owner = await db.user.findUnique({ where: { email: OWNER_EMAIL } });
  if (!owner) throw new Error("Owner not found");

  const others = await db.user.findMany({
    where: {
      isActive: true,
      email: { not: OWNER_EMAIL },
      memberships: { some: { orgId: org.id } },
    },
    take: 13,
    orderBy: { name: "asc" },
  });
  const roster = [owner, ...others];
  if (roster.length < 14) throw new Error(`Only ${roster.length} roster members`);

  // Attendance + team assignment (alternating to balance)
  await db.$transaction(
    roster.flatMap((user, i) => [
      db.attendance.create({
        data: {
          matchId: match.id,
          userId: user.id,
          status: "CONFIRMED",
          position: i + 1,
        },
      }),
      db.teamAssignment.create({
        data: {
          matchId: match.id,
          userId: user.id,
          team: i % 2 === 0 ? "RED" : "YELLOW",
        },
      }),
    ]),
  );

  const url = `https://matchtime.ai/matches/${match.id}/rate`;
  console.log(`\n✅ Created test match with 14 players, score 5-3.`);
  console.log(`   Match id: ${match.id}`);
  console.log(`\n→ Open as Kemal: ${url}`);
  console.log(`\nTo clean up later: node --env-file=.env --import tsx scripts/create-test-match.ts --delete`);

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
