/**
 * THE MIGRATION HARNESS — §10 step 2, "repoint the shadow".
 *
 * `window-analyzer.ts` + `WindowVerdict` + `/admin/shadow` already give
 * us a second analysis of the same window fired via `after()` (so it
 * cannot affect the live path), batch-hash dedupe, a daily cost cap,
 * per-call `costUsd`, and a side-by-side dashboard. §7.1 is generous
 * about why that was worth building and honest about why it stalled:
 * "it changed the GRANULARITY of the decision but not WHO decides."
 *
 * This module repoints it. Same harness, same table, same dashboard —
 * but the payload is now router → extractors → engine in DRY RUN, so
 * what gets persisted is a PROPOSAL made by code from facts, not a
 * second opinion from a second prompt.
 *
 * STILL ZERO WRITES. Nothing here calls `registerAttendance`, queues a
 * BotJob, or sends anything. The only row it creates is the
 * `WindowVerdict` the harness already created.
 *
 * BACKWARD COMPATIBLE ON PURPOSE. `/admin/shadow` reads
 * `verdictJson.{windowSummary, stateChanges, reactions, groupReply}`.
 * The proposal is projected onto exactly that shape so the existing
 * dashboard keeps working with no change, and the full detail (routes,
 * facts, proposed writes, degradations, measured cost) rides along
 * under `proposal` for the diff §10 step 3 is read from.
 */
import { messageTagsBot } from "../interaction-contract";
import type { BatchInputHistory, BatchInputMessage } from "../message-analyzer";
import { resolvePerson } from "./identity";
import { loadSquadState } from "./load-state";
import { anthropicModel, type PipelineModel } from "./llm";
import { runPipeline, type PipelineMessage, type PipelineResult } from "./run";
import type { SquadState, WindowShapedVerdict } from "./types";

/**
 * Which analysis the shadow harness runs.
 *
 *   window  the 2026-05-29 one-coherent-diff prompt (the default, so
 *           turning the shadow on does not silently change what it is)
 *   v2      router → extractors → engine, dry run
 *
 * Default `window` rather than `v2` for the same reason
 * `SHADOW_ANALYZER_ENABLED` defaults off: an operator who flips one
 * switch should get exactly the thing they asked for.
 */
export function shadowPipelineMode(): "window" | "v2" {
  const raw = process.env.SHADOW_PIPELINE?.trim().toLowerCase();
  return raw === "v2" || raw === "pipeline" ? "v2" : "window";
}

export interface DryRunShadowInput {
  orgId: string;
  messages: BatchInputMessage[];
  history: BatchInputHistory[];
  now?: Date;
  models?: { router: PipelineModel; extractor: PipelineModel };
  /** Injectable so the wiring is testable without a database. */
  loadState?: (orgId: string, now: Date) => Promise<SquadState>;
}

export interface DryRunShadowResult {
  /** What goes in `WindowVerdict.verdictJson`. */
  payload: WindowShapedVerdict;
  costUsd: number;
  modelMs: number;
  result: PipelineResult;
}

export async function runDryRunShadow(
  input: DryRunShadowInput,
): Promise<DryRunShadowResult> {
  const now = input.now ?? new Date();
  const load = input.loadState ?? loadSquadState;
  const state = await load(input.orgId, now);

  const messages: PipelineMessage[] = input.messages.map((m) => ({
    id: m.waMessageId,
    body: m.body,
    authorName: m.authorName,
    senderUserId: resolveSender(m, state),
    senderName: m.authorName,
    // The harness's input carries no structured `botMentioned` (the Pi
    // sends it to the live route, not here), so this falls back to the
    // TEXT tag. `messageTagsBot` was hardened for exactly that case
    // after the 2026-06-29 @lid self-mention incident, and a shadow that
    // under-reports tags would under-report actions, which is the
    // direction that hides problems. Worth fixing before step 5.
    tagged: messageTagsBot({ body: m.body }),
  }));

  const routerModel = input.models?.router ?? anthropicModel();
  const extractorModel = input.models?.extractor ?? anthropicModel();

  const result = await runPipeline({
    messages,
    history: input.history.map((h) => ({ author: h.authorName, body: h.body })),
    state,
    now,
    models: { router: routerModel, extractor: extractorModel },
  });

  return {
    payload: toWindowShape(result),
    costUsd: result.cost.totalUsd,
    modelMs: result.cost.routerMs + result.cost.extractorMs,
    result,
  };
}

/** Prefer the id the route already resolved; otherwise resolve the
 *  pushname against the roster with the same pure resolver the engine
 *  uses. Never invents a member. */
function resolveSender(m: BatchInputMessage, state: SquadState): string | null {
  if (m.authorUserId) return m.authorUserId;
  if (!m.authorName) return null;
  const r = resolvePerson(m.authorName, state.roster);
  return r.kind === "resolved" ? r.member.userId : null;
}

/**
 * Project the proposal onto the shape `/admin/shadow` already renders,
 * and carry the full detail alongside it.
 */
export function toWindowShape(result: PipelineResult): WindowShapedVerdict {
  const stateChanges = result.engine.writes
    .filter((w) => w.kind === "attendance")
    .map((w) => ({
      action:
        w.status === "DROPPED"
          ? ("drop" as const)
          : w.status === "BENCH"
            ? ("bench" as const)
            : ("add" as const),
      targetName: w.name,
      targetUserId: w.userId,
      reason: w.reason,
    }));

  const acted = result.engine.outcomes.filter((o) => o.disposition === "acted").length;
  const degraded = result.engine.outcomes.filter((o) => o.disposition === "degraded").length;
  const routes = result.routes.map((r) => r.route);
  const noneCount = routes.filter((r) => r === "none").length;

  const windowSummary =
    `${result.engine.outcomes.length} message(s): ${noneCount} banter, ${acted} acted, ` +
    `${degraded} degraded. ${result.engine.writes.length} proposed write(s), ` +
    `$${result.cost.totalUsd.toFixed(5)}.`;

  return {
    windowSummary,
    stateChanges,
    reactions: result.composed.reacts.map((r) => ({
      waMessageId: r.messageId,
      emoji: r.emoji,
      kind: "ack",
    })),
    groupReply: result.composed.utterances.map((u) => u.text).join("\n\n") || null,
    // Everything the older shape cannot hold. This is the artefact §10
    // step 3 is read from.
    pipeline: "dryrun-v2",
    proposal: {
      routes: result.routes,
      facts: result.facts,
      writes: result.engine.writes,
      outcomes: result.engine.outcomes,
      speech: result.engine.speech,
      utterances: result.composed.utterances,
      operatorNotes: result.composed.operatorNotes,
      degradations: result.degradations,
      cost: result.cost,
    },
  };
}
