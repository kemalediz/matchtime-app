/**
 * THE MONEY COLLECTOR'S REPLY TO A FEE QUESTION, READ BY THE MODEL
 * (2026-10-30, the "no string parsing" sweep, package P5).
 *
 * After a match MatchTime DMs the club's money collector one of two
 * questions: "how much per player?" (the fee ask), or "£8 each for 12
 * players, reply ✅ to send everyone their pay link, or send a different
 * amount" (the confirm). Whatever he answers is read here, by one Haiku
 * call, with what MatchTime last said to him as context. Code then acts on
 * facts only (`payment-flow.ts`, `runCollectorFeeReply`).
 *
 * WHAT WAS HERE UNTIL 2026-10-30. A whole-body allowlist (`anchoredFeeReply`:
 * ✅ ✔ 👍 and about 60 English and Turkish yes and no words) decided first,
 * then a regex amount test (`looksLikeFeeAmount`, `parseFeeReply` with its
 * "total", "split", "toplam", "bölüş" detectors), and the model only saw
 * what both abstained on. Kemal, 2026-10-30: "I don't want any string
 * parsing at all." All three are gone; the model reads every reply that
 * reaches it, including a bare ✅.
 *
 * WHAT STILL KEEPS THE MONEY SAFE IS CODE, ON FACTS:
 *   1. the sender is the club's money collector (`paymentHolderId`);
 *   2. the match is a played one of his club, within four days, with its
 *      links not out and no price set (an amount may be waiting for his
 *      yes, `feePendingConfirm`). An amount typed before the fee ask went
 *      out is read too, and only staged;
 *   3. a "yes" releases only the amount that is waiting, and only while it
 *      is still waiting when the release is written (compare-and-set); a
 *      "yes" that names a DIFFERENT amount releases nothing (it is staged
 *      and asked again);
 *   4. an amount is only ever STAGED: MatchTime repeats it back and waits
 *      for a separate yes. Nothing is charged on an amount alone;
 *   5. every model failure (no key, a throw, unparseable or out-of-enum
 *      JSON, confidence under 0.8, an amount outside £0.01 to £1,000) is
 *      `neither`, which releases, cancels and stages nothing.
 *
 * WHAT THIS COSTS. A ✅ used to need no network. Now an Anthropic outage
 * means the collector's ✅ does nothing until it is back (the ✅ REACTION on
 * the question still works: `fee-confirm-reaction.ts` joins it by message
 * id and never reads text). The live window is small: about six fee
 * questions a quarter at Sutton FC, each answered within minutes.
 */

import { bodyUnderHeader, dmClassifierStubCall } from "./dm-classifier-stub";
import { type Lang } from "./i18n/lang";
import { HAIKU_MODEL, HAIKU_SHORT_ANSWER_MAX_TOKENS, HAIKU_THINKING } from "./models";
import { noReplyContext, renderReplyContext, type ReplyContext } from "./reply-context";

/** Below this the model is not sure enough to charge the squad, to throw
 *  away a waiting amount, or to stage a new one. The same 0.8 the other
 *  DM readers use. */
export const FEE_REPLY_MIN_CONFIDENCE = 0.8;

/** The most a per-player fee or a match total can be. Anything above is
 *  not a fee MatchTime will stage from a chat message. */
export const FEE_REPLY_MAX_AMOUNT = 1000;

/** The closed enum. Anything else the model returns becomes `neither`. */
export type FeeReply = "yes" | "no" | "amount" | "neither";

/** What an amount he typed is: each player's fee, or the total to split. */
export type FeeAmountIs = "each" | "total";

/** The model's reading of his reply, checked. */
export interface FeeReplyRead {
  intent: FeeReply;
  /** The amount he states, in pounds, or null. Set for `amount`; for
   *  `yes`, only when he names one ("yes, £8"). */
  amount: number | null;
  /** Set exactly when `amount` is (null for `no` and `neither`). */
  amountIs: FeeAmountIs | null;
  confidence: number;
  reasoning: string;
}

const VALID: ReadonlySet<string> = new Set<FeeReply>(["yes", "no", "amount", "neither"]);

const MODEL = HAIKU_MODEL;

/**
 * The prompt, the same for every club, English and Turkish examples side
 * by side. Rewritten WHOLE on 2026-10-30: it now reads the whole reply
 * (the allowlist and the amount regex in front of it are gone), so it also
 * reads amounts, each or total, and knows which of the two questions is
 * open. The negative examples are real messages the Sutton collector has
 * written in the group (`AnalyzedMessage`).
 */
export function buildFeeReplySystemPrompt(): string {
  return `The person who collects the match fees for a football club sent MatchTime, the club's WhatsApp bot, the private reply under "THEIR REPLY". Above it you get the match, what MatchTime is waiting for from them, the time now, and what MatchTime said to them: the message they swipe-replied to, or else MatchTime's recent messages to them, each with when it was sent.

MatchTime is waiting for one of two answers:
- an amount, such as "Amount waiting for their yes: £8 per player": MatchTime told them the fee per player and how many players it will charge, and asked them to reply yes (or ✅) to send everyone their pay link now, or to send a different amount to change it.
- "Amount waiting for their yes: none": nothing is waiting. MatchTime asked them how much each player pays for the match, or will ask them soon: they may give the fee before the question arrives. (When MatchTime's message they answer names a fee and asks for their yes, that is the question.)

What does the reply say? Pick one intent:
- "yes": send the pay links now, at the fee MatchTime asked them to confirm. A bare ✅, 👍, "ok", "yes", "tamam" or "evet" is a yes when it answers that question.
- "no": do not send them, or not yet.
- "amount": they state the fee, or a new fee in place of the one waiting. Put the number in "amount", in pounds (8, 10.5), and in "amountIs" say whether it is what "each" player pays or the "total" to split between the players (the pitch cost, "altogether", "split"). If they only give a number, it is "each".
- "neither": anything else. Chat, thanks, banter, a question of their own, news about a player, a plan to deal with it later, a number that is not a fee (how many played, a score), or an answer to a different message. A 👍, ✅, "ok" or "yes" inside a sentence about something else is not an answer, and the "no" in "no worries" is not a refusal.

Which message the reply answers: the one they swipe-replied to; otherwise the newest of MatchTime's recent messages, unless their words plainly answer an earlier one (such as "send the links"). A reply to any message other than the fee question is "neither". If none of MatchTime's messages is known, read the reply against the fee question.

If a "yes" also names an amount ("yes £8 is right"), put that amount in "amount" and "amountIs" too. Otherwise leave both null.

Examples (English | Turkish):
yes: "✅" | "✅ evet"; "ok" | "tamam"; "ok send them" | "tamam gönder"; "yeah go on then" | "tamam, yolla gitsin"; "go ahead and send them" | "evet evet at hepsine"; "that's right, fire them out" | "doğru, gönderebilirsin"; "perfect 👍" swipe-replied to the fee question | "süper 👍" swipe-replied to the fee question
no: "no" | "hayır"; "hold off for now" | "şimdilik bekle"; "not yet, let me count the cash first" | "bekle, parayı bir sayayım"; "don't send them" | "daha gönderme"
amount, each: "£8" | "8 sterlin"; "8 each" | "kişi başı 8"; "make it £12" | "£12 yap"; "✅ actually make it £12" | "✅ yok 12 olsun"; "everyone pays 8" | "hepsi 8"
amount, total: "£80 total" | "toplam £80"; "the pitch was 96, split it" | "saha 96, bölüşelim"
neither: "great game 👍" | "harika maç 👍"; "ok so I'll sort it tomorrow" | "tamam yarın hallederim"; "yes, Elvin still collects it" | "evet, parayı Elvin topluyor"; "how many are paying?" | "kaç kişi ödüyor?"; "no worries mate, great game" | "sorun yok kardeşim, güzel maçtı"; "we had 10 players" | "10 kişiydik"; "did Wasim turn up in the end?" | "Wasim geldi mi sonunda?"; "yes" answering a request to rate teammates

If you are not at least 80% sure, choose "neither". A wrong "yes" asks up to 13 real people for money at a moment the collector did not choose, and cannot be undone. A wrong "amount" makes MatchTime ask about a fee they never gave. A wrong "neither" costs them one re-typed message, the cheapest of all.

Output STRICT JSON only, no markdown, no fences:
{"intent": "yes" | "no" | "amount" | "neither", "amount": <number or null>, "amountIs": "each" | "total" | null, "confidence": <number 0..1>, "reasoning": "<max 100 chars>"}`;
}

/** The prompt, the same for every club (pinned by `copy.en.snap` and
 *  `copy.tr.snap`, case "R98 FEE_REPLY_SYSTEM_PROMPT"). */
export const FEE_REPLY_SYSTEM_PROMPT = buildFeeReplySystemPrompt();

/** The model, as one function, so a test can drive the real parse
 *  without a key. */
export type FeeReplyCall = (system: string, user: string) => Promise<string>;

export interface FeeReplyContext {
  /** The amount awaiting his yes, or null: MatchTime asked how much. */
  pending: number | null;
  /** The match it belongs to, with its day and time
   *  (`contextMatchLabel`), so the model sees which game it is about. */
  matchName: string;
  /** The match's org language. Not sent to the model (one prompt for
   *  every club); kept for the callers and the verdict log. */
  lang?: Lang | string | null;
  /** The chat context (`loadDmReplyContext`): the time now, and the
   *  message they swipe-replied to or MatchTime's recent DMs to them.
   *  Absent: the time now, nothing known. */
  replyContext?: ReplyContext | null;
}

const NEITHER = (reasoning: string, confidence = 0): FeeReplyRead => ({
  intent: "neither",
  amount: null,
  amountIs: null,
  confidence,
  reasoning,
});

function validAmount(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v <= 0 || v > FEE_REPLY_MAX_AMOUNT) return null;
  return Math.round(v * 100) / 100;
}

/** Exported for unit tests: the JSON contract is load-bearing. Checks the
 *  model's OUTPUT (enum, confidence, amount range), never his words. */
export function parseFeeReplyIntent(rawText: string): FeeReplyRead {
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return NEITHER("parse failed");
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return NEITHER("parse failed");
    }
  }
  if (!parsed || typeof parsed !== "object") return NEITHER("not an object");
  const obj = parsed as Record<string, unknown>;
  const intent = typeof obj.intent === "string" && VALID.has(obj.intent) ? (obj.intent as FeeReply) : "neither";
  const confidence = typeof obj.confidence === "number" ? Math.max(0, Math.min(1, obj.confidence)) : 0;
  const reasoning = typeof obj.reasoning === "string" ? obj.reasoning.slice(0, 200) : "";
  if (intent === "neither") return NEITHER(reasoning, confidence);
  if (confidence < FEE_REPLY_MIN_CONFIDENCE) return NEITHER(`[low-confidence forced] ${reasoning}`, confidence);
  if (intent === "no") return { intent, amount: null, amountIs: null, confidence, reasoning };

  // An amount, when there is one, must be a real fee and say what it is.
  const hasAmount = obj.amount !== null && obj.amount !== undefined;
  const amount = validAmount(obj.amount);
  const amountIs = obj.amountIs === "each" || obj.amountIs === "total" ? (obj.amountIs as FeeAmountIs) : null;
  if (intent === "amount") {
    if (amount === null || amountIs === null) return NEITHER(`[bad amount forced] ${reasoning}`, confidence);
    return { intent, amount, amountIs, confidence, reasoning };
  }
  // "yes": with no amount, or with a valid one. A garbled amount on a yes
  // is a reading we cannot trust: nothing.
  if (!hasAmount) return { intent, amount: null, amountIs: null, confidence, reasoning };
  if (amount === null || amountIs === null) return NEITHER(`[bad amount forced] ${reasoning}`, confidence);
  return { intent, amount, amountIs, confidence, reasoning };
}

/**
 * TEST-ONLY seam, mirroring `DM_INTENT_STUB_FILE_ENV`. It stubs what
 * ENTERS the system (what the model said), never what the system
 * concludes. The stub's label is "yes", "no" or "neither", or the model's
 * whole JSON (starting "{") for an amount. Shared with the other DM
 * classifiers (`dm-classifier-stub.ts`): each user turn it is asked about
 * is appended to `<file>.calls`. `e2e/helpers/live-llm.ts` refuses a
 * "live" run that can still see it.
 */
export const FEE_REPLY_STUB_FILE_ENV = "MT_TEST_FEE_REPLY_STUB_FILE";

function stubCall(env: NodeJS.ProcessEnv): FeeReplyCall | null {
  // Missing or garbled file, or a body it does not map: `neither`, the
  // direction that cannot release anybody's pay links.
  return dmClassifierStubCall(env[FEE_REPLY_STUB_FILE_ENV], {
    label: "fee-confirm",
    header: REPLY_HEADER,
    answer: (label) =>
      label?.trim().startsWith("{")
        ? label
        : JSON.stringify({ intent: label ?? "neither", amount: null, amountIs: null, confidence: 1, reasoning: "fee-reply stub" }),
  });
}

/** What separates the context lines from the reply itself. */
const REPLY_HEADER = "THEIR REPLY:";

/** Everything after the header, trimmed, so a multi-line reply is read
 *  whole rather than by its last line. */
export function feeReplyBodyOf(user: string): string {
  return bodyUnderHeader(user, REPLY_HEADER);
}

/** The user turn: the match, what is waiting, the chat context, then the
 *  reply under a HEADER (a WhatsApp reply can be several lines long). */
export function buildFeeReplyUserTurn(text: string, ctx: FeeReplyContext): string {
  return [
    `Match: ${ctx.matchName}`,
    `Amount waiting for their yes: ${ctx.pending != null ? `${gbpish(ctx.pending)} per player` : "none"}`,
    renderReplyContext(ctx.replyContext ?? noReplyContext()),
    `${REPLY_HEADER}\n${text.trim()}`,
  ].join("\n");
}

/**
 * Ask the model, once, what this reply says about the fee.
 *
 * EVERY failure returns `neither`. That is the safety property: `neither`
 * moves no money and stages nothing. `call` is `undefined` to use the
 * real (or stubbed) model, and `null` to assert there is none.
 */
export async function classifyFeeReply(
  text: string,
  ctx: FeeReplyContext,
  call?: FeeReplyCall | null,
): Promise<FeeReplyRead> {
  if (!text || !text.trim()) return NEITHER("empty reply");
  const fn = call === undefined ? (stubCall(process.env) ?? liveCall()) : call;
  if (!fn) return NEITHER("classifier unavailable");
  try {
    return parseFeeReplyIntent(await fn(FEE_REPLY_SYSTEM_PROMPT, buildFeeReplyUserTurn(text, ctx)));
  } catch (err) {
    // FAIL CLOSED: a reply we did not understand changes nothing.
    console.error("[fee-confirm] classifier call failed:", err);
    return NEITHER("classifier error");
  }
}

/** Local £ formatting: `payments.ts`'s `gbp` would be a circular import. */
function gbpish(amount: number): string {
  return amount % 1 === 0 ? `£${amount.toFixed(0)}` : `£${amount.toFixed(2)}`;
}

/** The real call. Null when there is no key, which is `neither`. */
function liveCall(): FeeReplyCall | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return async (system, user) => {
    // Imported lazily so a unit test that never reaches the live path
    // does not pay for loading the SDK.
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const { guardedAnthropicCall, systemBlock } = await import("./pipeline/llm");
    const anthropic = new Anthropic({ apiKey: key });
    const response = await guardedAnthropicCall("fee-confirm", () =>
      anthropic.messages.create({
        model: MODEL,
        max_tokens: HAIKU_SHORT_ANSWER_MAX_TOKENS,
        ...HAIKU_THINKING,
        system: systemBlock(system),
        messages: [{ role: "user", content: user }],
      }),
    );
    const block = response.content.find((b) => b.type === "text");
    return block && block.type === "text" ? block.text : "";
  };
}
