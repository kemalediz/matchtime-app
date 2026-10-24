/**
 * THE OFFER REPLY READER (slice L6, 2026-10-24): the prompt, the user turn,
 * the JSON contract, and that every failure reads as "neither". The model
 * itself is the paid check (scripts/live-check-pool-reply.ts).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HAIKU_MODEL } from "../../models";
import { MIN_CACHEABLE_TOKENS, estimateTokens, type ModelRequest, type PipelineModel } from "../../pipeline/llm";
import {
  POOL_REPLY_CALL,
  POOL_REPLY_SCHEMA,
  POOL_REPLY_STUB_FILE_ENV,
  POOL_REPLY_SYSTEM_PROMPT,
  buildPoolReplyUserTurn,
  parsePoolReply,
  readPoolReply,
  type PoolReplyContext,
} from "../reply-reader";

const NOW = new Date("2026-10-27T12:00:00Z");
const CTX: PoolReplyContext = {
  now: NOW,
  ownClub: null,
  quotedIndex: null,
  offers: [
    {
      state: "open",
      sentAt: new Date("2026-10-27T11:00:00Z"),
      text: "⚽ *FNF* needs 1 player for a 7-a-side football game\n📅 *Friday 30 Oct, 20:30* (60 mins)\nWould you like the place? Reply here, or tap to answer: https://matchtime.ai/play/offer/abc.SECRETHMAC\n\nStop or change them: https://matchtime.ai/r/SHORTCODE",
    },
  ],
};

function fakeModel(text: string, seen: ModelRequest[] = []): PipelineModel {
  return {
    name: "fake",
    complete: async (req) => {
      seen.push(req);
      return { text, stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 0 };
    },
  };
}

describe("the prompt", () => {
  it("stays over Haiku 5.5's prompt-cache floor, so its cache marker does something", () => {
    expect(estimateTokens(POOL_REPLY_SYSTEM_PROMPT)).toBeGreaterThanOrEqual(MIN_CACHEABLE_TOKENS[HAIKU_MODEL]);
  });
  it("names each answer once, carries no em or en dash, and has English and Turkish examples", () => {
    for (const i of ["accept", "decline", "stop", "question", "neither"]) {
      expect(POOL_REPLY_SYSTEM_PROMPT.match(new RegExp(`^- "${i}":`, "gm"))).toHaveLength(1);
    }
    expect(POOL_REPLY_SYSTEM_PROMPT).not.toMatch(/[—–]/);
    expect(POOL_REPLY_SYSTEM_PROMPT).toMatch(/English \| Turkish/);
    expect(POOL_REPLY_SYSTEM_PROMPT).toMatch(/gelemiyorum|varım/);
  });
  it("runs on Haiku 5.5 with the house thinking, structured output", () => {
    expect(POOL_REPLY_CALL.model).toBe(HAIKU_MODEL);
    expect(POOL_REPLY_SCHEMA).toMatchObject({ type: "object", required: ["intent", "confidence", "reasoning"], additionalProperties: false });
  });
});

describe("the user turn", () => {
  it("carries the offers newest first with their state, his club, the quote, and his reply last", () => {
    const turn = buildPoolReplyUserTurn("yes please", { ...CTX, ownClub: "Sutton FC", quotedIndex: 0 });
    expect(turn).toMatch(/His own club: Sutton FC/);
    expect(turn).toMatch(/\[1\] .*open/);
    expect(turn).toMatch(/He swipe-replied to: offer \[1\]/);
    expect(turn.trimEnd().endsWith("HIS REPLY:\nyes please")).toBe(true);
  });
  it("never shows the model a signed link: every URL is <link>", () => {
    const turn = buildPoolReplyUserTurn("ok", CTX);
    expect(turn).not.toMatch(/https?:\/\//);
    expect(turn).not.toContain("SECRETHMAC");
    expect(turn).not.toContain("SHORTCODE");
    expect(turn).toContain("<link>");
  });
  it("says so when he is in no club and did not swipe-reply", () => {
    const turn = buildPoolReplyUserTurn("ok", CTX);
    expect(turn).toMatch(/His own club: none/);
    expect(turn).toMatch(/He swipe-replied to: nothing/);
  });
});

describe("parsePoolReply", () => {
  it("reads the contract", () => {
    expect(parsePoolReply('{"intent":"accept","confidence":0.92,"reasoning":"yes"}')).toEqual({ intent: "accept", confidence: 0.92, reasoning: "yes" });
  });
  it("keeps a low confidence as it is (the rules decide the re-ask)", () => {
    expect(parsePoolReply('{"intent":"decline","confidence":0.4,"reasoning":"?"}')).toMatchObject({ intent: "decline", confidence: 0.4 });
  });
  it("clamps the confidence", () => {
    expect(parsePoolReply('{"intent":"stop","confidence":7,"reasoning":""}').confidence).toBe(1);
  });
  it("anything unknown or broken is neither with no confidence", () => {
    expect(parsePoolReply('{"intent":"maybe","confidence":0.9}')).toMatchObject({ intent: "neither" });
    expect(parsePoolReply("not json")).toMatchObject({ intent: "neither", confidence: 0 });
    expect(parsePoolReply("")).toMatchObject({ intent: "neither", confidence: 0 });
  });
});

describe("readPoolReply", () => {
  afterEach(() => {
    delete process.env[POOL_REPLY_STUB_FILE_ENV];
  });

  it("sends the prompt, the turn, the schema and the Haiku posture", async () => {
    const seen: ModelRequest[] = [];
    const r = await readPoolReply("I'm in", CTX, { model: fakeModel('{"intent":"accept","confidence":0.9,"reasoning":"in"}', seen) });
    expect(r.intent).toBe("accept");
    expect(seen[0]).toMatchObject({ model: HAIKU_MODEL, system: POOL_REPLY_SYSTEM_PROMPT, schema: POOL_REPLY_SCHEMA, label: "pool-reply" });
    expect(seen[0].user).toContain("HIS REPLY:\nI'm in");
  });
  it("an empty reply asks nobody", async () => {
    const seen: ModelRequest[] = [];
    expect((await readPoolReply("   ", CTX, { model: fakeModel("{}", seen) })).intent).toBe("neither");
    expect(seen).toHaveLength(0);
  });
  it("no model, or a failed call: neither", async () => {
    expect((await readPoolReply("yes", CTX, { model: null })).intent).toBe("neither");
    const throwing: PipelineModel = { name: "x", complete: async () => Promise.reject(new Error("529")) };
    expect((await readPoolReply("yes", CTX, { model: throwing })).intent).toBe("neither");
  });
  it("the test seam answers by the reply body, with low:<intent> for an unsure reading", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pool-reply-stub-"));
    const file = path.join(dir, "stub.json");
    writeFileSync(file, JSON.stringify({ bodies: { "yes please": "accept", "hmm maybe": "low:accept" } }));
    process.env[POOL_REPLY_STUB_FILE_ENV] = file;
    expect(await readPoolReply("yes please", CTX)).toMatchObject({ intent: "accept", confidence: 1 });
    expect(await readPoolReply("hmm maybe", CTX)).toMatchObject({ intent: "accept", confidence: 0.5 });
    expect(await readPoolReply("unmapped", CTX)).toMatchObject({ intent: "neither" });
  });
});
