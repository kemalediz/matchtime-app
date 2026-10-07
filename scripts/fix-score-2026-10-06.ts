/**
 * SPENT. Applied to production on the night of 6 October 2026 (candidate
 * [0]: Red +24, Yellow -24 taken back, then the right result applied).
 * It refuses to run again: the match no longer reads Red 9, Yellow 6.
 * Kept as the record of what was done. Any later change to a score goes
 * through `src/lib/match-elo.ts`, which stores the points it writes.
 *
 * One-off: Sutton Football Club, Tuesday 6 October 2026.
 *
 * The group was told "9-6 to yellows". The score extractor returned the
 * two numbers with no team, the engine put the first on Red, and the
 * match was recorded Red 9, Yellow 6. The truth is Red 6, Yellow 9. The
 * Elo pass then rewarded the losing side.
 *
 * This sets the match to Red 6, Yellow 9 and puts every affected
 * membership's Elo where it would be had Yellow 9, Red 6 been recorded
 * the first time:
 *
 *   1. recover the per-team deltas the wrong result applied, by working
 *      backwards from the ratings as they stand (`invertEloDeltas`; the
 *      applied deltas were not stored anywhere before today);
 *   2. subtract them, which gives the ratings as they were before the
 *      score was reported;
 *   3. run the ordinary forward pass on those with the right result.
 *
 * DRY RUN by default. Pass --apply to write.
 *
 *   node --env-file=.env --import tsx scripts/fix-score-2026-10-06.ts
 *   node --env-file=.env --import tsx scripts/fix-score-2026-10-06.ts --apply
 *
 * IT REFUSES, and writes nothing, when:
 *   - the match no longer reads Red 9, Yellow 6 (already fixed, or edited);
 *   - another match of this club has been scored or edited since this
 *     one, because then the ratings have moved again and step 1 would
 *     recover the wrong numbers;
 *   - step 1 has no solution (the ratings moved for some other reason);
 *   - step 1 has two solutions and --pick was not given. The forward
 *     pass rounds, so two neighbouring answers are sometimes both
 *     consistent; they differ by one rating point. The dry run prints
 *     both so a person chooses, the script never does.
 *
 * WHAT IT ASSUMES AND CANNOT PROVE: that the bot's Elo pass for the
 * wrong result ran, once. It runs straight after the score write and a
 * failure is only logged, not stored. If it had failed, the ratings
 * would not have moved and this script would subtract deltas that were
 * never added. See the PR description for the evidence either way.
 *
 * One transaction. `SET LOCAL` only, so nothing outlives it. Every
 * membership update is guarded on the rating read at the start, and the
 * match update on Red 9, Yellow 6, so a concurrent change aborts the
 * whole thing instead of being overwritten.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { computeEloDeltas, invertEloDeltas, type PlayerEloInput } from "../src/lib/elo.ts";

const MATCH_ID = "cmtbro2ct0006tt9kxjbbr0ce";
const WRONG = { red: 9, yellow: 6 };
const RIGHT = { red: 6, yellow: 9 };

class Refuse extends Error {}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const pickArg = args.find((a) => a.startsWith("--pick="));
  const pick = pickArg ? Number(pickArg.slice("--pick=".length)) : null;

  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_URL (or DATABASE_URL) is not set");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) } as never);

  console.log(`${apply ? "APPLY" : "DRY RUN"}: match ${MATCH_ID}`);

  try {
    await db.$transaction(
      async (tx) => {
        if (apply) {
          // Transaction-scoped. Never a session-level SET.
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`);
          await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${MATCH_ID} FOR UPDATE`;
        }

        const match = await tx.match.findUnique({
          where: { id: MATCH_ID },
          select: {
            id: true,
            date: true,
            status: true,
            redScore: true,
            yellowScore: true,
            updatedAt: true,
            activity: { select: { name: true, orgId: true, org: { select: { name: true } } } },
            teamAssignments: { select: { userId: true, team: true, user: { select: { name: true } } } },
          },
        });
        if (!match) throw new Refuse("match not found");
        const orgId = match.activity.orgId;
        console.log(`  ${match.activity.org.name}, ${match.activity.name}, kickoff ${match.date.toISOString()}`);
        console.log(`  match BEFORE: Red ${match.redScore}, Yellow ${match.yellowScore} (${match.status}, last written ${match.updatedAt.toISOString()})`);

        if (match.redScore !== WRONG.red || match.yellowScore !== WRONG.yellow) {
          throw new Refuse(
            `the match no longer reads Red ${WRONG.red}, Yellow ${WRONG.yellow}. Nothing to do, or somebody edited it: look before touching it.`,
          );
        }

        const later = await tx.match.findMany({
          where: {
            activity: { orgId },
            id: { not: MATCH_ID },
            redScore: { not: null },
            updatedAt: { gte: match.updatedAt },
          },
          select: { id: true, date: true, updatedAt: true },
        });
        if (later.length > 0) {
          throw new Refuse(
            `another scored match of this club was written after this one (${later
              .map((m) => `${m.id} at ${m.updatedAt.toISOString()}`)
              .join(", ")}), so the ratings have moved again and the applied deltas cannot be recovered from them.`,
          );
        }

        const memberships = await tx.membership.findMany({
          where: { orgId, userId: { in: match.teamAssignments.map((t) => t.userId) } },
          select: { id: true, userId: true, matchRating: true },
        });
        const byUser = new Map(memberships.map((m) => [m.userId, m]));
        // No membership at the club: entered the maths at 1000, never
        // written (`membership-elo.ts`). Same before and after.
        const unwritten = new Set(match.teamAssignments.filter((t) => !byUser.has(t.userId)).map((t) => t.userId));
        const current: PlayerEloInput[] = match.teamAssignments.map((t) => ({
          userId: t.userId,
          team: t.team as "RED" | "YELLOW",
          matchRating: byUser.get(t.userId)?.matchRating ?? 1000,
        }));
        const nameOf = new Map(match.teamAssignments.map((t) => [t.userId, t.user.name ?? "?"]));
        console.log(`  players on the team sheet: ${current.length} (${unwritten.size} with no membership here)`);

        const candidates = invertEloDeltas(current, WRONG.red, WRONG.yellow, unwritten);
        if (candidates.length === 0) {
          throw new Refuse(
            "no pair of deltas is consistent with the ratings as they stand, so they have moved for another reason since. Not guessing.",
          );
        }
        console.log(
          `  deltas the wrong result applied, recovered by inversion: ${candidates
            .map((c, i) => `[${i}] Red ${signed(c.red)}, Yellow ${signed(c.yellow)}`)
            .join("  OR  ")}`,
        );

        const plans = candidates.map((c) => {
          const before: PlayerEloInput[] = current.map((p) =>
            unwritten.has(p.userId) ? p : { ...p, matchRating: p.matchRating - (p.team === "RED" ? c.red : c.yellow) },
          );
          const right = computeEloDeltas(before, RIGHT.red, RIGHT.yellow);
          return current.map((p, i) => ({
            userId: p.userId,
            name: nameOf.get(p.userId) ?? "?",
            team: p.team,
            now: p.matchRating,
            beforeMatch: before[i].matchRating,
            after: unwritten.has(p.userId) ? p.matchRating : right[i].after,
            written: !unwritten.has(p.userId),
          }));
        });

        plans.forEach((plan, i) => {
          console.log(`\n  Candidate [${i}]`);
          console.log(`  ${"player".padEnd(18)}${"team".padEnd(8)}${"now".padStart(6)}${"pre-match".padStart(11)}${"corrected".padStart(11)}${"change".padStart(8)}`);
          for (const r of [...plan].sort((a, b) => a.team.localeCompare(b.team) || a.name.localeCompare(b.name))) {
            console.log(
              `  ${r.name.padEnd(18)}${r.team.padEnd(8)}${String(r.now).padStart(6)}${String(r.beforeMatch).padStart(11)}${String(r.after).padStart(11)}${signed(r.after - r.now).padStart(8)}${r.written ? "" : "  (no membership, not written)"}`,
            );
          }
        });
        console.log(`\n  match AFTER: Red ${RIGHT.red}, Yellow ${RIGHT.yellow} (COMPLETED)`);

        if (!apply) {
          console.log("\nnothing written (pass --apply)");
          return;
        }

        let chosen = 0;
        if (plans.length > 1) {
          if (pick === null || !Number.isInteger(pick) || pick < 0 || pick >= plans.length) {
            throw new Refuse(
              `${plans.length} candidates are consistent (they differ by one rating point). Choose one with --pick=<index>.`,
            );
          }
          chosen = pick;
        }
        const plan = plans[chosen];

        for (const r of plan) {
          if (!r.written) continue;
          const res = await tx.membership.updateMany({
            where: { userId: r.userId, orgId, matchRating: r.now },
            data: { matchRating: r.after },
          });
          if (res.count !== 1) {
            throw new Refuse(`${r.name}'s rating changed while this ran (expected ${r.now}). Rolled back.`);
          }
        }
        const m = await tx.match.updateMany({
          where: { id: MATCH_ID, redScore: WRONG.red, yellowScore: WRONG.yellow },
          data: { redScore: RIGHT.red, yellowScore: RIGHT.yellow, status: "COMPLETED" },
        });
        if (m.count !== 1) throw new Refuse("the match changed while this ran. Rolled back.");

        console.log(`\nAPPLIED candidate [${chosen}]: match is Red ${RIGHT.red}, Yellow ${RIGHT.yellow}; ${plan.filter((r) => r.written).length} ratings corrected.`);
      },
      { timeout: 30_000 },
    );
  } catch (err) {
    if (err instanceof Refuse) {
      console.error(`\nREFUSING: ${err.message}`);
      process.exitCode = 2;
    } else {
      throw err;
    }
  } finally {
    await db.$disconnect();
  }
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
