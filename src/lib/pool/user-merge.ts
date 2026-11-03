/**
 * The pool's part of folding one User into another (2026-11-03).
 *
 * The user merge (`src/lib/user-merge-plan.ts`, `src/lib/user-merge.ts`)
 * must move every row that names a user, the pool's included. The pool's
 * tables are read and written only by the pool's own code (source guard:
 * src/lib/pool/__tests__/source-guard.test.ts), so the merge asks this
 * module for them: which pool columns name a user, the pool rows the
 * merge needs to see, and how those rows move.
 *
 * The rules (unchanged from the merge's own header):
 *   - PoolOffer and PoolBlock rows are re-keyed onto the target; where the
 *     target already has one for the same key, the target's is kept and
 *     the source's deleted.
 *   - PoolProfile is one per user: it moves when the target has none;
 *     when both have one, the target's is kept and the source's is
 *     stopped and stays on the deactivated source.
 *   - PoolConsentRecord is never touched (legal evidence, append-only):
 *     the merge lists it in UNTOUCHED_COLUMNS and its UserMerge row maps
 *     the old id.
 *
 * Pure apart from `loadPoolMergeRows`, which reads with the merge's own
 * transaction client and writes nothing.
 */
import type { RefColumn } from "../user-merge-plan";

type U = { id: string; userId: string };

/** The pool rows a merge plans over (a part of the merge's snapshot). */
export interface PoolMergeRows {
  poolProfiles: Array<U & { status: string }>;
  poolOffers: Array<U & { matchId: string }>;
  poolBlocks: Array<U & { orgId: string; by: string }>;
}

export const emptyPoolMergeRows = (): PoolMergeRows => ({ poolProfiles: [], poolOffers: [], poolBlocks: [] });

/** Pool columns with no unique key involving the user: every value naming
 *  the source is rewritten to the target (the merge's USER_REF_COLUMNS). */
export const POOL_USER_REF_COLUMNS: RefColumn[] = [
  { model: "PoolProfile", column: "referrerUserId", kind: "scalar" },
  { model: "PoolAsk", column: "approvedByUserId", kind: "scalar" },
  { model: "PoolAskRetry", column: "askedByUserId", kind: "scalar" },
  { model: "PoolBlock", column: "byUserId", kind: "scalar" },
  { model: "PoolReport", column: "userId", kind: "scalar" },
  { model: "PoolReport", column: "byUserId", kind: "scalar" },
  { model: "PoolReport", column: "reviewedBy", kind: "scalar" },
];

// Same loose typing as user-merge.ts: the transaction client's type
// changes shape under `$extends` (see src/lib/db.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

/** The merge's (key, user) reader: the source's rows plus the target's
 *  rows with the same keys. */
export type PairReader = (
  tx: Tx,
  delegate: string,
  S: string,
  T: string,
  keyField: string,
  select: Record<string, true>,
) => Promise<Array<Record<string, unknown>>>;

/** Reads the pool rows naming the source, and the target's rows a move
 *  could collide with. */
export async function loadPoolMergeRows(tx: Tx, S: string, T: string, pair: PairReader): Promise<PoolMergeRows> {
  const poolProfiles = await tx.poolProfile.findMany({ where: { userId: { in: [S, T] } }, select: { id: true, userId: true, status: true } });
  const poolOffers = (await pair(tx, "poolOffer", S, T, "matchId", {})) as PoolMergeRows["poolOffers"];
  const poolBlocks = (await pair(tx, "poolBlock", S, T, "orgId", { by: true })) as PoolMergeRows["poolBlocks"];
  return { poolProfiles, poolOffers, poolBlocks };
}

/** The planner's generic re-key (see `planUserMerge`). */
export type Rekey = <R extends { id: string }>(
  table: string,
  rows: R[],
  userCols: Array<keyof R & string>,
  keyOf: (r: R) => string,
  opts: { rule: string },
) => void;

/** PoolOffer and PoolBlock: re-keyed onto the target, the target's kept on a collision. */
export function planPoolRekeys(rows: PoolMergeRows, rekey: Rekey, keepTarget: string): void {
  rekey("poolOffer", rows.poolOffers, ["userId"], (r) => `${r.matchId}:${r.userId}`, { rule: keepTarget });
  rekey("poolBlock", rows.poolBlocks, ["userId"], (r) => `${r.orgId}:${r.userId}:${r.by}`, { rule: keepTarget });
}

/** PoolProfile: one per user. */
export function planPoolProfile(
  rows: PoolMergeRows,
  ids: { S: string; T: string; now: Date },
  ops: {
    upd: (table: string, id: string, set: Record<string, unknown>, why: string) => void;
    clash: (table: string, rowId: string, rule: string) => void;
  },
): void {
  const { S, T, now } = ids;
  const sp = rows.poolProfiles.find((x) => x.userId === S);
  const tp = rows.poolProfiles.find((x) => x.userId === T);
  if (sp && !tp) ops.upd("poolProfile", sp.id, { userId: T }, "moves to the target");
  if (sp && tp) {
    ops.clash("poolProfile", sp.id, "both have a pool profile: the target's is kept; the source's is stopped and stays on the deactivated source");
    if (sp.status !== "stopped") ops.upd("poolProfile", sp.id, { status: "stopped", stoppedAt: now }, "duplicate pool profile stopped");
  }
}
