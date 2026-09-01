/**
 * The reconstruction rules, under test.
 *
 * The single thing this file exists to pin: **a world that cannot be
 * proven is EXCLUDED, never guessed.** A fabricated world produces a
 * fabricated diff, and a fabricated diff is worse than no diff at all
 * because it reads exactly like a real one.
 */
import { describe, expect, it } from "vitest";
import { reconstruct, BATCH_JOIN_MS, BATCH_AMBIGUOUS_MS } from "./reconstruct";
import type { RawAttendance, RawMessage, ReplaySource } from "./types";

const ORG = "org-1";
const GROUP = "1203630000@g.us";
const KICKOFF = "2026-05-12T20:30:00.000Z";
/** 2 h before kickoff. */
const T0 = "2026-05-12T18:30:00.000Z";

function iso(base: string, msOffset: number): string {
  return new Date(new Date(base).getTime() + msOffset).toISOString();
}

function msg(over: Partial<RawMessage> & { waMessageId: string; createdAt: string }): RawMessage {
  return {
    orgId: ORG,
    groupId: GROUP,
    authorUserId: "u-pete",
    authorName: "Pete Power",
    authorHadPhone: false,
    body: "in",
    intent: "in",
    action: "registered",
    handledBy: "llm",
    ...over,
  };
}

function att(over: Partial<RawAttendance> & { userId: string }): RawAttendance {
  return {
    matchId: "m-1",
    status: "CONFIRMED",
    position: 1,
    // Settled long before the batch: created and last touched yesterday.
    createdAt: "2026-05-11T09:00:00.000Z",
    updatedAt: "2026-05-11T09:00:00.000Z",
    ...over,
  };
}

function source(over: Partial<ReplaySource> = {}): ReplaySource {
  return {
    messages: [msg({ waMessageId: "w1", createdAt: T0 })],
    matches: [
      {
        id: "m-1",
        orgId: ORG,
        activityId: "a-1",
        date: KICKOFF,
        maxPlayers: 14,
        status: "COMPLETED",
        attendanceDeadline: KICKOFF,
        redScore: null,
        yellowScore: null,
        createdAt: "2026-05-05T09:00:00.000Z",
        updatedAt: "2026-05-13T09:00:00.000Z",
      },
    ],
    attendance: [att({ userId: "u-dan" }), att({ userId: "u-gina", status: "BENCH" })],
    memberships: [
      { orgId: ORG, userId: "u-pete", role: "PLAYER", createdAt: "2026-04-01T00:00:00.000Z", leftAt: null },
      { orgId: ORG, userId: "u-dan", role: "OWNER", createdAt: "2026-04-01T00:00:00.000Z", leftAt: null },
      { orgId: ORG, userId: "u-gina", role: "PLAYER", createdAt: "2026-04-01T00:00:00.000Z", leftAt: null },
    ],
    users: [
      { id: "u-pete", name: "Pete Power", hasPhone: true },
      { id: "u-dan", name: "Dan Drummer", hasPhone: true },
      { id: "u-gina", name: "Gina Gale", hasPhone: false },
    ],
    orgs: [{ id: ORG, name: "Test FC", features: { attendance: true, bench: true } }],
    teamAssignments: [],
    benchOffers: [],
    ...over,
  };
}

describe("reconstruct — a clean batch", () => {
  it("builds a case whose world is the world the message landed in", () => {
    const r = reconstruct(source());
    expect(r.excluded).toEqual([]);
    expect(r.cases).toHaveLength(1);

    const c = r.cases[0];
    expect(c.meta.tier).toBe("strict");
    expect(c.meta.maxPlayers).toBe(14);
    // 18:30 → 20:30 kickoff.
    expect(c.meta.hoursToKickoff).toBeCloseTo(2, 3);
    expect(c.meta.squadBefore).toEqual({ confirmed: 1, bench: 1, dropped: 0 });

    // Kickoff fidelity is carried as HOURS, not days: a message two
    // hours before kickoff and one two days before are different worlds.
    expect(c.case.world.upcomingMatchInHours).toBeCloseTo(2, 3);
    expect(c.case.world.maxPlayers).toBe(14);
    expect(c.case.world.attendance).toEqual([
      { key: "u-dan", status: "CONFIRMED" },
      { key: "u-gina", status: "BENCH" },
    ]);
    // Roles and phone-on-record shape come from the roster at T.
    expect(c.case.world.players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "u-dan", name: "Dan Drummer", role: "OWNER" }),
        expect.objectContaining({ key: "u-gina", hasPhone: false }),
      ]),
    );
  });

  it("replays the sender exactly as WhatsApp delivered them: @lid, no phone", () => {
    const c = reconstruct(source()).cases[0];
    // 1,705 of the 1,723 production messages arrived with NO phone on
    // the wire (@lid privacy mode). The sender must be replayed by
    // pushname alone or the resolver takes a path production never did.
    expect(c.case.messages[0].from).toEqual({ name: "Pete Power", phone: "" });
    expect(c.case.messages[0].body).toBe("in");
  });

  it("carries production's own verdict as triage metadata, never as an expectation", () => {
    const c = reconstruct(source()).cases[0];
    expect(c.meta.prodOutcomes).toEqual([
      {
        waMessageId: expect.stringMatching(/^m-[0-9a-f]{12}$/),
        intent: "in",
        action: "registered",
        handledBy: "llm",
      },
    ]);
    // The incumbent is not ground truth: nothing it did becomes an
    // assertion. `expect` stays empty so the grader can never "pass" a
    // replay case by agreeing with the old pipeline.
    expect(c.case.expect).toEqual({});
  });
});

describe("reconstruct — batching", () => {
  it("groups one flush into one batch and splits on the 10-minute timer", () => {
    const s = source({
      messages: [
        msg({ waMessageId: "w1", createdAt: T0 }),
        msg({ waMessageId: "w2", createdAt: iso(T0, 120), body: "me too" }),
        msg({ waMessageId: "w3", createdAt: iso(T0, 10 * 60_000), body: "out" }),
      ],
    });
    const r = reconstruct(s);
    expect(r.cases).toHaveLength(2);
    expect(r.cases[0].case.messages.map((m) => m.body)).toEqual(["in", "me too"]);
    expect(r.cases[1].case.messages.map((m) => m.body)).toEqual(["out"]);
  });

  it("EXCLUDES both neighbours when the gap sits in the ambiguous band", () => {
    // Between BATCH_JOIN_MS and BATCH_AMBIGUOUS_MS, "one slow flush" and
    // "two quick flushes" are indistinguishable in the data. Guessing
    // either way invents a batch production never analysed.
    const gap = (BATCH_JOIN_MS + BATCH_AMBIGUOUS_MS) / 2;
    const s = source({
      messages: [
        msg({ waMessageId: "w1", createdAt: T0 }),
        msg({ waMessageId: "w2", createdAt: iso(T0, gap), body: "me too" }),
      ],
    });
    const r = reconstruct(s);
    expect(r.cases).toEqual([]);
    expect(r.excluded.map((e) => e.reason)).toEqual([
      "batch-boundary-ambiguous",
      "batch-boundary-ambiguous",
    ]);
  });
});

describe("reconstruct — what cannot be proven is excluded", () => {
  it("excludes a batch whose squad state at that instant is unknowable", () => {
    // The row existed before the batch and was touched after it. There
    // is no attendance audit log, so its status AT the batch instant is
    // not recoverable — and the whole point of a replay is the world.
    const s = source({
      attendance: [
        att({ userId: "u-dan" }),
        att({ userId: "u-gina", createdAt: "2026-05-11T09:00:00.000Z", updatedAt: "2026-05-12T19:00:00.000Z" }),
      ],
    });
    const r = reconstruct(s);
    expect(r.cases).toEqual([]);
    expect(r.excluded[0].reason).toBe("attendance-state-unknown");
    expect(r.excluded[0].detail).toContain("u-gina");
  });

  it("treats a row created AFTER the batch as simply absent, not unknown", () => {
    const s = source({
      attendance: [
        att({ userId: "u-dan" }),
        att({ userId: "u-gina", createdAt: "2026-05-12T19:00:00.000Z", updatedAt: "2026-05-12T19:30:00.000Z" }),
      ],
    });
    const r = reconstruct(s);
    expect(r.excluded).toEqual([]);
    expect(r.cases[0].case.world.attendance).toEqual([{ key: "u-dan", status: "CONFIRMED" }]);
  });

  it("excludes a batch with no upcoming match — a deleted match leaves no trace", () => {
    const r = reconstruct(source({ matches: [] }));
    expect(r.cases).toEqual([]);
    expect(r.excluded[0].reason).toBe("no-upcoming-match");
  });

  it("excludes a batch containing a body-less message", () => {
    const s = source({ messages: [msg({ waMessageId: "w1", createdAt: T0, body: null })] });
    const r = reconstruct(s);
    expect(r.cases).toEqual([]);
    expect(r.excluded[0].reason).toBe("no-body");
  });

  it("excludes a batch whose sender has neither a user nor a pushname", () => {
    const s = source({
      messages: [msg({ waMessageId: "w1", createdAt: T0, authorUserId: null, authorName: null })],
    });
    const r = reconstruct(s);
    expect(r.cases).toEqual([]);
    expect(r.excluded[0].reason).toBe("sender-unknown");
  });

  it("replays an unresolved-but-named sender as the outsider they were", () => {
    const s = source({
      messages: [
        msg({ waMessageId: "w1", createdAt: T0, authorUserId: null, authorName: "Ba", body: "who's playing" }),
      ],
    });
    const r = reconstruct(s);
    expect(r.cases).toHaveLength(1);
    expect(r.cases[0].case.messages[0].from).toEqual({ name: "Ba", phone: "" });
    expect(r.cases[0].meta.unresolvedSenders).toEqual(["Ba"]);
    expect(r.cases[0].case.world.players.map((p) => p.name)).not.toContain("Ba");
  });

  it("excludes members who had not joined yet, and includes those who left later", () => {
    const s = source({
      memberships: [
        { orgId: ORG, userId: "u-pete", role: "PLAYER", createdAt: "2026-04-01T00:00:00.000Z", leftAt: null },
        { orgId: ORG, userId: "u-dan", role: "OWNER", createdAt: "2026-04-01T00:00:00.000Z", leftAt: "2026-06-01T00:00:00.000Z" },
        { orgId: ORG, userId: "u-gina", role: "PLAYER", createdAt: "2026-07-01T00:00:00.000Z", leftAt: null },
      ],
      attendance: [att({ userId: "u-dan" })],
    });
    const keys = reconstruct(s).cases[0].case.world.players.map((p) => p.key);
    expect(keys).toContain("u-dan"); // left AFTER the batch → present at T
    expect(keys).not.toContain("u-gina"); // joined after the batch
  });
});

describe("reconstruct — tiers", () => {
  const previous = {
    id: "m-0",
    orgId: ORG,
    activityId: "a-1",
    date: "2026-05-05T20:30:00.000Z",
    maxPlayers: 14,
    status: "COMPLETED",
    attendanceDeadline: "2026-05-05T20:30:00.000Z",
    redScore: 3,
    yellowScore: 2,
    createdAt: "2026-04-28T09:00:00.000Z",
    // Still being written after the batch instant — the score and the
    // payment metadata land days later.
    updatedAt: "2026-05-13T09:00:00.000Z",
  };

  it('drops an unsettled completed match and says so, rather than inventing its state', () => {
    const s = source({ matches: [previous, ...source().matches] });
    const c = reconstruct(s).cases[0];
    expect(c.meta.tier).toBe("wide");
    expect(c.meta.caveats.join(" ")).toContain("completed match");
    expect(c.case.world.completedMatch).toBeUndefined();
  });

  it("includes a completed match that WAS settled, and stays strict", () => {
    const settled = { ...previous, updatedAt: "2026-05-06T09:00:00.000Z" };
    const s = source({
      matches: [settled, ...source().matches],
      attendance: [
        att({ userId: "u-dan" }),
        att({ userId: "u-gina", status: "BENCH" }),
        att({ matchId: "m-0", userId: "u-dan", createdAt: "2026-05-04T09:00:00.000Z", updatedAt: "2026-05-06T09:00:00.000Z" }),
      ],
    });
    // Settled = the Match row and every attendance row stopped changing
    // BEFORE the batch instant (T0 = 2026-05-12).
    const c = reconstruct(s).cases[0];
    expect(c.meta.tier).toBe("strict");
    expect(c.meta.caveats).toEqual([]);
    expect(c.case.world.completedMatch).toEqual({
      hoursAgo: expect.closeTo(166, 0),
      confirmedKeys: ["u-dan"],
      redScore: 3,
      yellowScore: 2,
    });
  });
});

describe("reconstruct — chat history", () => {
  it("forwards the preceding messages as the Pi's buffer, oldest first", () => {
    const s = source({
      messages: [
        msg({ waMessageId: "w0", createdAt: iso(T0, -3600_000), body: "anyone for tuesday" }),
        msg({ waMessageId: "w1", createdAt: T0 }),
      ],
    });
    const r = reconstruct(s);
    const last = r.cases[r.cases.length - 1];
    // The Pi's buffer is the last 15 INBOUND messages and it is
    // recorded BEFORE the flush, so the batch's own messages are in it.
    expect(last.case.history?.map((h) => h.body)).toEqual(["anyone for tuesday", "in"]);
    expect(last.case.history?.[0].author).toBe("Pete Power");
  });

  it("caps the buffer at the 15 the Pi keeps", () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      msg({ waMessageId: `w${i}`, createdAt: iso(T0, i * 60_000), body: `m${i}` }),
    );
    const r = reconstruct(source({ messages }));
    const last = r.cases[r.cases.length - 1];
    expect(last.case.history).toHaveLength(15);
    expect(last.case.history?.[14].body).toBe("m19");
  });
});

describe("reconstruct — privacy", () => {
  it("hashes the WhatsApp message id, which embeds a phone AND the group JID", () => {
    const s = source({
      messages: [
        msg({ waMessageId: "false_447525334985-1607872139@g.us_ACD62BCA47B2B0B1", createdAt: T0 }),
      ],
    });
    const ref = reconstruct(s).cases[0].meta.prodOutcomes[0].waMessageId;
    expect(ref).toMatch(/^m-[0-9a-f]{12}$/);
    // Stable, so two extracts of the same history line up.
    expect(reconstruct(s).cases[0].meta.prodOutcomes[0].waMessageId).toBe(ref);
  });

  it("replaces a pushname that is itself a phone number", () => {
    const s = source({
      messages: [msg({ waMessageId: "w1", createdAt: T0, authorUserId: null, authorName: "+44 7700 900123" })],
    });
    const from = reconstruct(s).cases[0].case.messages[0].from as { name: string };
    expect(from.name).not.toMatch(/\d{5}/);
    expect(from.name).toMatch(/^Member /);
  });

  it("never emits a phone number or an @lid/@g.us JID", () => {
    const s = source({
      messages: [
        msg({ waMessageId: "w1", createdAt: T0, body: "call me on 07700900123 or +447700900124", authorHadPhone: true }),
      ],
    });
    const r = reconstruct(s);
    const blob = JSON.stringify(r);
    // The extract may legitimately contain a member's own words, which
    // is what the corpus already precedents. What must never appear is
    // a routable identifier.
    expect(blob).not.toContain("@g.us");
    expect(blob).not.toContain("@lid");
    expect(blob).not.toMatch(/\b0\d{9,10}\b/);
    expect(blob).not.toMatch(/\+?44\d{9,10}\b/);
  });
});

describe("reconstruct — stats", () => {
  it("reports replayability and the intent mix over what actually replays", () => {
    const s = source({
      messages: [
        msg({ waMessageId: "w1", createdAt: T0, intent: "noise", body: "😂" }),
        msg({ waMessageId: "w2", createdAt: iso(T0, 3600_000), body: null, intent: "in" }),
      ],
    });
    const r = reconstruct(s);
    expect(r.stats.messagesInSource).toBe(2);
    expect(r.stats.messagesReplayable).toBe(1);
    expect(r.stats.messagesExcluded).toBe(1);
    expect(r.stats.byReason["no-body"]).toEqual({ batches: 1, messages: 1 });
    expect(r.stats.intentDistribution).toEqual({ noise: 1 });
    expect(r.stats.intentDistributionAll).toEqual({ noise: 1, in: 1 });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// THE TWO FIXES (2026-09-01)
// ═══════════════════════════════════════════════════════════════════════
//
// The extract measured on 2026-09-01 replayed 447 of 1,723 messages. The
// two biggest reasons were both recording gaps, not analysis problems:
// no attendance audit log (1,149 messages) and no batch id (104). Both
// now exist. These cases pin how the harness USES them — and, just as
// important, that it does not use them where they do not apply.
//
// Neither fix recovers a single historical message. What they change is
// what tomorrow's extract can prove.

describe("reconstruct — the squad from the EVENT LOG rather than row timestamps", () => {
  /** When logging began — in production the first event for a row and
   *  the row itself are written in the SAME transaction, so a row is
   *  covered exactly when it was created at or after the epoch. */
  const LOG_EPOCH = "2026-05-12T10:00:00.000Z";

  /** A source whose attendance rows would be unknowable at T0 (touched
   *  after the batch) but whose history IS in the log. */
  function loggedSource(over: Partial<ReplaySource> = {}): ReplaySource {
    return source({
      attendance: [
        att({ userId: "u-dan", createdAt: LOG_EPOCH, updatedAt: "2026-05-12T23:00:00.000Z" }),
        att({
          userId: "u-gina",
          status: "BENCH",
          position: 2,
          createdAt: LOG_EPOCH,
          updatedAt: "2026-05-12T23:00:00.000Z",
        }),
      ],
      attendanceEvents: [
        {
          matchId: "m-1",
          userId: "u-dan",
          orgId: ORG,
          fromStatus: null,
          toStatus: "CONFIRMED",
          toPosition: 1,
          cause: "self-attendance",
          actorKind: "player",
          at: "2026-05-12T10:00:00.000Z",
        },
        {
          matchId: "m-1",
          userId: "u-gina",
          orgId: ORG,
          fromStatus: null,
          toStatus: "BENCH",
          toPosition: 2,
          cause: "self-attendance",
          actorKind: "player",
          at: "2026-05-12T11:00:00.000Z",
        },
        // AFTER the batch: the payment/settlement churn that made these
        // rows unknowable in the first place, plus a real later move.
        {
          matchId: "m-1",
          userId: "u-gina",
          orgId: ORG,
          fromStatus: "BENCH",
          toStatus: "CONFIRMED",
          toPosition: 2,
          cause: "bench-claim",
          actorKind: "player",
          at: "2026-05-12T23:00:00.000Z",
        },
      ],
      ...over,
    });
  }

  it("REPLAYS a batch the old rule had to throw away", () => {
    const r = reconstruct(loggedSource());
    expect(r.excluded).toEqual([]);
    expect(r.cases).toHaveLength(1);
    // The world is the world at 18:30, not the world after the whistle:
    // Gina is still on the bench, because her claim came at 23:00.
    expect(r.cases[0].case.world.attendance).toEqual([
      { key: "u-dan", status: "CONFIRMED" },
      { key: "u-gina", status: "BENCH" },
    ]);
    expect(r.cases[0].meta.squadBefore).toEqual({ confirmed: 1, bench: 1, dropped: 0 });
  });

  it("says on the case that the squad came from the log, so a reader can tell", () => {
    const c = reconstruct(loggedSource()).cases[0];
    expect(c.meta.squadSource).toBe("event-log");
    // And a case built the old way still says so.
    expect(reconstruct(source()).cases[0].meta.squadSource).toBe("row-timestamps");
  });

  it("still EXCLUDES a match whose rows predate the log — half a history is not a history", () => {
    // The row was created before logging began, so the log cannot
    // account for how it reached the status it holds. Trusting a
    // partial log is exactly the fabrication the harness refuses.
    const s = loggedSource({
      attendance: [
        att({ userId: "u-dan", createdAt: "2026-05-01T09:00:00.000Z", updatedAt: "2026-05-12T23:00:00.000Z" }),
      ],
    });
    const r = reconstruct(s);
    expect(r.cases).toEqual([]);
    expect(r.excluded[0].reason).toBe("attendance-state-unknown");
  });

  it("falls back to row timestamps when there is no log at all", () => {
    // Every message before this shipped. Nothing about the old path
    // changes, which is what makes the 447 comparable.
    const r = reconstruct(source({ attendanceEvents: [] }));
    expect(r.cases).toHaveLength(1);
    expect(r.cases[0].meta.squadSource).toBe("row-timestamps");
  });

  it("does not let a DELETED row linger as DROPPED in a replayed world", () => {
    const s = loggedSource({
      attendance: [
        att({ userId: "u-dan", createdAt: LOG_EPOCH, updatedAt: "2026-05-12T23:00:00.000Z" }),
      ],
      attendanceEvents: [
        {
          matchId: "m-1",
          userId: "u-dan",
          orgId: ORG,
          fromStatus: null,
          toStatus: "CONFIRMED",
          toPosition: 1,
          cause: "self-attendance",
          actorKind: "player",
          at: "2026-05-12T10:00:00.000Z",
        },
        {
          matchId: "m-1",
          userId: "u-gina",
          orgId: ORG,
          fromStatus: null,
          toStatus: "CONFIRMED",
          toPosition: 2,
          cause: "admin-squad-edit",
          actorKind: "admin",
          at: "2026-05-12T10:30:00.000Z",
        },
        {
          matchId: "m-1",
          userId: "u-gina",
          orgId: ORG,
          fromStatus: "CONFIRMED",
          toStatus: null,
          fromPosition: 2,
          cause: "admin-squad-edit",
          actorKind: "admin",
          at: "2026-05-12T11:00:00.000Z",
        },
      ],
    });
    const c = reconstruct(s).cases[0];
    expect(c.case.world.attendance).toEqual([{ key: "u-dan", status: "CONFIRMED" }]);
  });
});

describe("reconstruct — batches RECORDED rather than inferred", () => {
  it("groups by batchId, and the ambiguous band no longer costs anything", () => {
    // The exact gap the timing heuristic cannot call. With a recorded
    // batch id there is nothing to call.
    const gap = (BATCH_JOIN_MS + BATCH_AMBIGUOUS_MS) / 2;
    const s = source({
      messages: [
        msg({ waMessageId: "w1", createdAt: T0, batchId: "b-1" }),
        msg({ waMessageId: "w2", createdAt: iso(T0, gap), body: "me too", batchId: "b-2" }),
      ],
    });
    const r = reconstruct(s);
    expect(r.excluded).toEqual([]);
    expect(r.cases).toHaveLength(2);
    expect(r.cases[0].case.messages.map((m) => m.body)).toEqual(["in"]);
    expect(r.cases[1].case.messages.map((m) => m.body)).toEqual(["me too"]);
  });

  it("keeps ONE flush together even when the writes were seconds apart", () => {
    const s = source({
      messages: [
        msg({ waMessageId: "w1", createdAt: T0, batchId: "b-1" }),
        msg({ waMessageId: "w2", createdAt: iso(T0, 8_000), body: "me too", batchId: "b-1" }),
      ],
    });
    const r = reconstruct(s);
    expect(r.cases).toHaveLength(1);
    expect(r.cases[0].case.messages.map((m) => m.body)).toEqual(["in", "me too"]);
  });

  it("still infers, and still excludes, for the messages written before the column existed", () => {
    const gap = (BATCH_JOIN_MS + BATCH_AMBIGUOUS_MS) / 2;
    const s = source({
      messages: [
        msg({ waMessageId: "w1", createdAt: T0 }),
        msg({ waMessageId: "w2", createdAt: iso(T0, gap), body: "me too" }),
      ],
    });
    const r = reconstruct(s);
    expect(r.cases).toEqual([]);
    expect(r.excluded.every((e) => e.reason === "batch-boundary-ambiguous")).toBe(true);
  });

  it("a stamped flush is not disturbed by an unstamped message beside it", () => {
    // The changeover moment: one batch carries an id, its neighbour does
    // not. The stamped one must be exact regardless of what the timing
    // heuristic makes of the other.
    const s = source({
      messages: [
        msg({ waMessageId: "w1", createdAt: T0 }),
        msg({ waMessageId: "w2", createdAt: iso(T0, 3_000), body: "stamped", batchId: "b-9" }),
      ],
    });
    const r = reconstruct(s);
    const stamped = r.cases.find((c) => c.case.messages.some((m) => m.body === "stamped"));
    expect(stamped, "a recorded batch is never thrown away for a neighbour's ambiguity").toBeTruthy();
    expect(stamped!.case.messages).toHaveLength(1);
  });
});
