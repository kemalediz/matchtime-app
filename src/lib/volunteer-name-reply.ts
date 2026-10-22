/**
 * A NAMELESS VOLUNTEER'S REPLY TO "what name should I list you under?"
 * (2026-10-22).
 *
 * A partner club's player with no name on file says IN to another club's
 * ask by DM; MatchTime asks him for a name before writing his place
 * (partner-guest-dm.ts). His next DM used to be TAKEN as the name, so
 * "OUT", "actually can't make it", "yok gelemiyorum" or "which match?"
 * became his User.name and he was put IN. Now the model reads the reply
 * (house rule: never understand people by phrases or regex) and says one
 * of three things:
 *
 *   - "name":  he gives his name, alone or in a sentence, with or without
 *              "still in". The name is returned as he wrote it.
 *   - "out":   he withdraws.
 *   - "other": anything else (a question, a bare "IN", unreadable).
 *
 * The code keeps the deterministic guards on what may be SAVED: the name
 * must be in his message, must have a letter, must not be a phone number,
 * and is capped at 40 characters. Every failure (no key, a failed call,
 * an unparseable or unsure answer) is "other", which saves nothing,
 * records nothing and only asks the question again.
 *
 * One Haiku 5.5 call per reply, through the pipeline's model
 * (`HAIKU_CALL`, budget-guarded). No database here, so the live dry run
 * (scripts/dryrun-volunteer-name-reply.ts) imports the exact production
 * prompt without Prisma.
 */
import { dmClassifierStubCall } from "./dm-classifier-stub";
import { HAIKU_SHORT_ANSWER_MAX_TOKENS } from "./models";
import { anthropicModel, extractJson, HAIKU_CALL, type ModelCall, type PipelineModel } from "./pipeline/llm";
import { usableName } from "./player-display-name";

/** The model and thinking posture, pinned. Exported for the dry run. */
export const VOLUNTEER_NAME_REPLY_CALL: ModelCall = HAIKU_CALL;
/** Below this the model is not sure enough to save a name or drop an IN. */
export const VOLUNTEER_NAME_REPLY_MIN_CONFIDENCE = 0.8;
/** The longest name kept from his reply. */
const VOLUNTEER_NAME_MAX = 40;
const LABEL = "volunteer-name-reply";
const MESSAGE_HEADER = "HIS REPLY:";

export type VolunteerNameReply = { kind: "name"; name: string } | { kind: "out" } | { kind: "other"; why: string };

export interface VolunteerNameContext {
  /** The club whose game he offered to play in. */
  askerName: string;
  /** Its day and time, in his club's language. */
  day: string;
  /** The exact question MatchTime sent him. */
  question: string;
  /** For the verdict log only; never sent to the model. */
  userId?: string;
}

/** A name as saved: spaces collapsed, capped, never a number or letterless. (pure) */
export function volunteerNameFromReply(text: string): string | null {
  const v = usableName(text);
  return v ? v.slice(0, VOLUNTEER_NAME_MAX).trim() : null;
}

export function buildVolunteerNameSystemPrompt(): string {
  return `A football player offered to play in another club's game. MatchTime, the WhatsApp bot, has no name for him, so it asked him privately what name to list him under. You get that club, the game's day and time, the exact question MatchTime sent, and his reply under "${MESSAGE_HEADER}".

What does his reply say? Pick one:
- "name": he gives his name, on its own or in a sentence, with or without saying he is still in. Put the name in "name" exactly as he wrote it, without the words around it.
- "out": he no longer wants to play in that game: he withdraws, says he cannot come, or says no. This wins even when he also gives his name.
- "other": anything else: a question, a word that is not a name (such as "IN", "ok" or "yes"), a message about somebody else, or something you cannot read.

Examples (English | Turkish):
name: "Dave" | "Emre"; "it's Tom Hart" | "Adım Kerem Aydın"; "Sam here, still in" | "Burak, varım"
out: "out" | "yokum"; "can't make it after all" | "gelemiyorum artık"; "Sam, but I can't come now" | "Burak ama gelemem"
other: "who's this?" | "sen kimsin?"; "what time?" | "saat kaçta?"; "IN" | "varım"; "ok" | "tamam"

If you are not at least 80% sure, choose "other": a wrong "name" puts the wrong words on a squad list and a wrong "out" loses a player who wanted to play, while "other" only asks him again.

Output STRICT JSON only, no markdown, no fences:
{"reply": "name" | "out" | "other", "name": "<his name, or empty>", "confidence": <number 0..1>}`;
}

export function buildVolunteerNameUserTurn(text: string, ctx: VolunteerNameContext): string {
  return [
    `Club he offered to play for: ${ctx.askerName}`,
    `Its game: ${ctx.day}`,
    `MatchTime asked him: ${ctx.question}`,
    `${MESSAGE_HEADER}\n${text.trim()}`,
  ].join("\n");
}

const OTHER = (why: string): VolunteerNameReply => ({ kind: "other", why });

/** Case-folded, accents and spacing evened out, for the "is it in his message?" check. */
const fold = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("tr").replace(/ı/g, "i").replace(/\s+/g, " ").trim();

/** The JSON contract and the save guards. Exported for unit tests. (pure) */
export function parseVolunteerNameReply(raw: string, replyText: string): VolunteerNameReply {
  let obj: Record<string, unknown>;
  try {
    const parsed = extractJson(raw);
    if (!parsed || typeof parsed !== "object") return OTHER("not an object");
    obj = parsed as Record<string, unknown>;
  } catch {
    return OTHER("parse failed");
  }
  const confidence = typeof obj.confidence === "number" ? obj.confidence : 0;
  if (obj.reply !== "name" && obj.reply !== "out") return OTHER(obj.reply === "other" ? "other" : "no valid answer");
  if (confidence < VOLUNTEER_NAME_REPLY_MIN_CONFIDENCE) return OTHER("low confidence");
  if (obj.reply === "out") return { kind: "out" };
  const name = volunteerNameFromReply(typeof obj.name === "string" ? obj.name : "");
  if (!name) return OTHER("not a usable name");
  // The model may only pick the name out of his words, never supply one.
  if (!fold(replyText).includes(fold(name))) return OTHER("name not in his reply");
  return { kind: "name", name };
}

/**
 * TEST-ONLY seam, as the sibling DM classifiers have: the answer the model
 * would have given for a reply body, read from a file, so the e2e suite can
 * drive the real route for free. Labels: "name:<the name>", "out", or
 * anything else (no mapping) for "other". `e2e/helpers/live-llm.ts`
 * refuses a live run that can still see it.
 */
export const VOLUNTEER_NAME_STUB_FILE_ENV = "MT_TEST_VOLUNTEER_NAME_STUB_FILE";

function stubModel(env: NodeJS.ProcessEnv): PipelineModel | null {
  const call = dmClassifierStubCall(env[VOLUNTEER_NAME_STUB_FILE_ENV], {
    label: LABEL,
    header: MESSAGE_HEADER,
    answer: (label) =>
      label?.startsWith("name:")
        ? JSON.stringify({ reply: "name", name: label.slice(5), confidence: 1 })
        : JSON.stringify({ reply: label === "out" ? "out" : "other", name: "", confidence: 1 }),
  });
  if (!call) return null;
  return {
    name: "volunteer-name-stub",
    complete: async (req) => ({
      text: await call(req.system, req.user),
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0,
      ms: 0,
    }),
  };
}

function defaultModel(): PipelineModel | null {
  return stubModel(process.env) ?? (process.env.ANTHROPIC_API_KEY?.trim() ? anthropicModel() : null);
}

/**
 * Read his reply, once. `deps.model` undefined uses the real model (or the
 * e2e stub), null asserts there is none. Never throws.
 */
export async function readVolunteerNameReply(
  text: string,
  ctx: VolunteerNameContext,
  deps?: { model?: PipelineModel | null },
): Promise<VolunteerNameReply> {
  if (!text?.trim()) return OTHER("empty reply");
  const model = deps?.model === undefined ? defaultModel() : deps.model;
  if (!model) return OTHER("classifier unavailable");
  let verdict: VolunteerNameReply;
  try {
    const resp = await model.complete({
      ...VOLUNTEER_NAME_REPLY_CALL,
      system: buildVolunteerNameSystemPrompt(),
      user: buildVolunteerNameUserTurn(text, ctx),
      maxTokens: HAIKU_SHORT_ANSWER_MAX_TOKENS,
      // Short and asked rarely: a 1-hour cache write would cost more than it saves.
      cache: false,
      label: LABEL,
    });
    verdict = parseVolunteerNameReply(resp.text, text);
  } catch (err) {
    // FAIL SAFE: no name, nothing IN, the question asked again.
    console.error(`[${LABEL}] model call failed:`, err instanceof Error ? err.message : "failed");
    verdict = OTHER("classifier error");
  }
  console.info(`[${LABEL}] verdict user=${ctx.userId ?? "?"} reply=${verdict.kind}${verdict.kind === "other" ? ` why=${verdict.why}` : ""}`);
  return verdict;
}
