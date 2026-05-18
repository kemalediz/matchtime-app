/**
 * Bot handlers are now ONLY a monitored-groups allow-list. All message
 * classification (IN / OUT / score / drop-with-excuse / conditional /
 * question / noise) runs through the LLM batch (smart-analysis.ts) on
 * a 10-minute cadence.
 *
 * The old regex fast-path lived here and reacted instantly to clear
 * IN/OUT/score messages. It was removed on 2026-04-21 — trading a few
 * minutes of latency for a single code path that handles nuance
 * correctly end-to-end. Kemal explicitly asked for this.
 */

let monitoredGroups = new Set<string>();

export function setMonitoredGroups(groupIds: string[]) {
  monitoredGroups = new Set(groupIds);
}

export function isMonitoredGroup(groupId: string): boolean {
  return monitoredGroups.has(groupId);
}

/**
 * Phase 2: dynamically start monitoring a group mid-run (no restart).
 * Used when an "@MatchTime setup" trigger lands in a group the bot
 * isn't monitoring yet — add it so the trigger + every subsequent
 * onboarding answer flows through the normal analyze path.
 */
export function addMonitoredGroup(groupId: string): void {
  monitoredGroups.add(groupId);
}
