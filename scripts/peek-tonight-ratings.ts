/**
 * READ-ONLY. Show the CLUB ratings the balancer would use for a match's
 * confirmed squad.
 *
 *   npx tsx scripts/peek-tonight-ratings.ts [matchId]
 *
 * Reads exactly what `generateTeamsForMatch` reads: this club's seed
 * from `Membership`, this club's sixty most recent ratings for each
 * player, and this club's mean as the fallback prior. Until 2026-09-19
 * it read the global `User.seedRating` and every rating from every
 * club, so its answer could differ from the sheet the bot actually
 * posted, which is the opposite of what a peek script is for.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { computeClubRating } from "../src/lib/player-rating.ts";

const DEFAULT_MATCH_ID = "cmohvq0n5000004lf6bm8udzj";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  const matchId = process.argv[2] ?? DEFAULT_MATCH_ID;
  const match = await db.match.findUnique({
    where: { id: matchId },
    select: { id: true, date: true, activity: { select: { name: true, org: { select: { id: true, name: true } } } } },
  });
  if (!match) {
    console.error(`No match ${matchId}`);
    process.exit(1);
  }
  const orgId = match.activity.org.id;

  // One aggregate for the whole squad, not one per player: it is the
  // same number for all of them.
  const clubMean = await db.rating.aggregate({
    _avg: { score: true },
    where: { match: { activity: { orgId } } },
  });
  const clubMeanRating = clubMean._avg.score ?? null;

  const atts = await db.attendance.findMany({
    where: { matchId: match.id, status: "CONFIRMED" },
    include: { user: { select: { id: true, name: true } } },
  });
  const seedRows = await db.membership.findMany({
    where: { orgId, userId: { in: atts.map((a) => a.userId) } },
    select: { userId: true, seedRating: true },
  });
  const seedByUser = new Map(seedRows.map((m) => [m.userId, m.seedRating]));

  const rows: Array<{ name: string | null; rating: number; peerCount: number; source: string; seed: number | null }> = [];
  for (const a of atts) {
    const ratings = await db.rating.findMany({
      where: { playerId: a.userId, match: { activity: { orgId } } },
      orderBy: { createdAt: "desc" },
      take: 60,
      select: { score: true },
    });
    const seed = seedByUser.get(a.userId) ?? null;
    const r = computeClubRating({
      clubSeedRating: seed,
      clubPeerRatings: ratings.map((x) => x.score),
      clubMeanRating,
    });
    rows.push({ name: a.user.name, rating: r.rating, peerCount: r.peerCount, source: r.source, seed });
  }

  rows.sort((a, b) => b.rating - a.rating);
  console.log(
    `${match.activity.org.name} | ${match.activity.name} | ${match.date.toISOString()}\n` +
      `club mean: ${clubMeanRating === null ? "none" : clubMeanRating.toFixed(3)}\n` +
      `squad club ratings (high to low):`,
  );
  for (const r of rows) {
    console.log(
      `  ${r.rating.toFixed(2).padStart(5)}  ${(r.name ?? "?").padEnd(22)}  peerN=${String(r.peerCount).padStart(3)}  src=${r.source.padEnd(13)} seed=${r.seed ?? "-"}`,
    );
  }

  const total = rows.reduce((s, r) => s + r.rating, 0);
  console.log(`\nSquad mean: ${rows.length ? (total / rows.length).toFixed(2) : "n/a"}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => process.exit(0));
