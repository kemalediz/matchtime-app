/**
 * ONE MESSAGE, SEVERAL INSTRUCTIONS (2026-11-16, Vets).
 *
 * "@Match Time switch to 7aside, take Luca to bench, @Zak is IN and then
 * make the teams." The router gave one route per message, so it chose
 * other_att: Luca was benched and Zak asked about, while the switch and the
 * teams were dropped and the organiser was never told. The match stayed at
 * 16 places and the team sheet said two were still needed.
 *
 * The MODEL says which instructions a message holds: the router's `route`
 * and its `also` list (`router.ts`). Nothing here reads a message's words.
 * This module settles, from those routes, what code needs:
 *
 *   WHO ANSWERS   always the router's `route`: `also` never changes it (the
 *                 prompt's question 1 already puts a place in `route`).
 *                 A `none` message is chat and has no other parts.
 *   THE OTHER     `also` without `none`, `unsure` (never instructions of
 *   PARTS         their own) or a second route of the owner's own kind.
 *   IN WHAT ORDER a YES to what MatchTime is waiting for first (a pasted
 *                 list is applied before anything is built on it), then
 *                 the format or size (places are counted against the new
 *                 size), then who plays, then the teams (built from the
 *                 squad as it now stands), then the rest. `ROUTE_RANK`.
 *
 * Every owner reads the WHOLE message with its own extractor, and each
 * extractor's prompt already defines only its own fields. The analyze
 * route and HQ do the parts in this order and join what they say into ONE
 * reply (`mergeOneReply`).
 */
import type { Route } from "./types";

/** The order the parts of one message are carried out in. */
export const ROUTE_RANK: Readonly<Record<Route, number>> = {
  approve: 0,
  admin_ops: 1,
  self_att: 2,
  other_att: 2,
  offer: 2,
  unsure: 2,
  balancer: 3,
  score: 4,
  ask_group: 5,
  question: 6,
  help: 6,
  team_sheet: 7,
  poster: 7,
  none: 99,
};

const ATTENDANCE: readonly Route[] = ["self_att", "other_att", "offer", "unsure"];

export function isAttendanceRoute(route: Route): boolean {
  return ATTENDANCE.includes(route);
}

/** Routes one owner handles count once: the four attendance routes are
 *  the attendance engine's, and help is answered where questions are. */
function ownerKey(route: Route): string {
  if (isAttendanceRoute(route)) return "attendance";
  if (route === "help") return "question";
  return route;
}

/**
 * PURE. The router's route and its `also` list, settled. `route` is always
 * exactly what the router said. `alsoRoutes` is the other parts in the order
 * they are done: no `none`, no `unsure`, nothing the owner already handles,
 * each once; `[]` for a `none` message and for one instruction.
 */
export function settleRoutes(primary: Route, also: readonly Route[]): { route: Route; alsoRoutes: Route[] } {
  if (primary === "none") return { route: primary, alsoRoutes: [] };
  const seen = new Set([ownerKey(primary)]);
  const rest: Route[] = [];
  for (const r of byRank(also)) {
    if (r === "none" || r === "unsure") continue;
    const key = ownerKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    rest.push(r);
  }
  return { route: primary, alsoRoutes: rest };
}

/** PURE. Stable sort by `ROUTE_RANK`. */
export function byRank(routes: readonly Route[]): Route[] {
  return routes
    .map((r, i) => ({ r, i }))
    .sort((a, b) => ROUTE_RANK[a.r] - ROUTE_RANK[b.r] || a.i - b.i)
    .map((x) => x.r);
}

/** PURE. Every route of a message, in the order its parts are done. */
export function orderedRoutes(r: { route: Route; alsoRoutes?: readonly Route[] }): Route[] {
  return byRank([r.route, ...(r.alsoRoutes ?? [])]);
}

/**
 * SEVERAL MESSAGES IN ONE BATCH (Sutton FC, 2026-11-17).
 *
 * 11:36 "@Match Time cancel the match due to low numbers". 12:48 and 12:50
 * two players wrote "In". 12:51 "@Match Time ... can you enable today's
 * match again?". All three arrived in ONE batch. The attendance engine
 * runs before the admin owner, so both INs were decided against the still
 * cancelled match and nothing was written; then the match was put back on.
 * The organiser added the two by hand.
 *
 * `ROUTE_RANK` already does a message's own parts in this order (the match
 * first, then who plays). This is the same order across the messages of a
 * batch: which admin messages are done BEFORE the attendance engine. The
 * admin action is the admin extractor's (a fact); which messages are
 * attendance claims is the router's route. Nothing here reads words.
 *
 *   THE RULE      A change to the match itself (`MATCH_CHANGE_ACTIONS`:
 *                 put back on, cancel, another size, the fewest and most
 *                 players) is done before the batch's
 *                 attendance claims, wherever it sits among them, UNTIL the
 *                 first cancel that comes after a claim. That cancel, and
 *                 everything after it, is done after the claims, as it
 *                 always was. Only a cancel that will be carried out counts
 *                 (an organiser's, with the real tag: the gate the cancel
 *                 itself applies); the players' "no game this week?" read
 *                 as a cancel holds nothing back.
 *
 *   SO            "In", "In", "back on": the match is back on first and
 *                 both INs count. The players were answering the
 *                 organiser's revival; an IN sent while it was off, in the
 *                 same batch as the restore, is an IN for the restored game.
 *                 "In", "cancel": the IN is recorded, then the cancel
 *                 applies to it as to every other row. "cancel", "In": the
 *                 IN meets a cancelled match, as it would in a later batch.
 *                 "switch to 7 aside", "In": the place is counted against
 *                 the new size (and the same with the switch after the IN:
 *                 the squad is counted once, against the size the organiser
 *                 set). "In", "cancel", "back on": cancelled THEN restored,
 *                 both after the IN, never in the reverse order.
 *
 *   NOT A GAME MOVE (review of #616). "Move Monday's game to Tuesday" is
 *                 left where it always was, after the claims: the INs land
 *                 on the game the players were answering, never on one
 *                 moved under them in the same batch.
 *
 * A batch with no attendance claim moves nothing: there is nothing to order
 * against, and it runs exactly as before.
 */
export const MATCH_CHANGE_ACTIONS: ReadonlySet<string> = new Set([
  "restore_match",
  "cancel_match",
  "switch_format",
  "player_numbers",
]);

export interface BatchPart {
  id: string;
  /** The router put this message on an attendance route (a claim). */
  claims: boolean;
  /** The admin extractor's action for this message, when it read one. */
  adminAction: string | null;
  /** The sender is an organiser and tagged MatchTime for real (the Pi's
   *  mention flag), so a cancel will be carried out. Absent: it will. */
  acts?: boolean;
}

/** PURE. The ids, in message order, of the match changes done before the
 *  batch's attendance claims. */
export function matchChangesFirst(batch: readonly BatchPart[]): Set<string> {
  const first = new Set<string>();
  if (!batch.some((p) => p.claims)) return first;
  let claimed = false;
  for (const p of batch) {
    if (p.adminAction === "cancel_match" && p.acts !== false && claimed) break;
    if (p.adminAction !== null && MATCH_CHANGE_ACTIONS.has(p.adminAction)) first.add(p.id);
    if (p.claims) claimed = true;
  }
  return first;
}
