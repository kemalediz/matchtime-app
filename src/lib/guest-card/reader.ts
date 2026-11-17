/**
 * THE GUEST READER (2026-11-17; REWRITTEN WHOLE after the review of #621):
 * one small closed-answer model read. An organiser shared a guest's contact
 * card, or wrote names and numbers; does his message ask MatchTime to put
 * someone into a game, is it the card's person or someone he typed with a
 * number, which game (or a day that is not on the list), and does the
 * message ask for anything else too? One plain task, each output
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

export const GUEST_ADD_SYSTEM_PROMPT = `An organiser of a football club sent the message under "THE MESSAGE" to MatchTime, the club's WhatsApp assistant. Say whether it asks MatchTime to put a new player into one of the club's games: who, and which game.

Above the message you get the time now, the club's coming games (numbered; in a private message they can be several clubs' games), the WhatsApp contact cards the organiser has just shared (by name), and whether his message replies to one. A card is the person he means when he writes "him", "her", "this guy", "these two" or no name at all.

Answer with these fields:
- "add": true when the message asks MatchTime to put someone into a game: the person on a card he shared, or someone the message names together with a phone number. A plain "he's in", "he's coming" or "add him" beside a card counts. False for everything else: a question, chat, a player dropping out, a card with nothing said about playing, "maybe" or "might", and a person who is neither on a card nor given with a number.
- "card": true when the person to add is the one on the cards (several cards: all of them). False when the message is about someone else.
- "name": a name the message gives the card's person ("add him, he's Sam Jones"), exactly as written; "" when it gives none.
- "typed": every person the message names WITH a phone number, each {"name", "phone"} exactly as written. Empty when there is none.
- "game": the number of the game in the list that the message means ("tonight", "Friday", "next week", "salı", a club's name). 0 when it names none.
- "game_not_listed": true when the message names a day or game that is not in the list; then "game" is 0.
- "also": true when the message also asks MatchTime for something else besides the add: the sender's own IN or OUT, another player in or out, the teams, a question. False when the add is the whole message.
- "confidence": how sure you are about "add", from 0 to 1. Below 0.7 nobody is added; a wrong add puts a stranger into the club's game.

Examples (English | Turkish).
With a card shared:
- add, the card's person: "add him for tonight" | "bu akşama ekle"; "he's in" | "o da geliyor"; "he's playing Friday" | "cuma oynuyor"; "add him, his name is Sam Jones" (name "Sam Jones") | "ekle, adı Sam Jones" (name "Sam Jones")
- add, someone else: "Sami 07700 900456 is playing tonight" (card false, typed Sami) | "Sami 07700 900456 bu akşam oynuyor"
- add, and something else too ("also" true): "I'm in, and add him for tonight" | "ben varım, onu da ekle"
- a day not in the list ("game_not_listed" true): "add him for Thursday" when no game is on a Thursday | "perşembeye ekle"
- not an add: "who's this?" | "bu kim?"; "might bring him next week" | "belki haftaya getiririm"; "he can't make it" | "gelemiyor"
With no card:
- add: "Abu Ayoub 07700 900123 is playing tonight" (typed Abu Ayoub) | "Sami 0532 123 45 67 cuma oynuyor" (typed Sami); "Abu 07700 900123 and Can 07700 900124 are in" (typed both)
- not an add: "Abu's number is 07700 900123" | "Abu'nun numarası 07700 900123"

Answer with the JSON object only: {"add": true or false, "card": true or false, "name": "", "typed": [{"name": "", "phone": ""}], "game": a number, "game_not_listed": true or false, "also": true or false, "confidence": a number from 0 to 1}.`;

export const GUEST_ADD_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    add: { type: "boolean" },
    card: { type: "boolean" },
    name: { type: "string" },
    typed: {
      type: "array",
      items: { type: "object", properties: { name: { type: "string" }, phone: { type: "string" } }, required: ["name", "phone"], additionalProperties: false },
    },
    game: { type: "integer" },
    game_not_listed: { type: "boolean" },
    also: { type: "boolean" },
    confidence: { type: "number" },
  },
  required: ["add", "card", "name", "typed", "game", "game_not_listed", "also", "confidence"],
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
  /** The person to add is the one on the shared cards. */
  card: boolean;
  /** A name the message gives the card's person, or null. */
  name: string | null;
  /** People named with a phone number, as written (each has both). */
  typed: Array<{ name: string; phone: string }>;
  /** 1-based number in `games`; 0 for none named. */
  game: number;
  /** The message names a day or game that is not in the list. */
  gameNotListed: boolean;
  /** The message also asks for something else besides the add. */
  also: boolean;
  confidence: number;
}

const NO_ADD: GuestAddReading = { add: false, card: false, name: null, typed: [], game: 0, gameNotListed: false, also: false, confidence: 0 };

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
  const typed = Array.isArray(obj.typed)
    ? obj.typed
        .map((t) => ({ name: str((t as Record<string, unknown> | null)?.name), phone: str((t as Record<string, unknown> | null)?.phone) }))
        .filter((t): t is { name: string; phone: string } => !!t.name && !!t.phone)
    : [];
  return {
    add: obj.add,
    card: obj.card === true,
    name: str(obj.name),
    typed,
    game: typeof obj.game === "number" && Number.isInteger(obj.game) ? obj.game : 0,
    gameNotListed: obj.game_not_listed === true,
    also: obj.also === true,
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
