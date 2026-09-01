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
import { SimGroup, type SimHistoryEntry, type StubVerdict } from "../sim/group";
import type { CorpusCase, CorpusMessage, CorpusObservation } from "./grade";
import type { CorpusMode, CorpusPipeline, PipelineContext } from "./pipeline";
// The world builder and the read-back helpers moved to ./world when the
// SECOND pipeline arrived (§10 step 2). Both pipelines must be judged
// against a world built by the same code, or a divergence in the builder
// would read as a divergence in the pipelines.
import { buildCorpusWorld, readMembers, readRows, readScore, readTeams } from "./world";

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

  private async buildWorld(ctx: PipelineContext, c: CorpusCase): Promise<SimGroup> {
    return buildCorpusWorld(ctx, c);
  }

  private rows = readRows;
  private members = readMembers;
  private teams = readTeams;
  private score = readScore;
}
