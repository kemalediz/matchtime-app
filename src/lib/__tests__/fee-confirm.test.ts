/**
 * THE MONEY COLLECTOR'S "YES", AND THE THUMBS-UP THAT WAS NOT ONE.
 *
 * `isAffirmative`'s first line was `/[✅✔👍]/u.test(text)` — a thumbs-up
 * ANYWHERE in the body released the whole squad's pay links. Its word
 * list was unanchored at the end too (`/^(yes|…|ok|…)\b/`), so
 * "ok so I'll sort it tomorrow" was a yes. `isNegative` had the same
 * shape: "no worries mate" cancelled a pending fee.
 *
 * These tests pin the replacement. The two that matter most are the
 * first two — a fragment must not move money — and the two after them:
 * the anchored allowlist must keep working with the model unreachable,
 * and every failure of the model must leave the money where it is.
 */
import { describe, it, expect } from "vitest";
import {
  FEE_CONFIRM_ANCHORS_BEFORE_IT_ASKS,
  FEE_REPLY_MIN_CONFIDENCE,
  FEE_REPLY_SYSTEM_PROMPT,
  anchoredFeeReply,
  classifyFeeReply,
  parseFeeReplyIntent,
  type FeeReply,
} from "../fee-confirm";
import { runCollectorFeeReply, type CollectorFeeDeps } from "../payment-flow";

// ── THE DETERMINISTIC HALF ───────────────────────────────────────────

describe("anchoredFeeReply — a whole-body allowlist, never a fragment", () => {
  it("is what the constant says it is", () => {
    expect(FEE_CONFIRM_ANCHORS_BEFORE_IT_ASKS).toBe(true);
  });

  const YES = [
    "👍",
    "✅",
    "✔",
    "✔️",
    "👍🏽",
    "yes",
    "Yes",
    "yes.",
    "yeah",
    "yep",
    "yup",
    "ok",
    "OK!",
    "okay",
    "k",
    "confirm",
    "confirmed",
    "correct",
    "send",
    "send it",
    "send them",
    "yes send them",
    "yes please",
    "go on",
    "do it",
    "sure",
    "that's right",
    "release",
    "yes 👍",
    "👍 yes",
    "  ✅  ",
  ];
  for (const t of YES) {
    it(`accepts ${JSON.stringify(t)}`, () => {
      expect(anchoredFeeReply(t)).toBe("yes");
    });
  }

  const NO = ["no", "No.", "nope", "nah", "not yet", "wait", "hold", "cancel", "stop", "❌", "🚫", "no ❌"];
  for (const t of NO) {
    it(`refuses ${JSON.stringify(t)}`, () => {
      expect(anchoredFeeReply(t)).toBe("no");
    });
  }

  // ⚠️ THE BUG, BY NAME. Every one of these used to be a "yes" or a "no".
  const ABSTAIN = [
    "great game 👍",
    "cheers lads, great game 👍",
    "ok so I'll sort it tomorrow",
    "ok i will call goals and switch to 7aside again",
    "yes, Elvin still collects it",
    "sure will do",
    "yes pls, can you share the name?",
    "✅ means that player has been accepted to the main squad",
    "no worries mate, great game",
    "nah he's not playing, but send them anyway",
    "£12 each",
    "12",
    "",
    "   ",
    "👍❌",
  ];
  for (const t of ABSTAIN) {
    it(`abstains on ${JSON.stringify(t)}`, () => {
      expect(anchoredFeeReply(t)).toBeNull();
    });
  }
});

// ── THE MODEL HALF, AND EVERY WAY IT CAN FAIL ────────────────────────

describe("classifyFeeReply fails closed to `neither`", () => {
  const ctx = { amount: 10.3, matchName: "Tuesday 5-a-side" };

  it("no classifier available → neither", async () => {
    expect(await classifyFeeReply("go for it mate", ctx, null)).toBe("neither");
  });

  it("a throwing call → neither", async () => {
    const boom = async () => {
      throw new Error("overloaded");
    };
    expect(await classifyFeeReply("go for it mate", ctx, boom)).toBe("neither");
  });

  it("unparseable output → neither", async () => {
    expect(await classifyFeeReply("go for it", ctx, async () => "I think so?")).toBe("neither");
  });

  it("an intent outside the enum → neither", async () => {
    const out = JSON.stringify({ intent: "maybe", confidence: 1, reasoning: "x" });
    expect(await classifyFeeReply("go for it", ctx, async () => out)).toBe("neither");
  });

  it("below the confidence floor → neither", async () => {
    const out = JSON.stringify({
      intent: "yes",
      confidence: FEE_REPLY_MIN_CONFIDENCE - 0.01,
      reasoning: "unsure",
    });
    expect(await classifyFeeReply("go for it", ctx, async () => out)).toBe("neither");
  });

  it("a confident yes is passed through", async () => {
    const out = JSON.stringify({ intent: "yes", confidence: 0.97, reasoning: "direct go-ahead" });
    expect(await classifyFeeReply("go for it", ctx, async () => out)).toBe("yes");
  });

  it("the prompt carries the amount and the match, so the model knows what is being confirmed", async () => {
    let seen = "";
    await classifyFeeReply("go for it", ctx, async (_s, user) => {
      seen = user;
      return "{}";
    });
    expect(seen).toContain("10.30");
    expect(seen).toContain("Tuesday 5-a-side");
    expect(seen).toContain("go for it");
  });

  it("the system prompt names the failure shape it exists to catch", () => {
    expect(FEE_REPLY_SYSTEM_PROMPT).toContain("great game 👍");
  });
});

describe("parseFeeReplyIntent", () => {
  it("tolerates a fenced block", () => {
    const raw = '```json\n{"intent":"no","confidence":0.9,"reasoning":"not yet"}\n```';
    expect(parseFeeReplyIntent(raw).intent).toBe("no");
  });
  it("clamps a nonsense confidence rather than trusting it", () => {
    const raw = '{"intent":"yes","confidence":12,"reasoning":"x"}';
    expect(parseFeeReplyIntent(raw).confidence).toBe(1);
  });
});

// ── THE FLOW, WITH THE MONEY INJECTED ────────────────────────────────

const AMOUNT = 10.3;

function recorder(over: Partial<CollectorFeeDeps> = {}) {
  const calls = {
    /** ⚠️ every entry here is 8-13 real people asked for money. */
    released: [] as Array<{ matchId: string; amount: number }>,
    cancelled: [] as string[],
    staged: [] as Array<{ matchId: string; perPlayer: number }>,
    judged: [] as string[],
  };
  const deps: CollectorFeeDeps = {
    pendingMatch: async () => ({
      id: "m1",
      name: "Tuesday 5-a-side",
      feePendingConfirm: AMOUNT,
    }),
    headcount: async () => 9,
    judge: async (text) => {
      calls.judged.push(text);
      return "neither";
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

describe("runCollectorFeeReply — a fragment cannot release the squad's pay links", () => {
  it('"great game 👍" releases NOTHING', async () => {
    const { deps, calls } = recorder();
    const res = await runCollectorFeeReply("great game 👍", deps);
    expect(calls.released).toEqual([]);
    expect(calls.cancelled).toEqual([]);
    expect(res).toBeNull();
  });

  it('"ok so I\'ll sort it tomorrow" releases NOTHING', async () => {
    const { deps, calls } = recorder();
    const res = await runCollectorFeeReply("ok so I'll sort it tomorrow", deps);
    expect(calls.released).toEqual([]);
    expect(res).toBeNull();
  });

  it('"no worries mate, great game" cancels NOTHING', async () => {
    const { deps, calls } = recorder();
    await runCollectorFeeReply("no worries mate, great game", deps);
    expect(calls.cancelled).toEqual([]);
    expect(calls.released).toEqual([]);
  });
});

describe("runCollectorFeeReply — what the collector actually types still works", () => {
  for (const t of ["👍", "✅", "yes", "yes send them", "confirm", "ok", "yep"]) {
    it(`${JSON.stringify(t)} releases the links, and the model is never asked`, async () => {
      const { deps, calls } = recorder();
      const res = await runCollectorFeeReply(t, deps);
      expect(calls.released).toEqual([{ matchId: "m1", amount: AMOUNT }]);
      expect(calls.judged).toEqual([]);
      expect(res?.released).toBe(8);
      expect(res?.reply).toContain("8 pay links");
    });
  }

  it("the anchored yes does not need the model to be reachable at all", async () => {
    const { deps, calls } = recorder({
      judge: async () => {
        throw new Error("anthropic is down");
      },
    });
    const res = await runCollectorFeeReply("✅", deps);
    expect(calls.released).toEqual([{ matchId: "m1", amount: AMOUNT }]);
    expect(res?.released).toBe(8);
  });

  it('"no" cancels, and the model is never asked', async () => {
    const { deps, calls } = recorder();
    const res = await runCollectorFeeReply("no", deps);
    expect(calls.cancelled).toEqual(["m1"]);
    expect(calls.released).toEqual([]);
    expect(calls.judged).toEqual([]);
    expect(res?.reply).toContain("cancelled");
  });
});

describe("runCollectorFeeReply — the model only ever sees what the allowlist could not decide", () => {
  it("a natural go-ahead the allowlist abstains on IS released when the model is sure", async () => {
    const { deps, calls } = recorder({ judge: async () => "yes" });
    const res = await runCollectorFeeReply("yeah go on then, fire them out", deps);
    expect(calls.released).toEqual([{ matchId: "m1", amount: AMOUNT }]);
    expect(res?.released).toBe(8);
  });

  it("a natural refusal is a cancel", async () => {
    const { deps, calls } = recorder({ judge: async () => "no" });
    await runCollectorFeeReply("hold off until I've counted the cash", deps);
    expect(calls.cancelled).toEqual(["m1"]);
    expect(calls.released).toEqual([]);
  });

  it("`neither` does nothing and falls through", async () => {
    const { deps, calls } = recorder({ judge: async () => "neither" });
    const res = await runCollectorFeeReply("did Wasim turn up in the end?", deps);
    expect(calls.released).toEqual([]);
    expect(calls.cancelled).toEqual([]);
    expect(res).toBeNull();
  });

  // ⚠️ THE FAILURE DIRECTION, PROVEN.
  it("a THROWN classifier releases nothing, cancels nothing and leaves the fee pending", async () => {
    const { deps, calls } = recorder({
      judge: async () => {
        throw new Error("overloaded");
      },
    });
    const res = await runCollectorFeeReply("cheers mate, go for it", deps);
    expect(calls.released).toEqual([]);
    expect(calls.cancelled).toEqual([]);
    expect(calls.staged).toEqual([]);
    expect(res).toBeNull();
  });
});

describe("runCollectorFeeReply — a fresh amount is decided by code, before the model", () => {
  it("a new amount supersedes the pending one and never reaches the model", async () => {
    const { deps, calls } = recorder();
    const res = await runCollectorFeeReply("£12 each", deps);
    expect(calls.staged).toEqual([{ matchId: "m1", perPlayer: 12 }]);
    expect(calls.released).toEqual([]);
    expect(calls.judged).toEqual([]);
    expect(res?.reply).toContain("£12");
  });

  // The old order asked `isAffirmative` first, so this released at the
  // SUPERSEDED price — 13 people charged the wrong amount off one emoji.
  it('"✅ actually make it £12" re-stages rather than releasing the old price', async () => {
    const { deps, calls } = recorder();
    await runCollectorFeeReply("✅ actually make it £12", deps);
    expect(calls.released).toEqual([]);
    expect(calls.staged).toEqual([{ matchId: "m1", perPlayer: 12 }]);
  });
});

describe("runCollectorFeeReply — the gates that were already there stay there", () => {
  it("no pending match → nothing happens and the model is never asked", async () => {
    const { deps, calls } = recorder({ pendingMatch: async () => null });
    expect(await runCollectorFeeReply("✅", deps)).toBeNull();
    expect(calls.released).toEqual([]);
    expect(calls.judged).toEqual([]);
  });

  it("a match with NO pending amount never releases, whatever the reply says", async () => {
    const { deps, calls } = recorder({
      pendingMatch: async () => ({ id: "m1", name: "Tuesday 5-a-side", feePendingConfirm: null }),
      judge: async () => "yes" as FeeReply,
    });
    const res = await runCollectorFeeReply("✅ yes send them", deps);
    expect(calls.released).toEqual([]);
    expect(calls.judged).toEqual([]);
    expect(res).toBeNull();
  });

  it("an amount on a fee-less match stages it for confirmation, and sends nothing", async () => {
    const { deps, calls } = recorder({
      pendingMatch: async () => ({ id: "m1", name: "Tuesday 5-a-side", feePendingConfirm: null }),
    });
    const res = await runCollectorFeeReply("£10.30 each", deps);
    expect(calls.staged).toEqual([{ matchId: "m1", perPlayer: 10.3 }]);
    expect(calls.released).toEqual([]);
    expect(res?.reply).toContain("£10.30");
  });
});
