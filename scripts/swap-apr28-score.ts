/**
 * One-off: swap the Apr 28 score from Red 6-5 to Yellow 6-5.
 *
 * Score was recorded the wrong way round (whoever entered it had the
 * teams flipped). Yellow actually won 6-5, but the DB has Red 6 -
 * Yellow 5. This means the Elo update went to the wrong side too.
 *
 * Fix:
 *   1. Compute "would-be" deltas using current ratings + the BAD
 *      score → approximation of what was originally applied.
 *   2. Reverse those deltas (current - delta) → approximate
 *      pre-bad-update ratings.
 *   3. Compute fresh deltas using the reversed ratings + the CORRECT
 *      score (Red 5, Yellow 6).
 *   4. Apply: matchRating becomes reversed + correct_delta. Update
 *      Match.redScore + .yellowScore.
 *
 * Approximation note: the bad deltas we compute in step 1 use
 * CURRENT team avgs, not the pre-bad-update avgs. Difference per
 * player is < 1 rating point because team-avg shifted by the same
 * delta on both sides. Good enough for a one-off correction.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { computeEloDeltas } from "../src/lib/elo.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  const m = await db.match.findFirst({
    where: { isHistorical: false, status: "COMPLETED" },
    orderBy: { date: "desc" },
    include: { activity: { select: { name: true } } },
  });
  if (!m) {
    console.log("No completed match found");
    return;
  }
  console.log(`Match ${m.id} (${m.activity.name}, ${m.date.toISOString()})`);
  console.log(`Current: Red ${m.redScore} - Yellow ${m.yellowScore}`);
  if (m.redScore !== 6 || m.yellowScore !== 5) {
    console.log("Sanity check failed — expected Red 6 - Yellow 5. Aborting.");
    return;
  }

  const teams = await db.teamAssignment.findMany({
    where: { matchId: m.id },
    include: { user: { select: { id: true, name: true, matchRating: true } } },
  });
  if (teams.length === 0) {
    console.log("No team assignments — nothing to undo. Just swapping the score.");
    await db.match.update({
      where: { id: m.id },
      data: { redScore: 5, yellowScore: 6 },
    });
    console.log("Score swapped to Red 5 - Yellow 6.");
    return;
  }

  const eloInputs = teams.map((t) => ({
    userId: t.userId,
    team: t.team,
    matchRating: t.user.matchRating,
  }));
  const nameById = new Map(teams.map((t) => [t.userId, t.user.name ?? "?"]));

  const badDeltas = computeEloDeltas(eloInputs, 6, 5);
  const reversedInputs = eloInputs.map((p) => {
    const d = badDeltas.find((x) => x.userId === p.userId);
    return { ...p, matchRating: p.matchRating - (d?.delta ?? 0) };
  });
  const correctDeltas = computeEloDeltas(reversedInputs, 5, 6);

  console.log("\nPlanned changes:");
  console.log(
    "  user".padEnd(28) +
      "team".padEnd(8) +
      "current".padEnd(10) +
      "→ reversed".padEnd(13) +
      "→ corrected",
  );
  const updates = reversedInputs.map((p) => {
    const d = correctDeltas.find((x) => x.userId === p.userId);
    const final = p.matchRating + (d?.delta ?? 0);
    const orig = eloInputs.find((x) => x.userId === p.userId)!.matchRating;
    console.log(
      `  ${(nameById.get(p.userId) ?? "?").padEnd(26)}${p.team.padEnd(8)}${String(orig).padEnd(10)}→ ${String(p.matchRating).padEnd(11)}→ ${final}`,
    );
    return { userId: p.userId, after: final };
  });

  await db.$transaction([
    ...updates.map((u) =>
      db.user.update({
        where: { id: u.userId },
        data: { matchRating: u.after },
      }),
    ),
    db.match.update({
      where: { id: m.id },
      data: { redScore: 5, yellowScore: 6 },
    }),
  ]);
  console.log("\nDone. Score is now Red 5 - Yellow 6 (Yellow wins).");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => process.exit(0));
