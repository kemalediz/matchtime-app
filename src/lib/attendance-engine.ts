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
 * Prefix on every degradation this layer reports, so the analyze
 * route's partial-response admin DM can match a TYPED marker instead of
 * prefix-matching free-text reasoning. §9 keeps that net and says to
 * "fix the mechanism: under the new design it matches a typed error,
 * which is what it always wanted to be."
 */
export const ENGINE_APPLY_DEGRADED_PREFIX = "attendance-engine: degraded —";

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
