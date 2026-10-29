/**
 * THE COLLECTOR'S ANSWER TO "N SAY THEY'VE PAID" (2026-10-29). MatchTime
 * lists the month's paid claims to the money collector, numbered by each
 * player's place on the month's list; he answers which money arrived. His
 * answer was read by a fixed vocabulary ("PAID ALL", "PAID 1 3", "PAID
 * NONE"); now a model reads it, with the list he was sent as context
 * (Kemal: no code reads what people mean). Code then confirms exactly the
 * claims that list named (`month-payment.ts`, `decideCollectorReply`).
 *
 * Asked only when the sender may confirm payments and a list is out for
 * him: one indexed query decides that for everybody else, with no call.
 * Fail safe: unsure, failed or unreadable is null, and nothing is marked.
 */
import { dmClassifierStubCall } from "./dm-classifier-stub";
import { anthropicModel, extractJson, HAIKU_CALL, type ModelCall, type PipelineModel } from "./pipeline/llm";
import type { CollectorReply } from "./month-payment-rules";

export const DIGEST_REPLY_CALL: ModelCall = HAIKU_CALL;
const LABEL = "month-digest-reply";
const HEADER = "HIS MESSAGE:";

export interface DigestShown {
  /** 1 to 12. */
  month: number;
  monthName: string;
  /** The lines he was sent: the number on the month's list and the name. */
  lines: Array<{ slot: number | null; name: string }>;
}

export const DIGEST_REPLY_SYSTEM = `MatchTime, a football club's WhatsApp bot, sent the club's money collector a list of the players who say they have paid for the month, each with their number on the month's list, and asked him which payments have arrived. You get that list (or lists, one per month) and his message under "${HEADER}". Is his message his answer, and what does it say?

answer:
- "all": every payment on the list has arrived ("PAID ALL", "all in", "yes all received", "ÖDENDİ HEPSİ", "hepsi geldi").
- "numbers": only some have arrived: put their numbers from the list in "numbers" ("PAID 1 3", "1 and 3 are in", "ÖDENDİ 1 3"). A name on the list counts as its number ("Steff and Ben" are the numbers those two have).
- "none": none of them has arrived ("PAID NONE", "nothing yet", "ÖDENDİ HİÇBİRİ", "hiçbiri gelmedi").
- "other": anything else: a question, a different subject, a message that is not an answer about these payments, an amount somebody says they paid ("paid £30" is a player's own claim, not his answer), or a bare number with no word about money.

month: the month he names (1 to 12) when lists for more than one month are out and he says which ("PAID NOVEMBER ALL"); 0 otherwise.

If you are not at least 80% sure, choose "other": a wrong answer marks money as received that never came, while "other" changes nothing.

Output STRICT JSON only, no markdown, no fences.`;

const SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", enum: ["all", "numbers", "none", "other"] },
    numbers: { type: "array", items: { type: "integer" } },
    month: { type: "integer" },
    confidence: { type: "number" },
  },
  required: ["answer", "numbers", "month", "confidence"],
  additionalProperties: false,
} as const;

export function buildDigestReplyUserTurn(digests: DigestShown[], text: string): string {
  const blocks = digests.map((d) => [`THE LIST FOR ${d.monthName.toUpperCase()} (month ${d.month}):`, ...d.lines.map((l) => `  ${l.slot ?? "?"}. ${l.name}`)].join("\n"));
  return [...blocks, `${HEADER}\n${text.trim()}`].join("\n\n");
}

/** PURE. The JSON, checked. Null: not an answer. */
export function parseDigestReply(raw: string): CollectorReply | null {
  let o: Record<string, unknown>;
  try {
    const parsed = extractJson(raw);
    if (!parsed || typeof parsed !== "object") return null;
    o = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof o.confidence !== "number" || o.confidence < 0.8) return null;
  const month = typeof o.month === "number" && Number.isInteger(o.month) && o.month >= 1 && o.month <= 12 ? { month: o.month } : {};
  if (o.answer === "all") return { kind: "all", ...month };
  if (o.answer === "none") return { kind: "none", ...month };
  if (o.answer !== "numbers") return null;
  const numbers = [...new Set((Array.isArray(o.numbers) ? o.numbers : []).filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 99))];
  return numbers.length > 0 ? { kind: "numbers", numbers, ...month } : null;
}

export const DIGEST_REPLY_STUB_FILE_ENV = "MT_TEST_DIGEST_REPLY_STUB_FILE";

function stubModel(env: NodeJS.ProcessEnv): PipelineModel | null {
  const call = dmClassifierStubCall(env[DIGEST_REPLY_STUB_FILE_ENV], {
    label: LABEL,
    header: HEADER,
    answer: (label) => label ?? JSON.stringify({ answer: "other", numbers: [], month: 0, confidence: 1 }),
  });
  if (!call) return null;
  return {
    name: "digest-reply-stub",
    complete: async (req) => ({ text: await call(req.system, req.user), stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 0 }),
  };
}

/** Read his message against the lists he was sent. Never throws. */
export async function readDigestReply(digests: DigestShown[], text: string, deps?: { model?: PipelineModel | null }): Promise<CollectorReply | null> {
  if (!text?.trim() || digests.length === 0) return null;
  const model = deps?.model === undefined ? (stubModel(process.env) ?? (process.env.ANTHROPIC_API_KEY?.trim() ? anthropicModel() : null)) : deps.model;
  if (!model) return null;
  try {
    const resp = await model.complete({
      ...DIGEST_REPLY_CALL,
      system: DIGEST_REPLY_SYSTEM,
      user: buildDigestReplyUserTurn(digests, text),
      maxTokens: 1_024,
      schema: SCHEMA as unknown as Record<string, unknown>,
      // A few times a month: a 1-hour cache write would cost more than it saves.
      cache: false,
      label: LABEL,
    });
    return parseDigestReply(resp.text);
  } catch (err) {
    console.error(`[${LABEL}] read failed:`, err instanceof Error ? err.message : "failed");
    return null;
  }
}
