/**
 * Pipeline #4 — §10 STEP 7's `question` and `balancer`, with the real
 * model, judged by the same cases that judge the mega-prompt.
 *
 *   router → question/teams extractor → engine → composer
 *
 * and nothing after it, because both routes are READS. There is no
 * apply layer to exercise, which is why this pipeline can be
 * in-process: it reads the world the harness built and returns what
 * MatchTime would SAY. `attendanceAfter` is a database read taken after
 * the run, so a case asserting `unchanged` is genuinely asserting that
 * nothing moved rather than asserting a proposal.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY IT DECLARES THE CASES IT OWNS, RATHER THAN RUNNING THEM ALL
 * ─────────────────────────────────────────────────────────────────────
 * `runAnswerBatch` hands a message BACK to the analyzer for a dozen
 * documented reasons, and in production that is the whole design: the
 * mega-prompt is still standing and still answers everything this step
 * does not own. In-process there is no mega-prompt, so a handed-back
 * message would be scored as silence and the case would fail — which
 * would report a carve-out working exactly as intended as a defect.
 *
 * Rather than pretend, the owned set is DECLARED here, case by case,
 * with the reason each corpus case in these two routes is in or out.
 * `supports()` skips the rest, and the scoreboard's own
 * "N cases DID NOT RUN and are NOT covered by the numbers above" banner
 * then says so in the output. Anything else would be a number that
 * flatters this step.
 *
 * A hybrid pipeline that fell back to the shipped analyze route for the
 * un-owned half is the honest end state and is what production does. It
 * needs the analyze route to know about these flags, which is a separate
 * commit — see the branch header. When that lands, this pipeline should
 * be replaced by a `CurrentAnalyzerPipeline` subclass sending the
 * `x-mt-engine-routes` header, exactly as `engine-pipeline.ts` does for
 * step 6, and the declared list below should be deleted.
 */
import { anthropicModel } from "@/lib/pipeline/llm";
import { routeBatch } from "@/lib/pipeline/router";
import { runAnswerBatch, type AnswerBatchMessage } from "@/lib/pipeline/answer-batch";
import type { OrgFeatures } from "@/lib/org-features";
import type { Route } from "@/lib/pipeline/types";
import { loadStateViaSql } from "./dryrun-pipeline";
import type { CorpusCase, CorpusMessage, CorpusObservation } from "./grade";
import type { CorpusMode, CorpusPipeline, PipelineContext } from "./pipeline";
import { buildCorpusWorld, readMembers, readRows, readTeams } from "./world";

/**
 * The corpus cases whose SHAPE step 7 owns, and why the neighbouring
 * ones are not here. Every §3.2 S16 / S19 / S24 / S32 case in the
 * corpus is accounted for below; nothing was left out silently.
 *
 *   S16c  bench question         → owned (topic `bench`)
 *   S32   phone-presence         → owned (topic `phones`)
 *   S24   fact-check the count   → owned (topic `count`, statedCount 9)
 *   S19   show the teams again   → owned (`balancer`, action `show`)
 *
 *   S16   history-vs-roster      → NOT owned here. Its first message is
 *                                  a third-party registration
 *                                  (`@Ehtisham Ul Haq In`) and the case
 *                                  asserts Ehtisham CONFIRMED. That is
 *                                  step 6's write, not step 7's answer,
 *                                  and this pipeline performs no writes
 *                                  at all — it would fail on the half
 *                                  of the case it is not responsible
 *                                  for. The QUESTION half is covered by
 *                                  the person_status unit tests and by
 *                                  the ownership rule that a name which
 *                                  does not resolve is handed back.
 *   S16d  most consistent        → NOT owned BY DESIGN. `stats` is one
 *                                  of the two topics `answer-batch.ts`
 *                                  hands back, and the reason is
 *                                  measured: the composed leaderboard
 *                                  trips `displaysSquadState`, so the
 *                                  shipped step-4 composer would swap
 *                                  the answer for the squad roster —
 *                                  the 2026-05-14 incident. A skip here
 *                                  is the carve-out working.
 *   S16b  Wasim relays Najib     → routes `other_att`, not `question`.
 *                                  Step 6's.
 */
const OWNED_CASE_IDS = new Set([
  "S16c-bench-question-no-speculation",
  "S32-phone-presence-answer-never-leaks-digits",
  "S24-factcheck-wrong-squad-count",
  "S19-show-teams-does-not-reshuffle",
]);

/** Both routes, both flags on. The point of the sweep is to measure
 *  them; a per-route number comes from the per-case rows. */
const ENABLED: Set<Route> = new Set<Route>(["question", "balancer"]);

export class AnswerEnginePipeline implements CorpusPipeline {
  readonly name = "answer-engine";

  /**
   * LIVE ONLY, for the same reason `DryRunPipeline` is: a stubbed run
   * of this pipeline would need hand-written FACTS, and the facts are
   * exactly what the model produces. Writing them myself would be
   * grading my own answer key — the trap `e2e/corpus/README.md` warns
   * about under "Do not 'record' stubs from a live run". The
   * deterministic coverage is 42 unit tests in
   * `src/lib/pipeline/__tests__/answer-batch.test.ts`.
   */
  supports(c: CorpusCase, mode: CorpusMode): boolean {
    return mode === "live" && OWNED_CASE_IDS.has(c.id);
  }

  async run(ctx: PipelineContext, c: CorpusCase): Promise<CorpusObservation> {
    const grp = await buildCorpusWorld(ctx, c);

    const attendanceBefore = await readRows(grp);
    const memberNamesBefore = await readMembers(grp);
    const teamsBefore = await readTeams(grp);

    const model = anthropicModel();
    const now = new Date();
    const spoken: string[] = [];
    const reacts: Array<string | null> = [];
    const notes: Record<string, unknown> = {
      orgId: grp.orgId,
      matchId: grp.matchId,
      routes: [] as unknown[],
      owned: [] as string[],
      handedBack: [] as string[],
      reasons: [] as unknown[],
      degradations: [] as string[],
      costUsd: 0,
    };

    const history: Array<{ author: string | null; body: string }> = (c.history ?? []).map((h) => ({
      author: h.author,
      body: h.body,
    }));

    const turns = new Map<number, CorpusMessage[]>();
    for (const m of c.messages) {
      const t = m.turn ?? 0;
      if (!turns.has(t)) turns.set(t, []);
      turns.get(t)!.push(m);
    }

    const features = await loadFeaturesViaSql(ctx, grp.orgId);

    for (const turn of [...turns.keys()].sort((a, b) => a - b)) {
      const items = turns.get(turn)!;

      const messages: AnswerBatchMessage[] = items.map((m, i) => {
        const roster = typeof m.from === "string" ? grp.player(m.from) : null;
        return {
          waMessageId: `corpus-${turn}-${i}`,
          body: m.body,
          authorName: roster ? roster.name : (m.from as { name: string | null }).name,
          senderUserId: roster ? roster.userId : null,
          senderName: roster ? roster.name : (m.from as { name: string | null }).name,
          tagged: m.tag ?? false,
          route: undefined,
          gated: false,
        };
      });

      // Stage 1 — the REAL router, same call the analyze route makes.
      const routed = await routeBatch(
        model,
        messages.map((m) => ({ id: m.waMessageId, authorName: m.authorName, body: m.body })),
      );
      const routeById = new Map(routed.routes.map((r) => [r.messageId, r.route]));
      for (const m of messages) m.route = routeById.get(m.waMessageId);
      (notes.routes as unknown[]).push(
        ...routed.routes.map((r) => ({ id: r.messageId, route: r.route, source: r.source })),
      );
      notes.costUsd = (notes.costUsd as number) + (routed.usage?.costUsd ?? 0);
      (notes.degradations as string[]).push(
        ...routed.degradations.map((d) => `router: ${d.detail}`),
      );

      const state = await loadStateViaSql(grp);

      const res = await runAnswerBatch({
        orgId: grp.orgId,
        now,
        messages,
        history: [...history],
        expectedMatchId: state.matchId,
        enabled: ENABLED,
        deps: {
          model,
          loadState: async () => loadStateViaSql(grp),
          loadFeatures: async () => features,
        },
      });

      notes.costUsd = (notes.costUsd as number) + res.cost.usd;
      (notes.degradations as string[]).push(...res.degradations);
      for (const m of messages) {
        const out = res.outcomes.get(m.waMessageId);
        if (out) {
          (notes.owned as string[]).push(`${m.waMessageId} ${out.route}`);
          (notes.reasons as unknown[]).push({ id: m.waMessageId, reasoning: out.reasoning });
          if (out.reply) spoken.push(out.reply);
          reacts.push(out.react);
        } else {
          (notes.handedBack as string[]).push(`${m.waMessageId} route=${m.route ?? "(none)"}`);
          reacts.push(null);
        }
      }

      for (const m of items) {
        history.push({
          author: typeof m.from === "string" ? grp.player(m.from).name : m.from.name,
          body: m.body,
        });
      }
      for (const s of spoken.slice(-messages.length)) {
        history.push({ author: "MatchTime", body: s });
      }
    }

    return {
      attendanceBefore,
      // A DATABASE read, not a projection. This pipeline writes nothing,
      // so `unchanged` is asserted against the real rows.
      attendanceAfter: await readRows(grp),
      memberNamesBefore,
      memberNamesAfter: await readMembers(grp),
      spoken,
      dms: [],
      reacts,
      benchOffersOpen: (await ctx.db.all<{ id: string }>(
        `SELECT id FROM "BenchSlotOffer" WHERE "matchId" = $1 AND "resolvedAt" IS NULL`,
        [grp.matchId],
      )).length,
      teamsBefore,
      teamsAfter: await readTeams(grp),
      notes,
    };
  }
}

/** `OrgFeatures` in plain SQL — the Playwright process never loads
 *  Prisma (`e2e/sim/group.ts`). Only `teamBalancing` is load-bearing
 *  here; the rest are read so the shape is honest rather than a
 *  hand-built object that could disagree with the database. */
async function loadFeaturesViaSql(ctx: PipelineContext, orgId: string): Promise<OrgFeatures> {
  const row = await ctx.db.one<{
    whatsappBotEnabled: boolean;
    featureAttendance: boolean;
    featureBench: boolean;
    featureTeamBalancing: boolean;
    featureMomVoting: boolean;
    featurePlayerRating: boolean;
    featureReminders: boolean;
    featureStatsQa: boolean;
    paymentTrackingEnabled: boolean;
    paymentCollectionEnabled: boolean;
    featureSquadFromList: boolean;
  }>(
    `SELECT "whatsappBotEnabled", "featureAttendance", "featureBench", "featureTeamBalancing",
            "featureMomVoting", "featurePlayerRating", "featureReminders", "featureStatsQa",
            "paymentTrackingEnabled", "paymentCollectionEnabled", "featureSquadFromList"
       FROM "Organisation" WHERE id = $1`,
    [orgId],
  );
  if (!row) {
    // `getOrgFeatures` returns ALL_OFF for an org it cannot read, and
    // ALL_OFF means this pipeline owns nothing — the safe direction, and
    // the same one the server takes.
    throw new Error(`corpus: no Organisation row for ${orgId}`);
  }
  return {
    botEnabled: row.whatsappBotEnabled,
    attendance: row.featureAttendance,
    bench: row.featureBench,
    teamBalancing: row.featureTeamBalancing,
    momVoting: row.featureMomVoting,
    playerRating: row.featurePlayerRating,
    reminders: row.featureReminders,
    statsQa: row.featureStatsQa,
    paymentTracking: row.paymentTrackingEnabled,
    paymentCollection: row.paymentCollectionEnabled,
    squadFromList: row.featureSquadFromList,
  };
}

export default AnswerEnginePipeline;
