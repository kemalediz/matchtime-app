/**
 * THE MIGRATION HARNESS — §10 step 2, "repoint the shadow".
 *
 * Two things must hold for this to be a safe place to run a new
 * pipeline over live traffic:
 *
 *   1. It cannot turn itself on. `SHADOW_ANALYZER_ENABLED` already
 *      guards the harness (PR #28, after three months of paying ~30% of
 *      the analyzer bill for a comparison nobody read); `SHADOW_PIPELINE`
 *      then decides WHICH analysis runs, and defaults to the old one so
 *      flipping one switch cannot silently change the other thing.
 *   2. It writes nothing but the `WindowVerdict` row the harness already
 *      wrote, in a shape `/admin/shadow` can already render.
 */
import { describe, it, expect, afterEach } from "vitest";
import { runDryRunShadow, shadowPipelineMode, toWindowShape } from "../shadow";
import { runPipeline } from "../run";
import type { ModelResponse, PipelineModel } from "../llm";
import { NOW, world } from "./helpers";

const ORIGINAL = process.env.SHADOW_PIPELINE;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.SHADOW_PIPELINE;
  else process.env.SHADOW_PIPELINE = ORIGINAL;
});

function model(router: string, extractor: string): PipelineModel {
  return {
    name: "fake",
    async complete(req): Promise<ModelResponse> {
      return {
        text: req.label === "router" ? router : extractor,
        stopReason: "end_turn",
        usage: { inputTokens: 800, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.001,
        ms: 1500,
      };
    },
  };
}

describe("shadowPipelineMode", () => {
  it("defaults to the OLD window analyzer, not the new pipeline", () => {
    delete process.env.SHADOW_PIPELINE;
    expect(shadowPipelineMode()).toBe("window");
  });

  it.each(["", "  ", "false", "0", "no", "off", "window", "yes", "1", "true"])(
    "%s does not select v2",
    (v) => {
      process.env.SHADOW_PIPELINE = v;
      expect(shadowPipelineMode()).toBe("window");
    },
  );

  it.each(["v2", "V2", " pipeline "])("%s selects v2", (v) => {
    process.env.SHADOW_PIPELINE = v;
    expect(shadowPipelineMode()).toBe("v2");
  });
});

describe("the persisted payload", () => {
  const state = world({
    confirmed: ["kemal", "elvin", "sait", "mustafa", "abid", "idris", "faris"],
  });

  it("keeps the four fields /admin/shadow already renders", async () => {
    const result = await runPipeline({
      now: NOW,
      state,
      history: [],
      messages: [
        {
          id: "wa-1",
          body: "in",
          authorName: "Zair Malik",
          senderUserId: "u-zair",
          tagged: false,
        },
      ],
      models: {
        router: model('{"routes":[{"id":"wa-1","route":"self_att"}]}', ""),
        extractor: model(
          "",
          JSON.stringify({
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
        ),
      },
    });

    const payload = toWindowShape(result);
    expect(payload.windowSummary).toBeTypeOf("string");
    expect(payload.stateChanges).toEqual([
      expect.objectContaining({ action: "add", targetName: "Zair Malik" }),
    ]);
    expect(payload.reactions[0]).toMatchObject({ waMessageId: "wa-1", emoji: "✅" });
    expect(payload.groupReply).toContain("8/14");
  });

  it("carries the detail the old shape cannot hold, for the step-3 diff", async () => {
    const result = await runPipeline({
      now: NOW,
      state,
      history: [],
      messages: [
        { id: "wa-1", body: "😂😂", authorName: "Ayoub", senderUserId: "u-ayoub", tagged: false },
      ],
      models: {
        router: model('{"routes":[{"id":"wa-1","route":"none"}]}', ""),
        extractor: model("", "{}"),
      },
    });
    const payload = toWindowShape(result);
    expect(payload.pipeline).toBe("dryrun-v2");
    expect(payload.proposal).toHaveProperty("routes");
    expect(payload.proposal).toHaveProperty("facts");
    expect(payload.proposal).toHaveProperty("writes");
    expect(payload.proposal).toHaveProperty("degradations");
    expect(payload.proposal).toHaveProperty("cost");
    // A banter window proposes nothing and says nothing.
    expect(payload.stateChanges).toHaveLength(0);
    expect(payload.groupReply).toBeNull();
  });
});

describe("runDryRunShadow", () => {
  it("resolves a sender the route already identified, and never invents one", async () => {
    const state = world({ confirmed: ["kemal", "elvin"] });
    const out = await runDryRunShadow({
      orgId: "org-1",
      now: NOW,
      loadState: async () => state,
      messages: [
        {
          waMessageId: "wa-1",
          body: "in",
          authorPhone: "+447700900001",
          authorName: "Zair Malik",
          authorUserId: "u-zair",
          timestamp: NOW,
        },
        {
          waMessageId: "wa-2",
          body: "in",
          authorPhone: "",
          authorName: "Somebody Unknown",
          authorUserId: null,
          timestamp: NOW,
        },
      ],
      history: [],
      models: {
        router: model(
          '{"routes":[{"id":"wa-1","route":"self_att"},{"id":"wa-2","route":"self_att"}]}',
          "",
        ),
        extractor: model(
          "",
          JSON.stringify({
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
        ),
      },
    });

    const changes = out.payload.stateChanges;
    expect(changes).toHaveLength(1);
    expect(changes[0].targetName).toBe("Zair Malik");
    // The unresolved sender produced no write AND a loud degradation —
    // "message understood, action silently not taken" is this product's
    // signature failure (§9, the unresolved-sender nudge).
    expect(out.result.degradations.some((d) => /sender could not be resolved/i.test(d.detail))).toBe(
      true,
    );
  });

  it("reports a per-batch cost", async () => {
    const state = world({ confirmed: ["kemal"] });
    const out = await runDryRunShadow({
      orgId: "org-1",
      now: NOW,
      loadState: async () => state,
      messages: [
        {
          waMessageId: "wa-1",
          body: "😂",
          authorPhone: "",
          authorName: "Ayoub Benali",
          authorUserId: null,
          timestamp: NOW,
        },
      ],
      history: [],
      models: {
        router: model('{"routes":[{"id":"wa-1","route":"none"}]}', ""),
        extractor: model("", "{}"),
      },
    });
    expect(out.costUsd).toBeCloseTo(0.001, 6);
    expect(out.result.cost.extractorCalls).toBe(0);
  });
});
