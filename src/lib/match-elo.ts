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
 * ── THE RECORD ───────────────────────────────────────────────────────
 *
 * `Match.eloApplied`, one JSON value, written ONLY by this file:
 *
 *     {
 *       target:  { red, yellow },            the score THIS FILE last wrote
 *       applied: { red, yellow, deltas } | null,
 *       outOfStep?: true
 *     }
 *
 * `applied` is what the club's ratings currently carry for this match:
 * the result, and the points actually written to each membership for
 * it. `applied: null` means NOTHING has been added yet.
 *
 *   `setMatchScore`     writes the score (the fact) and, IN THE SAME
 *                       UPDATE, `target`. It never touches a rating.
 *   `reconcileMatchElo` makes the ratings agree with the score: take
 *                       back `applied.deltas`, add the new result's,
 *                       store those as `applied`. When `applied` already
 *                       is the match's score it does nothing. That is
 *                       the whole of "exactly once".
 *
 * Two functions and two transactions ON PURPOSE. `score-engine.ts`
 * explains why: a score is a fact the group reported and the Elo is
 * derived from it, so an Elo failure must never roll the score back.
 *
 * ── A FAILED ELO PASS IS "PENDING", AND THAT IS NOT "LEGACY" ─────────
 *
 * The first version of this file told the two apart by whether the
 * column was NULL, and they are both NULL: a first score whose Elo pass
 * threw (a timeout, a dropped connection) looked exactly like a match
 * scored before the column existed, so a later correction "took back"
 * points that had never been added (review of PR #214, item 1: four
 * players on 1000 ended 949 / 1051 where 974 / 1026 was right).
 *
 * Hence `target`, written with the score. From the first score this
 * file writes, the column is never NULL again:
 *
 *   NULL, match has a score       LEGACY. Scored before the column, by
 *                                 code that added the points and stored
 *                                 nothing. See below.
 *   applied null                  PENDING. Reconcile goes FORWARD only.
 *   applied = the match's score   in step. Reconcile does nothing.
 *   applied = some other score    a correction. Take back, then add.
 *
 * ── MATCHES SCORED BEFORE THE COLUMN EXISTED ─────────────────────────
 *
 * When `setMatchScore` overwrites the score of a match with a NULL
 * record, it stamps `applied: { red: old, yellow: old, deltas: null,
 * asOf }`: "the ratings carry the old result; what was written is
 * unknown; the match row was last written at `asOf`".
 *
 * `reconcileMatchElo` can then try to recover the points by inversion
 * (`invertEloDeltas`), and ONLY when nothing can have moved these
 * ratings since: no other scored match of the club has a later kickoff
 * OR was written after `asOf`. `Match.updatedAt` moves on every write to
 * a match, so "written after" errs towards refusing. Otherwise it LEAVES
 * THE RATINGS ALONE and reports `legacy_left`. Stale by one result is
 * recoverable by a person; a second result stacked on the first is the
 * bug this file exists to remove.
 *
 * BE HONEST ABOUT WHAT THE INVERSION PROVES: nothing. It always finds an
 * answer (one, or two a point apart), for any ratings whatever, because
 * it is solving for the number that makes the forward pass agree with
 * itself. It cannot tell that the ratings have moved since. The guard
 * above is the only protection, and what it cannot see is a rating
 * changed by something that is not a score (a player merge). An earlier
 * version had a "no consistent answer, refuse" branch and described it
 * as a safeguard; it could never fire.
 *
 * ── A SCORE CHANGED BY SOMETHING ELSE ────────────────────────────────
 *
 * If the match's score is not `target` when this file next sees it,
 * something that does not keep the record changed it: the old code
 * (between the migration and the deploy), or a script. What that did to
 * the ratings is unknowable, so the match is marked `outOfStep`, its
 * ratings are left alone from then on, and every reconcile says so.
 *
 * ── LOCKS ────────────────────────────────────────────────────────────
 *
 * The match row first, then the memberships involved, in id order, then
 * ONE write per player with the net change, in the same order. Two
 * reconciles touching the same players therefore queue instead of
 * deadlocking, and the ratings read inside the lock are the ratings
 * written against.
 */
import { db as defaultDb } from "./db";
import { computeEloDeltas, invertEloDeltas, type PlayerEloInput } from "./elo";
import { MEMBERSHIP_ELO_DEFAULT } from "./membership-elo";
import { SCORE_ASK_KIND } from "./pipeline/score-ask";

type Db = typeof defaultDb;
// The interactive-transaction client. Structural, so a unit test can
// hand in a fake.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

type Score = { red: number; yellow: number };

export interface EloApplied {
  /** The score this file last wrote to the match. */
  target: Score;
  /** What the ratings carry for the match; null when nothing yet. */
  applied:
    | (Score & {
        /** null: scored before the column existed, points unknown. */
        deltas: Array<{ userId: string; delta: number }> | null;
        /** Legacy stamp only: when the match row was last written before
         *  this file first touched it (ISO). */
        asOf?: string;
      })
    | null;
  /** The score was changed by something that does not keep this record,
   *  or the record could not be read. Either way what the ratings carry
   *  for this match is unknown, and they are left alone. */
  outOfStep?: true;
  /** A value found in the column that this file could not read, kept
   *  as it was found. Always with `outOfStep`. */
  unreadable?: unknown;
}

const isScore = (v: unknown): v is Score =>
  !!v &&
  typeof v === "object" &&
  Number.isInteger((v as Score).red) &&
  Number.isInteger((v as Score).yellow);

/** Read the column defensively: it is JSON, so its shape is a promise
 *  and not a guarantee. Anything unreadable is treated as absent. */
export function parseEloApplied(raw: unknown): EloApplied | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isScore(r.target)) return null;
  const out: EloApplied = { target: { red: r.target.red, yellow: r.target.yellow }, applied: null };
  if (r.applied !== null && r.applied !== undefined) {
    if (!isScore(r.applied)) return null;
    const a = r.applied as Score & { deltas?: unknown; asOf?: unknown };
    let deltas: Array<{ userId: string; delta: number }> | null = null;
    if (Array.isArray(a.deltas)) {
      deltas = [];
      for (const d of a.deltas as Array<Record<string, unknown>>) {
        if (!d || typeof d.userId !== "string" || !Number.isInteger(d.delta)) return null;
        deltas.push({ userId: d.userId, delta: d.delta as number });
      }
    }
    out.applied = {
      red: a.red,
      yellow: a.yellow,
      deltas,
      ...(typeof a.asOf === "string" ? { asOf: a.asOf } : {}),
    };
  }
  if (r.outOfStep === true) out.outOfStep = true;
  if (r.unreadable !== undefined) out.unreadable = r.unreadable;
  return out;
}

/**
 * The column, told apart three ways. NULL is "no record" (an older
 * match, or one never scored). A value this file cannot read is NOT
 * that: treating it as legacy would stamp over it and then "recover"
 * points on the strength of nothing. It is out of step, and loudly.
 */
function readRecord(
  raw: unknown,
  matchId: string,
): { kind: "none" } | { kind: "ok"; record: EloApplied } | { kind: "unreadable"; raw: unknown } {
  if (raw === null || raw === undefined) return { kind: "none" };
  const record = parseEloApplied(raw);
  if (record) return { kind: "ok", record };
  console.error(
    `[match-elo] match ${matchId}: UNREADABLE Match.eloApplied (${JSON.stringify(raw)?.slice(0, 300)}). ` +
      `Treated as out of step: its ratings will be left alone.`,
  );
  return { kind: "unreadable", raw };
}

/** Thrown by `setMatchScore` when `expectPrevious` no longer matches:
 *  somebody else changed the score between the decision and the write. */
export class ScoreMovedError extends Error {
  constructor(
    public readonly expected: Score,
    public readonly found: { red: number | null; yellow: number | null },
  ) {
    super(
      `the match reads ${found.red}-${found.yellow}, not the ${expected.red}-${expected.yellow} this change was decided against`,
    );
  }
}

// A correction on a full 7-a-side sheet is a few dozen small statements,
// one after the other. Prisma's default interactive transaction timeout
// is 5 seconds, which a cold connection could eat into.
const RECONCILE_TX = { timeout: 15_000, maxWait: 5_000 };

async function lockMatch(tx: Tx, matchId: string): Promise<void> {
  // A row lock, held to the end of the transaction, so two writers of
  // one match's score or Elo run one after the other.
  await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${matchId} FOR UPDATE`;
}

const same = (a: Score | null, b: Score | null): boolean =>
  !!a && !!b && a.red === b.red && a.yellow === b.yellow;

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
  expectPrevious?: Score;
}): Promise<{ previous: Score | null; changed: boolean }> {
  const db = args.db ?? defaultDb;
  const { matchId, red, yellow, expectPrevious } = args;
  return db.$transaction(async (tx: Tx) => {
    await lockMatch(tx, matchId);
    const row = await tx.match.findUnique({
      where: { id: matchId },
      select: { redScore: true, yellowScore: true, eloApplied: true, updatedAt: true },
    });
    if (!row) throw new Error(`match ${matchId} not found`);
    const previous: Score | null =
      row.redScore !== null && row.yellowScore !== null
        ? { red: row.redScore as number, yellow: row.yellowScore as number }
        : null;
    if (expectPrevious && !same(previous, expectPrevious)) {
      throw new ScoreMovedError(expectPrevious, { red: row.redScore, yellow: row.yellowScore });
    }

    const target: Score = { red, yellow };
    const read = readRecord(row.eloApplied, matchId);
    const record = read.kind === "ok" ? read.record : null;
    let next: EloApplied;
    if (read.kind === "unreadable") {
      next = { target, applied: null, outOfStep: true, unreadable: read.raw };
    } else if (!record) {
      next = previous
        ? // LEGACY: scored before the column, points added and not stored.
          {
            target,
            applied: {
              red: previous.red,
              yellow: previous.yellow,
              deltas: null,
              ...(row.updatedAt instanceof Date ? { asOf: row.updatedAt.toISOString() } : {}),
            },
          }
        : // A FIRST SCORE. Nothing applied yet: pending until reconcile.
          { target, applied: null };
    } else {
      // The score on the row should be what this file last wrote. If it
      // is not, something else changed it and the record no longer
      // describes the ratings.
      const outOfStep = record.outOfStep === true || !same(previous, record.target);
      next = {
        target,
        applied: record.applied,
        ...(outOfStep ? { outOfStep: true as const } : {}),
        ...(record.unreadable !== undefined ? { unreadable: record.unreadable } : {}),
      };
    }

    await tx.match.update({
      where: { id: matchId },
      data: { redScore: red, yellowScore: yellow, status: "COMPLETED", eloApplied: next },
    });
    // THE MATCH HAS A RESULT, so any "which team won?" the bot had open
    // for it is over (`pipeline/score-ask.ts`). Here, in the same
    // transaction, and not in the bot's own deps: the dashboard, the
    // legacy score route and a script all come through this function,
    // and a question that outlives its result is how a bare "Yellow"
    // came to overwrite one (second review, H1).
    await tx.sentNotification.deleteMany({ where: { kind: SCORE_ASK_KIND, matchId } });
    return { previous, changed: !same(previous, target) };
  });
}

export type ReconcileStatus =
  /** The match has no score. Nothing to do. */
  | "no_score"
  /** The ratings already carry this score. Nothing written. */
  | "unchanged"
  /** The result's points were added and stored (nothing to take back). */
  | "applied"
  /** A changed result: the old points taken back, the new added. */
  | "corrected"
  /** The match has no team sheet (not both sides), so there is nobody
   *  to add points to. NOT recorded as applied: once teams exist, the
   *  next reconcile applies the result. Nothing triggers that by itself
   *  (teams cannot be generated for a completed match); saving the
   *  score again does. */
  | "no_teams"
  /** The ratings could NOT be brought into line and were LEFT AS THEY
   *  WERE: an older match whose points could not be recovered, or a
   *  score changed by something that does not keep the record. */
  | "legacy_left";

export interface ReconcileResult {
  status: ReconcileStatus;
  /** How many memberships the new result's points were written to. */
  moved: number;
  /** For a person reading a log or a note. */
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
    const score: Score = { red: match.redScore, yellow: match.yellowScore };
    const assignments = match.teamAssignments as Array<{ userId: string; team: "RED" | "YELLOW" }>;
    const read = readRecord(match.eloApplied, matchId);
    if (read.kind === "unreadable") {
      await tx.match.update({
        where: { id: matchId },
        data: { eloApplied: { target: score, applied: null, outOfStep: true, unreadable: read.raw } },
      });
      return {
        status: "legacy_left",
        moved: 0,
        detail: "the stored Elo record for this match could not be read, so what the ratings carry for it is unknown. Ratings left as they were.",
      };
    }

    // LEGACY and untouched: a match that has a score and NO record was
    // scored before the column existed, by code that added the points
    // itself. Nothing here has changed the score, so there is nothing to
    // do, and above all nothing to add a second time.
    if (read.kind === "none") return { status: "unchanged", moved: 0 };
    const record = read.record;

    if (record.outOfStep || !same(score, record.target)) {
      const detail =
        record.unreadable !== undefined
          ? "the stored Elo record for this match could not be read, so what the ratings carry for it is unknown. Ratings left as they were."
          : `the score was changed outside MatchTime's score writer (the record expects ` +
            `${record.target.red}-${record.target.yellow}, the match reads ${score.red}-${score.yellow}), so what the ` +
            `ratings carry for this match is unknown. Ratings left as they were.`;
      if (!record.outOfStep) {
        await tx.match.update({ where: { id: matchId }, data: { eloApplied: { ...record, outOfStep: true } } });
      }
      console.warn(`[match-elo] match ${matchId}: ${detail}`);
      return { status: "legacy_left", moved: 0, detail };
    }

    if (record.applied && same(record.applied, score) ) {
      return { status: "unchanged", moved: 0 };
    }

    // ── Lock every membership this will read or write, in id order ───
    const storedIds = (record.applied?.deltas ?? []).map((d) => d.userId);
    const userIds = [...new Set([...assignments.map((a) => a.userId), ...storedIds])].sort();
    if (userIds.length > 0) {
      await tx.$queryRaw`SELECT id FROM "Membership" WHERE "orgId" = ${orgId} AND "userId" = ANY(${userIds}::text[]) ORDER BY id FOR UPDATE`;
    }
    const rows: Array<{ userId: string; matchRating: number }> =
      userIds.length > 0
        ? await tx.membership.findMany({
            where: { orgId, userId: { in: userIds } },
            select: { userId: true, matchRating: true },
          })
        : [];
    const rating = new Map(rows.map((r) => [r.userId, r.matchRating]));

    // ── What to take back ────────────────────────────────────────────
    const notes: string[] = [];
    let takeBack: Array<{ userId: string; delta: number }> = [];
    if (record.applied) {
      if (record.applied.deltas === null) {
        const recovered = await recoverLegacyDeltas(tx, {
          matchId,
          orgId,
          date: match.date,
          applied: record.applied,
          assignments,
          rating,
        });
        if (recovered.kind === "left") {
          console.warn(`[match-elo] match ${matchId}: ${recovered.detail}`);
          return { status: "legacy_left", moved: 0, detail: recovered.detail };
        }
        takeBack = recovered.deltas;
        if (recovered.detail) notes.push(recovered.detail);
      } else {
        takeBack = record.applied.deltas;
      }
    }

    // Somebody whose points are on the record and who has no membership
    // here any more: merged into another player, or removed. A merge
    // keeps the SURVIVOR's rating unless it was still the 1000 default
    // (`merge-players-core.ts`), so whether these points travelled with
    // them is not knowable from here. They are left, and it is said.
    const gone = takeBack.filter((d) => d.delta !== 0 && !rating.has(d.userId));
    if (gone.length > 0) {
      notes.push(
        `${gone.length} player${gone.length === 1 ? "" : "s"} on the stored record no longer ` +
          `${gone.length === 1 ? "has" : "have"} a membership at this club (${gone.map((d) => d.userId).join(", ")}), ` +
          `so their old points were not taken back.`,
      );
    }

    // ── The new result, from the ratings with the old points removed ──
    const net = new Map<string, number>();
    for (const d of takeBack) {
      if (!rating.has(d.userId)) continue;
      rating.set(d.userId, rating.get(d.userId)! - d.delta);
      net.set(d.userId, (net.get(d.userId) ?? 0) - d.delta);
    }
    const inputs: PlayerEloInput[] = assignments.map((a) => ({
      userId: a.userId,
      team: a.team,
      // No membership: no club opinion, which is 1000, and nowhere to
      // persist a change (`membership-elo.ts`).
      matchRating: rating.get(a.userId) ?? MEMBERSHIP_ELO_DEFAULT,
    }));
    // NO TEAM SHEET YET (not both sides): nobody to add points to. The
    // first version stored that as "applied, with no deltas", after
    // which every later reconcile said "unchanged" and the result was
    // never applied even once teams existed. It stays PENDING instead.
    const hasBothSides =
      assignments.some((a) => a.team === "RED") && assignments.some((a) => a.team === "YELLOW");
    const written: Array<{ userId: string; delta: number }> = [];
    for (const d of hasBothSides ? computeEloDeltas(inputs, score.red, score.yellow) : []) {
      if (!rating.has(d.userId)) continue;
      written.push({ userId: d.userId, delta: d.delta });
      net.set(d.userId, (net.get(d.userId) ?? 0) + d.delta);
    }

    // ── One write per player, in the order the rows were locked ──────
    for (const userId of [...net.keys()].sort()) {
      const by = net.get(userId)!;
      if (by === 0) continue;
      await tx.membership.updateMany({
        where: { userId, orgId },
        data: { matchRating: { increment: by } },
      });
    }

    const next: EloApplied = { target: score, applied: hasBothSides ? { ...score, deltas: written } : null };
    await tx.match.update({ where: { id: matchId }, data: { eloApplied: next } });
    const status: ReconcileStatus = !hasBothSides ? "no_teams" : record.applied ? "corrected" : "applied";
    return { status, moved: written.length, ...(notes.length ? { detail: notes.join(" ") } : {}) };
  }, RECONCILE_TX);
}

async function recoverLegacyDeltas(
  tx: Tx,
  args: {
    matchId: string;
    orgId: string;
    date: Date;
    applied: NonNullable<EloApplied["applied"]>;
    assignments: Array<{ userId: string; team: "RED" | "YELLOW" }>;
    rating: Map<string, number>;
  },
): Promise<
  | { kind: "recovered"; deltas: Array<{ userId: string; delta: number }>; detail?: string }
  | { kind: "left"; detail: string }
> {
  const { matchId, orgId, date, applied, assignments, rating } = args;
  const was = `${applied.red}-${applied.yellow}`;
  const hasBothSides =
    assignments.some((a) => a.team === "RED") && assignments.some((a) => a.team === "YELLOW");
  // No teams: the forward pass added nothing for it, so there is
  // nothing to take back.
  if (!hasBothSides) return { kind: "recovered", deltas: [] };

  // THE GUARD. Has anything scored since been able to move these
  // ratings? Kickoff order alone is not enough: an OLDER match can be
  // scored late. `asOf` is when this match's row was last written before
  // the edit; without one (an unreadable stamp) nothing is assumed.
  const asOf = applied.asOf ? new Date(applied.asOf) : null;
  if (!asOf || Number.isNaN(asOf.getTime())) {
    return {
      kind: "left",
      detail:
        `scored ${was} before Elo points were stored, and when that score was written is not known, so those ` +
        `points cannot be recovered safely. Ratings left as they were: they still reflect ${was}.`,
    };
  }
  const later = await tx.match.findFirst({
    where: {
      activity: { orgId },
      id: { not: matchId },
      redScore: { not: null },
      OR: [{ date: { gt: date } }, { updatedAt: { gt: asOf } }],
    },
    select: { id: true },
  });
  if (later) {
    return {
      kind: "left",
      detail:
        `scored ${was} before Elo points were stored, and another match of the club (${later.id}) has been ` +
        `played or scored since, so those points cannot be recovered. Ratings left as they were: they still reflect ${was}.`,
    };
  }

  const unwritten = new Set(assignments.filter((a) => !rating.has(a.userId)).map((a) => a.userId));
  const inputs: PlayerEloInput[] = assignments.map((a) => ({
    userId: a.userId,
    team: a.team,
    matchRating: rating.get(a.userId) ?? MEMBERSHIP_ELO_DEFAULT,
  }));
  // Always at least one answer: see the header for why that is not a
  // safeguard. Defensive only.
  const candidates = invertEloDeltas(inputs, applied.red, applied.yellow, unwritten);
  if (candidates.length === 0) {
    return {
      kind: "left",
      detail: `scored ${was} before Elo points were stored, and they could not be recovered. Ratings left as they were: they still reflect ${was}.`,
    };
  }
  const c = candidates[0];
  return {
    kind: "recovered",
    deltas: assignments
      .filter((a) => !unwritten.has(a.userId))
      .map((a) => ({ userId: a.userId, delta: a.team === "RED" ? c.red : c.yellow })),
    ...(candidates.length > 1
      ? {
          detail:
            `Scored ${was} before Elo points were stored; the points taken back are known to within one ` +
            `rating point per player.`,
        }
      : {}),
  };
}
