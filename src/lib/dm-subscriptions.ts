/**
 * Per-category proactive-DM subscription preferences — PURE logic.
 *
 * This module holds the parts of the feature that must be unit-testable
 * without a database: the deterministic keyword parser that maps an
 * inbound DM to an intent, the intent -> flag-patch mapping, the
 * acknowledgement copy, and the data-migration backfill rule. The DB
 * writer lives in `notification-prefs.ts` (setDmSubscriptions); the
 * senders that consult the flags live in bot-scheduler.ts / recruit.ts.
 *
 * Design note (why a per-category model): a player once DM'd the bot
 * "do not message me on any topic but payment". The only preference we
 * had was a single ratings toggle, so the bot silenced ratings, claimed
 * success, and then kept sending recruit/bench/reminder DMs — it lied.
 * Each proactive-DM category now has its own boolean flag on Membership
 * (all default true = subscribed). PAYMENT DMs have NO flag: someone who
 * owes money is always sent their pay link + chases.
 */
import { t } from "./i18n/t";
import { normaliseLang, type Lang } from "./i18n/lang";

/** The per-category subscription boolean fields on `Membership`. Payment
 *  is intentionally absent — it is never opt-out-able. */
export const DM_SUB_FIELDS = [
  "subMatchInviteDm",
  "subBenchOfferDm",
  "subTentativeDm",
  "subRatingDm",
  "subReminderDm",
] as const;

export type DmSubField = (typeof DM_SUB_FIELDS)[number];

/** A partial patch over the sub* flags — any subset may be set at once. */
export type DmSubPatch = Partial<Record<DmSubField, boolean>>;

export type DmSubCommandKind =
  | "opt-out-all" // silence everything except payment
  | "opt-out-ratings" // silence only rating / MoM DMs
  | "opt-in-all" // re-subscribe to everything
  | "opt-in-ratings"; // re-subscribe to rating / MoM DMs only

// ── Building-block regexes ──────────────────────────────────────────────
// Kept intentionally conservative: we only ever act on a clear keyword
// match, and the GOLDEN RULE downstream is that we never ACK unless the DB
// write actually lands. False negatives (fall through to normal handling)
// are far safer than false positives (silencing someone who didn't ask).

/** A "make it stop" verb. NB: bare "no" is deliberately excluded — it
 *  fires on chit-chat like "no problem". "no more" is included. */
const STOP_VERB = /\b(stop|don'?t|do not|no more|quit|unsubscribe|opt[\s-]?out|leave me alone|mute|silence)\b/i;

/** Names the rating / Man-of-the-Match category specifically. */
const NAMES_RATINGS = /\b(rating|ratings|rate|mom|motm|man of the match|man-of-the-match|mvp)\b/i;

/** Names payment. */
const NAMES_PAYMENT = /\bpay(?:ment)?s?\b/i;

/** A restrictive "only this one thing" marker. */
const RESTRICTIVE = /\b(only|just|except|but|nothing but|apart from|other than|no .* but)\b/i;

/** Refers to messaging/contact in general (used to spot a BROAD stop that
 *  names no specific category). */
const MESSAGING_WORD = /\b(messag\w*|contact|text|texts|dm|dms|nudg\w*|ping|notif\w*)\b/i;

/** Bare "stop" (optionally with trailing punctuation). */
const BARE_STOP = /^\s*(stop|leave me alone)[.!]?\s*$/i;

/** An unambiguous "turn it back on" verb that needs no object. */
const OPT_IN_BARE = /\b(resume|opt[\s-]?in|unmute|re-?subscribe)\b/i;

/** "start / turn on X" where X is about messaging or ratings. */
const OPT_IN_VERB_OBJ =
  /\b(start|turn (?:it|them|these|everything)? ?(?:back )?on|switch on|turn on)\b[^.?!]*\b(messag\w*|rating\w*|rate|mom|motm|man of the match|mvp|dm\w*|notif\w*|contact|everything|again)\b/i;

/**
 * Classify an inbound DM into a subscription command, or null if it isn't
 * one (ordinary chat / a question — the caller then falls through to its
 * normal handling and writes nothing).
 *
 * Disambiguation order is load-bearing:
 *   1. opt-in first, so "start ratings" isn't read as a stop.
 *   2. BROAD "all-but-payment" before narrow ratings — a message that
 *      names payment (with a restrictive marker) or is a bare broad stop
 *      is the BROAD case. This is what routes the real incident message
 *      "do not message me on any topic but payment" to opt-out-all.
 *   3. narrow ratings.
 */
export function parseDmSubscriptionCommand(text: string, lang?: Lang | string | null): DmSubCommandKind | null {
  const t = (text ?? "").trim();
  if (!t) return null;

  // A Turkish org's player may use either language. The Turkish reading
  // runs first and only for that org; English text is never read by it.
  if (normaliseLang(lang) === "tr") {
    const tr = parseTurkishDmSubscriptionCommand(t);
    if (tr) return tr;
  }

  // 1. Opt back IN.
  const isOptIn = OPT_IN_BARE.test(t) || OPT_IN_VERB_OBJ.test(t);
  if (isOptIn) {
    // Ratings-specific only if it names ratings AND isn't an explicit
    // "everything / all" re-subscribe. NB: "messages" alone is NOT broad —
    // "start rating messages" is still ratings-specific.
    const namesBroad = /\b(everything|all)\b/i.test(t);
    if (NAMES_RATINGS.test(t) && !namesBroad) return "opt-in-ratings";
    return "opt-in-all";
  }

  // 2a. BROAD all-but-payment: names payment with a restrictive marker.
  if (NAMES_PAYMENT.test(t) && RESTRICTIVE.test(t)) return "opt-out-all";

  // 3. Narrow ratings: a stop verb aimed at ratings/MoM (and not a
  //    payment-restrictive phrase, already handled above).
  if (STOP_VERB.test(t) && NAMES_RATINGS.test(t)) return "opt-out-ratings";

  // 2b. BROAD stop that names no specific category: bare "stop" or a stop
  //     verb about messaging in general.
  const broadStop =
    (BARE_STOP.test(t) || (STOP_VERB.test(t) && MESSAGING_WORD.test(t))) &&
    !NAMES_RATINGS.test(t);
  if (broadStop) return "opt-out-all";

  return null;
}

// ── Turkish (Phase 3, 2026-09-17) ──────────────────────────────────────
// Same shape and the same caution as the English: a clear verb AND a
// clear object, or the command the Turkish ack quotes ("mesajları aç",
// "puanlamayı aç"). A bare "dur" is NOT a stop: it is what a collector
// types to hold a fee, and this reader runs before the fee reader.
// Letter-bounded (`\p{L}`), after `toLocaleLowerCase("tr")`.

const TR = (body: string) => new RegExp(`(?<!\\p{L})(?:${body})(?!\\p{L})`, "u");
/** "turn on / start". */
const TR_ON = TR(String.raw`a[çc]|a[çc]abilirsin|ba[şs]lat|tekrar\s+g[öo]nder`);
/** "don't send / don't write / don't want / stop / switch off". */
const TR_STOP = TR(
  String.raw`atma|atmay[ıi]n|g[öo]nderme|g[öo]ndermeyin|yazma|yazmay[ıi]n|istemiyorum|durdur|kapat|rahats[ıi]z\s+etme`,
);
/** Messages in general. */
const TR_MESSAGES = TR(String.raw`mesaj\p{L}*|bildirim\p{L}*|dm\p{L}*|hepsini|t[üu]m[üu]n[üu]|her\s*[şs]eyi`);
/** The rating / Man-of-the-Match category. */
const TR_RATINGS = TR(String.raw`puan\p{L}*|ma[çc][ıi]n\s+adam\p{L}*|oylama\p{L}*`);
/** "only / except ... payment". */
const TR_ONLY_PAYMENT = TR(String.raw`(?:sadece|yaln[ıi]zca|bir\s+tek)\s+[öo]deme\p{L}*|[öo]deme\p{L}*\s+(?:d[ıi][şs][ıi]nda|hari[çc])`);

function parseTurkishDmSubscriptionCommand(raw: string): DmSubCommandKind | null {
  const t = raw.toLocaleLowerCase("tr");
  if (TR_ON.test(t) && !TR_STOP.test(t)) {
    if (TR_RATINGS.test(t)) return "opt-in-ratings";
    if (TR_MESSAGES.test(t)) return "opt-in-all";
    return null;
  }
  if (TR_ONLY_PAYMENT.test(t)) return "opt-out-all";
  if (TR_STOP.test(t) && TR_RATINGS.test(t)) return "opt-out-ratings";
  if (TR_STOP.test(t) && TR_MESSAGES.test(t)) return "opt-out-all";
  return null;
}

/** The flag patch a command applies. opt-out-all / opt-in-all touch every
 *  category; the ratings commands touch only subRatingDm. */
export function dmSubPatchForCommand(kind: DmSubCommandKind): DmSubPatch {
  switch (kind) {
    case "opt-out-all":
      return Object.fromEntries(DM_SUB_FIELDS.map((f) => [f, false])) as DmSubPatch;
    case "opt-in-all":
      return Object.fromEntries(DM_SUB_FIELDS.map((f) => [f, true])) as DmSubPatch;
    case "opt-out-ratings":
      return { subRatingDm: false };
    case "opt-in-ratings":
      return { subRatingDm: true };
  }
}

/** Player-facing acknowledgement copy for a command. Only ever sent AFTER
 *  the DB write succeeds (see the fast-path's GOLDEN RULE). `lang` is the
 *  language of the org the reply is routed through; each ack quotes the
 *  command that undoes it, in that language, and the parser above
 *  accepts it. */
export function dmSubAckMessage(kind: DmSubCommandKind, lang?: Lang | string | null): string {
  return t(lang).dm_sub_ack({ kind });
}

/**
 * Data-migration backfill rule, extracted so it can be asserted in a unit
 * test alongside the SQL in
 * prisma/migrations/*_dm_subscription_preferences/migration.sql.
 *
 * Old `ratingDmOptOut` has OPT-OUT semantics (true = suppressed); new
 * `subRatingDm` has SUBSCRIPTION semantics (true = receives). So
 * subRatingDm = NOT ratingDmOptOut — anyone opted out of ratings STAYS
 * opted out.
 */
export function subRatingDmFromLegacy(ratingDmOptOut: boolean): boolean {
  return !ratingDmOptOut;
}
