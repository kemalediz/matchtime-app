/**
 * F3, LEARNED SETUP: WHOSE PRICE IS IT? (2026-10-30, the last of the
 * no-string-parsing sweep.)
 *
 * The setup reading reports the match fee: an amount and the quotes that
 * state it. Whether that amount is what EACH PLAYER pays or what the WHOLE
 * PITCH costs used to be decided by a word list in rules.ts (pitch, total,
 * each, per head, kişi başı: `pricesIn`, `statesPrice`). Kemal: no string
 * parsing. It is now this one short model call.
 *
 * Why its own call and not a field of the reading: adding the field to the
 * reading's prompt and schema measured worse on a question it does not
 * share (organisers pick: main 3 of 7, with the field 1 of 8). The reading's
 * prompt stays byte-identical; this call sees only the amount and its
 * quotes, so it cannot move anything else.
 *
 * Asked ONLY when there is something to ask about (`feeBasisCandidate`): a
 * pounds amount in range with at least one quote holding the number. Most
 * readings have no fee and make no second call. Every failure is "unclear",
 * and rules.ts keeps a fee only on "per_player": a broken call suggests no
 * fee, never a wrong one.
 */
import { HAIKU_EFFORT, HAIKU_MODEL, HAIKU_SHORT_ANSWER_MAX_TOKENS } from "../models";
import { extractJson, type PipelineModel } from "../pipeline/llm";
import { MAX_MATCH_FEE, MIN_MATCH_FEE, quoteHasAmount } from "./rules";

export const FEE_BASIS_MODEL = HAIKU_MODEL;

export const FEE_BASIS_SYSTEM_PROMPT = `A WhatsApp group that plays a regular football game wrote a price. You get the amount and the excerpts of the chat that state it, in English, Turkish or both. Say whose price it is:
- "per_player": what each player pays for one game ("£6 each", "7.50 a head", "it's £7 each now the pitch went up", "kişi başı £7").
- "whole_pitch": what the pitch or the booking costs for everyone together, even when the message says it is split between the players ("Pitch is £45 a week", "£60 for the hour, we split it", "saha toplam £45").
- "unclear": neither, or you cannot tell from the excerpts.

Answer with the JSON object only: {"basis": "per_player" | "whole_pitch" | "unclear", "reasoning": "<max 80 chars>"}`;

export const FEE_BASIS_SCHEMA = {
  type: "object",
  properties: {
    basis: { type: "string", enum: ["per_player", "whole_pitch", "unclear"] },
    reasoning: { type: "string" },
  },
  required: ["basis", "reasoning"],
  additionalProperties: false,
} as const;

export type FeeBasis = "per_player" | "whole_pitch" | "unclear" | "none";

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The amount and the quotes that hold it, or null: nothing to ask about. */
export function feeBasisCandidate(raw: unknown): { amount: number; quotes: string[] } | null {
  const fee = obj(obj(raw).match_fee);
  const amount = typeof fee.amount === "number" && Number.isFinite(fee.amount) ? Math.round(fee.amount * 100) / 100 : 0;
  if (fee.currency !== "pounds" || amount < MIN_MATCH_FEE || amount > MAX_MATCH_FEE) return null;
  const quotes = (Array.isArray(fee.evidence) ? fee.evidence : []).filter(
    (q): q is string => typeof q === "string" && quoteHasAmount(q, amount),
  );
  return quotes.length > 0 ? { amount, quotes } : null;
}

/** The model's answer. Also accepts a test stub that answers every call
 *  with the whole reading (its `match_fee.basis`). */
function parseBasis(text: string): FeeBasis {
  let o: Record<string, unknown>;
  try {
    o = obj(extractJson(text));
  } catch {
    return "unclear";
  }
  const b = o.basis ?? obj(o.match_fee).basis;
  return b === "per_player" || b === "whole_pitch" ? b : "unclear";
}

/**
 * The reading with `match_fee.basis` set: "none" with no call when there is
 * no candidate, otherwise what the model said ("unclear" on any failure).
 * Returns the extra call's count and cost for the run's record.
 */
export async function withFeeBasis(
  raw: unknown,
  model: PipelineModel,
): Promise<{ raw: unknown; calls: number; costUsd: number; inputTokens: number; outputTokens: number }> {
  const none = { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
  const o = obj(raw);
  if (!o.match_fee || typeof o.match_fee !== "object") return { raw, ...none };
  const set = (basis: FeeBasis) => ({ ...o, match_fee: { ...obj(o.match_fee), basis } });
  const cand = feeBasisCandidate(raw);
  if (!cand) return { raw: set("none"), ...none };
  try {
    const resp = await model.complete({
      model: FEE_BASIS_MODEL,
      system: FEE_BASIS_SYSTEM_PROMPT,
      user: `Amount: ${cand.amount}\nExcerpts:\n${cand.quotes.map((q) => `- ${q}`).join("\n")}`,
      maxTokens: HAIKU_SHORT_ANSWER_MAX_TOKENS,
      schema: FEE_BASIS_SCHEMA as unknown as Record<string, unknown>,
      thinking: { effort: HAIKU_EFFORT },
      cache: false,
      label: "setup-fee-basis",
    });
    return {
      raw: set(parseBasis(resp.text)),
      calls: 1,
      costUsd: resp.costUsd ?? 0,
      inputTokens: resp.usage.inputTokens + resp.usage.cacheReadTokens + resp.usage.cacheWriteTokens,
      outputTokens: resp.usage.outputTokens,
    };
  } catch (err) {
    console.error("[setup-learning] fee basis read failed; no fee is suggested:", err instanceof Error ? err.message : "failed");
    return { raw: set("unclear"), calls: 1, costUsd: 0, inputTokens: 0, outputTokens: 0 };
  }
}
