/**
 * ONE REPLY FOR A MESSAGE WITH SEVERAL INSTRUCTIONS (2026-11-16, Vets).
 *
 * Each owner the router listed (`RoutedMessage.alsoRoutes`) does its part
 * and says what it says; the analyze route and HQ join those lines into the
 * message's ONE reply (`mergeOneReply`), in the order the parts were done
 * (`multi-route.ts`). A part that produced nothing at all (its extractor
 * failed, or read nothing it could act on) is named in one plain line, so
 * an organiser is never left believing it was done. A part that was refused
 * says so itself ("only an organiser can do that", "the teams are made on
 * match day"), and is not named again.
 *
 * Only for a message that really tagged MatchTime: an untagged message is
 * never told what MatchTime did not do (the interaction contract).
 */
import type { Route } from "./pipeline/types";
import { isAttendanceRoute } from "./pipeline/multi-route";
import { multiInstructionCopy, type InstructionPart } from "./i18n/multi-instruction";
import { t } from "./i18n/t";

/**
 * PURE. The bench, as the squad post numbers it, for a message whose squad
 * part changed who plays and whose teams part then made the teams. The team
 * sheet is that message's post (one list, not two), and it shows the two
 * teams only: without this, "take Luca to bench" would be done and never
 * said. Null for an empty bench.
 */
export function benchBlock(names: readonly string[], lang?: string | null): string | null {
  if (names.length === 0) return null;
  return [t(lang).bench_header({ count: names.length }), ...names.map((n, i) => `${i + 1}. ${n}`)].join("\n");
}

/** PURE. How the group would name the part of a message a route handles. */
export function partOf(route: Route): InstructionPart {
  if (route === "admin_ops") return "settings";
  if (isAttendanceRoute(route)) return "squad";
  if (route === "balancer" || route === "team_sheet") return "teams";
  if (route === "question" || route === "help") return "question";
  if (route === "score") return "result";
  return "other";
}

/** PURE. The also routes of a message that no owner reported anything for. */
export function partsNotDone(alsoRoutes: readonly Route[], done: ReadonlySet<Route>): Route[] {
  return alsoRoutes.filter((r) => !done.has(r));
}

/** PURE. The one line naming the parts not done, or null when every part was. */
export function notDoneLine(parts: readonly Route[], lang?: string | null): string | null {
  if (parts.length === 0) return null;
  const copy = multiInstructionCopy(lang);
  const names = [...new Set(parts.map((r) => copy.part[partOf(r)]))];
  return copy.notDone({ parts: copy.join(names), count: names.length });
}
