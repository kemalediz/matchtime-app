/**
 * Classify a player's WhatsApp DM reply to a roster check-in.
 *
 * Deliberately tight prompt: we want one of {in, maybe, out, unclear}
 * with conservative defaults. If the message could plausibly be off-
 * topic (random question, photo, joke), Claude is told to return
 * "unclear" and we route to a clarification DM instead of saving a
 * dubious classification. Better to ask twice than to misclassify.
 *
 * One-shot Haiku call per reply. Cheap (~£0.001 each) and the volume
 * is low (one per player per survey, plus a clarification round at
 * worst).
 */
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-4-5";

const SYSTEM_PROMPT = `You are classifying a player's WhatsApp DM reply to a "roster check-in" survey from their football club. The bot has DM'd them: "Are you still up for Tuesday football going forward? Reply yes / maybe / not for now."

Classify their reply into ONE of:

- "in": clearly committing to keep playing. Examples: "yes", "I'm in", "definitely", "still keen", "of course", "yeah why not", "100%", "always", "always in mate".
- "maybe": tentative, conditional, ad-hoc. Examples: "depends", "sometimes", "if I'm free", "not every week", "ad hoc", "maybe", "occasionally", "when I can", "depends on knee", "I'll play if there's room".
- "out": clearly stepping back, dropping out, or saying no. Examples: "not for now", "I'm done", "won't make it anymore", "step me back", "out", "I can't commit", "moving away", "too busy", "no thanks".
- "unclear": ANYTHING else — questions, off-topic chatter, just emojis, ambiguous phrasing, replies that don't address the survey question at all. When in doubt, return "unclear" — we'd rather ask the player to clarify than misclassify them.

Be CONSERVATIVE. If you're not 80%+ certain, return "unclear". Examples of things that should be "unclear":
- "what is this?"
- "who is this?"
- "🙂"
- "we'll see"  (too vague — could be in/maybe/out — ask)
- "ok"  (ambiguous; could mean "ok I'm in" or "ok received your message")
- "thanks for letting me know"
- jokes, banter, follow-up questions to the bot
- empty or near-empty replies

Output STRICT JSON only — no markdown, no fences:

{
  "category": "in" | "maybe" | "out" | "unclear",
  "confidence": <number 0..1>,
  "reasoning": "<short justification, max 100 chars>"
}`;

export interface RosterClassification {
  category: "in" | "maybe" | "out" | "unclear";
  confidence: number;
  reasoning: string;
}

export async function classifyRosterReply(
  replyBody: string,
  context?: { playerName?: string | null; clubName?: string },
): Promise<RosterClassification> {
  const fallback: RosterClassification = {
    category: "unclear",
    confidence: 0,
    reasoning: "classifier unavailable",
  };
  if (!process.env.ANTHROPIC_API_KEY) return fallback;
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const userText = [
      context?.clubName ? `Club: ${context.clubName}` : null,
      context?.playerName ? `Player: ${context.playerName}` : null,
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
    if (!textBlock) return fallback;
    return parse(textBlock.text);
  } catch (err) {
    console.error("[roster-classifier] Claude call failed:", err);
    return fallback;
  }
}

function parse(rawText: string): RosterClassification {
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return { category: "unclear", confidence: 0, reasoning: "parse failed" };
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return { category: "unclear", confidence: 0, reasoning: "parse failed" };
    }
  }
  if (!parsed || typeof parsed !== "object") {
    return { category: "unclear", confidence: 0, reasoning: "not an object" };
  }
  const obj = parsed as Record<string, unknown>;
  const VALID = new Set(["in", "maybe", "out", "unclear"]);
  const category = typeof obj.category === "string" && VALID.has(obj.category)
    ? (obj.category as RosterClassification["category"])
    : "unclear";
  const confidence =
    typeof obj.confidence === "number"
      ? Math.max(0, Math.min(1, obj.confidence))
      : 0;
  const reasoning = typeof obj.reasoning === "string" ? obj.reasoning.slice(0, 200) : "";
  // Confidence threshold: ANYTHING below 0.7 forces "unclear" so the
  // bot routes to clarification rather than saving a wobbly call.
  if (confidence < 0.7 && category !== "unclear") {
    return {
      category: "unclear",
      confidence,
      reasoning: `[low-confidence forced] ${reasoning}`,
    };
  }
  return { category, confidence, reasoning };
}
