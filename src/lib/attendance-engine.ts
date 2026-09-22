/**
 * §10 STEP 6 — THE APPLY LAYER.
 *
 *   "Swap the attendance path to extractor + engine. `self_att`,
 *    `other_att`, `offer` only — the three routes covering every
 *    incident in the archive. Everything else still runs the old
 *    prompt."
 *
 * `src/lib/pipeline/` decides and composes and is forbidden from
 * writing — `pipeline/__tests__/zero-writes.test.ts` scans it on every
 * build. This module is the other side of that line: it takes the
 * engine's `ProposedWrite`s and makes them real. It lives OUTSIDE
 * `pipeline/` for exactly that reason, so the dry run stays a dry run.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE ONE RULE
 * ─────────────────────────────────────────────────────────────────────
 * `registerAttendance` and `cancelAttendance` remain the only way
 * attendance changes. Not "mostly", not "except for the fast case".
 * They are where the row and its `AttendanceEvent` are written in ONE
 * transaction (PR #41, `attendance.ts:229-272`), where the in-flight
 * previous-match guard lives, where a drop opens the bench offer and a
 * confirm closes the stale one, and where the squad-full announcement
 * fires. A second writer would have to reimplement all of it and would
 * get one of them wrong.
 *
 * So this module imports neither `db` nor Prisma. Its dependencies are
 * injected, which is also what makes the seam unit-testable without a
 * database — and a test asserts the absence by scanning this file,
 * because a comment saying so is worth nothing (four seatbelts were
 * found dead on 2026-08-31, all with comments claiming they worked).
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * ─────────────────────────────────────────────────────────────────────
 *   • It does not open or resolve `BenchSlotOffer`s. The engine
 *     PROPOSES them so the dry run can be diffed, but on the real path
 *     `cancelAttendance` → `requestBenchConfirmationOnDrop` already
 *     owns that, and `registerAttendance` already closes the stale
 *     ones. §13: "the bench-offer model … preserve the semantics
 *     exactly." Applying the proposals on top would double-open them.
 *   • It does not compose copy. `pipeline/compose.ts` does, from the
 *     projected state, and the analyze route re-composes the squad post
 *     from a fresh snapshot after every write in the batch has landed.
 *   • It does not decide. Every branch below is a mechanical
 *     translation of a field the engine already set.
 */
import type { BenchIntent, registerAttendance, cancelAttendance } from "./attendance";
import type { AttendanceEventContext } from "./attendance-events";
import type { AttStatus, ProposedWrite } from "./pipeline/types";

export type EngineAttendanceWrite = Extract<ProposedWrite, { kind: "attendance" }>;

/** The person who SENT the message a write came from. Never the
 *  subject — those are the same only for a self claim. */
export interface EngineActor {
  userId: string | null;
  name: string | null;
  isAdmin: boolean;
}

/**
 * Prefix on every degradation this layer reports. §9 keeps the
 * partial-response net and says to "fix the mechanism: under the new
 * design it matches a typed error, which is what it always wanted to
 * be."
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
 */
export const ENGINE_APPLY_DEGRADED_PREFIX = "attendance-engine: degraded —";

/**
 * `AnalyzedMessage.handledBy` for a message the engine decided.
 *
 * The AUDIT field, not the wire field — same split step 5 made for
 * `router-gate`. `whatsapp-bot/src/api.ts:325` types the HTTP
 * response's `handledBy` as a closed union and that file is out of
 * scope, so the wire keeps saying `llm`; this makes "what did the
 * engine decide, and what did it write?" a single query against the
 * admin log rather than an archaeology exercise.
 */
export const ENGINE_HANDLED_BY = "attendance-engine";

/** The engine's placeholder for a named guest with no member row yet
 *  (`engine.ts:1061`, `userId = \`new:${name}\``). */
const PROVISIONAL_PREFIX = "new:";

export function isProvisionalUserId(userId: string): boolean {
  return userId.startsWith(PROVISIONAL_PREFIX);
}

// ── The derivations. All pure, all mechanical. ──────────────────────

/**
 * PR #27's invariant, carried across the seam.
 *
 * `explicitBench` is true on a write only when a HUMAN named the bench
 * and attached no condition to it (`engine.ts:1090`). That is precisely
 * `BenchIntent: "explicit"` — honoured at any capacity.
 *
 * Everything else that lands on BENCH got there because the squad was
 * full, and is reported as `"inferred"`, which `attendance.ts` treats
 * as "re-decide from capacity". That matters when the squad gained a
 * slot between the state load and the write: `"explicit"` would park
 * the player on a bench beside an empty slot, which is the 2026-08-31
 * incident.
 */
export function benchIntentFor(w: EngineAttendanceWrite): BenchIntent | undefined {
  if (w.status !== "BENCH") return undefined;
  return w.explicitBench ? "explicit" : "inferred";
}

/**
 * Should a bench player be promoted into a free slot?
 *
 * For the player's OWN claim: always. That is the shipped rule
 * (`route.ts:2758`, Kemal 2026-05-19 — "a benched player saying IN
 * while the squad is short must move to the squad"), and it is
 * deliberately taken from the SHAPE of the write rather than from the
 * engine's `promote` projection. The engine decided against a state
 * loaded at the top of the batch; `registerAttendance` re-counts
 * CONFIRMED inside the write. Trusting the projection here would leave
 * a bencher on the bench whenever a slot opened in between — a missed
 * write, and the recoverable direction is the other one.
 *
 * For a third party: only when the engine's own authorisation pass
 * (`promote-authorization.ts`, reused unchanged) said so. A random
 * member saying "Burak should come" must not promote Burak.
 */
export function promoteFromBenchFor(w: EngineAttendanceWrite, isSelf: boolean): boolean {
  if (w.status !== "CONFIRMED") return false;
  return isSelf || w.promote;
}

/**
 * WHY this row moved, for the append-only log (PR #41).
 *
 * The mapping mirrors `route.ts:2872-2877` exactly rather than
 * improving on it, so a replay comparing the two paths is comparing
 * decisions and not a column that quietly changed meaning. The one
 * consequence worth naming: a non-admin SELF-REPLACE is recorded as
 * `admin-message` / `admin` on both paths, because both derive it from
 * "was this promotion authorised", and the self-replace is authorised.
 */
export function eventContextFor(
  w: EngineAttendanceWrite,
  actor: EngineActor,
  isSelf: boolean,
  sourceRef: string,
): AttendanceEventContext {
  if (isSelf) {
    return {
      cause: "self-attendance",
      actorKind: "player",
      actorUserId: actor.userId,
      sourceRef,
    };
  }
  const authoritative = actor.isAdmin || w.promote;
  return {
    cause: authoritative ? "admin-message" : "third-party-attendance",
    actorKind: authoritative ? "admin" : "member",
    actorUserId: actor.userId,
    sourceRef,
  };
}

/**
 * `AnalyzedMessage.action` for a message the engine decided.
 *
 * Cold-audit 1.3 is that this column records the INTENT rather than the
 * outcome. Here it can only ever record the outcome, because the only
 * input is the set of writes that actually landed.
 */
export function analyzedActionFor(
  writes: EngineAttendanceWrite[],
  senderUserId: string | null,
): string {
  if (writes.length === 0) return "none";
  const own = senderUserId ? writes.find((w) => w.userId === senderUserId) : undefined;
  const label = (s: AttStatus) => (s === "CONFIRMED" ? "IN" : s === "BENCH" ? "BENCH" : "OUT");
  if (own) return label(own.status);
  return `registerFor:${label(writes[0].status)}`;
}

// ── The apply ───────────────────────────────────────────────────────

export interface EngineApplyDeps {
  registerAttendance: typeof registerAttendance;
  cancelAttendance: typeof cancelAttendance;
  /** Resolve a named person to a member, provisioning one if the org
   *  has never seen them. Injected because the analyze route owns the
   *  provisioning policy (`resolveOrProvisionByName`) and this module
   *  must not grow a second one. */
  resolveOrProvision: (name: string) => Promise<{ userId: string } | null>;
  /**
   * MOVE ONE `TeamAssignment` ROW from the player who left to the player
   * who replaced him (2026-09-22). Returns whether there was a row to
   * move.
   *
   * Injected for the same reason `resolveOrProvision` is: this module
   * decides nothing and reaches nothing, and the delete-plus-upsert
   * transaction already exists twice (`bench-confirmation.ts`,
   * `analyze/route.ts`'s slot transfer). The caller passes the one it
   * already owns rather than a third copy being written here.
   */
  transferTeamSlot: (args: {
    matchId: string;
    fromUserId: string;
    toUserId: string;
  }) => Promise<"moved" | "no-slot">;
}

export interface EngineWriteResult {
  write: EngineAttendanceWrite;
  /** The id actually written to, after provisioning. */
  userId: string | null;
  ok: boolean;
  /** The status the DATABASE settled on — not the engine's projection.
   *  Reacts and acks follow this. */
  status?: AttStatus;
  error?: string;
}

export async function applyEngineWrites(args: {
  matchId: string;
  writes: ProposedWrite[];
  /** Sender per source message id. */
  actorByMessageId: Map<string, EngineActor>;
  deps: EngineApplyDeps;
}): Promise<EngineWriteResult[]> {
  const { matchId, writes, actorByMessageId, deps } = args;
  const out: EngineWriteResult[] = [];

  for (const w of writes) {
    // Bench-offer bookkeeping belongs to `attendance.ts` (see the
    // header). Proposals are recorded by the dry run and ignored here.
    if (w.kind === "open_bench_offer" || w.kind === "resolve_bench_offer") continue;

    // ── THE REPLACEMENT'S TEAM SLOT ────────────────────────────────
    //
    // The engine emits this only after BOTH attendance writes, and the
    // loop is in order, so by the time it lands the donor is DROPPED
    // and the receiver is CONFIRMED. Both ids are resolved members (the
    // pairing refuses anything else), so nothing is provisioned here.
    //
    // A FAILURE IS REPORTED, NEVER SWALLOWED. The attendance half has
    // already landed, so the squad is right either way; what a silent
    // catch would hide is a team sheet still naming a man who is not
    // coming, which is the incident this whole change is about.
    if (w.kind === "inherit_team_slot") {
      try {
        await deps.transferTeamSlot({
          matchId,
          fromUserId: w.fromUserId,
          toUserId: w.toUserId,
        });
        // Nothing to report on success, for the same reason the bench
        // offers report nothing: no attendance row moved, so there is
        // no row for `intentFor`, `analyzedActionFor` or the react to
        // read. The squad is already right and the composer has already
        // said who is on which side.
      } catch (err) {
        // NEVER SWALLOWED (the 9f19040 rule). The composer has ALREADY
        // told the group that this player takes that side, so a caught
        // exception here would leave a cheerful line standing over a
        // team sheet that still names a man who is not coming, which
        // is the 2026-09-22 incident rebuilt inside the fix for it.
        //
        // Reported as a failure about the RECEIVER's row, which is what
        // it is: his attendance landed, his place on the sheet did not.
        // `attendance-write-outcome.ts` replaces the reply with the
        // truth from here.
        out.push({
          write: {
            kind: "attendance",
            userId: w.toUserId,
            name: w.toName,
            status: "CONFIRMED",
            explicitBench: false,
            promote: false,
            sourceMessageId: w.sourceMessageId,
            reason: w.reason,
          },
          userId: w.toUserId,
          ok: false,
          error: `could not move ${w.fromName}'s ${w.team} slot to ${w.toName}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
      continue;
    }

    if (w.kind !== "attendance") {
      // Unreachable: the engine only produces these from `question`,
      // `score` and `admin_ops` facts, and step 6 owns none of those
      // routes. Reported rather than skipped, because a silent skip is
      // how a decision disappears.
      out.push({
        write: w as unknown as EngineAttendanceWrite,
        userId: null,
        ok: false,
        error: `a "${w.kind}" write reached the attendance apply layer; step 6 owns only self_att, other_att and offer`,
      });
      continue;
    }

    const actor = actorByMessageId.get(w.sourceMessageId) ?? {
      userId: null,
      name: null,
      isAdmin: false,
    };

    // Provision a named guest the org has never seen. Only ever for an
    // ADD — the engine already refuses relationships, quantities,
    // indefinites and raw digits (`identity.ts`), so what arrives here
    // is a usable name.
    let userId = w.userId;
    if (isProvisionalUserId(userId)) {
      if (w.status === "DROPPED") {
        out.push({
          write: w,
          userId: null,
          ok: false,
          error: `refusing to provision "${w.name}" in order to drop them`,
        });
        continue;
      }
      try {
        const target = await deps.resolveOrProvision(w.name);
        if (!target) {
          out.push({
            write: w,
            userId: null,
            ok: false,
            error: `could not resolve or provision "${w.name}"`,
          });
          continue;
        }
        userId = target.userId;
      } catch (err) {
        out.push({
          write: w,
          userId: null,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    }

    const isSelf = !!actor.userId && actor.userId === userId;

    try {
      if (w.status === "DROPPED") {
        await deps.cancelAttendance(
          userId,
          matchId,
          eventContextFor(w, actor, isSelf, w.sourceMessageId),
        );
        out.push({ write: w, userId, ok: true, status: "DROPPED" });
      } else {
        const res = await deps.registerAttendance(userId, matchId, {
          benchIntent: benchIntentFor(w),
          promoteFromBench: promoteFromBenchFor(w, isSelf),
          event: eventContextFor(w, actor, isSelf, w.sourceMessageId),
        });
        out.push({ write: w, userId, ok: true, status: res.status as AttStatus });
      }
    } catch (err) {
      // NEVER swallowed. A thrown write means no row moved, so any
      // cheerful ack would be a lie — the caller replaces it with the
      // truth (`attendance-write-outcome.ts`, the 9f19040 rule).
      out.push({
        write: w,
        userId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return out;
}
