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
 * batch that really sends a team sheet has NO carrier: that sheet is the
 * batch's squad post. And a reply the composition renders into the same
 * sheet keeps only its own words (`withoutRepeatedTeamSheet`).
 *
 * WHAT "REALLY SENDS A SHEET" MEANS (review round 2). Decided from what a
 * reply RENDERS, flagged where the sheet is rendered and handed in as
 * `sheets`, never from its intent: the team intents also carry "No teams
 * generated yet", "I'll build the teams on match day" and "Can't build teams
 * right now", which hold no sheet and must not stop the squad post.
 *   "read"   the teams shown as they stand (the show-teams answer);
 *   "write"  a sheet a team write in this batch rendered: the teams made,
 *            a swap's sheet, a replacement's, or the team half of an
 *            attendance message, appended after the composition.
 * A "read" sheet beside a "write" one was rendered before the write and is
 * stale, and of two written sheets (regenerate + swap, replacement + swap)
 * the earlier is stale too: only the LAST written sheet, which shows the
 * batch's final teams, goes out (`staleSheetIds`, review round 3).
 *
 * PURE: no database, no I/O. `route.ts` is the only caller.
 */
import { skipsSquadComposition } from "./group-copy";

/** A team sheet a reply really renders: as the teams stand ("read"), or as
 *  a team write in this batch left them ("write"), with `seq` the order the
 *  written sheets were rendered in (a replacement's first, then the team
 *  path's in its own order, `TeamOpsMessageOutcome.sheetSeq`). */
export type Sheet = { kind: "read" } | { kind: "write"; seq: number };

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
 * PURE. The sheets that are stale: with any written sheet in the batch,
 * every shown one and every written one but the last rendered (the highest
 * `seq`; on a tie, the later in the batch). Those replies are not sent; the
 * one sheet left answers them.
 */
export function staleSheetIds(sheets: ReadonlyMap<string, Sheet>): string[] {
  let last: string | null = null;
  let lastSeq = Number.NEGATIVE_INFINITY;
  for (const [id, sh] of sheets) {
    if (sh.kind === "write" && sh.seq >= lastSeq) {
      last = id;
      lastSeq = sh.seq;
    }
  }
  if (last === null) return [];
  return [...sheets.keys()].filter((id) => id !== last);
}

/**
 * PURE. The id of the result that carries the batch's squad post: the LAST
 * reply that already speaks, is not late and is rendered by the composition;
 * with none, the message that changed the squad (`squadPostId`, already
 * moved off a late message by the caller). Null when that message is not in
 * the results, and null when the batch really sends a team sheet (`sheets`,
 * by message id).
 */
export function squadPostCarrierId(
  results: ReadonlyArray<CarrierResult>,
  opts: { squadPostId: string; late: ReadonlySet<string>; teamPostIds: ReadonlySet<string>; sheets: ReadonlyMap<string, Sheet> },
): string | null {
  if (opts.sheets.size > 0) return null;
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
