/**
 * THE FILL CYCLE'S CLAIM, HELD FOR ONE BATCH (review of #616, 2026-11-17).
 *
 * `<matchId>:squad-locked` is the claim `squad-announce.ts` takes when it
 * posts "Squad complete", and clears on a drop so each fill cycle is
 * announced once. A batch whose ONE reply carries the list (a message with
 * several parts, #613, or a size switched before the batch's INs) holds it
 * for the batch, so an IN that fills the squad does not ALSO queue "Squad
 * complete": a second list.
 *
 *   TAKE     always, even when the claim is already there (a squad announced
 *            at the old size): the batch now owns its settlement.
 *   SETTLE   once: kept only when the squad is full after the batch (the
 *            reply showed it), otherwise released so the next fill is
 *            announced; released when fullness cannot be read.
 *   ON THROW `withExitTasks` runs the settlement whatever happens, so a
 *            batch that throws half way never leaves the claim held, which
 *            would silence the next full squad.
 */

export interface SquadLockStore {
  hold(key: string, matchId: string): Promise<void>;
  release(key: string): Promise<void>;
  isFull(matchId: string): Promise<boolean>;
}

export const squadLockKeyOf = (matchId: string) => `${matchId}:squad-locked`;

export function squadLockHold(store: SquadLockStore) {
  let matchId: string | null = null;
  let settled = false;
  return {
    /** The match held, or null. */
    get matchId() {
      return matchId;
    },
    /** Holds the claim for `id`. True when it is held. */
    async take(id: string): Promise<boolean> {
      if (matchId) return true;
      try {
        await store.hold(squadLockKeyOf(id), id);
        matchId = id;
        return true;
      } catch (err) {
        console.error(`[squad-lock] claim for ${id} not taken:`, err instanceof Error ? err.message : "failed");
        return false;
      }
    },
    /** Kept only when the squad is full; released otherwise. Once. */
    settle: async (): Promise<void> => {
      if (!matchId || settled) return;
      settled = true;
      const key = squadLockKeyOf(matchId);
      try {
        if (!(await store.isFull(matchId))) await store.release(key);
      } catch (err) {
        console.error("[squad-lock] claim not settled, released:", err instanceof Error ? err.message : "failed");
        await store.release(key).catch(() => undefined);
      }
    },
  };
}

export type AtExit = (task: () => Promise<void>) => void;

/** Runs `fn`, then every task it registered, in order, whether `fn`
 *  returned or threw. A task that throws is logged and the rest still run;
 *  `fn`'s result or error is what the caller gets. */
export async function withExitTasks<T>(fn: (atExit: AtExit) => Promise<T>): Promise<T> {
  const tasks: Array<() => Promise<void>> = [];
  try {
    return await fn((task) => tasks.push(task));
  } finally {
    for (const task of tasks) {
      await task().catch((err) => console.error("[exit-task] failed:", err instanceof Error ? err.message : "failed"));
    }
  }
}
