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

/**
 * PURE. The one line naming the ACTIONS of a message that were not done,
 * when one message asked for several admin actions (Sutton FC, 2026-11-23:
 * "switch to 5aside, then invite local player pool for the remaining
 * slots"). Each is named in the sender's own words, as the admin extractor
 * reported them (`AdminFacts.words`), or as "the rest" when it gave none.
 * Null when every action was done. The players' group
 * (`admin-ops-engine-batch.ts`) and HQ (`admin-group-understand.ts`) say it
 * the same way, with the same copy as `notDoneLine`.
 */
/**
 * The outcome codes of the admin cores that mean the action WENT THROUGH:
 * the change is made, or was already so ("unchanged"), or the ask was
 * made. Without the "hq-" prefix HQ puts on some. Anything else (a
 * question back, "which game?", a refusal, no match) did not.
 */
const ACTION_DONE_CODES: ReadonlySet<string> = new Set([
  "format-switched", "format-switched-activity", "format-unchanged",
  "quiet-hours-on", "quiet-hours-off", "quiet-hours-unchanged",
  "player-range-set", "player-range-cleared", "player-range-unchanged",
  "season-break-set", "season-break-unchanged",
  "open-squad-on", "open-squad-off", "open-squad-unchanged",
  "game-move-moved", "game-move-weekly-moved", "game-move-weekly-unchanged",
  "venue-set",
  "match-cancelled", "match-restored", "match-not-played", "match-played-restored",
  "match_cancelled", "match_restored", "match_not_played", "match_played_restored",
  "pool-asked", "xask-words-asked", "group-asked", "named-done",
]);

/** The organisers-only refusal (players' group, HQ): nothing changed, and
 *  every later action checks the same right itself, so it holds none back. */
const ORGANISERS_ONLY_CODES: ReadonlySet<string> = new Set(["organisers_only", "only-organisers"]);

/**
 * PURE. May the next admin action of the same message run, after one whose
 * outcome code is this (2026-11-23, live run: "switch to 5aside, then
 * invite the pool for the remaining slots" read no "a side", the switch
 * asked "How many a side?", and the pool was asked for the places at the
 * OLD size)? Only when this one went through, or was the organisers-only
 * refusal. A code joined with "+" (several places asked) goes through when
 * any part did. The later actions that may not run are named as not done.
 */
export function letsNextActionRun(outcome: string): boolean {
  return outcome.split("+").some((c) => {
    const code = c.replace(/^hq-/, "");
    return ACTION_DONE_CODES.has(code) || ORGANISERS_ONLY_CODES.has(code);
  });
}

export function actionsNotDoneLine(words: ReadonlyArray<string | undefined>, lang?: string | null): string | null {
  if (words.length === 0) return null;
  const copy = multiInstructionCopy(lang);
  const names = [...new Set(words.map((w) => (w && w.trim() ? `"${w.trim()}"` : copy.part.other)))];
  return copy.notDone({ parts: copy.join(names), count: names.length });
}
