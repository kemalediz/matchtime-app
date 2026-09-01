/**
 * Pipeline #1 — today's analyzer, as shipped.
 *
 * Builds the case's world with the existing sim harness (`e2e/sim/
 * group.ts`), posts the messages through the REAL `/api/whatsapp/analyze`
 * route, and reads the world back out of the database.
 *
 * HISTORY IS MANDATORY. `group.ts` forwards the "Recent chat history"
 * block the Pi sends on every production call. PR #26 discovered the sim
 * was omitting it, which meant every live-LLM test written before it ran
 * against a prompt production never uses — Amir's bug reproduced only
 * 2/5 WITH history. Every case's `history` is forwarded on every turn,
 * and later turns also see the earlier turns and MatchTime's own replies.
 */
import { createGroup, SimGroup, type SimHistoryEntry, type StubVerdict } from "../sim/group";
import type { AttStatus, CorpusCase, CorpusMessage, CorpusObservation } from "./grade";
import type { CorpusMode, CorpusPipeline, PipelineContext } from "./pipeline";

type Row = { name: string; status: AttStatus };

export class CurrentAnalyzerPipeline implements CorpusPipeline {
  readonly name = "current-analyzer";

  supports(c: CorpusCase, mode: CorpusMode): boolean {
    if (mode === "live") return true;
    // A stubbed run drives the LLM seam directly, so the case has to say
    // what the model emits. Cases without stubs are live-only by design.
    return c.messages.some((m) => m.stub !== undefined);
  }

  async run(ctx: PipelineContext, c: CorpusCase, mode: CorpusMode): Promise<CorpusObservation> {
    const grp = await this.buildWorld(ctx, c);

    const attendanceBefore = await this.rows(grp);
    const memberNamesBefore = await this.members(grp);
    const teamsBefore = await this.teams(grp);

    const spoken: string[] = [];
    const dms: Array<{ to: string | null; text: string }> = [];
    const reacts: Array<string | null> = [];

    // Messages are grouped into turns; each turn is one analyze batch,
    // exactly as the Pi's buffer flushes.
    const turns = new Map<number, CorpusMessage[]>();
    for (const m of c.messages) {
      const t = m.turn ?? 0;
      if (!turns.has(t)) turns.set(t, []);
      turns.get(t)!.push(m);
    }

    const history: SimHistoryEntry[] = (c.history ?? []).map((h) => ({
      authorName: h.author,
      body: h.body,
    }));

    for (const turn of [...turns.keys()].sort((a, b) => a - b)) {
      const items = turns.get(turn)!;
      const batch = await grp.postBatch(
        items.map((m) => ({
          ...(typeof m.from === "string" ? { player: m.from } : { author: m.from }),
          body: m.body,
          botMentioned: m.tag ?? false,
          ...(mode === "stub" && m.stub ? { verdict: m.stub as StubVerdict } : {}),
        })),
        { history: [...history] },
      );

      for (const r of batch.results) {
        reacts.push(r.react ?? null);
        if (r.reply) spoken.push(r.reply);
      }
      spoken.push(...batch.groupPosts);
      dms.push(...batch.dms.map((d) => ({ to: d.phone, text: d.text })));

      // Carry this turn forward as history for the next one.
      for (const m of items) {
        history.push({
          authorName: typeof m.from === "string" ? grp.player(m.from).name : m.from.name,
          body: m.body,
        });
      }
      for (const r of batch.results) {
        if (r.reply) history.push({ authorName: "MatchTime", body: r.reply });
      }
      for (const post of batch.groupPosts) history.push({ authorName: "MatchTime", body: post });
    }

    return {
      attendanceBefore,
      attendanceAfter: await this.rows(grp),
      memberNamesBefore,
      memberNamesAfter: await this.members(grp),
      spoken,
      dms,
      reacts,
      benchOffersOpen: (await grp.openOffers()).length,
      teamsBefore,
      teamsAfter: await this.teams(grp),
      scoreAfter: await this.score(grp),
      notes: { orgId: grp.orgId, matchId: grp.matchId },
    };
  }

  // ── world construction ───────────────────────────────────────────────

  private async buildWorld(ctx: PipelineContext, c: CorpusCase): Promise<SimGroup> {
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
                // reproduces the exact distance to kickoff a real
                // message had, which day granularity would erase.
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

    // An OPEN BENCH SLOT block only exists when a real BenchSlotOffer
    // row is open. Seeded directly so it is identical in both modes.
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

  // ── observation ──────────────────────────────────────────────────────

  private async rows(grp: SimGroup): Promise<Row[]> {
    if (!grp.matchId) return [];
    return grp.db.all<Row>(
      `SELECT COALESCE(u.name, '(unnamed)') AS name, a.status
         FROM "Attendance" a JOIN "User" u ON u.id = a."userId"
        WHERE a."matchId" = $1 ORDER BY a.position ASC`,
      [grp.matchId],
    );
  }

  private async members(grp: SimGroup): Promise<string[]> {
    const rows = await grp.db.all<{ name: string | null }>(
      `SELECT u.name FROM "Membership" m JOIN "User" u ON u.id = m."userId"
        WHERE m."orgId" = $1 ORDER BY u.name ASC`,
      [grp.orgId],
    );
    return rows.map((r) => r.name ?? "(unnamed)");
  }

  private async teams(grp: SimGroup): Promise<Array<{ name: string; team: string }>> {
    if (!grp.matchId) return [];
    return grp.db.all(
      `SELECT COALESCE(u.name, '(unnamed)') AS name, t.team
         FROM "TeamAssignment" t JOIN "User" u ON u.id = t."userId"
        WHERE t."matchId" = $1`,
      [grp.matchId],
    );
  }

  private async score(
    grp: SimGroup,
  ): Promise<{ red: number | null; yellow: number | null } | undefined> {
    if (!grp.completedMatchId) return undefined;
    const row = await grp.db.one<{ redScore: number | null; yellowScore: number | null }>(
      `SELECT "redScore", "yellowScore" FROM "Match" WHERE id = $1`,
      [grp.completedMatchId],
    );
    return { red: row?.redScore ?? null, yellow: row?.yellowScore ?? null };
  }
}
