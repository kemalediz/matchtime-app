/**
 * WHICH REPLY CARRIES THE BATCH'S SQUAD POST (review of #595, 2026-11-15;
 * found in #604, carried onto main 2026-11-18).
 *
 * When a batch changes the squad in a way worth a post, the analyze route
 * puts the `[SQUAD]` marker on one reply, and the squad composition then
 * renders the post into that reply from the database. The marker went on the
 * LAST reply that speaks, whatever it was. The composition does not render
 * every reply (`composesSquadPost`): the unified answer, stats answers, help,
 * the pitch set by words and every reply that is not the model's are left
 * alone. A marker on one of those was never rendered, and the last-line
 * strip removed it: "Ian Innes is in" beside "@Match Time who's on the
 * bench?" lost the squad post.
 *
 * Now the marker goes on the last speaking reply the composition renders,
 * else on the message that changed the squad. Still ONE send per message and
 * one squad post per batch; a reply the composition skips keeps its own
 * words.
 *
 * A BATCH WITH A TEAM POST HAS NO CARRIER (review of #628). Once the match
 * has teams the squad post the composition renders IS the team sheet, so a
 * batch that already sends a team post (the show-teams and make-teams
 * replies, the replacement and swap sheets) must not send a second sheet on
 * a reply after it. The team post stays the batch's only announcement.
 *
 * PURE: no database, no I/O. `route.ts` is the only caller.
 */
import { isTeamPostIntent, skipsSquadComposition } from "./group-copy";

/** The fields of a route result the choice reads. */
export interface CarrierResult {
  waMessageId: string;
  reply?: string | null;
  intent?: string | null;
  handledBy?: string | null;
}

/**
 * PURE. Does the squad composition render the squad post into this reply?
 * The composition's own filter, defined once for both places that need it:
 * a reply with words, the model's (or a pasted roster's ack, the one
 * fast-path reply that is a squad post), whose intent is not one the
 * composition skips (`skipsSquadComposition`), and not a deterministic team
 * post (`teamPostIds`: the replacement sheet, a swap's sheet).
 */
export function composesSquadPost(r: CarrierResult, teamPostIds: ReadonlySet<string>): boolean {
  if (!r.reply) return false;
  const pastedRosterAck = r.handledBy === "fast-path" && r.intent === "pasted_roster";
  if (r.handledBy !== "llm" && !pastedRosterAck) return false;
  if (skipsSquadComposition(r.intent)) return false;
  return !teamPostIds.has(r.waMessageId);
}

/** PURE. A reply that is a team post: by its intent, or by id. */
function isTeamPost(r: CarrierResult, teamPostIds: ReadonlySet<string>): boolean {
  return !!r.reply && (isTeamPostIntent(r.intent) || teamPostIds.has(r.waMessageId));
}

/**
 * PURE. The id of the result that carries the batch's squad post: the LAST
 * reply that already speaks, is not late, and is rendered by the
 * composition; with none, the message that changed the squad (`squadPostId`,
 * already moved off a late message by the caller). Null when that message
 * is not in the results, and null when any result is a team post.
 */
export function squadPostCarrierId(
  results: ReadonlyArray<CarrierResult>,
  opts: { squadPostId: string; late: ReadonlySet<string>; teamPostIds: ReadonlySet<string> },
): string | null {
  if (results.some((r) => isTeamPost(r, opts.teamPostIds))) return null;
  const eligible = results.filter((r) => !opts.late.has(r.waMessageId) && composesSquadPost(r, opts.teamPostIds));
  if (eligible.length > 0) return eligible[eligible.length - 1].waMessageId;
  return results.some((r) => r.waMessageId === opts.squadPostId) ? opts.squadPostId : null;
}
