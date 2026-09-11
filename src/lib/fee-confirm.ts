/**
 * THE MONEY COLLECTOR'S "YES" — an anchored allowlist that answers the
 * question we ASKED, and a model for everything else.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT WAS HERE UNTIL 2026-09-11
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `payment-flow.ts`'s `isAffirmative`, whose first line was:
 *
 *     if (/[✅✔👍]/u.test(text)) return true;
 *
 * A thumbs-up ANYWHERE in the body released per-player pay links to the
 * whole confirmed squad. "great game 👍", typed while a fee confirmation
 * was pending, charged 8-13 real people. The word list under it was
 * unanchored at the end —
 *
 *     /^(yes|yeah|yep|yup|ok|okay|confirm|send|correct|sure|go)\b/
 *
 * — so "ok so I'll sort it tomorrow" was a yes too. `isNegative` had the
 * same two shapes, so "no worries mate" silently cancelled a pending
 * fee.
 *
 * This is the family this codebase has now deleted five times, each time
 * after a production incident (`__tests__/no-conjunction-classifiers.
 * test.ts` keeps the register). It is the mildest member of it — see
 * "HOW BAD WAS IT, HONESTLY" below — but it is the only one left
 * standing in front of money.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT THE COLLECTOR ACTUALLY DOES — MEASURED, NOT IMAGINED
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Read out of production on 2026-09-11 (`BotJob` + `Match` fee columns;
 * inbound DMs are not persisted anywhere, so the OUTCOME is recoverable
 * and the exact typed words are not):
 *
 *   6   fee-confirmation prompts ever sent, 2026-06-09 → 2026-09-08
 *   6   released — every single one confirmed, at the prompted amount
 *   0   cancelled (`isNegative` has never fired in production)
 *   0   superseded (no collector has ever answered with a new amount)
 *
 *   response time: 26s, 31s, 32s, 42s, 2m16s, 20m42s
 *   TOTAL TIME `feePendingConfirm` HAS EVER BEEN NON-NULL: ~25 minutes,
 *   across 94 days.
 *
 * So the live window in which a stray 👍 could have fired is about 25
 * minutes in three months, and in those 25 minutes it never did. THE
 * CURRENT BEHAVIOUR HAS NEVER MISFIRED. That is evidence about how hard
 * to swing, and it is why this is a tightening rather than a rewrite of
 * the flow.
 *
 * What the same collector types the rest of the time is the other half
 * of the evidence. Of his 467 messages in the live group:
 *
 *   4   contain ✅ or 👍 — and ALL FOUR are inside a sentence, none is a
 *       bare emoji. One of them is "Quick heads-up on match payments…".
 *  16   begin with a word-list token but run longer than two words:
 *       "yes, Elvin still collects it", "ok i will call goals and switch
 *       to 7aside again", "sure will do", "yes pls, can you share the
 *       name?"
 *
 * Every one of those twenty is a false "yes" under the deleted test. He
 * has simply never typed one of them into a DM during those 25 minutes.
 * (Caveat, said plainly: those are GROUP messages. The fee path only
 * ever reads DMs, and no DM corpus exists. It is the best available
 * sample of how this person writes, not a sample of the input.)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * HOW BAD WAS IT, HONESTLY — BOTH DIRECTIONS PRICED
 * ═══════════════════════════════════════════════════════════════════════
 *
 * A WRONG RELEASE costs: 8-13 personal DMs, from an UNOFFICIAL WhatsApp
 * client, asking real people for money at a moment the collector did not
 * choose — some of whom may have already paid him in cash. It is
 * irreversible in the one way that matters: `paymentLinksReleasedAt` is
 * stamped, so the links are out and the flow cannot be re-run. The
 * amount is at least never invented — it is whatever MatchTime had just
 * echoed back — EXCEPT in the one case this change also fixes: under the
 * old ordering "✅ actually make it £12" released at the OLD price,
 * because the affirmative test ran before the amount test.
 *
 * A WRONG REFUSAL costs: one re-typed message. `feePendingConfirm`
 * survives untouched, the prompt is still on his phone, and the next
 * "✅" works.
 *
 * These are NOT symmetric, but they are far closer than the mass-DM
 * cases that motivated `stats-blast.ts` and `dm-intent.ts` — there the
 * downside was 69 DMs and possibly the WhatsApp account, and the upside
 * of firing was an unasked-for convenience. Here both outcomes are
 * recoverable and neither is catastrophic. That is why the answer below
 * is not "route it through the model and be done".
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE TWO GATES THAT MAKE THIS A NARROW PROBLEM
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Unlike every classifier deleted before it, this one never reads cold
 * text. `handleCollectorFeeReply` only consults it when BOTH hold:
 *
 *   1. the sender is the org's `paymentHolderId` — one person per club;
 *   2. `match.feePendingConfirm != null` — MatchTime asked a closed
 *      question, in writing, seconds ago: *Reply ✅ (or "yes") to send
 *      everyone their pay link, or send a different amount to change
 *      it.*
 *
 * It is resolving a prompt, not classifying a message. That is a far
 * easier problem than "is this sentence an instruction to the bot", and
 * it is why an allowlist is a legitimate tool here in a way it was not
 * on the analyze route.
 */

import { readFileSync } from "node:fs";

/**
 * ⚠️ THE ARGUED DESIGN, IN ONE FLAG. The deterministic allowlist decides
 * FIRST and the model is only ever asked what the allowlist abstained
 * on. Set `false` nowhere: this constant exists to name the decision and
 * to make anyone who wants to change it read the argument.
 *
 * ── WHY NOT "JUST TIGHTEN THE REGEX" (the `HELP_RE` answer) ──────────
 *
 * §2.4 of `MDs/router-accuracy-2026-09-11.md` kept one regex, and the
 * reasoning transfers almost completely: an anchored whole-body test is
 * *structurally incapable* of matching a fragment, which is the single
 * property that caused 2026-04-21, 2026-09-01, 2026-09-10 and this. The
 * affirmative vocabulary here is closed and tiny — the prompt literally
 * tells the collector which two things to type — so an allowlist is the
 * right tool for the case that actually occurs, and it costs nothing:
 * no key, no network, no latency, no spend, and no new way to fail on
 * the money path.
 *
 * The reason it is not the WHOLE answer is the one thing the production
 * read could not recover. Inbound DMs are not persisted, so we know all
 * six confirmations succeeded but NOT what was typed. Under the deleted
 * code a release fired on "an emoji anywhere" OR "one of twelve opening
 * words" OR "an exact phrase" — three very different inputs, and they
 * are indistinguishable after the fact. Shipping an anchored allowlist
 * ALONE would therefore be shipping an unmeasured risk of refusing a
 * reply that has worked six times out of six, on the live money path of
 * a paying club. That is not a risk worth taking to avoid one model
 * call.
 *
 * ── WHY NOT "JUST ASK THE MODEL" (the `dm-intent.ts` answer) ─────────
 *
 * Because it would put a network call in front of the ONE reply we told
 * the collector to send. "✅" is not a classification problem; it is a
 * token match against a two-item menu we wrote ourselves, and a model
 * is strictly worse at that than the menu is. Routing it through Haiku
 * would mean an Anthropic outage, an expired key or a 30s timeout can
 * break the documented happy path of a live money flow — a failure mode
 * that does not exist today and that buys nothing, because the model
 * cannot be more right about "✅" than the allowlist already is.
 *
 * ── SO: BOTH, IN THAT ORDER, AND THE ORDER IS THE WHOLE POINT ───────
 *
 *   1. `anchoredFeeReply` — whole-body, `^…$` in effect: strip the
 *      affirm/deny emoji, and require what REMAINS to be empty or an
 *      exact member of a ~30-token set. "great game 👍" leaves "great
 *      game", which is not in the set, so it abstains. Deterministic,
 *      free, offline, and it cannot match a fragment.
 *   2. a fresh amount — `looksLikeFeeAmount` + `parseFeeReply`, also
 *      deterministic, also before the model, so "make it £12" can never
 *      be read as a confirmation of £10.30.
 *   3. only then the model, on a message that is neither the menu
 *      answer nor a number — i.e. approximately never. It returns a
 *      three-value enum and NOTHING ELSE; every gate and the action
 *      itself stay in code, which is this codebase's stated split.
 *
 * This is a WIDENING, not just a tightening: "yeah go on then, fire
 * them out" works now and did not before. The thing that got narrower
 * is only the fragment.
 *
 * ── WHICH WAY IT FAILS, AND WHAT THAT COSTS ─────────────────────────
 *
 * Every model failure — no key, a thrown call, a timeout, unparseable
 * JSON, an intent outside the enum, a confidence under the floor — is
 * `neither`. `neither` releases nothing, cancels nothing and stages
 * nothing: `handleCollectorFeeReply` returns null, the DM falls through
 * to the handlers below it exactly as unrecognised chatter always has,
 * and `feePendingConfirm` is still set. The collector re-types "✅" and
 * that path never touches the model. So the blast radius of the new
 * dependency is: natural-language confirmations stop working until
 * Anthropic comes back. `__tests__/fee-confirm.test.ts` proves both
 * halves — a throwing classifier releases nothing, and "✅" still
 * releases with the classifier throwing.
 *
 * ── WHAT THIS MAKES WORSE, SAID OUT LOUD ────────────────────────────
 *
 *   A SECOND THING TO GET WRONG. The model can, in principle, read
 *   "great game 👍" as a yes — the exact bug, reintroduced one layer
 *   down. The prompt carries that message as a named negative example
 *   and the floor is 0.8, but a prompt is not a proof, which is why
 *   `scripts/dryrun-fee-confirm.ts` exists and must be re-run against
 *   the live model if the prompt or the model is ever changed.
 *
 *   LATENCY ON A PATH THAT HAD NONE. Only on messages the allowlist
 *   abstains on, only while a fee is pending — measured above at ~25
 *   minutes in 94 days — so the expected number of live model calls per
 *   month is close to zero. It is not zero.
 */
export const FEE_CONFIRM_ANCHORS_BEFORE_IT_ASKS = true;

/**
 * Below this the model is not sure enough to charge 8-13 people, or to
 * throw away an amount the collector has already typed once.
 *
 * ONE number for both directions, deliberately, and it is the same 0.8
 * `dm-intent.ts` uses. A cheaper bar for `no` is tempting — cancelling
 * is the harmless half — but a wrong `no` still silently discards the
 * amount and makes MatchTime look broken, and a second threshold is a
 * second thing nobody would remember to re-argue.
 */
export const FEE_REPLY_MIN_CONFIDENCE = 0.8;

/** The closed enum. Anything else the model returns becomes `neither`. */
export type FeeReply = "yes" | "no" | "neither";

const VALID: ReadonlySet<string> = new Set<FeeReply>(["yes", "no", "neither"]);

// ── THE DETERMINISTIC HALF ───────────────────────────────────────────

/** ✅ ✔ 👍 — matched, then REMOVED, so what is left has to stand on its
 *  own. This is the difference between an allowlist and the fragment
 *  test it replaces. */
const AFFIRM_EMOJI = /[✅✔\u{1F44D}]/gu;
/** ❌ ✖ 🚫 👎. `👎` is new — the old `isNegative` missed it, and a wrong
 *  `no` costs one re-typed amount. */
const DENY_EMOJI = /[❌✖\u{1F6AB}\u{1F44E}]/gu;
/** Variation selectors and skin tones, so `✔️` and `👍🏽` reduce to the
 *  same nothing as `✔` and `👍`. */
const EMOJI_MODIFIERS = /[\uFE0E\uFE0F\u{1F3FB}-\u{1F3FF}]/gu;

/** What the collector types when he means yes. Every entry is a WHOLE
 *  message, never a prefix. */
const YES_WORDS: ReadonlySet<string> = new Set([
  "y", "ye", "yes", "yep", "yeah", "yeh", "yup", "ya", "yes please", "yes pls",
  "ok", "oki", "okay", "okey", "k", "kk", "ok send", "ok send them", "okay send",
  "confirm", "confirmed", "correct", "thats correct", "thats right", "that is right",
  "send", "send it", "send them", "send it out", "send them out", "send the links",
  "yes send", "yes send it", "yes send them", "yes confirm", "yes go", "yes go ahead",
  "release", "release them", "go", "go on", "go ahead", "do it", "sure", "right",
  "perfect", "great", "good", "thats it", "all good", "spot on", "agreed", "approved",
]);

/** …and when he means not yet. */
const NO_WORDS: ReadonlySet<string> = new Set([
  "n", "no", "nope", "nah", "naw", "no thanks", "no not yet", "not yet", "not now",
  "cancel", "cancel it", "stop", "stop it", "wait", "wait a sec", "hold", "hold on",
  "hold off", "hang on", "dont", "do not", "dont send", "do not send", "not right now",
  "one sec", "one moment", "later", "ignore", "ignore that", "scrap that", "forget it",
]);

/** Everything that is not a letter, a digit or a space, collapsed. The
 *  digits are KEPT so "12" and "ok 12" stay out of the word sets and
 *  fall to the amount test instead. */
function words(text: string): string {
  return text
    .toLowerCase()
    // Apostrophes are DELETED, not spaced, so "that's right" and "don't
    // send" reduce to the same tokens as "thats right" and "dont send"
    // rather than splitting into a third word.
    .replace(/['’‘`]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The whole-body allowlist. Returns `null` — ABSTAIN, not "no" — for
 * anything it does not recognise, which is what lets the model have the
 * remainder.
 *
 * The rule, in one line: strip the affirm/deny emoji, and whatever is
 * left must be empty or an exact member of the matching set. A message
 * carrying both kinds of emoji, or a recognised emoji plus unrecognised
 * prose, abstains — it is exactly the "great game 👍" shape and the
 * whole reason this function exists.
 */
export function anchoredFeeReply(text: string): "yes" | "no" | null {
  if (!text) return null;
  const hasYes = AFFIRM_EMOJI.test(text);
  AFFIRM_EMOJI.lastIndex = 0;
  const hasNo = DENY_EMOJI.test(text);
  DENY_EMOJI.lastIndex = 0;
  if (hasYes && hasNo) return null; // "👍❌" is a conversation, not an answer

  const rest = words(
    text.replace(AFFIRM_EMOJI, " ").replace(DENY_EMOJI, " ").replace(EMOJI_MODIFIERS, " "),
  );

  if (hasYes) return rest === "" || YES_WORDS.has(rest) ? "yes" : null;
  if (hasNo) return rest === "" || NO_WORDS.has(rest) ? "no" : null;
  if (rest === "") return null;
  if (YES_WORDS.has(rest)) return "yes";
  if (NO_WORDS.has(rest)) return "no";
  return null;
}

// ── THE MODEL HALF ───────────────────────────────────────────────────

const MODEL = "claude-haiku-4-5";

/**
 * The prompt. The NEGATIVE examples are the point, and they are not
 * invented: "great game 👍" is the message this whole change exists to
 * refuse, and the rest are real messages this collector has written in
 * the live group, lifted verbatim from `AnalyzedMessage`.
 *
 * Note what it is NOT asked. It never sees the squad, never proposes an
 * amount and never decides whether the sender is allowed to do this.
 * It answers one closed question about one reply.
 */
export const FEE_REPLY_SYSTEM_PROMPT = `You read ONE short private WhatsApp reply from the person who collects match fees for a football club. A moment ago the bot asked them, in writing:

  "Got it — £X per player for <match>, N players to charge. Reply ✅ (or \\"yes\\") to send everyone their pay link, or send a different amount to change it."

You decide whether their reply is a DIRECT ANSWER to that question.

Return ONE intent:

- "yes": they are telling you to send the pay links now, at the amount you just quoted. Examples: "yeah go on then", "go ahead and send them", "that's right, fire them out", "sounds right, send em", "correct, send the links".

- "no": they are telling you NOT to send them, or not yet. Examples: "hold off for now", "not yet, let me count the cash first", "leave it till tomorrow", "don't send them", "scrap that".

- "neither": EVERYTHING else.

THE ONE DISTINCTION THAT MATTERS. A reply is only "yes" or "no" if it ANSWERS the question. Chat, thanks, banter, a question of their own, a statement about a player, or a plan to deal with it later are all "neither" — however many thumbs-up, ticks, "ok"s or "yes"es they contain. A message can contain 👍 without being an answer, and "ok" can open a sentence about something else entirely.

  "👍"                                          -> yes
  "yes send them"                               -> yes
  "great game 👍"                               -> neither, it is banter and the 👍 is not an answer
  "cheers lads, great game 👍"                  -> neither
  "ok so I'll sort it tomorrow"                 -> neither, that is a plan, not a go-ahead
  "yes, Elvin still collects it"                -> neither, it answers a different question
  "sure will do"                                -> neither, they are agreeing to do something themselves
  "yes pls, can you share the name?"            -> neither, it is a question
  "ok i will call goals and switch to 7aside"   -> neither
  "✅ means that player has been accepted"      -> neither, it is explaining an emoji
  "no worries mate, great game"                 -> neither, "no" is not a refusal here
  "how many are paying?"                        -> neither
  "did Wasim turn up in the end?"               -> neither
  "make it £12"                                 -> neither, an amount is handled elsewhere

If you are not at least 80% sure, return "neither" with a low confidence. A wrong "yes" asks up to 13 real people for money at a moment the collector did not choose, and cannot be undone. A wrong "no" throws away an amount they already typed. A wrong "neither" costs them one re-typed message, which is the cheapest of the three by a wide margin — when in doubt, choose it.

Output STRICT JSON only — no markdown, no fences:

{
  "intent": "yes" | "no" | "neither",
  "confidence": <number 0..1>,
  "reasoning": "<short justification, max 100 chars>"
}`;

/** The model, as one function, so a test can drive the real parse
 *  without a key. */
export type FeeReplyCall = (system: string, user: string) => Promise<string>;

export interface FeeReplyContext {
  /** The amount awaiting confirmation — what a "yes" would charge. */
  amount: number;
  /** The match it belongs to, so the model can see it is answering
   *  about a specific game. */
  matchName: string;
}

export interface FeeReplyClassification {
  intent: FeeReply;
  confidence: number;
  reasoning: string;
}

const NEITHER = (reasoning: string): FeeReplyClassification => ({
  intent: "neither",
  confidence: 0,
  reasoning,
});

/** Exported for unit tests — the JSON contract is load-bearing. */
export function parseFeeReplyIntent(rawText: string): FeeReplyClassification {
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
  // RE-VALIDATED against the enum rather than trusted: structured output
  // guarantees shape, never semantics.
  const intent =
    typeof obj.intent === "string" && VALID.has(obj.intent) ? (obj.intent as FeeReply) : "neither";
  const confidence =
    typeof obj.confidence === "number" ? Math.max(0, Math.min(1, obj.confidence)) : 0;
  const reasoning = typeof obj.reasoning === "string" ? obj.reasoning.slice(0, 200) : "";
  if (intent !== "neither" && confidence < FEE_REPLY_MIN_CONFIDENCE) {
    return { intent: "neither", confidence, reasoning: `[low-confidence forced] ${reasoning}` };
  }
  return { intent, confidence, reasoning };
}

/**
 * TEST-ONLY seam, mirroring `DM_INTENT_STUB_FILE_ENV`. A write path that
 * can only be exercised by spending money is a write path nobody
 * exercises — and this one is the write path that charges a real club.
 *
 * It stubs what ENTERS the system (what the model said), never what the
 * system concludes.
 */
export const FEE_REPLY_STUB_FILE_ENV = "MT_TEST_FEE_REPLY_STUB_FILE";

interface FeeReplyStub {
  /** Trimmed reply → the intent the model would have returned. */
  bodies?: Record<string, FeeReply>;
  /** Replies whose model CALL throws, the way an overloaded API does. */
  fail?: string[];
}

function stubCall(env: NodeJS.ProcessEnv): FeeReplyCall | null {
  const file = env[FEE_REPLY_STUB_FILE_ENV];
  if (!file) return null;
  return async (_system, user) => {
    let cfg: FeeReplyStub = {};
    try {
      cfg = JSON.parse(readFileSync(file, "utf8")) as FeeReplyStub;
    } catch {
      // Missing or garbled → behave as if there were no mapping at all,
      // which is the direction that cannot release anybody's pay links.
      cfg = {};
    }
    const body = feeReplyBodyOf(user);
    if ((cfg.fail ?? []).includes(body)) throw new Error("fee-reply stub: forced failure");
    return JSON.stringify({
      intent: cfg.bodies?.[body] ?? "neither",
      confidence: 1,
      reasoning: "fee-reply stub",
    });
  };
}

/** What separates the context lines from the reply itself. */
const REPLY_HEADER = "THEIR REPLY:";

/** Everything after the header, trimmed — so a multi-line reply is read
 *  whole rather than by its last line. */
export function feeReplyBodyOf(user: string): string {
  const i = user.indexOf(`${REPLY_HEADER}\n`);
  return (i === -1 ? user : user.slice(i + REPLY_HEADER.length + 1)).trim();
}

/**
 * Ask the model, once, whether this reply answers the fee prompt.
 *
 * EVERY failure returns `neither`. That is not a convention, it is the
 * safety property: `neither` is the value that moves no money.
 *
 * `call` is `undefined` to use the real (or stubbed) model, and `null`
 * to assert there is none.
 */
export async function classifyFeeReply(
  text: string,
  ctx: FeeReplyContext,
  call?: FeeReplyCall | null,
): Promise<FeeReply> {
  if (!text || !text.trim()) return "neither";
  const fn = call === undefined ? (stubCall(process.env) ?? liveCall()) : call;
  if (!fn) return "neither";
  const user = [
    `The bot asked about: ${ctx.matchName}`,
    `The amount awaiting confirmation: ${gbpish(ctx.amount)}`,
    // A HEADER, not a last line: a real WhatsApp reply can be several
    // lines long, and a seam that read only the last line would
    // classify a fragment — which is the bug this file replaces.
    `${REPLY_HEADER}\n${text.trim()}`,
  ].join("\n");
  try {
    return parseFeeReplyIntent(await fn(FEE_REPLY_SYSTEM_PROMPT, user)).intent;
  } catch (err) {
    // FAIL CLOSED. An overloaded API, a network blip, a revoked key —
    // all of them are "we did not understand this reply", and the thing
    // MatchTime does with a reply it did not understand is nothing.
    console.error("[fee-confirm] classifier call failed:", err);
    return "neither";
  }
}

/** Local £ formatting — `payments.ts`'s `gbp` would be a circular
 *  import (it pulls the flow in via `payment-flow`), and this file is
 *  deliberately dependency-free apart from the SDK. */
function gbpish(amount: number): string {
  return amount % 1 === 0 ? `£${amount.toFixed(0)}` : `£${amount.toFixed(2)}`;
}

/** The real call. Null when there is no key — which is `neither`. */
function liveCall(): FeeReplyCall | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return async (system, user) => {
    // Imported lazily so a unit test that never reaches the live path
    // does not pay for loading the SDK.
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const anthropic = new Anthropic({ apiKey: key });
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 200,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{ role: "user", content: user }],
    });
    const block = response.content.find((b) => b.type === "text");
    return block && block.type === "text" ? block.text : "";
  };
}
