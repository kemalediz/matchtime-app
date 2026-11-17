/**
 * THE GUEST READER (2026-11-17): one small closed-answer model read. An
 * organiser shared a guest's contact card, or wrote a name and a number;
 * does his message ask MatchTime to put that person into a game, and which
 * game, and did he write a name or a number? One plain task, each output
 * defined once, grouped English and Turkish examples, and the CONTEXT (the
 * club's coming games, the cards he shared, by name only) doing the work.
 *
 * It decides nothing. `rules.ts` gates who is read at all (an organiser,
 * with a card or a number), checks the number it returns is written in his
 * message (`phoneWrittenIn`), and `add.ts` does the add under the club's
 * own rules. Every failure (no key, a failed call, an answer off the
 * contract) is "no add", which changes nothing.
 *
 * WHAT THE MODEL SEES: the time, the club's coming games, the card's
 * display name (never its number), his name and his words. Nothing else.
 *
 * One Haiku 5.5 call per read (`HAIKU_CALL`, structured output), spent from
 * the club's daily AI cap by the caller. In the e2e suite it is the
 * extractor stub, kind "guest_card" (`MT_TEST_EXTRACTOR_STUB_FILE`).
 */
import { formatLondon } from "../london-time";
import { extractorStubFromEnv } from "../pipeline/extractor-stub";
import { anthropicModel, extractJson, HAIKU_CALL, type ModelCall, type PipelineModel } from "../pipeline/llm";

export const GUEST_ADD_CALL: ModelCall = HAIKU_CALL;
/** The extractor stub reads the kind off this label. */
export const GUEST_ADD_LABEL = "extractor:guest_card";
/** Thinking shares the budget; the answer itself is a line. */
const MAX_TOKENS = 1_024;
/** Below this the add is not made. */
export const GUEST_ADD_FLOOR = 0.7;

export const GUEST_ADD_SYSTEM_PROMPT = `An organiser of a football club sent the message under "THE MESSAGE" to MatchTime, the club's WhatsApp assistant. Say whether it asks MatchTime to put a new player into one of the club's games, and which game.

Above the message you get the time now, the club's coming games (numbered), the WhatsApp contact cards the organiser has just shared (by name), and whether his message replies to one. A card is the person he means when he writes "him", "her", "this guy", "these two" or no name at all.

Answer with these fields:
- "add": true when the message asks MatchTime to put the person into a game: someone on a card he shared, or someone the message names together with a phone number. A plain "he's in", "he's coming" or "add him" beside a card counts. False for everything else: a question, chat, a player dropping out, a card with nothing said about playing, "maybe" or "might", and a person who is neither on a card nor given with a number.
- "game": the number of the game in the list that the message means ("tonight", "Friday", "next week", "salı"). 0 when it names none.
- "name": the player's name exactly as the message writes it, or "" when it writes none ("add him").
- "phone": the phone number exactly as the message writes it, or "" when it writes none.
- "confidence": how sure you are about "add", from 0 to 1. Below 0.7 nobody is added; a wrong add puts a stranger into the club's game.

Examples (English | Turkish).
With a card shared:
- add, no game named: "add him" | "bunu ekle"; "he's in" | "o da geliyor"
- add, a game named: "add him for tonight" | "bu akşama ekle"; "he's playing Friday" | "cuma oynuyor"
- not an add: "who's this?" | "bu kim?"; "might bring him next week" | "belki haftaya getiririm"; "he can't make it" | "gelemiyor"
With no card:
- add: "Abu Ayoub 07700 900123 is playing tonight" (name "Abu Ayoub", phone "07700 900123") | "Sami 07700 900456 cuma oynuyor" (name "Sami", phone "07700 900456")
- not an add: "Abu's number is 07700 900123" | "Abu'nun numarası 07700 900123"

Answer with the JSON object only: {"add": true or false, "game": a number, "name": "", "phone": "", "confidence": a number from 0 to 1}.`;

export const GUEST_ADD_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    add: { type: "boolean" },
    game: { type: "integer" },
    name: { type: "string" },
    phone: { type: "string" },
    confidence: { type: "number" },
  },
  required: ["add", "game", "name", "phone", "confidence"],
  additionalProperties: false,
};

export interface GuestAddContext {
  now: Date;
  /** The club's coming games, soonest first (several clubs in a DM). */
  games: Array<{ club: string; kickoff: Date }>;
  /** The cards he just shared, by their cleaned display name. */
  cards: Array<{ name: string | null }>;
  /** His message is a WhatsApp reply to a card. */
  quotedCard: boolean;
  senderName: string | null;
}

export interface GuestAddReading {
  add: boolean;
  /** 1-based number in `games`; 0 for none named. */
  game: number;
  name: string | null;
  phone: string | null;
  confidence: number;
}

const NO_ADD: GuestAddReading = { add: false, game: 0, name: null, phone: null, confidence: 0 };

const when = (d: Date) => formatLondon(d, "EEE d MMM, HH:mm");

export function buildGuestAddUserTurn(text: string, ctx: GuestAddContext): string {
  const today = formatLondon(ctx.now, "yyyy-MM-dd");
  const games = ctx.games.length
    ? ctx.games.map((g, i) => `${i + 1}. ${g.club}, ${when(g.kickoff)}${formatLondon(g.kickoff, "yyyy-MM-dd") === today ? " (today)" : ""}`).join("\n")
    : "(none)";
  const cards = ctx.cards.length ? ctx.cards.map((c, i) => `${i + 1}. ${c.name ?? "(no name on the card)"}`).join(", ") : "none";
  return [
    `Time now: ${when(ctx.now)} (London)`,
    `The club's coming games:\n${games}`,
    `Contact cards he just shared: ${cards}`,
    `He replied to: ${ctx.quotedCard ? "a contact card he shared" : "nothing (a plain message)"}`,
    `THE MESSAGE (from ${ctx.senderName?.trim() || "the organiser"}):\n${text.trim()}`,
  ].join("\n\n");
}

/** The JSON contract. Anything off it is no add. (pure) */
export function parseGuestAdd(raw: string): GuestAddReading {
  let obj: Record<string, unknown>;
  try {
    const parsed = extractJson(raw);
    if (!parsed || typeof parsed !== "object") return NO_ADD;
    obj = parsed as Record<string, unknown>;
  } catch {
    return NO_ADD;
  }
  if (typeof obj.add !== "boolean") return NO_ADD;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    add: obj.add,
    game: typeof obj.game === "number" && Number.isInteger(obj.game) ? obj.game : 0,
    name: str(obj.name),
    phone: str(obj.phone),
    confidence: typeof obj.confidence === "number" && Number.isFinite(obj.confidence) ? Math.max(0, Math.min(1, obj.confidence)) : 0,
  };
}

function defaultModel(): PipelineModel | null {
  return extractorStubFromEnv() ?? (process.env.ANTHROPIC_API_KEY?.trim() ? anthropicModel() : null);
}

/** Read his message, once. `deps.model` undefined: the real model (or the
 *  e2e stub); null: none. Never throws. */
export async function readGuestAdd(text: string, ctx: GuestAddContext, deps?: { model?: PipelineModel | null }): Promise<GuestAddReading> {
  if (!text?.trim()) return NO_ADD;
  const model = deps?.model === undefined ? defaultModel() : deps.model;
  if (!model) return NO_ADD;
  try {
    const resp = await model.complete({
      ...GUEST_ADD_CALL,
      system: GUEST_ADD_SYSTEM_PROMPT,
      user: buildGuestAddUserTurn(text, ctx),
      maxTokens: MAX_TOKENS,
      schema: GUEST_ADD_SCHEMA,
      label: GUEST_ADD_LABEL,
    });
    return parseGuestAdd(resp.text);
  } catch (err) {
    console.error("[guest-card] reader call failed:", err instanceof Error ? err.message : "failed");
    return NO_ADD;
  }
}
