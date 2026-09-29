/**
 * THE ONE PLACE A VACATED TEAM SLOT CHANGES HANDS IN THE DATABASE.
 *
 * `team-slot-inherit.ts` decides WHO takes WHICH slot and is pure. This
 * module applies that decision to Postgres, under a per-match lock, and
 * every path that can seat a newly confirmed player after the teams exist
 * goes through it: the engine's `team_slot_inherit` write (a group IN,
 * a third-party IN) and the bench claim (a DM "YES", a 👍, a group "yes").
 *
 * ── THE INCIDENT: Sutton FC, 29 September 2026 ─────────────────────────
 *
 * Teams published with 14 on the sheet. Then, over ninety minutes:
 *
 *   06:29  Elnur  OUT   (slot vacated)
 *   06:55  Burak  OUT   (slot vacated, by an admin)
 *   07:15  Abid   OUT   (slot vacated)
 *   07:47  Mojib  IN    → engine: inherits Burak's slot
 *   07:57  Hamzah IN    → engine: inherits Elnur's slot
 *   08:05  Ozgur  bench claim of the OLDEST open offer, which was
 *                 ELNUR's: "Ozgur is in, replacing Elnur Mammadov"
 *
 * The bench claim trusted `BenchSlotOffer.replacingUserId` as the slot
 * to take. Elnur's slot had already changed hands at 07:57, so its
 * `findUnique` for Elnur's `TeamAssignment` found nothing: Ozgur was
 * seated nowhere, the group was told he replaced a man whose slot was
 * already filled, and ABID's slot, the one still vacant, was never
 * passed on. Abid stayed on the Red sheet for the rest of the day.
 *
 * Two independent seat-assigners, each with its own idea of which slot
 * was free, is the bug. This module is the fix: there is one assigner,
 * it reads the sheet and the squad AS THEY ARE at the moment of the
 * write (under the lock), and it answers "which slot did this player
 * actually get?" for whichever caller has to announce it.
 *
 * ── THE RULES IT HOLDS ────────────────────────────────────────────────
 *
 *   • A slot is VACATED when its holder is not CONFIRMED. It is inherited
 *     at most once: the row changes hands (`userId` is updated in place),
 *     so the next read sees the new holder and the slot is no longer
 *     vacant. `@@unique([matchId, userId])` stops one player holding two.
 *   • Pairing is `decideSlotInherits`: vacancies in sheet order, arrivals
 *     in the order they joined the squad. Deterministic across retries
 *     and across any interleaving of drops and joins.
 *   • A slot that changes hands closes the bench offer that advertised
 *     it. That offer is no longer true, and leaving it open is what let
 *     the 08:05 claim name Elnur.
 *   • Serialised per match by a transaction-scoped advisory lock, so two
 *     joins landing at the same instant cannot both read the same slot as
 *     free. The lock is released at commit or rollback, never held across
 *     requests, and is keyed on the match alone so unrelated matches
 *     never wait on each other.
 */
import { decideSlotInherits, type InheritTeam } from "./team-slot-inherit";

/** A slot that changed hands. `slotId` is the `TeamAssignment` row. */
export interface AppliedSlotMove {
  slotId: string;
  fromUserId: string;
  toUserId: string;
  team: InheritTeam;
}

/**
 * The slice of a Prisma transaction client this module touches. Declared
 * structurally so the unit tests can hand it an in-memory world and so a
 * caller cannot accidentally run it outside a transaction: nothing but a
 * `tx` has this exact shape in the call sites.
 */
export interface SlotFillTx {
  $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  attendance: {
    findMany: (args: {
      where: { matchId: string };
      select: { userId: true; status: true; position: true };
    }) => Promise<Array<{ userId: string; status: string; position: number }>>;
  };
  teamAssignment: {
    findMany: (args: {
      where: { matchId: string };
      orderBy: { id: "asc" };
      select: { id: true; userId: true; team: true };
    }) => Promise<Array<{ id: string; userId: string; team: string }>>;
    update: (args: { where: { id: string }; data: { userId: string } }) => Promise<unknown>;
  };
  benchSlotOffer: {
    updateMany: (args: {
      where: { matchId: string; replacingUserId: { in: string[] }; resolvedAt: null };
      data: { resolvedAt: Date; outcome: string };
    }) => Promise<{ count: number }>;
  };
}

/**
 * Take the per-match slot lock for the rest of this transaction.
 *
 * `pg_advisory_xact_lock` rather than `SELECT … FOR UPDATE` on `Match`:
 * the match row is written by unrelated paths (status, labels, payment
 * flags) that have no business queueing behind a seat change, and an
 * advisory key names exactly the resource being protected.
 */
export async function lockTeamSlots(tx: SlotFillTx, matchId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`team-slots:${matchId}`}))`;
}

async function readWorld(tx: SlotFillTx, matchId: string) {
  const [rows, teams] = await Promise.all([
    tx.attendance.findMany({
      where: { matchId },
      select: { userId: true, status: true, position: true },
    }),
    tx.teamAssignment.findMany({
      where: { matchId },
      // SHEET ORDER. `load-state.ts` reads it the same way and says why.
      orderBy: { id: "asc" },
      select: { id: true, userId: true, team: true },
    }),
  ]);
  return { rows, teams };
}

async function applyMoves(
  tx: SlotFillTx,
  matchId: string,
  moves: AppliedSlotMove[],
): Promise<void> {
  for (const m of moves) {
    // IN PLACE, so the replacement stands where the dropped player stood.
    await tx.teamAssignment.update({ where: { id: m.slotId }, data: { userId: m.toUserId } });
  }
  if (moves.length > 0) {
    await tx.benchSlotOffer.updateMany({
      where: { matchId, replacingUserId: { in: moves.map((m) => m.fromUserId) }, resolvedAt: null },
      data: { resolvedAt: new Date(), outcome: "refilled" },
    });
  }
}

/**
 * Seat every confirmed player who has no slot into a vacated one, and
 * return what moved. Idempotent: a second call on the same world moves
 * nothing. Call it INSIDE the transaction that made the attendance
 * change, after that change, so the read sees it.
 */
export async function fillVacatedSlots(tx: SlotFillTx, matchId: string): Promise<AppliedSlotMove[]> {
  await lockTeamSlots(tx, matchId);
  const { rows, teams } = await readWorld(tx, matchId);
  if (teams.length === 0) return [];
  const slotIdOf = new Map(teams.map((t) => [t.userId, t.id]));
  const moves: AppliedSlotMove[] = decideSlotInherits({
    rows: rows.map((r) => ({
      userId: r.userId,
      status: r.status as "CONFIRMED" | "BENCH" | "DROPPED",
      position: r.position,
    })),
    teams: teams.map((t) => ({ userId: t.userId, team: t.team as InheritTeam })),
  }).map((m) => ({ ...m, slotId: slotIdOf.get(m.fromUserId)! }));
  await applyMoves(tx, matchId, moves);
  return moves;
}

/** Why a named move was not applied as asked. */
export type GuardedMoveRefusal =
  | "slot-already-taken"
  | "holder-still-playing"
  | "receiver-not-playing"
  | "receiver-already-seated";

export type GuardedMoveResult =
  | { kind: "moved"; move: AppliedSlotMove }
  | { kind: "refused"; reason: GuardedMoveRefusal; healed: AppliedSlotMove[] };

/**
 * Move ONE named slot (`fromUserId` → `toUserId`), the move the engine
 * decided and has already put into words, but only if it is still true
 * under the lock.
 *
 * The engine decides from a snapshot taken at the start of its request.
 * Another request (a bench claim, a second batch) can seat somebody in
 * the same slot in between. Updating blindly would then either throw
 * (the row no longer belongs to `fromUserId`) and leave the arrival
 * standing nowhere, or, on a lucky interleaving, overwrite a seat that
 * was already given away. So each precondition is re-checked here, and
 * when one no longer holds the move is REFUSED and the sheet is HEALED
 * with `fillVacatedSlots` instead, which seats the arrival in whatever
 * slot is genuinely free now. The caller reports the refusal loudly; the
 * sheet in the database is right either way.
 */
export async function moveNamedSlot(
  tx: SlotFillTx,
  matchId: string,
  fromUserId: string,
  toUserId: string,
): Promise<GuardedMoveResult> {
  await lockTeamSlots(tx, matchId);
  const { rows, teams } = await readWorld(tx, matchId);
  const statusOf = new Map(rows.map((r) => [r.userId, r.status]));
  const slot = teams.find((t) => t.userId === fromUserId);
  let reason: GuardedMoveRefusal | null = null;
  if (!slot) reason = "slot-already-taken";
  else if (statusOf.get(fromUserId) === "CONFIRMED") reason = "holder-still-playing";
  else if (statusOf.get(toUserId) !== "CONFIRMED") reason = "receiver-not-playing";
  else if (teams.some((t) => t.userId === toUserId)) reason = "receiver-already-seated";
  if (reason === null && slot) {
    const move: AppliedSlotMove = {
      slotId: slot.id,
      fromUserId,
      toUserId,
      team: slot.team as InheritTeam,
    };
    await applyMoves(tx, matchId, [move]);
    return { kind: "moved", move };
  }
  const healed = await fillVacatedSlots(tx, matchId);
  return { kind: "refused", reason: reason!, healed };
}
