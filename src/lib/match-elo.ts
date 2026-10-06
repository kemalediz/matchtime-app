/**
 * A MATCH'S SCORE AND THE ELO IT IMPLIES: THE ONE WRITER (2026-10-07).
 *
 * Until now four call sites each wrote a score and then added that
 * result's Elo points to the club's memberships: the bot
 * (`owner-deps.ts`), the dashboard (`actions/matches.ts`), the legacy
 * `/api/whatsapp/score` route and the auto-completion cron. None of them
 * knew whether points had already been added for the match, so:
 *
 *   - editing a score on the dashboard added the NEW result's points on
 *     top of the OLD result's (a win corrected to a loss left the side
 *     with one win's worth of points it should never have had);
 *   - saving the SAME score twice added its points twice;
 *   - and there was no way to undo either, because the points written
 *     were not stored anywhere.
 *
 * Sutton FC, 6 October 2026: "9-6 to yellows" was recorded Red 9,
 * Yellow 6, and putting it right needed a one-off script that worked the
 * points out backwards (`scripts/fix-score-2026-10-06.ts`).
 *
 * ── THE DESIGN ───────────────────────────────────────────────────────
 *
 * `Match.eloApplied` records what the Elo pass did for the match:
 *
 *     { red, yellow, deltas: [{ userId, delta }] | null }
 *
 * `red` / `yellow` are the score the club's ratings currently REFLECT
 * for this match; `deltas` are the points actually written. With that,
 * the Elo is a pure consequence of the score that can be re-derived at
 * any time:
 *
 *   `setMatchScore`     writes the score (the fact).
 *   `reconcileMatchElo` makes the ratings agree with whatever score the
 *                       match now has: take back the stored points, add
 *                       the new result's, store those. Run twice, the
 *                       second run finds the stored score equal to the
 *                       match's and does nothing. That is the whole of
 *                       "exactly once".
 *
 * Two functions and two transactions ON PURPOSE. `score-engine.ts`
 * explains why: a score is a fact the group reported and the Elo is
 * derived from it, so an Elo failure must never roll the score back.
 * Because reconcile works from the stored state and not from anything
 * its caller remembers, a failed reconcile is repaired by the next one.
 *
 * ── MATCHES SCORED BEFORE THE COLUMN EXISTED ─────────────────────────
 *
 * Their `eloApplied` is NULL although points were added. The two cannot
 * be told apart by looking, so `setMatchScore` settles it at the only
 * moment it is knowable: when it overwrites a score on a match with no
 * record, it stamps `{ red: old, yellow: old, deltas: null }` in the
 * same update. "The ratings reflect the old score; what was written is
 * unknown."
 *
 * `reconcileMatchElo` then tries to recover the points with
 * `invertEloDeltas`, and ONLY when no later match of the club has been
 * scored (after one, the ratings have moved again and the answer would
 * be wrong). If it cannot, it LEAVES THE RATINGS ALONE, keeps the stamp
 * and reports `legacy_left`. Stale by one result is recoverable by a
 * person; a second result stacked on the first is the bug this file
 * exists to remove. The inversion can offer two neighbouring answers one
 * point apart (the forward pass rounds); the first is taken and the
 * result says so.
 *
 * Every match scored from now on has its points stored, so none of this
 * paragraph applies to it.
 */
import { db as defaultDb } from "./db";
import { computeEloDeltas, invertEloDeltas } from "./elo";
import { loadMembershipEloInputs } from "./membership-elo";

type Db = typeof defaultDb;
// The interactive-transaction client. Structural, so a unit test can
// hand in a fake.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

export interface EloApplied {
  red: number;
  yellow: number;
  /** null: scored before the column existed, points unknown. */
  deltas: Array<{ userId: string; delta: number }> | null;
}

/** Read the column defensively: it is JSON, so its shape is a promise
 *  and not a guarantee. Anything unreadable is treated as absent. */
export function parseEloApplied(raw: unknown): EloApplied | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Number.isInteger(r.red) || !Number.isInteger(r.yellow)) return null;
  let deltas: EloApplied["deltas"] = null;
  if (Array.isArray(r.deltas)) {
    deltas = [];
    for (const d of r.deltas as Array<Record<string, unknown>>) {
      if (!d || typeof d.userId !== "string" || !Number.isInteger(d.delta)) return null;
      deltas.push({ userId: d.userId, delta: d.delta as number });
    }
  }
  return { red: r.red as number, yellow: r.yellow as number, deltas };
}

/** Thrown by `setMatchScore` when `expectPrevious` no longer matches:
 *  somebody else changed the score between the decision and the write. */
export class ScoreMovedError extends Error {
  constructor(
    public readonly expected: { red: number; yellow: number },
    public readonly found: { red: number | null; yellow: number | null },
  ) {
    super(
      `the match reads ${found.red}-${found.yellow}, not the ${expected.red}-${expected.yellow} this change was decided against`,
    );
  }
}

const RECONCILE_TX = { timeout: 15_000, maxWait: 5_000 };

async function lockMatch(tx: Tx, matchId: string): Promise<void> {
  // A row lock, held to the end of the transaction, so two writers of
  // one match's score or Elo run one after the other.
  await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${matchId} FOR UPDATE`;
}

/**
 * Write a match's score and mark it COMPLETED. The two move together: a
 * match with a score that is not COMPLETED is a state nothing models.
 *
 * `expectPrevious`: the score this change was decided against (a
 * correction). If the match no longer reads that, nothing is written
 * and `ScoreMovedError` is thrown.
 *
 * Does NOT touch any rating. Call `reconcileMatchElo` afterwards.
 */
export async function setMatchScore(args: {
  db?: Db;
  matchId: string;
  red: number;
  yellow: number;
  expectPrevious?: { red: number; yellow: number };
}): Promise<{ previous: { red: number; yellow: number } | null; changed: boolean }> {
  const db = args.db ?? defaultDb;
  const { matchId, red, yellow, expectPrevious } = args;
  return db.$transaction(async (tx: Tx) => {
    await lockMatch(tx, matchId);
    const row = await tx.match.findUnique({
      where: { id: matchId },
      select: { redScore: true, yellowScore: true, eloApplied: true },
    });
    if (!row) throw new Error(`match ${matchId} not found`);
    const previous =
      row.redScore !== null && row.yellowScore !== null
        ? { red: row.redScore as number, yellow: row.yellowScore as number }
        : null;
    if (expectPrevious && (previous?.red !== expectPrevious.red || previous?.yellow !== expectPrevious.yellow)) {
      throw new ScoreMovedError(expectPrevious, { red: row.redScore, yellow: row.yellowScore });
    }
    // The legacy stamp. See the header: a scored match with no record
    // had its points added by code that did not store them.
    const stamp =
      previous && parseEloApplied(row.eloApplied) === null
        ? { eloApplied: { red: previous.red, yellow: previous.yellow, deltas: null } }
        : {};
    await tx.match.update({
      where: { id: matchId },
      data: { redScore: red, yellowScore: yellow, status: "COMPLETED", ...stamp },
    });
    return { previous, changed: previous?.red !== red || previous?.yellow !== yellow };
  });
}

export type ReconcileStatus =
  /** The match has no score. Nothing to do. */
  | "no_score"
  /** The ratings already reflect this score. Nothing written. */
  | "unchanged"
  /** First result for the match: its points were added and stored. */
  | "applied"
  /** A changed result: the old points taken back, the new added. */
  | "corrected"
  /** A changed result on a match scored before the points were stored,
   *  where they could not be recovered. RATINGS LEFT AS THEY WERE. */
  | "legacy_left";

export interface ReconcileResult {
  status: ReconcileStatus;
  /** How many memberships the new result's points were written to. */
  moved: number;
  /** For a person reading a log. Set for `legacy_left` and for a legacy
   *  correction that was only known to within one point. */
  detail?: string;
}

/**
 * Make the club's ratings agree with the match's current score.
 * Idempotent: see the header.
 */
export async function reconcileMatchElo(args: { db?: Db; matchId: string }): Promise<ReconcileResult> {
  const db = args.db ?? defaultDb;
  const { matchId } = args;
  return db.$transaction(async (tx: Tx): Promise<ReconcileResult> => {
    await lockMatch(tx, matchId);
    const match = await tx.match.findUnique({
      where: { id: matchId },
      select: {
        date: true,
        redScore: true,
        yellowScore: true,
        eloApplied: true,
        activity: { select: { orgId: true } },
        teamAssignments: { select: { userId: true, team: true } },
      },
    });
    if (!match || match.redScore === null || match.yellowScore === null) {
      return { status: "no_score", moved: 0 };
    }
    const orgId: string = match.activity.orgId;
    const red: number = match.redScore;
    const yellow: number = match.yellowScore;
    const assignments = match.teamAssignments as Array<{ userId: string; team: "RED" | "YELLOW" }>;
    const applied = parseEloApplied(match.eloApplied);

    if (applied && applied.red === red && applied.yellow === yellow) {
      return { status: "unchanged", moved: 0 };
    }

    let detail: string | undefined;
    if (applied) {
      let takeBack = applied.deltas;
      if (takeBack === null) {
        // Scored before the points were stored. Recover them or stop.
        const recovered = await recoverLegacyDeltas(tx, { matchId, orgId, date: match.date, applied, assignments });
        if (recovered.kind === "left") {
          console.warn(`[match-elo] match ${matchId}: ${recovered.detail}`);
          return { status: "legacy_left", moved: 0, detail: recovered.detail };
        }
        takeBack = recovered.deltas;
        detail = recovered.detail;
      }
      for (const d of takeBack) {
        if (d.delta === 0) continue;
        await tx.membership.updateMany({
          where: { userId: d.userId, orgId },
          data: { matchRating: { decrement: d.delta } },
        });
      }
    }

    // The new result, from the ratings as they now stand.
    const { inputs } = await loadMembershipEloInputs({ db: tx, orgId, assignments });
    const deltas = computeEloDeltas(inputs, red, yellow);
    const written: Array<{ userId: string; delta: number }> = [];
    for (const d of deltas) {
      // `updateMany`, as in `membership-elo.ts`: a player with no
      // membership at this club matches nothing and is not written, and
      // is therefore not stored as written either.
      const res = await tx.membership.updateMany({
        where: { userId: d.userId, orgId },
        data: { matchRating: { increment: d.delta } },
      });
      if (res.count > 0) written.push({ userId: d.userId, delta: d.delta });
    }
    await tx.match.update({
      where: { id: matchId },
      data: { eloApplied: { red, yellow, deltas: written } },
    });
    const status: ReconcileStatus = applied ? "corrected" : "applied";
    return { status, moved: written.length, ...(detail ? { detail } : {}) };
    // A correction on a full 7-a-side sheet is about thirty small
    // statements, one after the other. Prisma's default interactive
    // transaction timeout is 5 seconds, which a cold connection could
    // eat into; 15 keeps a slow night from leaving the ratings stale.
  }, RECONCILE_TX);
}

async function recoverLegacyDeltas(
  tx: Tx,
  args: {
    matchId: string;
    orgId: string;
    date: Date;
    applied: EloApplied;
    assignments: Array<{ userId: string; team: "RED" | "YELLOW" }>;
  },
): Promise<
  | { kind: "recovered"; deltas: Array<{ userId: string; delta: number }>; detail?: string }
  | { kind: "left"; detail: string }
> {
  const { matchId, orgId, date, applied, assignments } = args;
  const was = `${applied.red}-${applied.yellow}`;
  const hasBothSides =
    assignments.some((a) => a.team === "RED") && assignments.some((a) => a.team === "YELLOW");
  // No teams: the forward pass added nothing for it, so there is
  // nothing to take back.
  if (!hasBothSides) return { kind: "recovered", deltas: [] };

  const later = await tx.match.findFirst({
    where: {
      activity: { orgId },
      id: { not: matchId },
      date: { gt: date },
      redScore: { not: null },
    },
    select: { id: true },
  });
  if (later) {
    return {
      kind: "left",
      detail:
        `scored ${was} before Elo points were stored, and a later match of the club (${later.id}) has been ` +
        `scored since, so those points cannot be recovered. Ratings left as they were: they still reflect ${was}.`,
    };
  }

  const { inputs, unmemberedUserIds } = await loadMembershipEloInputs({ db: tx, orgId, assignments });
  const candidates = invertEloDeltas(inputs, applied.red, applied.yellow, new Set(unmemberedUserIds));
  if (candidates.length === 0) {
    return {
      kind: "left",
      detail:
        `scored ${was} before Elo points were stored, and no set of points is consistent with the ratings ` +
        `as they stand. Ratings left as they were: they still reflect ${was}.`,
    };
  }
  const c = candidates[0];
  const unwritten = new Set(unmemberedUserIds);
  return {
    kind: "recovered",
    deltas: assignments
      .filter((a) => !unwritten.has(a.userId))
      .map((a) => ({ userId: a.userId, delta: a.team === "RED" ? c.red : c.yellow })),
    ...(candidates.length > 1
      ? {
          detail:
            `scored ${was} before Elo points were stored; the points taken back are known to within one ` +
            `rating point per player (${candidates.length} consistent answers, the first was used).`,
        }
      : {}),
  };
}
