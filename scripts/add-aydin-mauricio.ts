/**
 * SPENT, AND NO LONGER RUNNABLE. This script reads or writes
 * `User.seedRating` / `User.matchRating`, and both columns were DROPPED
 * on 2026-09-19 (slice 7 of
 * MDs/club-scoped-ratings-design-2026-09-18.md). It will throw.
 *
 * Kept as a record of what was done, not as something to re-run or copy.
 * The seed and the Elo are per club now: `Membership.seedRating`, and
 * `src/lib/membership-elo.ts` for the Elo, which needs the match's org.
 */
/**
 * Add Aydın as a new player (not in original seed roster) and record
 * both Aydın and Mauricio as CONFIRMED for the next upcoming match.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const ORG_SLUG = "sutton-fc";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const org = await db.organisation.findUnique({ where: { slug: ORG_SLUG } });
  if (!org) throw new Error(`Org ${ORG_SLUG} not found`);

  // Upsert Aydın
  let aydin = await db.user.findUnique({ where: { email: "aydin@matchday.local" } });
  if (!aydin) {
    aydin = await db.user.create({
      data: {
        email: "aydin@matchday.local",
        name: "Aydın",
        seedRating: 6.0,
        isActive: true,
        onboarded: true,
      },
    });
    console.log(`Created new user: Aydın (${aydin.id})`);
  } else {
    console.log(`Aydın already exists (${aydin.id})`);
  }
  // Ensure membership
  await db.membership.upsert({
    where: { userId_orgId: { userId: aydin.id, orgId: org.id } },
    create: { userId: aydin.id, orgId: org.id, role: "PLAYER" },
    update: {},
  });

  // Seed default football positions for Aydın so the balancer has something
  // to work with until admin updates them.
  const football7 = await db.activity.findFirst({
    where: { orgId: org.id, isActive: true },
    orderBy: { createdAt: "asc" },
  });
  if (football7) {
    await db.playerActivityPosition.upsert({
      where: { userId_activityId: { userId: aydin.id, activityId: football7.id } },
      create: { userId: aydin.id, activityId: football7.id, positions: ["MID"] },
      update: {},
    });
  }

  // Find the target match
  const match = await db.match.findFirst({
    where: {
      activity: { orgId: org.id },
      date: { gte: new Date() },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
    },
    orderBy: { date: "asc" },
  });
  if (!match) throw new Error("No upcoming match found");

  const mauricio = await db.user.findUnique({ where: { email: "mauricio@matchday.local" } });
  if (!mauricio) throw new Error("Mauricio not found in DB");

  // Get max existing position
  const maxPosAgg = await db.attendance.aggregate({
    where: { matchId: match.id },
    _max: { position: true },
  });
  let pos = (maxPosAgg._max.position ?? 0) + 1;

  for (const u of [aydin, mauricio]) {
    const confirmedCount = await db.attendance.count({
      where: { matchId: match.id, status: "CONFIRMED" },
    });
    const status = confirmedCount < match.maxPlayers ? "CONFIRMED" : "BENCH";
    await db.attendance.upsert({
      where: { matchId_userId: { matchId: match.id, userId: u.id } },
      create: { matchId: match.id, userId: u.id, status, position: pos++ },
      update: { status, position: pos++, respondedAt: new Date() },
    });
    console.log(`  ✓  ${u.name} → ${status}`);
  }

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
