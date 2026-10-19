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
import { HAIKU_MODEL, HAIKU_SHORT_ANSWER_MAX_TOKENS, HAIKU_THINKING } from "./models";

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
 * English and Turkish side by side.
 *
 * Rewritten whole, and shorter, on 2026-10-18 (Feroz, FNF): "I bank
 * transferred Raihan" was read as `other` because the model was never told
 * Raihan is the money collector. The user turn now names the collector and
 * the context does the work; each intent is defined once. `will_pay_direct`
 * (Kemal, same day) is the pay page's "Pay the collector directly" button
 * said in words. The examples use a collector called Sam, so the live
 * check's Raihan cases prove the rule rather than echo an example.
 */
export function buildPaymentClaimSystemPrompt(): string {
  return `A player who owes a match fee sent MatchTime, their football club's bot, the private WhatsApp message under "THE DM". Above it you get what they owe, "Money collector:" (the club member the fees are paid to, through MatchTime's pay link or directly by cash or bank transfer) and MatchTime's last message to them (its words in quotes, or a description in brackets).

What is the player telling us about paying? Pick one:
- "paid": they say they have paid their own fee to the club: to the money collector (by name, even a first name or with a Turkish ending), "you", "the organiser", or nobody named. A bare "done" or "tamam" counts only if MatchTime's last message was about paying.
- "paid_for_others": they have paid, and it covers somebody else too, or instead.
- "will_pay_direct": they have not paid yet but say they will pay the money collector directly (by name, or "the organiser"), by cash or transfer.
- "other": anything else. A plan that does not say they will pay the collector directly, a question, a denial, a complaint, a payment made at an earlier time, a payment to someone who is not the money collector (or to anyone, when the collector is not known), or a message about something else.

Examples, if the money collector is Sam (English | Turkish):
paid: "Paid" | "ödedim"; "sent it" | "gönderdim abi"; "transferred" | "havale yaptım";"bank transferred Sam" | "Sam'e havale yaptım"; "paid Sam cash" | "Sam'e elden verdim"
paid_for_others: "paid for me and my mate" | "ikimizin parasını gönderdim"
will_pay_direct: "will send Sam tonight" | "akşam Sam'e atarım"; "I'll give the organiser cash" | "organizatöre elden veririm"
other: "I'll pay later" | "sonra öderim"; "haven't paid yet" | "daha ödemedim"; "how much do I owe?" | "ne kadar borcum var?"; "did you get my payment?" | "parayı aldın mı?"; "did Sam get it?" | "Sam'e geçti mi?"; "paid last week" | "geçen hafta ödedim"; "paid Ali" | "Ali'ye verdim"; "👍"; "done 👍" after a request to rate teammates

If you are not at least 80% sure, choose "other": a wrong "other" only means they say it again.

Output STRICT JSON only, no markdown, no fences:
{"intent": "paid" | "paid_for_others" | "will_pay_direct" | "other", "confidence": <number 0..1>, "reasoning": "<max 100 chars>"}`;
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
  /** MatchTime's most recent DM to this player, when known: its words, or
   *  a bracketed description when only its key was stored. */
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

/** A stored message goes in quotes; a bracketed description (a scheduler
 *  DM whose words were never stored) goes in as it is, as the prompt
 *  says. */
function lastDmLine(lastBotDm: string | null | undefined): string {
  if (!lastBotDm) return "(not known)";
  if (lastBotDm.startsWith("(") && lastBotDm.endsWith(")")) return lastBotDm;
  return JSON.stringify(lastBotDm.slice(0, 300));
}

/** The user turn: context lines, then the message under a header. */
export function buildPaymentClaimUserTurn(text: string, ctx: PaymentClaimContext): string {
  return [
    ctx.playerName ? `Player: ${ctx.playerName}` : null,
    ctx.owes ? `They owe: ${ctx.owes}` : null,
    `Money collector: ${ctx.collectorName?.trim() || "(not known)"}`,
    `MatchTime's last message to them: ${lastDmLine(ctx.lastBotDm)}`,
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

