/**
 * THE PLAYER PAYMENT-CLAIM CLASSIFIER (2026-09-23): one model call that
 * says whether a player's DM tells MatchTime they have already paid.
 *
 * No database, no side effects: `lib/payment-claim.ts` owns the gates,
 * the write and the reply, and this file only reads a message. Kept apart
 * so the live dry run (`scripts/dryrun-payment-claim.ts`) can import the
 * exact production prompt without importing Prisma. See
 * `lib/payment-claim.ts` for the design and the decisions.
 */
import { bodyUnderHeader, dmClassifierStubCall } from "./dm-classifier-stub";
import { HAIKU_MODEL, HAIKU_SHORT_ANSWER_MAX_TOKENS, HAIKU_THINKING } from "./models";
import { noReplyContext, renderReplyContext, type ReplyContext } from "./reply-context";

/** The model, pinned. Exported so the live dry run measures this one. */
export const PAYMENT_CLAIM_MODEL = HAIKU_MODEL;

/** Below this the model is not sure enough to tell a collector a player
 *  says they have paid. The same bar as `dm-intent.ts` and
 *  `fee-confirm.ts`. */
export const PAYMENT_CLAIM_MIN_CONFIDENCE = 0.8;

/** The closed enum. Anything else the model returns becomes `other`. */
export type PaymentClaimIntent = "paid" | "paid_for_others" | "will_pay_direct" | "other";

const VALID: ReadonlySet<string> = new Set<PaymentClaimIntent>(["paid", "paid_for_others", "will_pay_direct", "other"]);

/**
 * The prompt. One prompt for every org: a Sutton player writes Turkish as
 * readily as a Turkish club's player writes English, so the examples are
 * English and Turkish side by side. The examples use a collector called
 * Sam, so the live check's Raihan cases prove the rule rather than echo an
 * example.
 *
 * Rewritten whole on 2026-10-30 (P5 of the "no string parsing" sweep): it
 * now also says the AMOUNT the player states, if any, so code can check it
 * against what he owes (`payment-claim.ts`) instead of anything reading
 * his words. Before that: 2026-10-18 (the collector named in the context,
 * `will_pay_direct`), 2026-10-20 (the shared chat-context block).
 */
export function buildPaymentClaimSystemPrompt(): string {
  return `A player who owes a match fee sent MatchTime, their football club's bot, the private WhatsApp message under "THE DM". Above it you get what they owe, "Money collector:" (the club member the fees are paid to, through MatchTime's pay link or directly by cash or bank transfer), the time now, and what MatchTime said to them: the message they swipe-replied to, or else MatchTime's recent messages to them, each with when it was sent and what it was about.

What is the player telling us about paying? Pick one intent:
- "paid": they say they have paid their own fee to the club: to the money collector (by name, even a first name or with a Turkish ending), "you", "the organiser", or nobody named. A bare "done" or "tamam" counts only if it answers a MatchTime message about paying: the one they swipe-replied to, or else the newest recent one.
- "paid_for_others": they have paid, and it covers somebody else too, or instead.
- "will_pay_direct": they have not paid yet but say they will pay the money collector directly (by name, or "the organiser"), by cash or transfer.
- "other": anything else. A plan that does not say they will pay the collector directly, a question, a denial, a complaint, a payment made at an earlier time, a payment to someone who is not the money collector (or to anyone, when the collector is not known), or a message about something else.

amount: the amount of money the message says they paid or will pay, in pounds (8, 10.5), when it states one. null when it states none, which is most messages. Never copy it from what they owe.

Examples, if the money collector is Sam (English | Turkish):
paid: "Paid" | "ödedim"; "sent it" | "gönderdim abi"; "transferred" | "havale yaptım"; "bank transferred Sam" | "Sam'e havale yaptım"; "paid Sam cash" | "Sam'e elden verdim"; "sent Sam £8" (amount 8) | "Sam'e 8 pound attım" (amount 8)
paid_for_others: "paid for me and my mate" | "ikimizin parasını gönderdim"
will_pay_direct: "will send Sam tonight" | "akşam Sam'e atarım"; "I'll give the organiser £8 cash" (amount 8) | "organizatöre elden veririm"
other: "I'll pay later" | "sonra öderim"; "haven't paid yet" | "daha ödemedim"; "how much do I owe?" | "ne kadar borcum var?"; "did you get my payment?" | "parayı aldın mı?"; "did Sam get it?" | "Sam'e geçti mi?"; "paid last week" | "geçen hafta ödedim"; "paid Ali" | "Ali'ye verdim"; "👍"; "done 👍" answering a request to rate teammates

If you are not at least 80% sure, choose "other": a wrong "other" only means they say it again.

Output STRICT JSON only, no markdown, no fences:
{"intent": "paid" | "paid_for_others" | "will_pay_direct" | "other", "amount": <number or null>, "confidence": <number 0..1>, "reasoning": "<max 100 chars>"}`;
}

/** The model, as one function, so a test can drive the real parse
 *  without a key. */
export type PaymentClaimCall = (system: string, user: string) => Promise<string>;

export interface PaymentClaimContext {
  playerName?: string | null;
  /** "£8 for Tuesday 7-a-side": what they owe, so the model can see
   *  what a claim would be about. */
  owes?: string | null;
  /** Who receives this club's match fees (`Organisation.paymentHolderId`'s
   *  name). Paying them, by name, IS a claim (Feroz, FNF 2026-10-18). */
  collectorName?: string | null;
  /** The chat context (`loadDmReplyContext`): the time now, and the
   *  message they swipe-replied to or MatchTime's recent DMs to them.
   *  Absent: the time now, nothing known. */
  replyContext?: ReplyContext | null;
}

export interface PaymentClaimClassification {
  intent: PaymentClaimIntent;
  /** The amount the message states they paid or will pay, in pounds, or
   *  null when it states none (or the model's figure was not a real
   *  amount). Code compares it with what they owe (`payment-claim.ts`). */
  amount?: number | null;
  confidence: number;
  reasoning: string;
}

const OTHER = (reasoning: string): PaymentClaimClassification => ({ intent: "other", amount: null, confidence: 0, reasoning });

/** A stated amount, checked: a positive number of pounds up to £1,000,
 *  to the penny; null when it is not one. */
function statedAmount(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 1000) return null;
  return Math.round(v * 100) / 100;
}

/** Exported for unit tests. The JSON contract is load-bearing. */
export function parsePaymentClaim(rawText: string): PaymentClaimClassification {
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return OTHER("parse failed");
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return OTHER("parse failed");
    }
  }
  if (!parsed || typeof parsed !== "object") return OTHER("not an object");
  const obj = parsed as Record<string, unknown>;
  // RE-VALIDATED against the enum rather than trusted.
  const intent =
    typeof obj.intent === "string" && VALID.has(obj.intent) ? (obj.intent as PaymentClaimIntent) : "other";
  const confidence = typeof obj.confidence === "number" ? Math.max(0, Math.min(1, obj.confidence)) : 0;
  const reasoning = typeof obj.reasoning === "string" ? obj.reasoning.slice(0, 200) : "";
  if (intent !== "other" && confidence < PAYMENT_CLAIM_MIN_CONFIDENCE) {
    return { intent: "other", amount: null, confidence, reasoning: `[low-confidence forced] ${reasoning}` };
  }
  if (intent === "other") return { intent, amount: null, confidence, reasoning };
  // A figure that is not a real amount is a reading we cannot trust: `other`.
  const stated = obj.amount === null || obj.amount === undefined ? null : statedAmount(obj.amount);
  if (stated === null && obj.amount !== null && obj.amount !== undefined) {
    return { intent: "other", amount: null, confidence, reasoning: `[bad amount forced] ${reasoning}` };
  }
  return { intent, amount: stated, confidence, reasoning };
}

/**
 * TEST-ONLY seam, mirroring `DM_INTENT_STUB_FILE_ENV`. It stubs what
 * ENTERS the system (what the model said), never what the system
 * concludes: the owed-match gate, the write and the reply all run for
 * real behind it. `e2e/helpers/live-llm.ts` refuses a "live" run that can
 * still see it.
 */
export const PAYMENT_CLAIM_STUB_FILE_ENV = "MT_TEST_PAYMENT_CLAIM_STUB_FILE";

/** What separates the context lines from the message itself. */
const MESSAGE_HEADER = "THE DM:";

/** Everything after the header, trimmed, so a multi-line message is
 *  read whole. */
export function paymentClaimBodyOf(user: string): string {
  return bodyUnderHeader(user, MESSAGE_HEADER);
}

function stubCall(env: NodeJS.ProcessEnv): PaymentClaimCall | null {
  return dmClassifierStubCall(env[PAYMENT_CLAIM_STUB_FILE_ENV], {
    label: "payment-claim",
    header: MESSAGE_HEADER,
    // A label is an intent, or the model's whole JSON (starting "{") when a
    // spec needs a stated amount.
    answer: (label) =>
      label?.trim().startsWith("{")
        ? label
        : JSON.stringify({ intent: label ?? "other", amount: null, confidence: 1, reasoning: "payment-claim stub" }),
  });
}

/** The real call. Null when there is no key, which is `other`. */
function liveCall(): PaymentClaimCall | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return async (system, user) => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const { guardedAnthropicCall, systemBlock } = await import("./pipeline/llm");
    const anthropic = new Anthropic({ apiKey: key });
    const response = await guardedAnthropicCall("payment-claim", () =>
      anthropic.messages.create({
        model: PAYMENT_CLAIM_MODEL,
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

/** The user turn: context lines, then the message under a header. */
export function buildPaymentClaimUserTurn(text: string, ctx: PaymentClaimContext): string {
  return [
    ctx.playerName ? `Player: ${ctx.playerName}` : null,
    ctx.owes ? `They owe: ${ctx.owes}` : null,
    `Money collector: ${ctx.collectorName?.trim() || "(not known)"}`,
    renderReplyContext(ctx.replyContext ?? noReplyContext()),
    `${MESSAGE_HEADER}\n${text.trim()}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Ask the model, once, whether this DM is a payment claim.
 *
 * EVERY failure returns `other`, which writes nothing. `call` is
 * `undefined` to use the real (or stubbed) model and `null` to assert
 * there is none.
 */
export async function classifyPaymentClaim(
  text: string,
  ctx: PaymentClaimContext,
  call?: PaymentClaimCall | null,
): Promise<PaymentClaimIntent> {
  return (await classifyPaymentClaimDetailed(text, ctx, call)).intent;
}

/** The same, with confidence and reasoning (the live dry run prints them). */
export async function classifyPaymentClaimDetailed(
  text: string,
  ctx: PaymentClaimContext,
  call?: PaymentClaimCall | null,
): Promise<PaymentClaimClassification> {
  if (!text || !text.trim()) return OTHER("empty message");
  const fn = call === undefined ? (stubCall(process.env) ?? liveCall()) : call;
  if (!fn) return OTHER("classifier unavailable");
  try {
    return parsePaymentClaim(await fn(buildPaymentClaimSystemPrompt(), buildPaymentClaimUserTurn(text, ctx)));
  } catch (err) {
    // FAIL CLOSED: a message we did not understand changes nothing.
    console.error("[payment-claim] classifier call failed:", err);
    return OTHER("classifier error");
  }
}

