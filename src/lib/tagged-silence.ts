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
 */
import type { Route } from "./pipeline/types";

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
  /** The router's answer; `undefined` when it gave none. */
  route: Route | undefined;
  /** The message's one result, after every pass of the batch. */
  result: { reply: string | null; react: string | null; intent: string; handledBy: string };
}

export function taggedSilence(i: TaggedSilenceInput): boolean {
  if (!i.taggedExplicitly || !i.senderKnown) return false;
  if (i.late || i.capped || i.gated) return false;
  // Banter and thanks: the router said so, and silence is the answer.
  // No route at all is a router failure, which the operator note reports.
  if (i.route === undefined || i.route === "none") return false;
  const r = i.result;
  if (r.handledBy === "error") return false;
  if (r.reply || r.react) return false;
  return NOTHING_HAPPENED.includes(r.intent);
}
