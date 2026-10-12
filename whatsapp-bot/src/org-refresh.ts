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
 *     than minutes;
 *   - on the scheduler tick after the server's "club set version" changes
 *     (2026-10-13, further down): a club that went live, was suspended or
 *     paused, or an admin group linked, is acted on within one tick.
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
  /** Self-join slice 1: groups the bot must never forward or speak in.
   *  [] from an older server. Never contains a live org's group. */
  silentGroups: string[];
  /** false retires the "@MatchTime setup" trigger. true from an older server. */
  legacySetupTrigger: boolean;
  /**
   * Self-join slice 6: look, after a reconnect, for groups this account was
   * added to while offline. null (no sweep) from an older server, with
   * self-join off, or when no organiser is waiting for an add. `knownGroups`
   * are the groups the server already knows, never read; every live org's
   * group is added to them here too.
   */
  selfJoinSweep: { knownGroups: string[] } | null;
  /**
   * Slice 2a: each approved club's linked admin WhatsApp group. [] from an
   * older server. Never a live org's group, never silent, never onboarding.
   */
  adminGroups: Array<{ groupId: string; orgId: string }>;
}

/**
 * Is this a real `/api/whatsapp/orgs` answer? The server always sends an
 * `orgs` array (empty when there are none). A 200 without one (a proxy
 * page, an error object) is a FAILED refresh: the caller throws and the
 * Pi keeps its old list, rather than parsing it as "no clubs" and dropping
 * every live group (Sutton FC's included) from monitoring.
 */
export function isOrgsResponseBody(data: unknown): boolean {
  return !!data && typeof data === "object" && Array.isArray((data as { orgs?: unknown }).orgs);
}

/** Read the `/api/whatsapp/orgs` body defensively into a snapshot. */
export function parseOrgSnapshot(data: unknown): OrgSnapshot {
  const d = (data ?? {}) as {
    orgs?: Array<{ whatsappGroupId?: string | null; name?: string | null }>;
    onboardingGroups?: unknown;
    silentGroups?: unknown;
    legacySetupTrigger?: unknown;
    selfJoinSweep?: unknown;
    adminGroups?: unknown;
  };
  const orgConfigs: OrgConfig[] = (Array.isArray(d.orgs) ? d.orgs : [])
    .filter((o) => typeof o?.whatsappGroupId === "string" && o.whatsappGroupId.length > 0)
    .map((o) => ({ groupId: o.whatsappGroupId as string, orgName: String(o.name ?? "?") }));
  const known = new Set(orgConfigs.map((o) => o.groupId));
  // A live org is never silenced on the Pi, whatever the list says: the
  // failure to avoid is Sutton FC going quiet because of a stale row.
  // Slice 2a: admin groups. A live org's group is never one, whatever the
  // list says (the same protection as the silent list below).
  const adminSeen = new Set<string>();
  const adminGroups: OrgSnapshot["adminGroups"] = [];
  for (const a of Array.isArray(d.adminGroups) ? d.adminGroups : []) {
    const groupId = (a as { groupId?: unknown })?.groupId;
    const orgId = (a as { orgId?: unknown })?.orgId;
    if (typeof groupId !== "string" || !groupId.endsWith("@g.us") || typeof orgId !== "string" || !orgId) continue;
    if (known.has(groupId) || adminSeen.has(groupId)) continue;
    adminSeen.add(groupId);
    adminGroups.push({ groupId, orgId });
  }
  const silentGroups = [
    ...new Set(
      (Array.isArray(d.silentGroups) ? d.silentGroups : [])
        .filter((g): g is string => typeof g === "string" && g.length > 0)
        .filter((g) => !known.has(g) && !adminSeen.has(g)),
    ),
  ];
  const silent = new Set(silentGroups);
  const onboardingGroups = (Array.isArray(d.onboardingGroups) ? d.onboardingGroups : [])
    .filter((g): g is string => typeof g === "string" && g.length > 0)
    .filter((g) => !known.has(g) && !silent.has(g) && !adminSeen.has(g));
  let selfJoinSweep: OrgSnapshot["selfJoinSweep"] = null;
  if (d.selfJoinSweep && typeof d.selfJoinSweep === "object") {
    const listed = (d.selfJoinSweep as { knownGroups?: unknown }).knownGroups;
    const knownGroups = new Set<string>([...known, ...adminSeen]);
    for (const g of Array.isArray(listed) ? listed : []) {
      if (typeof g === "string" && g.length > 0) knownGroups.add(g);
    }
    selfJoinSweep = { knownGroups: [...knownGroups] };
  }
  return {
    orgConfigs,
    onboardingGroups: [...new Set(onboardingGroups)],
    silentGroups,
    legacySetupTrigger: d.legacySetupTrigger !== false,
    selfJoinSweep,
    adminGroups,
  };
}

export interface OrgSnapshotDiff {
  addedOrgs: OrgConfig[];
  removedOrgs: OrgConfig[];
  addedOnboarding: string[];
  removedOnboarding: string[];
  addedSilent: string[];
  removedSilent: string[];
  addedAdmin: string[];
  removedAdmin: string[];
  changed: boolean;
}

/** What changed between two snapshots, for the log line. */
export function diffOrgSnapshot(prev: OrgSnapshot | null, next: OrgSnapshot): OrgSnapshotDiff {
  const prevOrgs = new Map((prev?.orgConfigs ?? []).map((o) => [o.groupId, o]));
  const nextOrgs = new Map(next.orgConfigs.map((o) => [o.groupId, o]));
  const prevOnb = new Set(prev?.onboardingGroups ?? []);
  const nextOnb = new Set(next.onboardingGroups);
  const prevSilent = new Set(prev?.silentGroups ?? []);
  const nextSilent = new Set(next.silentGroups ?? []);
  const prevAdmin = new Set((prev?.adminGroups ?? []).map((a) => a.groupId));
  const nextAdmin = new Set((next.adminGroups ?? []).map((a) => a.groupId));
  const diff: OrgSnapshotDiff = {
    addedOrgs: [...nextOrgs.values()].filter((o) => !prevOrgs.has(o.groupId)),
    removedOrgs: [...prevOrgs.values()].filter((o) => !nextOrgs.has(o.groupId)),
    addedOnboarding: [...nextOnb].filter((g) => !prevOnb.has(g)),
    removedOnboarding: [...prevOnb].filter((g) => !nextOnb.has(g)),
    addedSilent: [...nextSilent].filter((g) => !prevSilent.has(g)),
    removedSilent: [...prevSilent].filter((g) => !nextSilent.has(g)),
    addedAdmin: [...nextAdmin].filter((g) => !prevAdmin.has(g)),
    removedAdmin: [...prevAdmin].filter((g) => !nextAdmin.has(g)),
    changed: false,
  };
  diff.changed =
    diff.addedOrgs.length +
      diff.removedOrgs.length +
      diff.addedOnboarding.length +
      diff.removedOnboarding.length +
      diff.addedSilent.length +
      diff.removedSilent.length +
      diff.addedAdmin.length +
      diff.removedAdmin.length >
    0;
  return diff;
}

export function describeOrgSnapshotDiff(diff: OrgSnapshotDiff): string {
  const parts: string[] = [];
  if (diff.addedOrgs.length) parts.push(`+org ${diff.addedOrgs.map((o) => `${o.orgName} (${o.groupId})`).join(", ")}`);
  if (diff.removedOrgs.length) parts.push(`-org ${diff.removedOrgs.map((o) => `${o.orgName} (${o.groupId})`).join(", ")}`);
  if (diff.addedOnboarding.length) parts.push(`+onboarding ${diff.addedOnboarding.join(", ")}`);
  if (diff.removedOnboarding.length) parts.push(`-onboarding ${diff.removedOnboarding.join(", ")}`);
  if (diff.addedSilent.length) parts.push(`+silent ${diff.addedSilent.join(", ")}`);
  if (diff.removedSilent.length) parts.push(`-silent ${diff.removedSilent.join(", ")}`);
  if (diff.addedAdmin.length) parts.push(`+admin-group ${diff.addedAdmin.join(", ")}`);
  if (diff.removedAdmin.length) parts.push(`-admin-group ${diff.removedAdmin.join(", ")}`);
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

// ── F2 (2026-10-05): one refresh before deciding a re-add ──────────────
//
// The monitored set is rebuilt only by a refresh, so a club deleted or
// unlinked on the server stays "a club" on the Pi for up to
// REFRESH_INTERVAL_MS, and a self-add to it used to stop at
// "already-monitored" without telling the server. The self-add path now
// asks for one refresh first (bot-added.ts, `recheckMonitoredGroup`),
// gated here so that repeated adds or a reconnect replaying many adds can
// never turn into a refresh storm:
//   - a group is re-checked at most once per STALE_RECHECK_GROUP_COOLDOWN_MS;
//   - at most STALE_RECHECK_MAX_PER_WINDOW re-checks start per
//     STALE_RECHECK_WINDOW_MS, whatever the groups;
//   - concurrent re-checks share one refresh;
//   - a re-check gives up after STALE_RECHECK_TIMEOUT_MS (fetch has no
//     timeout of its own), so a group join is never stuck behind it.
// A failed or timed-out refresh changes nothing: refreshOrgs (index.ts)
// throws before it touches any set, so the old list stands.

export const STALE_RECHECK_GROUP_COOLDOWN_MS = 60 * 1000;
export const STALE_RECHECK_WINDOW_MS = 60 * 1000;
export const STALE_RECHECK_MAX_PER_WINDOW = 3;
export const STALE_RECHECK_TIMEOUT_MS = 10 * 1000;

export type StaleRecheckOutcome = "refreshed" | "failed" | "timed-out" | "rate-limited" | "no-refresher";

const recheckedAt = new Map<string, number>();
let recheckStarts: number[] = [];
/** The one re-check refresh in flight, shared by concurrent re-adds. */
let recheckInFlight: Promise<"refreshed" | "failed"> | null = null;

/** Run the refresher once, reporting failure instead of swallowing it. */
function runRefreshReporting(reason: string): Promise<"refreshed" | "failed"> {
  // A refresh already in flight may have read /orgs BEFORE the delete
  // that makes this re-check necessary: wait it out, then start a fresh one.
  const before = inFlight ?? Promise.resolve();
  return before.then(async () => {
    if (!refresher) return "failed" as const;
    if (inFlight) {
      // Someone started another refresh after ours was requested: it is
      // fresh enough. Share it.
      await inFlight;
      return "refreshed" as const;
    }
    let failed = false;
    const fn = refresher;
    inFlight = fn(reason)
      .catch((err) => {
        failed = true;
        console.error(`[org-refresh] refresh (${reason}) failed:`, err instanceof Error ? err.message : err);
      })
      .finally(() => {
        inFlight = null;
      });
    await inFlight;
    return failed ? ("failed" as const) : ("refreshed" as const);
  });
}

/**
 * The Pi was just added to `groupId`, which it lists as a club: re-read
 * /orgs once, within the limits above, before the caller decides. Never
 * throws. The caller re-reads its own sets afterwards; this only reports
 * what happened, for the log.
 */
export async function requestStaleGroupRecheck(groupId: string, now: number = Date.now()): Promise<StaleRecheckOutcome> {
  if (!refresher) return "no-refresher";
  if (!recheckInFlight) {
    const last = recheckedAt.get(groupId);
    if (last !== undefined && now - last < STALE_RECHECK_GROUP_COOLDOWN_MS) return "rate-limited";
    recheckStarts = recheckStarts.filter((t) => now - t < STALE_RECHECK_WINDOW_MS);
    if (recheckStarts.length >= STALE_RECHECK_MAX_PER_WINDOW) return "rate-limited";
    recheckStarts.push(now);
    recheckedAt.set(groupId, now);
    for (const [g, t] of recheckedAt) if (now - t >= STALE_RECHECK_GROUP_COOLDOWN_MS) recheckedAt.delete(g);
    recheckInFlight = runRefreshReporting(`stale check: MatchTime re-added to listed club group ${groupId}`).finally(() => {
      recheckInFlight = null;
    });
  } else {
    recheckedAt.set(groupId, now);
  }
  const shared = recheckInFlight;
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timed-out">((resolve) => {
    t = setTimeout(() => resolve("timed-out"), STALE_RECHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([shared, timeout]);
  } finally {
    clearTimeout(t);
  }
}

// ── 2026-10-13: refresh when the server says the club set changed ──────
//
// The periodic refresh leaves a gap of up to REFRESH_INTERVAL_MS, and for
// a club that has just gone live the gap is the worst five minutes it
// could be: its organiser has been told "Done", its hello is not posted
// (the scheduler loops over the clubs of the last refresh), and every
// message in its group is DROPPED, not buffered (index.ts: not monitored,
// and still in the silent set). The same gap the other way round keeps
// the Pi acting for a club that has just been suspended or paused.
//
// So the server now stamps two responses with a "club set version", an
// opaque string that changes whenever the clubs the Pi should serve,
// monitor or silence change:
//   - /api/whatsapp/orgs: the stamp this snapshot was read at
//     (`noteSnapshotClubSetVersion`, called by index.ts after every
//     successful refresh, whatever asked for it);
//   - /api/whatsapp/platform-jobs, which the scheduler polls every tick
//     whatever the clubs' switches say: the stamp now
//     (`notePolledClubSetVersion`, called by api.ts).
// When the two differ the scheduler's tick calls `refreshIfClubSetChanged`
// before it loops over the clubs, so a club that went live is served, and
// one that was suspended is silent, on that very tick.
//
// NOTHING NEW RUNS while the stamp is unchanged: one string comparison.
//
// NO STORM, by three rules:
//   - one refresh per call, and the tick calls it once;
//   - a refresh that SUCCEEDED but still does not match the polled stamp
//     (two server instances that disagree, say) is not repeated for that
//     stamp: only a new stamp is a new change;
//   - a refresh still running from an earlier tick is waited on, never
//     started a second time.
// A FAILED refresh is simply tried again on the next tick.
//
// AN OLDER SERVER sends neither stamp: both are null and nothing here
// ever runs. The 5-minute timer below stays, as the backstop for that
// server and for anything a stamp cannot see.

/** How long a tick waits for this refresh before carrying on without it.
 *  `fetch` has no timeout of its own; the refresh keeps running. */
export const CLUB_SET_REFRESH_TIMEOUT_MS = 10 * 1000;

/** The stamp on the latest platform-jobs poll; null when it carried none. */
let polledClubSetVersion: string | null = null;
/** The stamp the snapshot in use was read at; null from an older server. */
let snapshotClubSetVersion: string | null = null;
/** A polled stamp a refresh has already succeeded for (see NO STORM). */
let refreshedForStamp: string | null = null;
let clubSetRefresh: Promise<"refreshed" | "failed"> | null = null;

/** The stamp in an /orgs or platform-jobs body, or null (an older server). */
export function parseClubSetVersion(data: unknown): string | null {
  const v = data && typeof data === "object" ? (data as { clubSetVersion?: unknown }).clubSetVersion : null;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** api.ts: the stamp on the platform-jobs poll that has just come back. */
export function notePolledClubSetVersion(v: unknown): void {
  polledClubSetVersion = typeof v === "string" && v.length > 0 ? v : null;
}

/** index.ts: a refresh has just succeeded; this is the stamp /orgs carried. */
export function noteSnapshotClubSetVersion(v: string | null): void {
  snapshotClubSetVersion = typeof v === "string" && v.length > 0 ? v : null;
}

export type ClubSetCheck =
  /** The poll or the snapshot has no stamp (an older server), or no refresher is wired. */
  | "no-stamp"
  | "unchanged"
  | "refreshed"
  | "failed"
  | "timed-out"
  /** A refresh already succeeded for this stamp and the snapshot still differs. */
  | "already-refreshed";

/**
 * Called once per scheduler tick, after the platform-jobs poll and before
 * the clubs. Refreshes the org picture when the server's stamp is not the
 * one this snapshot was read at. Never throws.
 */
export async function refreshIfClubSetChanged(): Promise<ClubSetCheck> {
  const polled = polledClubSetVersion;
  if (!polled || !snapshotClubSetVersion || !refresher) return "no-stamp";
  if (polled === snapshotClubSetVersion) {
    refreshedForStamp = null;
    return "unchanged";
  }
  if (refreshedForStamp === polled) return "already-refreshed";
  if (!clubSetRefresh) {
    console.log("[org-refresh] the server's club set changed since the last refresh; refreshing now");
    clubSetRefresh = runRefreshReporting("club set changed")
      .catch((err) => {
        console.error("[org-refresh] refresh (club set changed) failed:", err instanceof Error ? err.message : err);
        return "failed" as const;
      })
      .then((outcome) => {
        if (outcome === "refreshed") refreshedForStamp = polled;
        return outcome;
      })
      .finally(() => {
        clubSetRefresh = null;
      });
  }
  const running = clubSetRefresh;
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timed-out">((resolve) => {
    t = setTimeout(() => resolve("timed-out"), CLUB_SET_REFRESH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([running, timeout]);
  } finally {
    clearTimeout(t);
  }
}

// ── The catch-up for a group that has just become a club's ─────────────
//
// Between a go-live and the refresh that follows it the group's messages
// were dropped. The drivers keep what the line delivered (Baileys: a
// bounded per-chat buffer of every chat, `baileys/replay.ts`), so the
// existing restart catch-up (`recoverGroupMessages`, smart-analysis.ts)
// can read them back, and the server drops anything it has already
// analysed by its WhatsApp message id. Two limits, both from the club's
// go-live time as /orgs gives it (`liveAt`):
//   - NOTHING FROM BEFORE GO-LIVE is ever fed: until then the group was
//     deliberately not listened to (`sinceMs` is the floor);
//   - only a club that went live in the last CATCH_UP_MAX_AGE_MS. A club
//     back from a pause or a mute went live long ago and was silent on
//     purpose in between: nothing is re-read for it, as today.
// A group with no go-live time (an older server, a club that was never
// held) gets no catch-up, as today.

/** A go-live older than this is not "a moment ago": no catch-up. */
export const CATCH_UP_MAX_AGE_MS = 15 * 60 * 1000;

/** `liveAt` per club group in an /orgs body, as epoch milliseconds. */
export function parseLiveSince(data: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const orgs = data && typeof data === "object" ? (data as { orgs?: unknown }).orgs : null;
  for (const o of Array.isArray(orgs) ? orgs : []) {
    const groupId = (o as { whatsappGroupId?: unknown } | null)?.whatsappGroupId;
    const liveAt = (o as { liveAt?: unknown } | null)?.liveAt;
    if (typeof groupId !== "string" || !groupId || typeof liveAt !== "string") continue;
    const ms = Date.parse(liveAt);
    if (Number.isFinite(ms)) out.set(groupId, ms);
  }
  return out;
}

/** The groups NEW in this refresh whose missed messages are re-read, and from when. */
export function catchUpTargets(
  addedOrgs: OrgConfig[],
  liveSince: ReadonlyMap<string, number>,
  nowMs: number,
): Array<{ groupId: string; sinceMs: number }> {
  const out: Array<{ groupId: string; sinceMs: number }> = [];
  for (const o of addedOrgs) {
    const sinceMs = liveSince.get(o.groupId);
    if (sinceMs === undefined) continue;
    if (sinceMs > nowMs || nowMs - sinceMs > CATCH_UP_MAX_AGE_MS) continue;
    out.push({ groupId: o.groupId, sinceMs });
  }
  return out;
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
  recheckedAt.clear();
  recheckStarts = [];
  recheckInFlight = null;
  polledClubSetVersion = null;
  snapshotClubSetVersion = null;
  refreshedForStamp = null;
  clubSetRefresh = null;
}
