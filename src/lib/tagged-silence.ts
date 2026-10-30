/**
 * A MESSAGE TAGGED TO MATCHTIME IS NEVER MET WITH SILENCE (2026-10-29).
 *
 * MT Test: the owner tagged "@Match Time invite players from pool" three
 * times. Twice the router chose `offer`, the attendance extractor came away
 * with a bare "chase", the engine called it a nudge and MatchTime said
 * nothing at all. HQ has had its "I didn't catch that" line since
 * 2026-10-16 (`hq_not_understood`); the players' group had no twin.
 *
 * The rule reads the OUTCOME the batch ended with, never the words: a
 * known member tagged MatchTime explicitly and the message's one result
 * carries no reply, no reaction, and an intent that says nothing was
 * written or queued. The handled-silently cases stay silent by
 * construction: a tick is a reaction, applied attendance has an intent of
 * its own, banter and thanks are the router's `none`.
 *
 * 2026-10-30: three more silences are not "nothing came of it", found by
 * stubbed e2e specs that went red with #455: a player's admin-only ask
 * refused on purpose (clause-peel, stats-blast), a read lost to an API
 * error (attendance-engine-overload), and a squad question the batch's one
 * squad post answered (squad-post). Each is reported by its owner as a
 * typed fact (`SilenceFacts`).
 */
import type { Route } from "./pipeline/types";

/**
 * What the owners report about the silences they chose (2026-10-30), so
 * the rule below reads facts rather than reasons written for humans. Each
 * owner adds a message id; the analyze route reads them. Ids only: an
 * owner records what it decided, never anything about the words.
 *
 *   refused           an admin-only ask from a player (`engine.ts`
 *                     `MessageOutcome.refused`);
 *   readFailed        the model read of the message failed;
 *   squadPostAnswers  a squad question (count, squad, bench, a player's
 *                     place) held back because a neighbour changed the
 *                     squad; the batch's squad post answers it, when one
 *                     goes out.
 */
export interface SilenceFacts {
  refused: Set<string>;
  readFailed: Set<string>;
  squadPostAnswers: Set<string>;
}

export function newSilenceFacts(): SilenceFacts {
  return { refused: new Set(), readFailed: new Set(), squadPostAnswers: new Set() };
}

/** The intents a result carries when nothing was written, queued or said. */
const NOTHING_HAPPENED: readonly string[] = ["noise", "unclear"];

export interface TaggedSilenceInput {
  /** The STRICT tag (an @ of MatchTime), never a swipe-reply. */
  taggedExplicitly: boolean;
  /** The sender resolved to a member of the club. */
  senderKnown: boolean;
  /** Late messages are silent on purpose (they are recorded only). */
  late: boolean;
  /** At the daily AI cap the club has had its one polite line. */
  capped: boolean;
  /** Skipped by the gate on purpose (a feature switched off). */
  gated: boolean;
  /** An owner REFUSED it on permission: an admin-only ask from a player.
   *  That silence is designed (`engine.ts`), and "I didn't catch that"
   *  would be false: it was caught, and refused. */
  refused: boolean;
  /** The model read of it failed (an API error after the retries). A
   *  system failure, on the operator note, exactly like a write that
   *  threw (`handledBy: "error"`); the group is not told it was unclear. */
  readFailed: boolean;
  /** A squad question held back because a neighbour in the batch changed
   *  the squad, and the batch's squad post, which answers it, went out. */
  answeredBySquadPost: boolean;
  /** The router's answer; `undefined` when it gave none. */
  route: Route | undefined;
  /** The message's one result, after every pass of the batch. */
  result: { reply: string | null; react: string | null; intent: string; handledBy: string };
}

export function taggedSilence(i: TaggedSilenceInput): boolean {
  if (!i.taggedExplicitly || !i.senderKnown) return false;
  if (i.late || i.capped || i.gated) return false;
  if (i.refused || i.readFailed || i.answeredBySquadPost) return false;
  // Banter and thanks: the router said so, and silence is the answer.
  // No route at all is a router failure, which the operator note reports.
  if (i.route === undefined || i.route === "none") return false;
  const r = i.result;
  if (r.handledBy === "error") return false;
  if (r.reply || r.react) return false;
  return NOTHING_HAPPENED.includes(r.intent);
}
