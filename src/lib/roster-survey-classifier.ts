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
import { guardedAnthropicCall, systemBlock } from "@/lib/pipeline/llm";
import { bodyUnderHeader, dmClassifierStubCall } from "./dm-classifier-stub";
import { dayCommaTimeLabel } from "./i18n/dates";
import { HAIKU_MODEL, HAIKU_SHORT_ANSWER_MAX_TOKENS, HAIKU_THINKING } from "./models";
import { noReplyContext, renderReplyContext, type ReplyContext } from "./reply-context";

const MODEL = HAIKU_MODEL;

/**
 * REWRITTEN WHOLE again on 2026-10-20 (quoted-reply context, slice S3).
 * The model was shown the club, the player and the reply, nothing else,
 * so a "yes" swipe-replied to a pay link or a rating request read as a
 * yes to the check-in. The user turn now carries when the check-in went
 * out and the shared chat-context block (`reply-context.ts`): the time
 * now, and the message they swipe-replied to, or else MatchTime's recent
 * messages to them. A reply answers the check-in when it is the message
 * they replied to, or the newest one, or their words plainly answer it.
 */
export const ROSTER_SURVEY_SYSTEM_PROMPT = `A player sent MatchTime, their football club's WhatsApp bot, the private message under "THE DM". Some time before, MatchTime had sent them a roster check-in: do they still want to play with the club in the coming weeks? It offered three answers: stay on the roster, play only in the weeks they say IN, or step back. Above the message you get when the check-in was sent, the time now, and what MatchTime said to them: the message they swipe-replied to, or else MatchTime's recent messages to them, each with when it was sent and what it was about.

Which answer to the check-in is the message? Pick one:
- "in": yes, they want to stay on the roster. A yes for a stated stretch ("this month", "till Christmas") is still "in": it is a yes, and the club checks in again later.
- "maybe": they will play some weeks but not every week, it depends on something, or they are taking a break and may come back.
- "out": they clearly stop, with no way back mentioned. Taking a player off the roster is the harshest answer, so any hint of coming back ("for now", "later", "maybe") is "maybe", never "out".
- "unclear": anything that does not answer the check-in. A question, chat, an emoji, a bare "ok" or "tamam", or an answer to a different message.

Whether it answers the check-in: a message they swipe-replied to the check-in answers it. A message they swipe-replied to any other message (a pay link, a rating request, a match invite) answers that one, so a bare "yes" or "no" there is "unclear". With no swipe-reply, a bare "yes" or "no" answers the newest of MatchTime's recent messages, so it is "unclear" when the newest is about something else. Words that plainly answer the check-in ("still keen", "count me in going forward", "I'm done, take me off") answer it whatever came after.

Examples (English | Turkish):
in: "yes" | "evet"; "I'm in" | "varım"; "of course, still keen" | "tabii ki, devam"; "100%" | "kesinlikle"; "always in mate" | "her zaman varım"; "yes, till Christmas" | "evet, yılbaşına kadar varım"
maybe: "depends" | "duruma göre"; "sometimes" | "ara sıra"; "if I'm free" | "boş olursam"; "when I can" | "fırsat buldukça"; "not every week" | "her hafta değil"; "maybe" | "belki"; "not for now, maybe later" | "şimdilik yok, belki sonra"; "taking a break for a bit" | "bir süre ara vereceğim"; "we'll see" | "sonra bakarız"
out: "I'm done, take me off" | "bırakıyorum, beni çıkarın"; "won't be playing anymore" | "artık oynamayacağım"; "stopping football completely" | "futbolu tamamen bıraktım"; "moving away" | "taşınıyorum"
unclear: "what is this?" | "bu ne?"; "who is this?" | "kimsin?"; "ok" | "tamam"; "thanks for letting me know" | "haber verdiğin için sağ ol"; "🙂"; "yes" | "evet" swipe-replied to a pay link

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
  /** When the check-in DM went out (`RosterSurveyDM.sentAt`), or null. */
  checkInSentAt?: Date | null;
  /** The chat context (`loadDmReplyContext`): the time now, and the
   *  message they swipe-replied to or MatchTime's recent DMs to them.
   *  Absent: the time now, nothing known. */
  replyContext?: ReplyContext | null;
}

/** The model, as one function, so a test can drive the real parse
 *  without a key and the live dry run can meter what it spends. */
export type RosterSurveyCall = (system: string, user: string) => Promise<string>;

/** What separates the context lines from the message itself. */
const MESSAGE_HEADER = "THE DM:";

/** Everything after the header, trimmed, so a multi-line reply is read whole. */
export function rosterSurveyBodyOf(user: string): string {
  return bodyUnderHeader(user, MESSAGE_HEADER);
}

export function buildRosterSurveyUserTurn(replyBody: string, context: RosterReplyContext = {}): string {
  return [
    context.clubName ? `Club: ${context.clubName}` : null,
    context.playerName ? `Player: ${context.playerName}` : null,
    `The check-in was sent: ${context.checkInSentAt ? dayCommaTimeLabel("en", context.checkInSentAt) : "(not known)"}`,
    renderReplyContext(context.replyContext ?? noReplyContext()),
    `${MESSAGE_HEADER}\n${replyBody.trim()}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * TEST-ONLY seam (quoted-reply context S3), the same one the other DM
 * classifiers use (`dm-classifier-stub.ts`): the category the model would
 * have returned for a DM body, so a route-level spec can drive the check-in
 * path for free and read what the model would have been told
 * (`<file>.calls`). `e2e/helpers/live-llm.ts` refuses a "live" run that can
 * still see it.
 */
export const ROSTER_SURVEY_STUB_FILE_ENV = "MT_TEST_ROSTER_SURVEY_STUB_FILE";

function stubCall(env: NodeJS.ProcessEnv): RosterSurveyCall | null {
  return dmClassifierStubCall(env[ROSTER_SURVEY_STUB_FILE_ENV], {
    label: "roster-survey",
    header: MESSAGE_HEADER,
    answer: (category) => JSON.stringify({ category: category ?? "unclear", confidence: 1, reasoning: "roster-survey stub" }),
  });
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
        system: systemBlock(system),
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
  const fn = call === undefined ? (stubCall(process.env) ?? liveCall()) : call;
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
