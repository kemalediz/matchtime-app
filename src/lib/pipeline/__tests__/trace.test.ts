/**
 * WHAT THE MODEL SAID ABOUT A MESSAGE, KEPT ON ITS ROW.
 *
 * 2026-09-24: the attendance extractor returned `polarity: "bench"` for
 * Erdal's plain "in", the engine benched him, and nobody could prove why
 * because the extractor's output was stored nowhere. `AnalyzedMessage`
 * held what the ENGINE decided, never what the MODEL returned.
 *
 * These pin the three things `pipeline/trace.ts` promises:
 *   1. the router's route and every extractor's facts reach the trace,
 *      per message, with the model that produced them;
 *   2. the trace is BOUNDED (a pasted roster cannot bloat a row) and
 *      carries no phone numbers;
 *   3. tracing can NEVER change or break analysis: the traced extractor
 *      returns exactly what the untraced one does, and a failure to
 *      record or save is logged and swallowed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractForRoute } from "../extractors";
import { EXTRACTOR_MODEL, ROUTER_MODEL, type ModelResponse, type PipelineModel } from "../llm";
import {
  buildPipelineTrace,
  extractForRouteTraced,
  persistPipelineTraces,
  TRACE_LIMITS,
  traceRouting,
  withPipelineTrace,
  type PipelineTrace,
} from "../trace";

const USAGE = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

function modelReturning(text: string | (() => string), extra: Partial<ModelResponse> = {}): PipelineModel {
  return {
    name: "fake",
    async complete() {
      return {
        text: typeof text === "function" ? text() : text,
        stopReason: "end_turn",
        usage: USAGE,
        costUsd: 0.001,
        ms: 7,
        ...extra,
      };
    },
  };
}

const BENCH_FOR_PLAIN_IN = JSON.stringify({
  claims: [
    {
      subject: "sender",
      personRef: "",
      personNamed: false,
      polarity: "bench",
      contingent: false,
      conditionOn: "none",
      tense: "present",
      basis: "decision",
      reported: false,
      replaces: "",
      confidence: 0.62,
    },
  ],
  affirmation: "none",
  sideRequests: [],
});

function msg(id: string, body = "in") {
  return { id, body, authorName: "Erdal", tagged: false, history: [], lastBotPost: null };
}

/** Run `fn` inside a trace context and return what would be saved. */
async function capture(fn: () => Promise<void>): Promise<Map<string, PipelineTrace>> {
  const saved = new Map<string, PipelineTrace>();
  await withPipelineTrace(async () => {
    await fn();
    await persistPipelineTraces(async (id, trace) => {
      saved.set(id, trace);
    });
  });
  return saved;
}

afterEach(() => vi.restoreAllMocks());

describe("what is recorded", () => {
  it("keeps the router's route and the extractor's claims, with the models", async () => {
    const saved = await capture(async () => {
      traceRouting({
        routes: [{ messageId: "wa-1", route: "self_att", source: "model" }],
        degradations: [],
        modelCalled: true,
        floorEnabled: false,
      });
      await extractForRouteTraced("attendance", modelReturning(BENCH_FOR_PLAIN_IN), "self_att", msg("wa-1"));
    });

    const t = saved.get("wa-1")!;
    expect(t.v).toBe(1);
    expect(t.router).toMatchObject({ route: "self_att", source: "model", model: ROUTER_MODEL, floor: false });
    expect(t.extractions).toHaveLength(1);
    const x = t.extractions[0];
    expect(x).toMatchObject({ owner: "attendance", route: "self_att", extractor: "attendance", model: EXTRACTOR_MODEL });
    expect(x.facts).toMatchObject({
      kind: "attendance",
      claims: [{ polarity: "bench", subject: "sender", contingent: false, confidence: 0.62 }],
      affirmation: null,
    });
    expect(x.calls).toEqual([{ ms: 7, stopReason: "end_turn", inputTokens: 10, outputTokens: 5 }]);
    // A clean parse: the facts ARE the output, so the raw text is not kept.
    expect(x.calls[0]).not.toHaveProperty("raw");
  });

  it("says no model was asked when the floor routed the message", async () => {
    const saved = await capture(async () => {
      traceRouting({
        routes: [{ messageId: "wa-1", route: "self_att", source: "floor" }],
        degradations: [],
        modelCalled: false,
        floorEnabled: true,
      });
    });
    expect(saved.get("wa-1")!.router).toMatchObject({ source: "floor", model: null });
    expect(saved.get("wa-1")!.extractions).toEqual([]);
  });

  it("keeps the router's degradations for this message and for the whole batch, not a neighbour's", async () => {
    const saved = await capture(async () => {
      traceRouting({
        routes: [
          { messageId: "wa-1", route: "self_att", source: "floor", overrodeRoute: "none" },
          { messageId: "wa-2", route: "none", source: "model" },
        ],
        degradations: [
          { stage: "router", messageId: "wa-1", detail: "the floor overrode the router: none → self_att" },
          { stage: "router", messageId: "wa-2", detail: "about wa-2 only" },
          { stage: "router", messageId: null, detail: "batch-wide note" },
        ],
        modelCalled: true,
        floorEnabled: true,
      });
    });
    const r = saved.get("wa-1")!.router!;
    expect(r.overrodeRoute).toBe("none");
    expect(r.degradations).toEqual(["the floor overrode the router: none → self_att", "batch-wide note"]);
  });

  it("keeps the raw model text, and the error, when the output did not parse cleanly", async () => {
    const saved = await capture(async () => {
      await extractForRouteTraced("attendance", modelReturning("not json at all"), "self_att", msg("wa-1"));
    });
    const x = saved.get("wa-1")!.extractions[0];
    expect(x.facts).toEqual({ kind: "none" });
    expect(x.degradations[0]).toMatch(/could not be parsed/);
    expect(x.calls[0].raw).toBe("not json at all");
  });

  it("records a call that threw, once per attempt", async () => {
    const model: PipelineModel = {
      name: "fake",
      async complete() {
        throw new Error("overloaded_error 529");
      },
    };
    const saved = await capture(async () => {
      await extractForRouteTraced("attendance", model, "self_att", msg("wa-1"));
    });
    const x = saved.get("wa-1")!.extractions[0];
    // self_att retries once, so two attempts.
    expect(x.calls).toHaveLength(2);
    expect(x.calls[0].error).toMatch(/overloaded_error 529/);
    expect(x.degradations[0]).toMatch(/failed TWICE/);
  });

  it("keeps every owner's extraction of the same message", async () => {
    const saved = await capture(async () => {
      await extractForRouteTraced("attendance", modelReturning(BENCH_FOR_PLAIN_IN), "self_att", msg("wa-1"));
      await extractForRouteTraced(
        "answer",
        modelReturning('{"topic":"count","personRef":"","table":"other","period":"","since":"","lastMatches":0}'),
        "question",
        msg("wa-1"),
      );
    });
    expect(saved.get("wa-1")!.extractions.map((x) => x.owner)).toEqual(["attendance", "answer"]);
  });

  it("snapshots the facts, so a caller mutating them afterwards does not rewrite history", async () => {
    let res: Awaited<ReturnType<typeof extractForRouteTraced>> | null = null;
    const saved = await capture(async () => {
      res = await extractForRouteTraced("attendance", modelReturning(BENCH_FOR_PLAIN_IN), "self_att", msg("wa-1"));
      (res!.facts as { claims: Array<{ polarity: string }> }).claims[0].polarity = "in";
    });
    expect((saved.get("wa-1")!.extractions[0].facts as { claims: Array<{ polarity: string }> }).claims[0].polarity).toBe(
      "bench",
    );
  });
});

describe("tracing never changes what analysis sees", () => {
  it("returns exactly what the untraced extractor returns", async () => {
    const plain = await extractForRoute(modelReturning(BENCH_FOR_PLAIN_IN), "self_att", msg("wa-1"));
    let traced: unknown;
    await withPipelineTrace(async () => {
      traced = await extractForRouteTraced("attendance", modelReturning(BENCH_FOR_PLAIN_IN), "self_att", msg("wa-1"));
    });
    expect(traced).toEqual(plain);
  });

  it("outside a trace context it records nothing and still extracts", async () => {
    const res = await extractForRouteTraced("attendance", modelReturning(BENCH_FOR_PLAIN_IN), "self_att", msg("wa-1"));
    expect(res.facts.kind).toBe("attendance");
    traceRouting({ routes: [{ messageId: "wa-1", route: "self_att", source: "model" }], degradations: [], modelCalled: true, floorEnabled: false });
    const write = vi.fn();
    expect(await persistPipelineTraces(write)).toBe(0);
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps two concurrent requests' traces apart", async () => {
    const a = capture(async () => {
      await new Promise((r) => setTimeout(r, 5));
      await extractForRouteTraced("attendance", modelReturning(BENCH_FOR_PLAIN_IN), "self_att", msg("wa-a"));
    });
    const b = capture(async () => {
      await extractForRouteTraced("attendance", modelReturning(BENCH_FOR_PLAIN_IN), "self_att", msg("wa-b"));
    });
    const [sa, sb] = await Promise.all([a, b]);
    expect([...sa.keys()]).toEqual(["wa-a"]);
    expect([...sb.keys()]).toEqual(["wa-b"]);
  });
});

describe("a failure to trace never breaks analysis", () => {
  it("a recording failure is swallowed and the extraction result still comes back", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // `extractForRoute` never reads `stopReason`; the trace does. A getter
    // that throws there fails the RECORDING and nothing else.
    const model: PipelineModel = {
      name: "fake",
      async complete() {
        const resp = { text: BENCH_FOR_PLAIN_IN, usage: USAGE, costUsd: 0, ms: 1 } as ModelResponse;
        Object.defineProperty(resp, "stopReason", {
          get() {
            throw new Error("boom in the trace");
          },
        });
        return resp;
      },
    };
    let res: Awaited<ReturnType<typeof extractForRouteTraced>> | null = null;
    await withPipelineTrace(async () => {
      res = await extractForRouteTraced("attendance", model, "self_att", msg("wa-1"));
    });
    expect(res!.facts.kind).toBe("attendance");
    expect(res!.degradations).toEqual([]);
    expect(err).toHaveBeenCalled();
  });

  it("a malformed routing record is swallowed", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await withPipelineTrace(async () => {
      expect(() => traceRouting(null as never)).not.toThrow();
    });
    expect(err).toHaveBeenCalled();
  });

  it("a save that rejects is logged, and the others still save", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const saved: string[] = [];
    let written = -1;
    await withPipelineTrace(async () => {
      traceRouting({
        routes: [
          { messageId: "wa-1", route: "none", source: "model" },
          { messageId: "wa-2", route: "none", source: "model" },
        ],
        degradations: [],
        modelCalled: true,
        floorEnabled: false,
      });
      written = await persistPipelineTraces(async (id) => {
        if (id === "wa-1") throw new Error('column "pipelineTrace" does not exist');
        saved.push(id);
      });
    });
    expect(saved).toEqual(["wa-2"]);
    expect(written).toBe(1);
    expect(err).toHaveBeenCalled();
  });
});

describe("the trace is bounded and carries no phone numbers", () => {
  it("truncates long strings and caps arrays", async () => {
    const claims = Array.from({ length: 40 }, (_, i) => ({
      subject: "other",
      personRef: `Player ${i} ` + "x".repeat(1_000),
      personNamed: true,
      polarity: "in",
      contingent: false,
      conditionOn: "none",
      tense: "present",
      basis: "decision",
      reported: false,
      replaces: "",
      confidence: 0.9,
    }));
    const saved = await capture(async () => {
      await extractForRouteTraced(
        "attendance",
        modelReturning(JSON.stringify({ claims, affirmation: "none", sideRequests: [] })),
        "other_att",
        msg("wa-1", "1. Player 0\n2. Player 1\n..."),
      );
    });
    const facts = saved.get("wa-1")!.extractions[0].facts as { claims: unknown[] };
    // The cap, plus one marker saying how many were left out.
    expect(facts.claims).toHaveLength(TRACE_LIMITS.array + 1);
    expect(facts.claims[TRACE_LIMITS.array]).toBe(`… ${40 - TRACE_LIMITS.array} more`);
    const first = facts.claims[0] as { personRef: string };
    expect(first.personRef.length).toBeLessThanOrEqual(TRACE_LIMITS.string);
    expect(first.personRef.endsWith("…")).toBe(true);
    expect(JSON.stringify(saved.get("wa-1")).length).toBeLessThanOrEqual(TRACE_LIMITS.total);
  });

  it("stays under the total budget however much is recorded", () => {
    const big = "y".repeat(5_000);
    const trace = buildPipelineTrace({
      router: { route: "unsure", source: "fallback", model: ROUTER_MODEL, floor: false, degradations: [big, big, big] },
      extractions: Array.from({ length: 10 }, () => ({
        owner: "attendance",
        route: "unsure",
        extractor: "attendance",
        model: EXTRACTOR_MODEL,
        client: "anthropic",
        facts: { kind: "attendance", claims: Array.from({ length: 10 }, () => ({ personRef: big })) },
        degradations: [big, big, big, big, big, big, big, big],
        calls: [{ ms: 1, raw: big }, { ms: 1, raw: big }],
      })),
    });
    expect(trace.extractions.length).toBeLessThanOrEqual(TRACE_LIMITS.extractions);
    expect(JSON.stringify(trace).length).toBeLessThanOrEqual(TRACE_LIMITS.total);
    expect(trace.truncated).toBe(true);
  });

  it("redacts anything shaped like a phone number", async () => {
    const out = JSON.stringify({
      claims: [
        {
          subject: "other",
          personRef: "07700 900123",
          personNamed: false,
          polarity: "in",
          contingent: false,
          conditionOn: "none",
          tense: "present",
          basis: "decision",
          reported: false,
          replaces: "+44 7700-900-456",
          confidence: 0.5,
        },
      ],
      affirmation: "none",
      sideRequests: [],
    });
    const saved = await capture(async () => {
      await extractForRouteTraced("attendance", modelReturning(out), "other_att", msg("wa-1", "add 07700 900123"));
      await extractForRouteTraced("attendance", modelReturning("oops 447700900789"), "other_att", msg("wa-1"));
    });
    const json = JSON.stringify(saved.get("wa-1"));
    expect(json).not.toMatch(/7700/);
    expect(json).toContain("[phone]");
  });
});
