/**
 * The append-only attendance event log.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY
 * ─────────────────────────────────────────────────────────────────────
 * `Attendance` records what a squad IS. Nothing recorded what it WAS.
 *
 * That is not a cosmetic gap. `e2e/replay/` replays real production
 * history through a candidate pipeline and diffs the outcomes; it is
 * the evidence base for §10 step 6 of
 * `MDs/analyzer-redesign-2026-08-31.md`, the step that swaps the
 * attendance WRITE path and the only one that can put a player at a
 * pitch with no slot. Measured on 2026-09-01, that harness can replay
 * **447 of 1,723 messages (25.9%)**, and the single biggest reason for
 * the rest — 1,149 messages — is `attendance-state-unknown`: a row that
 * existed before a batch and was touched after it has an unknowable
 * status AT that instant. Sutton's per-player payment metadata (live
 * since 2026-06-09) keeps bumping `updatedAt` on settled rows for days
 * after the whistle, which widens it further.
 *
 * This log closes that going FORWARD. It cannot recover a single one of
 * the 1,149 messages already on disk — nothing can — but from the day
 * it is applied, every future batch is reconstructable.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE THREE RULES
 * ─────────────────────────────────────────────────────────────────────
 * 1. **Append-only.** Never updated, never deleted. Enforced by a
 *    Postgres trigger (`attendance_event_no_mutate`), not by
 *    convention — the whole value of this table is that it is the one
 *    thing in the system that cannot be rewritten.
 * 2. **Same transaction as the change it records.** A log written next
 *    to the write instead of inside it can disagree with the state,
 *    and a log that can disagree with the state is not evidence.
 *    Every caller here passes the transaction client.
 * 3. **The cause, not just the effect.** A DROPPED row that came from a
 *    bench claim and one that came from a player's own OUT are
 *    identical afterwards and completely different facts. The replay
 *    needs the difference, so the caller has to name it — and a cause
 *    this module does not recognise is REFUSED rather than stored,
 *    because a typo silently becoming a hole in an audit log is the
 *    exact failure mode this table exists to end.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT THIS MODULE IS NOT
 * ─────────────────────────────────────────────────────────────────────
 * It changes no behaviour. Nothing reads it on the write path, no
 * decision branches on it, and a caller cannot influence the squad
 * through it. It is observation, and it is meant to stay that way.
 */
import type { AttendanceStatus } from "@/generated/prisma/enums";

/** `null` means "no Attendance row" — before a first registration, or
 *  after the row was deleted outright. */
export type AttendanceStatusLike = AttendanceStatus | null;

/**
 * WHY a transition happened. Closed set: `recordAttendanceEvent`
 * refuses anything not on this list.
 *
 * These name the TRIGGER, not the outcome. "a bench player claimed the
 * slot" and "the player said IN" can both end in CONFIRMED and are not
 * the same event.
 */
export const ATTENDANCE_EVENT_CAUSES = [
  /** The player's own claim or withdrawal — a group message, a DM, or
   *  the web app. `actorUserId` is the player themselves. */
  "self-attendance",
  /** Another member registered or dropped them ("Najib's in", "Amir
   *  can't make it"). `actorUserId` is the SENDER, not the subject. */
  "third-party-attendance",
  /** A bench player claimed a vacated slot by reacting 👍 to a
   *  BenchSlotOffer. `sourceRef` is the offer id. */
  "bench-claim",
  /** An admin screen: add to match, remove from match, move up from
   *  bench, promote onto a team. */
  "admin-squad-edit",
  /** An admin's chat instruction did roster surgery ("put Amir in the
   *  team", "move X to the bench"). */
  "admin-message",
  /** The match's format changed (5-a-side ⇄ 7-a-side) and the squad was
   *  recut against the new capacity. Whole-squad, one transaction. */
  "format-switch",
  /** A posted squad list was extracted and written to the DB
   *  (`featureSquadFromList` orgs). */
  "pasted-roster",
  /** An admin linked an unresolved pushname to a player and the most
   *  recent attendance intent was replayed onto the squad. */
  "unresolved-link",
  /** Duplicate User rows were merged; this row was remapped to the
   *  survivor or dropped as the loser of a unique-key clash. */
  "player-merge",
  /** A one-off maintenance script. Also the fallback recorded when a
   *  caller supplies no context at all, so an unattributed write is
   *  VISIBLE in the log rather than missing from it. */
  "maintenance-script",
  /** e2e fixture seeding. Never occurs in production. */
  "test-fixture",
] as const;

export type AttendanceEventCause = (typeof ATTENDANCE_EVENT_CAUSES)[number];

/** WHO caused it. Same closed-set treatment as the cause. */
export const ATTENDANCE_ACTOR_KINDS = [
  /** The subject themselves. */
  "player",
  /** Another member of the club, not an admin. */
  "member",
  /** An org OWNER/ADMIN, through a screen or a chat instruction. */
  "admin",
  /** A cron / the bot scheduler, with no human in the loop. */
  "scheduler",
  /** The application acting on its own (a merge, a format recut). */
  "system",
  /** A `scripts/*.ts` one-off run by hand. */
  "script",
] as const;

export type AttendanceActorKind = (typeof ATTENDANCE_ACTOR_KINDS)[number];

export interface AttendanceEventContext {
  cause: AttendanceEventCause;
  actorKind: AttendanceActorKind;
  /** The user who caused it. Null for scheduler/system/script. */
  actorUserId?: string | null;
  /** WhatsApp message id, analyze batch id, BenchSlotOffer id, script
   *  name. Free-form provenance; never parsed. */
  sourceRef?: string | null;
  /** Triage detail for a human. Never parsed, never branched on. */
  note?: string | null;
}

/**
 * The context recorded when a caller supplies none. Only reachable from
 * `scripts/*` (which TypeScript does not check — see tsconfig's
 * `exclude`); every path under `src/` is required by the type system to
 * pass a real one.
 *
 * It deliberately writes an event rather than skipping one. An
 * unattributed transition that is IN the log and says so is a fact you
 * can act on; one that is missing is the hole this table exists to end.
 */
export const UNATTRIBUTED_ATTENDANCE_CONTEXT: AttendanceEventContext = {
  cause: "maintenance-script",
  actorKind: "script",
  note: "no attendance-event context was supplied by the caller",
};

export interface AttendanceTransition {
  matchId: string;
  userId: string;
  orgId: string;
  fromStatus: AttendanceStatusLike;
  toStatus: AttendanceStatusLike;
  fromPosition?: number | null;
  toPosition?: number | null;
}

/**
 * The narrowest possible view of a Prisma client: everything this
 * module needs is `attendanceEvent.create`.
 *
 * Structural, not `Prisma.TransactionClient`, for one specific reason —
 * the app's `db` is an EXTENDED client (`src/lib/db.ts`), so the
 * interactive-transaction client's nominal type differs from the base
 * one and a caller would have to fight the generics to pass `tx`. A
 * structural type accepts `db`, `tx`, and a test double identically,
 * which is what keeps rule 2 (same transaction) cheap enough that every
 * caller actually obeys it.
 */
export interface AttendanceEventSink {
  attendanceEvent: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

/**
 * Append one transition.
 *
 * MUST be called with the same `tx` as the attendance write it
 * describes. Throws on an unrecognised cause or actor — see rule 3.
 * A transition where nothing actually changed writes nothing.
 */
export async function recordAttendanceEvent(
  sink: AttendanceEventSink,
  transition: AttendanceTransition,
  context: AttendanceEventContext,
): Promise<void> {
  if (!(ATTENDANCE_EVENT_CAUSES as readonly string[]).includes(context.cause)) {
    throw new Error(
      `attendance-events: unknown cause "${context.cause}". ` +
        `Add it to ATTENDANCE_EVENT_CAUSES deliberately — a cause nobody declared is a ` +
        `hole in the audit log, which is the thing this table exists to prevent.`,
    );
  }
  if (!(ATTENDANCE_ACTOR_KINDS as readonly string[]).includes(context.actorKind)) {
    throw new Error(
      `attendance-events: unknown actorKind "${context.actorKind}". ` +
        `One of: ${ATTENDANCE_ACTOR_KINDS.join(", ")}.`,
    );
  }

  const fromPosition = transition.fromPosition ?? null;
  const toPosition = transition.toPosition ?? null;
  // A no-op write is not a transition. registerAttendance is idempotent
  // by design, and an audit log full of "CONFIRMED → CONFIRMED" makes
  // the real moves harder to see, not easier.
  if (transition.fromStatus === transition.toStatus && fromPosition === toPosition) return;

  await sink.attendanceEvent.create({
    data: {
      matchId: transition.matchId,
      userId: transition.userId,
      orgId: transition.orgId,
      fromStatus: transition.fromStatus,
      toStatus: transition.toStatus,
      fromPosition,
      toPosition,
      cause: context.cause,
      actorKind: context.actorKind,
      actorUserId: context.actorUserId ?? null,
      sourceRef: context.sourceRef ?? null,
      note: context.note ?? null,
    },
  });
}

// ── Reconstruction ─────────────────────────────────────────────────────

/** The shape `squadStateAt` needs. Satisfied by a Prisma
 *  `AttendanceEvent` row and by the replay harness's extract alike. */
export interface AttendanceEventLike {
  matchId: string;
  userId: string;
  fromStatus: AttendanceStatusLike;
  toStatus: AttendanceStatusLike;
  toPosition?: number | null;
  at: string | Date;
}

export interface SquadPlace {
  userId: string;
  status: AttendanceStatus;
  position: number;
}

function ms(at: string | Date): number {
  return at instanceof Date ? at.getTime() : new Date(at).getTime();
}

/**
 * The squad as it stood at `instant`, rebuilt from the log ALONE.
 *
 * This is the function the whole table is for: given the events, the
 * state of any past moment is a fold, and the replay harness stops
 * having to guess. PURE — no DB, no clock, no ordering assumptions
 * about the input (it sorts).
 *
 * `matchId` narrows a mixed log to one match; omit it when the caller
 * has already filtered. Events at exactly `instant` are INCLUDED, so a
 * caller wanting "the world a batch landed in" passes the instant the
 * batch STARTED — which is what `e2e/replay/reconstruct.ts` does.
 */
export function squadStateAt(
  events: AttendanceEventLike[],
  instant: string | Date,
  matchId?: string,
): SquadPlace[] {
  const t = ms(instant);
  const relevant = events
    .filter((e) => (matchId ? e.matchId === matchId : true))
    .filter((e) => ms(e.at) <= t)
    .sort((a, b) => ms(a.at) - ms(b.at) || a.userId.localeCompare(b.userId));

  const state = new Map<string, SquadPlace>();
  for (const e of relevant) {
    if (e.toStatus === null) {
      state.delete(e.userId);
      continue;
    }
    const prior = state.get(e.userId);
    state.set(e.userId, {
      userId: e.userId,
      status: e.toStatus,
      position: e.toPosition ?? prior?.position ?? 0,
    });
  }

  return [...state.values()].sort(
    (a, b) => a.position - b.position || a.userId.localeCompare(b.userId),
  );
}
