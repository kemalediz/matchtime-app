/**
 * The corpus world, built ONCE and shared by every pipeline.
 *
 * Extracted from `current-analyzer-pipeline.ts` when the second pipeline
 * arrived (§10 step 2). This is not tidiness: if the two pipelines were
 * judged against worlds built by two copies of this code, a divergence
 * in the BUILDER would read as a divergence in the pipelines, and the
 * whole comparison would be worthless. One builder, one world shape,
 * both pipelines.
 */
import { createGroup, SimGroup } from "../sim/group";
import type { AttStatus, CorpusCase } from "./grade";
import type { PipelineContext } from "./pipeline";

export async function buildCorpusWorld(
  ctx: PipelineContext,
  c: CorpusCase,
): Promise<SimGroup> {
  const w = c.world;
  const grp = (
    await createGroup(ctx.request, ctx.db, {
      name: `Corpus ${c.id}`,
      maxPlayers: w.maxPlayers ?? 14,
      players: w.players,
      ...(w.features ? { features: w.features } : {}),
      upcomingMatch:
        w.upcomingMatchInDays === null
          ? false
          : {
              // Hours win when a case gives them: the replay harness
              // reproduces the exact distance to kickoff a real message
              // had, which day granularity would erase. (From PR #35.)
              ...(w.upcomingMatchInHours !== undefined
                ? { hoursFromNow: w.upcomingMatchInHours }
                : { daysFromNow: w.upcomingMatchInDays ?? 2 }),
              ...(w.deadlineHoursBeforeKickoff !== undefined
                ? { deadlineHoursBeforeKickoff: w.deadlineHoursBeforeKickoff }
                : {}),
            },
      attendance: w.attendance ?? [],
      ...(w.completedMatch ? { completedMatch: w.completedMatch } : {}),
    })
  ).attach(ctx.request);

  if (w.alsoMatchInDays !== undefined) {
    await grp.addMatch({ daysFromNow: w.alsoMatchInDays });
  }

  if (w.teams) {
    for (const [key, team] of Object.entries(w.teams)) {
      await ctx.db.run(
        `INSERT INTO "TeamAssignment" (id, "matchId", "userId", team) VALUES ($1, $2, $3, $4)`,
        // Derived from matchId, which already carries the harness's
        // per-process nonce — a fixed `corpus-ta-<caseId>` collides
        // between two runs sharing the embedded Postgres.
        [`ta-${grp.matchId}-${key}`, grp.matchId, grp.player(key).userId, team],
      );
    }
  }

  // An OPEN BENCH SLOT block only exists when a real BenchSlotOffer row
  // is open. Seeded directly so it is identical in every mode.
  if (w.openBenchSlotByDropping) {
    const dropped = grp.player(w.openBenchSlotByDropping);
    await ctx.db.run(
      `UPDATE "Attendance" SET status = 'DROPPED' WHERE "matchId" = $1 AND "userId" = $2`,
      [grp.matchId, dropped.userId],
    );
    await ctx.db.run(
      `INSERT INTO "BenchSlotOffer" (id, "matchId", "replacingUserId", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, now(), now())`,
      [`offer-${grp.matchId}`, grp.matchId, dropped.userId],
    );
  }

  await grp.drainOutbound(); // setup must not pollute the observation
  return grp;
}

export type Row = { name: string; status: AttStatus };

export async function readRows(grp: SimGroup): Promise<Row[]> {
  if (!grp.matchId) return [];
  return grp.db.all<Row>(
    `SELECT COALESCE(u.name, '(unnamed)') AS name, a.status
       FROM "Attendance" a JOIN "User" u ON u.id = a."userId"
      WHERE a."matchId" = $1 ORDER BY a.position ASC`,
    [grp.matchId],
  );
}

export async function readMembers(grp: SimGroup): Promise<string[]> {
  const rows = await grp.db.all<{ name: string | null }>(
    `SELECT u.name FROM "Membership" m JOIN "User" u ON u.id = m."userId"
      WHERE m."orgId" = $1 ORDER BY u.name ASC`,
    [grp.orgId],
  );
  return rows.map((r) => r.name ?? "(unnamed)");
}

export async function readTeams(
  grp: SimGroup,
): Promise<Array<{ name: string; team: string }>> {
  if (!grp.matchId) return [];
  return grp.db.all(
    `SELECT COALESCE(u.name, '(unnamed)') AS name, t.team
       FROM "TeamAssignment" t JOIN "User" u ON u.id = t."userId"
      WHERE t."matchId" = $1`,
    [grp.matchId],
  );
}

export async function readScore(
  grp: SimGroup,
): Promise<{ red: number | null; yellow: number | null } | undefined> {
  if (!grp.completedMatchId) return undefined;
  const row = await grp.db.one<{ redScore: number | null; yellowScore: number | null }>(
    `SELECT "redScore", "yellowScore" FROM "Match" WHERE id = $1`,
    [grp.completedMatchId],
  );
  return { red: row?.redScore ?? null, yellow: row?.yellowScore ?? null };
}
