/**
 * ONE SUMMARY PER CLUB FOR ONE REQUEST OR ONE SCHEDULER POLL (slice A0, plan
 * section 3.4). Created at the top of each entry point and passed down;
 * dropped with the request. There is NO module-level cache: Vercel reuses a
 * warm module across requests and the Pi polls every 30 seconds, so a cache
 * that outlived one request would serve yesterday's squad.
 *
 * After a write the summary is stale and says so: a request that writes
 * attendance and then needs the new count calls `refresh(orgId)`.
 *
 * Takes the loader as an argument, so this module imports no database
 * client (pass `loadClubSummary` from load.ts).
 */
import type { ClubSummary } from "./types";

export type SummaryLoader = (orgId: string, now: Date, opts?: { members?: boolean }) => Promise<ClubSummary | null>;

export interface SummaryScope {
  /** The scope's clock: every summary in it is as of this instant. */
  readonly now: Date;
  /** The club's summary, loaded at most once per scope (once more if
   *  members are asked for after a summary without them). */
  get(orgId: string, opts?: { members?: boolean }): Promise<ClubSummary | null>;
  /** Forget the club's summary: the next `get` reads it again. */
  refresh(orgId: string): void;
}

export function summaryScope(now: Date, loader: SummaryLoader): SummaryScope {
  // By club: the summary without members, and the one with them.
  const bare = new Map<string, Promise<ClubSummary | null>>();
  const full = new Map<string, Promise<ClubSummary | null>>();

  const remember = (map: Map<string, Promise<ClubSummary | null>>, orgId: string, p: Promise<ClubSummary | null>) => {
    map.set(orgId, p);
    // A failed read is not kept: the next `get` tries again.
    p.catch(() => {
      if (map.get(orgId) === p) map.delete(orgId);
    });
    return p;
  };

  return {
    now,
    get(orgId, opts = {}) {
      const withMembers = full.get(orgId);
      if (withMembers) return withMembers;
      if (opts.members) return remember(full, orgId, loader(orgId, now, { members: true }));
      return bare.get(orgId) ?? remember(bare, orgId, loader(orgId, now, { members: false }));
    },
    refresh(orgId) {
      bare.delete(orgId);
      full.delete(orgId);
    },
  };
}
