/**
 * READING A NAMELESS VOLUNTEER'S REPLY TO "what name should I list you
 * under?" (2026-10-22).
 *
 * The bug: his next DM was taken as his name whatever it said, so "OUT",
 * "actually can't make it" or "which match?" became User.name and he was
 * put IN. Now the model reads the reply (never a phrase list), and the
 * code keeps the deterministic guards on what it may save as a name.
 *
 * The model is stubbed here (a fake `PipelineModel`); the live check is
 * scripts/dryrun-volunteer-name-reply.ts on the dev key.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildVolunteerNameSystemPrompt,
  buildVolunteerNameUserTurn,
  parseVolunteerNameReply,
  readVolunteerNameReply,
  volunteerNameFromReply,
  VOLUNTEER_NAME_REPLY_CALL,
} from "../volunteer-name-reply";
import type { ModelRequest, PipelineModel } from "../pipeline/llm";
import { HAIKU_MODEL } from "../models";

const CTX = {
  askerName: "FNF",
  day: "Fri 30 Oct, 20:30",
  question: "Thanks! Before I put you down for *FNF*'s game, Fri 30 Oct, 20:30, what name should I list you under? Just reply with your name.",
};

function fakeModel(answer: string | (() => never)): PipelineModel & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    name: "fake",
    requests,
    complete: async (req) => {
      requests.push(req);
      const text = typeof answer === "string" ? answer : answer();
      return { text, stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 1 };
    },
  };
}

const json = (o: Record<string, unknown>) => JSON.stringify(o);

describe("parseVolunteerNameReply (the JSON contract and the name guards)", () => {
  it("a name the model found in his words: kept, spaces collapsed", () => {
    expect(parseVolunteerNameReply(json({ reply: "name", name: "Mark  Smith", confidence: 0.95 }), "it's Mark Smith")).toEqual({ kind: "name", name: "Mark Smith" });
    expect(parseVolunteerNameReply(json({ reply: "name", name: "Can", confidence: 0.9 }), "Adım Can")).toEqual({ kind: "name", name: "Can" });
    expect(parseVolunteerNameReply(json({ reply: "name", name: "İlker", confidence: 0.9 }), "ilker")).toEqual({ kind: "name", name: "İlker" });
  });

  it("a name that is not in his message is never saved (the model may not invent one)", () => {
    expect(parseVolunteerNameReply(json({ reply: "name", name: "Ali", confidence: 0.99 }), "OUT").kind).toBe("other");
  });

  it("a phone number, no letter, or an empty name is never a name", () => {
    expect(parseVolunteerNameReply(json({ reply: "name", name: "07893 944985", confidence: 0.99 }), "07893 944985").kind).toBe("other");
    expect(parseVolunteerNameReply(json({ reply: "name", name: "👍", confidence: 0.99 }), "👍").kind).toBe("other");
    expect(parseVolunteerNameReply(json({ reply: "name", name: "", confidence: 0.99 }), "Ali").kind).toBe("other");
  });

  it("an OUT is an OUT, with or without a name", () => {
    expect(parseVolunteerNameReply(json({ reply: "out", name: "", confidence: 0.9 }), "actually can't make it")).toEqual({ kind: "out" });
    expect(parseVolunteerNameReply(json({ reply: "out", name: "Ali", confidence: 0.9 }), "Ali but I can't come")).toEqual({ kind: "out" });
  });

  it("below 80% sure, or anything unreadable: other, which only asks again", () => {
    expect(parseVolunteerNameReply(json({ reply: "name", name: "Ali", confidence: 0.6 }), "Ali").kind).toBe("other");
    expect(parseVolunteerNameReply(json({ reply: "out", confidence: 0.5 }), "hmm out?").kind).toBe("other");
    expect(parseVolunteerNameReply("not json", "Ali").kind).toBe("other");
    expect(parseVolunteerNameReply(json({ reply: "maybe", confidence: 1 }), "Ali").kind).toBe("other");
    expect(parseVolunteerNameReply(json({ reply: "other", confidence: 1 }), "which match?").kind).toBe("other");
  });

  it("a fenced answer still parses", () => {
    expect(parseVolunteerNameReply("```json\n" + json({ reply: "name", name: "Ben", confidence: 0.9 }) + "\n```", "Ben here")).toEqual({ kind: "name", name: "Ben" });
  });
});

describe("volunteerNameFromReply (the deterministic guard, unchanged)", () => {
  it("trimmed, spaces collapsed, capped at 40, never a number", () => {
    expect(volunteerNameFromReply("  Cem\n Yilmaz ")).toBe("Cem Yilmaz");
    expect(volunteerNameFromReply("x".repeat(60))).toHaveLength(40);
    expect(volunteerNameFromReply("👍")).toBeNull();
    expect(volunteerNameFromReply("+447893944985")).toBeNull();
    expect(volunteerNameFromReply("")).toBeNull();
    expect(volunteerNameFromReply("İlker")).toBe("İlker");
  });
});

describe("readVolunteerNameReply (one Haiku call, failing safe)", () => {
  it("asks Haiku 5.5 once with the question we asked, the club and the day as context, the reply under its header", async () => {
    const model = fakeModel(json({ reply: "name", name: "Ben", confidence: 0.95 }));
    expect(await readVolunteerNameReply("Ben here", CTX, { model })).toEqual({ kind: "name", name: "Ben" });
    expect(model.requests).toHaveLength(1);
    const [req] = model.requests;
    expect(req).toMatchObject({ model: HAIKU_MODEL, thinking: VOLUNTEER_NAME_REPLY_CALL.thinking, label: "volunteer-name-reply" });
    expect(req.system).toBe(buildVolunteerNameSystemPrompt());
    expect(req.user).toBe(buildVolunteerNameUserTurn("Ben here", CTX));
    expect(req.user).toContain("FNF");
    expect(req.user).toContain("Fri 30 Oct, 20:30");
    expect(req.user).toContain(CTX.question);
    expect(req.user.trim().endsWith("Ben here")).toBe(true);
  });

  it("the model call fails: other (save nothing, record nothing, ask again)", async () => {
    const model = fakeModel(() => {
      throw new Error("529 overloaded");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await readVolunteerNameReply("Ali", CTX, { model })).kind).toBe("other");
    err.mockRestore();
  });

  it("no model at all, or an empty reply: other, and no call", async () => {
    expect((await readVolunteerNameReply("Ali", CTX, { model: null })).kind).toBe("other");
    const model = fakeModel(json({ reply: "name", name: "x", confidence: 1 }));
    expect((await readVolunteerNameReply("   ", CTX, { model })).kind).toBe("other");
    expect(model.requests).toHaveLength(0);
  });

  it("the prompt is short, defines each answer once, and has no em dashes", () => {
    const p = buildVolunteerNameSystemPrompt();
    expect(p).not.toMatch(/[—–]/);
    expect(p.length).toBeLessThan(2500);
    for (const k of ['"name"', '"out"', '"other"']) expect(p).toContain(k);
  });
});
