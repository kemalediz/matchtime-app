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
import { readFileSync } from "node:fs";

/** The model, pinned. Exported so the live dry run measures this one. */
export const PAYMENT_CLAIM_MODEL = "claude-haiku-4-5";

/** Below this the model is not sure enough to tell a collector a player
 *  says they have paid. The same bar as `dm-intent.ts` and
 *  `fee-confirm.ts`. */
export const PAYMENT_CLAIM_MIN_CONFIDENCE = 0.8;

/** The closed enum. Anything else the model returns becomes `other`. */
export type PaymentClaimIntent = "paid" | "paid_for_others" | "other";

const VALID: ReadonlySet<string> = new Set<PaymentClaimIntent>(["paid", "paid_for_others", "other"]);

/**
 * The prompt. One prompt for every org: a Sutton player writes Turkish as
 * readily as a Turkish club's player writes English, so both languages'
 * examples are always there. The NEGATIVE examples are the job: every one
 * contains a payment word and none of them is a claim.
 */
export function buildPaymentClaimSystemPrompt(): string {
  return `You read ONE private WhatsApp message sent to MatchTime, a football club's bot, by a player who currently owes a match fee. MatchTime sent them a pay link for it. You decide whether the message is the player TELLING you they have ALREADY PAID the club's money collector. You never answer the message.

Return ONE intent:

- "paid": the sender says the payment is DONE, for themselves. Examples: "Paid", "paid 👍", "sent it", "done 👍", "transferred", "just paid you", "paid mate", "money sent", "bank transfer done", "sent to Kemal", "paid Kemal cash at the pitch". Turkish: "ödedim", "gönderdim", "yolladım", "tamam ödedim", "attım parayı", "havale yaptım", "gönderdim abi".

- "paid_for_others": the sender says the payment is done AND that it covers somebody else too, or instead. Examples: "paid for me and my mate", "sent £16 for me and Ali", "paid for my brother as well", "ikimizin parasını gönderdim", "Ali'nin parasını da yolladım".

- "other": EVERYTHING else.

THE ONE DISTINCTION THAT MATTERS. Only a payment the sender states as already DONE counts. A plan, a promise, a question, a denial, a complaint, or a payment tied to some other time is "other", however many payment words it contains.

  "Paid"                            -> paid
  "sent it"                         -> paid
  "done 👍" (after a payment reminder) -> paid
  "ödedim"                          -> paid
  "gönderdim abi"                   -> paid
  "paid for me and my mate"         -> paid_for_others
  "I'll pay later"                  -> other, it is a plan
  "will send it tonight"            -> other, it is a plan
  "haven't paid yet"                -> other, it says the opposite
  "how much do I owe?"              -> other, it is a question
  "did you get my payment?"         -> other, it is a question to you
  "paid last week"                  -> other, it names another time; it may be another match or a dispute
  "can I pay by bank transfer?"     -> other, it is a question
  "why am I being asked to pay?"    -> other, it is a complaint
  "IN"                              -> other
  "👍"                              -> other, an acknowledgement is not a claim
  "sonra öderim"                    -> other, it is a plan
  "daha ödemedim"                   -> other, it says the opposite
  "ne kadar borcum var?"            -> other, it is a question
  "parayı aldın mı?"                -> other, it is a question
  "geçen hafta ödedim"              -> other, it names another time

A bare "done", "sent" or "tamam" only counts as a claim when MatchTime's last message to this player (shown below the context, when known) was about paying. If that last message was about something else (rating teammates, availability, a match reminder), a bare "done" answers THAT and is "other".

If you are not at least 80% sure, return "other" with a low confidence. A wrong "paid" tells the money collector that this player says they have paid; the collector still has to check and confirm, but it is a false message about somebody's money. A wrong "other" means the player may have to say it again. When in doubt, choose "other".

Output STRICT JSON only, no markdown, no fences:

{
  "intent": "paid" | "paid_for_others" | "other",
  "confidence": <number 0..1>,
  "reasoning": "<short justification, max 100 chars>"
}`;
}

/** The model, as one function, so a test can drive the real parse
 *  without a key. */
export type PaymentClaimCall = (system: string, user: string) => Promise<string>;

export interface PaymentClaimContext {
  playerName?: string | null;
  /** "£8 for Tuesday 7-a-side": what they owe, so the model can see
   *  what a claim would be about. */
  owes?: string | null;
  /** MatchTime's most recent DM to this player, when known. */
  lastBotDm?: string | null;
}

export interface PaymentClaimClassification {
  intent: PaymentClaimIntent;
  confidence: number;
  reasoning: string;
}

const OTHER = (reasoning: string): PaymentClaimClassification => ({ intent: "other", confidence: 0, reasoning });

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
    return { intent: "other", confidence, reasoning: `[low-confidence forced] ${reasoning}` };
  }
  return { intent, confidence, reasoning };
}

/**
 * TEST-ONLY seam, mirroring `DM_INTENT_STUB_FILE_ENV`. It stubs what
 * ENTERS the system (what the model said), never what the system
 * concludes: the owed-match gate, the write and the reply all run for
 * real behind it. `e2e/helpers/live-llm.ts` refuses a "live" run that can
 * still see it.
 */
export const PAYMENT_CLAIM_STUB_FILE_ENV = "MT_TEST_PAYMENT_CLAIM_STUB_FILE";

interface PaymentClaimStub {
  /** Trimmed message body → the intent the model would have returned. */
  bodies?: Record<string, PaymentClaimIntent>;
  /** Bodies whose model CALL throws, the way an overloaded API does. */
  fail?: string[];
}

/** What separates the context lines from the message itself. */
const MESSAGE_HEADER = "THE DM:";

/** Everything after the header, trimmed, so a multi-line message is
 *  read whole. */
export function paymentClaimBodyOf(user: string): string {
  const i = user.indexOf(`${MESSAGE_HEADER}\n`);
  return (i === -1 ? user : user.slice(i + MESSAGE_HEADER.length + 1)).trim();
}

function stubCall(env: NodeJS.ProcessEnv): PaymentClaimCall | null {
  const file = env[PAYMENT_CLAIM_STUB_FILE_ENV];
  if (!file) return null;
  return async (_system, user) => {
    let cfg: PaymentClaimStub = {};
    try {
      cfg = JSON.parse(readFileSync(file, "utf8")) as PaymentClaimStub;
    } catch {
      // Missing or garbled → no mapping at all, which is `other`.
      cfg = {};
    }
    const body = paymentClaimBodyOf(user);
    if ((cfg.fail ?? []).includes(body)) throw new Error("payment-claim stub: forced failure");
    return JSON.stringify({ intent: cfg.bodies?.[body] ?? "other", confidence: 1, reasoning: "payment-claim stub" });
  };
}

/** The real call. Null when there is no key, which is `other`. */
function liveCall(): PaymentClaimCall | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return async (system, user) => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const anthropic = new Anthropic({ apiKey: key });
    const response = await anthropic.messages.create({
      model: PAYMENT_CLAIM_MODEL,
      max_tokens: 200,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{ role: "user", content: user }],
    });
    const block = response.content.find((b) => b.type === "text");
    return block && block.type === "text" ? block.text : "";
  };
}

/** The user turn: context lines, then the message under a header. */
export function buildPaymentClaimUserTurn(text: string, ctx: PaymentClaimContext): string {
  return [
    ctx.playerName ? `Player: ${ctx.playerName}` : null,
    ctx.owes ? `They owe: ${ctx.owes}` : null,
    `MatchTime's last message to them: ${ctx.lastBotDm ? JSON.stringify(ctx.lastBotDm.slice(0, 300)) : "(not known)"}`,
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

