/**
 * DOES THE MESSAGE NAME THE BENCH? (2026-09-24, Sutton FC, Erdal's "in")
 *
 * A BENCH row means the squad is FULL or a human EXPLICITLY asked for the
 * bench (PR #27). "Explicitly asked" used to be taken on the extractor's
 * word alone: any uncontingent `polarity: "bench"` became `explicitBench`,
 * and `explicitBench` is the only thing that may demote a CONFIRMED
 * player. On 2026-09-24 the extractor returned "bench" for the two letters
 * "in", from a player already confirmed at 14/14, and the engine demoted
 * him with the audit note "explicit bench request". Nobody had said the
 * word.
 *
 * NOT A CLASSIFIER, and that distinction is the whole reason this is
 * allowed to exist in a codebase that deleted its regex fast path twice.
 * It never PRODUCES a bench and never reads a polarity off the text: it
 * is a necessary condition on a reading the model already made. A model
 * "bench" whose message contains none of these words is read as the IN it
 * came from, and capacity decides, which is exactly how an INFERRED bench
 * has always been treated. The only thing it can do is refuse a demotion.
 *
 * WHICH WAY IT FAILS. A real bench request in words not listed here is
 * read as an IN: a confirmed player stays confirmed (he can say "bench"
 * and it lands), a newcomer takes a slot if there is one and the bench if
 * there is not. Both are recoverable with one message. The failure it
 * closes, a player losing his place silently, was not.
 *
 * English and Turkish, because the group speaks both. Turkish "yedek"
 * softens to "yedeğ-" before a vowel ("yedeğe", "yedeğim").
 */
const BENCH_WORDS =
  /(?<![\p{L}\p{N}])(?:bench(?:ed|es|ing)?|reserves?|subs?|substitutes?|stand-?by|wait(?:ing)?[\s-]?list(?:ed)?|yede[kğ]\p{L}*)(?![\p{L}\p{N}])|🪑/iu;

export function namesTheBench(body: string): boolean {
  return BENCH_WORDS.test(body);
}
