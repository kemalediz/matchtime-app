/**
 * A PLAYER DMs "Paid" (2026-09-23).
 *
 * Non-technical players skip the pay link and just tell MatchTime they
 * have paid. Nothing read that until now: Abid Kazmi's "Paid" at 18:09
 * on 2026-09-23 was lost. This is the player-side twin of the collector
 * fee flow, and it is shaped the same way: a pure orchestration of
 * injected callbacks, a model that only ever says "this looks like a
 * claim", and code that owns every gate and every write.
 *
 * The write it may make is the SAME one the pay page's "settle directly"
 * button makes (`markDirectPaymentPending`): a PENDING state the collector
 * must still confirm. It never marks anybody paid; see
 * `paid-claim-never-sets-paid-at.test.ts` for that guarantee on its own.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  PAYMENT_CLAIM_MIN_CONFIDENCE,
  buildPaymentClaimSystemPrompt,
  buildPaymentClaimUserTurn,
  classifyPaymentClaim,
  paymentClaimContext,
  parsePaymentClaim,
  paymentClaimBodyOf,
  pickClaimMatch,
  runPaymentClaim,
  type OwedMatch,
  type OwedMatchRow,
  type PaymentClaimDeps,
  type PaymentClaimClassification,
  type PaymentClaimIntent,
} from "../payment-claim";
import { noReplyContext, renderReplyContext, type ReplyContext } from "../reply-context";

// Mon 19 Oct 2026, 18:00 London.
const NOW = new Date("2026-10-19T17:00:00Z");
const PAY_CHASE_CTX: ReplyContext = {
  now: NOW,
  quoted: null,
  recent: [{ at: new Date("2026-10-19T16:00:00Z"), text: "💷 Quick one Abid, your £8 is still outstanding", topic: "paymentCollection", match: null }],
  earlier: null,
};

const OWED: OwedMatch = {
  matchId: "m-tue",
  orgId: "org-sutton",
  activityName: "Tuesday 7-a-side",
  fee: 8,
  lang: "en",
  collectorName: "Kemal Ediz",
};

function recorder(over: Partial<PaymentClaimDeps> = {}) {
  const calls = {
    classified: 0,
    marked: [] as string[],
    vias: [] as string[],
    links: [] as string[],
    replies: [] as Array<{ orgId: string; text: string }>,
    sightings: 0,
    reacted: [] as string[],
  };
  const deps: PaymentClaimDeps = {
    owedMatch: async () => OWED,
    classify: async () => {
      calls.classified++;
      return { intent: "other", confidence: 0.9, reasoning: "not a claim" };
    },
    firstSighting: async () => {
      calls.sightings++;
      return true;
    },
    markPending: async (matchId, via) => {
      calls.marked.push(matchId);
      calls.vias.push(via);
      return { ok: true, alreadyPending: false, amount: 8, quantity: 1, collectorNotified: true };
    },
    payLink: async (matchId) => {
      calls.links.push(matchId);
      return "https://mt.example/s/pay";
    },
    reply: async (args) => {
      calls.replies.push(args);
    },
    react: async (orgId) => {
      calls.reacted.push(orgId);
      return true;
    },
    playerName: "Abid Kazmi",
    userId: "u-abid",
    ...over,
  };
  return { calls, deps };
}

const says = (intent: PaymentClaimIntent) => ({
  classify: async (): Promise<PaymentClaimClassification> => ({ intent, confidence: 0.95, reasoning: "stub" }),
});

describe("nothing owed: the model is never asked and nothing happens", () => {
  it("no owed match (already paid, no fee yet, not in the squad, or the collector)", async () => {
    const r = recorder({ ...says("paid"), owedMatch: async () => null });
    const out = await runPaymentClaim(r.deps);
    expect(out.handled).toBeNull();
    expect(r.calls.classified).toBe(0);
    expect(r.calls.marked).toEqual([]);
    expect(r.calls.replies).toEqual([]);
  });
});

describe("not a claim: nothing is written, the DM falls through", () => {
  it("`other` writes nothing and replies nothing (a question reaches DM Q&A below)", async () => {
    const r = recorder(says("other"));
    const out = await runPaymentClaim(r.deps);
    expect(out.handled).toBeNull();
    expect(r.calls.marked).toEqual([]);
    expect(r.calls.replies).toEqual([]);
  });

  it("FAILS CLOSED when the model call throws", async () => {
    const r = recorder({
      classify: async () => {
        throw new Error("529 Overloaded");
      },
    });
    const out = await runPaymentClaim(r.deps);
    expect(out.handled).toBeNull();
    expect(r.calls.marked).toEqual([]);
    expect(r.calls.replies).toEqual([]);
  });
});

describe("a claim", () => {
  it("marks the owed match pending (the settle-directly write) and thanks the player", async () => {
    const r = recorder(says("paid"));
    const out = await runPaymentClaim(r.deps);
    expect(out).toEqual({
      handled: "paid-claim",
      matchId: "m-tue",
      alreadyPending: false,
      collectorNotified: true,
      reactionQueued: true,
    });
    expect(r.calls.marked).toEqual(["m-tue"]);
    expect(r.calls.reacted).toEqual(["org-sutton"]);
    expect(r.calls.replies).toHaveLength(1);
    expect(r.calls.replies[0].orgId).toBe("org-sutton");
    expect(r.calls.replies[0].text).toBe(
      "Thanks Abid, I've told Kemal you've paid *£8* for *Tuesday 7-a-side*. Kemal will confirm once it lands 👍",
    );
  });

  it("uses the collector's actual name, not a hardcoded one", async () => {
    const r = recorder({ ...says("paid"), owedMatch: async () => ({ ...OWED, collectorName: "Elvin Aliyev" }) });
    await runPaymentClaim(r.deps);
    expect(r.calls.replies[0].text).toContain("I've told Elvin");
    expect(r.calls.replies[0].text).not.toContain("Kemal");
  });

  it("replies in the org's language, in the sen register", async () => {
    const r = recorder({ ...says("paid"), owedMatch: async () => ({ ...OWED, lang: "tr", activityName: "Cuma Maçı" }) });
    await runPaymentClaim(r.deps);
    expect(r.calls.replies[0].text).toBe(
      "Teşekkürler Abid! *Cuma Maçı* için *£8* ödediğini ilettim. Kemal para eline geçince onaylayacak 👍",
    );
  });

  it("a second 'paid' while still pending: a different reply, and the collector is not re-notified", async () => {
    const r = recorder({
      ...says("paid"),
      markPending: async (matchId) => {
        r.calls.marked.push(matchId);
        return { ok: true, alreadyPending: true, amount: 8, quantity: 1, collectorNotified: false };
      },
    });
    const out = await runPaymentClaim(r.deps);
    expect(out).toMatchObject({ handled: "paid-claim", alreadyPending: true, collectorNotified: false });
    expect(r.calls.replies[0].text).toBe(
      "Already done Abid: Kemal knows about your *£8* for *Tuesday 7-a-side* and will confirm once it lands 👍",
    );
    // "Already done" still gets its ✅.
    expect(r.calls.reacted).toEqual(["org-sutton"]);
  });

  it("a REPLAY of the same WhatsApp message is silent and writes nothing", async () => {
    const r = recorder({ ...says("paid"), firstSighting: async () => false });
    const out = await runPaymentClaim(r.deps);
    expect(out.handled).toBe("paid-claim-replay");
    expect(r.calls.marked).toEqual([]);
    expect(r.calls.replies).toEqual([]);
    expect(r.calls.reacted).toEqual([]);
  });

  it("blocked at write time (the collector confirmed a moment ago): silent, and does not fall through", async () => {
    const r = recorder({
      ...says("paid"),
      markPending: async () => ({ ok: false, reason: "You're already paid for this match" }),
    });
    const out = await runPaymentClaim(r.deps);
    expect(out.handled).toBe("paid-claim-blocked");
    expect(r.calls.replies).toEqual([]);
    expect(r.calls.reacted).toEqual([]);
  });

  it("a failed ✅ is logged and changes nothing else: the claim is still recorded and the player still thanked", async () => {
    const r = recorder({
      ...says("paid"),
      react: async () => {
        throw new Error("db down");
      },
    });
    const out = await runPaymentClaim(r.deps);
    expect(out).toMatchObject({ handled: "paid-claim", reactionQueued: false });
    expect(r.calls.marked).toEqual(["m-tue"]);
    expect(r.calls.replies).toHaveLength(1);
  });

  it("not a claim never reacts", async () => {
    const r = recorder(says("other"));
    await runPaymentClaim(r.deps);
    expect(r.calls.reacted).toEqual([]);
  });
});

describe("paying for someone else is not guessed at", () => {
  it("writes NOTHING and points the player at the pay page's guest count", async () => {
    const r = recorder(says("paid_for_others"));
    const out = await runPaymentClaim(r.deps);
    expect(out).toEqual({ handled: "paid-claim-for-others", matchId: "m-tue" });
    expect(r.calls.marked).toEqual([]);
    expect(r.calls.links).toEqual(["m-tue"]);
    expect(r.calls.replies[0].text).toContain("https://mt.example/s/pay");
    expect(r.calls.replies[0].text).toContain("how many people you paid for");
  });
});

describe("which match: the most recent one still owed", () => {
  const row = (id: string, date: string, over: Partial<OwedMatchRow> = {}): OwedMatchRow => ({
    matchId: id,
    date: new Date(date),
    fee: 8,
    activityName: `Match ${id}`,
    orgId: "org-sutton",
    lang: "en",
    collectorId: "u-kemal",
    collectorName: "Kemal Ediz",
    ...over,
  });

  it("picks the most recent unpaid match, not the oldest", () => {
    const got = pickClaimMatch(
      [row("old", "2026-09-01T20:00:00Z"), row("new", "2026-09-22T20:00:00Z"), row("mid", "2026-09-15T20:00:00Z")],
      "u-abid",
    );
    expect(got?.matchId).toBe("new");
  });

  it("the collector never owes their own org", () => {
    expect(pickClaimMatch([row("a", "2026-09-22T20:00:00Z")], "u-kemal")).toBeNull();
  });

  it("nothing owed is null", () => {
    expect(pickClaimMatch([], "u-abid")).toBeNull();
  });
});

describe("the classifier's contract", () => {
  it("below the floor is `other`", () => {
    expect(PAYMENT_CLAIM_MIN_CONFIDENCE).toBe(0.8);
    expect(parsePaymentClaim(JSON.stringify({ intent: "paid", confidence: 0.79, reasoning: "x" })).intent).toBe("other");
    expect(parsePaymentClaim(JSON.stringify({ intent: "paid", confidence: 0.8, reasoning: "x" })).intent).toBe("paid");
  });

  it("an intent outside the enum is `other`", () => {
    expect(parsePaymentClaim(JSON.stringify({ intent: "paid_in_full", confidence: 1 })).intent).toBe("other");
  });

  it("garbage is `other`", () => {
    expect(parsePaymentClaim("sure, it's a payment").intent).toBe("other");
  });

  it("no model (no key) is `other`, and an empty body never asks", async () => {
    expect(await classifyPaymentClaim("Paid", { playerName: "Abid" }, null)).toBe("other");
    let asked = 0;
    const call = async () => {
      asked++;
      return JSON.stringify({ intent: "paid", confidence: 1 });
    };
    expect(await classifyPaymentClaim("   ", { playerName: "Abid" }, call)).toBe("other");
    expect(asked).toBe(0);
  });

  it("a thrown call is `other`", async () => {
    const call = async () => {
      throw new Error("overloaded");
    };
    expect(await classifyPaymentClaim("Paid", { playerName: "Abid" }, call)).toBe("other");
  });

  it("sends the whole message under a header, with the owed match and the chat context", async () => {
    let seen = "";
    const call = async (_s: string, user: string) => {
      seen = user;
      return JSON.stringify({ intent: "paid", confidence: 0.95, reasoning: "claim" });
    };
    const got = await classifyPaymentClaim(
      "Paid\nsent it to Kemal",
      { playerName: "Abid", owes: "£8 for Tuesday 7-a-side", replyContext: PAY_CHASE_CTX },
      call,
    );
    expect(got).toBe("paid");
    expect(paymentClaimBodyOf(seen)).toBe("Paid\nsent it to Kemal");
    expect(seen).toContain("£8 for Tuesday 7-a-side");
    expect(seen).toContain("still outstanding");
    expect(seen).toContain(renderReplyContext(PAY_CHASE_CTX));
  });

  it("the user turn carries the shared block, never the old last-message line", () => {
    const turn = buildPaymentClaimUserTurn("done", { playerName: "Abid", replyContext: PAY_CHASE_CTX });
    expect(turn).toContain("NOW: Monday 19 October 2026, 18:00 (club time, London)");
    expect(turn).toContain("MATCHTIME'S RECENT MESSAGES TO THEM");
    expect(turn).not.toContain("MatchTime's last message to them");
  });

  it("no context handed in still says the time now and that nothing is known", () => {
    const turn = buildPaymentClaimUserTurn("done", { playerName: "Abid" });
    expect(turn).toMatch(/NOW: /);
    expect(turn).toContain("none in the last 14 days");
  });

  it("the prompt reads the swipe-replied message, else the newest recent one", () => {
    const p = buildPaymentClaimSystemPrompt();
    expect(p).toMatch(/swipe-replied to/);
    expect(p).toMatch(/newest/);
    expect(p).not.toContain("MatchTime's last message");
  });

  it("the prompt names the not-a-claim shapes, in both languages", () => {
    const p = buildPaymentClaimSystemPrompt();
    for (const s of [
      "I'll pay later",
      "haven't paid yet",
      "how much do I owe?",
      "did you get my payment?",
      "paid last week",
      "sonra öderim",
      "daha ödemedim",
      "ödedim",
      "gönderdim",
      "paid for me and my mate",
    ]) {
      expect(p, s).toContain(s);
    }
    expect(p).not.toMatch(/[—–]/);
  });
});

// ── Feroz, FNF 2026-10-18 ─────────────────────────────────────────────
//   "I bank transferred Raihan" was read as `other` 5/5 because the model
//   was never told Raihan collects the money, and the `other` left no
//   trace in the logs. The context now names the collector, the last DM
//   includes the scheduler's chasers, and every verdict is logged.

describe("the classifier is told who collects the money", () => {
  it("the user turn names the money collector", () => {
    const turn = buildPaymentClaimUserTurn("I bank transferred Raihan", {
      playerName: "Feroz",
      owes: "£5 for Football 9-a-side",
      collectorName: "Raihan",
    });
    expect(turn).toContain("Money collector: Raihan");
    expect(paymentClaimBodyOf(turn)).toBe("I bank transferred Raihan");
  });

  it("no collector known: the line says so rather than vanishing", () => {
    const turn = buildPaymentClaimUserTurn("Paid", { playerName: "Feroz", owes: "£5 for X", collectorName: null });
    expect(turn).toContain("Money collector: (not known)");
  });

  it("the route's context carries the owed match's collector", () => {
    const ctx = paymentClaimContext(
      { ...OWED, collectorName: "Raihan", fee: 5, activityName: "Football 9-a-side" },
      "Feroz",
      noReplyContext(NOW),
    );
    expect(ctx).toEqual({
      playerName: "Feroz",
      owes: "£5 for Football 9-a-side",
      collectorName: "Raihan",
      replyContext: noReplyContext(NOW),
    });
  });

  it("the prompt defines the money collector and says paying someone else is not paying", () => {
    const p = buildPaymentClaimSystemPrompt();
    expect(p).toContain("Money collector:");
    expect(p).toMatch(/not the money collector/i);
  });
});

// ── "I'll pay Raihan directly" (Kemal, 2026-10-18) ────────────────────
//   A stated plan to pay the MONEY COLLECTOR directly is the pay page's
//   "Pay the collector directly" button: the same pending state (so the
//   chasers stop), the collector's notice in its "they'll pay you" form,
//   and the player's ack says "you'll pay", never "you've paid".

describe("a plan to pay the collector directly is the settle-directly button", () => {
  it("marks pending with the will-pay door, thanks the player in the will-pay words, reacts", async () => {
    const r = recorder(says("will_pay_direct"));
    const out = await runPaymentClaim(r.deps);
    expect(out).toEqual({
      handled: "will-pay-direct",
      matchId: "m-tue",
      alreadyPending: false,
      collectorNotified: true,
      reactionQueued: true,
    });
    expect(r.calls.marked).toEqual(["m-tue"]);
    expect(r.calls.vias).toEqual(["dm-will-pay"]);
    expect(r.calls.replies[0].text).toBe(
      "Noted Abid, I've told Kemal you'll pay them *£8* directly for *Tuesday 7-a-side*. Kemal will confirm once it lands 👍",
    );
    expect(r.calls.replies[0].text).not.toMatch(/you've paid/);
    expect(r.calls.reacted).toEqual(["org-sutton"]);
  });

  it("in Turkish", async () => {
    const r = recorder({
      ...says("will_pay_direct"),
      owedMatch: async () => ({ ...OWED, lang: "tr", activityName: "Cuma Maçı" }),
    });
    await runPaymentClaim(r.deps);
    expect(r.calls.replies[0].text).toBe(
      "Tamamdır Abid! *Cuma Maçı* için *£8* tutarını doğrudan ödeyeceğini ilettim. Kemal para eline geçince onaylayacak 👍",
    );
  });

  it("a `paid` claim still comes through the DM-claim door", async () => {
    const r = recorder(says("paid"));
    await runPaymentClaim(r.deps);
    expect(r.calls.vias).toEqual(["dm-claim"]);
  });

  it("a repeat while already pending gets the existing 'already done' reply", async () => {
    const r = recorder({
      ...says("will_pay_direct"),
      markPending: async () => ({ ok: true, alreadyPending: true, amount: 8, quantity: 1, collectorNotified: false }),
    });
    await runPaymentClaim(r.deps);
    expect(r.calls.replies[0].text).toBe(
      "Already done Abid: Kemal knows about your *£8* for *Tuesday 7-a-side* and will confirm once it lands 👍",
    );
  });

  it("the intent is in the classifier's closed enum and its prompt", () => {
    expect(parsePaymentClaim(JSON.stringify({ intent: "will_pay_direct", confidence: 0.9, reasoning: "x" })).intent).toBe(
      "will_pay_direct",
    );
    expect(buildPaymentClaimSystemPrompt()).toContain('"will_pay_direct"');
  });
});

describe("every verdict is logged, `other` included", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs user, match, intent, confidence and reasoning for an `other`", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const r = recorder({
      classify: async () => ({ intent: "other", confidence: 0.8, reasoning: "names another person (Raihan)" }),
    });
    await runPaymentClaim(r.deps);
    const line = info.mock.calls.map((c) => c.join(" ")).find((l) => l.includes("[payment-claim] verdict"));
    expect(line).toBeDefined();
    expect(line).toContain("user=u-abid");
    expect(line).toContain("match=m-tue");
    expect(line).toContain("intent=other");
    expect(line).toContain("confidence=0.80");
    expect(line).toContain("names another person (Raihan)");
  });

  it("logs a `paid` too", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await runPaymentClaim(recorder(says("paid")).deps);
    expect(info.mock.calls.some((c) => c.join(" ").includes("intent=paid "))).toBe(true);
  });

  it("nothing owed: no model call, so no verdict line", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await runPaymentClaim(recorder({ owedMatch: async () => null }).deps);
    expect(info.mock.calls.some((c) => c.join(" ").includes("[payment-claim] verdict"))).toBe(false);
  });
});
