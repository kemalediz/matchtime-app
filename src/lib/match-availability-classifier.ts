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
 * Conservative by construction: "unclear" is the safe default and the
 * caller must treat it as "do nothing", never as a guess.
 *
 * One-shot Haiku call per unmatched reply. Cheap, and DM volume is low.
 */
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-4-5";

/** Below this the model is not sure enough to write to the squad. */
const MIN_CONFIDENCE = 0.75;

const SYSTEM_PROMPT = `You are classifying a football player's WhatsApp DM reply to their club's bot. The bot asked whether they can play in ONE specific upcoming match (for example: "we're putting the squad together for Tuesday football. Fancy it?").

Decide what the player is saying about THEIR OWN availability for THAT match:

- "in": any clear acceptance, however casual, idiomatic or brief. The word "in" is NOT required. Examples: "yeah sure count me in", "why not, coming", "go on then", "I'll be there mate", "yep im in", "count me in 👍", "aye", "im up for it", "see you there", "definitely", "put me down", "course I am", "sounds good see you tuesday", "yes please".

- "out": any clear decline for THAT match. Examples: "can't tomorrow sorry", "not this week", "sorry mate, away", "nah cant make it", "im working", "on holiday", "out this one", "no chance im injured", "gotta miss this week".

- "unclear": EVERYTHING else. Questions, hedges, tentatives, banter, off-topic chat, bare acknowledgements, replies about somebody other than the sender.

RULES (in priority order):
1. HEDGES ARE UNCLEAR, never "in" and never "out". If the reply contains any of: "maybe", "not sure", "I'll let you know", "I'll try", "probably", "possibly", "if I can", "depends", "we'll see", "hopefully" — return "unclear". "maybe, I'll let you know" is unclear.
2. A QUESTION about the match ("what time is it again?", "who else is playing?", "where are we playing?", "am I in?", "is there space?") is "unclear" — the player is asking, not answering. But a reply that clearly accepts AND also asks something ("go on then, what time?") is "in".
3. THIRD PARTIES ARE UNCLEAR. This decision only ever covers the SENDER. "Kieran is in", "my mate wants a game", "is Rashad playing" → "unclear".
4. PAST OR HYPOTHETICAL statements are "unclear": "I was in last week", "if I was fit I'd play".
5. BARE ACKNOWLEDGEMENTS ("ok", "👍", "yes", "cheers", "🙏") are "unclear" UNLESS the context line says the bot asked this player to play, in which case a bare affirmative ("yes", "👍", "ok") is "in" and a bare negative ("no", "👎", "nah") is "out".
6. If you are not at least 80% sure, return "unclear". A wrong "in" puts somebody in a squad they never asked to join; a wrong "out" drops somebody who wanted to play. Both are worse than asking again.

Output STRICT JSON only — no markdown, no fences:

{
  "decision": "in" | "out" | "unclear",
  "confidence": <number 0..1>,
  "reasoning": "<short justification, max 100 chars>"
}`;

export type MatchAvailability = "in" | "out" | "unclear";

export interface MatchAvailabilityClassification {
  decision: MatchAvailability;
  confidence: number;
  reasoning: string;
}

export interface MatchAvailabilityContext {
  playerName?: string | null;
  clubName?: string | null;
  /** "Tue 1 Sep, 20:00" — helps the model read "can't tomorrow". */
  matchWhen?: string | null;
  matchName?: string | null;
  /** True when the bot DM'd this player about this very match (a recruit
   *  invite or a follow-up). Unlocks bare affirmatives — see rule 5. */
  wasAskedToPlay?: boolean;
}

const UNCLEAR = (reasoning: string): MatchAvailabilityClassification => ({
  decision: "unclear",
  confidence: 0,
  reasoning,
});

export async function classifyMatchAvailability(
  replyBody: string,
  context: MatchAvailabilityContext = {},
): Promise<MatchAvailabilityClassification> {
  if (!replyBody || !replyBody.trim()) return UNCLEAR("empty reply");
  if (!process.env.ANTHROPIC_API_KEY) return UNCLEAR("classifier unavailable");
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const userText = [
      context.clubName ? `Club: ${context.clubName}` : null,
      context.playerName ? `Player: ${context.playerName}` : null,
      context.matchName ? `Match: ${context.matchName}` : null,
      context.matchWhen ? `Kick-off: ${context.matchWhen}` : null,
      `Bot asked this player to play in this match: ${context.wasAskedToPlay ? "yes" : "no"}`,
      `Reply: ${JSON.stringify(replyBody)}`,
    ]
      .filter(Boolean)
      .join("\n");
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 200,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [{ role: "user", content: userText }],
    });
    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === "text",
    );
    if (!textBlock) return UNCLEAR("no text block");
    return parse(textBlock.text);
  } catch (err) {
    console.error("[match-availability] Claude call failed:", err);
    return UNCLEAR("classifier error");
  }
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
  if (decision !== "unclear" && confidence < MIN_CONFIDENCE) {
    return {
      decision: "unclear",
      confidence,
      reasoning: `[low-confidence forced] ${reasoning}`,
    };
  }
  return { decision, confidence, reasoning };
}
