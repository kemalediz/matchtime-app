/**
 * AN ORGANISER'S SHORT LIST OF NAMES WITH A BARE IN OR OUT, IN HQ
 * (FNF HQ, 2026-10-17 09:01 London). Pure.
 *
 * "Imti\nRafi\nAH\n\nIn", "Yaseen, Mo, Feroz and Ali out". In the admin
 * group this is structured data, like the pasted squad list
 * (`admin-group-paste.ts`): names and a direction, nothing else. Nothing
 * was written for it: the router (model) routed the first `none` (a model
 * miss: 19 of 20 dev-key reruns with the same context gave other_att), and
 * the HQ vetting held every claim, because a name alone on its line is no
 * command clause.
 *
 * HQ ONLY. The players' group and DMs never read this: there the router
 * understands the words (owner rule: no exact-phrase understanding of
 * meaning; structured data only, and only where it is structured data).
 * `admin-group-understand.ts` routes such a message from an organiser to
 * other_att without the router; `admin-group-squad-change.ts` hands the
 * engine these facts (no extractor) and the names to the vetting.
 *
 * Deliberately narrow. Two to eight names (one name is a sentence for the
 * router, as "Baki OUT" always was; a whole squad is a pasted list), each
 * one to three capitalised words of letters (or an @tag), never a word
 * that is not a name ("me", "all", "are", "the"), never the bot. Separated
 * by new lines, commas, "and", "&", "+" or "ve". The token (in, out, var,
 * yok) alone, first or last. A question mark, a word around the names, or
 * both ways in one message: null, the router's.
 */
import type { AttendanceFacts, Claim } from "./pipeline/types";
import { messageTagsBot } from "./interaction-contract";

export interface HqNameList {
  polarity: "in" | "out";
  names: string[];
}

const EMOJI_RUN =
  /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}‍️⃣\u{E0020}-\u{E007F}]+/gu;
const TOKEN = "in|out|var|yok";
const TAIL = new RegExp(`^([\\s\\S]*?)[\\s,:;.\\-–—]+(${TOKEN})[\\s!.]*$`, "iu");
const HEAD = new RegExp(`^(${TOKEN})[\\s,:;.\\-–—]+([\\s\\S]+)$`, "iu");
const SPLIT = /\n|,|\s+(?:and|ve|&|\+)\s+|\s*[&+]\s*/iu;
const BULLET = /^\s*(?:\d{1,2}[.)]|[-•*·])\s*/u;
const WORD = /^@?\p{L}[\p{L}'’.-]*$/u;
const MAX = 8;
const PARTICLE = new Set(["ul", "al", "el", "bin", "ibn", "de", "da", "van", "der", "von"]);
const TOKEN_WORD = /^(?:in|out|var|var[ıi]m|yok|yokum|gelemiyorum)$/iu;
/** Words that are never a player's name in a list. Folded. */
const NOT_A_NAME = new Set([
  "i", "im", "me", "myself", "we", "us", "you", "he", "she", "him", "her", "they", "them", "it",
  "all", "everyone", "everybody", "anyone", "someone", "nobody", "both", "rest", "others",
  "is", "are", "was", "were", "be", "am", "not", "also", "too", "the", "a", "an", "and", "or",
  "back", "still", "now", "then", "maybe", "this", "that", "week", "today", "tonight",
  "mt", "matchtime", "bot",
  "ben", "biz", "sen", "siz", "o", "onlar", "herkes", "hepsi", "belki",
]);

export function readHqNameList(body: string): HqNameList | null {
  const text = (typeof body === "string" ? body : "").replace(EMOJI_RUN, " ").trim();
  if (!text || text.includes("?")) return null;
  // A message tagging MatchTime is said to it in words: the router's.
  if (text.includes("@") && messageTagsBot({ body: text })) return null;
  const tail = TAIL.exec(text);
  const head = tail ? null : HEAD.exec(text);
  const [rest, token] = tail ? [tail[1], tail[2]] : head ? [head[2], head[1]] : [null, null];
  if (rest === null || token === null) return null;
  const polarity = /^(?:in|var)$/iu.test(token) ? "in" : "out";
  const names: string[] = [];
  for (const raw of rest.split(SPLIT)) {
    const item = raw.replace(BULLET, "").replace(/[\s.,;:]+$/u, "").trim();
    if (!item) continue;
    const words = item.split(/\s+/);
    if (words.length > 3) return null;
    for (const [i, w] of words.entries()) {
      const bare = w.replace(/^@/, "");
      if (!WORD.test(w) || TOKEN_WORD.test(bare)) return null;
      // Written as a name: capitalised ("Imti", "AH"), an @tag, or a
      // particle inside one ("Ehtisham ul Haq").
      if (!w.startsWith("@") && !/^\p{Lu}/u.test(bare) && !(i > 0 && PARTICLE.has(bare))) return null;
      if (NOT_A_NAME.has(bare.toLowerCase().replace(/['’.]/g, ""))) return null;
    }
    const name = words.join(" ").replace(/^@/, "");
    if (/^match\s*time$/iu.test(name)) return null;
    names.push(name);
  }
  return names.length >= 2 && names.length <= MAX ? { polarity, names } : null;
}

/** The facts the list states, as the attendance engine reads them: each
 *  name, present, a decision, named, not contingent, not relayed. */
export function hqNameListFacts(body: string): AttendanceFacts | null {
  const list = readHqNameList(body);
  if (!list) return null;
  const claim = (personRef: string): Claim => ({
    subject: "other",
    personRef,
    personNamed: true,
    polarity: list.polarity,
    contingent: false,
    conditionOn: "none",
    tense: "present",
    basis: "decision",
    reported: false,
    confidence: 1,
    replaces: "",
  });
  return { kind: "attendance", claims: list.names.map(claim), affirmation: null, sideRequests: [] };
}
