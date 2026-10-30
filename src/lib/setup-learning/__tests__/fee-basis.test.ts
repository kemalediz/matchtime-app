/**
 * THE FEE BASIS READ (2026-10-30, the last no-string-parsing sweep). The
 * setup reading's prompt stays byte-identical to what it was; whether the
 * price it found is each player's or the whole pitch's is ONE short model
 * call of its own, made only when there is a pounds price with a quote that
 * holds the number. No model here: the model is a stub.
 */
import { describe, expect, it } from "vitest";
import type { ModelRequest, PipelineModel } from "../../pipeline/llm";
import { FEE_BASIS_SCHEMA, FEE_BASIS_SYSTEM_PROMPT, feeBasisCandidate, withFeeBasis } from "../fee-basis";

function model(answer: unknown, opts: { fail?: boolean } = {}) {
  const reqs: ModelRequest[] = [];
  const m: PipelineModel & { reqs: ModelRequest[] } = {
    name: "stub",
    reqs,
    async complete(req) {
      reqs.push(req);
      if (opts.fail) throw new Error("529 overloaded");
      return {
        text: typeof answer === "string" ? answer : JSON.stringify(answer),
        stopReason: "end_turn",
        usage: { inputTokens: 300, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.0001,
        ms: 1,
      };
    },
  };
  return m;
}

const fee = (amount: number, evidence: string[], currency = "pounds") => ({ match_fee: { amount, currency, confidence: "high", evidence } });

describe("feeBasisCandidate: only a pounds price with a quote that holds the number is asked about", () => {
  it("the quotes that hold the amount, nothing else", () => {
    expect(feeBasisCandidate(fee(6, ["£6 each please", "see you at 7"]))).toEqual({ amount: 6, quotes: ["£6 each please"] });
  });
  it("no price, another currency, a silly amount, or no quote with the number: no call", () => {
    for (const raw of [fee(0, []), fee(150, ["Kişi başı 150 TL"], "other"), fee(200, ["£200"]), fee(6, ["six quid each"]), {}, null]) {
      expect(feeBasisCandidate(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});

describe("withFeeBasis: the model says whose price it is; the reading gets it as match_fee.basis", () => {
  it("per player", async () => {
    const m = model({ basis: "per_player", reasoning: "each" });
    const out = await withFeeBasis(fee(6, ["£6 each please"]), m);
    expect((out.raw as { match_fee: { basis: string } }).match_fee.basis).toBe("per_player");
    expect(out.calls).toBe(1);
    expect(out.costUsd).toBe(0.0001);
    expect(m.reqs[0].user).toContain("£6 each please");
    expect(m.reqs[0].user).toContain("Amount: 6");
    expect(m.reqs[0].schema).toEqual(FEE_BASIS_SCHEMA);
    expect(m.reqs[0].label).toBe("setup-fee-basis");
  });
  it("the whole pitch, in English or Turkish", async () => {
    const out = await withFeeBasis(fee(45, ["Saha toplam £45"]), model({ basis: "whole_pitch", reasoning: "pitch" }));
    expect((out.raw as { match_fee: { basis: string } }).match_fee.basis).toBe("whole_pitch");
  });
  it("no candidate: no call, and the basis is none", async () => {
    const m = model({ basis: "per_player" });
    const out = await withFeeBasis(fee(0, []), m);
    expect(m.reqs).toEqual([]);
    expect(out.calls).toBe(0);
    expect((out.raw as { match_fee: { basis: string } }).match_fee.basis).toBe("none");
  });
  it("FAILS CLOSED: a thrown call, garbage or a basis outside the list is unclear, and so no fee", async () => {
    for (const m of [model({}, { fail: true }), model("not json"), model({ basis: "per_head_maybe" })]) {
      const out = await withFeeBasis(fee(6, ["£6 each"]), m);
      expect((out.raw as { match_fee: { basis: string } }).match_fee.basis).toBe("unclear");
    }
  });
  it("a test stub that answers every call with the whole reading: its match_fee.basis is the answer", async () => {
    const reading = { ...fee(6, ["£6 each"]), squad: {} } as { match_fee: Record<string, unknown> };
    reading.match_fee.basis = "per_player";
    const out = await withFeeBasis(fee(6, ["£6 each"]), model(reading));
    expect((out.raw as { match_fee: { basis: string } }).match_fee.basis).toBe("per_player");
  });
  it("leaves the rest of the reading alone", async () => {
    const raw = { ...fee(6, ["£6 each"]), squad: { answer: "rolling" } };
    const out = await withFeeBasis(raw, model({ basis: "per_player" }));
    expect((out.raw as { squad: unknown }).squad).toEqual({ answer: "rolling" });
  });
});

describe("the prompt", () => {
  it("is short, defines each answer once, English beside Turkish, no dashes", () => {
    for (const b of ["per_player", "whole_pitch", "unclear"]) expect(FEE_BASIS_SYSTEM_PROMPT.split(`- "${b}"`).length, b).toBe(2);
    expect(FEE_BASIS_SYSTEM_PROMPT).toContain("kişi başı");
    expect(FEE_BASIS_SYSTEM_PROMPT).not.toMatch(/[—–]/);
    expect(FEE_BASIS_SYSTEM_PROMPT.length).toBeLessThan(1500);
    expect(FEE_BASIS_SCHEMA.properties.basis.enum).toEqual(["per_player", "whole_pitch", "unclear"]);
  });
});
