/**
 * THE ONE DM READ, ONCE PER DM (`dm-reader.ts`, 2026-10-30). Every step
 * of the DM route that asks (GO, the stop and start commands, the admin
 * instructions, the Q&A) gets the SAME answer from ONE model call, and a
 * failure anywhere is `other`, which acts on nothing.
 */
import { describe, it, expect, vi } from "vitest";
import { createDmReaderWith, type DmReaderFacts } from "../dm-reader";

const FACTS: DmReaderFacts = { context: { senderName: "Ali" }, budgetKey: "org-1" };

describe("createDmReaderWith", () => {
  it("one model call however many steps ask", async () => {
    const classify = vi.fn(async () => ({ intent: "stop_messages" as const, confidence: 0.9, reasoning: "r" }));
    const facts = vi.fn(async () => FACTS);
    const r = createDmReaderWith({ facts, classify });
    const [a, b] = await Promise.all([r.read("u1"), r.read("u1")]);
    const c = await r.read("u1");
    expect(a.intent).toBe("stop_messages");
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(facts).toHaveBeenCalledTimes(1);
  });

  it("the facts are loaded for the user who asked first, and handed to the model", async () => {
    const classify = vi.fn(async (f: DmReaderFacts) => ({ intent: "other" as const, confidence: 0, reasoning: String(f.budgetKey) }));
    const facts = vi.fn(async (userId: string) => ({ ...FACTS, budgetKey: `key-${userId}` }));
    const r = createDmReaderWith({ facts, classify });
    expect((await r.read("u7")).reasoning).toBe("key-u7");
    expect(facts).toHaveBeenCalledWith("u7");
  });

  it("a facts read that throws is `other`, and the model is never asked", async () => {
    const classify = vi.fn();
    const r = createDmReaderWith({ facts: async () => { throw new Error("db down"); }, classify });
    expect((await r.read("u1")).intent).toBe("other");
    expect(classify).not.toHaveBeenCalled();
  });

  it("a model call that throws is `other`", async () => {
    const r = createDmReaderWith({ facts: async () => FACTS, classify: async () => { throw new Error("cap"); } });
    expect((await r.read("u1")).intent).toBe("other");
  });
});
