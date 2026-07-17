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
export function parseDmSubscriptionCommand(text: string): DmSubCommandKind | null {
  const t = (text ?? "").trim();
  if (!t) return null;

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
 *  the DB write succeeds (see the fast-path's GOLDEN RULE). */
export function dmSubAckMessage(kind: DmSubCommandKind): string {
  switch (kind) {
    case "opt-out-all":
      return (
        'Done — I\'ll only message you about payments from now on. ' +
        'Text "start messages" anytime to turn the rest back on.'
      );
    case "opt-out-ratings":
      return (
        'Done — no more rating or Man-of-the-Match messages from me 👍 ' +
        'Text "start ratings" anytime to turn them back on.'
      );
    case "opt-in-all":
      return "Great — you're back on for all my messages 👍";
    case "opt-in-ratings":
      return "Great — I'll send you rating and Man-of-the-Match links again 👍";
  }
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
