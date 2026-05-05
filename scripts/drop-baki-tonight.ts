/**
 * Manual fix: Baki messaged "I can't come today, I am out" but the
 * analyzer's reply text claimed "Aydın moves up" without actually
 * dropping Baki or asking Aydın. DB still has Baki as CONFIRMED.
 * Run cancelAttendance() the proper way so Baki goes DROPPED and the
 * bench-confirmation DM fires to Aydın (first bench).
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { cancelAttendance } from "../src/lib/attendance.ts";

const MATCH_ID = "cmohvq0n5000004lf6bm8udzj";
const BAKI_USER_ID = "cmo4wnnkt0005mvr8vrxko4ck"; // from earlier peek

async function main() {
  // Verify Baki via the canonical Prisma client first.
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  const before = await db.attendance.findUnique({
    where: { matchId_userId: { matchId: MATCH_ID, userId: BAKI_USER_ID } },
    include: { user: { select: { name: true } } },
  });
  console.log("Before:", before?.user.name, "status=", before?.status);

  // cancelAttendance throws if status is already DROPPED — guard.
  if (!before) {
    console.error("Baki has no attendance row for this match");
    process.exit(1);
  }
  if (before.status === "DROPPED") {
    console.log("Already DROPPED — nothing to do.");
    return;
  }

  await cancelAttendance(BAKI_USER_ID, MATCH_ID);

  const after = await db.attendance.findUnique({
    where: { matchId_userId: { matchId: MATCH_ID, userId: BAKI_USER_ID } },
  });
  console.log("After:", "status=", after?.status);

  // Verify the bench-confirmation row was created for Aydın.
  const pending = await db.pendingBenchConfirmation.findFirst({
    where: { matchId: MATCH_ID, resolvedAt: null },
    include: { match: true },
    orderBy: { createdAt: "desc" },
  });
  if (pending) {
    const aydın = await db.user.findUnique({
      where: { id: pending.userId },
      select: { name: true },
    });
    console.log(
      `Bench-confirmation queued for ${aydın?.name} (replacing user ${pending.replacingUserId}, expires ${pending.expiresAt.toISOString()})`,
    );
  } else {
    console.warn("No pending bench-confirmation found — investigate");
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => process.exit(0));
