/**
 * The two model reads behind an untagged call-off (2026-10-29): did the
 * organiser call the next game off, read against the group's recent chat;
 * and is his DM reply a yes to cancelling it. What the model is shown, how
 * its answer is read, and that every failure is "no".
 */
import { describe, expect, it } from "vitest";
import {
  CALLOFF_MESSAGE_HEADER,
  CALLOFF_REPLY_HEADER,
  buildCalloffSystemPrompt,
  buildCalloffUserTurn,
  buildCalloffReplySystemPrompt,
  buildCalloffReplyUserTurn,
  parseCalloffVerdict,
  parseCalloffReply,
  readGroupCalloff,
  readCalloffReply,
} from "../calloff-reader";
import type { PipelineModel } from "../pipeline/llm";

const NOW = new Date("2026-10-26T18:28:00Z");
const ctx = {
  authorName: "Steff",
  body: "Alright, so it's off gents, enjoy your evenings at home",
  game: "Monday 26 October, 20:30",
  history: [
    { author: "Lucas", body: "Sorry lads can't make it today" },
    { author: "Steff", body: "Shite 😬😬" },
    { author: "Steff", body: "Alright, so it's off gents, enjoy your evenings at home" },
    { author: "Steff", body: "Nah, they won't come, they play every weekend" },
  ],
  reply: null,
  now: NOW,
};

function fake(text: string, seen: Array<{ system: string; user: string }> = []): PipelineModel {
  return {
    name: "fake",
    complete: async (req) => {
      seen.push({ system: req.system, user: req.user });
      return { text, stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 0 };
    },
  };
}
const boom: PipelineModel = { name: "boom", complete: async () => { throw new Error("overloaded"); } };

describe("what the call-off reader is shown", () => {
  it("the time, the next game, the recent chat (never the message itself), then the organiser's message", () => {
    const user = buildCalloffUserTurn(ctx);
    expect(user).toMatch(/^NOW: /);
    expect(user).toContain("THE CLUB'S NEXT GAME: Monday 26 October, 20:30");
    expect(user).toContain("Lucas: Sorry lads can't make it today");
    expect(user).toContain("Steff: Nah, they won't come");
    expect(user.split(ctx.body)).toHaveLength(2); // once, under the header
    expect(user.endsWith(`${CALLOFF_MESSAGE_HEADER}\n${ctx.body}`)).toBe(true);
    expect(user).toContain("an organiser of the club");
  });
  it("a WhatsApp reply shows what it quotes", () => {
    const user = buildCalloffUserTurn({
      ...ctx,
      body: "Yes",
      reply: { at: null, text: "Are we off for tonight?", topic: null, match: null, author: { name: "Mark" } },
    });
    expect(user).toContain("THEY ARE REPLYING TO Mark's message");
    expect(user).toContain("Are we off for tonight?");
  });
  it("the prompt is one plain task with English and Turkish examples", () => {
    const p = buildCalloffSystemPrompt();
    expect(p).toContain("calloff");
    expect(p).toMatch(/maç yok/);
    expect(p).not.toMatch(/[–—]/);
  });
});

describe("reading the verdict", () => {
  it("a sure call-off is a call-off", () => {
    expect(parseCalloffVerdict('{"calloff": true, "confidence": 0.9}')).toBe(true);
  });
  it("unsure, false, or garbage is not", () => {
    expect(parseCalloffVerdict('{"calloff": true, "confidence": 0.5}')).toBe(false);
    expect(parseCalloffVerdict('{"calloff": false, "confidence": 1}')).toBe(false);
    expect(parseCalloffVerdict("no idea")).toBe(false);
  });
  it("the model is asked once; a failed call is no call-off", async () => {
    const seen: Array<{ system: string; user: string }> = [];
    expect(await readGroupCalloff(ctx, { model: fake('{"calloff": true, "confidence": 0.95}', seen) })).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].system).toBe(buildCalloffSystemPrompt());
    expect(await readGroupCalloff(ctx, { model: boom })).toBe(false);
    expect(await readGroupCalloff(ctx, { model: null })).toBe(false);
  });
});

describe("his DM reply", () => {
  const rctx = { question: "Sounds like Monday is off. Reply *cancel* and I'll cancel it and tell the group, or ignore this if it's still on.", text: "yeah go on", lang: "en" };
  it("is shown the question and his words", () => {
    const user = buildCalloffReplyUserTurn(rctx);
    expect(user).toContain(rctx.question);
    expect(user.endsWith(`${CALLOFF_REPLY_HEADER}\nyeah go on`)).toBe(true);
    expect(buildCalloffReplySystemPrompt()).toMatch(/iptal/);
  });
  it("yes, no, or anything else", () => {
    expect(parseCalloffReply('{"answer": "yes", "confidence": 0.9}')).toBe("yes");
    expect(parseCalloffReply('{"answer": "no", "confidence": 0.9}')).toBe("no");
    expect(parseCalloffReply('{"answer": "yes", "confidence": 0.4}')).toBe("other");
    expect(parseCalloffReply('{"answer": "maybe"}')).toBe("other");
    expect(parseCalloffReply("garbage")).toBe("other");
  });
  it("a failed call is other, never a yes", async () => {
    expect(await readCalloffReply(rctx, { model: fake('{"answer": "yes", "confidence": 1}') })).toBe("yes");
    expect(await readCalloffReply(rctx, { model: boom })).toBe("other");
  });
});
