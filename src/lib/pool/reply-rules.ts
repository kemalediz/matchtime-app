/**
 * A REPLY IN WORDS TO A POOL OFFER: THE RULES (slice L6, 2026-10-24). PURE.
 * Plan 5.3: the reader answers accept, decline, stop, question or neither,
 * with a confidence floor; it runs ONLY when the sender has an offer that
 * reached him (the state prior), and reads the reply against the offer.
 *
 * The model only says what the words mean (`reply-reader.ts`). Everything
 * else is decided here, from facts:
 *
 *   offerReplyState  what one of his offers is now: open (he may still
 *                    answer it), taken (he took the place and still holds
 *                    it, before kickoff), or ended.
 *   replyScope       which offers a DM may be about. A swipe-reply quoting
 *                    an offer is about that offer. Otherwise someone in no
 *                    club: his one live offer; two or more live: "several"
 *                    (he is asked which, never guessed); none live: his
 *                    newest ended one (its one "gone" line, or a stop). A
 *                    CLUB MEMBER's plain DM is read only with exactly one
 *                    live offer AND no club DM to him since it was
 *                    delivered (so "is Tuesday on?" after his club's
 *                    reminder stays his club's); two live offers: quotes
 *                    only. Decision L6.1.
 *   replyAction      what is done with the reading. Below the floor: one
 *                    re-ask with the link (live offer), or today's line.
 *                    A club member's plain DM that is unsure or "neither"
 *                    carries on to his club's handlers, never swallowed.
 *                    Accept, decline, give back and stop change his record,
 *                    so they need the DM to come from HIS number (`proved`;
 *                    the DM is his own message, which is the proof the tap
 *                    link's page asks for, review of #400 M2); unproved,
 *                    the tap-the-link line, whose page proves him.
 *                    "details" (2026-11-04, his times and formats) is
 *                    `detailsAction`'s: saved only from his own number.
 */

/** "details" (2026-11-04): he tells MatchTime his times or formats
 *  (`details-rules.ts`), answering its question or at any time. */
export type PoolReplyIntent = "accept" | "decline" | "stop" | "question" | "details" | "neither";
export const POOL_REPLY_INTENTS: readonly PoolReplyIntent[] = ["accept", "decline", "stop", "question", "details", "neither"];

/** Below this the reading changes nothing (the pairing reply's floor). */
export const POOL_REPLY_MIN_CONFIDENCE = 0.8;

/** How long after delivery a plain reply may still be about an offer (L5a's window). */
export const POOL_REPLY_WINDOW_MS = 24 * 3600_000;

/** A question about one offer is answered with its facts at most this many times. */
export const POOL_REPLY_FACTS_PER_OFFER = 3;

export type OfferReplyState = "open" | "taken" | "ended";

export function offerReplyState(o: {
  outcome: string | null;
  askStatus: string;
  sentAt: Date | null;
  expiresAt: Date;
  matchLive: boolean;
  kickoff: Date;
  /** He has a CONFIRMED or BENCH row on the match (for an accepted offer). */
  holdsPlace: boolean;
  now: Date;
}): OfferReplyState {
  const now = o.now.getTime();
  const before = o.matchLive && now < o.kickoff.getTime();
  if (!before || !o.sentAt) return "ended";
  if (o.outcome === null) return o.askStatus === "open" && now < o.expiresAt.getTime() ? "open" : "ended";
  if (o.outcome === "accepted") return o.holdsPlace ? "taken" : "ended";
  return "ended";
}

export interface ReplyOffer {
  id: string;
  state: OfferReplyState;
  sentAt: Date;
  /** The DM swipe-replies to this offer's own WhatsApp message. */
  quoted: boolean;
}

export type ReplyScope = { kind: "none" } | { kind: "one"; offer: ReplyOffer; quoted: boolean } | { kind: "several"; offers: ReplyOffer[] };

/** `offers`: his delivered offers in the window and the places he holds, newest first. */
export function replyScope(a: { offers: readonly ReplyOffer[]; inAClub: boolean; clubDmSinceOffer: boolean }): ReplyScope {
  const quoted = a.offers.find((o) => o.quoted);
  if (quoted) return { kind: "one", offer: quoted, quoted: true };
  const live = a.offers.filter((o) => o.state !== "ended");
  if (a.inAClub) {
    if (live.length !== 1 || a.clubDmSinceOffer) return { kind: "none" };
    return { kind: "one", offer: live[0], quoted: false };
  }
  if (live.length === 1) return { kind: "one", offer: live[0], quoted: false };
  if (live.length > 1) return { kind: "several", offers: [...live] };
  return a.offers[0] ? { kind: "one", offer: a.offers[0], quoted: false } : { kind: "none" };
}

export interface ReplyReading {
  intent: PoolReplyIntent;
  confidence: number;
}

export type ReplyAction =
  | { kind: "carry-on" }
  /** Today's (L5a) one line: "tap the link" (live) or "that place has gone" (ended). */
  | { kind: "fallback"; offerId: string }
  | { kind: "accept"; offerId: string }
  | { kind: "decline"; offerId: string }
  | { kind: "pull-out"; offerId: string }
  | { kind: "stop" }
  /** The offer's facts again, and the link: nothing invented. */
  | { kind: "facts"; offerId: string }
  | { kind: "reask"; offerId: string }
  | { kind: "which"; offerIds: string[] }
  | { kind: "profile-off"; offerId: string }
  /** Save his times and formats (`details-rules.ts` `applyDetails`). */
  | { kind: "details" }
  /** Ask once what times and formats he meant. */
  | { kind: "details-reask" };

/**
 * His times and formats (2026-11-04). A sure "details" from his own number
 * is saved whenever the DM was read at all: it was in scope, or it was read
 * against his offers (his words are plainly about the pool then). Unsure:
 * someone in no club is asked once more; a club member's DM carries on to
 * his club's handlers. Null: not a details reading, the offer rules decide.
 */
function detailsAction(a: {
  scope: ReplyScope;
  reading: ReplyReading;
  inAClub: boolean;
  proved: boolean;
  details?: { inScope: boolean; canSave: boolean };
}): ReplyAction | null {
  if (a.reading.intent !== "details") return null;
  const read = !!a.details?.inScope || a.scope.kind !== "none";
  const fallback: ReplyAction =
    a.scope.kind === "none" ? { kind: "carry-on" } : { kind: "fallback", offerId: a.scope.kind === "one" ? a.scope.offer.id : a.scope.offers[0].id };
  if (!read || !a.details?.canSave) return { kind: "carry-on" };
  if (a.reading.confidence >= POOL_REPLY_MIN_CONFIDENCE) return a.proved ? { kind: "details" } : fallback;
  return a.inAClub ? { kind: "carry-on" } : { kind: "details-reask" };
}

export function replyAction(a: {
  scope: ReplyScope;
  reading: ReplyReading;
  /** He is a live ordinary member of a club (guests not counted). */
  inAClub: boolean;
  /** The DM came from the number his profile (and the offer) is on. */
  proved: boolean;
  /** His pool profile is active (not paused, not stopped). */
  profileActive: boolean;
  /** His times and formats: may this DM be about them (`detailsInScope`),
   *  and may his profile be changed (active or paused). */
  details?: { inScope: boolean; canSave: boolean };
}): ReplyAction {
  const details = detailsAction(a);
  if (details) return details;
  const { scope, reading } = a;
  if (scope.kind === "none") return { kind: "carry-on" };
  const target = scope.kind === "one" ? scope.offer : scope.offers[0];
  const memberPlain = a.inAClub && !(scope.kind === "one" && scope.quoted);
  const isSure = reading.intent !== "neither" && reading.confidence >= POOL_REPLY_MIN_CONFIDENCE;
  const fallback: ReplyAction = { kind: "fallback", offerId: target.id };

  if (!isSure) {
    if (memberPlain) return { kind: "carry-on" };
    if (reading.intent === "neither") return fallback;
    if (scope.kind === "several") return { kind: "which", offerIds: scope.offers.map((o) => o.id) };
    return target.state === "ended" ? fallback : { kind: "reask", offerId: target.id };
  }

  if (reading.intent === "stop") return a.proved ? { kind: "stop" } : fallback;
  if (scope.kind === "several") return { kind: "which", offerIds: scope.offers.map((o) => o.id) };
  if (target.state === "ended") return fallback;

  const changes = reading.intent === "accept" || reading.intent === "decline";
  if (target.state === "taken") {
    if (reading.intent === "decline") return a.proved ? { kind: "pull-out", offerId: target.id } : fallback;
    return { kind: "facts", offerId: target.id };
  }
  // Open.
  if (changes && !a.proved) return fallback;
  if (reading.intent === "decline") return { kind: "decline", offerId: target.id };
  if (!a.profileActive) return { kind: "profile-off", offerId: target.id };
  return reading.intent === "accept" ? { kind: "accept", offerId: target.id } : { kind: "facts", offerId: target.id };
}
