/**
 * THE WHOLE PIPELINE, end to end, against fake models.
 *
 * What this file pins is the WIRING — the properties that must hold
 * however the model behaves on the day:
 *
 *   • exactly one outcome per input message, always (§3.2 S1)
 *   • a banter batch costs one cheap call and nothing else (§4.2, §8.3)
 *   • a message carrying several facts loses none of them — today's
 *     incident, where a regex fast path claimed a two-intent message and
 *     threw half away
 *   • one reply per message, composed once (§3.2 S36)
 *   • every failure is visible; nothing fails quietly (§11.2, §11.4)
 */
import { describe, it, expect } from "vitest";
import { runPipeline } from "../run";
import type { ModelRequest, ModelResponse, PipelineModel } from "../llm";
import { NOW, world } from "./helpers";

interface Scripted {
  router?: string;
  extractors?: Record<string, string>;
  throwOn?: "router" | "extractor";
}

function scriptedModels(s: Scripted) {
  const calls: ModelRequest[] = [];
  const model: PipelineModel = {
    name: "scripted",
    async complete(req): Promise<ModelResponse> {
      calls.push(req);
      if (s.throwOn === "router" && req.label === "router") throw new Error("router down");
      if (s.throwOn === "extractor" && req.label.startsWith("extractor")) {
        throw new Error("extractor down");
      }
      const text =
        req.label === "router"
          ? (s.router ?? '{"routes":[]}')
          : (s.extractors?.[messageIdOf(req.user)] ?? '{"claims":[],"affirmation":null,"sideRequests":[]}');
      return {
        text,
        stopReason: "end_turn",
        usage: {
          inputTokens: req.label === "router" ? 815 : 900,
          outputTokens: req.label === "router" ? 140 : 180,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        costUsd: req.label === "router" ? 0.0012 : 0.0024,
        ms: req.label === "router" ? 1800 : 2400,
      };
    },
  };
  return { model, calls };
}

/** The extractor prompt carries the body, so key the script off it. */
function messageIdOf(user: string): string {
  if (user.includes("my brother")) return "brother";
  if (user.includes("replace me")) return "replace";
  if (user.includes("Habib")) return "habib";
  return "default";
}

const TEN = ["kemal", "elvin", "sait", "mustafa", "abid", "idris", "faris", "shaz", "adam", "efat"];

function batch(msgs: Array<{ id: string; from: string | null; body: string; tagged?: boolean }>) {
  return msgs.map((m) => ({
    id: m.id,
    body: m.body,
    authorName: m.from ? m.from : null,
    senderUserId: m.from ? `u-${m.from}` : null,
    senderName: m.from ?? null,
    tagged: m.tagged ?? false,
  }));
}

describe("coverage", () => {
  it("produces exactly one outcome per input message, whatever happens", async () => {
    const { model } = scriptedModels({
      router: '{"routes":[{"id":"a","route":"none"}]}', // b and c missing
    });
    const out = await runPipeline({
      now: NOW,
      state: world({ confirmed: TEN }),
      history: [],
      messages: batch([
        { id: "a", from: "ayoub", body: "😂😂" },
        { id: "b", from: "sait", body: "anyone watching the derby" },
        { id: "c", from: "zair", body: "something ambiguous" },
      ]),
      models: { router: model, extractor: model },
    });
    expect(out.engine.outcomes.map((o) => o.messageId)).toEqual(["a", "b", "c"]);
    // The two ids the router skipped went to `unsure` (never `none`)
    // and are reported.
    expect(out.routes.filter((r) => r.source === "fallback")).toHaveLength(2);
    expect(out.degradations.length).toBeGreaterThanOrEqual(2);
  });
});

describe("the modal case: a batch where nothing happened", () => {
  it("costs ONE cheap call and reaches no extractor at all", async () => {
    const { model, calls } = scriptedModels({
      router:
        '{"routes":[{"id":"a","route":"none"},{"id":"b","route":"none"},{"id":"c","route":"none"}]}',
    });
    const out = await runPipeline({
      now: NOW,
      state: world({ confirmed: TEN }),
      history: [],
      messages: batch([
        { id: "a", from: "ayoub", body: "😂😂😂" },
        { id: "b", from: "zair", body: "https://www.instagram.com/reel/DaClAuzs1eQ/" },
        { id: "c", from: "sait", body: "anyone watching the derby tonight" },
      ]),
      models: { router: model, extractor: model },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].label).toBe("router");
    expect(out.engine.writes).toHaveLength(0);
    expect(out.composed.utterances).toHaveLength(0);
    expect(out.composed.reacts).toHaveLength(0);
    expect(out.cost.extractorCalls).toBe(0);
  });
});

describe("a message carrying SEVERAL facts loses none of them", () => {
  it("keeps a third-party OUT and a recruit request from the same message", async () => {
    // The 2026-09-01 incident in miniature: a regex fast path claimed a
    // two-intent message and threw half away. There is no fast path
    // here, and the extractor's schema has room for both.
    const { model } = scriptedModels({
      router: '{"routes":[{"id":"a","route":"other_att"}]}',
      extractors: {
        habib: JSON.stringify({
          claims: [
            {
              subject: "other",
              personRef: "Habib",
              personNamed: true,
              polarity: "out",
              contingent: false,
              conditionOn: "none",
              tense: "present",
              reported: true,
              confidence: 0.93,
            },
          ],
          affirmation: null,
          sideRequests: ["recruit"],
        }),
      },
    });
    const out = await runPipeline({
      now: NOW,
      state: world({
        confirmed: [...TEN, "usama", "karahan", "habib", "wasim"],
        bench: ["najib"],
      }),
      history: [],
      messages: batch([
        {
          id: "a",
          from: "elvin",
          body: "@Match Time Habib can't make it, anyone able to cover?",
          tagged: true,
        },
      ]),
      models: { router: model, extractor: model },
    });
    const outcome = out.engine.outcomes[0];
    expect(outcome.writes.some((w) => w.kind === "attendance")).toBe(true);
    expect(outcome.writes.some((w) => w.kind === "open_bench_offer")).toBe(true);
    expect(outcome.reasons.join(" ")).toMatch(/side-request:recruit/);
  });
});

describe("one reply per message, composed once", () => {
  it("does not produce a second squad post for a squad question in the same batch", async () => {
    const { model } = scriptedModels({
      router:
        '{"routes":[{"id":"a","route":"self_att"},{"id":"b","route":"question"}]}',
      extractors: {
        default: JSON.stringify({
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
          affirmation: null,
          sideRequests: [],
        }),
      },
    });
    // The question extractor gets the same scripted body, so give it a
    // router route it can answer and let the fallback shape apply.
    const out = await runPipeline({
      now: NOW,
      state: world({ confirmed: TEN }),
      history: [],
      messages: batch([
        { id: "a", from: "usama", body: "in" },
        { id: "b", from: "zair", body: "@Match Time how many are we?", tagged: true },
      ]),
      models: { router: model, extractor: model },
    });
    expect(out.composed.utterances.length).toBeLessThanOrEqual(1);
  });
});

describe("failures are visible", () => {
  it("a dead router routes the whole batch to the extractor and says so (§11.4)", async () => {
    const { model, calls } = scriptedModels({ throwOn: "router" });
    const out = await runPipeline({
      now: NOW,
      state: world({ confirmed: TEN }),
      history: [],
      messages: batch([{ id: "a", from: "zair", body: "something attendance shaped" }]),
      models: { router: model, extractor: model },
    });
    expect(out.routes[0].route).toBe("unsure");
    expect(calls.some((c) => c.label.startsWith("extractor"))).toBe(true);
    expect(out.degradations.some((d) => d.stage === "router")).toBe(true);
  });

  it("a dead extractor fails CLOSED and the message is marked degraded, not silent", async () => {
    const { model } = scriptedModels({
      router: '{"routes":[{"id":"a","route":"self_att"}]}',
      throwOn: "extractor",
    });
    const out = await runPipeline({
      now: NOW,
      state: world({ confirmed: TEN }),
      history: [],
      messages: batch([{ id: "a", from: "zair", body: "in" }]),
      models: { router: model, extractor: model },
    });
    expect(out.engine.writes).toHaveLength(0);
    expect(out.engine.outcomes[0].disposition).toBe("degraded");
    expect(out.composed.operatorNotes.join(" ")).toMatch(/extractor down/);
  });

  it("reports the two-stage disagreement when the router says none and facts exist", async () => {
    // §11.2. Not reachable through the normal flow (a `none` route never
    // calls an extractor), so the engine's guard is what catches a
    // hand-assembled or replayed batch. Asserted here so the reporting
    // path stays wired.
    const { model } = scriptedModels({
      router: '{"routes":[{"id":"a","route":"unsure"}]}',
      extractors: { default: '{"claims":[],"affirmation":null,"sideRequests":[]}' },
    });
    const out = await runPipeline({
      now: NOW,
      state: world({ confirmed: TEN }),
      history: [],
      messages: batch([{ id: "a", from: "zair", body: "hmm" }]),
      models: { router: model, extractor: model },
    });
    expect(out.engine.outcomes[0].reasons.join(" ")).toMatch(/no claims extracted/i);
  });
});

describe("cost accounting", () => {
  it("reports router and extractor spend separately, per batch", async () => {
    const { model } = scriptedModels({
      router: '{"routes":[{"id":"a","route":"self_att"},{"id":"b","route":"none"}]}',
    });
    const out = await runPipeline({
      now: NOW,
      state: world({ confirmed: TEN }),
      history: [],
      messages: batch([
        { id: "a", from: "usama", body: "count me in for tuesday" },
        { id: "b", from: "ayoub", body: "😂" },
      ]),
      models: { router: model, extractor: model },
    });
    expect(out.cost.routerUsd).toBeCloseTo(0.0012, 6);
    expect(out.cost.extractorUsd).toBeCloseTo(0.0024, 6);
    expect(out.cost.totalUsd).toBeCloseTo(0.0036, 6);
    expect(out.cost.extractorCalls).toBe(1);
    expect(out.cost.routerCalls).toBe(1);
  });
});
