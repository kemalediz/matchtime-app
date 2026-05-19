/**
 * 2026-05-19: "@Match Time swap Elvin with Abid please, then post the
 * teams again" was a TEAM swap. The bot misread it as an attendance
 * swap → dropped Elvin, opened a bench offer (Burak/Ehtisham tagged),
 * left teams inconsistent (Elvin DROPPED but still RED).
 *
 * Remediate:
 *  1. Elvin DROPPED → CONFIRMED (he never dropped).
 *  2. Resolve the bogus open BenchSlotOffer (replacing Elvin) so the
 *     bench flow stops.
 *  3. Do the swap he actually asked for: Elvin ↔ Abid swap teams.
 *  4. Re-arm + fire nothing automatically; we post a clean corrected
 *     teams message from MatchTime instead.
 *
 * Dry-run by default; --apply to act.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const APPLY = process.argv.includes("--apply");

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const m = await db.match.findFirst({
    where: { status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] } },
    orderBy: { date: "asc" },
    include: {
      activity: { include: { sport: { select: { teamLabels: true } }, select: { orgId: true, name: true, sport: true } } },
      teamAssignments: { include: { user: { select: { id: true, name: true } } } },
    },
  });
  if (!m) { console.error("no match"); process.exit(1); }
  const orgId = m.activity.orgId;
  const labels = (m.activity.sport.teamLabels as string[]) ?? ["Red", "Yellow"];

  const elvin = await db.user.findFirst({ where: { name: { equals: "Elvin", mode: "insensitive" } }, select: { id: true, name: true } });
  const abid = await db.user.findFirst({ where: { name: { contains: "Abid", mode: "insensitive" } }, select: { id: true, name: true } });
  if (!elvin || !abid) { console.error("Elvin/Abid not found"); process.exit(1); }

  const elvinTA = m.teamAssignments.find((t) => t.userId === elvin.id);
  const abidTA = m.teamAssignments.find((t) => t.userId === abid.id);
  const openOffers = await db.benchSlotOffer.findMany({
    where: { matchId: m.id, resolvedAt: null },
  });

  console.log("Plan:");
  console.log(`  1. Elvin: DROPPED → CONFIRMED`);
  console.log(`  2. Resolve ${openOffers.length} open bench offer(s) (bogus, replacing Elvin)`);
  console.log(`  3. Team swap: Elvin ${elvinTA?.team} → ${abidTA?.team}, Abid ${abidTA?.team} → ${elvinTA?.team}`);

  if (!APPLY) { console.log("\n(dry-run — pass --apply)"); await db.$disconnect(); return; }

  // 1. Restore Elvin.
  await db.attendance.update({
    where: { matchId_userId: { matchId: m.id, userId: elvin.id } },
    data: { status: "CONFIRMED" },
  });
  // 2. Kill the bogus offer(s).
  await db.benchSlotOffer.updateMany({
    where: { matchId: m.id, resolvedAt: null },
    data: { resolvedAt: new Date(), outcome: "cancelled-misclassification" },
  });
  // 3. Swap teams (only if both had assignments).
  if (elvinTA && abidTA) {
    await db.$transaction([
      db.teamAssignment.update({ where: { matchId_userId: { matchId: m.id, userId: elvin.id } }, data: { team: abidTA.team } }),
      db.teamAssignment.update({ where: { matchId_userId: { matchId: m.id, userId: abid.id } }, data: { team: elvinTA.team } }),
    ]);
  }

  // Build corrected teams post.
  const fresh = await db.match.findUnique({
    where: { id: m.id },
    include: { teamAssignments: { include: { user: { select: { name: true } } } } },
  });
  const red = fresh!.teamAssignments.filter((t) => t.team === "RED").map((t) => t.user.name);
  const yel = fresh!.teamAssignments.filter((t) => t.team === "YELLOW").map((t) => t.user.name);
  const text =
    `🔁 Done — swapped *${elvin.name}* and *${abid.name}*. Nobody dropped; updated teams:\n\n` +
    `*${labels[0]}*\n${red.map((n, i) => `${i + 1}. ${n}`).join("\n")}\n\n` +
    `*${labels[1]}*\n${yel.map((n, i) => `${i + 1}. ${n}`).join("\n")}`;
  const job = await db.botJob.create({ data: { orgId, kind: "group", text } });
  console.log(`\nQueued corrected-teams BotJob ${job.id}`);
  console.log("---\n" + text);

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
