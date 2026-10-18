/**
 * Classify a player's WhatsApp DM reply about ONE SPECIFIC upcoming match.
 *
 * WHY A SIBLING CLASSIFIER (2026-08-31)
 * -------------------------------------
 * `roster-survey-classifier.ts` answers a different question: "are you
 * still up for Tuesday football GOING FORWARD?" In that world "out" means
 * the player is permanently leaving the club and "not this week" is a
 * MAYBE. Reusing it for a per-match reply would be actively wrong — "can't
 * tomorrow sorry" is a firm OUT for this match, not a hedge about
 * membership. Same house style, same model, same conservative parse; a
 * different question.
 *
 * WHY AN LLM AND NOT A REGEX
 * --------------------------
 * Real replies from this club look like "yeah sure count me in", "why not,
 * coming", "go on then", "can't tomorrow sorry". Many of these players are
 * older and not technical; they write naturally and never type keywords. A
 * regex silently misses most of them, and a missed reply means a player
 * believes they are signed up while the squad stays short — the exact
 * silent-failure class that has already cost this club a week. The callers
 * keep a cheap regex FAST-PATH for the unambiguous cases and fall through
 * to this classifier for everything else.
 *
 * THE CONTEXT DOES THE WORK (rewritten whole, and shorter, 2026-10-18)
 * --------------------------------------------------------------------
 * A wrong "in" puts somebody in a squad from a DM. The model used to get
 * only a yes/no "the bot asked this player to play" flag; it now gets what
 * MatchTime actually said to the player last (`last-bot-dm.ts`, the same
 * reader the payment-claim classifier uses: its words, or what a scheduler
 * DM was about), the match with its day and time, and where the player
 * stands for it. A bare "yes" is an answer only to a question about
 * playing, and the model can now see whether there was one. Turkish is part
 * of the one definition rather than a rule bolted on, and every verdict is
 * logged.
 *
 * Conservative by construction: "unclear" is the safe default and the
 * caller must treat it as "do nothing", never as a guess.
 *
 * One-shot Haiku call per unmatched reply. Cheap, and DM volume is low.
 * No database here: callers load the context (`match-availability-
 * context.ts`), so the live dry run (`scripts/dryrun-match-availability.ts`)
 * imports the exact production prompt without importing Prisma.
 */
import { lastBotDmLine } from "./last-bot-dm";

/** The model, pinned. Exported so the live dry run measures this one. */
export const MATCH_AVAILABILITY_MODEL = "claude-haiku-4-5";

/**
 * Below this the model is not sure enough to write to the squad. 0.8, the
 * bar the prompt states and the same as the sibling DM classifiers
 * (`payment-claim-classifier.ts`, `dm-intent.ts`, `fee-confirm.ts`). It was
 * 0.75 in code while the prompt said 80%; the stricter one wins because a
 * wrong "in" adds somebody to a squad, while a wrong "unclear" only means
 * the reply is asked again or handled as a normal DM.
 */
export const MATCH_AVAILABILITY_MIN_CONFIDENCE = 0.8;

/** What separates the context lines from the message itself. */
const MESSAGE_HEADER = "THE DM:";

/**
 * The prompt. One prompt for every org, English and Turkish side by side:
 * a Sutton player writes Turkish as readily as a Turkish club's player
 * writes English.
 */
export function buildMatchAvailabilitySystemPrompt(): string {
  return `A football player sent MatchTime, their club's WhatsApp bot, the private message under "THE DM". Above it you get the match it is about (its day and time), the player's current status for that match, and MatchTime's last message to them (its words in quotes, or a description in brackets).

Is the player telling us whether THEY will play in THAT match? Pick one:
- "in": they say they will play, in any words, however casual. A yes that also asks something ("go on then, what time?") is still "in"; a question with no yes in it is not.
- "out": they say they will not play in that match, in any words: a no, or a reason they cannot come.
- "unclear": anything else. A maybe, "I'll try" or a promise to confirm later; a question on its own; a message about somebody other than the sender; a past or hypothetical game; or a message about something else.
A bare "yes", "ok" or "👍" is "in", and a bare "no" or "👎" is "out", only when MatchTime's last message asked them whether they can play. When it was about something else, or is not known, a bare reply is "unclear".

Examples (English | Turkish):
in: "yeah sure count me in" | "varım"; "why not, coming" | "geliyorum"; "put me down" | "sayın beni"; "go on then, what time?" | "tamam gelirim, saat kaçta?"
out: "can't tomorrow sorry" | "gelemiyorum"; "not this week" | "bu hafta yokum"; "sorry mate, working" | "işteyim abi"
unclear: "maybe, I'll let you know" | "belki, haber veririm"; "I'll try" | "bakarız"; "what time is it again?" | "saat kaçta?"; "Kieran is in" | "Ahmet geliyor"; "I was in last week" | "geçen hafta vardım"; "yes" | "evet" when the last message was a request to rate teammates, or is not known

If you are not at least 80% sure, choose "unclear": a wrong "in" puts them in a squad they never joined and a wrong "out" drops someone who wanted to play, while "unclear" changes nothing.

Output STRICT JSON only, no markdown, no fences:
{"decision": "in" | "out" | "unclear", "confidence": <number 0..1>, "reasoning": "<max 100 chars>"}`;
}

export type MatchAvailability = "in" | "out" | "unclear";

export interface MatchAvailabilityClassification {
  decision: MatchAvailability;
  confidence: number;
  reasoning: string;
}

export interface MatchAvailabilityContext {
  /** For the verdict log only; never sent to the model. */
  userId?: string | null;
  /** For the verdict log only; never sent to the model. */
  matchId?: string | null;
  playerName?: string | null;
  clubName?: string | null;
  matchName?: string | null;
  /** "Tue 1 Sep, 20:00" — helps the model read "can't tomorrow". */
  matchWhen?: string | null;
  /** `availabilityStatusLabel(...)`: where the player stands for it. */
  currentStatus?: string | null;
  /** MatchTime's most recent DM to this player (`last-bot-dm.ts`): its
   *  words, or a bracketed description of a scheduler DM. A bare "yes" is
   *  an answer only when this asked about playing. */
  lastBotDm?: string | null;
}

/** Where the player stands for the match, in the words the model reads. */
export function availabilityStatusLabel(input: {
  status: "CONFIRMED" | "BENCH" | "DROPPED" | null;
  tentative?: boolean;
}): string {
  const base =
    input.status === "CONFIRMED"
      ? "in the squad"
      : input.status === "BENCH"
        ? "on the bench"
        : input.status === "DROPPED"
          ? "dropped out"
          : "not signed up";
  return input.tentative ? `said maybe, ${base}` : base;
}

/** The user turn: context lines, then the message under a header. */
export function buildMatchAvailabilityUserTurn(text: string, ctx: MatchAvailabilityContext): string {
  const match = [ctx.matchName, ctx.matchWhen].filter(Boolean).join(", ");
  return [
    ctx.clubName ? `Club: ${ctx.clubName}` : null,
    ctx.playerName ? `Player: ${ctx.playerName}` : null,
    match ? `Match: ${match}` : null,
    `Their status for it: ${ctx.currentStatus?.trim() || "(not known)"}`,
    `MatchTime's last message to them: ${lastBotDmLine(ctx.lastBotDm)}`,
    `${MESSAGE_HEADER}\n${text.trim()}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The model, as one function, so a test (and the dry run) can drive the
 *  real parse without a key. */
export type MatchAvailabilityCall = (system: string, user: string) => Promise<string>;

const UNCLEAR = (reasoning: string): MatchAvailabilityClassification => ({
  decision: "unclear",
  confidence: 0,
  reasoning,
});

/** The real call. Null when there is no key, which is "unclear". */
function liveCall(): MatchAvailabilityCall | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return async (system, user) => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const { guardedAnthropicCall } = await import("./pipeline/llm");
    const anthropic = new Anthropic({ apiKey: key });
    const response = await guardedAnthropicCall("match-availability", () =>
      anthropic.messages.create({
        model: MATCH_AVAILABILITY_MODEL,
        max_tokens: 200,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }],
        messages: [{ role: "user", content: user }],
      }),
    );
    const block = response.content.find((b) => b.type === "text");
    return block && block.type === "text" ? block.text : "";
  };
}

/**
 * Ask the model, once, what this DM says about the player's availability.
 *
 * EVERY failure returns "unclear", which writes nothing. `call` is
 * `undefined` to use the real model and `null` to assert there is none.
 * Every verdict the model was asked for is logged, "unclear" included.
 */
export async function classifyMatchAvailability(
  replyBody: string,
  context: MatchAvailabilityContext = {},
  call?: MatchAvailabilityCall | null,
): Promise<MatchAvailabilityClassification> {
  if (!replyBody || !replyBody.trim()) return UNCLEAR("empty reply");
  const fn = call === undefined ? liveCall() : call;
  if (!fn) return UNCLEAR("classifier unavailable");
  let verdict: MatchAvailabilityClassification;
  try {
    verdict = parse(
      await fn(buildMatchAvailabilitySystemPrompt(), buildMatchAvailabilityUserTurn(replyBody, context)),
    );
  } catch (err) {
    // FAIL CLOSED: a reply we did not understand changes nothing.
    console.error("[match-availability] Claude call failed:", err);
    verdict = UNCLEAR("classifier error");
  }
  console.info(
    `[match-availability] verdict user=${context.userId ?? "?"} match=${context.matchId ?? "?"} ` +
      `intent=${verdict.decision} confidence=${verdict.confidence.toFixed(2)} ` +
      `reasoning=${JSON.stringify(verdict.reasoning.slice(0, 120))}`,
  );
  return verdict;
}

/** Exported for unit tests — the JSON contract is load-bearing. */
export function parse(rawText: string): MatchAvailabilityClassification {
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return UNCLEAR("parse failed");
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return UNCLEAR("parse failed");
    }
  }
  if (!parsed || typeof parsed !== "object") return UNCLEAR("not an object");
  const obj = parsed as Record<string, unknown>;
  const VALID = new Set(["in", "out", "unclear"]);
  const decision =
    typeof obj.decision === "string" && VALID.has(obj.decision)
      ? (obj.decision as MatchAvailability)
      : "unclear";
  const confidence =
    typeof obj.confidence === "number" ? Math.max(0, Math.min(1, obj.confidence)) : 0;
  const reasoning = typeof obj.reasoning === "string" ? obj.reasoning.slice(0, 200) : "";
  // A wobbly call must never write to a squad.
  if (decision !== "unclear" && confidence < MATCH_AVAILABILITY_MIN_CONFIDENCE) {
    return {
      decision: "unclear",
      confidence,
      reasoning: `[low-confidence forced] ${reasoning}`,
    };
  }
  return { decision, confidence, reasoning };
}
