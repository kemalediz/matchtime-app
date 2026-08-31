/**
 * Unit tests for the outbound safety guards (2026-07-19 duplicate-send
 * incident: 30+ copies of one roster post in ~20 minutes because several
 * bot processes on the Pi each received the SAME due instruction before
 * any of them acked it).
 *
 * Two things are under test:
 *   1. claim-on-dispatch — the structural fix (unique key, first writer
 *      wins). Unchanged by the 2026-08-31 work.
 *   2. the outbound guards — a REPETITION guard (the real protection)
 *      plus a raised volume ceiling (a last-resort sanity bound).
 *
 * These cover the pure logic only — no DB, no WhatsApp session. The
 * atomic claim itself is injected as a function so we can simulate two
 * concurrent claimants racing for the same key.
 */
import { describe, it, expect, vi } from "vitest";
import {
  MAX_GROUP_MESSAGES_PER_HOUR,
  CIRCUIT_BREAKER_WINDOW_MS,
  MAX_IDENTICAL_GROUP_MESSAGES,
  REPETITION_WINDOW_MS,
  OUTBOUND_TEXT_LOG_KIND,
  GROUP_DIRECTED_KINDS,
  isGroupDirected,
  evaluateCircuitBreaker,
  evaluateRepetition,
  normaliseOutboundText,
  hashOutboundText,
  outboundTextOf,
  outboundTextLogKey,
  parseOutboundTextLogKey,
  classifyClaimError,
  planAckSideEffects,
  selectDispatchable,
  type Claimable,
  type RecentOutboundText,
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

const groupMsg = (key: string, text = `body of ${key}`): Claimable => ({
  kind: "group-message",
  key,
  text,
});

const T0 = new Date("2026-09-01T17:00:00.000Z");
const at = (msFromT0: number) => new Date(T0.getTime() + msFromT0);
const MIN = 60_000;

describe("volume ceiling (last-resort sanity bound)", () => {
  it("is a named exported constant, raised to 40/hour", () => {
    // A raw volume cap is NOT the real protection — it gags the bot
    // exactly when a match-day group is busiest and legitimate replies
    // are flying. 40/hour is far above any plausible legitimate day
    // (normal traffic is 1-2 group posts/day) and exists only to catch
    // failure modes the repetition guard cannot see.
    expect(MAX_GROUP_MESSAGES_PER_HOUR).toBe(40);
    expect(CIRCUIT_BREAKER_WINDOW_MS).toBe(60 * 60 * 1000);
  });

  it("allows normal volume", () => {
    const r = evaluateCircuitBreaker({ recentGroupSends: 2 });
    expect(r.allowed).toBe(true);
    expect(r.cap).toBe(MAX_GROUP_MESSAGES_PER_HOUR);
  });

  it("allows a chaotic-but-legitimate match day well past the OLD cap of 10", () => {
    // The exact scenario the old cap broke: a busy Tuesday where players
    // are dropping out and asking questions. Every one of these must go.
    for (const n of [10, 15, 25, 39]) {
      expect(evaluateCircuitBreaker({ recentGroupSends: n }).allowed).toBe(true);
    }
  });

  it("allows right up to the cap and denies at/past it", () => {
    expect(evaluateCircuitBreaker({ recentGroupSends: 39 }).allowed).toBe(true);
    expect(evaluateCircuitBreaker({ recentGroupSends: 40 }).allowed).toBe(false);
    expect(evaluateCircuitBreaker({ recentGroupSends: 41 }).allowed).toBe(false);
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

describe("normaliseOutboundText / hashOutboundText", () => {
  it("treats whitespace-only differences as identical", () => {
    expect(hashOutboundText("Squad is locked")).toBe(hashOutboundText("  Squad is locked  "));
    expect(hashOutboundText("Squad   is\tlocked")).toBe(hashOutboundText("Squad is locked"));
    expect(hashOutboundText("Squad is\nlocked")).toBe(hashOutboundText("Squad is locked"));
  });

  it("treats case-only differences as identical", () => {
    expect(hashOutboundText("Squad Is Locked")).toBe(hashOutboundText("squad is locked"));
  });

  it("keeps genuinely different messages apart", () => {
    expect(hashOutboundText("Squad is locked")).not.toBe(hashOutboundText("Squad is not locked"));
    expect(hashOutboundText("You're IN for Tuesday")).not.toBe(
      hashOutboundText("You're OUT for Tuesday"),
    );
  });

  it("normalises to a trimmed, single-spaced, lowercased form", () => {
    expect(normaliseOutboundText("  Hello \n  World  ")).toBe("hello world");
  });

  it("produces a short stable hex digest with no key-delimiter characters", () => {
    const h = hashOutboundText("anything");
    expect(h).toMatch(/^[0-9a-f]+$/);
    expect(h).toBe(hashOutboundText("anything"));
  });
});

describe("outboundTextOf", () => {
  it("reads the text of a group message", () => {
    expect(outboundTextOf({ kind: "group-message", key: "k", text: "hi" })).toBe("hi");
  });

  it("reads the text of a bench prompt", () => {
    expect(outboundTextOf({ kind: "bench-prompt", key: "k", text: "you're up" })).toBe("you're up");
  });

  it("derives a poll's identity from its question AND options", () => {
    const a = outboundTextOf({
      kind: "group-poll",
      key: "k",
      question: "MoM?",
      options: ["Ali", "Ben"],
    });
    const b = outboundTextOf({
      kind: "group-poll",
      key: "k2",
      question: "MoM?",
      options: ["Ali", "Cam"],
    });
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it("returns null when there is no outbound text to compare (e.g. a reaction)", () => {
    expect(outboundTextOf({ kind: "update-reaction", key: "retro-react-1" })).toBeNull();
    expect(outboundTextOf({ kind: "group-message", key: "k", text: "   " })).toBeNull();
  });
});

describe("evaluateRepetition — the real protection", () => {
  const H = hashOutboundText("Squad is locked for Tuesday");

  it("allows the first three identical sends inside the window", () => {
    // Three is already generous. A legitimate group post is never
    // repeated verbatim within five minutes.
    const recent: RecentOutboundText[] = [];
    for (let i = 0; i < 3; i++) {
      const v = evaluateRepetition({ textHash: H, recent, now: at(i * 1000) });
      expect(v.allowed).toBe(true);
      recent.push({ hash: H, at: at(i * 1000) });
    }
    expect(recent).toHaveLength(3);
  });

  it("BLOCKS the fourth identical send inside the window", () => {
    const recent: RecentOutboundText[] = [0, 1000, 2000].map((ms) => ({ hash: H, at: at(ms) }));
    const v = evaluateRepetition({ textHash: H, recent, now: at(3000) });
    expect(v.allowed).toBe(false);
    expect(v.repeats).toBe(3);
    expect(v.limit).toBe(MAX_IDENTICAL_GROUP_MESSAGES);
  });

  it("exposes the limit and window as named constants", () => {
    expect(MAX_IDENTICAL_GROUP_MESSAGES).toBe(3);
    expect(REPETITION_WINDOW_MS).toBe(5 * 60 * 1000);
  });

  it("allows MANY DIFFERENT messages at the same rate — busy is not broken", () => {
    // This is the whole point: a chaotic match day produces lots of
    // DIFFERENT messages and must never be gagged.
    const recent: RecentOutboundText[] = [];
    for (let i = 0; i < 20; i++) {
      const h = hashOutboundText(`reply number ${i}`);
      const v = evaluateRepetition({ textHash: h, recent, now: at(i * 1000) });
      expect(v.allowed).toBe(true);
      recent.push({ hash: h, at: at(i * 1000) });
    }
  });

  it("allows identical texts SIX minutes apart (outside the window)", () => {
    const recent: RecentOutboundText[] = [0, 1, 2].map((i) => ({ hash: H, at: at(i * 1000) }));
    const v = evaluateRepetition({ textHash: H, recent, now: at(6 * MIN) });
    expect(v.allowed).toBe(true);
    expect(v.repeats).toBe(0);
  });

  it("allows the same daily wording repeated 24h apart", () => {
    const recent: RecentOutboundText[] = [0, 1, 2, 3].map((i) => ({ hash: H, at: at(i * 1000) }));
    const v = evaluateRepetition({ textHash: H, recent, now: at(24 * 60 * MIN) });
    expect(v.allowed).toBe(true);
  });

  it("counts only entries strictly inside the window", () => {
    const recent: RecentOutboundText[] = [
      { hash: H, at: at(-6 * MIN) }, // aged out
      { hash: H, at: at(-4 * MIN) },
      { hash: H, at: at(-3 * MIN) },
      { hash: H, at: at(-1 * MIN) },
    ];
    const v = evaluateRepetition({ textHash: H, recent, now: T0 });
    expect(v.repeats).toBe(3);
    expect(v.allowed).toBe(false);
  });

  it("ignores other messages' hashes entirely", () => {
    const other = hashOutboundText("something else");
    const recent: RecentOutboundText[] = Array.from({ length: 50 }, (_, i) => ({
      hash: other,
      at: at(i),
    }));
    expect(evaluateRepetition({ textHash: H, recent, now: at(60_000) }).allowed).toBe(true);
  });

  it("honours explicit limit / window overrides", () => {
    const recent: RecentOutboundText[] = [{ hash: H, at: T0 }];
    expect(evaluateRepetition({ textHash: H, recent, now: T0, limit: 1 }).allowed).toBe(false);
    expect(
      evaluateRepetition({ textHash: H, recent, now: at(2000), windowMs: 1000 }).allowed,
    ).toBe(true);
  });
});

describe("outbound text log key", () => {
  it("round-trips org and hash", () => {
    const key = outboundTextLogKey("org1", "deadbeef", "match9:pre-kickoff");
    expect(key.startsWith("txtlog:")).toBe(true);
    expect(parseOutboundTextLogKey(key)).toEqual({ orgId: "org1", hash: "deadbeef" });
  });

  it("is unique per instruction so N sends of one text make N rows", () => {
    const a = outboundTextLogKey("org1", "d1", "m1:a");
    const b = outboundTextLogKey("org1", "d1", "m1:b");
    expect(a).not.toBe(b);
  });

  it("cannot collide with a real instruction key namespace", () => {
    expect(parseOutboundTextLogKey("org-o1:bot-intro")).toBeNull();
    expect(parseOutboundTextLogKey("botjob-abc")).toBeNull();
    expect(parseOutboundTextLogKey("m1:pre-kickoff")).toBeNull();
    expect(OUTBOUND_TEXT_LOG_KIND).toBe("outbound-text-log");
    expect(GROUP_DIRECTED_KINDS.has(OUTBOUND_TEXT_LOG_KIND)).toBe(false);
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
      { kind: "dm", key: "m1:rate-dm:u1", text: "you're in" },
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

describe("selectDispatchable — repetition guard", () => {
  const DUP = "Teams are up for tonight";

  it("lets three identical group posts through, then blocks the fourth", async () => {
    const store = makeClaimStore();
    const onRepeat = vi.fn();
    const instrs = Array.from({ length: 4 }, (_, i) => groupMsg(`m1:k${i}`, DUP));
    const r = await selectDispatchable(instrs, {
      claim: store.claim,
      recentGroupSends: 0,
      recentTexts: [],
      now: T0,
      onRepeat,
    });
    expect(r.dispatch.map((i) => i.key)).toEqual(["m1:k0", "m1:k1", "m1:k2"]);
    expect(r.repetitionBlocked).toEqual(["m1:k3"]);
    expect(store.claimed.has("m1:k3")).toBe(false); // key left free for a human
    expect(onRepeat).toHaveBeenCalledTimes(1);
    expect(onRepeat.mock.calls[0][0]).toMatchObject({ repeats: 3, limit: 3 });
  });

  it("counts history from previous polls, not just this batch", async () => {
    const store = makeClaimStore();
    const r = await selectDispatchable([groupMsg("m1:k9", DUP)], {
      claim: store.claim,
      recentGroupSends: 0,
      recentTexts: [0, 1, 2].map((i) => ({ hash: hashOutboundText(DUP), at: at(i * 1000) })),
      now: at(4000),
    });
    expect(r.dispatch).toEqual([]);
    expect(r.repetitionBlocked).toEqual(["m1:k9"]);
  });

  it("does NOT block identical texts once the 5-minute window has passed", async () => {
    const store = makeClaimStore();
    const r = await selectDispatchable([groupMsg("m1:k9", DUP)], {
      claim: store.claim,
      recentGroupSends: 0,
      recentTexts: [0, 1, 2].map((i) => ({ hash: hashOutboundText(DUP), at: at(i * 1000) })),
      now: at(6 * MIN),
    });
    expect(r.dispatch.map((i) => i.key)).toEqual(["m1:k9"]);
    expect(r.repetitionBlocked).toEqual([]);
  });

  it("treats whitespace-different copies of one message as the same message", async () => {
    const store = makeClaimStore();
    const variants = ["Teams are up", " Teams  are up ", "Teams\nare up", "TEAMS ARE UP"];
    const instrs = variants.map((t, i) => groupMsg(`m1:w${i}`, t));
    const r = await selectDispatchable(instrs, {
      claim: store.claim,
      recentGroupSends: 0,
      recentTexts: [],
      now: T0,
    });
    expect(r.dispatch).toHaveLength(3);
    expect(r.repetitionBlocked).toEqual(["m1:w3"]);
  });

  it("never blocks a busy but legitimate match day (all different texts)", async () => {
    const store = makeClaimStore();
    const instrs = Array.from({ length: 12 }, (_, i) => groupMsg(`m1:b${i}`, `distinct reply ${i}`));
    const r = await selectDispatchable(instrs, {
      claim: store.claim,
      recentGroupSends: 0,
      recentTexts: [],
      now: T0,
    });
    expect(r.dispatch).toHaveLength(12);
    expect(r.repetitionBlocked).toEqual([]);
    expect(r.breakerTripped).toBe(false);
  });

  it("blocking one repeated text does NOT suppress other, different posts", async () => {
    const store = makeClaimStore();
    const instrs = [
      groupMsg("m1:d1", DUP),
      groupMsg("m1:d2", DUP),
      groupMsg("m1:d3", DUP),
      groupMsg("m1:d4", DUP), // blocked
      groupMsg("m1:other", "a completely different post"),
    ];
    const r = await selectDispatchable(instrs, {
      claim: store.claim,
      recentGroupSends: 0,
      recentTexts: [],
      now: T0,
    });
    expect(r.dispatch.map((i) => i.key)).toEqual(["m1:d1", "m1:d2", "m1:d3", "m1:other"]);
    expect(r.repetitionBlocked).toEqual(["m1:d4"]);
  });

  it("records the hash of every group post it actually dispatched", async () => {
    const store = makeClaimStore();
    const recordText = vi.fn(async (info: { hash: string; key: string }) => {
      void info;
    });
    await selectDispatchable([groupMsg("m1:k0", DUP), { kind: "dm", key: "m1:dm", text: DUP }], {
      claim: store.claim,
      recentGroupSends: 0,
      recentTexts: [],
      now: T0,
      recordText,
    });
    // Group post recorded; the DM is not part of the group ledger.
    expect(recordText).toHaveBeenCalledTimes(1);
    expect(recordText.mock.calls[0][0]).toMatchObject({
      hash: hashOutboundText(DUP),
      key: "m1:k0",
    });
  });

  it("still dispatches when the ledger write fails — the guard must never gag the bot", async () => {
    const store = makeClaimStore();
    const r = await selectDispatchable([groupMsg("m1:k0", DUP)], {
      claim: store.claim,
      recentGroupSends: 0,
      recentTexts: [],
      now: T0,
      recordText: async () => {
        throw new Error("ledger write failed");
      },
    });
    expect(r.dispatch.map((i) => i.key)).toEqual(["m1:k0"]);
  });

  it("cannot be tripped by an instruction with no comparable text", async () => {
    const store = makeClaimStore();
    const instrs: Claimable[] = Array.from({ length: 6 }, (_, i) => ({
      kind: "group-message",
      key: `m1:n${i}`,
    }));
    const r = await selectDispatchable(instrs, {
      claim: store.claim,
      recentGroupSends: 0,
      recentTexts: [],
      now: T0,
    });
    expect(r.dispatch).toHaveLength(6);
  });
});

describe("DMs are never gated by either guard", () => {
  it("sends 10 IDENTICAL DMs — a player's reply must always arrive", async () => {
    // Identical DM text across players is completely normal ("You're in
    // for Tuesday ✅"). The repetition guard must not see them.
    const store = makeClaimStore();
    const instrs: Claimable[] = Array.from({ length: 10 }, (_, i) => ({
      kind: "dm",
      key: `m1:rate-dm:u${i}`,
      text: "You're IN for Tuesday",
    }));
    const r = await selectDispatchable(instrs, {
      claim: store.claim,
      recentGroupSends: 0,
      recentTexts: [],
      now: T0,
    });
    expect(r.dispatch).toHaveLength(10);
    expect(r.repetitionBlocked).toEqual([]);
  });

  it("sends DMs even when the volume ceiling has already tripped", async () => {
    const store = makeClaimStore();
    const instrs: Claimable[] = [
      groupMsg("m1:group", "roster"),
      { kind: "dm", key: "m1:dm1", text: "You're OUT, mate" },
    ];
    const r = await selectDispatchable(instrs, {
      claim: store.claim,
      recentGroupSends: MAX_GROUP_MESSAGES_PER_HOUR + 100,
      recentTexts: [],
      now: T0,
    });
    expect(r.dispatch.map((i) => i.key)).toEqual(["m1:dm1"]);
    expect(r.breakerTripped).toBe(true);
  });

  it("sends DMs even when that exact text is being blocked in the group", async () => {
    const store = makeClaimStore();
    const dup = "Kick-off moved to 8pm";
    const r = await selectDispatchable(
      [groupMsg("m1:g", dup), { kind: "dm", key: "m1:dm1", text: dup }],
      {
        claim: store.claim,
        recentGroupSends: 0,
        recentTexts: [0, 1, 2].map((i) => ({ hash: hashOutboundText(dup), at: at(i * 1000) })),
        now: at(3000),
      },
    );
    expect(r.dispatch.map((i) => i.key)).toEqual(["m1:dm1"]);
    expect(r.repetitionBlocked).toEqual(["m1:g"]);
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

  it("has no side effects for an outbound text-log ledger row", () => {
    expect(planAckSideEffects(outboundTextLogKey("o1", "abcd", "m1:k"))).toEqual([]);
  });
});
