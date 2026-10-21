/**
 * THE SQUAD-LIST READING (2026-10-21): the request it sends and how the
 * answer is joined back onto the messages. No model is called: the
 * pipeline model is a stub that records the request.
 *
 * Moved from a raw Sonnet 5 call to `pipeline/llm.ts` on Haiku 5.5
 * (`SQUAD_LIST_CALL = HAIKU_CALL`), prompt rewritten. The model now sees
 * each message under a short id (m1, m2, ...) rather than its WhatsApp
 * id, which is long and costs output tokens on every list it echoes; the
 * code maps the short id back.
 */
import { describe, it, expect } from "vitest";
import { HAIKU_CALL, MIN_CACHEABLE_TOKENS, PIPELINE_CACHE_CONTROL, estimateTokens, type ModelRequest, type PipelineModel } from "../pipeline/llm";
import {
  readSquadLists,
  SQUAD_LIST_CALL,
  SQUAD_LIST_SYSTEM,
  squadListUserTurn,
  type SourceMessage,
} from "../squad-from-list";

function stub(body: unknown): { model: PipelineModel; reqs: ModelRequest[] } {
  const reqs: ModelRequest[] = [];
  return {
    reqs,
    model: {
      name: "stub",
      async complete(req) {
        reqs.push(req);
        return {
          text: typeof body === "string" ? body : JSON.stringify(body),
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0,
          ms: 1,
        };
      },
    },
  };
}

const MSGS: SourceMessage[] = [
  { waMessageId: "3EB0AAAAAAAAAAAAAAAA01", senderPhone: "447900000001", senderPushname: "Amir", timestamp: new Date("2026-05-18T10:00:00Z"), body: "Thursday 9pm:\n1. Ehtisham\n2. Amir" },
  { waMessageId: "3EB0AAAAAAAAAAAAAAAA02", senderPhone: "447900000002", senderPushname: "Dan", timestamp: new Date("2026-05-18T09:00:00Z"), body: "who's bringing bibs?" },
  { waMessageId: "3EB0AAAAAAAAAAAAAAAA03", senderPhone: "447900000003", senderPushname: "T", timestamp: new Date("2026-05-18T11:00:00Z"), body: "Thursday 9pm:\n1. Ehtisham\n2. Amir\n3. Tharan\n\nReserves:\n1. Martin" },
];

describe("the squad-list reading's request", () => {
  it("runs on Haiku 5.5 through the pipeline, cached, with a schema", async () => {
    const { model, reqs } = stub({ lists: [] });
    await readSquadLists(MSGS, { model });
    expect(SQUAD_LIST_CALL).toBe(HAIKU_CALL);
    expect(reqs).toHaveLength(1);
    const r = reqs[0];
    expect(r.model).toBe(HAIKU_CALL.model);
    expect(r.thinking).toEqual(HAIKU_CALL.thinking);
    expect(r.cache).toBeUndefined(); // the shared 1-hour marker
    expect(r.schema).toBeTruthy();
    expect(r.label).toBe("squad-from-list");
    expect(r.system).toBe(SQUAD_LIST_SYSTEM);
    expect(PIPELINE_CACHE_CONTROL.ttl).toBe("1h");
  });

  it("keeps the system prompt above Haiku 5.5's cache floor (a char/4 estimate, which under-counts)", () => {
    expect(estimateTokens(SQUAD_LIST_SYSTEM)).toBeGreaterThan(MIN_CACHEABLE_TOKENS[HAIKU_CALL.model]);
  });

  it("shows each message under a short id with its lines intact, never the WhatsApp id", () => {
    const turn = squadListUserTurn(MSGS);
    expect(turn).toContain("m1");
    expect(turn).toContain("1. Ehtisham\n2. Amir");
    expect(turn).not.toContain("3EB0");
    expect(SQUAD_LIST_SYSTEM).not.toMatch(/[–—]/);
    // English and Turkish examples side by side.
    expect(SQUAD_LIST_SYSTEM).toMatch(/Yedekler/);
  });
});

describe("joining the answer back onto the messages", () => {
  it("maps short ids back, sorts by time, and keeps sender details the model never saw", async () => {
    const { model } = stub({
      lists: [
        { id: "m3", names: ["Ehtisham", "Amir", "Tharan"], reserves: ["Martin"] },
        { id: "m1", names: ["Ehtisham", "Amir"], reserves: [] },
      ],
    });
    const out = await readSquadLists(MSGS, { model });
    expect(out.map((l) => l.waMessageId)).toEqual(["3EB0AAAAAAAAAAAAAAAA01", "3EB0AAAAAAAAAAAAAAAA03"]);
    expect(out[1]).toMatchObject({ senderPushname: "T", names: ["Ehtisham", "Amir", "Tharan"], reserves: ["Martin"] });
  });

  it("ignores an unknown id and a one-name list, and backstops a dropped Reserves block from the text", async () => {
    const { model } = stub({
      lists: [
        { id: "m9", names: ["A", "B"], reserves: [] },
        { id: "m2", names: ["Dan"], reserves: [] },
        { id: "m3", names: ["Ehtisham", "Amir", "Tharan"], reserves: [] },
      ],
    });
    const out = await readSquadLists(MSGS, { model });
    expect(out).toHaveLength(1);
    expect(out[0].reserves).toEqual(["Martin"]);
  });

  it("fails open to no lists on a failed call or an unreadable body", async () => {
    expect(await readSquadLists(MSGS, { model: stub("nope").model })).toEqual([]);
    const failing: PipelineModel = { name: "x", complete: async () => { throw new Error("529"); } };
    expect(await readSquadLists(MSGS, { model: failing })).toEqual([]);
  });

  it("makes no call with nothing to read", async () => {
    const { model, reqs } = stub({ lists: [] });
    expect(await readSquadLists([], { model })).toEqual([]);
    expect(reqs).toHaveLength(0);
  });
});
