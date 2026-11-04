/**
 * THE POOL'S DM READER (slice L6, 2026-10-24; REWRITTEN WHOLE 2026-11-04).
 * A small closed-answer reader, shaped like `pairing-reply.ts` and
 * `volunteer-name-reply.ts`. One plain task: a pool player wrote to
 * MatchTime privately; given what MatchTime sent him (its game offers, its
 * question about his times and formats) and what his profile says, what
 * does his message mean? accept, decline, stop, question, details or
 * neither, with a confidence, and for "details" what he said.
 *
 * WHY THE REWRITE (Kemal, 2026-11-04): the /play form now asks only his
 * name, postcode area and days (`short-form.ts`); MatchTime asks the times
 * and formats on WhatsApp and reads his answer here, and he can change them
 * the same way at any time. One reader for everything a pool player says
 * to MatchTime, not a second one beside it: the offers and the question
 * are the same conversation. Each answer is defined once; the examples are
 * grouped by answer, English and Turkish side by side.
 *
 * It decides nothing. `reply-rules.ts` decides what is done (the floor, the
 * re-ask, proof, which offer); `details-rules.ts` what his times change;
 * `reply.ts` does it. Every failure (no key, a failed or cut-off call, an
 * answer off the contract) is "neither" with no confidence, which changes
 * nothing.
 *
 * WHAT THE MODEL SEES (privacy, plan section 6): only this person's own
 * offers and question, as they were sent to him, with every link replaced
 * by "<link>" (the tap link is signed, the manage link signs him in), his
 * own profile's days, hours and formats, his message, the time, and the
 * NAME of his own club if he has one. Never another person, never a number.
 * Named in the pool source guard's `POOL_MODEL_READERS`.
 *
 * One Haiku 5.5 call per message (`HAIKU_CALL`, budget-guarded, structured
 * output). No database here, so `scripts/live-check-pool-reply.ts` imports
 * the exact production prompt without Prisma.
 */
import { dmClassifierStubCall } from "../dm-classifier-stub";
import { formatLondon } from "../london-time";
import { anthropicModel, extractJson, HAIKU_CALL, type ModelCall, type PipelineModel } from "../pipeline/llm";
import type { DetailsReading, DetailsSummary } from "./details-rules";
import { POOL_REPLY_INTENTS, type OfferReplyState, type PoolReplyIntent } from "./reply-rules";
import { SPORT_LEVELS, type SportLevel } from "./sports";

/** The model and thinking posture, pinned. Exported for the paid check. */
export const POOL_REPLY_CALL: ModelCall = HAIKU_CALL;
const LABEL = "pool-reply";
const REPLY_HEADER = "HIS REPLY:";
/** Thinking shares the budget, and "details" may list seven days of hours:
 *  twice the house short-answer budget (`HAIKU_SHORT_ANSWER_MAX_TOKENS`). */
const MAX_TOKENS = 2_048;

export const POOL_REPLY_SYSTEM_PROMPT = `Someone in the MatchTime player pool sent MatchTime, a WhatsApp bot, the private message under "${REPLY_HEADER}". MatchTime finds local games that are short of players and privately offers the place to nearby pool players. It also asks each new pool player which times suit him on the days he picked and which football formats he plays, so it only offers games that fit. Players answer both in their own words.

Above his message you get the time now, whether he also plays for a club of his own, what his pool profile says (his days with their hours, his football formats, his level), MatchTime's question about his times and formats if it asked one, the game offers MatchTime sent him (newest first, each with its state and its exact words), and what he swipe-replied to, if anything.

Say what his message means. Pick one:
- "accept": he wants the place in a game offer. Yes, I'm in, count me in, a thumbs up, or a yes with a question ("yes, where do I park?").
- "decline": he does not want the place in a game offer, or, for a place he has already taken, he can no longer come. No, not this time, busy that night, can't make it any more.
- "stop": he wants no more game offers at all. Stop sending these, take me off the list, unsubscribe. A no to one game is "decline", not "stop".
- "question": he asks about a game offer before deciding: where it is, parking, the fee, the level, how long. MatchTime then sends him the offer's facts again; it cannot answer anything else.
- "details": he tells MatchTime when he can play or which formats he plays, answering its question or changing them at any time: times, days, "any time", "only 11-a-side", a day he can no longer do, his level.
- "neither": anything else. Thanks, a greeting, banter, a message about his own club's games, a reply that does not answer what MatchTime asked, or something you cannot read.

For "details", also say what he told MatchTime, as data. Leave everything he did not say empty:
- "hours": one entry for each stretch of time he gave, {"day", "from", "to"}. For "day", 0 is Sunday, 1 Monday, 2 Tuesday, 3 Wednesday, 4 Thursday, 5 Friday, 6 Saturday. "from" and "to" are 24-hour London times, "HH:MM"; "to" is "24:00" for "until late", "after 7" or anything past midnight; any time on a day is "00:00" to "24:00". A general answer ("weekday evenings", "any time") covers the days on his profile it fits; another day goes in only when he names it.
- Clock times without am or pm mean what people mean for a game after work: on a weekday "7", "after 7" or "from 8" is 19:00 or 20:00; on Saturday and Sunday "9 to 12" is the morning. Evenings are 18:00 to 24:00, afternoons 12:00 to 18:00, mornings 07:00 to 12:00.
- "not_days": days he says he can no longer play, by the same numbers.
- "formats": the football formats he plays, as players a side: 5, 7, 8, 9 or 11 ("5s", "fives", "5 a side" and "5 kişilik" are 5; "full size" and "11s" are 11). "any_format" is true when any format suits him.
- "level": "novice", "intermediate", "advanced" or "pro" only when he says how good he is in those terms or plainly close to them ("beginner" is novice, "decent" or "average" is intermediate, "good" or "experienced" is advanced, "semi-pro" is pro); "" otherwise.

How to read it:
- Read the message as a whole. Typos and slang count ("yh go on", "im in", "nah mate"). Sarcasm is not a yes ("oh great, 11pm on a Tuesday, can't wait").
- A swipe-reply is about the message it quotes. A plain message is about his game offers when its words fit them, and "details" when it gives times, days or formats he can play. If he has a club of his own, a message that could just as well be about his own club's games is "neither", and so is a question about a day or a game that none of his offers is for ("what time is kickoff on Thursday?" when no offer is on a Thursday).
- For an offer that has ended, still say what he means; MatchTime decides what to do with it.
- Mixed messages: stop wins ("no thanks, and stop messaging me" is "stop"); a clear yes or no to a game offer wins over a question and over details ("yes, and I'm free Thursdays too" is "accept", "no, but where is it anyway?" is "decline").
- Turkish is as common as English: read it the same way.

Examples (English | Turkish):
accept: "yes" | "evet"; "I'm in" | "varım"; "count me in 👍" | "beni yaz"; "go on then, I'll come" | "olur, gelirim"; "yes please, is there parking?" | "tamam geliyorum, otopark var mı?"
decline: "no thanks" | "hayır, sağ ol"; "can't make it" | "gelemem"; "busy that night" | "o akşam işim var"; "sorry, I can't come any more" (a place he took) | "artık gelemiyorum"
stop: "stop sending me these" | "bana bu mesajları atma artık"; "take me off the list" | "beni listeden çıkar"; "no more game offers please" | "maç teklifi göndermeyin"
question: "where is it?" | "nerede?"; "is there parking?" | "otopark var mı?"; "how much is it?" | "ücret ne kadar?"; "what level is it?" | "seviye nasıl?"
details: "weekday evenings after 7" | "hafta içi akşam 7'den sonra"; "Tue and Thu from 8, 5 or 7 a side" | "salı ve perşembe 8'den sonra, 5 ya da 7 kişilik"; "any time, any format" | "her saat olur, format fark etmez"; "only 11s" | "sadece 11 kişilik"; "can't do Saturdays any more" | "cumartesi artık olmuyor"; "weekend mornings, I'm a beginner" | "hafta sonu sabahları, yeni başlıyorum"
neither: "thanks" | "teşekkürler"; "hello?" | "merhaba"; "who is this?" | "kimsin?"; "haha nice" | "haha güzel"; "sounds good" (to the question, saying nothing about times) | "tamamdır"; "is our Tuesday game on?" (his own club) | "salı maçımız var mı?"

Confidence is how sure you are, from 0 to 1. Below 0.8 MatchTime asks him once more or does nothing. A wrong "accept" books him onto a stranger's team, a wrong "decline" or "stop" loses a player who wanted to play, a wrong "details" changes which games he is offered (he is told what was saved and can correct it), and a wrong "neither" costs him one more message, the cheapest mistake.

Answer with the JSON object only, every key every time: {"intent": one of the six, "confidence": a number from 0 to 1, "hours": [], "not_days": [], "formats": [], "any_format": false, "level": "", "reasoning": at most 100 characters}. For every intent but "details", the lists are empty, "any_format" is false and "level" is "".`;

/** Structured output (`output_config.format`). No nullable types: the API
 *  rejects them (see pipeline/extractors.ts). */
export const POOL_REPLY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    intent: { type: "string", enum: [...POOL_REPLY_INTENTS] },
    confidence: { type: "number" },
    hours: {
      type: "array",
      items: {
        type: "object",
        properties: { day: { type: "integer" }, from: { type: "string" }, to: { type: "string" } },
        required: ["day", "from", "to"],
        additionalProperties: false,
      },
    },
    not_days: { type: "array", items: { type: "integer" } },
    formats: { type: "array", items: { type: "integer" } },
    any_format: { type: "boolean" },
    level: { type: "string", enum: ["", ...SPORT_LEVELS] },
    reasoning: { type: "string" },
  },
  required: ["intent", "confidence", "hours", "not_days", "formats", "any_format", "level", "reasoning"],
  additionalProperties: false,
};

export interface PoolReplyContext {
  now: Date;
  /** The name of his own club (a live ordinary membership), or null. */
  ownClub: string | null;
  /** His offers in question, newest first, as sent. May be empty. */
  offers: Array<{ state: OfferReplyState; sentAt: Date; text: string }>;
  /** Index into `offers` of the one he swipe-replied to, or null. */
  quotedIndex: number | null;
  /** His profile's days, hours and formats (`detailsSummary`), or null. */
  profile: (DetailsSummary & { level: SportLevel | null }) | null;
  /** MatchTime's question about his times and formats, newest, or null. */
  detailsAsk: { sentAt: Date; text: string } | null;
  /** He swipe-replied to that question. */
  quotedAsk: boolean;
}

export interface PoolReplyReading {
  intent: PoolReplyIntent;
  confidence: number;
  reasoning: string;
  /** What he said for "details"; empty for every other intent. */
  details: DetailsReading;
}

const STATE_LINE: Record<OfferReplyState, string> = {
  open: "open, he has not answered it yet",
  taken: "taken, he said yes and holds this place",
  ended: "ended, the place can no longer be taken",
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const when = (d: Date) => formatLondon(d, "EEE d MMM, HH:mm");
/** Every link, signed or not, is hidden from the model. */
const withoutLinks = (text: string) => text.replace(/https?:\/\/\S+/g, "<link>");

function profileLine(p: PoolReplyContext["profile"]): string {
  if (!p) return "His pool profile: not shown";
  const days = p.days.length
    ? p.days.map((d) => `${DAY_NAMES[d.day]} (day ${d.day}) ${d.any ? "any time" : d.ranges.map((r) => `${r.from} to ${r.to}`).join(" and ")}`).join("; ")
    : "no days";
  const formats = p.formats === null ? "no football" : p.formats.length ? p.formats.map((n) => `${n}-a-side`).join(", ") : "any";
  return `His pool profile: ${days}. Football formats: ${formats}. Level: ${p.level ?? "not given"}.`;
}

export function buildPoolReplyUserTurn(text: string, ctx: PoolReplyContext): string {
  const offers = ctx.offers.map((o, i) => `[${i + 1}] Sent ${when(o.sentAt)}. State: ${STATE_LINE[o.state]}.\n${withoutLinks(o.text).trim()}`);
  const quoted =
    ctx.quotedIndex !== null ? `offer [${ctx.quotedIndex + 1}]` : ctx.quotedAsk && ctx.detailsAsk ? "the question about his times and formats" : "nothing (a plain message)";
  return [
    `Time now: ${when(ctx.now)} (London)`,
    `His own club: ${ctx.ownClub ? `${ctx.ownClub} (MatchTime also messages him about its games)` : "none"}`,
    profileLine(ctx.profile),
    ctx.detailsAsk
      ? `MatchTime's question about his times and formats, sent ${when(ctx.detailsAsk.sentAt)}:\n${withoutLinks(ctx.detailsAsk.text).trim()}`
      : "MatchTime's question about his times and formats: none",
    `Game offers MatchTime sent him, newest first:\n${offers.length ? offers.join("\n\n") : "(none)"}`,
    `He swipe-replied to: ${quoted}`,
    `${REPLY_HEADER}\n${text.trim()}`,
  ].join("\n\n");
}

const NO_DETAILS = (): DetailsReading => ({ hours: [], notDays: [], formats: [], anyFormat: false, level: null });
const NEITHER = (reasoning: string): PoolReplyReading => ({ intent: "neither", confidence: 0, reasoning, details: NO_DETAILS() });
const ints = (v: unknown): number[] => (Array.isArray(v) ? v.filter((n): n is number => typeof n === "number" && Number.isInteger(n)) : []);

/** His times and formats off the answer: shapes only; `details-rules.ts`
 *  checks every value. (pure) */
function readDetails(obj: Record<string, unknown>): DetailsReading {
  const hours = Array.isArray(obj.hours)
    ? obj.hours
        .filter((h): h is { day: number; from: string; to: string } => {
          const r = h as Record<string, unknown> | null;
          return !!r && typeof r.day === "number" && Number.isInteger(r.day) && typeof r.from === "string" && typeof r.to === "string";
        })
        .map((h) => ({ day: h.day, from: h.from, to: h.to }))
    : [];
  const level = typeof obj.level === "string" && (SPORT_LEVELS as readonly string[]).includes(obj.level) ? (obj.level as SportLevel) : null;
  return { hours, notDays: ints(obj.not_days), formats: ints(obj.formats), anyFormat: obj.any_format === true, level };
}

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
  return { intent, confidence, reasoning, details: intent === "details" ? readDetails(obj) : NO_DETAILS() };
}

/**
 * TEST-ONLY seam, as the sibling DM readers have: what the model would have
 * said, keyed by the reply body, read from a file. Labels: an intent, or
 * "low:<intent>" for an unsure one (confidence 0.5); "details:<json>" (or
 * "low:details:<json>") carries the fields, in the model's own keys; no
 * mapping is "neither". `e2e/helpers/live-llm.ts` refuses a live run that
 * can see it.
 */
export const POOL_REPLY_STUB_FILE_ENV = "MT_TEST_POOL_REPLY_STUB_FILE";

function stubAnswer(label: string | null): string {
  const low = label?.startsWith("low:") ?? false;
  const rest = low ? label!.slice(4) : (label ?? "neither");
  const [intent, ...json] = rest.split(":");
  let fields: Record<string, unknown> = {};
  try {
    fields = json.length ? (JSON.parse(json.join(":")) as Record<string, unknown>) : {};
  } catch {
    fields = {};
  }
  return JSON.stringify({ hours: [], not_days: [], formats: [], any_format: false, level: "", ...fields, intent, confidence: low ? 0.5 : 1, reasoning: "pool-reply stub" });
}

function stubModel(env: NodeJS.ProcessEnv): PipelineModel | null {
  const call = dmClassifierStubCall(env[POOL_REPLY_STUB_FILE_ENV], { label: LABEL, header: REPLY_HEADER, answer: stubAnswer });
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
 * Read his message, once. `deps.model` undefined uses the real model (or
 * the e2e stub), null asserts there is none. Never throws.
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
      maxTokens: MAX_TOKENS,
      schema: POOL_REPLY_SCHEMA,
      label: LABEL,
    });
    return parsePoolReply(resp.text);
  } catch (err) {
    // FAIL SAFE: nothing booked, declined, stopped or changed.
    console.error(`[${LABEL}] model call failed:`, err instanceof Error ? err.message : "failed");
    return NEITHER("reader error");
  }
}
