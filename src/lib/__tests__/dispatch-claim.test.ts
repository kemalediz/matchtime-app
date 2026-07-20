/**
 * Unit tests for the claim-on-dispatch guard (2026-07-19 duplicate-send
 * incident: 30+ copies of one roster post in ~20 minutes because several
 * bot processes on the Pi each received the SAME due instruction before
 * any of them acked it).
 *
 * These cover the pure logic only — no DB, no WhatsApp session. The
 * atomic claim itself is injected as a function so we can simulate two
 * concurrent claimants racing for the same key.
 */
import { describe, it, expect, vi } from "vitest";
import {
  MAX_GROUP_MESSAGES_PER_HOUR,
  CIRCUIT_BREAKER_WINDOW_MS,
  GROUP_DIRECTED_KINDS,
  isGroupDirected,
  evaluateCircuitBreaker,
  classifyClaimError,
  planAckSideEffects,
  selectDispatchable,
  type Claimable,
} from "../dispatch-claim";

// ── A fake "database" whose unique index on `key` is the whole point ──
function makeClaimStore() {
  const claimed = new Set<string>();
  return {
    claimed,
    /** Mirrors Prisma `create` on a @unique column: first writer wins. */
    async claim(instr: Claimable) {
      if (claimed.has(instr.key)) {
        const err = Object.assign(new Error("Unique constraint failed"), {
          code: "P2002",
        });
        throw err;
      }
      claimed.add(instr.key);
    },
  };
}

const groupMsg = (key: string): Claimable => ({ kind: "group-message", key });

describe("circuit breaker", () => {
  it("exposes the cap as a named constant well above legitimate traffic", () => {
    // Normal MatchTime traffic is ~1-2 group posts per day per org.
    expect(MAX_GROUP_MESSAGES_PER_HOUR).toBe(10);
    expect(CIRCUIT_BREAKER_WINDOW_MS).toBe(60 * 60 * 1000);
  });

  it("allows normal volume", () => {
    const r = evaluateCircuitBreaker({ recentGroupSends: 2 });
    expect(r.allowed).toBe(true);
    expect(r.cap).toBe(MAX_GROUP_MESSAGES_PER_HOUR);
  });

  it("allows right up to the cap and denies at/past it", () => {
    expect(evaluateCircuitBreaker({ recentGroupSends: 9 }).allowed).toBe(true);
    expect(evaluateCircuitBreaker({ recentGroupSends: 10 }).allowed).toBe(false);
    expect(evaluateCircuitBreaker({ recentGroupSends: 999 }).allowed).toBe(false);
  });

  it("honours an explicit cap override (used by tests / future tuning)", () => {
    expect(evaluateCircuitBreaker({ recentGroupSends: 3, cap: 3 }).allowed).toBe(false);
    expect(evaluateCircuitBreaker({ recentGroupSends: 3, cap: 4 }).allowed).toBe(true);
  });

  it("counts only group-directed kinds", () => {
    expect(isGroupDirected("group-message")).toBe(true);
    expect(isGroupDirected("group-poll")).toBe(true);
    expect(isGroupDirected("bench-prompt")).toBe(true);
    expect(isGroupDirected("dm")).toBe(false);
    expect(isGroupDirected("update-reaction")).toBe(false);
    expect(GROUP_DIRECTED_KINDS.size).toBe(3);
  });
});

describe("classifyClaimError", () => {
  it("maps a Prisma P2002 unique violation to already-claimed", () => {
    expect(classifyClaimError({ code: "P2002" })).toBe("already-claimed");
  });

  it("maps anything else to error", () => {
    expect(classifyClaimError(new Error("connection reset"))).toBe("error");
    expect(classifyClaimError({ code: "P2025" })).toBe("error");
    expect(classifyClaimError(null)).toBe("error");
  });
});

describe("selectDispatchable — claim-on-dispatch", () => {
  it("dispatches an instruction the first time it is claimed", async () => {
    const store = makeClaimStore();
    const r = await selectDispatchable([groupMsg("m1:announce-match")], {
      claim: store.claim,
      recentGroupSends: 0,
    });
    expect(r.dispatch.map((i) => i.key)).toEqual(["m1:announce-match"]);
    expect(r.alreadyClaimed).toEqual([]);
  });

  it("gives the SAME instruction to only ONE of two concurrent pollers", async () => {
    // This is the incident, reproduced: two bot processes poll at the
    // same instant and both receive the same due instruction list.
    const store = makeClaimStore();
    const instrs = [groupMsg("m1:announce-match")];

    const [botA, botB] = await Promise.all([
      selectDispatchable(instrs, { claim: store.claim, recentGroupSends: 0 }),
      selectDispatchable(instrs, { claim: store.claim, recentGroupSends: 0 }),
    ]);

    const totalDispatched = botA.dispatch.length + botB.dispatch.length;
    expect(totalDispatched).toBe(1); // exactly one send, never two
    const loser = botA.dispatch.length === 0 ? botA : botB;
    expect(loser.alreadyClaimed).toEqual(["m1:announce-match"]);
  });

  it("holds the line across 30 concurrent pollers (the observed blast radius)", async () => {
    const store = makeClaimStore();
    const instrs = [groupMsg("m1:pre-kickoff")];
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        selectDispatchable(instrs, { claim: store.claim, recentGroupSends: 0 }),
      ),
    );
    expect(results.reduce((n, r) => n + r.dispatch.length, 0)).toBe(1);
  });

  it("does NOT dispatch an instruction whose claim errored for a non-unique reason", async () => {
    const r = await selectDispatchable([groupMsg("m1:pre-kickoff")], {
      claim: async () => {
        throw new Error("db unreachable");
      },
      recentGroupSends: 0,
    });
    expect(r.dispatch).toEqual([]);
    expect(r.errored).toEqual(["m1:pre-kickoff"]);
  });

  it("skips everything and reports a tripped breaker when the org is over cap", async () => {
    const store = makeClaimStore();
    const onBreak = vi.fn();
    const r = await selectDispatchable([groupMsg("m1:a"), groupMsg("m1:b")], {
      claim: store.claim,
      recentGroupSends: MAX_GROUP_MESSAGES_PER_HOUR,
      onBreak,
    });
    expect(r.dispatch).toEqual([]);
    expect(r.breakerTripped).toBe(true);
    expect(store.claimed.size).toBe(0); // nothing claimed → nothing lost
    expect(onBreak).toHaveBeenCalledTimes(1);
    expect(onBreak.mock.calls[0][0]).toMatchObject({
      count: MAX_GROUP_MESSAGES_PER_HOUR,
      cap: MAX_GROUP_MESSAGES_PER_HOUR,
    });
  });

  it("trips mid-batch: claims up to the cap, then stops", async () => {
    const store = makeClaimStore();
    const instrs = Array.from({ length: 5 }, (_, i) => groupMsg(`m1:k${i}`));
    const r = await selectDispatchable(instrs, {
      claim: store.claim,
      recentGroupSends: MAX_GROUP_MESSAGES_PER_HOUR - 2, // room for 2 more
    });
    expect(r.dispatch).toHaveLength(2);
    expect(r.breakerTripped).toBe(true);
    expect(store.claimed.size).toBe(2);
  });

  it("does not let DMs or reactions consume the group-message budget", async () => {
    const store = makeClaimStore();
    const instrs: Claimable[] = [
      { kind: "dm", key: "m1:rate-dm:u1" },
      { kind: "update-reaction", key: "retro-react-1" },
      groupMsg("m1:pre-kickoff"),
    ];
    const r = await selectDispatchable(instrs, {
      claim: store.claim,
      recentGroupSends: MAX_GROUP_MESSAGES_PER_HOUR - 1, // room for 1 group post
    });
    expect(r.dispatch.map((i) => i.key)).toEqual([
      "m1:rate-dm:u1",
      "retro-react-1",
      "m1:pre-kickoff",
    ]);
    expect(r.breakerTripped).toBe(false);
  });
});

describe("planAckSideEffects — every existing ack behaviour is preserved", () => {
  it("closes out a BotJob", () => {
    expect(planAckSideEffects("botjob-abc123")).toEqual([
      { type: "botjob-sent", botJobId: "abc123" },
    ]);
  });

  it("stamps waMessageId on a bench slot offer (group post only)", () => {
    expect(planAckSideEffects("offer-off1")).toEqual([
      { type: "offer-wa-message-id", offerId: "off1" },
    ]);
  });

  it("does NOT treat a per-bencher offer DM as the offer post", () => {
    expect(planAckSideEffects("offer-off1:dm:user9")).toEqual([]);
  });

  it("closes out a RetroReaction", () => {
    expect(planAckSideEffects("retro-react-r7")).toEqual([
      { type: "retro-reaction-sent", retroReactionId: "r7" },
    ]);
  });

  it("stamps notifiedAt for a tentative follow-up", () => {
    expect(planAckSideEffects("match1:tentative-followup:user2")).toEqual([
      { type: "tentative-followup-notified", matchId: "match1", userId: "user2" },
    ]);
  });

  it("has no side effects for a plain match-keyed group post", () => {
    expect(planAckSideEffects("match1:pre-kickoff")).toEqual([]);
    expect(planAckSideEffects("org-o1:bot-intro")).toEqual([]);
  });
});
