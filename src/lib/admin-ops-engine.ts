/**
 * §10 STEP 7 PART 2 — THE `admin_ops` APPLY LAYER.
 *
 *   router → admin extractor → engine → APPLY → composer
 *
 * `src/lib/pipeline/` decides and composes and is forbidden from
 * writing — `pipeline/__tests__/zero-writes.test.ts` scans every file in
 * that directory on every build. This module is the other side of that
 * line and lives OUTSIDE `pipeline/` for exactly that reason, as
 * `attendance-engine.ts` and `score-engine.ts` do.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THIS ONE MOVES REAL MONEY
 * ─────────────────────────────────────────────────────────────────────
 * Sutton FC has been on live Stripe payments since 2026-06-09, and a
 * `PaymentCredit` row or an `Attendance.paidAt` stamp is what the chase
 * math reads to decide who still owes. So the rules here are stricter
 * than anywhere else in the migration:
 *
 *   • NOTHING here decides anything. Who may credit, whom they credited,
 *     how many, and whether the number is even possible are all settled
 *     in `engine.ts`'s `handleAdmin` before this module is reached, and
 *     none of it is re-litigated. Every branch below is a mechanical
 *     translation of a field the engine already set.
 *   • THE TWO BRANCHES ARE NOT INTERCHANGEABLE, and the flag that picks
 *     between them comes from the FACTS (`namedCovered`), never from
 *     `coveredUserIds.length`. Naming people stamps their rows and
 *     creates NO credit row; a bare count creates one credit row and
 *     stamps nobody. Doing both would double-count every payment.
 *   • THE ACK IS COMPUTED FROM WHAT LANDED, not from what was asked
 *     for. `unpaidAfter` is derived from the rows this module actually
 *     stamped, so §3.2 S7's "words must match action" holds by
 *     construction rather than by care.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT IT DELIBERATELY DOES NOT DO
 * ─────────────────────────────────────────────────────────────────────
 *   • It does not fire the recruit blast. The engine proposes
 *     `recruit_blast` so the DECISION is auditable, and
 *     `admin-ops-engine-batch.ts` reports it as `recruitRequest` for the
 *     route's existing batch-final pass. 2026-09-01: the blast ran
 *     BEFORE the batch's attendance writes, counted a squad the same
 *     message was about to change, and told the owner it was full one
 *     line after he said Najib was out. WHEN it runs is the whole bug.
 *   • It does not choose the payment target match. The runner does,
 *     from `SquadState.completedMatch`, and only when that is a
 *     genuinely `COMPLETED`, non-historical match — which is exactly the
 *     shipped selector (`route.ts:3801-3803`).
 *   • It imports neither `db` nor Prisma. Its dependencies are injected,
 *     which is what makes the seam unit-testable without a database, and
 *     a test asserts the absence by SCANNING this file, because a
 *     comment saying so is worth nothing.
 */
import { t } from "./i18n/t";
import type { Lang } from "./i18n/lang";
import type { ProposedWrite } from "./pipeline/types";

export type EnginePaymentWrite = Extract<ProposedWrite, { kind: "payment_credit" }>;
export type EngineReminderWrite = Extract<ProposedWrite, { kind: "reminder" }>;

/**
 * Prefix on every degradation this layer reports. Mirrors
 * `ENGINE_APPLY_DEGRADED_PREFIX` for step 6.
 *
 * ⚠️ WHAT THE DM ACTUALLY IS, corrected 2026-09-06. §10 step 8 replaced
 * the analyze route's inline partial-response net with
 * `lib/operator-note.ts`, which selects on the TYPED fact "no owner
 * claimed this id" and never reads prose. So this prefix is no longer
 * what triggers the DM — nothing regex-matches it any more, which is
 * exactly what §9 asked for. It is now (a) the audit trail on the
 * `AnalyzedMessage` row and (b) the marker a human scans for in the
 * log. The line AFTER the message id is what an admin reads on their
 * phone, because `composeOperatorNote` prints it verbatim as the "why"
 * beside the lost message. Write those sentences for that reader.
 *
 * On THIS path the sentence is money-adjacent (S21 — `PaymentCredit`,
 * `Attendance.paidAt`, live on Sutton FC), so "nobody credited this
 * payment" has to be legible to an admin at a glance.
 */
export const ADMIN_OPS_APPLY_DEGRADED_PREFIX = "admin-ops-engine: degraded —";

/** `AnalyzedMessage.handledBy` for a message this path decided. The
 *  AUDIT field, not the wire field. */
export const ADMIN_OPS_HANDLED_BY = "admin-ops-engine";

export interface PaidState {
  /** The activity's name, for the ack. Read, never composed here. */
  matchName: string;
  confirmed: Array<{ userId: string; name: string; paid: boolean }>;
  /** Sum of every existing `PaymentCredit.count` on the match. */
  creditTotal: number;
}

export interface AdminOpsApplyDeps {
  /** CONFIRMED attendance on the payment target, with paid state and the
   *  credits already recorded against it. */
  loadPaidState: (matchId: string) => Promise<PaidState>;
  /** `Attendance.paidAt` + `paidViaUserId`, for ONE player. Idempotent
   *  at the call site: a row that is already paid is never re-stamped,
   *  matching `route.ts:3866-3871`. */
  markPaid: (args: { matchId: string; userId: string; payerUserId: string }) => Promise<void>;
  /** One aggregate `PaymentCredit` row. */
  createPaymentCredit: (args: {
    matchId: string;
    payerUserId: string;
    recordedByUserId: string;
    count: number;
  }) => Promise<void>;
  /** The player's WhatsApp number, or null. The engine already refused a
   *  member with no phone on file; this covers the gap between the state
   *  load and the write. */
  loadPhone: (userId: string) => Promise<string | null>;
  /** A future-dated `kind: "dm"` BotJob. The scheduler emits it when
   *  `sendAfter` has passed, which is what makes a reminder land on the
   *  right day without a second timer. */
  queueReminderDm: (args: { phone: string; text: string; sendAt: Date }) => Promise<void>;
}

export interface PaymentApplyResult {
  write: EnginePaymentWrite;
  ok: boolean;
  error?: string;
  matchName: string;
  /** Whose rows were stamped, by name, for the ack. */
  creditedNames: string[];
  /** Named people who are not CONFIRMED on the target match. Reported to
   *  the group rather than silently dropped (`route.ts:3906-3908`). */
  unmatchedUserIds: string[];
  confirmedCount: number;
  unpaidAfter: number;
}

export interface ReminderApplyResult {
  write: EngineReminderWrite;
  ok: boolean;
  error?: string;
}

/**
 * The DM a reminder actually sends. Copy lives here rather than in
 * `pipeline/compose.ts` because the composer's whole contract is that it
 * renders GROUP utterances from the projected state; a 1:1 DM is neither.
 * Byte-for-byte the shipped text (`route.ts:3975-3979`) — a player who
 * has had one of these before should not be able to tell that anything
 * changed.
 */
export function composeReminderDm(args: { name: string | null; note: string }): string {
  const first = (args.name ?? "").split(/\s+/)[0] || "there";
  return (
    `⏰ Reminder, ${first} — you asked me to nudge you:\n\n` +
    `_${args.note}_\n\n` +
    `(reply in the group when you're ready 👍)`
  );
}

/**
 * The group acknowledgement for a credit that LANDED.
 *
 * Every number in it is read from what the apply actually did, which is
 * the point: `route.ts:3898-3912` re-reads the match to build the same
 * sentence, and this derives it from the same facts without a second
 * round trip. If nothing landed, there is no sentence.
 */
export function composePaymentAck(r: PaymentApplyResult, payerName: string, lang?: Lang | string | null): string {
  return t(lang).payment_credit_ack({
    payerName,
    credited: r.creditedNames,
    count: r.write.count,
    matchName: r.matchName,
    unpaid: r.unpaidAfter,
    confirmed: r.confirmedCount,
    unmatched: r.unmatchedUserIds.length,
  });
}

/**
 * Apply ONE payment credit.
 *
 * Sequential per player and not `Promise.all`: these are rows on one
 * match, the counts are read back afterwards, and racing them buys
 * nothing on a list that is at most a squad long.
 */
export async function applyPaymentCredit(args: {
  matchId: string;
  write: EnginePaymentWrite;
  /** The ADMIN who typed the message. `PaymentCredit.recordedById`, and
   *  never the payer — they are the same person only by coincidence. */
  recordedByUserId: string;
  deps: AdminOpsApplyDeps;
}): Promise<PaymentApplyResult> {
  const { matchId, write, recordedByUserId, deps } = args;
  const base: Omit<PaymentApplyResult, "ok"> = {
    write,
    matchName: "",
    creditedNames: [],
    unmatchedUserIds: [],
    confirmedCount: 0,
    unpaidAfter: 0,
  };

  let state: PaidState;
  try {
    state = await deps.loadPaidState(matchId);
  } catch (err) {
    return { ...base, ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const confirmedById = new Map(state.confirmed.map((c) => [c.userId, c]));
  const creditedNames: string[] = [];
  const unmatched: string[] = [];
  let newlyPaid = 0;
  let creditAdded = 0;

  try {
    if (write.namedCovered) {
      // (a) NAMED. Stamp each row; create NO credit row — that is how
      // `route.ts:3841-3873` avoids double-counting the same money.
      for (const userId of write.coveredUserIds) {
        const row = confirmedById.get(userId);
        if (!row) {
          unmatched.push(userId);
          continue;
        }
        if (!row.paid) {
          await deps.markPaid({ matchId, userId, payerUserId: write.payerUserId });
          newlyPaid++;
        }
        creditedNames.push(row.name);
      }
    } else {
      // (b) AGGREGATE. One credit row for the count, nobody stamped.
      await deps.createPaymentCredit({
        matchId,
        payerUserId: write.payerUserId,
        recordedByUserId,
        count: write.count,
      });
      creditAdded = write.count;
    }
  } catch (err) {
    // A partial apply is possible here (some rows stamped, one threw)
    // and it is reported as a FAILURE rather than acked as a success:
    // the runner suppresses the group ack, so the admin sees nothing
    // rather than a number that is wrong. The rows that did land are
    // correct and idempotent, so retrying the same message is safe.
    return {
      ...base,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      matchName: state.matchName,
      creditedNames,
      unmatchedUserIds: unmatched,
      confirmedCount: state.confirmed.length,
    };
  }

  const paidBefore = state.confirmed.filter((c) => c.paid).length;
  const confirmedCount = state.confirmed.length;
  const unpaidAfter = Math.max(
    0,
    confirmedCount - (paidBefore + newlyPaid) - (state.creditTotal + creditAdded),
  );

  return {
    write,
    ok: true,
    matchName: state.matchName,
    creditedNames,
    unmatchedUserIds: unmatched,
    confirmedCount,
    unpaidAfter,
  };
}

/** Queue ONE reminder DM. */
export async function applyReminder(args: {
  write: EngineReminderWrite;
  /** For the greeting. Never used to decide anything. */
  name: string | null;
  /** What the reminder is ABOUT, as the message said it. */
  note: string;
  deps: AdminOpsApplyDeps;
}): Promise<ReminderApplyResult> {
  const { write, deps } = args;
  try {
    const phone = await deps.loadPhone(write.userId);
    if (!phone) {
      // The engine already refused a member with no phone in `SquadState`.
      // Reaching here means the two reads disagree, which is a real
      // condition (a number removed between them) and must not become a
      // cheerful "I'll DM you" over a DM nobody will receive.
      return { write, ok: false, error: "no phone number on file at write time" };
    }
    await deps.queueReminderDm({
      // The shipped shape: BotJob.phone carries no leading "+"
      // (`route.ts:3954`).
      phone: phone.replace(/^\+/, ""),
      text: composeReminderDm({ name: args.name, note: args.note }),
      sendAt: write.sendAt,
    });
    return { write, ok: true };
  } catch (err) {
    return { write, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
