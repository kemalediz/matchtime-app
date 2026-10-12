/**
 * BETWEEN A REFRESH OF THE CLUBS AND THE CATCH-UPS (2026-10-13; split out
 * of index.ts for the review of PR #250, so that it can be tested without
 * a socket).
 *
 * Three jobs, all driven by what /api/whatsapp/orgs has just returned:
 *
 *   1. THE SNAPSHOT'S STAMP. Every successful refresh notes the "club set
 *      version" its /orgs carried (`noteSnapshotClubSetVersion`), which the
 *      scheduler's tick compares with the stamp on its poll (org-refresh.ts).
 *
 *   2. A GROUP THAT HAS JUST BECOME A CLUB'S. Between a club's go-live and
 *      the refresh that follows, its group was still silent here and what
 *      was said in it was dropped. The drivers keep what the line delivered,
 *      so the restart catch-up (`recoverGroupMessages`) can read it back.
 *      The rules, each of which exists because the first version broke it:
 *        - THE FLOOR IS CAPTURED, NEVER LOOKED UP AGAIN. It is the club's
 *          go-live time from the /orgs that added the group, kept beside
 *          the group until the sweep runs. The sweep can wait a minute
 *          behind another one; a floor looked up then, from a newer
 *          snapshot the club had dropped out of, was "no floor", and two
 *          hours of the group were fed, the time before go-live included.
 *          `sweepSince` takes the floor as a required number: there is no
 *          way to call it without one;
 *        - STILL MONITORED, checked immediately before the sweep. A club
 *          suspended, paused or muted in the wait is not swept;
 *        - ONCE PER GO-LIVE, for the life of the process. A mute and an
 *          unmute inside fifteen minutes re-adds the group with the same
 *          go-live time; without this the stretch it was deliberately
 *          silent for would be fed;
 *        - IT WAITS, it is not dropped. One sweep runs at a time. A catch-up
 *          that meets another one stays on a small list and is tried again
 *          on every scheduler tick (`runPendingCatchUps`), until it runs or
 *          its go-live is more than CATCH_UP_MAX_AGE_MS old;
 *        - never at `ready` (the restart catch-up covers every club) and
 *          never in shadow mode.
 *
 *   3. THE RESTART CATCH-UP AT `ready`, with each club's go-live as its
 *      floor: no message from before a club went live is replayed (its
 *      group was deliberately not listened to until then). For clubs with
 *      no go-live time, which is every club on an older server and every
 *      club that was never held, the call is EXACTLY the one it always
 *      was: `recoverGroupMessages(driver, groupIds)`. Only monitored groups
 *      are ever handed to it.
 *
 * LOGS carry group ids, counts and reason codes. Never a club's name, a
 * message or a number.
 */
import type { WaDriver } from "./driver.js";
import {
  CATCH_UP_MAX_AGE_MS,
  catchUpTargets,
  parseClubSetVersion,
  parseLiveSince,
  type CatchUpTarget,
  type OrgConfig,
} from "./org-refresh.js";

/** Catch-ups waiting for a running sweep to finish. Far more than ever go live at once. */
export const MAX_PENDING_CATCH_UPS = 20;
/** Go-lives remembered as caught up, so a re-add does not repeat one. */
const MAX_REMEMBERED_GO_LIVES = 500;

/** The part of `recoverGroupMessages` this uses. */
export type RecoverFn = (
  driver: WaDriver,
  groupIds: string[],
  window?: undefined,
  opts?: { notBeforeMs?(groupId: string): number | null | undefined },
) => Promise<void>;

export interface ClubCatchUpWiring {
  driver: WaDriver;
  recoverGroupMessages: RecoverFn;
  isRecoverySweepRunning(): boolean;
  isMonitoredGroup(groupId: string): boolean;
  noteSnapshotClubSetVersion(version: string | null): void;
  now?(): number;
  log?(line: string): void;
  error?(line: string): void;
}

export interface ClubCatchUp {
  /** A refresh has just succeeded. `data` is the /orgs body it read. */
  onRefreshed(args: { reason: string; data: unknown; addedOrgs: OrgConfig[]; shadow?: boolean }): void;
  /** The restart catch-up, with each club's go-live as its floor. */
  readyCatchUp(groupIds: string[]): Promise<void>;
  /** Try every waiting catch-up once. Called on every scheduler tick. */
  runPending(): Promise<void>;
  /** What is waiting (oldest first). */
  pending(): ReadonlyArray<CatchUpTarget>;
}

export function wireClubCatchUp(w: ClubCatchUpWiring): ClubCatchUp {
  const now = w.now ?? (() => Date.now());
  const log = w.log ?? ((l: string) => console.log(l));
  const error = w.error ?? ((l: string) => console.error(l));

  /** `liveAt` per club group, from the latest /orgs. For the `ready` floor only. */
  let liveSince: Map<string, number> = new Map();
  let waiting: CatchUpTarget[] = [];
  /** "<group>|<go-live>" already queued or swept in this process. */
  const caughtUp = new Set<string>();
  let running: Promise<void> | null = null;

  /**
   * Sweep ONE group from its go-live on. The floor is a required number.
   * False: another sweep was running and nothing was read. The check and
   * the call are one synchronous step (`recoverGroupMessages` takes its
   * own guard before its first await), so no sweep can start in between.
   */
  async function sweepSince(groupId: string, sinceMs: number): Promise<boolean> {
    if (w.isRecoverySweepRunning()) return false;
    await w.recoverGroupMessages(w.driver, [groupId], undefined, { notBeforeMs: () => sinceMs });
    return true;
  }

  async function runPendingOnce(): Promise<void> {
    // A copy: the list may gain entries while a sweep is awaited.
    for (const target of [...waiting]) {
      const drop = () => {
        waiting = waiting.filter((t) => t !== target);
      };
      if (now() - target.sinceMs > CATCH_UP_MAX_AGE_MS) {
        drop();
        error(`[catch-up] ${target.groupId}: given up (expired): it could not run within ${CATCH_UP_MAX_AGE_MS / 60_000} minutes of the go-live`);
        continue;
      }
      if (!w.isMonitoredGroup(target.groupId)) {
        drop();
        log(`[catch-up] ${target.groupId}: skipped (not-monitored): no longer a served club's group`);
        continue;
      }
      try {
        if (await sweepSince(target.groupId, target.sinceMs)) {
          drop();
          log(`[catch-up] ${target.groupId}: ran, from its go-live on`);
        }
        // Else another sweep is running: it stays, for the next tick.
      } catch (err) {
        error(`[catch-up] ${target.groupId}: failed, will be tried again: ${err instanceof Error ? err.name : "error"}`);
      }
    }
  }

  function runPending(): Promise<void> {
    if (waiting.length === 0) return running ?? Promise.resolve();
    if (!running) {
      running = runPendingOnce().finally(() => {
        running = null;
      });
    }
    return running;
  }

  return {
    onRefreshed({ reason, data, addedOrgs, shadow }) {
      w.noteSnapshotClubSetVersion(parseClubSetVersion(data));
      liveSince = parseLiveSince(data);
      if (shadow || reason === "ready" || addedOrgs.length === 0) return;

      const { targets, skipped } = catchUpTargets(addedOrgs, liveSince, now());
      for (const s of skipped) log(`[catch-up] ${s.groupId}: newly monitored, no catch-up (${s.reason})`);
      let queued = 0;
      for (const t of targets) {
        const key = `${t.groupId}|${t.sinceMs}`;
        if (caughtUp.has(key)) {
          log(`[catch-up] ${t.groupId}: newly monitored, no catch-up (already-caught-up): this go-live was caught up once`);
          continue;
        }
        caughtUp.add(key);
        if (caughtUp.size > MAX_REMEMBERED_GO_LIVES) caughtUp.delete(caughtUp.values().next().value as string);
        waiting.push({ groupId: t.groupId, sinceMs: t.sinceMs });
        queued++;
      }
      while (waiting.length > MAX_PENDING_CATCH_UPS) {
        const dropped = waiting.shift() as CatchUpTarget;
        error(`[catch-up] ${dropped.groupId}: given up (too-many-waiting)`);
      }
      if (queued > 0) {
        log(`[catch-up] ${queued} group(s) newly live; catching up on what was said since go-live`);
        // At once, not on the next tick. Never throws.
        void runPending().catch(() => {});
      }
    },

    async readyCatchUp(groupIds) {
      const monitored = groupIds.filter((g) => w.isMonitoredGroup(g));
      if (monitored.length === 0) return;
      const floors = new Map<string, number>();
      for (const g of monitored) {
        const since = liveSince.get(g);
        if (since !== undefined) floors.set(g, since);
      }
      // No club with a go-live time: the call it always was.
      if (floors.size === 0) return w.recoverGroupMessages(w.driver, monitored);
      return w.recoverGroupMessages(w.driver, monitored, undefined, { notBeforeMs: (g) => floors.get(g) ?? null });
    },

    runPending,
    pending: () => waiting.map((t) => ({ ...t })),
  };
}

// ── The scheduler's hook ────────────────────────────────────────────────
// scheduler.ts calls `runPendingCatchUps` once per tick. It imports this
// module, not index.ts, so the instance index.ts builds is registered here.

let active: ClubCatchUp | null = null;

export function setActiveClubCatchUp(c: ClubCatchUp | null): void {
  active = c;
}

/** Try the waiting catch-ups. A no-op when none is wired or none waits. Never throws. */
export async function runPendingCatchUps(): Promise<void> {
  if (!active) return;
  try {
    await active.runPending();
  } catch (err) {
    console.error(`[catch-up] pending run failed: ${err instanceof Error ? err.name : "error"}`);
  }
}
