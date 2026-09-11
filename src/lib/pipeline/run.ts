/**
 * THE PIPELINE, stitched together. DRY-RUN ONLY.
 *
 *   router → extractors → engine → composer
 *
 * §10 step 2: "Replace `analyzeWindow`'s payload with router →
 * extractors → engine in dry-run. Persist proposed writes to
 * `WindowVerdict.verdictJson`. Still zero writes."
 *
 * Nothing in this module writes to the database, sends a message,
 * queues a notification or touches the live analyze route. It returns a
 * PROPOSAL and a PROJECTION.
 *
 * ⚠️ THERE IS NO LONGER A SECOND PIPELINE TO DIFF AGAINST. That sentence
 * used to end "…and the harness persists them so the two pipelines can
 * be diffed over the same traffic", which was the whole point of this
 * module for three months. §10 step 8 deleted `analyzeBatch`, the
 * 19,850-token `SYSTEM_PROMPT` and `executeVerdict`, and retired the
 * shadow window-analyzer with them — there is nothing on the other side
 * of the diff (`window-analyzer.ts` carries the tombstone, and
 * `pipeline/shadow.ts`, which repointed the shadow harness at this dry
 * run, was deleted outright).
 *
 * WHAT THIS MODULE IS FOR NOW, and it is still worth having: it is the
 * only way to run router → extractors → engine → composer over real
 * traffic WITHOUT writing anything. Its two callers are
 * `scripts/dryrun-pipeline.ts` and `e2e/corpus/dryrun-pipeline.ts`,
 * which call `runPipeline` directly. Both cost real money and are run by
 * hand. (The `none`-bucket sweep does NOT come through here: it has its
 * own `toWindowShape` in `none-shadow.ts`.)
 *
 * The router is the only SERIAL dependency; extractors fan out (§11.4).
 */
import { clampPastedRosterFacts } from "../pasted-roster-registration";
import { compose, type ComposedOutput } from "./compose";
import { decide } from "./engine";
import { extractForRoute, extractorFor } from "./extractors";
import { anthropicModel, type PipelineModel } from "./llm";
import { routeBatch } from "./router";
import type {
  Degradation,
  EngineMessage,
  EngineResult,
  Facts,
  RoutedMessage,
  SquadState,
} from "./types";

export interface PipelineMessage {
  id: string;
  body: string;
  /** Display name as it appears in the group. */
  authorName: string | null;
  /** Resolved member id, or null for an unknown pushname / opaque @lid. */
  senderUserId: string | null;
  senderName?: string | null;
  /** The interaction-contract signal forwarded by the Pi. */
  tagged: boolean;
  /** The STRICTER signal, read only by the bulk-DM commands. Omitted →
   *  the engine derives it from the body. See `lib/stats-blast.ts`. */
  taggedExplicitly?: boolean;
}

export interface PipelineInput {
  messages: PipelineMessage[];
  history: Array<{ author: string | null; body: string }>;
  state: SquadState;
  now: Date;
  models?: { router: PipelineModel; extractor: PipelineModel };
}

export interface PipelineCost {
  routerUsd: number;
  extractorUsd: number;
  totalUsd: number;
  routerCalls: number;
  extractorCalls: number;
  routerMs: number;
  extractorMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface PipelineResult {
  routes: RoutedMessage[];
  facts: Array<{ messageId: string; facts: Facts }>;
  engine: EngineResult;
  composed: ComposedOutput;
  degradations: Degradation[];
  cost: PipelineCost;
  ms: number;
}

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const t0 = Date.now();
  const routerModel = input.models?.router ?? anthropicModel();
  const extractorModel = input.models?.extractor ?? anthropicModel();
  const degradations: Degradation[] = [];
  const cost: PipelineCost = {
    routerUsd: 0,
    extractorUsd: 0,
    totalUsd: 0,
    routerCalls: 0,
    extractorCalls: 0,
    routerMs: 0,
    extractorMs: 0,
    inputTokens: 0,
    outputTokens: 0,
  };

  // ── Stage 1 ────────────────────────────────────────────────────────
  const routed = await routeBatch(
    routerModel,
    input.messages.map((m) => ({ id: m.id, authorName: m.authorName, body: m.body })),
  );
  degradations.push(...routed.degradations);
  if (routed.usage) {
    cost.routerCalls = 1;
    cost.routerUsd += routed.usage.costUsd ?? 0;
    cost.routerMs += routed.usage.ms;
    cost.inputTokens += routed.usage.inputTokens;
    cost.outputTokens += routed.usage.outputTokens;
  }

  const routeById = new Map(routed.routes.map((r) => [r.messageId, r.route]));
  const lastBotPost =
    [...input.history].reverse().find((h) => (h.author ?? "").toLowerCase() === "matchtime")?.body ??
    null;

  // ── Stage 2 (parallel) ─────────────────────────────────────────────
  const extractions = await Promise.all(
    input.messages.map(async (m) => {
      const route = routeById.get(m.id) ?? "unsure";
      if (extractorFor(route) === "none") {
        return { messageId: m.id, facts: { kind: "none" } as Facts, degraded: null as string | null };
      }
      const res = await extractForRoute(extractorModel, route, {
        id: m.id,
        body: m.body,
        authorName: m.authorName,
        tagged: m.tagged,
        history: input.history,
        lastBotPost,
      });
      degradations.push(...res.degradations);
      if (res.usage) {
        cost.extractorCalls += 1;
        cost.extractorUsd += res.usage.costUsd ?? 0;
        cost.extractorMs = Math.max(cost.extractorMs, res.usage.ms); // parallel
        cost.inputTokens += res.usage.inputTokens;
        cost.outputTokens += res.usage.outputTokens;
      }
      // An extractor that FAILED (as opposed to one that found nothing)
      // must reach the engine as a degradation, not as silence.
      const failure = res.degradations.find((d) => /failed|could not be parsed/i.test(d.detail));
      return {
        messageId: m.id,
        facts: res.facts,
        degraded: failure ? failure.detail : null,
      };
    }),
  );

  // ── THE PASTED-ROSTER CLAMP, so the dry run tells the truth ────────
  //
  //   ADDED 2026-09-07, and it is a fix to this harness rather than a
  //   new rule. `attendance-engine-batch.ts` has always refused to let
  //   the engine read names off a pasted list (PR #39, PR #35's measured
  //   non-determinism: the same paste, the same world, a different squad
  //   each run). This module never applied it, so `scripts/
  //   dryrun-pipeline.ts` printed writes for case C12 — "1. Kemal / 2.
  //   Mustafa / …" — that production would never make, and its own
  //   expectation line says "CLAMPED — must not rewrite the squad
  //   wholesale (PR #39)". A dry run that disagrees with production on
  //   the shape it is being used to investigate is worse than no dry
  //   run.
  //
  //   `clampPastedRosterFacts` is the single source of that rule and
  //   both callers use it, so the two cannot drift. What it keeps is the
  //   sender's own OUT and nothing else — read its header for why that
  //   one claim and no other.
  //
  //   WHAT IS STILL NOT MODELLED HERE, said plainly: the route's own
  //   pasted-roster arithmetic (`reconcilePastedRoster`, which registers
  //   the appended names) and the vCard refusal. This module is router →
  //   extractors → engine → composer, not the route, and neither of
  //   those lives in it.
  const clamped = extractions.map((e) => {
    const m = input.messages.find((x) => x.id === e.messageId);
    const c = clampPastedRosterFacts(m?.body, e.facts);
    return c.facts === e.facts ? e : { ...e, facts: c.facts };
  });

  const factsById = new Map(clamped.map((e) => [e.messageId, e]));

  // ── Stage 3 ────────────────────────────────────────────────────────
  const engineMessages: EngineMessage[] = input.messages.map((m) => {
    const e = factsById.get(m.id);
    return {
      id: m.id,
      body: m.body,
      senderUserId: m.senderUserId,
      senderName: m.senderName ?? m.authorName,
      tagged: m.tagged,
      ...(m.taggedExplicitly === undefined ? {} : { taggedExplicitly: m.taggedExplicitly }),
      route: routeById.get(m.id) ?? "unsure",
      facts: e?.facts ?? { kind: "none" },
      degraded: e?.degraded ?? null,
    };
  });

  const engine = decide({ messages: engineMessages, state: input.state, now: input.now });
  degradations.push(...engine.degradations);

  // ── Stage 4 ────────────────────────────────────────────────────────
  const composed = compose(engine);

  cost.totalUsd = cost.routerUsd + cost.extractorUsd;

  return {
    routes: routed.routes,
    // The CLAMPED facts, deliberately: this array is what the harness
    // prints, and printing a claim the engine was never shown is how a
    // dry run misleads the person reading it.
    facts: clamped.map((e) => ({ messageId: e.messageId, facts: e.facts })),
    engine,
    composed,
    degradations,
    cost,
    ms: Date.now() - t0,
  };
}
