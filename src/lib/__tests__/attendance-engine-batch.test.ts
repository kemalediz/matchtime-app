/**
 * §10 STEP 6 — THE ORCHESTRATOR.
 *
 * `attendance-engine.ts` is the seam and `pipeline/engine.ts` is the
 * decision; this is the thing that decides WHICH MESSAGES either of
 * them ever sees. That question — ownership — is where step 6's risk
 * actually lives, because every wrong answer to it is either a message
 * decided by a path with less context than the analyzer had, or a
 * message decided twice.
 *
 * So the whole decline table from the module header is asserted here,
 * one row at a time, and the assertion is always the same: OWNS NOTHING.
 *
 * WHAT "OWNS NOTHING" MEANS CHANGED ON 2026-09-06. This used to add
 * "which means the analyzer keeps the batch, which is today's behaviour
 * and therefore cannot be a regression". §10 step 8 deleted
 * `analyzeBatch`, the 19,850-token `SYSTEM_PROMPT` and `executeVerdict`,
 * so nothing keeps the batch: a message this engine declines goes SILENT
 * in the group and produces one line on a deduped operator DM
 * (`route.ts`'s "NOBODY OWNED IT" branch, `lib/operator-note.ts`). The assertions below are
 * unchanged and still right — the engine must not guess — but they now
 * pin a behaviour change rather than a no-op, so read `ownedIds.size ===
 * 0` as "MatchTime said nothing", not as "somebody else handled it".
 */
import { describe, expect, it, vi } from "vitest";
import {
  intentFor,
  describeEngineBatch,
  runAttendanceEngineBatch,
  tentativeUserId,
  type EngineBatchDeps,
  type EngineBatchMessage,
} from "../attendance-engine-batch";
import type { AttendanceFacts, SquadState } from "../pipeline/types";
import type { PipelineModel } from "../pipeline/llm";

// ── fixtures ────────────────────────────────────────────────────────

function state(over: Partial<SquadState> = {}): SquadState {
  return {
    matchId: "match-1",
    maxPlayers: 4,
    kickoffLabel: "Tue 20:00",
    venue: "The Pitch",
    rows: [],
    roster: [
      { userId: "u-pete", name: "Pete Power", isAdmin: false, hasPhone: true },
      { userId: "u-alice", name: "Alice Admin", isAdmin: true, hasPhone: true },
      { userId: "u-dan", name: "Dan Drummer", isAdmin: false, hasPhone: true },
    ],
    openOffers: [],
    teams: [],
    teamLabels: ["Red", "Yellow"],
    completedMatch: null,
    appearances: [],
    appearanceWindowDays: 30,
    payments: null,
    ratingProgress: null,
    lastBotPost: null,
    features: { attendance: true, paymentTracking: false, statsQa: false, reminders: false },
    smallerFormats: [],
    guestAskedUserIds: [],
    ...over,
  };
}

function msg(over: Partial<EngineBatchMessage> = {}): EngineBatchMessage {
  return {
    waMessageId: "wa-1",
    body: "in",
    authorName: "Pete Power",
    senderUserId: "u-pete",
    senderName: "Pete Power",
    senderIsAdmin: false,
    tagged: false,
    route: "self_att",
    gated: false,
    ...over,
  };
}

/** A model that answers every extractor call with the same facts. */
function modelReturning(body: Record<string, unknown>): PipelineModel {
  return {
    name: "fake",
    async complete() {
      return {
        text: JSON.stringify(body),
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
        ms: 1,
      };
    },
  };
}

const SELF_IN = {
  claims: [
    {
      subject: "sender",
      personRef: "",
      personNamed: false,
      polarity: "in",
      contingent: false,
      conditionOn: "none",
      tense: "present",
      reported: false,
      confidence: 0.95,
    },
  ],
  affirmation: "none",
  sideRequests: [],
};

function deps(over: Partial<EngineBatchDeps> = {}): EngineBatchDeps & {
  registered: string[];
  cancelled: string[];
  guestAsksClaimed: Array<{ matchId: string; userId: string }>;
} {
  const registered: string[] = [];
  const cancelled: string[] = [];
  // The once-per-player-per-match guest-name-ask row. A test fake that
  // always grants the slot; the specs that care about losing the race
  // override it.
  const guestAsksClaimed: Array<{ matchId: string; userId: string }> = [];
  return {
    registered,
    cancelled,
    guestAsksClaimed,
    model: modelReturning(SELF_IN),
    loadState: async () => state(),
    openBenchPromptUserIds: async () => [],
    async claimGuestNameAsk(args) {
      guestAsksClaimed.push(args);
      return true;
    },
    async registerAttendance(userId) {
      registered.push(userId);
      return {
        status: "CONFIRMED" as const,
        position: 1,
        slot: 1,
        confirmedCount: 1,
        maxPlayers: 4,
      };
    },
    async cancelAttendance(userId) {
      cancelled.push(userId);
      return { status: "DROPPED" as const };
    },
    async resolveOrProvision(name) {
      return { userId: `new-real:${name}` };
    },
    ...over,
  } as EngineBatchDeps & {
    registered: string[];
    cancelled: string[];
    guestAsksClaimed: Array<{ matchId: string; userId: string }>;
  };
}

async function run(messages: EngineBatchMessage[], d = deps(), enabled = true) {
  return runOn("match-1", messages, d, enabled);
}

/** …against a named registration match, for the per-match assertions. */
async function runOn(
  expectedMatchId: string,
  messages: EngineBatchMessage[],
  d = deps(),
  enabled = true,
) {
  return runAttendanceEngineBatch({
    orgId: "org-1",
    now: new Date("2026-09-03T12:00:00Z"),
    messages,
    history: [],
    expectedMatchId,
    enabled,
    deps: d,
  });
}

// ── the happy path, so "owns nothing" means something ───────────────

describe("the engine owns the three routes and writes through the shipped apply", () => {
  it("registers the sender for a self_att IN", async () => {
    const d = deps();
    const r = await run([msg()], d);
    expect([...r.ownedIds]).toEqual(["wa-1"]);
    expect(d.registered).toEqual(["u-pete"]);
    expect(r.outcomes.get("wa-1")).toMatchObject({ intent: "in", action: "IN" });
  });

  it("puts NO squad post on a batch that only changed the squad (2026-09-09)", async () => {
    // WAS: "puts a squad post on the message that acted, once". It did,
    // and that was the bug — on the LIVE path this runner is the only
    // thing that ever composed one, so every batch containing an "in"
    // posted the whole roster. Kemal, watching it happen on Sutton FC:
    // "for every IN, MT is responding with the squad. I think that is
    // overmessaging. Only a tick is enough to confirm the attendance is
    // taken and a 5pm update about the squad is what we agreed."
    //
    // `squadPostForMessageId` is the marker the analyze route expands
    // into the roster (`route.ts:2132`). Null means nothing is expanded,
    // so the group gets the reacts and nothing else. The mechanism is
    // NOT deleted: it still fires when a squad question shares the batch
    // (`pipeline/__tests__/engine.test.ts`'s S36b block), which on this
    // path cannot happen because a `question` message reaches `decide()`
    // here with `facts: {kind:"none"}`.
    const d = deps();
    const r = await run(
      [
        msg({ waMessageId: "a" }),
        msg({
          waMessageId: "b",
          senderUserId: "u-dan",
          senderName: "Dan Drummer",
          authorName: "Dan Drummer",
        }),
      ],
      d,
    );
    expect(r.squadPostForMessageId).toBeNull();
    // Both writes still landed, and both players were still told.
    expect(d.registered).toEqual(["u-pete", "u-dan"]);
    expect(r.outcomes.get("a")?.react).toBe("✅");
    expect(r.outcomes.get("b")?.react).toBe("✅");
    expect(r.outcomes.get("a")?.reply).toBeNull();
    expect(r.outcomes.get("b")?.reply).toBeNull();
  });

  it("gives every owned message an outcome, even one that wrote nothing", async () => {
    // §3.2 S1's incident (Ibrahim and Baki, silently omitted) as a
    // post-condition rather than a prompt banner.
    const d = deps({ model: modelReturning({ claims: [], affirmation: "none", sideRequests: [] }) });
    const r = await run([msg({ waMessageId: "a" }), msg({ waMessageId: "b" })], d);
    expect([...r.outcomes.keys()].sort()).toEqual(["a", "b"]);
    expect(d.registered).toEqual([]);
  });
});

// ── every row of the module header's decline table ──────────────────

describe("every failure owns nothing — which since §10 step 8 means silence + an operator note", () => {
  it("the flag is off", async () => {
    const d = deps();
    const r = await run([msg()], d, false);
    expect(r.ownedIds.size).toBe(0);
    expect(d.registered).toEqual([]);
  });

  // `unsure` LEFT this list on 2026-09-06 (§10 step 8). It used to be
  // refused here for the reason `gate.ts`'s `ENGINE_ROUTES` gave — doubt
  // costs an analyzer call — and step 8 deletes the analyzer, so the
  // choice became "engine or silence" and §11.1's asymmetry answers it
  // the other way. See the essay on `ENGINE_ROUTES`. It is owned by the
  // case below this one, which asserts it goes through the same rules as
  // `self_att` rather than a looser set.
  it("the route is not one of the four", async () => {
    for (const route of ["question", "balancer", "score", "admin_ops", "none"] as const) {
      const d = deps();
      const r = await run([msg({ route })], d);
      expect(r.ownedIds.size, `route ${route} was owned`).toBe(0);
      expect(d.registered).toEqual([]);
    }
  });

  it("the router never mentioned the id", async () => {
    const d = deps();
    const r = await run([msg({ route: undefined })], d);
    expect(r.ownedIds.size).toBe(0);
  });

  // ── §10 STEP 8 — `unsure` IS OWNED, AND ON THE SAME TERMS ──────────
  //
  // Three cases rather than one, because "we now own `unsure`" is only
  // safe if it means "the same rules, entered by a different door". The
  // risk of the change is not that the engine acts on a doubtful
  // message; it is that a doubtful message gets a LOOSER path than a
  // confident one. So: it is owned; a claim on it writes exactly as
  // `self_att` writes; and a message the extractor cannot make a claim
  // from writes nothing, which is the §6.2 worst case, accepted.
  it("OWNS `unsure` — step 8 deleted the thing it used to fall back to", async () => {
    const d = deps();
    const r = await run([msg({ route: "unsure" })], d);
    expect(r.ownedIds.size).toBe(1);
  });

  it("puts an `unsure` message through the SAME write path as a `self_att` one", async () => {
    const viaUnsure = deps();
    await run([msg({ route: "unsure" })], viaUnsure);
    const viaSelfAtt = deps();
    await run([msg({ route: "self_att" })], viaSelfAtt);
    expect(viaUnsure.registered).toEqual(viaSelfAtt.registered);
    expect(viaUnsure.registered).toEqual(["u-pete"]);
  });

  it("writes nothing and says nothing for an `unsure` message with no claim in it", async () => {
    // §6.2's accepted worst case, and the reason the false-positive side
    // of §11.1's asymmetry is cheap: an extractor call that returns no
    // claims costs ~$0.002 and changes nothing at all.
    //
    // Note it is still OWNED. That is deliberate and it is the honest
    // shape: the engine looked at this message and decided nothing
    // happens, so it carries an outcome with a reason and a row in
    // `AnalyzedMessage` — which is §11.2's own mitigation, "log the
    // route alongside the extracted facts, so triage is one query".
    // Leaving it unowned would send it to step 8's operator note, and
    // an admin DM for every banter message the router happened to call
    // `unsure` is the nagging that makes an operator surface useless.
    const d = deps({
      model: modelReturning({ claims: [], affirmation: "none", sideRequests: [] }),
    });
    const r = await run([msg({ route: "unsure" })], d);
    expect(d.registered).toEqual([]);
    expect(d.cancelled).toEqual([]);
    const outcome = r.outcomes.get("wa-1");
    expect(outcome?.action).toBe("none");
    expect(outcome?.reply).toBeNull();
  });

  it("step 5's gate already skipped it", async () => {
    const d = deps();
    const r = await run([msg({ gated: true })], d);
    expect(r.ownedIds.size).toBe(0);
  });

  it("there is no active registration match", async () => {
    const d = deps({ loadState: async () => state({ matchId: null }) });
    const r = await run([msg()], d);
    expect(r.ownedIds.size).toBe(0);
    expect(d.registered).toEqual([]);
  });

  it("attendance is off for the org", async () => {
    const d = deps({
      loadState: async () =>
        state({ features: { attendance: false, paymentTracking: false, statsQa: false, reminders: false } }),
    });
    const r = await run([msg()], d);
    expect(r.ownedIds.size).toBe(0);
  });

  it("the state load throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = deps({
      loadState: async () => {
        throw new Error("db down");
      },
    });
    const r = await run([msg()], d);
    expect(r.ownedIds.size).toBe(0);
    err.mockRestore();
  });

  it("the route and the engine disagree about which match registration lands on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = deps({ loadState: async () => state({ matchId: "some-other-match" }) });
    const r = await run([msg()], d);
    expect(r.ownedIds.size).toBe(0);
    expect(d.registered).toEqual([]);
    warn.mockRestore();
  });

  it("the message is a pasted numbered roster — PR #39's shape, owned for nothing", async () => {
    // `reconcilePastedRoster` is the shipped handling for this shape,
    // and PR #35 measured why: the same paste registered a DIFFERENT
    // SUBSET on each run. Who a list registers is arithmetic, done in
    // the route, never a reading — so the model's SELF_IN here (the
    // sender's own name is slot 1) buys nothing.
    //
    // 2026-09-07: the refusal is a clamp on the FACTS rather than on the
    // message (`clampPastedRosterFacts`), because refusing the whole
    // message also threw away the sender's own drop — see the case
    // below. From outside, an ordinary paste behaves exactly as it did.
    const d = deps();
    const roster =
      "1. Pete Power\n2. Dan Drummer\n3. Alice Admin\n4. Someone Else\n5. Another Name";
    const r = await run([msg({ body: roster })], d);
    expect(r.ownedIds.size).toBe(0);
    expect(r.outcomes.size).toBe(0);
    expect(d.registered).toEqual([]);
  });

  it("…and a THIRD-PARTY read off that list is refused however the router routed it", async () => {
    const d = deps({
      model: modelReturning({
        claims: [
          {
            subject: "other",
            personRef: "Dan Drummer",
            personNamed: true,
            polarity: "in",
            contingent: false,
            conditionOn: "none",
            tense: "present",
            reported: false,
            confidence: 0.95,
          },
        ],
        affirmation: "none",
        sideRequests: [],
      }),
    });
    const roster =
      "1. Pete Power\n2. Dan Drummer\n3. Alice Admin\n4. Someone Else\n5. Another Name";
    const r = await run([msg({ body: roster, route: "other_att" })], d);
    expect(r.ownedIds.size).toBe(0);
    expect(d.registered).toEqual([]);
  });

  it("the message is a shared CONTACT CARD — its display name is not a registration", async () => {
    // Real production message, 2026-06-11: a forwarded vCard plus "Add
    // these 2 boys pl" registered a member called "Salman Shelly Ftbl"
    // and only one of the two people asked for. The card's `FN:` line
    // passes every identity check because it IS a name; what makes it
    // wrong is the container.
    const d = deps();
    const vcard =
      "BEGIN:VCARD\nVERSION:3.0\nN:;Salman Shelly Ftbl;;;\nFN:Salman Shelly Ftbl\nTEL;waid=447700900001:447700900001\nEND:VCARD";
    const r = await run([msg({ body: vcard })], d);
    expect(r.ownedIds.size).toBe(0);
    expect(d.registered).toEqual([]);
  });

  it("the sender has an open bench PROMPT — a different flow the engine has no concept of", async () => {
    // `resolveBenchConfirmation` owns a group "yes"/"👍" answering a
    // PendingBenchConfirmation. Handing that to the engine would silently
    // change what a bench player's own answer does.
    const d = deps({ openBenchPromptUserIds: async () => ["u-pete"] });
    const r = await run([msg()], d);
    expect(r.ownedIds.size).toBe(0);
    expect(d.registered).toEqual([]);
  });

  it("the bench-prompt lookup itself throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = deps({
      openBenchPromptUserIds: async () => {
        throw new Error("db down");
      },
    });
    const r = await run([msg()], d);
    expect(r.ownedIds.size).toBe(0);
    err.mockRestore();
  });

  it("one sender's bench prompt does not un-own the rest of the batch", async () => {
    const d = deps({ openBenchPromptUserIds: async () => ["u-pete"] });
    const r = await run(
      [msg({ waMessageId: "a" }), msg({ waMessageId: "b", senderUserId: "u-dan" })],
      d,
    );
    expect([...r.ownedIds]).toEqual(["b"]);
    expect(d.registered).toEqual(["u-dan"]);
  });
});

// ── the extractor failing is loud, not silent ───────────────────────

describe("an extractor failure hands the message BACK to the analyzer", () => {
  // The behaviour this replaced was "fail closed", which §11.4 asked
  // for — and which meant SILENT: no write, no reply, and a player who
  // said IN not in the squad. The first live corpus sweep of this step
  // measured 27 `529 Overloaded` and 3 `500`s across 10 messages, which
  // took two corpus cases from 3/3 to 0/3 without the engine ever
  // deciding them wrongly. The engine is one of two deciders and the
  // other one is the incumbent with all its seatbelts; handing the
  // message over is the step's own revert, applied per message.

  it("unparseable output → not owned, nothing written, and it is recorded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken: PipelineModel = {
      name: "broken",
      async complete() {
        return {
          text: "this is not JSON",
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0,
          ms: 1,
        };
      },
    };
    const d = deps({ model: broken });
    const r = await run([msg()], d);
    // NOT owned. Since §10 step 8 there is nothing behind this file, so
    // "not owned" means silence in the group plus one line on the
    // operator DM (`lib/operator-note.ts`) — not a hand-back.
    expect(r.ownedIds.size).toBe(0);
    expect(r.outcomes.size).toBe(0);
    expect(d.registered).toEqual([]);
    // Loud, not silent: the reason is on the record for the operator.
    expect(r.degradations.join(" ")).toMatch(/nobody handles this message/);
    warn.mockRestore();
  });

  it("a model call that throws is reported, not swallowed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const throwing: PipelineModel = {
      name: "throwing",
      async complete() {
        throw new Error("529 Overloaded");
      },
    };
    const d = deps({ model: throwing });
    const r = await run([msg()], d);
    expect(r.ownedIds.size).toBe(0);
    expect(d.registered).toEqual([]);
    expect(r.degradations.join(" ")).toMatch(/529 Overloaded/);
    warn.mockRestore();
  });

  /**
   * A model that fails the first N attempts for ONE message body and
   * always succeeds for anything else. Keyed on the BODY rather than a
   * global counter because the extractors fan out in parallel, so a
   * counter would make which message failed depend on scheduling.
   */
  function flakyFor(body: string, failures: number): PipelineModel {
    let seen = 0;
    return {
      name: "flaky",
      async complete(req) {
        if (req.user.includes(body)) {
          seen += 1;
          if (seen <= failures) throw new Error("529 Overloaded");
        }
        return {
          text: JSON.stringify(SELF_IN),
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0,
          ms: 1,
        };
      },
    };
  }

  it("RESCUES a message whose extraction failed once (§10 step 8's retry)", async () => {
    // This case used to assert `ownedIds.size === 1` — that the failed
    // message was lost and the other survived. That was correct while
    // the loser went to the ANALYZER. With no analyzer, losing it means
    // silence for someone who said "in", so `extractors.ts` retries the
    // attendance routes once and BOTH are now owned. The old assertion
    // would have quietly locked in the worse behaviour.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = deps({ model: flakyFor("aaa", 1) });
    const r = await run(
      [
        msg({ waMessageId: "a", body: "aaa", senderUserId: "u-pete" }),
        msg({ waMessageId: "b", body: "bbb", senderUserId: "u-dan" }),
      ],
      d,
    );
    expect(r.ownedIds.size).toBe(2);
    expect(d.registered.sort()).toEqual(["u-dan", "u-pete"]);
    warn.mockRestore();
  });

  it("one PERMANENTLY failed extraction does not cost the REST of the batch its decider", async () => {
    // The original point of this case, restated against a failure the
    // retry cannot rescue: the fallback is per MESSAGE. A batch where
    // one extractor call fails both attempts must not silence the
    // healthy ones alongside it.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = deps({ model: flakyFor("aaa", 2) });
    const r = await run(
      [
        msg({ waMessageId: "a", body: "aaa", senderUserId: "u-pete" }),
        msg({ waMessageId: "b", body: "bbb", senderUserId: "u-dan" }),
      ],
      d,
    );
    expect(r.ownedIds.size).toBe(1);
    expect(d.registered).toEqual(["u-dan"]);
    // And the one that was lost says so, loudly enough to reach the
    // operator note rather than vanishing.
    expect(r.degradations.join(" ")).toMatch(/529 Overloaded/);
    warn.mockRestore();
  });

  // ── the fallback under LOAD, not one throw ────────────────────────
  //
  // PR #44's own caveat: `maxRetries: 4` took the corpus sweep's ten
  // lost messages to zero, which means **the fallback never fired in
  // that sweep**. The retry is doing the work; this is the untested
  // second line. What an operator needs from it is not "it worked" but
  // "how often did it work, and would I have known", so the batch has to
  // report a RATE and it has to report it in the one case where the
  // engine has nothing left to report about.

  it("names the fallback RATE, not just the count", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = new Set(["a", "b", "c"]);
    const partial: PipelineModel = {
      name: "partial",
      async complete(req) {
        // The stub seam matches on the body; here the body IS the id.
        if ([...failing].some((id) => req.user.includes(`body-${id}`))) {
          throw new Error("529 Overloaded");
        }
        return {
          text: JSON.stringify(SELF_IN),
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0,
          ms: 1,
        };
      },
    };
    const d = deps({ model: partial });
    const r = await run(
      ["a", "b", "c", "d"].map((id) =>
        msg({ waMessageId: id, body: `body-${id}`, senderUserId: `u-${id}` }),
      ),
      d,
    );

    expect(r.ownedIds.size).toBe(1);
    expect(d.registered).toEqual(["u-d"]);
    const said = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(said).toMatch(/3 of 4/);
    expect(said).toMatch(/75(\.0)?%/);
    warn.mockRestore();
  });

  it("carries EVERY degradation out when EVERY extraction fails", async () => {
    // The total-overload edge. The engine owns nothing and returns
    // early; returning a bare empty result there would throw away the
    // only record of why it went quiet, and the caller would have a
    // batch that looks exactly like "the engine was switched off".
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dead: PipelineModel = {
      name: "dead",
      async complete() {
        throw new Error("529 Overloaded");
      },
    };
    const d = deps({ model: dead });
    const r = await run(
      ["a", "b", "c"].map((id) =>
        msg({ waMessageId: id, body: `body-${id}`, senderUserId: `u-${id}` }),
      ),
      d,
    );

    expect(r.ownedIds.size).toBe(0);
    expect(d.registered).toEqual([]);
    // One per message, each naming the message it lost and where it went.
    for (const id of ["a", "b", "c"]) {
      expect(r.degradations.join("\n")).toContain(id);
    }
    expect(
      r.degradations.filter((x) => /nobody handles this message/.test(x)),
    ).toHaveLength(3);
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/3 of 3/);
    warn.mockRestore();
  });

  it("a failure on the ONE message carrying the write hands exactly that one back", async () => {
    // The edge that decides whether the fallback is worth anything: the
    // batch is mostly noise and the single message that moves a squad
    // place is the one that fails.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onlyTheWriter: PipelineModel = {
      name: "only-the-writer",
      async complete(req) {
        if (req.user.includes("im in lads")) throw new Error("529 Overloaded");
        return {
          text: JSON.stringify({ claims: [], affirmation: "none", sideRequests: [] }),
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0,
          ms: 1,
        };
      },
    };
    const d = deps({ model: onlyTheWriter });
    const r = await run(
      [
        msg({ waMessageId: "n1", body: "😂😂", senderUserId: "u-a", route: "unsure" }),
        msg({ waMessageId: "w", body: "im in lads", senderUserId: "u-pete" }),
        msg({ waMessageId: "n2", body: "who's watching the derby", senderUserId: "u-b" }),
      ],
      d,
    );

    // The writer is NOT owned — it goes to the analyzer, which still has
    // every seatbelt around it — and the engine keeps the rest.
    expect(r.ownedIds.has("w")).toBe(false);
    expect(d.registered).toEqual([]);
    expect(r.degradations.join("\n")).toMatch(/w: attendance extractor failed/);
    warn.mockRestore();
  });

  it("REPORTS a batch that lost everything — the silence this fix found", async () => {
    // The condition that was wrong, in the one place it can be tested.
    // The route composed its operator lines behind
    // `if (engineOwnedIds.size > 0)`, so a batch where EVERY extraction
    // failed printed nothing and read exactly like a batch where the
    // flag was off. The engine had gone quiet and the log agreed.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dead: PipelineModel = {
      name: "dead",
      async complete() {
        throw new Error("529 Overloaded");
      },
    };
    const r = await run([msg({ waMessageId: "a", body: "in" })], deps({ model: dead }));
    const report = describeEngineBatch(r, 1);

    expect(r.ownedIds.size).toBe(0);
    expect(report.warns.length).toBeGreaterThan(0);
    expect(report.warns.join("\n")).toMatch(/529 Overloaded/);
    expect(report.info).toMatch(/decided 0\/1 message\(s\)/);
    warn.mockRestore();
  });

  it("says NOTHING about a batch that owned nothing and lost nothing", async () => {
    // The other half: with the flag off, or a window of pure banter, the
    // engine must not put a line in the log every ten minutes.
    const r = await run([msg({ route: "none" })], deps());
    const report = describeEngineBatch(r, 1);
    expect(report.warns).toEqual([]);
    expect(report.info).toBeNull();
  });
});

// ── the engine sees the whole window ────────────────────────────────

describe("the engine is given every message in the batch, not just the ones it owns", () => {
  it("a non-owned message still gets an outcome inside the engine and no write", async () => {
    // `assertCoverage` requires exactly one outcome per input message,
    // and the banter-drop guard + the state collapse both scan the
    // window. Passing only the owned subset would silently narrow both.
    const d = deps();
    const r = await run([msg({ waMessageId: "a" }), msg({ waMessageId: "b", route: "question" })], d);
    // Only `a` is owned and only `a` gets a route-6 outcome…
    expect([...r.ownedIds]).toEqual(["a"]);
    expect([...r.outcomes.keys()]).toEqual(["a"]);
    // …and nothing was written for `b`.
    expect(d.registered).toEqual(["u-pete"]);
  });
});

// ── the pure derivations ────────────────────────────────────────────

const att = (over: Partial<AttendanceFacts> = {}): AttendanceFacts => ({
  kind: "attendance",
  claims: [],
  affirmation: null,
  sideRequests: [],
  ...over,
});

describe("intentFor — the admin log's vocabulary, from the OUTCOME", () => {
  const w = (userId: string, status: "CONFIRMED" | "BENCH" | "DROPPED") => ({
    kind: "attendance" as const,
    userId,
    name: "X",
    status,
    explicitBench: false,
    promote: false,
    sourceMessageId: "m",
    reason: "r",
  });

  it("reports the SENDER's own move first", () => {
    expect(intentFor([w("u-pete", "DROPPED")], "u-pete", null, null)).toBe("out");
    expect(intentFor([w("u-pete", "CONFIRMED")], "u-pete", null, null)).toBe("in");
    expect(intentFor([w("u-pete", "BENCH")], "u-pete", null, null)).toBe("in");
  });

  it("reports a third-party write as an add", () => {
    expect(intentFor([w("u-dan", "CONFIRMED")], "u-pete", null, null)).toBe("in");
  });

  it("distinguishes a held conditional from silence", () => {
    const facts = att({
      claims: [
        {
          subject: "sender",
          personRef: "",
          personNamed: false,
          polarity: "in",
          contingent: true,
          conditionOn: "self",
          tense: "present",
          basis: "decision",
          reported: false,
          confidence: 0.9,
        },
      ],
    });
    expect(intentFor([], "u-pete", facts, null)).toBe("conditional_in");
  });

  it("distinguishes a cover request from silence", () => {
    expect(intentFor([], "u-pete", att({ sideRequests: ["recruit"] }), null)).toBe(
      "replacement_request",
    );
  });

  it("is `noise` only when nothing happened and nothing was said", () => {
    expect(intentFor([], "u-pete", att(), null)).toBe("noise");
    expect(intentFor([], "u-pete", att(), "here you go")).toBe("question");
  });
});

describe("tentativeUserId — conditional_in flavour (b) survives the move", () => {
  const selfClaim = (over: Record<string, unknown> = {}) => ({
    subject: "sender" as const,
    personRef: "",
    personNamed: false,
    polarity: "in" as const,
    contingent: true,
    conditionOn: "self" as const,
    tense: "present" as const,
    basis: "decision" as const,
    reported: false,
    confidence: 0.9,
    ...over,
  });

  it("records a MAYBE for personal uncertainty", () => {
    expect(tentativeUserId(att({ claims: [selfClaim()] }), "u-pete", [])).toBe("u-pete");
  });

  it("does NOT record one for a standing offer — that one registers", () => {
    // §3.2 S15: flavour (a) and flavour (b) have opposite outcomes, and
    // conflating them is the A5 incident.
    expect(
      tentativeUserId(att({ claims: [selfClaim({ conditionOn: "squad" })] }), "u-pete", []),
    ).toBeNull();
  });

  it("does NOT record one for a contingent DROP — that one holds", () => {
    expect(
      tentativeUserId(att({ claims: [selfClaim({ polarity: "out" })] }), "u-pete", []),
    ).toBeNull();
  });

  it("does NOT record one for a past or hypothetical claim", () => {
    for (const tense of ["past", "hypothetical"]) {
      expect(tentativeUserId(att({ claims: [selfClaim({ tense })] }), "u-pete", [])).toBeNull();
    }
  });

  it("does NOT record one when the sender's row actually moved", () => {
    const landed = [
      {
        kind: "attendance" as const,
        userId: "u-pete",
        name: "Pete",
        status: "CONFIRMED" as const,
        explicitBench: false,
        promote: false,
        sourceMessageId: "m",
        reason: "r",
      },
    ];
    expect(tentativeUserId(att({ claims: [selfClaim()] }), "u-pete", landed)).toBeNull();
  });

  it("does NOT record one for an unresolved sender", () => {
    expect(tentativeUserId(att({ claims: [selfClaim()] }), null, [])).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * THE ONE THING A PASTED ROSTER MAY ALSO SAY (2026-09-07)
 * ══════════════════════════════════════════════════════════════════════
 *
 * The defect, found by PR #55's port and marked `test.fail()` there: the
 * route peeled ANY roster-shaped message out of the batch before the
 * router ran, and this file refused the same shape independently. So a
 * message that was BOTH a list and its sender's own drop lost the drop.
 * Pat writes "can't make it lads, someone take my spot" above the list
 * and stays CONFIRMED — the squad reads full, the vacated slot is never
 * offered to the bench, and the club is a player short.
 *
 * The refusal is now `clampPastedRosterFacts` over the facts, and its
 * two directions are asserted here at the level that owns them.
 */
describe("a roster-shaped message keeps exactly one thing: the sender's own drop", () => {
  const ROSTER =
    "1. Pete Power\n2. Dan Drummer\n3. Alice Admin\n4. Someone Else\n5. Another Name";

  const SELF_OUT_PLUS_LIST = {
    claims: [
      {
        subject: "sender",
        personRef: "",
        personNamed: false,
        polarity: "out",
        contingent: false,
        conditionOn: "none",
        tense: "present",
        reported: false,
        confidence: 0.95,
      },
      // …and two names the extractor read off the list, which is exactly
      // what PR #35 measured as a coin flip between runs.
      {
        subject: "other",
        personRef: "Dan Drummer",
        personNamed: true,
        polarity: "in",
        contingent: false,
        conditionOn: "none",
        tense: "present",
        reported: false,
        confidence: 0.95,
      },
      {
        subject: "other",
        personRef: "Alice Admin",
        personNamed: true,
        polarity: "in",
        contingent: false,
        conditionOn: "none",
        tense: "present",
        reported: false,
        confidence: 0.95,
      },
    ],
    affirmation: "none",
    sideRequests: [],
  };

  /** Pete is in the squad, so there is a row to drop. */
  const withPeteIn = () =>
    state({ rows: [{ userId: "u-pete", status: "CONFIRMED" as const, position: 1 }] });

  it("the drop LANDS, and it is the only write", async () => {
    const d = deps({
      model: modelReturning(SELF_OUT_PLUS_LIST),
      loadState: async () => withPeteIn(),
    });
    const r = await run(
      [msg({ body: `can't make it lads, someone take my spot\n${ROSTER}` })],
      d,
    );
    expect([...r.ownedIds]).toEqual(["wa-1"]);
    expect(d.cancelled).toEqual(["u-pete"]);
    // Not one name off the list — that is the direction that puts a
    // player at a pitch with no slot.
    expect(d.registered).toEqual([]);
    expect(r.outcomes.get("wa-1")).toMatchObject({ intent: "out", action: "OUT" });
  });

  it("the same message with no drop in it owns nothing at all", async () => {
    // Byte-identical to the pre-2026-09-07 refusal, and this is the case
    // that keeps an ordinary posted list silent.
    const d = deps({
      model: modelReturning({
        claims: SELF_OUT_PLUS_LIST.claims.filter((c) => c.subject === "other"),
        affirmation: "none",
        sideRequests: [],
      }),
      loadState: async () => withPeteIn(),
    });
    const r = await run([msg({ body: ROSTER })], d);
    expect(r.ownedIds.size).toBe(0);
    expect(d.registered).toEqual([]);
    expect(d.cancelled).toEqual([]);
  });

  it("a drop with NO list in it is untouched by any of this", async () => {
    const d = deps({
      model: modelReturning({
        claims: [SELF_OUT_PLUS_LIST.claims[0]],
        affirmation: "none",
        sideRequests: [],
      }),
      loadState: async () => withPeteIn(),
    });
    const r = await run([msg({ body: "sorry lads can't make it tonight" })], d);
    expect([...r.ownedIds]).toEqual(["wa-1"]);
    expect(d.cancelled).toEqual(["u-pete"]);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * THE GUEST-NAME-ASK SLOT — A READER THAT FINALLY HAS A WRITER
 * ══════════════════════════════════════════════════════════════════════
 *
 * `guest-name-ask.ts`'s third gate is "at most ONE ask per player per
 * match, forever". `load-state.ts` reads the `SentNotification` row and
 * `engine.ts` decides on it; between §10 step 8 and 2026-09-07 NOTHING
 * WROTE IT, so `alreadyAsked` was permanently false and MatchTime asked
 * again on every offer. The write is a dep so that this file can assert
 * the ORDER, which is the part that matters: claim, then speak.
 */
describe("the unnamed-guest name ask claims its once-per-match slot before it speaks", () => {
  const OFFER = "my brother can play if needed";
  const UNNAMED_GUEST = {
    claims: [
      {
        subject: "other",
        personRef: "my brother",
        personNamed: false,
        polarity: "in",
        contingent: true,
        conditionOn: "squad",
        tense: "future",
        reported: false,
        confidence: 0.9,
      },
    ],
    affirmation: "none",
    sideRequests: [],
  };

  const offerDeps = (over: Partial<EngineBatchDeps> = {}) =>
    deps({ model: modelReturning(UNNAMED_GUEST), ...over });

  it("asks, and RECORDS the ask against this player and this match", async () => {
    const d = offerDeps();
    const r = await run([msg({ body: OFFER, route: "offer" })], d);
    expect(r.outcomes.get("wa-1")?.reply).toMatch(/what(?:'s| is| are) their names?\?/i);
    expect(d.guestAsksClaimed).toEqual([{ matchId: "match-1", userId: "u-pete" }]);
  });

  it("does NOT ask when the state already carries the row — the shipped gate", async () => {
    const d = offerDeps({ loadState: async () => state({ guestAskedUserIds: ["u-pete"] }) });
    const r = await run([msg({ body: OFFER, route: "offer" })], d);
    expect(r.outcomes.get("wa-1")?.reply).toBeNull();
    // Nothing was said, so nothing was claimed.
    expect(d.guestAsksClaimed).toEqual([]);
  });

  it("asks AGAIN on a different match — the key is per match, not per player", async () => {
    const d = offerDeps({
      // Same player, same `guestAskedUserIds` read, different match: the
      // rows are looked up `where kind AND matchId`, so a row on last
      // week's match cannot silence this week's ask.
      loadState: async () => state({ matchId: "match-2", guestAskedUserIds: [] }),
    });
    const r = await runOn("match-2", [msg({ body: OFFER, route: "offer" })], d);
    expect(r.outcomes.get("wa-1")?.reply).toMatch(/what(?:'s| is| are) their names?\?/i);
    expect(d.guestAsksClaimed).toEqual([{ matchId: "match-2", userId: "u-pete" }]);
  });

  it("LOSES the race → says nothing, rather than asking twice", async () => {
    // A concurrent batch got the row first. Under-asking is a no-op;
    // double-asking is the nagging the gate exists to prevent, which is
    // why the claim happens before composition and not after the send.
    const d = offerDeps({ claimGuestNameAsk: async () => false });
    const r = await run([msg({ body: OFFER, route: "offer" })], d);
    expect(r.outcomes.get("wa-1")?.reply).toBeNull();
  });

  it("a claim that THROWS is treated as lost — silence, never an unrecorded ask", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = offerDeps({
      claimGuestNameAsk: async () => {
        throw new Error("db down");
      },
    });
    const r = await run([msg({ body: OFFER, route: "offer" })], d);
    expect(r.outcomes.get("wa-1")?.reply).toBeNull();
    err.mockRestore();
  });

  it("never writes an attendance row either way", async () => {
    const d = offerDeps();
    await run([msg({ body: OFFER, route: "offer" })], d);
    expect(d.registered).toEqual([]);
    expect(d.cancelled).toEqual([]);
  });
});
