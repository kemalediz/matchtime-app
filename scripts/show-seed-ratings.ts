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
 * Show each player's effective rating as the balancer saw it, so we
 * can diagnose why Yellow came out strong.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const m = await db.match.findFirst({
    where: { status: { in: ["TEAMS_GENERATED", "TEAMS_PUBLISHED"] } },
    include: {
      teamAssignments: { include: { user: { select: { id: true, name: true, seedRating: true, matchRating: true } } } },
    },
    orderBy: { date: "desc" },
  });
  if (!m) { console.log("no team-generated match"); return; }

  // Compute effective rating for each player (same as team-generation.ts)
  const rows = await Promise.all(
    m.teamAssignments.map(async (t) => {
      const ratings = await db.rating.findMany({
        where: { playerId: t.userId },
        orderBy: { createdAt: "desc" },
        take: 60,
      });
      const effective =
        ratings.length >= 3
          ? ratings.reduce((s, r) => s + r.score, 0) / ratings.length
          : t.user.seedRating ?? 5.0;
      return {
        name: t.user.name ?? "?",
        team: t.team,
        seed: t.user.seedRating,
        peerCount: ratings.length,
        effective,
        elo: t.user.matchRating,
      };
    }),
  );

  const red = rows.filter((r) => r.team === "RED").sort((a, b) => b.effective - a.effective);
  const yellow = rows.filter((r) => r.team === "YELLOW").sort((a, b) => b.effective - a.effective);

  const sum = (arr: typeof red) => arr.reduce((s, r) => s + r.effective, 0);
  console.log(`\nRED   (sum=${sum(red).toFixed(1)}):`);
  for (const r of red)
    console.log(`  ${r.effective.toFixed(1)}  seed=${r.seed ?? "-"}  peer=${r.peerCount}  elo=${r.elo}  ${r.name}`);
  console.log(`\nYELLOW (sum=${sum(yellow).toFixed(1)}):`);
  for (const r of yellow)
    console.log(`  ${r.effective.toFixed(1)}  seed=${r.seed ?? "-"}  peer=${r.peerCount}  elo=${r.elo}  ${r.name}`);
  console.log(`\nDiff: ${Math.abs(sum(red) - sum(yellow)).toFixed(2)}`);

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
