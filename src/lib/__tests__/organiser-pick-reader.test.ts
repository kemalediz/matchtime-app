/**
 * THE PICK READER (2026-10-30): its prompt, its user turn, the check of its
 * answer and the adapter around the model call, with a stubbed model. The
 * model says what an organiser's reply to MatchTime's numbered bench list
 * means; these pin what code does with that answer: a number off the list
 * or a ref it was not shown is not applied, YES counts only while a
 * question waits, an ambiguous name must be in the message, "unclear" is
 * P6 in a DM and silence in HQ, and a failure is never a pick.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildPickReaderUserTurn,
  parsePickReading,
  PICK_READER_SCHEMA,
  PICK_READER_SYSTEM,
  type PickReaderContext,
  type PickReaderInput,
} from "../organiser-pick-reader-prompt";
import { readPickReply } from "../organiser-pick-reader";
import type { PipelineModel } from "../pipeline/llm";

const ctx = (over: Partial<PickReaderContext> = {}): PickReaderContext => ({
  orgId: "org1",
  door: "admin-group",
  list: [
    { ref: "p1", userId: "u-kemal", name: "Kemal Ediz" },
    { ref: "p2", userId: "u-wasim", name: "Wasim" },
    { ref: "p3", userId: "u-ali-k", name: "Ali Khan" },
    { ref: "p4", userId: "u-ibo", name: "İbrahim Işık" },
  ],
  confirmed: [{ ref: "p5", userId: "u-hamzah", name: "Hamzah" }],
  others: [
    { ref: "p6", userId: "u-ali-d", name: "Ali Demir" },
    { ref: "p7", userId: "u-sam", name: "Sam Lee" },
  ],
  asked: "Reply here with a number, a name or an @tag, e.g. *2*, or *2 3* for two. *NONE* leaves it open.",
  pending: null,
  tags: [],
  ...over,
});
const input = (body: string, extra: Partial<PickReaderInput> = {}): PickReaderInput => ({ body, senderName: "Hamzah", history: [], ...extra });
const ans = (o: Record<string, unknown>) => ({ kind: "other", positions: [], people: [], name: "", candidates: [], ...o });

describe("the prompt", () => {
  it("names every kind, keeps to the house rules, and the schema asks for each output once", () => {
    for (const k of ["pick", "all", "none", "yes", "ambiguous", "unknown-tag", "unclear", "other"]) expect(PICK_READER_SYSTEM).toContain(`"${k}"`);
    expect(PICK_READER_SYSTEM).not.toMatch(/[–—]/);
    expect(PICK_READER_SYSTEM).toContain("hepsi");
    expect(PICK_READER_SYSTEM).toContain("hiçbiri");
    expect(PICK_READER_SCHEMA.required).toEqual(["kind", "positions", "people", "name", "candidates"]);
  });

  it("the user turn shows the list as sent with refs, the question, the squad, the members, the tags, the recent messages and the message last", () => {
    const turn = buildPickReaderUserTurn(
      input("@252012071493723", { history: [{ author: "MatchTime", body: "Bench: 1. Kemal" }, { author: "Rafi", body: "who's free?" }] }),
      ctx({
        pending: { ref: "p7", userId: "u-sam", name: "Sam Lee" },
        tags: [
          { digits: "252012071493723", ref: "p2", whatsappName: "Wasimp" },
          { digits: "99999", ref: null, whatsappName: "Bob" },
        ],
      }),
    );
    expect(turn).toContain("WHERE: the club's admin group (HQ).");
    expect(turn).toContain("  1. p1 Kemal Ediz\n  2. p2 Wasim");
    expect(turn).toContain("MatchTime asked: Reply here with a number");
    expect(turn).toContain("WAITING FOR YES: MatchTime asked whether to bring in p7 Sam Lee");
    expect(turn).toContain("THE SQUAD: p5 Hamzah");
    expect(turn).toContain("OTHER MEMBERS: p6 Ali Demir, p7 Sam Lee");
    expect(turn).toContain("@252012071493723 is p2 Wasim");
    expect(turn).toContain("@99999 is nobody in the club (their own WhatsApp name: Bob)");
    expect(turn).toContain("MatchTime: Bench: 1. Kemal");
    expect(turn.trim().endsWith("THE MESSAGE:\n@252012071493723")).toBe(true);
  });

  it("a DM says so and shows no tags or recent messages when there are none", () => {
    const turn = buildPickReaderUserTurn(input("2"), ctx({ door: "dm" }));
    expect(turn).toContain("WHERE: a private message from an organiser.");
    expect(turn).toContain("WAITING FOR YES: nothing.");
    expect(turn).not.toContain("TAGS IN THE MESSAGE");
    expect(turn).not.toContain("RECENT MESSAGES");
  });
});

describe("the answer, checked against the facts", () => {
  const read = (o: Record<string, unknown>, body = "x", c = ctx()) => parsePickReading(ans(o), input(body), c);

  it("list numbers and refs it was shown are a pick", () => {
    expect(read({ kind: "pick", positions: [2, 3, 2] })).toEqual({ kind: "pick", positions: [2, 3], userIds: [] });
    expect(read({ kind: "pick", people: ["p2", "p7", "p5"] })).toEqual({ kind: "pick", positions: [], userIds: ["u-wasim", "u-sam", "u-hamzah"] });
    expect(read({ kind: "pick", positions: [1], people: ["p2"] })).toEqual({ kind: "pick", positions: [1], userIds: ["u-wasim"] });
  });

  it("a number off the list, or a ref it was not shown: P6 in a DM, nothing in HQ, and nothing applied", () => {
    for (const o of [{ kind: "pick", positions: [9] }, { kind: "pick", positions: [0] }, { kind: "pick", positions: [2], people: ["p99"] }, { kind: "pick" }]) {
      expect(read(o), JSON.stringify(o)).toEqual({ kind: "not-a-pick" });
      expect(read(o, "x", ctx({ door: "dm" })), JSON.stringify(o)).toEqual({ kind: "not-understood" });
    }
  });

  it("unclear: P6 in a DM, nothing in HQ; other is never ours", () => {
    expect(read({ kind: "unclear" })).toEqual({ kind: "not-a-pick" });
    expect(read({ kind: "unclear" }, "x", ctx({ door: "dm" }))).toEqual({ kind: "not-understood" });
    expect(read({ kind: "other" }, "x", ctx({ door: "dm" }))).toEqual({ kind: "not-a-pick" });
  });

  it("all and none", () => {
    expect(read({ kind: "all" })).toEqual({ kind: "all" });
    expect(read({ kind: "none" })).toEqual({ kind: "none" });
  });

  it("yes counts only while a question waits", () => {
    expect(read({ kind: "yes" })).toEqual({ kind: "not-a-pick" });
    expect(read({ kind: "yes" }, "evet", ctx({ pending: { ref: "p7", userId: "u-sam", name: "Sam Lee" } }))).toEqual({ kind: "yes" });
  });

  it("an unknown tag is E4", () => {
    expect(read({ kind: "unknown-tag" })).toEqual({ kind: "unresolved-tag" });
  });

  it("ambiguous: the name must be in the message and fit two or more people shown", () => {
    expect(read({ kind: "ambiguous", name: "ali", candidates: ["p3", "p6"] }, "Ali")).toEqual({ kind: "ambiguous", first: "ali", names: ["Ali Khan", "Ali Demir"] });
    expect(read({ kind: "ambiguous", name: "Bob", candidates: ["p3", "p6"] }, "Ali")).toEqual({ kind: "not-a-pick" });
    expect(read({ kind: "ambiguous", name: "Ali", candidates: ["p3", "p99"] }, "Ali", ctx({ door: "dm" }))).toEqual({ kind: "not-understood" });
  });

  it("anything unreadable is not a pick", () => {
    expect(parsePickReading(null, input("2"), ctx())).toEqual({ kind: "not-a-pick" });
    expect(parsePickReading("2", input("2"), ctx())).toEqual({ kind: "not-a-pick" });
    expect(read({ kind: "maybe" })).toEqual({ kind: "not-a-pick" });
  });
});

describe("readPickReply: one model call, fail safe", () => {
  const passthrough = <T,>(_k: string, fn: () => Promise<T>) => fn();
  const model = (text: string): PipelineModel & { calls: unknown[] } => {
    const calls: unknown[] = [];
    return { name: "stub", calls, complete: vi.fn(async (req) => (calls.push(req), { text, costUsd: 0 }) as never) };
  };

  it("one Haiku call with the schema, under the club's budget; the answer is checked", async () => {
    const m = model(JSON.stringify(ans({ kind: "pick", positions: [2] })));
    const budget = vi.fn(passthrough) as unknown as typeof passthrough;
    expect(await readPickReply(input("2"), ctx(), { model: m, budget })).toEqual({ kind: "pick", positions: [2], userIds: [] });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]).toMatchObject({ system: PICK_READER_SYSTEM, label: "organiser-pick-reader", schema: PICK_READER_SCHEMA });
    expect(budget).toHaveBeenCalledWith("org1", expect.any(Function));
  });

  it("no model, a failed call, the cap, or an unreadable answer: not a pick, in a DM too (never a fallback)", async () => {
    const dm = ctx({ door: "dm" });
    expect(await readPickReply(input("2"), dm, { model: null, budget: passthrough })).toEqual({ kind: "not-a-pick" });
    const failing: PipelineModel = { name: "x", complete: async () => { throw new Error("AI budget exceeded"); } };
    expect(await readPickReply(input("2"), dm, { model: failing, budget: passthrough })).toEqual({ kind: "not-a-pick" });
    expect(await readPickReply(input("2"), dm, { model: model("no json here"), budget: passthrough })).toEqual({ kind: "not-a-pick" });
  });

  it("an empty message is never sent to the model", async () => {
    const m = model("{}");
    expect(await readPickReply(input("   "), ctx(), { model: m, budget: passthrough })).toEqual({ kind: "not-a-pick" });
    expect(m.calls).toHaveLength(0);
  });
});
