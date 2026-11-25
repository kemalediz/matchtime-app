import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const GHOST_ID = "cmqx0xjk7000004kyrs9uslxn";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const m = await db.match.findUnique({
    where: { id: GHOST_ID },
    include: {
      activity: { include: { sport: true } },
      _count: {
        select: {
          attendances: true,
          teamAssignments: true,
          ratings: true,
          momVotes: true,
          sentNotifications: true,
          benchConfirmations: true,
          benchSlotOffers: true,
          ratingAdjustments: true,
          paymentCredits: true,
          tentativeAvailabilities: true,
        },
      },
    },
  });

  if (!m) {
    console.log("Ghost match not found — already deleted?");
    await db.$disconnect();
    return;
  }

  console.log("Target:", m.activity.name, m.date.toISOString(), "status=" + m.status);
  console.log("Related counts:", JSON.stringify(m._count, null, 2));

  // Safety: refuse if it has any attendances (would mean it's NOT the empty ghost).
  if (m._count.attendances > 0) {
    throw new Error(`Refusing: match has ${m._count.attendances} attendances — not the empty ghost.`);
  }

  // Clear FK-dependent rows that have no cascade, then delete the match.
  await db.$transaction([
    db.sentNotification.deleteMany({ where: { matchId: GHOST_ID } }),
    db.teamAssignment.deleteMany({ where: { matchId: GHOST_ID } }),
    db.rating.deleteMany({ where: { matchId: GHOST_ID } }),
    db.moMVote.deleteMany({ where: { matchId: GHOST_ID } }),
    db.pendingBenchConfirmation.deleteMany({ where: { matchId: GHOST_ID } }),
    db.benchSlotOffer.deleteMany({ where: { matchId: GHOST_ID } }),
    db.ratingAdjustment.deleteMany({ where: { matchId: GHOST_ID } }),
    db.paymentCredit.deleteMany({ where: { matchId: GHOST_ID } }),
    db.tentativeAvailability.deleteMany({ where: { matchId: GHOST_ID } }),
    db.match.delete({ where: { id: GHOST_ID } }),
  ]);

  console.log("Deleted ghost match", GHOST_ID);
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
