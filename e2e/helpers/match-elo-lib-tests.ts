/**
 * `lib/match-elo.ts` against the REAL embedded Postgres, under tsx (the
 * lib imports the Prisma 7 generated client, which Playwright's
 * transpiler cannot load). Invoked by e2e/api/match-elo.spec.ts via
 * execFile; exits non-zero with a readable message on any failure.
 *
 * `src/lib/__tests__/match-elo.test.ts` proves the arithmetic on an
 * in-memory fake. What only a real database can show:
 *   - the two raw `SELECT ... FOR UPDATE` statements parse and run (the
 *     membership one binds an array);
 *   - the JSON record round-trips through the real column;
 *   - two score changes on two matches that share players, fired at the
 *     same moment, both finish (no deadlock) and leave exactly the sum
 *     of what each wrote;
 *   - the "which team won?" question is stored, replaced, read back by
 *     the router's loader AND by the state loader, and cleared by a
 *     recorded result (`pipeline/score-ask.ts`).
 *
 * Requires the fixture world to be seeded (the spec reseeds first) and
 * MT_E2E_DATABASE_URL to point at the embedded test DB.
 */
import assert from "node:assert/strict";
import { assertSafeTestDbUrl, E2E_DB_URL } from "./env";
import { ACTIVITY_ID, ORG_ID, U } from "./constants";

async function main() {
  const url = process.env.MT_E2E_DATABASE_URL ?? E2E_DB_URL;
  assertSafeTestDbUrl(url);
  process.env.DATABASE_URL = url;

  const { setMatchScore, reconcileMatchElo, parseEloApplied } = await import("@/lib/match-elo");
  const { computeEloDeltas } = await import("@/lib/elo");
  const { db } = await import("@/lib/db");
  const { buildScoreApplyDeps } = await import("@/lib/owner-deps");
  const { loadOpenScoreAsk } = await import("@/lib/pipeline/load-awaiting-answer");
  const { loadSquadState } = await import("@/lib/pipeline/load-state");

  let n = 0;
  const ok = (label: string) => {
    n++;
    console.log(`  ✓ ${label}`);
  };

  const P = "e2e-melo";
  const RED = [U.admin, U.collector];
  const YELLOW = [U.player, U.rater];
  const players = [...RED, ...YELLOW];
  const teams = [
    ...RED.map((userId) => ({ userId, team: "RED" as const })),
    ...YELLOW.map((userId) => ({ userId, team: "YELLOW" as const })),
  ];

  const ratings = async (): Promise<Record<string, number>> => {
    const rows = await db.membership.findMany({
      where: { orgId: ORG_ID, userId: { in: players } },
      select: { userId: true, matchRating: true },
    });
    return Object.fromEntries(rows.map((r) => [r.userId, r.matchRating]));
  };
  const expected = (start: Record<string, number>, red: number, yellow: number) =>
    Object.fromEntries(
      computeEloDeltas(
        teams.map((t) => ({ ...t, matchRating: start[t.userId] })),
        red,
        yellow,
      ).map((d) => [d.userId, d.after]),
    );
  const makeMatch = async (id: string, date: Date) => {
    await db.match.create({
      data: {
        id,
        activityId: ACTIVITY_ID,
        date,
        maxPlayers: 4,
        status: "TEAMS_PUBLISHED",
        attendanceDeadline: date,
        teamAssignments: { create: teams },
      },
    });
  };

  const start = await ratings();
  assert.equal(Object.keys(start).length, 4, "the four seeded players are members of the e2e club");

  try {
    const M1 = `${P}-1`;
    const M2 = `${P}-2`;
    await makeMatch(M1, new Date("2026-06-02T19:30:00Z"));
    await makeMatch(M2, new Date("2026-06-09T19:30:00Z"));

    // ── A first score: applied, and the record round-trips ───────────
    await setMatchScore({ matchId: M1, red: 9, yellow: 6 });
    {
      const row = await db.match.findUnique({ where: { id: M1 }, select: { eloApplied: true, status: true } });
      assert.deepEqual(parseEloApplied(row?.eloApplied), { target: { red: 9, yellow: 6 }, applied: null });
      assert.equal(row?.status, "COMPLETED");
      assert.deepEqual(await ratings(), start, "writing a score moves no rating");
    }
    ok("setMatchScore writes the score and a PENDING record, and no rating");
    {
      const res = await reconcileMatchElo({ matchId: M1 });
      assert.equal(res.status, "applied");
      assert.equal(res.moved, 4);
      assert.deepEqual(await ratings(), expected(start, 9, 6));
      const row = await db.match.findUnique({ where: { id: M1 }, select: { eloApplied: true } });
      const rec = parseEloApplied(row?.eloApplied);
      assert.equal(rec?.applied?.deltas?.length, 4);
    }
    ok("reconcile adds the result's points under the row locks and stores them");

    // ── The correction is exact, and idempotent ──────────────────────
    await setMatchScore({ matchId: M1, red: 6, yellow: 9, expectPrevious: { red: 9, yellow: 6 } });
    assert.equal((await reconcileMatchElo({ matchId: M1 })).status, "corrected");
    assert.deepEqual(await ratings(), expected(start, 6, 9));
    assert.equal((await reconcileMatchElo({ matchId: M1 })).status, "unchanged");
    assert.deepEqual(await ratings(), expected(start, 6, 9));
    ok("a correction leaves the ratings where the right result alone would have, once");

    await assert.rejects(
      setMatchScore({ matchId: M1, red: 1, yellow: 1, expectPrevious: { red: 9, yellow: 6 } }),
      /reads 6-9/,
    );
    ok("a correction decided against a stale result is refused");

    // ── Two matches, the same players, at the same moment ────────────
    const before = await ratings();
    await setMatchScore({ matchId: M2, red: 3, yellow: 3 });
    await setMatchScore({ matchId: M1, red: 9, yellow: 6 });
    const both = await Promise.all([
      reconcileMatchElo({ matchId: M1 }),
      reconcileMatchElo({ matchId: M2 }),
      reconcileMatchElo({ matchId: M1 }),
      reconcileMatchElo({ matchId: M2 }),
    ]);
    assert.deepEqual(
      both.map((b) => b.status).sort(),
      ["applied", "corrected", "unchanged", "unchanged"],
      "each match is reconciled exactly once however many callers race",
    );
    {
      // Whatever order they ran in, the net change is the sum of what
      // the two records say was written, minus M1's old points.
      const rows = await db.match.findMany({ where: { id: { in: [M1, M2] } }, select: { id: true, eloApplied: true } });
      const now = await ratings();
      const m1Old = Object.fromEntries(
        players.map((u) => [u, expected(start, 6, 9)[u] - start[u]]),
      );
      for (const u of players) {
        const written = rows.reduce(
          (s, r) => s + (parseEloApplied(r.eloApplied)?.applied?.deltas?.find((d) => d.userId === u)?.delta ?? 0),
          0,
        );
        assert.equal(now[u], before[u] - m1Old[u] + written, `${u}: ratings add up after a race`);
      }
    }
    ok("racing reconciles on two matches that share players neither deadlock nor double count");

    // ── "Which team won?": stored, replaced, read, cleared ───────────
    {
      const M3 = `${P}-3`;
      // The most recently ENDED match of the club, so the state loader
      // picks it as the one a result is about.
      const kickoff = new Date(Date.now() - 3 * 60 * 60 * 1000);
      await makeMatch(M3, kickoff);
      const deps = buildScoreApplyDeps();
      assert.ok(deps.recordScoreAsk, "the production deps can remember a question");

      await deps.recordScoreAsk({ matchId: M3, first: 10, second: 7 });
      const open = await loadOpenScoreAsk(ORG_ID);
      assert.equal(open?.matchId, M3);
      assert.deepEqual([open?.first, open?.second], [10, 7]);
      assert.equal(open?.labels.length, 2);
      const state = await loadSquadState(ORG_ID, new Date());
      assert.equal(state.completedMatch?.id, M3, "the state loader holds the same match");
      assert.deepEqual(
        [state.completedMatch?.pendingScore?.first, state.completedMatch?.pendingScore?.second],
        [10, 7],
      );
      assert.equal(state.completedMatch?.teams?.length, 4);
      assert.ok(state.completedMatch?.kickoffAt);
      ok("a question is stored and read back by both loaders");

      await deps.recordScoreAsk({ matchId: M3, first: 10, second: 6 });
      const replaced = await loadOpenScoreAsk(ORG_ID);
      assert.deepEqual([replaced?.first, replaced?.second], [10, 6]);
      assert.equal(await db.sentNotification.count({ where: { matchId: M3, kind: "score-ask" } }), 1);
      ok("a different scoreline replaces it: one open question per match");

      await deps.recordScore({ matchId: M3, red: 6, yellow: 10 });
      assert.equal(await loadOpenScoreAsk(ORG_ID), null);
      const after = await loadSquadState(ORG_ID, new Date());
      assert.equal(after.completedMatch?.pendingScore, undefined);
      assert.equal(after.completedMatch?.redScore, 6);
      ok("recording a result clears the question");
    }

    console.log(`OK: ${n} match-elo checks against Postgres`);
  } finally {
    await db.match.deleteMany({ where: { id: { startsWith: P } } });
    for (const [userId, matchRating] of Object.entries(start)) {
      await db.membership.updateMany({ where: { orgId: ORG_ID, userId }, data: { matchRating } });
    }
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
