/**
 * Classify a player's WhatsApp DM reply to a roster check-in: one of
 * {in, maybe, out, unclear}. Anything the model is not sure of becomes
 * "unclear", and the route asks the player once more instead of saving a
 * dubious answer. One Haiku call per reply; the volume is one per player
 * per check-in.
 *
 * No database: the route (`api/whatsapp/dm-reply`) owns the write and the
 * reply, so the live dry run (`scripts/dryrun-roster-survey.ts`) can
 * import the exact production prompt.
 *
 * REWRITTEN WHOLE on 2026-10-19 (Haiku 5.5 trial): "Evet bu ay varım"
 * (yes, I'm in this month) and "yes I'm in this month" came back `maybe`.
 * The old prompt defined "in" as committing to play every week "going
 * forward", and told the model that any time word ("for now",
 * "currently") means `maybe`; that rule was written to keep a hedge away
 * from `out`, and it also pulled a yes for a stated stretch away from
 * `in`. The new prompt defines each answer once by what it does to the
 * player (stay on the roster, play only the weeks they say IN, step
 * back), and gives English and Turkish examples side by side, so the
 * Turkish language line the user turn used to carry is gone: one prompt
 * for every club. 2,610 characters before, 2,103 after (995 and 880
 * Haiku 5.5 tokens, over its 512-token cache floor).
 */
import Anthropic from "@anthropic-ai/sdk";
import { guardedAnthropicCall } from "@/lib/pipeline/llm";
import { HAIKU_MODEL, HAIKU_SHORT_ANSWER_MAX_TOKENS, HAIKU_THINKING } from "./models";

const MODEL = HAIKU_MODEL;

export const ROSTER_SURVEY_SYSTEM_PROMPT = `A player replied, in a private WhatsApp message, to a roster check-in from MatchTime, their football club's bot. The check-in asked whether they still want to play with the club in the coming weeks, and offered three answers: stay on the roster, play only in the weeks they say IN, or step back.

Which answer is the reply? Pick one:
- "in": they say yes, they want to stay on the roster. A yes for a stated stretch ("this month", "till Christmas") is still "in": it is a yes, and the club checks in again later.
- "maybe": they will play some weeks but not every week, it depends on something, or they are taking a break and may come back.
- "out": they clearly stop, with no way back mentioned. Taking a player off the roster is the harshest answer, so any hint of coming back ("for now", "later", "maybe") is "maybe", never "out".
- "unclear": a question, chat, an emoji, a bare "ok" or "tamam", or anything else that does not answer the check-in.

Examples (English | Turkish):
in: "yes" | "evet"; "I'm in" | "varım"; "of course, still keen" | "tabii ki, devam"; "100%" | "kesinlikle"; "always in mate" | "her zaman varım"; "yes, till Christmas" | "evet, yılbaşına kadar varım"
maybe: "depends" | "duruma göre"; "sometimes" | "ara sıra"; "if I'm free" | "boş olursam"; "when I can" | "fırsat buldukça"; "not every week" | "her hafta değil"; "maybe" | "belki"; "not for now, maybe later" | "şimdilik yok, belki sonra"; "taking a break for a bit" | "bir süre ara vereceğim"; "we'll see" | "sonra bakarız"
out: "I'm done, take me off" | "bırakıyorum, beni çıkarın"; "won't be playing anymore" | "artık oynamayacağım"; "stopping football completely" | "futbolu tamamen bıraktım"; "moving away" | "taşınıyorum"
unclear: "what is this?" | "bu ne?"; "who is this?" | "kimsin?"; "ok" | "tamam"; "thanks for letting me know" | "haber verdiğin için sağ ol"; "🙂"

If you are not at least 80% sure, choose "unclear": the player is simply asked again.

Output STRICT JSON only, no markdown, no fences:
{"category": "in" | "maybe" | "out" | "unclear", "confidence": <number 0..1>, "reasoning": "<max 100 chars>"}`;

export interface RosterClassification {
  category: "in" | "maybe" | "out" | "unclear";
  confidence: number;
  reasoning: string;
}

export interface RosterReplyContext {
  playerName?: string | null;
  clubName?: string;
}

/** The model, as one function, so a test can drive the real parse
 *  without a key and the live dry run can meter what it spends. */
export type RosterSurveyCall = (system: string, user: string) => Promise<string>;

export function buildRosterSurveyUserTurn(replyBody: string, context: RosterReplyContext = {}): string {
  return [
    context.clubName ? `Club: ${context.clubName}` : null,
    context.playerName ? `Player: ${context.playerName}` : null,
    `Reply: ${JSON.stringify(replyBody)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The real call. Null when there is no key, which is `unclear`. */
function liveCall(): RosterSurveyCall | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return async (system, user) => {
    const anthropic = new Anthropic({ apiKey: key });
    const response = await guardedAnthropicCall("roster-survey", () =>
      anthropic.messages.create({
        model: MODEL,
        max_tokens: HAIKU_SHORT_ANSWER_MAX_TOKENS,
        ...HAIKU_THINKING,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }],
        messages: [{ role: "user", content: user }],
      }),
    );
    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    return textBlock ? textBlock.text : "";
  };
}

/**
 * Classify one reply. EVERY failure is `unclear`, which saves nothing and
 * asks the player again. `call` is `undefined` for the real model and
 * `null` to assert there is none.
 */
export async function classifyRosterReply(
  replyBody: string,
  context: RosterReplyContext = {},
  call?: RosterSurveyCall | null,
): Promise<RosterClassification> {
  const fallback: RosterClassification = {
    category: "unclear",
    confidence: 0,
    reasoning: "classifier unavailable",
  };
  const fn = call === undefined ? liveCall() : call;
  if (!fn) return fallback;
  try {
    return parse(await fn(ROSTER_SURVEY_SYSTEM_PROMPT, buildRosterSurveyUserTurn(replyBody, context)));
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
