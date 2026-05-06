/** Show blended ratings for tonight's confirmed squad. */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { computePlayerRating } from "../src/lib/player-rating.ts";

const MATCH_ID = "cmohvq0n5000004lf6bm8udzj";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  const atts = await db.attendance.findMany({
    where: { matchId: MATCH_ID, status: "CONFIRMED" },
    include: { user: { select: { id: true, name: true, seedRating: true } } },
  });

  const rows: Array<{ name: string | null; rating: number; peerCount: number; source: string; seed: number | null }> = [];
  for (const a of atts) {
    const ratings = await db.rating.findMany({
      where: { playerId: a.userId },
      select: { score: true },
    });
    const r = computePlayerRating({ seedRating: a.user.seedRating, peerRatings: ratings.map((x) => x.score) });
    rows.push({
      name: a.user.name,
      rating: r.rating,
      peerCount: r.peerCount,
      source: r.source,
      seed: a.user.seedRating,
    });
  }
  rows.sort((a, b) => b.rating - a.rating);
  console.log("Tonight's squad — blended ratings (high→low):");
  for (const r of rows) {
    console.log(
      `  ${r.rating.toFixed(2).padStart(5)}  ${(r.name ?? "?").padEnd(22)}  peerN=${String(r.peerCount).padStart(3)}  src=${r.source.padEnd(8)} seed=${r.seed ?? "-"}`,
    );
  }

  const total = rows.reduce((s, r) => s + r.rating, 0);
  console.log(`\nSquad mean: ${(total / rows.length).toFixed(2)}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => process.exit(0));
