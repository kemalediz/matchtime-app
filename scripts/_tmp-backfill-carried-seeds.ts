/**
 * CARRIED SEEDS BACKFILL (Kemal, 2026-11-03): give every existing
 * membership that has no seed the seed its player carries from his other
 * clubs, the same rule new joins now get (`src/lib/carried-seed.ts`).
 *
 *   node --env-file=.env --import tsx scripts/_tmp-backfill-carried-seeds.ts            (dry run)
 *   node --env-file=.env --import tsx scripts/_tmp-backfill-carried-seeds.ts --apply    (writes)
 *
 * DRY RUN IS THE DEFAULT and only reads. It prints, per club, one line
 * per membership it would seed: membership id, user id, the seed, the
 * club ids it was averaged from, and whether the member has left or is a
 * guest. Then a count per club.
 *
 * --apply writes only where the seed is STILL null at the moment of
 * writing (`updateMany where seedRating IS NULL`), so a seed an admin
 * typed between the dry run and the apply is never overwritten.
 * Any other argument is refused. No model calls, no messages sent.
 */
import { db } from "../src/lib/db";
import { planCarriedSeeds } from "../src/lib/carried-seed";
import { loadClubRatingsByClub, type CarriedSeedClient } from "../src/lib/carried-seed-loader";

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--apply");
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(" ")}`);
  const apply = args.includes("--apply");

  const memberships = await db.membership.findMany({
    where: { seedRating: null },
    select: { id: true, orgId: true, userId: true, seedRating: true, leftAt: true, guestMatchId: true },
    orderBy: [{ orgId: "asc" }, { createdAt: "asc" }],
  });
  const ratings = await loadClubRatingsByClub(db as unknown as CarriedSeedClient, [...new Set(memberships.map((m) => m.userId))]);
  const plan = planCarriedSeeds(memberships, ratings);
  const byId = new Map(memberships.map((m) => [m.id, m]));

  console.log(`${apply ? "APPLY" : "DRY RUN"}: ${memberships.length} memberships with no seed, ${plan.length} would carry one.\n`);
  const perClub = new Map<string, number>();
  let current = "";
  for (const p of plan) {
    if (p.orgId !== current) {
      current = p.orgId;
      console.log(`club ${p.orgId}`);
    }
    const m = byId.get(p.membershipId)!;
    const state = [m.leftAt ? "left" : null, m.guestMatchId ? "guest" : null].filter(Boolean).join(",") || "member";
    console.log(`  ${p.membershipId}  user ${p.userId}  seed ${p.seed}  from ${p.fromOrgIds.join(" ")}  (${state})`);
    perClub.set(p.orgId, (perClub.get(p.orgId) ?? 0) + 1);
  }
  console.log("\ncount per club:");
  for (const [orgId, n] of perClub) console.log(`  ${orgId}  ${n}`);

  if (!apply) {
    console.log("\nNothing written. Re-run with --apply to write.");
    return;
  }
  let written = 0;
  for (const p of plan) {
    const { count } = await db.membership.updateMany({ where: { id: p.membershipId, seedRating: null }, data: { seedRating: p.seed } });
    written += count;
  }
  console.log(`\nWrote ${written} of ${plan.length} (the rest had been seeded meanwhile).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
