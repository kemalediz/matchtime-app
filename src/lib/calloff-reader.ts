/**
 * AN ORGANISER CALLING THE GAME OFF WITHOUT A TAG: THE TWO MODEL READS
 * (Vets MNF, 2026-10-26).
 *
 * 1. `readGroupCalloff`: did this organiser's untagged message in the
 *    players' group tell the group the club's next game is off? Read the
 *    way a person in the group would: against the time, the next game, the
 *    group's RECENT CHAT (the same lines the extractors read,
 *    `group-chat-history.ts`) and, for a WhatsApp reply, the message it
 *    quotes. A question ("are we off tonight?"), banter, a maybe or one
 *    player's own absence is not a call-off. Code has already checked the
 *    facts (an organiser, no tag, a game coming: `calloff-offer-rules.ts`);
 *    no words are checked anywhere before or after this read.
 * 2. `readCalloffReply`: is his reply to the DM that followed a yes to
 *    cancelling it, a no (it is still on), or neither?
 *
 * Why a step of its own rather than the router (measured on the dev key,
 * 2026-10-29, `scripts/live-check-untagged-calloff.ts`): the shipped router
 * sends "it's off gents" to admin_ops in one batch and to none in another,
 * because its admin_ops needs somebody telling the BOT to act, and in the
 * players' group it sees neither the chat before the message nor whether
 * the sender is an organiser. Changing that is a whole-prompt rewrite of
 * the router for every message of every club; this step runs only for an
 * organiser's untagged message while a game is coming.
 *
 * One Haiku 5.5 call each, budget-guarded by the caller's scope. Every
 * failure (no key, a failed call, an unreadable or unsure answer) is "no
 * call-off" and "other": nothing is cancelled and nobody is DM'd on a
 * guess. No database here, so the live check imports the exact prompts.
 */
import { dmClassifierStubCall } from "./dm-classifier-stub";
import { HAIKU_SHORT_ANSWER_MAX_TOKENS } from "./models";
import { anthropicModel, extractJson, HAIKU_CALL, type ModelCall, type PipelineModel } from "./pipeline/llm";
import { nowLine, quotedLines, type ContextMessage } from "./reply-context";

export const CALLOFF_READER_CALL: ModelCall = HAIKU_CALL;
/** Below this the model is not sure enough to trouble the organiser. */
export const CALLOFF_MIN_CONFIDENCE = 0.8;
/** The chat lines shown: as many as the extractors show, and a few more. */
export const CALLOFF_HISTORY_LINES = 10;
export const CALLOFF_MESSAGE_HEADER = "THE MESSAGE:";
export const CALLOFF_REPLY_HEADER = "HIS REPLY:";
const LABEL = "calloff-reader";
const REPLY_LABEL = "calloff-reply";

export interface CalloffReadInput {
  authorName: string | null;
  body: string;
  /** The next game, in the club's words for it: "Monday 26 October, 20:30". */
  game: string;
  /** The group's recent chat, oldest first; the message itself is dropped. */
  history: Array<{ author: string | null; body: string }>;
  /** The message this one is a WhatsApp reply to, if it is one. */
  reply: ContextMessage | null;
  now: Date;
}

export function buildCalloffSystemPrompt(): string {
  return `MatchTime is the WhatsApp bot that runs a football club's games. In the club's players' group, an ORGANISER of the club wrote the message under "${CALLOFF_MESSAGE_HEADER}", without tagging MatchTime. You are shown the time now, the club's next game, the group's recent chat and, when the message is a WhatsApp reply, the message it quotes. Read it as a person in that group would, in the light of that chat.

Does the message tell the group that the club's next game is off: called off, not happening, no game? Answer "calloff": true only then. It may say so plainly ("it's off gents", "no game tonight"), as the decision at the end of a chat about numbers ("not enough of us, that's it for tonight"), or as a yes to somebody asking whether it is off.

It is false when the message:
- asks whether the game is off, or says it might be ("are we off tonight?", "might have to call it off if nobody else comes");
- jokes about it without deciding anything;
- says only that the sender, or somebody else, cannot play;
- is about another game or another time (next month, December, a game already played);
- says the game is on, or is about anything else.

Examples (English | Turkish):
true: "Alright, so it's off gents, enjoy your evenings at home" | "Tamam beyler, bu akşam maç yok, iyi akşamlar"; "Not enough numbers, we're calling tonight off" | "Sayı tutmadı, bu akşamı iptal ediyoruz"; "Yes" replying to "Are we off for tonight?" | "Evet" replying to "Bu akşam maç yok mu?"
false: "Are we off for tonight?" | "Bu akşam maç yok mu?"; "if this rain keeps up it'll be off lol" | "bu yağmurla maç iptal olur herhalde 😂"; "I can't make it tonight" | "Ben bu akşam gelemiyorum"; "Defo won't play in December" | "Aralıkta oynamayız"

A call-off stops the game for everybody, so unless you are at least 80% sure, answer false: the organiser can always tag MatchTime himself.

Output STRICT JSON only, no markdown, no fences:
{"calloff": true | false, "confidence": <number 0..1>}`;
}

export function buildCalloffUserTurn(i: CalloffReadInput): string {
  const recent = i.history
    .filter((h) => !(h.body === i.body && (h.author ?? null) === (i.authorName ?? null)))
    .slice(-CALLOFF_HISTORY_LINES);
  const lines = [nowLine(i.now), `THE CLUB'S NEXT GAME: ${i.game}`];
  if (recent.length > 0) {
    lines.push("RECENT CHAT in the players' group (context only):");
    for (const h of recent) lines.push(`  ${h.author ?? "(unknown)"}: ${h.body}`);
  }
  if (i.reply) lines.push(...quotedLines(i.reply));
  lines.push(`From: ${i.authorName ?? "(unknown)"}, an organiser of the club. He did not tag MatchTime.`);
  lines.push(`${CALLOFF_MESSAGE_HEADER}\n${i.body.trim()}`);
  return lines.join("\n");
}

/** A sure call-off, or not. (pure) */
export function parseCalloffVerdict(raw: string): boolean {
  try {
    const obj = extractJson(raw) as Record<string, unknown> | null;
    if (!obj || typeof obj !== "object") return false;
    const confidence = typeof obj.confidence === "number" ? obj.confidence : 0;
    return obj.calloff === true && confidence >= CALLOFF_MIN_CONFIDENCE;
  } catch {
    return false;
  }
}

export interface CalloffReplyInput {
  /** The DM MatchTime sent him, word for word. */
  question: string;
  text: string;
  lang: string | null;
}

export function buildCalloffReplySystemPrompt(): string {
  return `MatchTime, the WhatsApp bot that runs a football club's games, asked one of the club's organisers privately whether to cancel the club's next game. Its question is under "MATCHTIME ASKED" and his reply under "${CALLOFF_REPLY_HEADER}".

What does his reply say? Pick one:
- "yes": cancel it. Any way of saying so: "cancel", "yes", "go on", "do it", "yep it's off", "iptal", "evet", "iptal et".
- "no": do not cancel it, the game is still on: "no", "it's still on", "we've found players", "hayır", "maç var", "iptal etme".
- "other": anything else: a question, something about another subject, or something you cannot read.

Unless you are at least 80% sure, choose "other": a wrong "yes" cancels a game for everybody, while "other" changes nothing.

Output STRICT JSON only, no markdown, no fences:
{"answer": "yes" | "no" | "other", "confidence": <number 0..1>}`;
}

export function buildCalloffReplyUserTurn(i: CalloffReplyInput): string {
  return [`MATCHTIME ASKED: ${i.question}`, `${CALLOFF_REPLY_HEADER}\n${i.text.trim()}`].join("\n");
}

export type CalloffReply = "yes" | "no" | "other";

/** Yes, no, or anything else. (pure) */
export function parseCalloffReply(raw: string): CalloffReply {
  try {
    const obj = extractJson(raw) as Record<string, unknown> | null;
    if (!obj || typeof obj !== "object") return "other";
    const confidence = typeof obj.confidence === "number" ? obj.confidence : 0;
    if (confidence < CALLOFF_MIN_CONFIDENCE) return "other";
    return obj.answer === "yes" || obj.answer === "no" ? obj.answer : "other";
  } catch {
    return "other";
  }
}

/**
 * TEST-ONLY seam, as the DM classifiers have: what the model would say for
 * a message body, read from a file, so the e2e suite drives the real routes
 * for free. Labels: "calloff" (the group message calls the game off),
 * "yes" or "no" (his DM reply); no mapping is "no call-off" and "other".
 * `e2e/helpers/live-llm.ts` refuses a live run that can still see it.
 */
export const CALLOFF_STUB_FILE_ENV = "MT_TEST_CALLOFF_STUB_FILE";

function stubModel(env: NodeJS.ProcessEnv, label: string, header: string, answer: (l: string | null) => string): PipelineModel | null {
  const call = dmClassifierStubCall(env[CALLOFF_STUB_FILE_ENV], { label, header, answer });
  if (!call) return null;
  return {
    name: `${label}-stub`,
    complete: async (req) => ({
      text: await call(req.system, req.user),
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0,
      ms: 0,
    }),
  };
}

function realModel(): PipelineModel | null {
  return process.env.ANTHROPIC_API_KEY?.trim() ? anthropicModel() : null;
}

async function ask(model: PipelineModel, system: string, user: string, label: string): Promise<string> {
  const resp = await model.complete({
    ...CALLOFF_READER_CALL,
    system,
    user,
    maxTokens: HAIKU_SHORT_ANSWER_MAX_TOKENS,
    // Short and asked rarely: a 1-hour cache write would cost more than it saves.
    cache: false,
    label,
  });
  return resp.text;
}

/**
 * Did the organiser call the next game off? `deps.model` undefined uses the
 * real model (or the e2e stub), null asserts there is none. Never throws.
 */
export async function readGroupCalloff(i: CalloffReadInput, deps?: { model?: PipelineModel | null }): Promise<boolean> {
  if (!i.body?.trim()) return false;
  const model =
    deps?.model === undefined
      ? (stubModel(process.env, LABEL, CALLOFF_MESSAGE_HEADER, (l) => JSON.stringify({ calloff: l === "calloff", confidence: 1 })) ?? realModel())
      : deps.model;
  if (!model) return false;
  let verdict = false;
  try {
    verdict = parseCalloffVerdict(await ask(model, buildCalloffSystemPrompt(), buildCalloffUserTurn(i), LABEL));
  } catch (err) {
    console.error(`[${LABEL}] model call failed:`, err instanceof Error ? err.message : "failed");
    verdict = false;
  }
  console.info(`[${LABEL}] verdict calloff=${verdict}`);
  return verdict;
}

/** His reply to the DM: yes, no or other. Never throws; a failure is "other". */
export async function readCalloffReply(i: CalloffReplyInput, deps?: { model?: PipelineModel | null }): Promise<CalloffReply> {
  if (!i.text?.trim()) return "other";
  const model =
    deps?.model === undefined
      ? (stubModel(process.env, REPLY_LABEL, CALLOFF_REPLY_HEADER, (l) =>
          JSON.stringify({ answer: l === "yes" || l === "no" ? l : "other", confidence: 1 }),
        ) ?? realModel())
      : deps.model;
  if (!model) return "other";
  let answer: CalloffReply = "other";
  try {
    answer = parseCalloffReply(await ask(model, buildCalloffReplySystemPrompt(), buildCalloffReplyUserTurn(i), REPLY_LABEL));
  } catch (err) {
    console.error(`[${REPLY_LABEL}] model call failed:`, err instanceof Error ? err.message : "failed");
  }
  console.info(`[${REPLY_LABEL}] verdict answer=${answer}`);
  return answer;
}
