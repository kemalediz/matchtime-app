/**
 * The monthly reader and the members with NO name yet (2026-11-03, Vets
 * MNF: 20 of 27 imported by phone), and an organiser asking for somebody
 * to be put on a month ("@Match Time add Tom to the November list, he's
 * paid"). No model: the JSON the model would return is handed in.
 */
import { describe, expect, it } from "vitest";
import { MONTHLY_READER_MAX_TOKENS, readMonthlyMessage } from "../monthly-reader";
import type { PipelineModel } from "../pipeline/llm";
import {
  buildMonthlyReaderUserTurn,
  MONTHLY_READER_SCHEMA,
  MONTHLY_READER_SYSTEM,
  parseMonthlyReading,
  type MonthlyReaderContext,
  type MonthlyReaderInput,
} from "../monthly-reader-prompt";

const CTX: MonthlyReaderContext = {
  orgId: "org-vets",
  members: [
    { ref: "p1", userId: "u-davide", name: "Davide Russo", aliases: [], organiser: true },
    { ref: "p2", userId: "u-tom", name: "Tom Hale", aliases: [], organiser: false },
    { ref: "p3", userId: "u-luca", name: "", aliases: [], organiser: false, nameless: true, seenAs: "Luca", onList: [] },
    { ref: "p4", userId: "u-nabz", name: "", aliases: [], organiser: false, nameless: true, seenAs: null, onList: [{ month: "November 2026", slot: 2 }] },
    { ref: "p5", userId: "u-anon", name: "", aliases: [], organiser: false, nameless: true, seenAs: null, onList: [] },
  ],
  months: ["  November 2026 (month 11): under way."],
  week: null,
};
const davide = { userId: "u-davide", name: "Davide Russo", organiser: true };
const input = (body: string, sender = davide): MonthlyReaderInput => ({ body, sender, history: [], reply: null, now: new Date("2026-11-05T12:00:00Z") });
const answer = (over: Record<string, unknown>) => ({
  kind: "signup",
  month: 0,
  gameDay: 0,
  listOf: "",
  lines: [],
  residual: "",
  choice: "in",
  signupMonth: 11,
  signupFor: "other",
  signupWho: "",
  signupName: "",
  signupPaid: false,
  signupPaidPence: 0,
  days: [],
  games: 0,
  ...over,
});

describe("members with no name yet, shown with what MatchTime knows of them", () => {
  it("each has a ref and 'no name yet', with the WhatsApp name he posts under and his number on a month's list", () => {
    const turn = buildMonthlyReaderUserTurn(input("hi"), CTX);
    expect(turn).toContain('p3: no name yet (WhatsApp name "Luca")');
    expect(turn).toContain("p4: no name yet (number 2 on the November 2026 list)");
    expect(turn).toMatch(/p5: no name yet\n/);
    // Never a phone number.
    expect(turn).not.toMatch(/\+44|07\d{3}/);
  });

  it("the prompt says a member with no name is matched only on a fact beside him, and a plain new name has no host", () => {
    expect(MONTHLY_READER_SYSTEM).toContain("no name yet");
    expect(MONTHLY_READER_SYSTEM).toMatch(/only when a fact beside him points to him/);
    expect(MONTHLY_READER_SYSTEM).toMatch(/"" when nothing says anybody brings him/);
    expect(MONTHLY_READER_SYSTEM).not.toMatch(/[–—]/);
  });
});

describe("a sign-up for somebody else, read with who it is", () => {
  it("'add Tom to the November list, he's paid': an add for that member, says paid", () => {
    const r = parseMonthlyReading(answer({ signupWho: "p2", signupName: "Tom", signupPaid: true }), input("@Match Time add Tom to the November list, he's paid"), CTX);
    expect(r).toEqual({ kind: "add", month: 11, choice: "in", days: [], games: null, person: { memberId: "u-tom", name: "Tom" }, paid: true, paidPence: null });
  });

  it("a name that is nobody: an add with no member and the name as written; 4 games and the amount kept", () => {
    const r = parseMonthlyReading(answer({ signupName: "Zak", games: 4, signupPaid: true, signupPaidPence: 3000 }), input("add Zak to November, 4 games, paid £30"), CTX);
    expect(r).toMatchObject({ kind: "add", person: { memberId: null, name: "Zak" }, games: 4, paid: true, paidPence: 3000 });
  });

  it("PAYG for somebody else keeps its days and is never 'paid' for the month", () => {
    const r = parseMonthlyReading(answer({ choice: "payg", signupWho: "p2", signupName: "Tom", days: [16], signupPaid: true }), input("put Tom on November as PAYG for the 16th"), CTX);
    expect(r).toMatchObject({ kind: "add", choice: "payg", days: [16], paid: false });
  });

  it("an out for somebody else, nobody named, the sender himself, or a name not in the message: none", () => {
    expect(parseMonthlyReading(answer({ choice: "out", signupWho: "p2", signupName: "Tom" }), input("Tom is out for November"), CTX).kind).toBe("none");
    expect(parseMonthlyReading(answer({}), input("my son is in for November"), CTX).kind).toBe("none");
    expect(parseMonthlyReading(answer({ signupWho: "sender" }), input("add me to November"), CTX).kind).toBe("none");
    expect(parseMonthlyReading(answer({ signupName: "Zak" }), input("add him to November"), CTX).kind).toBe("none");
    expect(parseMonthlyReading(answer({ signupWho: "p99", signupName: "" }), input("add him to November"), CTX).kind).toBe("none");
  });

  it("the sender's own sign-up is as before", () => {
    expect(parseMonthlyReading(answer({ signupFor: "sender" }), input("IN FOR NOVEMBER"), CTX)).toEqual({ kind: "signup", choice: "in", month: 11, days: [], games: null });
  });

  it("the schema asks who, by ref and by name, and whether he has paid", () => {
    for (const f of ["signupWho", "signupName", "signupPaid", "signupPaidPence"]) expect(MONTHLY_READER_SCHEMA.required).toContain(f);
  });
});

describe("a list line's host", () => {
  it("'' is nobody brings him (a plain new name); 'sender' is the sender", () => {
    const list = (host: string) =>
      parseMonthlyReading(
        { kind: "list", month: 11, gameDay: 0, listOf: "month", residual: "", lines: [{ section: "playing", slot: 14, name: "Zak", member: "", guest: true, host }] },
        input("MNF November\n14. Zak"),
        CTX,
      );
    const a = list("");
    const b = list("sender");
    expect(a.kind === "list" && a.list.slots[0].facts).toMatchObject({ guest: true, hostUserId: null });
    expect(b.kind === "list" && b.list.slots[0].facts).toMatchObject({ guest: true, hostUserId: "u-davide" });
  });

  it("a nameless member the reader matched is that member, never a guest", () => {
    const r = parseMonthlyReading(
      { kind: "list", month: 11, gameDay: 0, listOf: "month", residual: "", lines: [{ section: "playing", slot: 14, name: "Luca", member: "p3", guest: false }] },
      input("MNF November\n14. Luca (paid)"),
      CTX,
    );
    expect(r.kind === "list" && r.list.slots[0].facts).toMatchObject({ memberId: "u-luca", guest: false });
  });
});

describe("the call", () => {
  it("leaves room for a long list with Haiku's thinking (4,096 cut off a 21-line list, 2026-11-03)", async () => {
    let asked = 0;
    const model = {
      name: "spy",
      complete: async (req: { maxTokens: number }) => {
        asked = req.maxTokens;
        return { text: '{"kind":"none"}', stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 0 };
      },
    } as unknown as PipelineModel;
    await readMonthlyMessage(input("List"), CTX, { model });
    expect(asked).toBe(MONTHLY_READER_MAX_TOKENS);
    expect(MONTHLY_READER_MAX_TOKENS).toBeGreaterThanOrEqual(8_192);
  });
});
