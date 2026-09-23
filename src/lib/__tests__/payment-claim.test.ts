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
import { describe, it, expect } from "vitest";
import {
  PAYMENT_CLAIM_MIN_CONFIDENCE,
  buildPaymentClaimSystemPrompt,
  classifyPaymentClaim,
  parsePaymentClaim,
  paymentClaimBodyOf,
  pickClaimMatch,
  runPaymentClaim,
  type OwedMatch,
  type OwedMatchRow,
  type PaymentClaimDeps,
  type PaymentClaimIntent,
} from "../payment-claim";

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
    links: [] as string[],
    replies: [] as Array<{ orgId: string; text: string }>,
    sightings: 0,
  };
  const deps: PaymentClaimDeps = {
    owedMatch: async () => OWED,
    classify: async () => {
      calls.classified++;
      return "other";
    },
    firstSighting: async () => {
      calls.sightings++;
      return true;
    },
    markPending: async (matchId) => {
      calls.marked.push(matchId);
      return { ok: true, alreadyPending: false, amount: 8, quantity: 1, collectorNotified: true };
    },
    payLink: async (matchId) => {
      calls.links.push(matchId);
      return "https://mt.example/s/pay";
    },
    reply: async (args) => {
      calls.replies.push(args);
    },
    playerName: "Abid Kazmi",
    ...over,
  };
  return { calls, deps };
}

const says = (intent: PaymentClaimIntent) => ({ classify: async () => intent });

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
    expect(out).toEqual({ handled: "paid-claim", matchId: "m-tue", alreadyPending: false, collectorNotified: true });
    expect(r.calls.marked).toEqual(["m-tue"]);
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
  });

  it("a REPLAY of the same WhatsApp message is silent and writes nothing", async () => {
    const r = recorder({ ...says("paid"), firstSighting: async () => false });
    const out = await runPaymentClaim(r.deps);
    expect(out.handled).toBe("paid-claim-replay");
    expect(r.calls.marked).toEqual([]);
    expect(r.calls.replies).toEqual([]);
  });

  it("blocked at write time (the collector confirmed a moment ago): silent, and does not fall through", async () => {
    const r = recorder({
      ...says("paid"),
      markPending: async () => ({ ok: false, reason: "You're already paid for this match" }),
    });
    const out = await runPaymentClaim(r.deps);
    expect(out.handled).toBe("paid-claim-blocked");
    expect(r.calls.replies).toEqual([]);
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

  it("sends the whole message under a header, with the owed match and the last DM as context", async () => {
    let seen = "";
    const call = async (_s: string, user: string) => {
      seen = user;
      return JSON.stringify({ intent: "paid", confidence: 0.95, reasoning: "claim" });
    };
    const got = await classifyPaymentClaim(
      "Paid\nsent it to Kemal",
      { playerName: "Abid", owes: "£8 for Tuesday 7-a-side", lastBotDm: "💷 Quick one Abid, your £8 is still outstanding" },
      call,
    );
    expect(got).toBe("paid");
    expect(paymentClaimBodyOf(seen)).toBe("Paid\nsent it to Kemal");
    expect(seen).toContain("£8 for Tuesday 7-a-side");
    expect(seen).toContain("still outstanding");
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
