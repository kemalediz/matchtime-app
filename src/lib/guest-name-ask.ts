/**
 * UNNAMED-GUEST NAME ASK — pure, no DB, no LLM.
 *
 * WHY THIS FILE EXISTS (production, 2026-08-31)
 * ---------------------------------------------
 * Amir posted in the club's WhatsApp group:
 *
 *     "@Kemal Ediz my brother can play if needed"
 *
 * PR #26 (51b7250) fixed the write: the SUBJECT of a conditional offer
 * decides who gets registered, so Amir is no longer benched for offering
 * somebody else. What it left behind was SILENCE. `bring_guests_vague`
 * sits in ACTIONY_INTENTS, so an untagged one is forced to noise and
 * MatchTime says nothing at all. The club owner had to type
 *
 *     "yes pls, can you share the name?"
 *
 * himself before the guest could be registered. He asked for MatchTime
 * to do the asking.
 *
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 * ---------------------------------------------
 * This is a QUESTION, never a write. Nobody has been named, so there is
 * nothing to register and the blast radius is one sentence. The reply is
 * composed HERE, by code, from facts the caller reads out of the
 * database — the same direction `src/lib/format-switch.ts` set after the
 * 2026-08-30 format-switch incident, and what
 * MDs/analyzer-redesign-2026-08-31.md argues for: the model classifies,
 * code composes.
 *
 * MatchTime's interaction contract is deliberately conservative — silent
 * on banter, tag-free only for a player's own attendance. Making it
 * SPEAK where it currently stays quiet is the delicate part, so the ask
 * is gated four ways beyond "the model said bring_guests_vague":
 *
 *   1. The message must LOOK like an offer (looksLikeUnnamedGuestOffer):
 *      a person reference AND an availability cue. Banter that merely
 *      mentions a mate gets nothing. Waived when MT is tagged, because
 *      then the sender addressed it on purpose.
 *   2. The squad must have room (untagged). Soliciting a name for a full
 *      squad promises a slot that does not exist.
 *   3. At most ONE ask per player per match, forever, whatever they say
 *      afterwards. If they never reply with a name, MatchTime drops it.
 *   4. The sender must be resolved to a member, so that dedupe key
 *      exists at all.
 *
 * There is no branch in here that can produce an attendance write: the
 * decision type is `{ask, reason}` and the copy is a string. The caller
 * (src/app/api/whatsapp/analyze/route.ts) makes the whole
 * unnamed-guest-offer branch terminal, so no verdict that reaches it can
 * fall through into an apply path.
 */

// ── Placeholder guest names ────────────────────────────────────────────
//
// The analyzer has been observed emitting
// `registerFor: [{name: "Amir's brother", action: "IN"}]` for the exact
// production message — six times out of six with the pre-incident squad
// state (MDs/analyzer-redesign-2026-08-31.md §4.1). That string then
// reaches resolveOrProvisionByName, matches nobody, and PROVISIONS A
// GHOST USER literally called "Amir's brother" into a paid squad. A
// relationship is not a name, and code can say so deterministically.

/** Person nouns that are only ever a placeholder when DETERMINED
 *  ("my brother", "a mate", "2 of my guys"). Bare "Guy" / "Kid" are real
 *  first names, so a determiner is always required for these. */
const DETERMINED_NOUN =
  "brothers?|sisters?|bro|sis|mates?|friends?|cousins?|sons?|dad|father|uncle|nephew|" +
  "colleagues?|boys?|lads?|guys?|pals?|neighbou?rs?|flatmates?|housemates?|team-?mates?|" +
  "kids?|players?|keepers?|goalies?|goalkeepers?|subs?|guests?|others?";

/** Words that are a placeholder ON THEIR OWN — no determiner needed,
 *  because none of them is ever a person's name. */
const BARE_INDEFINITE =
  "someone|somebody|anyone|anybody|another|one\\s+more|a\\s+couple|a\\s+few|" +
  "guest|guests|\\+\\s*\\d+";

/** Optional leading count ("2 of my guys", "a couple of mates"). */
const COUNT = "(?:\\d+|two|three|four|five|a\\s+couple|a\\s+few|some|both)\\s+(?:of\\s+)?";

/** Determiner: a possessive ("my", "Amir's") or an article. */
const DETERMINER = "(?:my|his|her|their|our|your|[a-z][a-z'’-]*'?[’']s|a|an|the)\\s+";

// A determined noun needs a COUNT ("a couple of mates"), a DETERMINER
// ("my brother"), or both ("2 of my guys") — never bare, because bare
// "Guy" / "Kid" are real first names. Bare indefinites need neither.
const PLACEHOLDER_RE = new RegExp(
  `^(?:(?:${COUNT})(?:${DETERMINER})?|(?:${DETERMINER}))(?:${DETERMINED_NOUN})$` +
    `|^(?:${COUNT})?(?:${BARE_INDEFINITE})$`,
  "i",
);

/**
 * Is this "name" a relationship or an indefinite rather than a person?
 *
 *   "my brother"       → true    "Shahrokh"             → false
 *   "Amir's brother"   → true    "my brother Shahrokh"  → false (named!)
 *   "2 of my guys"     → true    "Guy"                  → false (a name)
 *   "someone"          → true    "Kieran Baker"         → false
 *
 * Deliberately ANCHORED at both ends: the moment a real name is attached
 * ("my brother Shahrokh") this returns false and the normal registerFor
 * path takes over. Wrongly dropping a real add is worse than wrongly
 * asking for a name, so this errs towards false.
 */
export function isPlaceholderGuestName(name: string): boolean {
  const t = (name ?? "").trim().replace(/\s+/g, " ");
  if (!t) return false;
  return PLACEHOLDER_RE.test(t);
}

// ── Does the message actually OFFER somebody? ──────────────────────────
//
// The deterministic corroboration that keeps MatchTime off banter. Both
// halves must be present: a person to offer, AND a cue that they might
// play. "my brother watched the game last night" has the first and not
// the second, so MatchTime stays quiet — which is what the owner values
// about the current contract.

/** Someone other than the sender is in the message. */
const PERSON_CUE = new RegExp(
  `\\b(?:${DETERMINED_NOUN})\\b|\\b(?:someone|somebody|anyone|anybody|another)\\b|\\+\\s*\\d`,
  "i",
);

/** …and they might PLAY. Availability / bringing / recruiting language. */
const AVAILABILITY_CUE = new RegExp(
  [
    "\\bcan\\s+play\\b",
    "\\bcould\\s+play\\b",
    "\\bcan\\s+make\\s+it\\b",
    "\\bwants?\\s+to\\s+(?:come|play|join)\\b",
    "\\bup\\s+for\\s+it\\b",
    "\\bfill(?:ing)?\\s+in\\b",
    "\\bbring(?:ing)?\\b",
    "\\bjoin\\b",
    "\\bjump\\s+in\\b",
    "\\bfind\\s+(?:another|someone|somebody|one)\\b",
    "\\bknow\\s+(?:a|someone|somebody)\\b",
    "\\bavailable\\b",
    "\\bfree\\b",
    "\\bspare\\b",
    "\\bcover\\b",
    "\\bmake\\s+up\\s+the\\s+numbers\\b",
    "\\bplay(?:ing)?\\s+(?:if|next|tomorrow|tonight|this)\\b",
  ].join("|"),
  "i",
);

/**
 * Does this message read as an offer of somebody who has NOT been named?
 *
 *   "my brother can play if needed"          → true
 *   "I can bring someone if you're short"    → true
 *   "two of my guys can play next week"      → true
 *   "my brother watched the game lol"        → false  (no availability cue)
 *   "I'll be the 14th if you're short"       → false  (no third party)
 *
 * An AND of two narrow signals on top of the model already having said
 * `bring_guests_vague`, so a false positive needs the model AND both
 * regexes to be wrong at once. Missing an ask costs nothing worse than
 * today's silence; speaking on banter is the failure that matters.
 */
export function looksLikeUnnamedGuestOffer(body: string): boolean {
  const t = (body ?? "").trim();
  if (!t) return false;
  return PERSON_CUE.test(t) && AVAILABILITY_CUE.test(t);
}

// ── Which verdicts reach the ask path ──────────────────────────────────

export interface GuestOfferEntry {
  name: string;
  action: "IN" | "OUT" | "BENCH";
}

/**
 * The subset of AnalysisVerdict this module reasons about.
 *
 * It carries EVERY actionable field, not just the guest-shaped ones,
 * because the caller's ask branch is terminal: whatever reaches it has
 * its whole verdict discarded. See isVagueGuestOfferVerdict.
 */
export interface GuestOfferVerdict {
  intent: string;
  registerAttendance: "IN" | "OUT" | "BENCH" | null;
  registerFor: GuestOfferEntry[] | null;
  // Everything else AnalysisVerdict can ACT on.
  benchConfirmation?: "yes" | "no" | null;
  scoreRed?: number | null;
  scoreYellow?: number | null;
  includeNames?: string[] | null;
  teamOverrides?: Array<{ name: string; team: "RED" | "YELLOW" }> | null;
  teamNames?: [string, string] | null;
  bulkPayment?: { payerName: string; count: number; coveredNames?: string[] } | null;
  reminder?: { date: string; time?: string; note: string } | null;
}

/**
 * Does this verdict tell the server to DO anything besides offer an
 * unnamed guest? Covers every actionable field on AnalysisVerdict apart
 * from registerFor, which the guest logic owns.
 *
 * `intent`, `confidence`, `react`, `reply` and `reasoning` are NOT
 * actionable: they describe or decorate, they do not mutate. Everything
 * listed here mutates something a player would notice.
 *
 * NOTE the explicit null checks on the score fields: 0 is a real score
 * ("we lost 0-3"), so a truthiness test would silently drop it.
 */
export function carriesOtherAction(v: GuestOfferVerdict): boolean {
  if (v.registerAttendance != null) return true;
  if (v.benchConfirmation != null) return true;
  if (v.scoreRed != null || v.scoreYellow != null) return true;
  if (v.includeNames != null && v.includeNames.length > 0) return true;
  if (v.teamOverrides != null && v.teamOverrides.length > 0) return true;
  if (v.teamNames != null) return true;
  if (v.bulkPayment != null) return true;
  if (v.reminder != null) return true;
  return false;
}

/**
 * Drop registerFor entries whose "name" is a placeholder ADD. Such an
 * entry can only ever provision a ghost member, so it is never worth
 * keeping. A non-IN placeholder is left alone: `stripPlaceholderGuests`
 * must never eat a drop (the analyze route's banter-drop guard and the
 * #26 seatbelt own that territory, and silently swallowing an OUT is the
 * failure class this codebase fears most).
 */
export function stripPlaceholderGuests(
  entries: GuestOfferEntry[] | null | undefined,
): GuestOfferEntry[] {
  return (entries ?? []).filter(
    (e) => !(e.action === "IN" && isPlaceholderGuestName(e.name)),
  );
}

/**
 * Is this verdict PURELY an offer of an UNNAMED guest — i.e. the
 * name-ask path?
 *
 * Two shapes qualify, because the model produces both for the same
 * message:
 *   a) `intent: "bring_guests_vague"` with no real registerFor, which is
 *      what the prompt asks for; and
 *   b) `intent: "in"` with `registerFor: [{name: "Amir's brother"}]`,
 *      which is what it actually emitted 6/6 times before the fix.
 *
 * A verdict carrying ANY real name is NOT this path — "my brother
 * Shahrokh can play" already works and must keep working.
 *
 * PURELY is the load-bearing word (PR #29 review, 2026-08-31). The
 * caller's ask branch is TERMINAL: it `continue`s before any apply path,
 * so whatever this returns true for has its ENTIRE verdict discarded.
 * The first cut only inspected registerFor, so "I'm in, and my brother
 * can play too" returned true and the player's own IN was never written.
 * They believe they are in the squad, the DB says otherwise, and the
 * pre-match reminder reads the DB. "I can't make it but my mate can
 * play" was worse still: a player who typed OUT stayed counted as
 * playing. That is exactly the silent-write-loss class this file was
 * written to guard against, missed one layer above where it was guarded.
 *
 * So: any other actionable payload (see carriesOtherAction) disqualifies
 * the verdict, and it falls through to normal handling. By then the
 * placeholder ADD has already been stripped by the caller, so no ghost
 * member is provisioned either way. Losing the name-ask on a combined
 * message is an acceptable cost. Losing attendance is not.
 */
export function isVagueGuestOfferVerdict(v: GuestOfferVerdict): boolean {
  // Anything else to DO means this is not purely a guest offer. Checked
  // FIRST so no later branch can hand back a true that discards a write.
  if (carriesOtherAction(v)) return false;

  // ALLOW-LIST, not a deny-list. Only these two intents may reach the
  // terminal branch, because the route has per-intent safety nets AFTER
  // it that `continue` would skip. The one that bites is the OUT safety
  // net: it fires on intent "replacement_request" with registerAttendance
  // NOT "OUT" and forces the sender OUT when the reasoning shows a strong
  // drop signal. registerAttendance is null there, so carriesOtherAction
  // cannot see it, and "someone replace me, my mate could fill in" would
  // have skipped the net and quietly kept a player who asked to be
  // replaced in the squad. Drop-shaped intents never take this path.
  //
  // "in" stays allowed because that is the ghost-user shape
  // (registerFor:[{name:"Amir's brother"}]), and the IN safety net's own
  // relay guard already skips any verdict with a non-empty registerFor,
  // so nothing downstream is lost by handling it here.
  if (v.intent !== "bring_guests_vague" && v.intent !== "in") return false;

  const entries = v.registerFor ?? [];
  const real = stripPlaceholderGuests(entries);
  if (real.length > 0) return false; // a real name is present → normal path
  if (v.intent === "bring_guests_vague") return true;
  // Placeholder-only ADDs under intent "in".
  return entries.length > 0 && entries.every((e) => e.action === "IN");
}

// ── The gate ───────────────────────────────────────────────────────────

export interface GuestAskInput {
  /** Raw message body, as posted. */
  body: string;
  /** Did the message tag @Match Time? (interaction-contract signal) */
  tagged: boolean;
  /** Did the sender resolve to a real member? Without a userId there is
   *  no per-player dedupe key, so the ask could repeat forever. */
  senderKnown: boolean;
  /** Org tracks attendance at all (MoM-only orgs must stay silent). */
  attendanceOn: boolean;
  /** There is a registration match to add anyone to. */
  hasActiveMatch: boolean;
  /** Confirmed squad size RIGHT NOW (read from the DB, never the model). */
  confirmedCount: number;
  /** Format capacity — Match.maxPlayers, i.e. both teams. */
  maxPlayers: number;
  /** Has this player already been asked for a guest name for THIS match? */
  alreadyAsked: boolean;
}

export interface GuestAskDecision {
  ask: boolean;
  /** Operator-readable why, logged and stored on the AnalyzedMessage. */
  reason: string;
}

/**
 * Should MatchTime ask this sender for their guest's name?
 *
 * Ordered so the reason is the most useful one, and so the cheap
 * structural checks come before the copy-ish ones.
 */
export function shouldAskForGuestName(input: GuestAskInput): GuestAskDecision {
  if (!input.attendanceOn)
    return { ask: false, reason: "attendance not tracked for this org" };
  if (!input.hasActiveMatch)
    return { ask: false, reason: "no active registration match to add a guest to" };
  if (!input.senderKnown)
    return { ask: false, reason: "sender unresolved, no per-player dedupe key" };
  if (input.alreadyAsked)
    return { ask: false, reason: "already asked this player for a guest name for this match" };

  // A tag means the sender addressed MatchTime deliberately. Answering is
  // then the polite thing to do whatever the squad state and however the
  // offer is worded — the seatbelts below exist to stop MT piping up
  // UNPROMPTED, not to stonewall someone who asked.
  if (input.tagged) return { ask: true, reason: "tagged unnamed-guest offer" };

  if (!looksLikeUnnamedGuestOffer(input.body))
    return { ask: false, reason: "untagged and does not read as a guest offer" };

  const room = Math.max(0, input.maxPlayers - input.confirmedCount);
  if (room <= 0)
    return {
      ask: false,
      reason: `squad already full (${input.confirmedCount}/${input.maxPlayers}), no slot to offer a guest`,
    };

  return {
    ask: true,
    reason: `unnamed guest offered with ${room} slot(s) open (${input.confirmedCount}/${input.maxPlayers})`,
  };
}

// ── The copy ───────────────────────────────────────────────────────────

/** Plural offer? "two of my guys", "2 friends", "my mates". */
const PLURAL_RE = new RegExp(
  `\\b(?:\\d+|two|three|four|five|couple|few|both)\\b[^.!?]{0,20}\\b(?:${DETERMINED_NOUN})\\b` +
    `|\\b(?:mates|friends|guys|lads|boys|brothers|sisters|cousins|players|others|people)\\b`,
  "i",
);

/** A pushname that is really a phone number must never be printed as a
 *  name in the group (same rule as isRawDigitName in the analyze route). */
function firstName(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  const first = t.split(/\s+/)[0] ?? "";
  if (!first) return null;
  if (/^[+\d][\d\s()+-]*$/.test(first)) return null; // raw number, not a name
  return first;
}

export interface GuestAskCopyInput {
  /** Sender's display name; only the first token is used. */
  askerName: string | null;
  /** The offer, used only to pick singular vs plural phrasing. */
  body: string;
}

/**
 * The ask, composed by CODE. Short, warm, and the next step is the whole
 * point of the sentence.
 *
 * House style: no em dashes, no slashes.
 */
export function renderGuestNameAsk(input: GuestAskCopyInput): string {
  const who = firstName(input.askerName);
  const opener = who ? `Nice one ${who} 🙌` : "Nice one 🙌";
  const plural = PLURAL_RE.test(input.body ?? "");
  return plural
    ? `${opener} What are their names? Reply with them and I'll add them to the squad.`
    : `${opener} What's their name? Reply with it and I'll add them to the squad.`;
}

/** SentNotification key: one ask per player per match, forever. */
export function guestNameAskKey(matchId: string, userId: string): string {
  return `guest-name-ask:${matchId}:${userId}`;
}

/** SentNotification kind for the same row. */
export const GUEST_NAME_ASK_KIND = "guest-name-ask";
