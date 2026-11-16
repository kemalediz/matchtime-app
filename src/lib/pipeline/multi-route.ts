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
