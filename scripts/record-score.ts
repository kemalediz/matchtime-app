/**
 * One-off: record Tuesday 7-a-side final score 7–7 (Kemal confirmed
 * via WhatsApp). LLM classified the message correctly but couldn't
 * resolve Kemal's @lid sender id to a User, so the score didn't
 * persist. Writing directly + applying Elo.
 *
 * SPENT. It ran once and is kept only as a record of what was done.
 * DO NOT COPY IT: the Elo moved to `Membership.matchRating` on
 * 2026-09-19 and `User.matchRating` is a deprecated column awaiting
 * slice 7's drop. A replacement for this script goes through
 * `src/lib/membership-elo.ts`, which needs the match's org.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { computeEloDeltas } from "../src/lib/elo.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const match = await db.match.findFirst({
    where: { status: "TEAMS_GENERATED", redScore: null, yellowScore: null },
    include: {
      teamAssignments: {
        include: { user: { select: { id: true, matchRating: true } } },
      },
    },
    orderBy: { date: "desc" },
  });
  if (!match) throw new Error("no eligible match");

  console.log(`Updating match ${match.id} → 7-7, status COMPLETED`);
  await db.match.update({
    where: { id: match.id },
    data: { redScore: 7, yellowScore: 7, status: "COMPLETED" },
  });

  const eloInputs = match.teamAssignments.map((t) => ({
    userId: t.userId,
    team: t.team,
    matchRating: t.user.matchRating,
  }));
  const deltas = computeEloDeltas(eloInputs, 7, 7);
  await db.$transaction(
    deltas.map((d) =>
      db.user.update({ where: { id: d.userId }, data: { matchRating: d.after } }),
    ),
  );
  console.log(`Elo updated for ${deltas.length} players.`);
  console.log("Post-match flow will kick in on the next scheduler tick (≤5 min).");
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
