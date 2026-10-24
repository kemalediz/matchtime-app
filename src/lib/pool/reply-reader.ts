/**
 * A POOL PLAYER'S REPLY TO HIS OWN OFFER, READ BY THE MODEL (slice L6,
 * 2026-10-24). Plan 5.3: a small closed-answer reader, shaped like
 * `pairing-reply.ts` and `volunteer-name-reply.ts`. One plain task: given
 * the offers MatchTime sent him (their exact words and state), what does his
 * reply mean? accept, decline, stop, question or neither, with a confidence.
 *
 * It decides nothing. `reply-rules.ts` decides what is done (the floor, the
 * re-ask, proof, which offer); `reply.ts` does it. Every failure (no key, a
 * failed or cut-off call, an answer off the contract) is "neither" with no
 * confidence, which changes nothing and keeps today's one line.
 *
 * WHAT THE MODEL SEES (privacy, plan section 6): only this person's own
 * offers, as they were sent to him, with every link replaced by "<link>"
 * (the tap link is signed, the stop link signs him in), his reply, the time,
 * and the NAME of his own club if he has one. Never another person, never a
 * number. Named in the pool source guard's `POOL_MODEL_READERS`.
 *
 * One Haiku 5.5 call per reply (`HAIKU_CALL`, budget-guarded, structured
 * output). No database here, so `scripts/live-check-pool-reply.ts` imports
 * the exact production prompt without Prisma.
 */
import { dmClassifierStubCall } from "../dm-classifier-stub";
import { formatLondon } from "../london-time";
import { HAIKU_SHORT_ANSWER_MAX_TOKENS } from "../models";
import { anthropicModel, extractJson, HAIKU_CALL, type ModelCall, type PipelineModel } from "../pipeline/llm";
import { POOL_REPLY_INTENTS, type OfferReplyState, type PoolReplyIntent } from "./reply-rules";

/** The model and thinking posture, pinned. Exported for the paid check. */
export const POOL_REPLY_CALL: ModelCall = HAIKU_CALL;
const LABEL = "pool-reply";
const REPLY_HEADER = "HIS REPLY:";

export const POOL_REPLY_SYSTEM_PROMPT = `Someone in the MatchTime player pool sent MatchTime, a WhatsApp bot, the private message under "${REPLY_HEADER}". MatchTime finds local games that are short of players and privately offers the place to nearby pool players, who reply in their own words. Above his reply you get the time now, whether he also plays for a club of his own, the game offers MatchTime sent him (newest first, each with its state and its exact words), and which offer he swipe-replied to, if any.

Read his reply against those offers and say what he means. Pick one:
- "accept": he wants the place. Yes, I'm in, count me in, a thumbs up, or a yes with a question ("yes, where do I park?").
- "decline": he does not want this place, or, for a place he has already taken, he can no longer come. No, not this time, busy that night, can't make it any more.
- "stop": he wants no more game offers at all. Stop sending these, take me off the list, unsubscribe. A no to one game is "decline", not "stop".
- "question": he asks about the game before deciding: where it is, parking, the fee, the level, how long. MatchTime then sends him the offer's facts again; it cannot answer anything else.
- "neither": anything else. Thanks, a greeting, banter, a message about something other than these offers, a message about his own club's games, or something you cannot read.

How to read it:
- Read the reply as a whole. Typos and slang count ("yh go on", "im in", "nah mate"). Sarcasm is not a yes ("oh great, 11pm on a Tuesday, can't wait").
- A swipe-reply is about the offer it quotes. A plain message is about his offers only when its words fit them. If he has a club of his own, a message that could just as well be about his own club's games is "neither".
- For an offer that has ended, still say what he means; MatchTime decides what to do with it.
- Mixed messages: stop wins ("no thanks, and stop messaging me" is "stop"); a clear yes or no wins over a question ("no, but where is it anyway?" is "decline").
- Turkish is as common as English: read it the same way.

Examples (English | Turkish):
accept: "yes" | "evet"; "I'm in" | "varım"; "count me in 👍" | "beni yaz"; "go on then, I'll come" | "olur, gelirim"; "yes please, is there parking?" | "tamam geliyorum, otopark var mı?"
decline: "no thanks" | "hayır, sağ ol"; "can't make it" | "gelemem"; "busy that night" | "o akşam işim var"; "sorry, I can't come any more" (a place he took) | "artık gelemiyorum"
stop: "stop sending me these" | "bana bu mesajları atma artık"; "take me off the list" | "beni listeden çıkar"; "no more game offers please" | "maç teklifi göndermeyin"
question: "where is it?" | "nerede?"; "is there parking?" | "otopark var mı?"; "how much is it?" | "ücret ne kadar?"; "what level is it?" | "seviye nasıl?"
neither: "thanks" | "teşekkürler"; "hello?" | "merhaba"; "who is this?" | "kimsin?"; "haha nice" | "haha güzel"; "is our Tuesday game on?" (his own club) | "salı maçımız var mı?"

Confidence is how sure you are, from 0 to 1. Below 0.8 MatchTime asks him once more instead of acting. A wrong "accept" books him onto a stranger's team, a wrong "decline" or "stop" loses a player who wanted to play, and a wrong "neither" costs him one more message, the cheapest mistake.

Answer with the JSON object only: {"intent": one of the five, "confidence": a number from 0 to 1, "reasoning": at most 100 characters}`;

/** Structured output (`output_config.format`). */
export const POOL_REPLY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    intent: { type: "string", enum: [...POOL_REPLY_INTENTS] },
    confidence: { type: "number" },
    reasoning: { type: "string" },
  },
  required: ["intent", "confidence", "reasoning"],
  additionalProperties: false,
};

export interface PoolReplyContext {
  now: Date;
  /** The name of his own club (a live ordinary membership), or null. */
  ownClub: string | null;
  /** His offers in question, newest first, as sent. */
  offers: Array<{ state: OfferReplyState; sentAt: Date; text: string }>;
  /** Index into `offers` of the one he swipe-replied to, or null. */
  quotedIndex: number | null;
}

export interface PoolReplyReading {
  intent: PoolReplyIntent;
  confidence: number;
  reasoning: string;
}

const STATE_LINE: Record<OfferReplyState, string> = {
  open: "open, he has not answered it yet",
  taken: "taken, he said yes and holds this place",
  ended: "ended, the place can no longer be taken",
};

const when = (d: Date) => formatLondon(d, "EEE d MMM, HH:mm");
/** Every link, signed or not, is hidden from the model. */
const withoutLinks = (text: string) => text.replace(/https?:\/\/\S+/g, "<link>");

export function buildPoolReplyUserTurn(text: string, ctx: PoolReplyContext): string {
  const offers = ctx.offers.map((o, i) => `[${i + 1}] Sent ${when(o.sentAt)}. State: ${STATE_LINE[o.state]}.\n${withoutLinks(o.text).trim()}`);
  return [
    `Time now: ${when(ctx.now)} (London)`,
    `His own club: ${ctx.ownClub ? `${ctx.ownClub} (MatchTime also messages him about its games)` : "none"}`,
    `Game offers MatchTime sent him, newest first:\n${offers.length ? offers.join("\n\n") : "(none)"}`,
    `He swipe-replied to: ${ctx.quotedIndex === null ? "nothing (a plain message)" : `offer [${ctx.quotedIndex + 1}]`}`,
    `${REPLY_HEADER}\n${text.trim()}`,
  ].join("\n\n");
}

const NEITHER = (reasoning: string): PoolReplyReading => ({ intent: "neither", confidence: 0, reasoning });

/** The JSON contract. Exported for unit tests. (pure) */
export function parsePoolReply(raw: string): PoolReplyReading {
  let obj: Record<string, unknown>;
  try {
    const parsed = extractJson(raw);
    if (!parsed || typeof parsed !== "object") return NEITHER("not an object");
    obj = parsed as Record<string, unknown>;
  } catch {
    return NEITHER("parse failed");
  }
  const intent = typeof obj.intent === "string" && (POOL_REPLY_INTENTS as readonly string[]).includes(obj.intent) ? (obj.intent as PoolReplyIntent) : null;
  if (!intent) return NEITHER("no valid answer");
  const confidence = typeof obj.confidence === "number" && Number.isFinite(obj.confidence) ? Math.max(0, Math.min(1, obj.confidence)) : 0;
  const reasoning = typeof obj.reasoning === "string" ? obj.reasoning.slice(0, 200) : "";
  return { intent, confidence, reasoning };
}

/**
 * TEST-ONLY seam, as the sibling DM readers have: what the model would have
 * said, keyed by the reply body, read from a file. Labels: an intent, or
 * "low:<intent>" for an unsure one (confidence 0.5); no mapping is
 * "neither". `e2e/helpers/live-llm.ts` refuses a live run that can see it.
 */
export const POOL_REPLY_STUB_FILE_ENV = "MT_TEST_POOL_REPLY_STUB_FILE";

function stubModel(env: NodeJS.ProcessEnv): PipelineModel | null {
  const call = dmClassifierStubCall(env[POOL_REPLY_STUB_FILE_ENV], {
    label: LABEL,
    header: REPLY_HEADER,
    answer: (label) => {
      const low = label?.startsWith("low:") ?? false;
      const intent = low ? label!.slice(4) : (label ?? "neither");
      return JSON.stringify({ intent, confidence: low ? 0.5 : 1, reasoning: "pool-reply stub" });
    },
  });
  if (!call) return null;
  return {
    name: "pool-reply-stub",
    complete: async (req) => ({
      text: await call(req.system, req.user),
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0,
      ms: 0,
    }),
  };
}

function defaultModel(): PipelineModel | null {
  return stubModel(process.env) ?? (process.env.ANTHROPIC_API_KEY?.trim() ? anthropicModel() : null);
}

/**
 * Read his reply, once. `deps.model` undefined uses the real model (or the
 * e2e stub), null asserts there is none. Never throws.
 */
export async function readPoolReply(text: string, ctx: PoolReplyContext, deps?: { model?: PipelineModel | null }): Promise<PoolReplyReading> {
  if (!text?.trim()) return NEITHER("empty reply");
  const model = deps?.model === undefined ? defaultModel() : deps.model;
  if (!model) return NEITHER("reader unavailable");
  try {
    const resp = await model.complete({
      ...POOL_REPLY_CALL,
      system: POOL_REPLY_SYSTEM_PROMPT,
      user: buildPoolReplyUserTurn(text, ctx),
      maxTokens: HAIKU_SHORT_ANSWER_MAX_TOKENS,
      schema: POOL_REPLY_SCHEMA,
      label: LABEL,
    });
    return parsePoolReply(resp.text);
  } catch (err) {
    // FAIL SAFE: nothing booked, declined or stopped; today's line instead.
    console.error(`[${LABEL}] model call failed:`, err instanceof Error ? err.message : "failed");
    return NEITHER("reader error");
  }
}
