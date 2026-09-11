/**
 * Pipeline #5 — §10 STEP 7 PART 2's two WRITING routes, with the real
 * model, judged by the same cases that judge the mega-prompt.
 *
 *   router → score/admin extractor → engine → APPLY → composer
 *
 * Unlike pipeline #4 (`answer-engine-pipeline.ts`), this one has a fifth
 * box and it is a real one: the apply layers write to the corpus
 * database. `attendanceAfter` and `scoreAfter` are DATABASE READS taken
 * after the run, so a case asserting `unchanged` is genuinely asserting
 * that nothing moved, and a case asserting a score is asserting a row.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE DEPS ARE SQL, NOT PRISMA, AND THAT IS NOT A SHORTCUT
 * ─────────────────────────────────────────────────────────────────────
 * The Playwright worker never loads Prisma (`e2e/sim/group.ts` talks
 * plain SQL), so the apply layers' injected dependencies are implemented
 * here against `grp.db`. That is the whole reason `score-engine.ts` and
 * `admin-ops-engine.ts` take their dependencies as arguments: the seam
 * that makes them unit-testable without a database is the same seam that
 * lets the corpus drive them against a real one.
 *
 * It does mean these SQL implementations are a SECOND implementation of
 * what the analyze route will inject, and a divergence between them
 * would not show up here. They are deliberately trivial — one statement
 * each, no branching — because every decision worth diverging on lives
 * in `engine.ts` and every branch worth diverging on lives in the apply
 * layers, both of which are shared.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY IT DECLARES THE CASES IT OWNS
 * ─────────────────────────────────────────────────────────────────────
 * Same reason pipeline #4 does. Both runners hand a message BACK to the
 * analyzer for a dozen documented reasons, and in production that is the
 * design — the mega-prompt is still standing. In-process there is no
 * mega-prompt, so a handed-back message would be scored as silence and
 * the case would fail, reporting a carve-out working exactly as intended
 * as a defect. The owned set is DECLARED, case by case, and the
 * scoreboard's own "N cases DID NOT RUN" banner then says so.
 */
import { anthropicModel } from "@/lib/pipeline/llm";
import { routeBatch } from "@/lib/pipeline/router";
import { runScoreBatch, type ScoreBatchMessage } from "@/lib/score-engine-batch";
import { runAdminOpsBatch, type AdminOpsBatchMessage } from "@/lib/admin-ops-engine-batch";
import type { ScoreApplyDeps } from "@/lib/score-engine";
import type { AdminOpsApplyDeps } from "@/lib/admin-ops-engine";
import type { Route } from "@/lib/pipeline/types";
import type { SimGroup } from "../sim/group";
import { loadStateViaSql } from "./dryrun-pipeline";
import type { CorpusCase, CorpusMessage, CorpusObservation } from "./grade";
import type { CorpusMode, CorpusPipeline, PipelineContext } from "./pipeline";
import { buildCorpusWorld, readMembers, readRows, readScore, readTeams } from "./world";

/**
 * The corpus cases these two routes own, and why the neighbouring ones
 * are not here. Every §3.2 S17 / S21 case in the corpus is accounted
 * for; nothing was left out silently.
 *
 *   S17    "Red won 5-3"            → owned (`score`)
 *   S17b   the first score of a
 *          TEAMS_PUBLISHED match    → owned (`score`) — the shape the
 *                                     old loader could not produce
 *   S21    admin credits 4 payments → owned (`admin_ops`, bulk_payment)
 *   S21b   a member cannot credit   → owned; asserts the refusal
 *   S22    "remind me on Monday"    → owned (`admin_ops`, reminder). The
 *                                     EXISTING corpus case, whose own
 *                                     `liveOnlyReason` says a hard-coded
 *                                     date goes stale on a calendar
 *                                     boundary — which is exactly what
 *                                     `resolveReminderPhrase` exists to
 *                                     stop being the model's problem.
 *   S22b   "remind me tomorrow
 *           at 6"                   → owned. Added here because the two
 *                                     exercise different branches of the
 *                                     resolver: a weekday name and a
 *                                     relative day plus a clock time.
 *   ADMIN-RECRUIT
 *          "message everyone from
 *           the last 5 matches"     → owned (`admin_ops`, recruit). The
 *                                     phrasing Kemal asked about, which
 *                                     before this change came back as
 *                                     `admin action "other" has no
 *                                     deterministic handler`. TAGGED.
 *   ADMIN-recruit-blast-untagged-needs-a-tag
 *          the same command with
 *          the tag taken off        → owned, and asserts the REFUSAL.
 *                                     2026-09-06: the route used to be
 *                                     this action's only gate, and on
 *                                     one real phrasing it is a coin
 *                                     flip (`admin_ops` 13/20). See
 *                                     `RECRUIT_BLAST_REQUIRES_TAG`.
 *   ADMIN-chase-nudge-is-not-a-recruit-blast
 *          "come on lads we need
 *           more players"           → owned, and expected to be HANDED
 *                                     BACK: the router says `none`
 *                                     20/20, so nothing here claims it.
 *                                     That is the pass. It is listed
 *                                     because the case has to fail
 *                                     LOUDLY if a nudge ever starts
 *                                     routing `admin_ops` and DMing the
 *                                     club — and an unowned case that
 *                                     nobody declared would instead be
 *                                     reported as "did not run".
 *
 *   PR33-recruit-ask-must-not-swallow-the-drop
 *                                   → NOT owned here. Its message is a
 *                                     third-party OUT plus a recruit
 *                                     ask, so it routes `other_att` and
 *                                     belongs to step 6's engine
 *                                     pipeline. This one performs no
 *                                     attendance write at all and would
 *                                     fail on the half of the case it is
 *                                     not responsible for.
 */
const OWNED_CASE_IDS = new Set([
  "S17-final-score-is-recorded",
  "S17b-first-score-on-a-published-match",
  "S21-bulk-payment-credit-by-admin",
  "S21b-bulk-payment-credit-from-non-admin-refused",
  "S22-reminder-request-queues-a-dm",
  "S22-reminder-request-is-queued-for-the-resolved-day",
  "ADMIN-recruit-blast-from-the-last-n-matches",
  "ADMIN-recruit-blast-untagged-needs-a-tag",
  "ADMIN-chase-nudge-is-not-a-recruit-blast",
]);

const ENABLED: Set<Route> = new Set<Route>(["score", "admin_ops"]);

export class WriteRoutesPipeline implements CorpusPipeline {
  readonly name = "write-routes-engine";

  /**
   * LIVE ONLY, for the same reason `DryRunPipeline` is: a stubbed run
   * would need hand-written FACTS, and the facts are exactly what the
   * model produces. Writing them myself would be grading my own answer
   * key. The deterministic coverage is `engine-write-routes.test.ts`,
   * `score-engine-batch.test.ts`, `admin-ops-engine-batch.test.ts` and
   * `reminder-time.test.ts`.
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
      completedMatchId: grp.completedMatchId,
      routes: [] as unknown[],
      owned: [] as string[],
      handedBack: [] as string[],
      reasons: [] as unknown[],
      recruit: [] as unknown[],
      statsBlast: [] as unknown[],
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

    const scoreDeps = sqlScoreDeps(grp);
    const adminDeps = sqlAdminDeps(grp);

    for (const turn of [...turns.keys()].sort((a, b) => a - b)) {
      const items = turns.get(turn)!;

      const base = items.map((m, i) => {
        const roster = typeof m.from === "string" ? grp.player(m.from) : null;
        return {
          waMessageId: `corpus-${turn}-${i}`,
          body: m.body,
          authorName: roster ? roster.name : (m.from as { name: string | null }).name,
          senderUserId: roster ? roster.userId : null,
          senderName: roster ? roster.name : (m.from as { name: string | null }).name,
          tagged: m.tag ?? false,
          route: undefined as Route | undefined,
          gated: false,
        };
      });

      // Stage 1 — the REAL router, the same call the analyze route makes.
      const routed = await routeBatch(
        model,
        base.map((m) => ({ id: m.waMessageId, authorName: m.authorName, body: m.body })),
      );
      const routeById = new Map(routed.routes.map((r) => [r.messageId, r.route]));
      for (const m of base) m.route = routeById.get(m.waMessageId);
      (notes.routes as unknown[]).push(
        ...routed.routes.map((r) => ({ id: r.messageId, route: r.route, source: r.source })),
      );
      notes.costUsd = (notes.costUsd as number) + (routed.usage?.costUsd ?? 0);
      (notes.degradations as string[]).push(
        ...routed.degradations.map((d) => `router: ${d.detail}`),
      );

      // BOTH runners see the whole window, and each owns only its own
      // route. That is what production will do: the flags are
      // independent, so a batch can legitimately have both on.
      const score = await runScoreBatch({
        orgId: grp.orgId,
        now,
        messages: base as ScoreBatchMessage[],
        history: [...history],
        enabled: ENABLED,
        deps: { model, loadState: async () => loadStateViaSql(grp), ...scoreDeps },
      });
      const admin = await runAdminOpsBatch({
        orgId: grp.orgId,
        now,
        messages: base as AdminOpsBatchMessage[],
        history: [...history],
        enabled: ENABLED,
        deps: { model, loadState: async () => loadStateViaSql(grp), ...adminDeps },
      });

      notes.costUsd = (notes.costUsd as number) + score.cost.usd + admin.cost.usd;
      (notes.degradations as string[]).push(...score.degradations, ...admin.degradations);

      const saidThisTurn: string[] = [];
      for (const m of base) {
        const out = score.outcomes.get(m.waMessageId) ?? admin.outcomes.get(m.waMessageId);
        if (out) {
          (notes.owned as string[]).push(`${m.waMessageId} ${out.route} ${out.intent}`);
          (notes.reasons as unknown[]).push({ id: m.waMessageId, reasoning: out.reasoning });
          if ("statsBlastRequest" in out && out.statsBlastRequest) {
            // Same deferral as the recruit blast below: production fires
            // this in the route's batch-final pass, so what the corpus
            // can assert is that the ask was RECOGNISED — and, for the
            // 2026-09-10 case, that it was not.
            (notes.statsBlast as unknown[]).push({ id: m.waMessageId });
          }
          if ("recruitRequest" in out && out.recruitRequest) {
            // The blast is NOT fired here, exactly as production defers
            // it to the batch-final pass. What the corpus can assert is
            // that the ask was RECOGNISED and carries a sane lookback.
            (notes.recruit as unknown[]).push({
              id: m.waMessageId,
              lookbackMatches: out.recruitLookbackMatches,
            });
          }
          if (out.reply) {
            spoken.push(out.reply);
            saidThisTurn.push(out.reply);
          }
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
      for (const s of saidThisTurn) history.push({ author: "MatchTime", body: s });
    }

    // Queued DMs are a real observation on this pipeline: a reminder IS
    // a `BotJob`, and a case that asserts one wants to see it.
    const dms = await grp.db.all<{ phone: string | null; text: string }>(
      `SELECT phone, text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' ORDER BY "createdAt" ASC`,
      [grp.orgId],
    );

    return {
      attendanceBefore,
      attendanceAfter: await readRows(grp),
      memberNamesBefore,
      memberNamesAfter: await readMembers(grp),
      spoken,
      dms: dms.map((d) => ({ to: d.phone, text: d.text })),
      reacts,
      benchOffersOpen: (
        await ctx.db.all<{ id: string }>(
          `SELECT id FROM "BenchSlotOffer" WHERE "matchId" = $1 AND "resolvedAt" IS NULL`,
          [grp.matchId],
        )
      ).length,
      scoreAfter: await readScore(grp),
      teamsBefore,
      teamsAfter: await readTeams(grp),
      notes,
    };
  }
}

// ── The injected dependencies, in plain SQL ───────────────────────────

function sqlScoreDeps(grp: SimGroup): ScoreApplyDeps {
  return {
    recordScore: async ({ matchId, red, yellow }) => {
      await grp.db.run(
        `UPDATE "Match" SET "redScore" = $2, "yellowScore" = $3, status = 'COMPLETED',
                            "updatedAt" = now()
          WHERE id = $1`,
        [matchId, red, yellow],
      );
    },
    loadEloInputs: async (matchId) =>
      grp.db.all<{ userId: string; team: "RED" | "YELLOW"; matchRating: number }>(
        `SELECT t."userId", t.team, u."matchRating"
           FROM "TeamAssignment" t JOIN "User" u ON u.id = t."userId"
          WHERE t."matchId" = $1`,
        [matchId],
      ),
    applyEloDeltas: async (deltas) => {
      for (const d of deltas) {
        await grp.db.run(`UPDATE "User" SET "matchRating" = $2 WHERE id = $1`, [
          d.userId,
          d.after,
        ]);
      }
    },
  };
}

function sqlAdminDeps(grp: SimGroup): AdminOpsApplyDeps & {
  reminderMutedUserIds: () => Promise<string[]>;
} {
  return {
    reminderMutedUserIds: async () =>
      (
        await grp.db.all<{ userId: string }>(
          `SELECT "userId" FROM "Membership"
            WHERE "orgId" = $1 AND "leftAt" IS NULL AND "subReminderDm" = false`,
          [grp.orgId],
        )
      ).map((r) => r.userId),
    loadPaidState: async (matchId) => {
      const meta = await grp.db.one<{ name: string }>(
        `SELECT a.name FROM "Match" m JOIN "Activity" a ON a.id = m."activityId" WHERE m.id = $1`,
        [matchId],
      );
      const confirmed = await grp.db.all<{ userId: string; name: string; paid: boolean }>(
        `SELECT att."userId", COALESCE(u.name, '(unnamed)') AS name,
                (att."paidAt" IS NOT NULL) AS paid
           FROM "Attendance" att JOIN "User" u ON u.id = att."userId"
          WHERE att."matchId" = $1 AND att.status = 'CONFIRMED'
          ORDER BY att.position ASC`,
        [matchId],
      );
      const credits = await grp.db.all<{ total: string | null }>(
        `SELECT SUM(count)::text AS total FROM "PaymentCredit" WHERE "matchId" = $1`,
        [matchId],
      );
      return {
        matchName: meta?.name ?? "the match",
        confirmed,
        creditTotal: Number(credits[0]?.total ?? 0),
      };
    },
    markPaid: async ({ matchId, userId, payerUserId }) => {
      await grp.db.run(
        `UPDATE "Attendance" SET "paidAt" = now(), "paidViaUserId" = $3, "updatedAt" = now()
          WHERE "matchId" = $1 AND "userId" = $2`,
        [matchId, userId, payerUserId],
      );
    },
    createPaymentCredit: async ({ matchId, payerUserId, recordedByUserId, count }) => {
      await grp.db.run(
        `INSERT INTO "PaymentCredit" (id, "matchId", "payerUserId", count, "recordedById", note)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          `pc-${matchId}-${payerUserId}-${count}`,
          matchId,
          payerUserId,
          count,
          recordedByUserId,
          "Recorded via WhatsApp (corpus)",
        ],
      );
    },
    loadPhone: async (userId) => {
      const row = await grp.db.one<{ phoneNumber: string | null }>(
        `SELECT "phoneNumber" FROM "User" WHERE id = $1`,
        [userId],
      );
      return row?.phoneNumber ?? null;
    },
    queueReminderDm: async ({ phone, text, sendAt }) => {
      await grp.db.run(
        `INSERT INTO "BotJob" (id, "orgId", kind, phone, text, "sendAfter")
         VALUES ($1, $2, 'dm', $3, $4, $5)`,
        [`bj-reminder-${grp.orgId}-${sendAt.getTime()}`, grp.orgId, phone, text, sendAt],
      );
    },
  };
}

export default WriteRoutesPipeline;
