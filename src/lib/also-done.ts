/**
 * WHAT THE OTHER PARTS OF THE SAME MESSAGE DID, FOR THE UNIFIED ANSWER
 * (2026-11-18; review of #626).
 *
 * Sutton, 17 Nov 12:53: "@Match Time switch the match to 7aside and tell us
 * the current list" was switched, then its question part was answered "I
 * can't switch the match from this message": nothing had told it. Every
 * route that acted on the same message now feeds the answer, whether it
 * spoke with a reply, a reaction or the batch's squad post, in the players'
 * group and in HQ alike. A part that refused, or found nothing to do, is
 * told as ANSWERED, NOT DONE, never as done.
 *
 * Read from each outcome's own labels (its intent, action and write
 * failure), never from the words of the message. PURE.
 */

/** One other part of the message, as the unified answer is told it. */
export interface AlsoDonePart {
  /** What that part said, or a plain line for a silent change. */
  text: string;
  /** True: it did something. False: it answered without doing it. */
  done: boolean;
}

/** The fields every owner's outcome carries that this reads. */
export interface PartOutcome {
  reply: string | null;
  react: string | null;
  intent: string;
  action: string;
  writeFailed?: boolean;
  /** The teams owner wrote the line-ups (a team sheet goes with them). */
  teamsGenerated?: boolean;
}

export type PartSource = "attendance" | "admin" | "score" | "teams";

/** An outcome that answered without doing: a refusal, a request no path
 *  has, a change that could not be made. Our own labels, never words. */
const NOT_DONE = /refus|denied|organisers_only|only-organisers|request_not_handled|unsupported|not_understood|not-understood|not-here/;

const SILENT_DONE: Record<PartSource, string> = {
  attendance: "The change to who plays was recorded",
  admin: "The change to the game was made",
  score: "The score was recorded",
  teams: "The change to the teams was made",
};

/** PURE. One owner's outcome for the message, or null when it said and did
 *  nothing (or its write threw, which says nothing, §3.2 S7). */
export function alsoDonePart(source: PartSource, o: PartOutcome): AlsoDonePart | null {
  if (o.writeFailed) return null;
  const notDone = NOT_DONE.test(o.intent) || NOT_DONE.test(o.action);
  const reply = o.reply?.trim();
  if (reply) return { text: reply, done: !notDone };
  if (notDone) return null;
  if (o.teamsGenerated) return { text: "The teams were made.", done: true };
  if (o.react) return { text: `${SILENT_DONE[source]} (MatchTime reacted ${o.react} to THE MESSAGE).`, done: true };
  if (o.action && o.action !== "none") {
    return { text: `${SILENT_DONE[source]} (${source === "attendance" ? "the squad list shows it" : "nothing was said about it"}).`, done: true };
  }
  return null;
}

/** An HQ part's outcome that answered without doing (`Understood.outcome`). */
const HQ_NOT_DONE = /only|not-here|not-understood|not-on-list|refus|denied|failed|unchanged|nothing|unclear|ambiguous|dead-end/;

/** PURE. An HQ part's result for the message, or null when it said nothing. */
export function hqAlsoDonePart(u: { outcome: string; replyText: string | null }): AlsoDonePart | null {
  const text = u.replyText?.trim();
  if (!text) return null;
  return { text, done: !HQ_NOT_DONE.test(u.outcome) };
}
