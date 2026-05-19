/**
 * 2026-05-19 incident remediation (live, match tonight):
 *  1. Close the 2 stale open RosterSurveys (Apr 29 / Apr 30) — they
 *     never got closed and are still capturing every DM a month
 *     later, which is what spammed Karahan with "unclear"
 *     clarifications.
 *  2. Undo the wrongful overnight bench-drops: Ehtisham / Karahan /
 *     Enayem were DROPPED only because their 2h bench windows expired
 *     at 23:24 / 01:24 / 03:24 while everyone slept. Restore them.
 *  3. Karahan explicitly said "I can play" (group + DM) and the squad
 *     is 12/14 — put him straight into the confirmed squad. The
 *     others go back to BENCH (standby), not dropped.
 *
 * Dry-run by default; pass --apply.
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
    include: { activity: { select: { orgId: true } } },
  });
  if (!m) { console.error("no match"); process.exit(1); }
  const orgId = m.activity.orgId;

  const byName = async (n: string) =>
    db.user.findFirst({ where: { name: { contains: n, mode: "insensitive" } }, select: { id: true, name: true } });
  const karahan = await byName("Karahan");
  const ehtisham = await byName("Ehtisham");
  const enayem = await byName("Enayem");

  const staleSurveys = await db.rosterSurvey.findMany({
    where: { orgId, status: "open" },
    select: { id: true, createdAt: true },
  });

  const confirmedCount = await db.attendance.count({
    where: { matchId: m.id, status: "CONFIRMED" },
  });

  console.log("Plan:");
  console.log(`  1. Close ${staleSurveys.length} stale open RosterSurvey(s): ${staleSurveys.map((s) => s.id).join(", ")}`);
  console.log(`  2. Karahan (${karahan?.name}) DROPPED → CONFIRMED (wants to play; squad ${confirmedCount}/14)`);
  console.log(`  3. Ehtisham (${ehtisham?.name}) DROPPED → BENCH (restore standby)`);
  console.log(`  4. Enayem (${enayem?.name}) DROPPED → BENCH (restore standby)`);
  console.log(`  (Burak stays BENCH; expired PBCs left resolved — code fix stops re-dropping)`);

  if (!APPLY) { console.log("\n(dry-run — pass --apply)"); await db.$disconnect(); return; }

  await db.rosterSurvey.updateMany({
    where: { orgId, status: "open" },
    data: { status: "closed", closedAt: new Date() },
  });
  console.log(`Closed ${staleSurveys.length} stale survey(s).`);

  if (karahan) {
    await db.attendance.update({
      where: { matchId_userId: { matchId: m.id, userId: karahan.id } },
      data: { status: "CONFIRMED" },
    });
    console.log("Karahan → CONFIRMED");
  }
  for (const u of [ehtisham, enayem]) {
    if (!u) continue;
    await db.attendance.update({
      where: { matchId_userId: { matchId: m.id, userId: u.id } },
      data: { status: "BENCH" },
    });
    console.log(`${u.name} → BENCH`);
  }

  // Resolve any lingering open PBCs for this match so the (still-buggy
  // until deploy) sweeper can't re-drop anyone before the code fix
  // lands.
  await db.pendingBenchConfirmation.updateMany({
    where: { matchId: m.id, resolvedAt: null },
    data: { resolvedAt: new Date(), outcome: "expired" },
  });

  const after = await db.match.findUnique({
    where: { id: m.id },
    include: { attendances: { include: { user: { select: { name: true } } }, orderBy: { position: "asc" } } },
  });
  const c = after!.attendances.filter((a) => a.status === "CONFIRMED");
  const b = after!.attendances.filter((a) => a.status === "BENCH");
  console.log(`\nAfter — CONFIRMED ${c.length}/14: ${c.map((a) => a.user.name).join(", ")}`);
  console.log(`BENCH: ${b.map((a) => a.user.name).join(", ") || "(none)"}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
