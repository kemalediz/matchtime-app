/**
 * THE ROUTER, TOLD WHAT MATCHTIME IS STILL WAITING FOR.
 *
 * The mechanism, in one sentence: **while MatchTime has an open,
 * unanswered question on the board, a `none` route is not trusted.**
 *
 * It is the same SHAPE as the deterministic floor and inherits its
 * proof — it can only ever move a message OUT of `none`, so it can add
 * an analyzer call and can never suppress one — but it is gated on a
 * DATABASE ROW rather than on the text of the message. That is the whole
 * difference between this and the `👍` regex the brief rules out: the
 * floor fires on what a message LOOKS like, and would therefore fire on
 * every thumbs-up in the group; this fires on what MatchTime ASKED, and
 * is silent for 99% of the history because MatchTime was not asking
 * anything.
 *
 * Measured over the same 1,723 production messages: **18 open-question
 * windows in 4.5 months**, and 69 messages inside one.
 */
import { describe, it, expect } from "vitest";
import { routeBatch, type RouterMessage } from "../router";
import { gateBatch } from "../gate";
import type { AwaitingQuestion } from "../awaiting-answer";
import type { PipelineModel, ModelResponse } from "../llm";
import type { Route } from "../types";

function modelSaying(route: Route): PipelineModel {
  return {
    name: "fake",
    async complete(req): Promise<ModelResponse> {
      const ids = [...req.user.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]);
      return {
        text: JSON.stringify({ routes: ids.map((id) => ({ id, route })) }),
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.0001,
        ms: 5,
      };
    },
  };
}

const OPEN: AwaitingQuestion = {
  id: "cmqfqlda5000004jpzqopngpk",
  orgId: "cmnnwhdx30000zfr85q18lyy9",
  kind: "bench-slot-offer",
  askedAt: new Date("2026-06-15T20:40:10.493Z"),
  closesAt: new Date("2026-06-16T19:30:00.000Z"),
};

const THUMB: RouterMessage[] = [{ id: "m1", authorName: "Aydın Kocahal", body: "👍" }];

describe("a bare 👍 answering a question MatchTime is still waiting on", () => {
  it("reaches the analyzer even though the router said `none`", async () => {
    const res = await routeBatch(modelSaying("none"), THUMB, { floor: false, awaiting: OPEN });
    expect(res.routes[0].route).not.toBe("none");
    expect(res.routes[0].source).toBe("awaiting");
    expect(res.routes[0].overrodeRoute).toBe("none");
  });

  it("says why, so a route can be explained after the fact", async () => {
    const res = await routeBatch(modelSaying("none"), THUMB, { floor: false, awaiting: OPEN });
    expect(res.degradations.map((d) => d.detail).join(" ")).toContain("bench-slot-offer");
  });

  it("routes it `unsure`, which is where §11.4 sends anything attendance-shaped it cannot read", async () => {
    const res = await routeBatch(modelSaying("none"), THUMB, { floor: false, awaiting: OPEN });
    expect(res.routes[0].route).toBe("unsure");
  });
});

describe("the negative direction — larger by far, and it must not move", () => {
  it("a bare 👍 with NO open question stays `none`", async () => {
    const res = await routeBatch(modelSaying("none"), THUMB, { floor: false });
    expect(res.routes[0].route).toBe("none");
    expect(res.routes[0].source).toBe("model");
  });

  it("a bare 👍 with `awaiting: null` stays `none`", async () => {
    const res = await routeBatch(modelSaying("none"), THUMB, { floor: false, awaiting: null });
    expect(res.routes[0].route).toBe("none");
  });

  it("banter alongside an open question is the price, and it is only ever an extra call", async () => {
    // Being honest about the cost rather than hiding it: while a slot is
    // open, the group's chatter reaches the analyzer too. That is 69
    // messages in 4.5 months and it cannot lose a write — the worst case
    // is one $0.03 call on a batch that did not need it.
    const banter: RouterMessage[] = [{ id: "m1", authorName: "Zair", body: "😂😂" }];
    const res = await routeBatch(modelSaying("none"), banter, { floor: false, awaiting: OPEN });
    expect(res.routes[0].route).toBe("unsure");
  });
});

describe("it can only ever ADD analysis — the same proof the floor has", () => {
  const ROUTES: Route[] = [
    "none",
    "self_att",
    "other_att",
    "offer",
    "question",
    "balancer",
    "score",
    "admin_ops",
    "unsure",
  ];

  it("never produces `none` where the model did not", async () => {
    for (const r of ROUTES) {
      const res = await routeBatch(modelSaying(r), THUMB, { floor: false, awaiting: OPEN });
      if (r === "none") expect(res.routes[0].route).not.toBe("none");
      else expect(res.routes[0].route).toBe(r);
    }
  });

  it("leaves every non-`none` route exactly as the model gave it", async () => {
    for (const r of ROUTES.filter((x) => x !== "none")) {
      const res = await routeBatch(modelSaying(r), THUMB, { floor: false, awaiting: OPEN });
      expect(res.routes[0].source).toBe("model");
      expect(res.routes[0].overrodeRoute).toBeUndefined();
    }
  });

  it("analysed(awaiting on) ⊇ analysed(awaiting off), over a mixed batch", async () => {
    const msgs: RouterMessage[] = [
      { id: "a", authorName: "Aydın Kocahal", body: "👍" },
      { id: "b", authorName: "Zair", body: "😂" },
      { id: "c", authorName: "Mo", body: "In" },
    ];
    const off = await routeBatch(modelSaying("none"), msgs, { floor: false });
    const on = await routeBatch(modelSaying("none"), msgs, { floor: false, awaiting: OPEN });
    const analysed = (rs: typeof off.routes) =>
      new Set(rs.filter((r) => r.route !== "none").map((r) => r.messageId));
    for (const id of analysed(off.routes)) expect(analysed(on.routes).has(id)).toBe(true);
  });

  it("does not fire when the model call failed — the batch is already going to the analyzer", async () => {
    const throwing: PipelineModel = {
      name: "boom",
      async complete(): Promise<ModelResponse> {
        throw new Error("nope");
      },
    };
    const res = await routeBatch(throwing, THUMB, { floor: false, awaiting: OPEN });
    expect(res.routes[0].route).toBe("unsure");
    expect(res.routes[0].source).toBe("fallback");
  });
});

describe("it composes with the floor rather than fighting it", () => {
  it("a floor-claimed message keeps the floor's route", async () => {
    const bare: RouterMessage[] = [{ id: "m1", authorName: "Mo", body: "In" }];
    const res = await routeBatch(modelSaying("none"), bare, { floor: true, awaiting: OPEN });
    expect(res.routes[0].route).toBe("self_att");
    expect(res.routes[0].source).toBe("floor");
  });

  it("the router is not asked at all when every message hits the floor, open question or not", async () => {
    let calls = 0;
    const counting: PipelineModel = {
      name: "counting",
      async complete(): Promise<ModelResponse> {
        calls += 1;
        return {
          text: JSON.stringify({ routes: [] }),
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0,
          ms: 0,
        };
      },
    };
    const bare: RouterMessage[] = [{ id: "m1", authorName: "Mo", body: "In" }];
    await routeBatch(counting, bare, { floor: true, awaiting: OPEN });
    expect(calls).toBe(0);
  });
});

// ── The GATE, which is what actually decides what the analyzer sees ────

describe("the gate, with a question of MatchTime's still on the board", () => {
  const gateMsgs = [
    { waMessageId: "m1", body: "👍", authorName: "Aydın Kocahal" },
    { waMessageId: "m2", body: "😂", authorName: "Zair" },
  ];

  it("analyses a 👍 the router called banter, and records why", async () => {
    const out = await gateBatch(gateMsgs, {
      model: modelSaying("none"),
      floor: false,
      awaiting: OPEN,
    });
    expect(out.skipped).toEqual([]);
    expect(out.analysed).toEqual(["m1", "m2"]);
    expect(out.awaitingForced).toEqual(["m1", "m2"]);
  });

  it("skips exactly as before when MatchTime is waiting for nothing", async () => {
    const out = await gateBatch(gateMsgs, { model: modelSaying("none"), floor: false });
    expect(out.skipped).toEqual(["m1", "m2"]);
    expect(out.analysed).toEqual([]);
    expect(out.awaitingForced).toEqual([]);
  });

  it("skipped(question open) is a subset of skipped(no question) — it can only ADD analysis", async () => {
    const closed = await gateBatch(gateMsgs, { model: modelSaying("none"), floor: false });
    const open = await gateBatch(gateMsgs, {
      model: modelSaying("none"),
      floor: false,
      awaiting: OPEN,
    });
    for (const id of open.skipped) expect(closed.skipped).toContain(id);
    for (const id of closed.analysed) expect(open.analysed).toContain(id);
  });

  it("hands the analyzer the same ids in the same order, with nothing invented", async () => {
    const out = await gateBatch(gateMsgs, {
      model: modelSaying("other_att"),
      floor: false,
      awaiting: OPEN,
    });
    expect(out.analysed).toEqual(gateMsgs.map((m) => m.waMessageId));
    expect(out.awaitingForced).toEqual([]);
  });
});
