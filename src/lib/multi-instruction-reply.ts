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
import { outcomeParts } from "./outcome-parts";

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
export function actionsNotDoneLine(words: ReadonlyArray<string | undefined>, lang?: string | null): string | null {
  if (words.length === 0) return null;
  const copy = multiInstructionCopy(lang);
  const names = [...new Set(words.map((w) => (w && w.trim() ? `"${w.trim()}"` : copy.part.other)))];
  return copy.notDone({ parts: copy.join(names), count: names.length });
}

/**
 * EVERY OUTCOME CODE AN ADMIN ACTION'S CORE RETURNS, classified once
 * (review of #629): "through" when the change is made, was already so, or
 * the ask was made; "held" for a question back, no game, a refusal or a
 * failure; "refused-right" for the organisers-only refusal, which changes
 * nothing and holds nothing back (each later action checks the same right
 * itself). `multi-instruction-reply-actions.test.ts` scans the cores for
 * their codes and fails on one missing here, so this cannot drift.
 */
export const ACTION_OUTCOMES: Readonly<Record<string, "through" | "held" | "refused-right">> = {
  // format-switch-words.ts, format-resize.ts
  "format-switched": "through", "format-switched-activity": "through", "format-unchanged": "through",
  "format-no-match": "held", "format-not-a-suggestion": "held", "format-open-squad": "held", "format-suggestion-stale": "held",
  "format-too-late": "held", "format-no-range": "held", "format-no-size": "held", "format-not-allowed": "held", "closed-format-switch": "held",
  // quiet-hours-words.ts
  "quiet-hours-on": "through", "quiet-hours-off": "through", "quiet-hours-unchanged": "through", "quiet-hours-refused": "held",
  // player-range-words.ts, open-squad-save.ts
  "player-range-set": "through", "player-range-cleared": "through", "player-range-unchanged": "through",
  "player-range-no-game": "held", "player-range-refused": "held", "player-range-which": "held",
  "open-squad-on": "through", "open-squad-off": "through", "open-squad-unchanged": "through",
  // season-break-words.ts
  "season-break-set": "through", "season-break-unchanged": "through", "season-break-refused": "held",
  // game-move-words.ts, and its "stayed" reasons
  "game-move-moved": "through", "game-move-weekly-moved": "through", "game-move-weekly-unchanged": "through", "game-move-stayed-unchanged": "through",
  "game-move-invalid": "held", "game-move-no-games": "held", "game-move-say-what": "held", "game-move-which": "held", "game-move-which-weekly": "held",
  "game-move-stayed-started": "held", "game-move-stayed-set-by-hand": "held", "game-move-stayed-into-the-past": "held",
  "game-move-stayed-other-month": "held", "game-move-stayed-unreadable-time": "held", "game-move-stayed-gone": "held",
  // venue-from-words.ts
  "venue-set": "through", "venue-no-name": "held", "venue-none": "held", "venue-unavailable": "held", "venue-which": "held",
  // month-coverage-words.ts
  "month-coverage-done": "through", "month-coverage-same": "through", "month-coverage-merged": "through",
  "month-coverage-asked": "held", "month-coverage-confirm": "held", "month-coverage-expired": "held", "month-coverage-failed": "held",
  "month-coverage-which": "held", "month-coverage-who": "held",
  // match-cancel.ts: the players' group's codes, and HQ's
  match_cancelled: "through", match_restored: "through", match_not_played: "through", match_played_restored: "through",
  match_cancel_none: "held", match_cancel_use_admin_group: "held", match_cancel_organisers_only: "refused-right",
  "match-cancelled": "through", "match-restored": "through", "match-not-played": "through", "match-played-restored": "through",
  // pool-ask-words.ts, partner-ask-words.ts, admin-group-ask-group.ts, named-invite.ts
  "hq-pool-asked": "through", "hq-pool-no-match": "held", "hq-pool-not-asked": "held",
  "xask-words-asked": "through", "xask-words-ambiguous": "held", "xask-words-no-game": "held", "xask-words-no-match": "held",
  "xask-words-no-partner": "held", "xask-words-not-asked": "held",
  "group-asked": "through", "group-ask-already": "through", "group-ask-full": "held", "group-ask-no-match": "held",
  "named-done": "through", "named-failed": "held", "named-full": "held", "named-no-match": "held", "named-nobody-tagged": "held",
  // The organisers-only line: the players' group's, and HQ's ("hq-only-organisers")
  organisers_only: "refused-right", "only-organisers": "refused-right",
};

/**
 * PURE. May the next admin action of the same message run, after one whose
 * outcome code is this (2026-11-23, live run: "switch to 5aside, then
 * invite the pool for the remaining slots" read no "a side", the switch
 * asked "How many a side?", and the pool was asked for the places at the
 * OLD size)? Only when this one went through, or was the organisers-only
 * refusal (`ACTION_OUTCOMES`), HQ's "hq-" prefix read through. A code
 * joined with "+" (several places asked) goes through when any part did.
 * An unknown code holds. The later actions not run are named as not done.
 */
export function letsNextActionRun(outcome: string): boolean {
  return outcomeParts(outcome).some((c) => {
    const kind = ACTION_OUTCOMES[c] ?? ACTION_OUTCOMES[c.replace(/^hq-/, "")];
    return kind === "through" || kind === "refused-right";
  });
}
