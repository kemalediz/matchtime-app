/**
 * THE MONEY COLLECTOR'S REPLY TO A FEE QUESTION (2026-10-30, P5 of the
 * "no string parsing" sweep).
 *
 * The model reads every reply (a bare ✅ included); code acts on facts:
 * the right sender, an open question, the amount waiting. These tests pin
 * both halves with the model stubbed: what the reading may do, and the
 * adversarial cases where it must do nothing (a wrong sender, no open
 * question, a "no", a model failure, a yes naming a different amount).
 */
import { describe, it, expect } from "vitest";
import {
  FEE_REPLY_MAX_AMOUNT,
  FEE_REPLY_MIN_CONFIDENCE,
  FEE_REPLY_SYSTEM_PROMPT,
  buildFeeReplyUserTurn,
  classifyFeeReply,
  parseFeeReplyIntent,
  type FeeReplyRead,
} from "../fee-confirm";
import { runCollectorFeeReply, type CollectorFeeDeps } from "../payment-flow";

const read = (intent: FeeReplyRead["intent"], amount: number | null = null, amountIs: FeeReplyRead["amountIs"] = null): FeeReplyRead => ({
  intent,
  amount,
  amountIs: amount != null ? (amountIs ?? "each") : null,
  confidence: 0.95,
  reasoning: "stub",
});

// ── THE MODEL CALL, AND EVERY WAY IT CAN FAIL ────────────────────────

describe("classifyFeeReply fails closed to `neither`", () => {
  const ctx = { pending: 10.3, matchName: "Tuesday 5-a-side" };

  it("no classifier available → neither", async () => {
    expect((await classifyFeeReply("go for it mate", ctx, null)).intent).toBe("neither");
  });

  it("a throwing call → neither", async () => {
    const boom = async () => {
      throw new Error("overloaded");
    };
    expect((await classifyFeeReply("go for it mate", ctx, boom)).intent).toBe("neither");
  });

  it("unparseable output → neither", async () => {
    expect((await classifyFeeReply("go for it", ctx, async () => "I think so?")).intent).toBe("neither");
  });

  it("an intent outside the enum → neither", async () => {
    const out = JSON.stringify({ intent: "maybe", confidence: 1, reasoning: "x" });
    expect((await classifyFeeReply("go for it", ctx, async () => out)).intent).toBe("neither");
  });

  it("below the confidence floor → neither", async () => {
    const out = JSON.stringify({ intent: "yes", amount: null, amountIs: null, confidence: FEE_REPLY_MIN_CONFIDENCE - 0.01 });
    expect((await classifyFeeReply("go for it", ctx, async () => out)).intent).toBe("neither");
  });

  it("an empty reply never reaches the model", async () => {
    let called = false;
    const r = await classifyFeeReply("   ", ctx, async () => {
      called = true;
      return "{}";
    });
    expect(r.intent).toBe("neither");
    expect(called).toBe(false);
  });

  it("a confident yes is passed through", async () => {
    const out = JSON.stringify({ intent: "yes", amount: null, amountIs: null, confidence: 0.97, reasoning: "go-ahead" });
    expect(await classifyFeeReply("✅", ctx, async () => out)).toMatchObject({ intent: "yes", amount: null });
  });

  it("the user turn carries the amount waiting, the match and the reply", () => {
    const turn = buildFeeReplyUserTurn("go for it", ctx);
    expect(turn).toContain("Amount waiting for their yes: £10.30 per player");
    expect(turn).toContain("Tuesday 5-a-side");
    expect(turn).toMatch(/THEIR REPLY:\ngo for it$/);
  });

  it("with nothing waiting, the user turn says so", () => {
    expect(buildFeeReplyUserTurn("8", { pending: null, matchName: "Tue" })).toContain("Amount waiting for their yes: none");
  });

  it("the system prompt names the failure shape it exists to catch, in both languages", () => {
    expect(FEE_REPLY_SYSTEM_PROMPT).toContain('"great game 👍" | "harika maç 👍"');
    expect(FEE_REPLY_SYSTEM_PROMPT).not.toMatch(/[—–]/);
  });
});

describe("parseFeeReplyIntent checks the model's output, never his words", () => {
  it("tolerates a fenced block", () => {
    const raw = '```json\n{"intent":"no","confidence":0.9,"reasoning":"not yet"}\n```';
    expect(parseFeeReplyIntent(raw).intent).toBe("no");
  });
  it("clamps a nonsense confidence rather than trusting it", () => {
    expect(parseFeeReplyIntent('{"intent":"yes","confidence":12}').confidence).toBe(1);
  });
  it("an amount reading with each or total passes", () => {
    expect(parseFeeReplyIntent('{"intent":"amount","amount":80,"amountIs":"total","confidence":0.9}')).toMatchObject({
      intent: "amount",
      amount: 80,
      amountIs: "total",
    });
  });
  it("an amount reading with no number, a zero, a negative or over the cap is `neither`", () => {
    for (const amount of [null, 0, -8, FEE_REPLY_MAX_AMOUNT + 1, "8"]) {
      const raw = JSON.stringify({ intent: "amount", amount, amountIs: "each", confidence: 0.95 });
      expect(parseFeeReplyIntent(raw).intent).toBe("neither");
    }
  });
  it("an amount reading that does not say each or total is `neither`", () => {
    expect(parseFeeReplyIntent('{"intent":"amount","amount":8,"amountIs":"pp","confidence":0.95}').intent).toBe("neither");
  });
  it("a yes with a garbled amount is `neither`, not a bare yes", () => {
    expect(parseFeeReplyIntent('{"intent":"yes","amount":-3,"amountIs":"each","confidence":0.95}').intent).toBe("neither");
  });
  it("a `no` drops any amount", () => {
    expect(parseFeeReplyIntent('{"intent":"no","amount":8,"amountIs":"each","confidence":0.95}')).toMatchObject({ intent: "no", amount: null });
  });
});

// ── THE FLOW, WITH THE MONEY INJECTED ────────────────────────────────

const AMOUNT = 10.3;

function recorder(over: Partial<CollectorFeeDeps> = {}, reading: FeeReplyRead = read("neither")) {
  const calls = {
    /** ⚠️ every entry here is 8-13 real people asked for money. */
    released: [] as Array<{ matchId: string; amount: number }>,
    cancelled: [] as string[],
    staged: [] as Array<{ matchId: string; perPlayer: number }>,
    judged: [] as Array<{ text: string; pending: number | null }>,
  };
  const deps: CollectorFeeDeps = {
    pendingMatch: async () => ({ id: "m1", name: "Tuesday 5-a-side", feePendingConfirm: AMOUNT }),
    headcount: async () => 9,
    judge: async (text, ask) => {
      calls.judged.push({ text, pending: ask.pending });
      return reading;
    },
    release: async (matchId, amount) => {
      calls.released.push({ matchId, amount });
      return 8;
    },
    cancel: async (matchId) => {
      calls.cancelled.push(matchId);
    },
    stage: async (matchId, perPlayer) => {
      calls.staged.push({ matchId, perPlayer });
    },
    ...over,
  };
  return { deps, calls };
}

const ASKED_NOTHING_WAITING = async () => ({ id: "m1", name: "Tuesday 5-a-side", feePendingConfirm: null, feeAsked: true });

describe("an amount waiting: the model's yes releases exactly that amount", () => {
  it("a bare ✅ goes to the model, and its yes releases the waiting amount", async () => {
    const { deps, calls } = recorder({}, read("yes"));
    const res = await runCollectorFeeReply("✅", deps);
    expect(calls.judged).toEqual([{ text: "✅", pending: AMOUNT }]);
    expect(calls.released).toEqual([{ matchId: "m1", amount: AMOUNT }]);
    expect(res?.reply).toContain("8 pay links");
  });

  it("a natural go-ahead read as yes is released", async () => {
    const { deps, calls } = recorder({}, read("yes"));
    await runCollectorFeeReply("yeah go on then, fire them out", deps);
    expect(calls.released).toEqual([{ matchId: "m1", amount: AMOUNT }]);
  });

  it("a yes naming the SAME amount releases it", async () => {
    const { deps, calls } = recorder({}, read("yes", 10.3));
    await runCollectorFeeReply("yes £10.30 is right", deps);
    expect(calls.released).toEqual([{ matchId: "m1", amount: AMOUNT }]);
  });

  it("a release that lost the race (null) sends no ack", async () => {
    const { deps } = recorder({ release: async () => null }, read("yes"));
    expect(await runCollectorFeeReply("✅", deps)).toBeNull();
  });

  it("the release ack names the match's club and date when known", async () => {
    const { deps } = recorder(
      { pendingMatch: async () => ({ id: "m1", name: "Tuesday 5-a-side", feePendingConfirm: AMOUNT, orgId: "org-b", date: new Date("2026-10-13T19:00:00Z") }) },
      read("yes"),
    );
    const res = await runCollectorFeeReply("✅", deps);
    expect(res).toMatchObject({ orgId: "org-b", matchId: "m1" });
    expect(res?.reply).toContain("on Tue 13 Oct");
  });
});

describe("an amount: staged and asked again, never charged off the message", () => {
  it("a new amount supersedes the waiting one", async () => {
    const { deps, calls } = recorder({}, read("amount", 12));
    const res = await runCollectorFeeReply("£12 each", deps);
    expect(calls.staged).toEqual([{ matchId: "m1", perPlayer: 12 }]);
    expect(calls.released).toEqual([]);
    expect(res?.asked).toBe(true);
    expect(res?.reply).toContain("£12");
  });

  it("an amount with nothing waiting, after the fee ask, is staged", async () => {
    const { deps, calls } = recorder({ pendingMatch: ASKED_NOTHING_WAITING }, read("amount", 10.3));
    const res = await runCollectorFeeReply("£10.30 each", deps);
    expect(calls.staged).toEqual([{ matchId: "m1", perPlayer: 10.3 }]);
    expect(calls.judged).toEqual([{ text: "£10.30 each", pending: null }]);
    expect(res?.reply).toContain("£10.30");
  });

  it("a total is split across the players who pay, and the confirm says how many are free", async () => {
    const { deps, calls } = recorder({ pendingMatch: ASKED_NOTHING_WAITING, headcount: async () => 8, freeCount: async () => 2 }, read("amount", 80, "total"));
    const res = await runCollectorFeeReply("£80 total", deps);
    expect(calls.staged).toEqual([{ matchId: "m1", perPlayer: 10 }]);
    expect(res?.reply).toContain("8 players to charge");
    expect(res?.reply).toContain("(2 players are on a free place and not counted.)");
  });

  it("a total with nobody to charge stages nothing", async () => {
    const { deps, calls } = recorder({ pendingMatch: ASKED_NOTHING_WAITING, headcount: async () => 0 }, read("amount", 80, "total"));
    expect(await runCollectorFeeReply("£80 total", deps)).toBeNull();
    expect(calls.staged).toEqual([]);
  });
});

// ── ADVERSARIAL: ONE PER GATE ────────────────────────────────────────

describe("adversarial: every gate holds even when the model says yes", () => {
  it("WRONG SENDER: not this match's collector (no pending match) → nothing, and the model is never asked", async () => {
    const { deps, calls } = recorder({ pendingMatch: async () => null }, read("yes"));
    expect(await runCollectorFeeReply("✅", deps)).toBeNull();
    expect(calls.judged).toEqual([]);
    expect(calls.released).toEqual([]);
    expect(calls.staged).toEqual([]);
  });

  it("NO OPEN QUESTION: nothing waiting and no fee ask sent → nothing, and the model is never asked", async () => {
    const { deps, calls } = recorder(
      { pendingMatch: async () => ({ id: "m1", name: "Tuesday 5-a-side", feePendingConfirm: null, feeAsked: false }) },
      read("amount", 8),
    );
    expect(await runCollectorFeeReply("£8 each", deps)).toBeNull();
    expect(calls.judged).toEqual([]);
    expect(calls.staged).toEqual([]);
  });

  it("NOTHING WAITING: a yes to the fee ask releases nothing (there is no amount to release)", async () => {
    const { deps, calls } = recorder({ pendingMatch: ASKED_NOTHING_WAITING }, read("yes"));
    expect(await runCollectorFeeReply("✅ yes send them", deps)).toBeNull();
    expect(calls.released).toEqual([]);
    expect(calls.staged).toEqual([]);
  });

  it('A "NO" READ: cancels the waiting amount and releases nothing', async () => {
    const { deps, calls } = recorder({}, read("no"));
    const res = await runCollectorFeeReply("hold off until I've counted the cash", deps);
    expect(calls.cancelled).toEqual(["m1"]);
    expect(calls.released).toEqual([]);
    expect(res?.reply).toContain("cancelled");
  });

  it('A "NO" with nothing waiting changes nothing', async () => {
    const { deps, calls } = recorder({ pendingMatch: ASKED_NOTHING_WAITING }, read("no"));
    expect(await runCollectorFeeReply("not yet", deps)).toBeNull();
    expect(calls.cancelled).toEqual([]);
  });

  it("MODEL FAILURE: a thrown judge releases, cancels and stages nothing", async () => {
    const { deps, calls } = recorder({
      judge: async () => {
        throw new Error("overloaded");
      },
    });
    expect(await runCollectorFeeReply("✅", deps)).toBeNull();
    expect(calls.released).toEqual([]);
    expect(calls.cancelled).toEqual([]);
    expect(calls.staged).toEqual([]);
  });

  it("MODEL FAILURE: a `neither` (what every classifier failure becomes) does nothing and falls through", async () => {
    const { deps, calls } = recorder({}, read("neither"));
    expect(await runCollectorFeeReply("great game 👍", deps)).toBeNull();
    expect(calls.released).toEqual([]);
    expect(calls.cancelled).toEqual([]);
    expect(calls.staged).toEqual([]);
  });

  it("WRONG AMOUNT: a yes naming a different amount releases NOTHING; the new amount is staged and asked again", async () => {
    const { deps, calls } = recorder({}, read("yes", 12));
    const res = await runCollectorFeeReply("✅ actually make it £12", deps);
    expect(calls.released).toEqual([]);
    expect(calls.staged).toEqual([{ matchId: "m1", perPlayer: 12 }]);
    expect(res?.asked).toBe(true);
  });
});

describe("monthly: a yes to a PAYG question whose amount was never staged", () => {
  it("the yes stages the asked price (the monthly gates decide) and releases it", async () => {
    const { deps, calls } = recorder({ pendingMatch: ASKED_NOTHING_WAITING, stageAskedFee: async () => 8 }, read("yes"));
    const res = await runCollectorFeeReply("✅", deps);
    expect(calls.released).toEqual([{ matchId: "m1", amount: 8 }]);
    expect(res?.released).toBe(8);
  });

  it("the monthly gates refusing (null) releases nothing", async () => {
    const { deps, calls } = recorder({ pendingMatch: ASKED_NOTHING_WAITING, stageAskedFee: async () => null }, read("yes"));
    expect(await runCollectorFeeReply("✅", deps)).toBeNull();
    expect(calls.released).toEqual([]);
  });

  it("a `neither` never reaches the monthly staging", async () => {
    let asked = false;
    const { deps } = recorder({
      pendingMatch: ASKED_NOTHING_WAITING,
      stageAskedFee: async () => {
        asked = true;
        return 8;
      },
    });
    await runCollectorFeeReply("ok so I'll sort it tomorrow", deps);
    expect(asked).toBe(false);
  });
});
