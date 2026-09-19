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
 * READ-ONLY. Prints the line-up each of the two rating formulas would
 * pick for a live squad, side by side, and names who moves.
 *
 *   npx tsx scripts/compare-rating-formulas.ts [matchId]
 *
 * With no argument it picks the org's next non-cancelled match that has
 * a confirmed squad, newest first.
 *
 * WRITES NOTHING. It never calls `generateTeamsForMatch` (that writes
 * TeamAssignment rows, flips Match.status and upserts RatingAdjustment);
 * it reads the same rows that function reads and runs the same PURE
 * balancer over two different rating vectors.
 *
 * The two vectors:
 *
 *   blended  the global blend: (sumPeer + seed x 3) / (peerCount + 3).
 *            The formula `lib/team-generation.ts` has always used, i.e.
 *            what the WhatsApp "generate the teams" request produces.
 *            Elo is not consulted.
 *   elo-mix  the formula that used to live privately in
 *            `app/actions/teams.ts` and drove the ADMIN DASHBOARD button:
 *            0.5 x peerAvg + 0.5 x (matchRating / 200) once 3+ peer
 *            ratings exist, else 0.7 x seed + 0.3 x (matchRating / 200).
 *            Deleted 2026-09-15; reproduced here so the divergence it
 *            caused stays measurable after the fact.
 *
 * A THIRD formula exists and is NOT compared here.
 * `app/api/cron/generate-teams/route.ts:57-92` uses a plain mean of the
 * last 60 peer scores, falling back to the seed under 3 ratings, with
 * no seed prior and no Elo. It is scheduled live at `0 12 * * *`. This
 * script answers the blended-vs-elo-mix question only; slice 3 of
 * `MDs/club-scoped-ratings-design-2026-09-18.md` is where the cron's
 * formula goes.
 *
 * The LLM rating adjuster is deliberately NOT run. Post-unification both
 * entry points run the same adjuster over the same base vector, so it is
 * a separate axis from the formula question this script answers, and
 * running it would spend a model call and write RatingAdjustment rows.
 *
 * ── THE HILL-CLIMB IS RANDOM, SO ONE RUN PROVES NOTHING ──────────────
 *
 * `balancePositionAware` — the strategy Sutton actually uses — ends with
 * a 1,000-iteration hill-climb that picks its candidate swaps with
 * `Math.random()`. Two runs of the SAME formula over the SAME squad can
 * therefore return different sheets. A single blended-vs-elo-mix diff
 * would report that coin-flip noise as if it were the formula's doing.
 *
 * So each formula is run TRIALS times, and what gets compared is the
 * MODAL partition — the sheet that formula lands on most often. The
 * script also prints each formula's own self-disagreement rate, which is
 * the noise floor any "who moves" claim has to clear.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { balanceTeams, type BalancingStrategy } from "../src/lib/team-balancer.ts";
import { computeClubRating } from "../src/lib/player-rating.ts";
import type { PlayerWithRating } from "../src/types/index.ts";

/** The formula this change deleted, kept verbatim so the comparison is
 *  a comparison and not a paraphrase. */
function eloMixRating(args: {
  seedRating: number | null;
  matchRating: number;
  peerRatings: number[];
}): number {
  const eloScaled = args.matchRating / 200;
  if (args.peerRatings.length >= 3) {
    const peerAvg =
      args.peerRatings.reduce((s, r) => s + r, 0) / args.peerRatings.length;
    return 0.5 * peerAvg + 0.5 * eloScaled;
  }
  const base = args.seedRating ?? 5.0;
  return 0.7 * base + 0.3 * eloScaled;
}

/** How many times each formula is balanced, to find its modal sheet. */
const TRIALS = 401;

/** A partition is colour-blind: {A,B} vs {C,D} is the same split however
 *  the shirts fall, and `swapTeamColours` exists precisely because the
 *  colours are not the decision. Key on the side Wasim-or-whoever-sorts-
 *  first is on, so the two orderings collapse to one string. */
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

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never as ConstructorParameters<typeof PrismaClient>[0]);

  const argMatchId = process.argv[2];
  const match = argMatchId
    ? await db.match.findUnique({
        where: { id: argMatchId },
        include: {
          activity: { include: { sport: true, org: true } },
          attendances: {
            where: { status: "CONFIRMED" },
            include: { user: { include: { activityPositions: true } } },
          },
        },
      })
    : await db.match.findFirst({
        where: {
          status: { notIn: ["CANCELLED", "COMPLETED"] },
          attendances: { some: { status: "CONFIRMED" } },
        },
        orderBy: { date: "asc" },
        include: {
          activity: { include: { sport: true, org: true } },
          attendances: {
            where: { status: "CONFIRMED" },
            include: { user: { include: { activityPositions: true } } },
          },
        },
      });

  if (!match) {
    console.log("No candidate match found.");
    await db.$disconnect();
    return;
  }

  const sport = match.activity.sport;
  const perTeam = sport.playersPerTeam;
  console.log(
    `${match.activity.org.name} — ${match.activity.name} — ${match.date.toISOString()}\n` +
      `match ${match.id}  status=${match.status}  ${sport.name} ${perTeam}v${perTeam}  ` +
      `strategy=${sport.balancingStrategy}\n` +
      `confirmed: ${match.attendances.length} (balancer takes the first ${perTeam * 2})\n`,
  );

  const rows = await Promise.all(
    match.attendances.map(async (a) => {
      const ratings = await db.rating.findMany({
        where: { playerId: a.userId },
        orderBy: { createdAt: "desc" },
        take: 60,
      });
      const peer = ratings.map((r) => r.score);
      const pap = a.user.activityPositions.find(
        (p) => p.activityId === match.activityId,
      );
      // The global blend, as it stood before 2026-09-19: the global
      // seed and a window drawn from every club. `computePlayerRating`
      // is gone; `computeClubRating` with `clubMeanRating: null` is the
      // same arithmetic, which is all this historical comparison needs.
      const blended = computeClubRating({
        clubSeedRating: a.user.seedRating ?? null,
        clubPeerRatings: peer,
        clubMeanRating: null,
      }).rating;
      const eloMix = eloMixRating({
        seedRating: a.user.seedRating ?? null,
        matchRating: a.user.matchRating,
        peerRatings: peer,
      });
      return {
        id: a.userId,
        name: a.user.name ?? "Unknown",
        positions: pap?.positions ?? [],
        image: a.user.image,
        seed: a.user.seedRating,
        elo: a.user.matchRating,
        peerCount: peer.length,
        blended,
        eloMix,
      };
    }),
  );

  console.log("player                  seed   elo  peers  blended  elo-mix   delta");
  for (const r of [...rows].sort((a, b) => b.blended - a.blended)) {
    console.log(
      `${r.name.padEnd(22)} ${String(r.seed ?? "-").padStart(4)} ${String(r.elo).padStart(5)} ` +
        `${String(r.peerCount).padStart(6)} ${r.blended.toFixed(2).padStart(8)} ` +
        `${r.eloMix.toFixed(2).padStart(8)} ${(r.eloMix - r.blended).toFixed(2).padStart(7)}`,
    );
  }

  // The DETERMINISTIC half of the comparison. The hill-climb is random,
  // but the draft ORDER it starts from is not, and the draft order is
  // the only thing a rating formula controls. Rank movement here is
  // signal; team movement below is mostly coin flips.
  const rankBy = (pick: (r: (typeof rows)[number]) => number) =>
    new Map(
      [...rows]
        .sort((a, b) => pick(b) - pick(a))
        .map((r, i) => [r.id, i + 1] as [string, number]),
    );
  const blendedRank = rankBy((r) => r.blended);
  const eloMixRank = rankBy((r) => r.eloMix);
  console.log("\ndraft order (deterministic — this is what the formula decides)");
  console.log("player                 blended  elo-mix   rank move");
  for (const r of [...rows].sort(
    (a, b) => blendedRank.get(a.id)! - blendedRank.get(b.id)!,
  )) {
    const from = eloMixRank.get(r.id)!;
    const to = blendedRank.get(r.id)!;
    const move = from === to ? "—" : `${from} → ${to} (${to < from ? "+" : ""}${from - to})`;
    console.log(
      `${r.name.padEnd(22)} ${String(to).padStart(7)} ${String(from).padStart(8)}   ${move}`,
    );
  }
  const spread = (pick: (r: (typeof rows)[number]) => number) => {
    const v = rows.map(pick);
    return Math.max(...v) - Math.min(...v);
  };
  console.log(
    `rating spread: blended ${spread((r) => r.blended).toFixed(2)}, ` +
      `elo-mix ${spread((r) => r.eloMix).toFixed(2)} — ` +
      `pinning half the weight on an Elo that is still near its 1000 start ` +
      `COMPRESSES the squad toward 5.0`,
  );

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
      distinct: new Set(keys).size,
      avgDiff: diffSum / TRIALS,
    };
  };

  const blendedRun = run((r) => r.blended);
  const eloMixRun = run((r) => r.eloMix);

  const show = (label: string, r: ReturnType<typeof run>) => {
    const [x, y] = r.key.split("  |  ");
    console.log(
      `\n── ${label} ──\n` +
        `modal sheet hit ${(r.share * 100).toFixed(0)}% of ${TRIALS} runs; ` +
        `${r.distinct} distinct sheets seen; mean rating diff ${r.avgDiff.toFixed(3)}\n` +
        `  ${x}\n  vs\n  ${y}`,
    );
  };
  show("blended  (WhatsApp path, now the dashboard too)", blendedRun);
  show("elo-mix  (old dashboard button)", eloMixRun);

  const sideOf = (key: string) => {
    const [x, y] = key.split("  |  ");
    const map = new Map<string, "A" | "B">();
    for (const n of x.split(", ")) map.set(n, "A");
    for (const n of y.split(", ")) map.set(n, "B");
    return map;
  };
  const a = sideOf(blendedRun.key);
  const b = sideOf(eloMixRun.key);
  // Colour-blind, so anchor on one player and ask who changes side
  // RELATIVE to him. Otherwise a pure relabel reads as everyone moving.
  const anchor = blendedRun.key.split("  |  ")[0].split(", ")[0];
  const together = (m: Map<string, "A" | "B">, n: string) => m.get(n) === m.get(anchor);
  const movers = rows
    .map((r) => r.name)
    .filter((n) => n !== anchor && together(a, n) !== together(b, n));

  console.log(
    `\nWHO MOVES (relative to ${anchor}): ${
      movers.length === 0
        ? "nobody — both formulas land on the same split for this squad"
        : movers
            .map((n) => `${n} ${together(b, n) ? "with" : "against"} → ${together(a, n) ? "with" : "against"}`)
            .join("; ")
    }`,
  );

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
