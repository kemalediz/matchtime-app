/**
 * A METERED MODEL FOR ONE ARM OF A PAID PROMPT CHECK (2026-10-20).
 *
 * The prompt rewrites run each site's cases on several arms (the live
 * prompt on Sonnet 5, the new prompt on Sonnet 5, the new prompt on
 * Haiku 5.5). This wraps the real `anthropicModel` so one script can run
 * any arm: it puts the arm's model id and thinking posture
 * (`SONNET_CALL` / `HAIKU_CALL`, the same values the sites ship) on every
 * request, records each call's latency, tokens, cost and stop reason, and
 * refuses to spend past a cap. Never use it outside a script started on
 * the dev key (`spendDevApiKeyOrExit`).
 */
import { anthropicModel, HAIKU_CALL, SONNET_CALL, type ModelCall, type PipelineModel } from "../../src/lib/pipeline/llm";

export const ARMS: Record<string, ModelCall> = { sonnet: SONNET_CALL, haiku: HAIKU_CALL };

export interface CallRecord {
  label: string;
  model: string;
  ms: number;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  stopReason: string | null;
  /** The response carried no text at all (the thinking-runaway shape). */
  empty: boolean;
  /** The model's raw text, before any code touched it. */
  raw: string;
  error?: string;
}

export function armModel(arm: ModelCall, maxUsd: number): { model: PipelineModel; calls: CallRecord[]; usd: () => number } {
  const inner = anthropicModel();
  const calls: CallRecord[] = [];
  const usd = () => calls.reduce((s, c) => s + c.usd, 0);
  const model: PipelineModel = {
    name: `arm:${arm.model}`,
    async complete(req) {
      if (usd() >= maxUsd) throw new Error(`stopped at $${maxUsd}`);
      const t0 = Date.now();
      try {
        const r = await inner.complete({ ...req, ...arm });
        calls.push({
          label: req.label,
          model: arm.model,
          ms: r.ms,
          usd: r.costUsd ?? 0,
          inputTokens: r.usage.inputTokens,
          outputTokens: r.usage.outputTokens,
          cacheReadTokens: r.usage.cacheReadTokens,
          cacheWriteTokens: r.usage.cacheWriteTokens,
          stopReason: r.stopReason,
          empty: !r.text.trim(),
          raw: r.text,
        });
        return r;
      } catch (err) {
        calls.push({
          label: req.label,
          model: arm.model,
          ms: Date.now() - t0,
          usd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          stopReason: null,
          empty: true,
          raw: "",
          error: (err as Error).message,
        });
        throw err;
      }
    },
  };
  return { model, calls, usd };
}

/** Median and 90th percentile of the calls' latency, in ms. */
export function latency(calls: CallRecord[]): { p50: number; p90: number } {
  const ms = calls.map((c) => c.ms).sort((a, b) => a - b);
  const at = (q: number) => (ms.length ? ms[Math.min(ms.length - 1, Math.ceil(q * ms.length) - 1)] : 0);
  return { p50: at(0.5), p90: at(0.9) };
}
