/**
 * §10 STEP 6 — THE APPLY LAYER.
 *
 * The engine decides; this is what turns a `ProposedWrite` into a row.
 * The decision half is already exhaustively tested in
 * `src/lib/pipeline/__tests__/engine.test.ts`. What is tested HERE is
 * the seam, because the seam is where a correct decision can still
 * become a wrong write:
 *
 *   • `registerAttendance` / `cancelAttendance` remain the ONLY way
 *     attendance changes, so every write keeps its `AttendanceEvent`
 *     inside the same transaction (PR #41). Asserted by scanning the
 *     source, not promised in a comment.
 *   • `benchIntent` is derived from `explicitBench`, which is the PR #27
 *     invariant: a BENCH row means FULL or ASKED, never "a classifier
 *     inferred it".
 *   • `promoteFromBench` follows the SHIPPED rule (the player's own IN),
 *     not the engine's projection, because the projection can be stale
 *     by the time the row is written and the stale direction loses a
 *     promotion the squad had room for.
 *   • the write log records the CAUSE, and a third-party write is never
 *     recorded as the subject's own.
 *   • a write that THROWS is surfaced, never swallowed — the honest-ack
 *     rule (`attendance-write-outcome.ts`, `9f19040`).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ENGINE_APPLY_DEGRADED_PREFIX,
  analyzedActionFor,
  applyEngineWrites,
  benchIntentFor,
  eventContextFor,
  isProvisionalUserId,
  promoteFromBenchFor,
  type EngineActor,
  type EngineApplyDeps,
} from "../attendance-engine";
import type { ProposedWrite } from "../pipeline/types";

type AttendanceWrite = Extract<ProposedWrite, { kind: "attendance" }>;

function write(over: Partial<AttendanceWrite> = {}): AttendanceWrite {
  return {
    kind: "attendance",
    userId: "u-najib",
    name: "Najib Ahmadi",
    status: "CONFIRMED",
    explicitBench: false,
    promote: false,
    sourceMessageId: "m1",
    reason: "slot 3 of 14",
    ...over,
  };
}

const SENDER: EngineActor = { userId: "u-najib", name: "Najib Ahmadi", isAdmin: false };
const ADMIN: EngineActor = { userId: "u-kemal", name: "Kemal Ediz", isAdmin: true };
const MEMBER: EngineActor = { userId: "u-sait", name: "Sait Demir", isAdmin: false };

// ── the pure derivations ────────────────────────────────────────────

describe("benchIntent (PR #27's invariant, carried across the seam)", () => {
  it("is undefined for anything that is not a BENCH row", () => {
    expect(benchIntentFor(write({ status: "CONFIRMED" }))).toBeUndefined();
    expect(benchIntentFor(write({ status: "DROPPED" }))).toBeUndefined();
  });

  it("is `explicit` only when a HUMAN named the bench", () => {
    expect(benchIntentFor(write({ status: "BENCH", explicitBench: true }))).toBe("explicit");
  });

  it("is `inferred` when the bench came from capacity, never `explicit`", () => {
    // The engine only emits BENCH with explicitBench=false when the
    // squad is full. Passing "inferred" makes `attendance.ts` re-decide
    // from capacity, so a squad that gained a slot between the state
    // load and the write CONFIRMS instead of parking someone on a bench
    // beside an empty slot — the 2026-08-31 incident, in miniature.
    expect(benchIntentFor(write({ status: "BENCH", explicitBench: false }))).toBe("inferred");
  });
});

describe("promoteFromBench", () => {
  it("is true for the player's OWN in — the shipped rule, not the projection", () => {
    // Kemal 2026-05-19: a benched player saying IN while the squad is
    // short must move into it. The engine may have projected
    // `promote:false` from a state loaded seconds earlier; the shipped
    // path asks the database at write time, and that is the direction
    // that cannot lose a slot.
    expect(promoteFromBenchFor(write({ status: "CONFIRMED", promote: false }), true)).toBe(true);
  });

  it("is false for a third party the sender is not authorised to promote", () => {
    // "Burak should come" must not promote Burak — he didn't ask.
    expect(promoteFromBenchFor(write({ status: "CONFIRMED", promote: false }), false)).toBe(false);
  });

  it("is true for a third party when the engine authorised the promotion", () => {
    // `isPromoteFromBenchAuthorized` already ran inside the engine: an
    // admin doing roster surgery, or a self-replace.
    expect(promoteFromBenchFor(write({ status: "CONFIRMED", promote: true }), false)).toBe(true);
  });

  it("is never set for a BENCH or DROPPED write", () => {
    expect(promoteFromBenchFor(write({ status: "BENCH" }), true)).toBe(false);
    expect(promoteFromBenchFor(write({ status: "DROPPED" }), true)).toBe(false);
  });
});

describe("the AttendanceEvent context (PR #41 — the cause, not just the effect)", () => {
  it("records a player's own claim as self-attendance, by the player", () => {
    const e = eventContextFor(write(), SENDER, true, "wa-1");
    expect(e).toMatchObject({
      cause: "self-attendance",
      actorKind: "player",
      actorUserId: "u-najib",
      sourceRef: "wa-1",
    });
  });

  it("never records someone else's write as the subject's own", () => {
    const e = eventContextFor(write({ userId: "u-najib" }), MEMBER, false, "wa-2");
    expect(e.cause).toBe("third-party-attendance");
    expect(e.actorKind).toBe("member");
    // The ACTOR is the sender, not the subject. A replay that cannot
    // tell those apart cannot tell a relay from roster surgery.
    expect(e.actorUserId).toBe("u-sait");
  });

  it("records an admin's roster surgery as admin-message", () => {
    const e = eventContextFor(write({ userId: "u-najib" }), ADMIN, false, "wa-3");
    expect(e.cause).toBe("admin-message");
    expect(e.actorKind).toBe("admin");
    expect(e.actorUserId).toBe("u-kemal");
  });

  it("records an authorised promotion as admin-message even from a non-admin self-replace", () => {
    // Mirrors the shipped mapping exactly (`route.ts` builds
    // `thirdPartyEvent` from `promoteAuthorized`), so the two paths'
    // rows stay comparable in the replay rather than diverging in a
    // column nobody would notice.
    const e = eventContextFor(write({ promote: true }), MEMBER, false, "wa-4");
    expect(e.cause).toBe("admin-message");
    expect(e.actorKind).toBe("admin");
  });

  it("carries a cause the closed set accepts, on every branch", async () => {
    const { ATTENDANCE_EVENT_CAUSES, ATTENDANCE_ACTOR_KINDS } = await import(
      "../attendance-events"
    );
    for (const actor of [SENDER, MEMBER, ADMIN]) {
      for (const self of [true, false]) {
        for (const promote of [true, false]) {
          const e = eventContextFor(write({ promote }), actor, self, "wa");
          expect(ATTENDANCE_EVENT_CAUSES).toContain(e.cause);
          expect(ATTENDANCE_ACTOR_KINDS).toContain(e.actorKind);
        }
      }
    }
  });
});

describe("provisional ids", () => {
  it("recognises the engine's placeholder for a guest with no member row", () => {
    expect(isProvisionalUserId("new:Kieran")).toBe(true);
    expect(isProvisionalUserId("cme8abc123")).toBe(false);
  });
});

describe("the AnalyzedMessage action label", () => {
  it("names what happened to the SENDER when the sender's own row moved", () => {
    expect(analyzedActionFor([write({ userId: "u-najib", status: "DROPPED" })], "u-najib")).toBe(
      "OUT",
    );
    expect(analyzedActionFor([write({ userId: "u-najib", status: "BENCH" })], "u-najib")).toBe(
      "BENCH",
    );
    expect(analyzedActionFor([write({ userId: "u-najib" })], "u-najib")).toBe("IN");
  });

  it("names the third-party write when the sender's own row did not move", () => {
    expect(analyzedActionFor([write({ userId: "u-other", status: "DROPPED" })], "u-najib")).toBe(
      "registerFor:OUT",
    );
  });

  it("is `none` when nothing was written", () => {
    expect(analyzedActionFor([], "u-najib")).toBe("none");
  });
});

// ── the apply itself ────────────────────────────────────────────────

function stubDeps(over: Partial<EngineApplyDeps> = {}): {
  deps: EngineApplyDeps;
  calls: string[];
} {
  const calls: string[] = [];
  const deps: EngineApplyDeps = {
    async registerAttendance(userId, matchId, options) {
      calls.push(
        `register(${userId},${matchId},bench=${options.benchIntent ?? "-"},promote=${!!options.promoteFromBench},cause=${options.event.cause})`,
      );
      return {
        status: options.benchIntent === "explicit" ? "BENCH" : "CONFIRMED",
        position: 1,
        slot: 1,
        confirmedCount: 1,
        maxPlayers: 14,
      };
    },
    async cancelAttendance(userId, matchId, event) {
      calls.push(`cancel(${userId},${matchId},cause=${event.cause})`);
      return { status: "DROPPED" as const };
    },
    async resolveOrProvision(name) {
      calls.push(`provision(${name})`);
      return { userId: `new-real:${name}` };
    },
    ...over,
  };
  return { deps, calls };
}

const ACTORS = new Map<string, EngineActor>([["m1", SENDER]]);

describe("applyEngineWrites", () => {
  it("routes an IN through registerAttendance and an OUT through cancelAttendance", async () => {
    const { deps, calls } = stubDeps();
    const res = await applyEngineWrites({
      matchId: "match-1",
      writes: [
        write({ userId: "u-x", name: "X", status: "DROPPED", sourceMessageId: "m1" }),
        write({ userId: "u-najib", status: "CONFIRMED", sourceMessageId: "m1" }),
      ],
      actorByMessageId: ACTORS,
      deps,
    });
    expect(res.every((r) => r.ok)).toBe(true);
    expect(calls).toEqual([
      "cancel(u-x,match-1,cause=third-party-attendance)",
      "register(u-najib,match-1,bench=-,promote=true,cause=self-attendance)",
    ]);
  });

  it("applies writes in the order the engine emitted them — OUT before IN", async () => {
    // The engine orders a replacement OUT-first so the slot is free
    // before it is filled. Re-ordering here would put the incoming
    // player on the bench and then drop the outgoing one, which is
    // exactly what the first live corpus sweep caught.
    const { deps, calls } = stubDeps();
    await applyEngineWrites({
      matchId: "m",
      writes: [
        write({ userId: "u-elnur", name: "Elnur", status: "DROPPED" }),
        write({ userId: "u-izzet", name: "Izzet", status: "CONFIRMED" }),
      ],
      actorByMessageId: ACTORS,
      deps,
    });
    expect(calls[0]).toContain("cancel(u-elnur");
    expect(calls[1]).toContain("register(u-izzet");
  });

  it("provisions a named guest the org has never seen, once, before writing", async () => {
    const { deps, calls } = stubDeps();
    const res = await applyEngineWrites({
      matchId: "m",
      writes: [write({ userId: "new:Kieran Rashad", name: "Kieran Rashad" })],
      actorByMessageId: ACTORS,
      deps,
    });
    expect(calls).toEqual([
      "provision(Kieran Rashad)",
      "register(new-real:Kieran Rashad,m,bench=-,promote=false,cause=third-party-attendance)",
    ]);
    expect(res[0].ok).toBe(true);
  });

  it("never provisions for a DROP — there is nobody to drop", async () => {
    const { deps, calls } = stubDeps();
    const res = await applyEngineWrites({
      matchId: "m",
      writes: [write({ userId: "new:Ghost", name: "Ghost", status: "DROPPED" })],
      actorByMessageId: ACTORS,
      deps,
    });
    expect(calls).toEqual([]);
    expect(res[0].ok).toBe(false);
  });

  it("surfaces a write that THREW instead of swallowing it", async () => {
    const { deps } = stubDeps({
      async registerAttendance() {
        throw new Error("Previous match hasn't been completed yet");
      },
    });
    const res = await applyEngineWrites({
      matchId: "m",
      writes: [write()],
      actorByMessageId: ACTORS,
      deps,
    });
    expect(res[0].ok).toBe(false);
    expect(res[0].error).toContain("Previous match");
    // The honest ack depends on this: a confirmation is never sent for
    // a write that did not land (9f19040).
  });

  it("carries on after a failure rather than abandoning the rest of the batch", async () => {
    let n = 0;
    const { deps, calls } = stubDeps({
      async registerAttendance(userId, matchId, options) {
        n++;
        if (n === 1) throw new Error("boom");
        calls.push(`register(${userId})`);
        return {
          status: "CONFIRMED" as const,
          position: 1,
          slot: 1,
          confirmedCount: 1,
          maxPlayers: 14,
        };
      },
    });
    const res = await applyEngineWrites({
      matchId: "m",
      writes: [write({ userId: "u-a", name: "A" }), write({ userId: "u-b", name: "B" })],
      actorByMessageId: ACTORS,
      deps,
    });
    expect(res.map((r) => r.ok)).toEqual([false, true]);
    expect(calls).toContain("register(u-b)");
  });

  it("reports the status the DATABASE returned, not the one the engine projected", async () => {
    // The engine projects against a state loaded before the batch. The
    // row is what the group is told about, so the react and the ack
    // follow the row.
    const { deps } = stubDeps();
    const res = await applyEngineWrites({
      matchId: "m",
      writes: [write({ status: "BENCH", explicitBench: false })],
      actorByMessageId: ACTORS,
      deps,
    });
    expect(res[0].status).toBe("CONFIRMED");
  });

  it("refuses a write kind that cannot reach it, loudly", async () => {
    // The engine only ever sees attendance facts on the three routes
    // step 6 owns, so a score/payment/reminder write here means a bug
    // upstream. Silence would be the failure mode this design exists to
    // remove.
    const { deps, calls } = stubDeps();
    const res = await applyEngineWrites({
      matchId: "m",
      writes: [
        {
          kind: "score",
          matchId: "m",
          red: 3,
          yellow: 2,
          sourceMessageId: "m1",
          reason: "x",
        },
      ],
      actorByMessageId: ACTORS,
      deps,
    });
    expect(calls).toEqual([]);
    expect(res[0].ok).toBe(false);
    expect(res[0].error).toContain("score");
  });

  it("leaves bench-offer bookkeeping to the shipped apply path", async () => {
    // `cancelAttendance` opens the offer (`requestBenchConfirmationOnDrop`)
    // and `registerAttendance` closes stale ones. Applying the engine's
    // proposed offer writes on top of that would double-open them and
    // re-litigate the 2026-05-19 Karahan design, which §13 says must be
    // preserved exactly.
    const { deps, calls } = stubDeps();
    const res = await applyEngineWrites({
      matchId: "m",
      writes: [
        {
          kind: "open_bench_offer",
          replacingUserId: "u-x",
          offeredToUserIds: ["u-y"],
          sourceMessageId: "m1",
          reason: "x",
        },
      ],
      actorByMessageId: ACTORS,
      deps,
    });
    expect(calls).toEqual([]);
    expect(res).toEqual([]);
  });
});

// ── the structural guarantee ────────────────────────────────────────

describe("registerAttendance / cancelAttendance stay the only way in", () => {
  const SRC = fs.readFileSync(
    path.resolve(__dirname, "..", "attendance-engine.ts"),
    "utf8",
  );

  it("the apply layer touches no Prisma model directly", () => {
    // A direct `db.attendance.update` here would write the row WITHOUT
    // the `AttendanceEvent` that `attendance.ts` writes in the same
    // transaction, and the replay harness step 6 is judged by would
    // silently stop covering the path that moved.
    const offenders = SRC.split("\n")
      .map((l, i) => ({ l, i: i + 1 }))
      .filter(({ l }) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .filter(({ l }) => /\bdb\s*\.\s*\w+\s*\.\s*(create|update|upsert|delete)/.test(l))
      .map(({ l, i }) => `attendance-engine.ts:${i} — ${l.trim()}`);
    expect(offenders).toEqual([]);
  });

  it("does not import the database client at all", () => {
    expect(SRC).not.toMatch(/from\s+["']\.\/db["']/);
  });

  it("the degraded marker is a typed prefix, not free prose", () => {
    expect(ENGINE_APPLY_DEGRADED_PREFIX).toMatch(/^attendance-engine:/);
  });
});
