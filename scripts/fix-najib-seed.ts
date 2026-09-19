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
 * Correct Najib's seed rating.
 *
 * Initial rebuild labelled him "Bench/occasional" at 5.5 — based on a
 * misreading of the chat analysis. In this group, "bench" means someone
 * who signed up late and didn't get a confirmed slot (not a weaker
 * player). Najib has 332 chat mentions and appears in lineups from
 * June 2023 through April 2026 — he's a core regular. Bumping to 6.0
 * (solid regular, no MoM win yet).
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const user = await db.user.findUnique({ where: { email: "najib@matchday.local" } });
  if (!user) throw new Error("Najib not found");

  const before = user.seedRating;
  await db.user.update({
    where: { id: user.id },
    data: { seedRating: 6.0 },
  });
  console.log(`  fixed  Najib  ${before} → 6.0  (core regular, 332 chat mentions over 2+ years)`);

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
