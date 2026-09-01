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
 * PROPOSAL and a PROJECTION, and the harness persists them so the two
 * pipelines can be diffed over the same traffic.
 *
 * The router is the only SERIAL dependency; extractors fan out (§11.4).
 */
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

  const factsById = new Map(extractions.map((e) => [e.messageId, e]));

  // ── Stage 3 ────────────────────────────────────────────────────────
  const engineMessages: EngineMessage[] = input.messages.map((m) => {
    const e = factsById.get(m.id);
    return {
      id: m.id,
      body: m.body,
      senderUserId: m.senderUserId,
      senderName: m.senderName ?? m.authorName,
      tagged: m.tagged,
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
    facts: extractions.map((e) => ({ messageId: e.messageId, facts: e.facts })),
    engine,
    composed,
    degradations,
    cost,
    ms: Date.now() - t0,
  };
}
