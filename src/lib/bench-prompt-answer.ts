/**
 * Reading a bench PROMPT's answer out of a group message — no model.
 *
 * ── Why this exists ───────────────────────────────────────────────────
 * A bench player gets DM'd "a slot opened, do you want it?" — a
 * `PendingBenchConfirmation` row. Plenty of them answer in the GROUP
 * instead of the DM, with one word. Until now the only thing that could
 * see that was the 19,850-token analyzer prompt, which set
 * `verdict.benchConfirmation = "yes" | "no"`; `executeVerdict` then
 * called `resolveBenchConfirmation` (lib/bench-confirmation.ts) and
 * reacted ✅ / 👋.
 *
 * §10 step 8 of MDs/analyzer-redesign-2026-08-31.md deletes that prompt.
 * `lib/attendance-engine-batch.ts` (~line 264) deliberately declines to
 * own this shape — a `PendingBenchConfirmation` is a different table and
 * a different flow from the `BenchSlotOffer` the engine models — so with
 * the prompt gone, a bench player answering in the group would be
 * silently ignored. Sutton FC runs `featureReminders`/bench live, so
 * that is a real regression, not a hypothetical one.
 *
 * It never needed a model. `/api/whatsapp/dm-reply` has recognised the
 * same answers with a regex since the bench redesign shipped
 * (2026-05-19, route.ts:142-146) — the DM half of the identical
 * question. This is the group half, written to the same standard as
 * `lib/dm-self-attendance.ts`: anchored on the WHOLE message, never a
 * substring.
 *
 * ── The prior this is allowed to lean on ──────────────────────────────
 * This function is ONLY consulted when the DB says THIS EXACT SENDER has
 * an unanswered prompt open for THIS match. That is an enormous prior:
 * a one-word message from that person, in that window, is an answer.
 * It is what lets "y", "ok" and "👍" be read here when
 * `classifyDmSelfAttendance` deliberately refuses them (it has no
 * pending prompt to anchor them to).
 *
 * It is NOT a licence to guess. Anything carrying a second clause, a
 * condition or a question mark returns `null` and falls through, because
 * a wrong "yes" promotes someone into a slot they did not ask for and
 * pushes a player who did onto the bench.
 *
 * ── Interaction contract: this path is TAG-FREE ───────────────────────
 * `lib/interaction-contract.ts` requires an `@Match Time` tag for
 * anything MT could DO or ANSWER *except* a player's own clear
 * self-attendance (`isSelfAttendanceVerdict` / `actionRequiresTag`).
 * Answering "do you want the slot?" is the purest self-attendance there
 * is: MatchTime asked THIS player a direct question about THEIR OWN
 * slot, the player is replying to it, and nobody else's row is touched.
 * Requiring a tag would mean ignoring a direct answer to our own
 * question. The tag is therefore not required — but a leading
 * "@Match Time" is stripped so that tagging anyway still works.
 *
 * ── What is LOST versus the shipped mega-prompt ───────────────────────
 * The prompt could read an answer out of a sentence ("yeah go on then
 * I'll leave work early") or out of a reply-quote of the prompt text.
 * This module returns `null` for anything it does not recognise whole.
 * That is the conservative direction and it is recoverable: the DM path
 * still works, a 👍 REACTION on the group offer post still works
 * (/api/whatsapp/reaction), and the player can send a second, shorter
 * message. §13's rule holds — a missed claim is recoverable in one
 * message; a wrong promotion on a paid match is not.
 *
 * ── A caller-side hazard worth naming ─────────────────────────────────
 * "out" and "i'm out" are read as "no". For a player with a prompt open
 * that is nearly always "no thanks, leave me on the bench" — and a "no"
 * is a pure NO-OP in `resolveBenchConfirmation` (`kind: "declined"`,
 * nobody is ever removed for declining). But a player who means "drop me
 * from the match entirely" writes the same word. The caller must not let
 * a "no" here SUPPRESS an explicit OUT registration: decline is
 * cosmetic, a drop is not. Both error directions on the "no" side cost
 * at most a stray 👋 react; the "yes" side is where the strictness is
 * spent.
 */

export type BenchPromptAnswer = "yes" | "no" | null;

/** Longest body we will even look at. A real answer is one to four
 *  words; anything longer is conversation. */
const MAX_LEN = 42;
/** …and a hard word cap on top, so a long message cannot be assembled
 *  out of filler tokens. */
const MAX_WORDS = 6;

/** Emoji that mean yes / no on their own. Same set the reaction handler
 *  and the bench DM path accept. */
const YES_EMOJI = /[\u{1F44D}\u{2705}\u{2714}\u{1F64B}]/gu;
const NO_EMOJI = /[\u{1F44E}\u{274C}\u{1F645}\u{1F6AB}]/gu;

/**
 * Lowercase, strip accents, drop apostrophes ("i'm" → "im", "can't" →
 * "cant"), drop emoji and stray punctuation, collapse whitespace, then
 * drop a leading bot tag. Mirrors `normalise` in lib/dm-self-attendance.
 *
 * Keeps every LETTER and DIGIT (`\p{L}\p{N}`), not only `[a-z0-9]`
 * (fixed 2026-09-16). The NFD fold above only removes the diacritics
 * that decompose; the dotless ı, and any letter with no decomposition,
 * used to be deleted outright, so "hayır" reached the word lists as
 * "hay r" and a Turkish player's name was mangled. ASCII input is
 * normalised byte for byte as before (pinned in
 * `__tests__/unicode-names.test.ts`). The word lists themselves are
 * still English; Phase 3b of the multi-language design adds Turkish.
 *
 * Exported as `normaliseBenchAnswerText` for that test only.
 */
function normalise(text: string): string {
  return (text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[‘’'`´]/g, "")
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/[‍️⃣⁠​]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    // A leading "@Match Time" / "@MatchTime" / "@MT" is allowed but not
    // required; the tag is not part of the answer.
    .replace(/^(?:match\s*time|matchtime|mt)\s+/, "")
    .trim();
}

/** Test-only surface for the normaliser above. */
export const normaliseBenchAnswerText = normalise;

/** Courtesy / address words that may appear on EITHER side of the answer
 *  without changing it. Deliberately a closed list of words that carry no
 *  attendance meaning of their own — a filler-only message has no core
 *  and is rejected. */
const FILLER = [
  "mate",
  "m8",
  "bro",
  "bruv",
  "pal",
  "lad",
  "lads",
  "boys",
  "guys",
  "cheers",
  "thanks",
  "thank",
  "thanx",
  "thx",
  "you",
  "ta",
  "pls",
  "plz",
  "ah",
  "oh",
  "hi",
  "hey",
  "hello",
  "alright",
  "definitely",
  "deffo",
  "then",
  "tonight",
  "today",
  "tomorrow",
  "thing",
];

/** Filler that may only TRAIL the answer — words that qualify WHICH match
 *  ("out this week", "in for this one") but can never open one. Kept out
 *  of the lead set so they cannot pad the front of a sentence. */
const TAIL_ONLY = ["this", "week", "one", "for", "now", "still"];

/** Words that may open a YES but are also YES cores in their own right
 *  ("yes" alone, "yes please"). Kept polarity-specific so a lead can
 *  never bridge into the OPPOSITE polarity's core — "yes cant" matches
 *  nothing at all, which is the correct answer. */
const YES_LEAD = ["yes", "yess", "yesss", "yep", "yeah", "yeh", "yea", "yup", "yh", "ya", "sure", "ok", "okay"];
const NO_LEAD = ["no", "nope", "nah", "naah", "naa", "sorry"];

/** The affirmative cores, as WHOLE alternatives. */
const YES_CORE = [
  String.raw`y`,
  String.raw`ye`,
  String.raw`yes+`,
  String.raw`yeah+`,
  String.raw`yeh+`,
  String.raw`yea`,
  String.raw`yep+`,
  String.raw`yup+`,
  String.raw`yh`,
  String.raw`ya`,
  String.raw`sure`,
  String.raw`ok(?:ay)?`,
  String.raw`(?:(?:im|i am|am)\s+)?in`,
  String.raw`count me in`,
  String.raw`(?:(?:ill|i will)\s+)?take it`,
  String.raw`go on`,
  String.raw`deal`,
  String.raw`done`,
  String.raw`please`,
  String.raw`confirm(?:ed)?`,
  String.raw`can do`,
  String.raw`i can (?:play|make it|do it)`,
  String.raw`grab it`,
];

/** The negative cores, as WHOLE alternatives. */
const NO_CORE = [
  String.raw`n`,
  String.raw`no+`,
  String.raw`nope+`,
  String.raw`nah+`,
  String.raw`na+h`,
  String.raw`nay`,
  String.raw`sorry`,
  String.raw`(?:i\s+)?(?:cant|cannot|carnt)(?:\s+(?:make it|make this one|do it|play|come|attend|tonight|today|tomorrow|this week))?`,
  String.raw`(?:i\s+)?wont(?:\s+(?:make it|be there|be playing|make this one))?`,
  String.raw`pass`,
  String.raw`(?:(?:im|i am|am)\s+)?out`,
  String.raw`count me out`,
  String.raw`not (?:tonight|today|tomorrow|this week|this one|available|playing|coming|free)`,
  String.raw`next time`,
  String.raw`unable`,
];

function whole(lead: string[], cores: string[]): RegExp {
  const leadTok = [...lead, ...FILLER].join("|");
  const tailTok = [...FILLER, ...TAIL_ONLY].join("|");
  return new RegExp(
    `^(?:(?:${leadTok})\\s+)*(?:${cores.join("|")})(?:\\s+(?:${tailTok}))*$`,
  );
}

const YES_RE = whole(YES_LEAD, YES_CORE);
const NO_RE = whole(NO_LEAD, NO_CORE);

/** Polarity carried by emoji alone, when the message has no words left
 *  after normalisation. Mixed signals ("👍👎") mean nothing. */
function emojiOnlyAnswer(raw: string): BenchPromptAnswer {
  const yes = (raw.match(YES_EMOJI) ?? []).length;
  const no = (raw.match(NO_EMOJI) ?? []).length;
  if (yes > 0 && no === 0) return "yes";
  if (no > 0 && yes === 0) return "no";
  return null;
}

/**
 * Is this group message an answer to the open bench prompt this sender
 * already has? `null` for everything the module does not recognise
 * WHOLE — the caller then does nothing at all.
 *
 * Pure: same string in, same answer out, always. No DB, no clock, no
 * model.
 */
export function readBenchPromptAnswer(body: string): BenchPromptAnswer {
  const raw = (body ?? "").trim();
  if (!raw) return null;
  if (raw.length > MAX_LEN) return null;
  // A question is a question, never an answer ("in?", "am I in?").
  if (raw.includes("?")) return null;

  const t = normalise(raw);

  // No words left: the whole message was emoji / punctuation.
  if (!t) return emojiOnlyAnswer(raw);

  if (t.split(" ").length > MAX_WORDS) return null;

  // A message whose WORDS say one thing and whose EMOJI say the other is
  // not a clean answer. Words win only when the emoji agree or are absent.
  const emoji = emojiOnlyAnswer(raw);
  const hasEmoji =
    (raw.match(YES_EMOJI) ?? []).length + (raw.match(NO_EMOJI) ?? []).length > 0;

  // NO first: several negative forms embed an affirmative word ("not
  // in"), and whole-message anchoring means the two can never both match
  // in practice — but the order makes that explicit.
  let answer: BenchPromptAnswer = null;
  if (NO_RE.test(t)) answer = "no";
  else if (YES_RE.test(t)) answer = "yes";

  if (answer && hasEmoji && emoji !== null && emoji !== answer) return null;
  if (answer) return answer;

  // No core matched, but the message is an emoji plus nothing that
  // carries meaning of its own ("👍 thanks", "❌ sorry mate"). The emoji
  // IS the answer; the words are courtesy.
  const allFiller = t.split(" ").every((w) => FILLER.includes(w));
  if (allFiller && emoji !== null) return emoji;
  return null;
}
