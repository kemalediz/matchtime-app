/**
 * ⚠️ TO BE DELETED AT MERGE. THE OLD BARE IN/OUT FLOOR, KEPT ONLY FOR
 * `floorAttendanceFacts`'s LAST IMPORTER (2026-10-30, "no string parsing").
 *
 * The router floor is gone: the router and the attendance extractor read
 * every message, and at the club's daily AI cap an attendance read still
 * happens up to twice the cap (`withAttendanceOverflow`). Nothing in the
 * players' group pipeline imports this file. `admin-group-squad-change.ts`
 * (package P3, the HQ group) still reads `floorAttendanceFacts` for its
 * `bareDeclaration` hold and is removing that import in parallel; when it
 * has, this file goes, and `src/lib/pipeline/__tests__/no-parsing-p1.source.test.ts`
 * says so. It is re-exported from `router.ts` only so that importer keeps
 * compiling until then.
 */
import type { AttendanceFacts, Claim, Route } from "./types";

/** P3's `admin-group-name-list.test.ts` only. Deleted with this file. */
export function routeFloor(body: string): Route | null {
  return parseFloor(body)?.route ?? null;
}

/**
 * THE DETERMINISTIC FLOOR. Twenty lines, anchored at both ends, and it
 * only ever claims a message that is ENTIRELY a bare self-attendance
 * token. "Zeeshan is out 😂" and "I was in last week" must not match, so
 * everything except the token, optional punctuation and an emoji is a
 * disqualifier.
 */
const FLOOR_IN = /^(?:i\s*'?a?m|i\s+am|im)?\s*(?:in|innn+)\b/i;
const FLOOR_OUT = /^(?:i\s*'?a?m|i\s+am|im)?\s*(?:out|can'?t\s+make\s+it)\b/i;
/**
 * THE SAME FLOOR IN TURKISH (2026-09-16, Erdal's group). "var" / "varım"
 * / "ben varım" is a bare "in"; "yok" / "yokum" / "ben yokum" /
 * "gelemiyorum" is a bare "out". `MDs/second-group-readiness-erdal-
 * 2026-09-16.md` §2 measured the router losing all three bare forms
 * 30 of 30 — silently, `none`, no write, no react — which is the exact
 * failure this floor exists for. Vocabulary only: the flag, the tail
 * rule and the one-way property are untouched.
 *
 * NOT `\b`: JavaScript's `\b` is ASCII-only, so `var\b` matches INSIDE
 * "varım" (ı is not a `\w`), and the loop below would then reject the
 * tail "ım" and call "varım" a sentence. The end of a Turkish token is
 * "not followed by a letter" instead. `[ıi]` because the dotless ı is
 * typed as a plain i from an English keyboard, and `/i` folds I to i.
 */
const FLOOR_IN_TR = /^(?:ben\s+)?(?:var[ıi]m|var)(?!\p{L})/iu;
const FLOOR_OUT_TR = /^(?:ben\s+)?(?:yokum|yok|gelemiyorum)(?!\p{L})/iu;
/**
 * ⚠️ "+1" IS NOT IN THE FLOOR, deliberately.
 *
 * The first cut force-routed it `self_att`, which is the wrong subject:
 * "+1" offers a GUEST, not the sender. The self extractor would then
 * produce a sender claim, the guest would be lost, and PR #29's
 * name-ask — the whole point of which is that an unnamed guest gets a
 * question rather than a ghost user — would be bypassed on the single
 * most common way to offer one. `guest-name-ask.ts` already classifies
 * `+N` as a placeholder guest, so the rest of the codebase agrees.
 * The router decides this one.
 */
/**
 * ONE CHARACTER OF AN EMOJI SEQUENCE (2026-09-24). The pictograph itself
 * plus everything a sequence is built from: skin tones, regional
 * indicators (flags), U+200D (the ZWJ in "🤷‍♂️", a format character),
 * U+FE0F (the variation selector in "✌️", a nonspacing mark, so `\p{S}`
 * alone missed both), the keycap U+20E3 and the tag characters of the
 * subdivision flags ("🏴󠁧󠁢󠁥󠁮󠁧󠁿"). NOT `\p{Emoji_Component}`: that property
 * includes the digits 0-9, and "in 20" is a sentence.
 */
const EMOJI_CHAR =
  "\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\p{Regional_Indicator}\\u200D\\uFE0F\\u20E3\\u{E0020}-\\u{E007F}";
const EMOJI_RUN = new RegExp(`[${EMOJI_CHAR}]+`, "gu");

/** Anything left after the token that is not punctuation or an emoji
 *  means this is a sentence, not a bare declaration. */
const FLOOR_TAIL = new RegExp(`^[\\s\\p{P}\\p{S}${EMOJI_CHAR}]*$`, "u");

/**
 * The MENTION half of the floor: `@Someone in`, `@Zair Malik out`.
 *
 * Same shape as the bare self-attendance floor — a subject and a token,
 * nothing else — one route along. It exists because the live corpus
 * caught `@Ehtisham Ul Haq In` routed `none`, which is §11.1's failure
 * exactly: a real third-party registration gone with no write, no reply
 * and no signal.
 *
 * A mention of the BOT is never a player. Without that check
 * "@Match Time in" would try to register a member called "Match Time",
 * which is the ghost-user class of bug one layer up.
 */
const MENTION_TOKEN = new RegExp(`^@[\\p{L}\\d._'${EMOJI_CHAR}-]+`, "u");
/** A capitalised word after a mention is part of the mentioned display
 *  name ("@Ehtisham Ul Haq") — the Pi expands a mention to the display
 *  name. A lower-case word is the sentence starting, and ends the
 *  subject. An emoji is part of a name too, attached ("Jesse👑") or as a
 *  word of its own ("@Jesse 👑 IN"): it is never the sentence starting. */
const NAME_WORD = new RegExp(
  `^[${EMOJI_CHAR}]*(?:\\p{Lu}[\\p{L}'-]*)?[${EMOJI_CHAR}]*$`,
  "u",
);


/**
 * What the floor read: the route, which way, and (for a mention) whose
 * names. One parser behind both `routeFloor` and `floorAttendanceFacts`,
 * so the two can never disagree about which messages are bare.
 */
interface FloorReading {
  route: "self_att" | "other_att";
  polarity: "in" | "out";
  /** The mentioned display names, verbatim, for `other_att`. */
  names: string[];
}

function parseFloor(body: string): FloorReading | null {
  const t = (body ?? "").trim();
  if (!t) return null;

  if (t.startsWith("@")) {
    // Never the bot. The old text test, frozen here so the last importer's behaviour does
    // not change before this file is deleted.
    if (/@?\s*match\s*time\b|\bmatchtime\b|@mt\b/i.test(t)) return null;
    let rest = t;
    const names: string[] = [];
    for (;;) {
      const m = MENTION_TOKEN.exec(rest);
      if (!m) break;
      const words = [m[0].slice(1)];
      rest = rest.slice(m[0].length).trimStart();
      // Consume the rest of the mentioned display name.
      for (;;) {
        const word = rest.split(/\s+/)[0] ?? "";
        if (!word || !NAME_WORD.test(word) || isFloorToken(word)) break;
        words.push(word);
        rest = rest.slice(word.length).trimStart();
      }
      names.push(words.join(" "));
    }
    if (names.length === 0) return null;
    const polarity = bareDeclaration(rest);
    return polarity ? { route: "other_att", polarity, names } : null;
  }

  const polarity = bareDeclaration(t);
  return polarity ? { route: "self_att", polarity, names: [] } : null;
}

/**
 * THE FACTS A BARE DECLARATION STATES, READ WITHOUT A MODEL (2026-09-29).
 *
 * For the daily AI cap. Below the cap the floor only ROUTES a message and
 * the attendance extractor still reads it; at the cap there is no
 * extractor, and a bare "in" must still put the player in the squad. So
 * the floor states what it already proved about the text, as `Facts`,
 * and the engine decides exactly as it would on the extractor's answer.
 *
 * It claims no more than the floor does: ONLY a message that is entirely
 * a bare IN/OUT token (with optional mentions, punctuation and emoji).
 * "in if we get 10", "who's in?" and "in, bringing my brother" are null,
 * and at the cap they are simply not handled rather than guessed at.
 * Every field is what the words say: present tense, not contingent, a
 * decision, not reported, and a mention is a named person.
 */
export function floorAttendanceFacts(body: string): AttendanceFacts | null {
  const f = parseFloor(body);
  if (!f) return null;
  const claim = (subject: "sender" | "other", personRef: string): Claim => ({
    subject,
    personRef,
    personNamed: subject === "other",
    polarity: f.polarity,
    contingent: false,
    conditionOn: "none",
    tense: "present",
    reported: false,
    confidence: 1,
    replaces: "",
  });
  return {
    kind: "attendance",
    claims: f.route === "self_att" ? [claim("sender", "")] : f.names.map((n) => claim("other", n)),
    affirmation: null,
    sideRequests: [],
  };
}

/** Is this single word one of the bare tokens the floor recognises? */
function isFloorToken(word: string): boolean {
  return /^(?:in|out|var|var[ıi]m|yok|yokum|gelemiyorum)$/iu.test(word.replace(/[^\p{L}]/gu, ""));
}

/** Is the whole of `t` a bare IN/OUT declaration and nothing else? Which
 *  way, or null. The length cap bounds the WORDS, so a run of emoji after
 *  "IN" never pushes a bare declaration over it. */
function bareDeclaration(t: string): "in" | "out" | null {
  if (!t || t.replace(EMOJI_RUN, "").length > 24) return null;
  for (const [re, polarity] of [
    [FLOOR_IN, "in"],
    [FLOOR_OUT, "out"],
    [FLOOR_IN_TR, "in"],
    [FLOOR_OUT_TR, "out"],
  ] as const) {
    const m = re.exec(t);
    if (!m) continue;
    return FLOOR_TAIL.test(t.slice(m[0].length)) ? polarity : null;
  }
  return null;
}
