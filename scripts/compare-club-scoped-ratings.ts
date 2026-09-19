/**
 * READ-ONLY. What slice 2 does to a live club, measured rather than
 * asserted.
 *
 *   npx tsx scripts/compare-club-scoped-ratings.ts [matchId]
 *
 * Sibling of `compare-rating-formulas.ts`, which answered the previous
 * question (blended vs the deleted elo-mix). This one answers slice 2's
 * question, from `MDs/club-scoped-ratings-design-2026-09-18.md`:
 *
 *   BEFORE  the global blend (`User.seedRating`, the player's 60 most
 *           recent ratings FROM ANY CLUB)`, the global window.
 *   AFTER   `computeClubRating(Membership.seedRating for this org, the
 *           player's 60 most recent ratings FROM THIS ORG, the mean of
 *           every rating given in this org)`.
 *
 * WRITES NOTHING. It never calls `generateTeamsForMatch` (that writes
 * TeamAssignment rows, flips Match.status and upserts RatingAdjustment);
 * it reads the same rows that function reads and runs the same PURE
 * balancer over two different rating vectors. The LLM rating adjuster
 * is deliberately not run: it is the same margin on top of either
 * vector, and running it would spend a model call and write rows.
 *
 * ── THE HILL-CLIMB IS RANDOM, SO ONE RUN PROVES NOTHING ──────────────
 *
 * `balancePositionAware`, the strategy Sutton actually uses, ends
 * with a 1,000-iteration hill-climb that picks its candidate swaps with
 * `Math.random()`. Two runs of the SAME vector over the SAME squad can
 * return different sheets. So each vector is run TRIALS times and what
 * is compared is the MODAL partition, alongside each vector's own
 * SELF-DISAGREEMENT RATE, which is the noise floor any "who moves"
 * claim has to clear. The deterministic half of the comparison is the
 * DRAFT ORDER, and that is where a rating change actually shows up.
 *
 * Two passes are printed:
 *   1. CLUB-WIDE: every rated member of the org, which is the table
 *      the club's admins need, and the check on design section 3.5.
 *   2. THIS MATCH: the confirmed squad, its draft order, and the
 *      modal sheet under each vector.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { balanceTeams, type BalancingStrategy } from "../src/lib/team-balancer.ts";
import { computeClubRating } from "../src/lib/player-rating.ts";
import type { PlayerWithRating } from "../src/types/index.ts";

/** How many times each vector is balanced, to find its modal sheet. */
const TRIALS = 401;

/** A partition is colour-blind: {A,B} vs {C,D} is the same split
 *  however the shirts fall. Key on the side whose first name sorts
 *  first, so the two orderings collapse to one string. */
function partitionKey(result: { red: PlayerWithRating[]; yellow: PlayerWithRating[] }) {
  const a = result.red.map((p) => p.name).sort();
  const b = result.yellow.map((p) => p.name).sort();
  const [x, y] = a[0] < b[0] ? [a, b] : [b, a];
  return `${x.join(", ")}  |  ${y.join(", ")}`;
}

function modal(keys: string[]): { key: string; count: number } {
  const tally = new Map<string, number>();
  for (const k of keys) tally.set(k, (tally.get(k) ?? 0) + 1);
  let best = { key: "", count: 0 };
  for (const [key, count] of tally) if (count > best.count) best = { key, count };
  return best;
}

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
} as never as ConstructorParameters<typeof PrismaClient>[0]);

/** Both numbers for one player at one club. */
async function bothRatings(userId: string, orgId: string, clubMeanRating: number | null) {
  // The org of every row is selected, not inferred by subtraction: a
  // player with 60 rows in BOTH windows would otherwise report zero
  // foreign ratings while his global window was full of them. That is
  // Ehtisham's exact case and it is the amplifier the design names.
  const globalRows = await db.rating.findMany({
    where: { playerId: userId },
    orderBy: { createdAt: "desc" },
    take: 60,
    select: { score: true, match: { select: { activity: { select: { orgId: true } } } } },
  });
  const clubRows = await db.rating.findMany({
    where: { playerId: userId, match: { activity: { orgId } } },
    orderBy: { createdAt: "desc" },
    take: 60,
    select: { score: true },
  });
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { seedRating: true },
  });
  const membership = await db.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
    select: { seedRating: true },
  });
  // The OLD global number. `computePlayerRating` was deleted on
  // 2026-09-19 once the dashboard tile stopped calling it, and the same
  // arithmetic is reached by handing `computeClubRating` the inputs the
  // global formula used: the global seed and a rating window drawn from
  // every club. `clubMeanRating: null` restores the old hardcoded 5.0
  // fallback. This is what the shim did, and `club-rating.test.ts`
  // still pins the two against each other.
  const before = computeClubRating({
    clubSeedRating: user?.seedRating ?? null,
    clubPeerRatings: globalRows.map((r) => r.score),
    clubMeanRating: null,
  });
  const after = computeClubRating({
    clubSeedRating: membership?.seedRating ?? null,
    clubPeerRatings: clubRows.map((r) => r.score),
    clubMeanRating,
  });
  return {
    before: before.rating,
    after: after.rating,
    source: after.source,
    globalPeers: globalRows.length,
    clubPeers: clubRows.length,
    /** Ratings from ANOTHER club sitting inside the old global window. */
    foreignPeers: globalRows.filter((r) => r.match.activity.orgId !== orgId).length,
    /** This club's own ratings EVICTED from the old global window by
     *  those foreign rows. Nonzero means the old number was not just
     *  diluted, it was missing the player's own scores. */
    evicted: Math.max(0, clubRows.length - globalRows.filter((r) => r.match.activity.orgId === orgId).length),
    userSeed: user?.seedRating ?? null,
    clubSeed: membership?.seedRating ?? null,
  };
}

function ranks<T extends { id: string }>(rows: T[], pick: (r: T) => number) {
  return new Map(
    [...rows].sort((a, b) => pick(b) - pick(a)).map((r, i) => [r.id, i + 1] as [string, number]),
  );
}

async function main() {
  const argMatchId = process.argv[2];
  const include = {
    activity: { include: { sport: true, org: true } },
    attendances: {
      where: { status: "CONFIRMED" as const },
      include: { user: { include: { activityPositions: true } } },
    },
  };
  const match = argMatchId
    ? await db.match.findUnique({ where: { id: argMatchId }, include })
    : await db.match.findFirst({
        where: {
          status: { notIn: ["CANCELLED", "COMPLETED"] },
          attendances: { some: { status: "CONFIRMED" } },
        },
        orderBy: { date: "asc" },
        include,
      });

  if (!match) {
    console.log("No candidate match found.");
    await db.$disconnect();
    return;
  }

  const orgId = match.activity.org.id;
  const orgName = match.activity.org.name;
  const agg = await db.rating.aggregate({
    _avg: { score: true },
    _count: true,
    where: { match: { activity: { orgId } } },
  });
  const clubMeanRating = agg._avg.score ?? null;

  console.log(
    `${orgName}  (org ${orgId})\n` +
      `club mean rating ${clubMeanRating?.toFixed(3) ?? "none"} over ${agg._count} ratings\n`,
  );

  // ── PASS 1: every rated member of the club ─────────────────────────

  const memberships = await db.membership.findMany({
    where: { orgId, leftAt: null },
    select: { userId: true, user: { select: { name: true } } },
  });
  const clubRatedIds = new Set(
    (
      await db.rating.findMany({
        where: { match: { activity: { orgId } } },
        select: { playerId: true },
        distinct: ["playerId"],
      })
    ).map((r) => r.playerId),
  );

  const clubRows: {
    id: string;
    name: string;
    before: number;
    after: number;
    clubPeers: number;
    foreignPeers: number;
    evicted: number;
    userSeed: number | null;
    clubSeed: number | null;
    source: string;
  }[] = [];
  for (const m of memberships) {
    if (!clubRatedIds.has(m.userId)) continue;
    const r = await bothRatings(m.userId, orgId, clubMeanRating);
    clubRows.push({ id: m.userId, name: m.user.name ?? "Unknown", ...r });
  }

  const beforeRank = ranks(clubRows, (r) => r.before);
  const afterRank = ranks(clubRows, (r) => r.after);
  const movers = clubRows.filter((r) => Math.abs(r.after - r.before) >= 0.0005);

  console.log(
    `── PASS 1: every rated, still-present member of ${orgName} ──\n` +
      `${clubRows.length} rated members; ${movers.length} change by 0.001 or more\n`,
  );
  console.log(
    "player                 seed(u) seed(m) club foreign evict   today  club-only    delta  rank",
  );
  for (const r of [...clubRows].sort((a, b) => b.after - a.after)) {
    const d = r.after - r.before;
    const from = beforeRank.get(r.id)!;
    const to = afterRank.get(r.id)!;
    console.log(
      `${r.name.padEnd(22)} ${String(r.userSeed ?? "-").padStart(7)} ${String(r.clubSeed ?? "-").padStart(7)} ` +
        `${String(r.clubPeers).padStart(4)} ${String(r.foreignPeers).padStart(7)} ${String(r.evicted).padStart(5)} ` +
        `${r.before.toFixed(3).padStart(7)} ${r.after.toFixed(3).padStart(10)} ` +
        `${(d >= 0 ? "+" : "") + d.toFixed(3)}`.padStart(9) +
        `  ${from === to ? "=" : `${from} to ${to}`}`,
    );
  }

  console.log(`\nMOVERS ONLY (${movers.length}):`);
  for (const r of [...movers].sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before))) {
    const d = r.after - r.before;
    console.log(
      `  ${r.name.padEnd(22)} ${r.before.toFixed(3)} to ${r.after.toFixed(3)}  ` +
        `(${d >= 0 ? "+" : ""}${d.toFixed(3)})  ` +
        `club ${r.clubPeers}, foreign ${r.foreignPeers}, own rows evicted ${r.evicted}  ` +
        `draft ${beforeRank.get(r.id)} to ${afterRank.get(r.id)}`,
    );
  }

  // Does the new PRIOR change anything on its own, separately from the
  // window? Only for a member with no club seed.
  const unseeded = clubRows.filter((r) => r.clubSeed === null);
  console.log(
    `\nprior check: ${unseeded.length} of ${clubRows.length} rated members have NO club seed, ` +
      `so the club-mean prior is what they get. ` +
      `${clubRows.filter((r) => r.clubSeed !== r.userSeed).length} carry a club seed that differs from the old global one.`,
  );

  // ── PASS 2: this match's squad ─────────────────────────────────────

  const sport = match.activity.sport;
  const perTeam = sport.playersPerTeam;
  console.log(
    `\n── PASS 2: the next fixture ──\n` +
      `${match.activity.name}, ${match.date.toISOString()}\n` +
      `match ${match.id}  status=${match.status}  ${sport.name} ${perTeam}v${perTeam}  ` +
      `strategy=${sport.balancingStrategy}\n` +
      `confirmed: ${match.attendances.length} (balancer takes the first ${perTeam * 2})\n`,
  );

  const rows = await Promise.all(
    match.attendances.map(async (a) => {
      const r = await bothRatings(a.userId, orgId, clubMeanRating);
      const pap = a.user.activityPositions.find((p) => p.activityId === match.activityId);
      return {
        id: a.userId,
        name: a.user.name ?? "Unknown",
        positions: pap?.positions ?? [],
        image: a.user.image,
        ...r,
      };
    }),
  );

  console.log("player                 club foreign evict   today  club-only    delta");
  for (const r of [...rows].sort((a, b) => b.after - a.after)) {
    const d = r.after - r.before;
    console.log(
      `${r.name.padEnd(22)} ${String(r.clubPeers).padStart(4)} ${String(r.foreignPeers).padStart(7)} ${String(r.evicted).padStart(5)} ` +
        `${r.before.toFixed(3).padStart(7)} ${r.after.toFixed(3).padStart(10)} ` +
        `${((d >= 0 ? "+" : "") + d.toFixed(3)).padStart(9)}`,
    );
  }

  const sqBefore = ranks(rows, (r) => r.before);
  const sqAfter = ranks(rows, (r) => r.after);
  console.log("\ndraft order (deterministic: this is what the rating decides)");
  console.log("player                 today  club-only   move");
  for (const r of [...rows].sort((a, b) => sqAfter.get(a.id)! - sqAfter.get(b.id)!)) {
    const from = sqBefore.get(r.id)!;
    const to = sqAfter.get(r.id)!;
    console.log(
      `${r.name.padEnd(22)} ${String(from).padStart(5)} ${String(to).padStart(10)}   ` +
        `${from === to ? "no change" : `${from} to ${to} (${to < from ? "+" : ""}${from - to})`}`,
    );
  }

  const composition = sport.positionComposition as Record<string, number> | null;
  const opts = {
    perTeam,
    strategy: sport.balancingStrategy as BalancingStrategy,
    composition: composition ?? undefined,
  };

  const run = (pick: (r: (typeof rows)[number]) => number) => {
    const keys: string[] = [];
    let diffSum = 0;
    for (let i = 0; i < TRIALS; i++) {
      const result = balanceTeams({
        ...opts,
        players: rows.map((r) => ({ ...r, rating: pick(r) })) as PlayerWithRating[],
      });
      keys.push(partitionKey(result));
      diffSum += result.ratingDiff;
    }
    const m = modal(keys);
    return {
      key: m.key,
      share: m.count / TRIALS,
      // Self-disagreement: how often the SAME vector fails to return
      // its own modal sheet. This is the noise floor.
      selfDisagreement: 1 - m.count / TRIALS,
      distinct: new Set(keys).size,
      avgDiff: diffSum / TRIALS,
    };
  };

  const beforeRun = run((r) => r.before);
  const afterRun = run((r) => r.after);

  const show = (label: string, r: ReturnType<typeof run>) => {
    const [x, y] = r.key.split("  |  ");
    console.log(
      `\n── ${label} ──\n` +
        `modal sheet hit ${(r.share * 100).toFixed(1)}% of ${TRIALS} runs; ` +
        `self-disagreement ${(r.selfDisagreement * 100).toFixed(1)}%; ` +
        `${r.distinct} distinct sheets seen; mean rating diff ${r.avgDiff.toFixed(3)}\n` +
        `  ${x}\n  vs\n  ${y}`,
    );
  };
  show("TODAY   global window, User.seedRating", beforeRun);
  show("AFTER   club window, Membership.seedRating, club-mean prior", afterRun);

  const sideOf = (key: string) => {
    const [x, y] = key.split("  |  ");
    const map = new Map<string, "A" | "B">();
    for (const n of x.split(", ")) map.set(n, "A");
    for (const n of y.split(", ")) map.set(n, "B");
    return map;
  };
  const a = sideOf(afterRun.key);
  const b = sideOf(beforeRun.key);
  const anchor = afterRun.key.split("  |  ")[0].split(", ")[0];
  const together = (m: Map<string, "A" | "B">, n: string) => m.get(n) === m.get(anchor);
  const sheetMovers = rows
    .map((r) => r.name)
    .filter((n) => b.has(n) && a.has(n) && n !== anchor && together(a, n) !== together(b, n));

  console.log(
    `\nSHEET MOVERS (relative to ${anchor}): ${
      sheetMovers.length === 0
        ? "nobody, the modal sheet is the same under both vectors"
        : sheetMovers
            .map((n) => `${n} ${together(b, n) ? "with" : "against"} to ${together(a, n) ? "with" : "against"}`)
            .join("; ")
    }`,
  );
  console.log(
    `NOISE FLOOR: the modal sheets above are only different if the difference clears ` +
      `${(Math.max(beforeRun.selfDisagreement, afterRun.selfDisagreement) * 100).toFixed(1)}% self-disagreement.`,
  );

  await db.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
