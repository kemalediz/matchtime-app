/**
 * The Pi's picture of which groups it serves, and how it stays current.
 *
 * Until 2026-09-17 the org list was read from the server ONCE, at
 * `ready`, and everything downstream (the monitored set, the scheduler's
 * org list, the flush timer's group list) was captured from that one
 * read. A group that became a live org later, which is exactly what a
 * self-setup does, was invisible until the next restart: its messages
 * were buffered (it was monitored) but never flushed (it was not in the
 * timer's list). The readiness review found a plain "YES" sitting in
 * the buffer forever.
 *
 * Now the snapshot is re-read from the server:
 *   - at `ready` (as before);
 *   - every REFRESH_INTERVAL_MS, as a backstop;
 *   - immediately when an analyze response says a setup COMPLETED, so the
 *     group's first "in" is handled as a live org's within seconds rather
 *     than minutes.
 *
 * Both designs were considered. "The server tells the Pi on each
 * response" is precise but only reaches a Pi that made the request, and
 * misses anything set up from a script or the dashboard. "Periodic
 * refresh" catches everything but is slow. Doing both costs one small
 * GET every few minutes and closes both gaps; the parse and diff are
 * pure and tested here, the wiring is in index.ts.
 */

export interface OrgConfig {
  groupId: string;
  orgName: string;
}

export interface OrgSnapshot {
  orgConfigs: OrgConfig[];
  onboardingGroups: string[];
}

/** Read the `/api/whatsapp/orgs` body defensively into a snapshot. */
export function parseOrgSnapshot(data: unknown): OrgSnapshot {
  const d = (data ?? {}) as {
    orgs?: Array<{ whatsappGroupId?: string | null; name?: string | null }>;
    onboardingGroups?: unknown;
  };
  const orgConfigs: OrgConfig[] = (Array.isArray(d.orgs) ? d.orgs : [])
    .filter((o) => typeof o?.whatsappGroupId === "string" && o.whatsappGroupId.length > 0)
    .map((o) => ({ groupId: o.whatsappGroupId as string, orgName: String(o.name ?? "?") }));
  const known = new Set(orgConfigs.map((o) => o.groupId));
  const onboardingGroups = (Array.isArray(d.onboardingGroups) ? d.onboardingGroups : [])
    .filter((g): g is string => typeof g === "string" && g.length > 0)
    .filter((g) => !known.has(g));
  return { orgConfigs, onboardingGroups: [...new Set(onboardingGroups)] };
}

export interface OrgSnapshotDiff {
  addedOrgs: OrgConfig[];
  removedOrgs: OrgConfig[];
  addedOnboarding: string[];
  removedOnboarding: string[];
  changed: boolean;
}

/** What changed between two snapshots, for the log line. */
export function diffOrgSnapshot(prev: OrgSnapshot | null, next: OrgSnapshot): OrgSnapshotDiff {
  const prevOrgs = new Map((prev?.orgConfigs ?? []).map((o) => [o.groupId, o]));
  const nextOrgs = new Map(next.orgConfigs.map((o) => [o.groupId, o]));
  const prevOnb = new Set(prev?.onboardingGroups ?? []);
  const nextOnb = new Set(next.onboardingGroups);
  const diff: OrgSnapshotDiff = {
    addedOrgs: [...nextOrgs.values()].filter((o) => !prevOrgs.has(o.groupId)),
    removedOrgs: [...prevOrgs.values()].filter((o) => !nextOrgs.has(o.groupId)),
    addedOnboarding: [...nextOnb].filter((g) => !prevOnb.has(g)),
    removedOnboarding: [...prevOnb].filter((g) => !nextOnb.has(g)),
    changed: false,
  };
  diff.changed =
    diff.addedOrgs.length + diff.removedOrgs.length + diff.addedOnboarding.length + diff.removedOnboarding.length > 0;
  return diff;
}

export function describeOrgSnapshotDiff(diff: OrgSnapshotDiff): string {
  const parts: string[] = [];
  if (diff.addedOrgs.length) parts.push(`+org ${diff.addedOrgs.map((o) => `${o.orgName} (${o.groupId})`).join(", ")}`);
  if (diff.removedOrgs.length) parts.push(`-org ${diff.removedOrgs.map((o) => `${o.orgName} (${o.groupId})`).join(", ")}`);
  if (diff.addedOnboarding.length) parts.push(`+onboarding ${diff.addedOnboarding.join(", ")}`);
  if (diff.removedOnboarding.length) parts.push(`-onboarding ${diff.removedOnboarding.join(", ")}`);
  return parts.length ? parts.join("; ") : "no change";
}

// ── The refresher hook ──────────────────────────────────────────────────
// index.ts owns the network call and the side effects; this module only
// makes sure two refreshes never interleave and that anyone (the flush
// path, a timer) can ask for one without importing index.ts.

export const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

let refresher: ((reason: string) => Promise<void>) | null = null;
let inFlight: Promise<void> | null = null;
let timer: NodeJS.Timeout | null = null;

export function setOrgRefresher(fn: ((reason: string) => Promise<void>) | null): void {
  refresher = fn;
}

/** Ask for a refresh. Concurrent callers share the one in flight. Never throws. */
export function requestOrgRefresh(reason: string): Promise<void> {
  if (!refresher) return Promise.resolve();
  if (inFlight) return inFlight;
  const fn = refresher;
  inFlight = fn(reason)
    .catch((err) => {
      console.error(`[org-refresh] refresh (${reason}) failed:`, err instanceof Error ? err.message : err);
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** One interval, ever (a repeat `ready` must not double it). */
export function startOrgRefreshTimer(intervalMs: number = REFRESH_INTERVAL_MS): void {
  if (timer) return;
  timer = setInterval(() => {
    void requestOrgRefresh("periodic");
  }, intervalMs);
}

export function stopOrgRefreshTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Test-only. */
export function _test_resetOrgRefresh(): void {
  stopOrgRefreshTimer();
  refresher = null;
  inFlight = null;
}
