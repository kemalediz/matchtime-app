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
 *
 * Two sets since 2026-09-17: the groups the bot listens to (live orgs
 * AND groups mid-setup) and, within those, the groups that are mid-setup.
 * The second set exists because a setup conversation cannot wait for
 * the 10-minute batch: a "YES" is flushed the moment it arrives
 * (smart-analysis.ts, `immediateFlushReason`). Both sets are rebuilt
 * from the server on every org refresh (index.ts), so a group that
 * completes setup moves from one to the other without a restart.
 */

let monitoredGroups = new Set<string>();
let onboardingGroups = new Set<string>();

/**
 * SILENT groups (self-join slice 1, 2026-09-29): groups the bot is in
 * but must never forward or speak in (a club waiting for approval,
 * rejected or suspended, or a group nobody asked MatchTime into). Read
 * from the server's `/orgs` on every refresh. A silent group is never
 * monitored, whatever tries to add it; the server refuses it too.
 */
let silentGroups = new Set<string>();
/** Server-controlled: false retires the "@MatchTime setup" trigger. An
 *  older server never sends it, which reads as true (today's behaviour). */
let legacySetupTrigger = true;

/** Replace the silent set. Call BEFORE setMonitoredGroups on a refresh. */
export function setSilentGroups(groupIds: string[]) {
  silentGroups = new Set(groupIds);
  for (const g of silentGroups) {
    monitoredGroups.delete(g);
    onboardingGroups.delete(g);
  }
}

export function isSilentGroup(groupId: string): boolean {
  return silentGroups.has(groupId);
}

export function setLegacySetupTrigger(on: boolean) {
  legacySetupTrigger = on;
}

export function isLegacySetupTriggerEnabled(): boolean {
  return legacySetupTrigger;
}

/** Replace the monitored set: the live orgs plus the groups mid-setup,
 *  never a silent group. */
export function setMonitoredGroups(groupIds: string[]) {
  monitoredGroups = new Set(groupIds.filter((g) => !silentGroups.has(g)));
}

export function isMonitoredGroup(groupId: string): boolean {
  return monitoredGroups.has(groupId) && !silentGroups.has(groupId);
}

/**
 * Dynamically start monitoring a group mid-run (no restart). Used when
 * an "@MatchTime setup" trigger lands in a group the bot isn't
 * monitoring yet, and when the bot has just been added to a group and
 * the server handed back an intro.
 */
export function addMonitoredGroup(groupId: string): void {
  if (silentGroups.has(groupId)) return;
  monitoredGroups.add(groupId);
}

/** Replace the mid-setup set (a subset of the monitored set). */
export function setOnboardingGroups(groupIds: string[]) {
  onboardingGroups = new Set(groupIds.filter((g) => !silentGroups.has(g)));
}

export function isOnboardingGroup(groupId: string): boolean {
  return onboardingGroups.has(groupId);
}

export function addOnboardingGroup(groupId: string): void {
  if (silentGroups.has(groupId)) return;
  onboardingGroups.add(groupId);
  monitoredGroups.add(groupId);
}

/** The setup finished (or was abandoned): stop the immediate flushes.
 *  The group stays monitored; the next org refresh decides whether it
 *  is a live org now. */
export function removeOnboardingGroup(groupId: string): void {
  onboardingGroups.delete(groupId);
}

/** Test-only: a copy of both sets. */
export function _test_groupSets(): { monitored: string[]; onboarding: string[] } {
  return { monitored: [...monitoredGroups], onboarding: [...onboardingGroups] };
}
