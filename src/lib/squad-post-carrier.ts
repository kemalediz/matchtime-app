/**
 * WHICH REPLY CARRIES THE BATCH'S SQUAD POST (2026-11-16, PR #604).
 *
 * When a batch changes the squad in a way worth a post, the analyze route
 * puts the `[SQUAD]` marker on one reply, and the squad composition then
 * renders the post into that reply from the database. The marker went on the
 * LAST reply that speaks, whatever it was. The composition does not render
 * every reply (`composesSquadPost`): the unified and open answers, stats
 * answers, help, team posts, the pitch set by words and every reply that is
 * not the model's are left alone. A marker on one of those was never
 * rendered, and the last-line strip removed it: "Ian Innes is in" beside
 * "@Match Time who's on the bench?" (UNIFIED_ANSWERS on) lost the squad post.
 *
 * Now the marker goes on the last speaking reply the composition renders,
 * else on the message that changed the squad. Still ONE send per message and
 * one squad post per batch; a reply it skips keeps its own words.
 *
 * NEVER THE TEAM SHEET TWICE (review of #604, 2026-11-16). Once the match
 * has teams, the squad post the composition renders IS the team sheet. So a
 * batch whose replies already post a team sheet (making or showing the
 * teams, a swap's or a replacement's sheet, the team half of an attendance
 * message appended after the composition) has NO carrier: that sheet is the
 * batch's squad post. And a reply the composition renders into the same
 * sheet keeps only its own words (`withoutRepeatedTeamSheet`).
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
 * post (`teamPostIds`: the 2026-09-15 replacement sheet).
 */
export function composesSquadPost(r: CarrierResult, teamPostIds: ReadonlySet<string>): boolean {
  if (!r.reply) return false;
  const pastedRosterAck = r.handledBy === "fast-path" && r.intent === "pasted_roster";
  if (r.handledBy !== "llm" && !pastedRosterAck) return false;
  if (skipsSquadComposition(r.intent)) return false;
  return !teamPostIds.has(r.waMessageId);
}

/**
 * PURE. Does this reply post a team sheet? Making or showing the teams with
 * words (showing them when none are made says nothing, and posts none), or
 * a deterministic team post (`teamPostIds`: a swap's sheet, the 2026-09-15
 * replacement sheet).
 */
export function postsTeamSheet(r: CarrierResult, teamPostIds: ReadonlySet<string>): boolean {
  if (!r.reply) return false;
  return isTeamPostIntent(r.intent) || teamPostIds.has(r.waMessageId);
}

/**
 * PURE. The id of the result that carries the batch's squad post: the LAST
 * reply that already speaks, is not late and is rendered by the composition;
 * with none, the message that changed the squad (`squadPostId`, already
 * moved off a late message by the caller). Null when that message is not in
 * the results, and null when the batch already posts a team sheet
 * (`postsTeamSheet`, or `appendedSheetIds`: a team sheet the route adds to a
 * reply after the composition).
 */
export function squadPostCarrierId(
  results: ReadonlyArray<CarrierResult>,
  opts: { squadPostId: string; late: ReadonlySet<string>; teamPostIds: ReadonlySet<string>; appendedSheetIds: ReadonlySet<string> },
): string | null {
  if (opts.appendedSheetIds.size > 0 || results.some((r) => postsTeamSheet(r, opts.teamPostIds))) return null;
  const speaks = results.filter((r) => !opts.late.has(r.waMessageId) && composesSquadPost(r, opts.teamPostIds));
  if (speaks.length > 0) return speaks[speaks.length - 1].waMessageId;
  return results.some((r) => r.waMessageId === opts.squadPostId) ? opts.squadPostId : null;
}

/**
 * PURE. A reply the composition rendered into `sheet`, the team sheet, in a
 * batch that already posts that sheet: the reply's own words without it, or
 * null when it was only the sheet. Anything else is unchanged.
 */
export function withoutRepeatedTeamSheet(text: string, sheet: string): string | null {
  if (text === sheet) return null;
  if (text.endsWith(`\n\n${sheet}`)) return text.slice(0, -(sheet.length + 2)).trim() || null;
  return text;
}
