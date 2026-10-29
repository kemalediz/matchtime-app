/**
 * The monthly reader (2026-10-29): the model reads a monthly club's pasted
 * lists and sign-ups, code only checks the answer and acts on it. No model
 * is called here: a fake `PipelineModel` returns the JSON the model would.
 */
import { describe, expect, it } from "vitest";
import { readMonthlyMessage } from "../monthly-reader";
import {
  buildMonthlyReaderUserTurn,
  MONTHLY_READER_SCHEMA,
  MONTHLY_READER_SYSTEM,
  parseMonthlyReading,
  type MonthlyReaderContext,
  type MonthlyReaderInput,
} from "../monthly-reader-prompt";
import type { MonthlyList, MonthlyListEntry } from "../monthly-list";
import { mayJoinStartedMonth, reconcileSignupPaste } from "../month-signup-rules";
import { reconcileMonthPaste, type WeekMember, type WeekRow } from "../monthly-week-rules";
import type { PipelineModel } from "../pipeline/llm";

const CTX: MonthlyReaderContext = {
  orgId: "org-vets",
  members: [
    { ref: "p1", userId: "u-davide", name: "Davide De Souza", aliases: ["Bossman"], organiser: true },
    { ref: "p2", userId: "u-smiler", name: "Sam Miles", aliases: ["Smiler"], organiser: false },
    { ref: "p3", userId: "u-dean", name: "Dean", aliases: [], organiser: false },
    { ref: "p4", userId: "u-lucas", name: "Lucas", aliases: [], organiser: false },
  ],
  months: ["  November 2026 (month 11): sign-up open. 5 games: Mon 2 Nov, Mon 9 Nov, Mon 16 Nov, Mon 23 Nov, Mon 30 Nov; 5 still to play."],
  week: { game: "Mon 9 Nov 2026, 20:30", text: "List for November: Mon 9 Nov, 20:30\n1. Davide" },
};
const input = (body: string, over: Partial<MonthlyReaderInput> = {}): MonthlyReaderInput => ({
  body,
  sender: { userId: "u-dean", name: "Dean", organiser: false },
  history: [],
  reply: null,
  now: new Date("2026-11-05T12:00:00Z"),
  ...over,
});
const line = (over: Record<string, unknown>) => ({
  section: "playing",
  slot: 0,
  name: "",
  member: "",
  guest: false,
  host: "",
  games: 0,
  payg: false,
  paygDays: [],
  paid: false,
  paidPence: 0,
  concession: false,
  newbie: false,
  ...over,
});
const answer = (over: Record<string, unknown>) => ({
  kind: "list",
  month: 11,
  gameDay: 0,
  listOf: "week",
  lines: [],
  residual: "",
  choice: "",
  signupMonth: 0,
  days: [],
  games: 0,
  ...over,
});

describe("the prompt", () => {
  it("is one plain task, with examples in English and Turkish, and a strict schema with no nullable types", () => {
    expect(MONTHLY_READER_SYSTEM).toContain("Paid but can't play");
    expect(MONTHLY_READER_SYSTEM).toContain("Kasım");
    expect(MONTHLY_READER_SYSTEM).not.toMatch(/[–—]/);
    expect(JSON.stringify(MONTHLY_READER_SCHEMA)).not.toContain('"null"');
    // Above Haiku 5.5's cacheable minimum (512 tokens), at a pessimistic 4 characters a token.
    expect(MONTHLY_READER_SYSTEM.length / 4).toBeGreaterThan(512);
  });

  it("the user turn gives the context first: members with refs, the months, the week's list, the chat, then the message and its sender", () => {
    const turn = buildMonthlyReaderUserTurn(
      input("List for November\n1. Davide\n7. smiler 4 only", {
        history: [
          { author: "Davide De Souza", body: "Any more takers for November?" },
          { author: "Dean", body: "List for November\n1. Davide\n7. smiler 4 only" },
        ],
      }),
      CTX,
    );
    expect(turn).toContain("p2: Sam Miles (also: Smiler)");
    expect(turn).toContain("p1: Davide De Souza (also: Bossman), organiser");
    expect(turn).toContain("November 2026 (month 11)");
    expect(turn).toContain("THE WEEK'S LIST AS MATCHTIME HAS IT (next game: Mon 9 Nov 2026, 20:30)");
    expect(turn).toContain("Davide De Souza: Any more takers for November?");
    // The message is not its own context.
    expect(turn.split("smiler 4 only").length).toBe(2);
    expect(turn).toMatch(/From Dean \(p3\)\.\nTHE MESSAGE:\nList for November/);
  });
});

describe("the answer, checked against the context", () => {
  it("a note beside a name is read into fields; the name is the clean name and the member is the ref's id", () => {
    const r = parseMonthlyReading(
      answer({
        listOf: "month",
        lines: [
          line({ slot: 1, name: "Davide", member: "p1" }),
          line({ slot: 7, name: "smiler", member: "p2", games: 4 }),
          line({ slot: 8, name: "Andrew", payg: true, paygDays: [5] }),
          line({ slot: 4, name: "Steff", paid: true, paidPence: 2250, concession: true }),
          line({ slot: 9, name: "" }),
          line({ section: "cant_play", slot: 1, name: "Lucas", member: "p4" }),
        ],
      }),
      input("x"),
      CTX,
    );
    if (r.kind !== "list") throw new Error(r.kind);
    expect(r.listOf).toBe("month");
    expect(r.list.month).toEqual({ month: 11, year: null });
    const [davide, smiler, andrew, steff, blank] = r.list.slots;
    expect(davide.facts?.memberId).toBe("u-davide");
    expect(smiler).toMatchObject({ name: "smiler", slot: 7, facts: { memberId: "u-smiler", games: 4 } });
    expect(andrew.marks).toMatchObject({ payg: true, paygDates: [{ day: 5, month: 11 }], paid: false });
    expect(steff.marks).toMatchObject({ paid: true, paidAmountPence: 2250, tier: "concession" });
    expect(blank).toMatchObject({ name: "", slot: 9 });
    expect(r.list.sections.cantPlay[0].facts?.memberId).toBe("u-lucas");
  });

  it("never invents a member: an unknown ref is nobody; a guest's host may be the sender", () => {
    const r = parseMonthlyReading(
      answer({
        lines: [
          line({ slot: 13, name: "Jon", guest: true, host: "sender" }),
          line({ slot: 16, name: "Luca", member: "p99", guest: true }),
        ],
      }),
      input("x"),
      CTX,
    );
    if (r.kind !== "list") throw new Error(r.kind);
    expect(r.list.slots[0].facts).toMatchObject({ memberId: null, guest: true, hostUserId: "u-dean" });
    expect(r.list.slots[1].facts).toMatchObject({ memberId: null, guest: true, hostUserId: null });
  });

  it("the residual must be the sender's own words from the message, or it is dropped", () => {
    const body = "can't make it lads\nList for November\n1. Davide";
    const ok = parseMonthlyReading(answer({ lines: [line({ slot: 1, name: "Davide", member: "p1" })], residual: "can't make it lads" }), input(body), CTX);
    const made = parseMonthlyReading(answer({ lines: [line({ slot: 1, name: "Davide", member: "p1" })], residual: "I am out" }), input(body), CTX);
    expect(ok.kind === "list" && ok.residual).toBe("can't make it lads");
    expect(made.kind === "list" && made.residual).toBe("");
  });

  it("a sign-up in any words, with the games committed", () => {
    expect(parseMonthlyReading(answer({ kind: "signup", lines: [], choice: "in", signupMonth: 11, games: 4 }), input("I'm in for November except the last week"), CTX)).toEqual({
      kind: "signup",
      choice: "in",
      month: 11,
      days: [],
      games: 4,
    });
  });

  it("anything it cannot trust is none", () => {
    expect(parseMonthlyReading(null, input("x"), CTX).kind).toBe("none");
    expect(parseMonthlyReading(answer({ kind: "signup", choice: "in", signupMonth: 13 }), input("x"), CTX).kind).toBe("none");
    expect(parseMonthlyReading(answer({ lines: [] }), input("x"), CTX).kind).toBe("none");
    expect(parseMonthlyReading(answer({ kind: "banter" }), input("x"), CTX).kind).toBe("none");
  });
});

describe("readMonthlyMessage", () => {
  const fake = (text: string | Error): PipelineModel => ({
    name: "fake",
    complete: async () => {
      if (text instanceof Error) throw text;
      return { text, stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 0 };
    },
  });

  it("one call, read into a reading", async () => {
    const r = await readMonthlyMessage(input("November good for me"), CTX, {
      model: fake(JSON.stringify(answer({ kind: "signup", choice: "in", signupMonth: 11 }))),
    });
    expect(r).toMatchObject({ kind: "signup", choice: "in", month: 11, games: null });
  });

  it("FAIL SAFE: a failed call, garbage or no model is none, and nothing is read", async () => {
    expect((await readMonthlyMessage(input("List for November\n1. Davide"), CTX, { model: fake(new Error("529")) })).kind).toBe("none");
    expect((await readMonthlyMessage(input("List for November\n1. Davide"), CTX, { model: fake("not json") })).kind).toBe("none");
    expect((await readMonthlyMessage(input("List for November\n1. Davide"), CTX, { model: null })).kind).toBe("none");
  });
});

// ── Acting on the reading ──────────────────────────────────────────────

const entry = (slot: number | null, name: string, facts: Partial<NonNullable<MonthlyListEntry["facts"]>> = {}, payg = false): MonthlyListEntry => ({
  slot,
  raw: name,
  name,
  marks: { paid: false, paidAmountPence: null, tier: null, payg, paygDates: [] },
  facts: { memberId: null, guest: false, hostUserId: null, games: null, newbie: false, ...facts },
});
const listOf = (slots: MonthlyListEntry[], month = 11): MonthlyList => ({ month: { month, year: null }, slots, sections: { cantPlay: [], reserves: [], other: [] } });

describe("the week's list, acted on (reconcileMonthPaste)", () => {
  const reg = (n: number, id: string, name: string): WeekMember => ({ userId: id, name, kind: "regular", slot: n, paid: "none", absent: false, paygDated: false, left: false });
  const members = [reg(1, "u-davide", "Davide De Souza"), reg(2, "u-smiler", "Sam Miles")];
  const rows: WeekRow[] = [
    { userId: "u-davide", name: "Davide De Souza", status: "CONFIRMED", position: 1 },
    { userId: "u-smiler", name: "Sam Miles", status: "CONFIRMED", position: 2 },
  ];
  const roster = CTX.members.map((m) => ({ userId: m.userId, name: m.name, aliases: m.aliases }));
  const run = (slots: MonthlyListEntry[], senderUserId = "u-dean") =>
    reconcileMonthPaste({ list: listOf(slots), members, rows, maxPlayers: 16, roster, matchMonth: 11, seeded: true, senderUserId, senderIsAdmin: false });

  it("the reader's member is taken as it is: 'smiler 4 only' is Sam Miles, committing to 4 games", () => {
    const r = run([entry(1, "Davide", { memberId: "u-davide" }), entry(2, "smiler", { memberId: "u-smiler", games: 4 })], "u-smiler");
    expect(r.notAdded).toEqual([]);
    expect(r.games).toEqual([{ userId: "u-smiler", games: 4, self: true }]);
  });

  it("B2: a guest a member writes in is added as a guest of that member, never matched by a prefix ('Luca' is not 'Lucas')", () => {
    const r = run([entry(1, "Davide", { memberId: "u-davide" }), entry(2, "smiler", { memberId: "u-smiler" }), entry(3, "Luca", { guest: true, hostUserId: null })]);
    expect(r.actions).toEqual([{ kind: "guest", name: "Luca", hostUserId: "u-dean", slot: 3 }]);
    expect(r.notAdded).toEqual([]);
  });

  it("a guest from an earlier week, now a club player, comes in when a member writes him in again", () => {
    const r = run([entry(1, "Davide", { memberId: "u-davide" }), entry(2, "smiler", { memberId: "u-smiler" }), entry(3, "Lucas", { memberId: "u-lucas", guest: true })]);
    expect(r.actions).toEqual([{ kind: "in", userId: "u-lucas", name: "Lucas", self: false, slot: 3 }]);
  });

  it("a guest needs a member to bring him: from somebody who is not a club player, nothing is added", () => {
    const r = run([entry(1, "Davide", { memberId: "u-davide" }), entry(3, "Luca", { guest: true })], "u-stranger");
    expect(r.actions.filter((a) => a.kind === "guest")).toEqual([]);
  });

  it("before the week is seeded a guest is not added", () => {
    const r = reconcileMonthPaste({
      list: listOf([entry(1, "Davide", { memberId: "u-davide" }), entry(3, "Luca", { guest: true })]),
      members,
      rows: [],
      maxPlayers: 16,
      roster,
      matchMonth: 11,
      seeded: false,
      senderUserId: "u-dean",
      senderIsAdmin: false,
    });
    expect(r.actions).toEqual([]);
  });
});

describe("the month's list, acted on (reconcileSignupPaste)", () => {
  const roster = CTX.members.map((m) => ({ userId: m.userId, name: m.name, aliases: m.aliases }));
  const members = [{ userId: "u-davide", name: "Davide", kind: "regular" as const, slot: 1, waiting: false, out: false, paid: "none" as const, paygMatchIds: [] }];

  it("the sender's own '4 only' line joins with the games committed", () => {
    const r = reconcileSignupPaste({ list: listOf([entry(1, "Davide", { memberId: "u-davide" }), entry(2, "smiler", { memberId: "u-smiler", games: 4 })]), members, roster, monthNumber: 11, senderUserId: "u-smiler" });
    expect(r.self).toEqual({ choice: "in", days: [], games: 4 });
  });

  it("a '4 only' beside a regular already on the month is reported for the caller to apply (self or an organiser)", () => {
    const r = reconcileSignupPaste({ list: listOf([entry(1, "Davide", { memberId: "u-davide", games: 3 })]), members, roster, monthNumber: 11, senderUserId: "u-dean" });
    expect(r.games).toEqual([{ userId: "u-davide", games: 3, self: false }]);
  });
});

describe("B3: joining a month under way", () => {
  it("a newcomer's own line on the month's pasted list may join a running month, as for IN typed or the page", () => {
    expect(mayJoinStartedMonth({ choice: "in", source: "paste", gamesLeft: 3, running: true })).toBe(true);
    expect(mayJoinStartedMonth({ choice: "payg", source: "paste", gamesLeft: 3, running: true })).toBe(false);
    expect(mayJoinStartedMonth({ choice: "in", source: "paste", gamesLeft: 0, running: true })).toBe(false);
  });
});

// ── The organiser's DM answer to the coming month's draft ─────────────
import { applySeedChanges, parseSeedReply } from "../month-seed-reply";

describe("the organiser's DM answer to the draft (month-seed-reply)", () => {
  const members = [
    { ref: "p1", userId: "u-davide" },
    { ref: "p2", userId: "u-craig" },
    { ref: "p3", userId: "u-ben" },
  ];
  const j = (o: unknown) => JSON.stringify(o);
  it("yes, no and a correction, each only when sure; a change must name a member", () => {
    expect(parseSeedReply(j({ answer: "yes", changes: [], confidence: 0.95 }), members)).toEqual({ kind: "yes" });
    expect(parseSeedReply(j({ answer: "no", changes: [], confidence: 0.9 }), members)).toEqual({ kind: "no" });
    expect(parseSeedReply(j({ answer: "yes", changes: [], confidence: 0.5 }), members).kind).toBe("other");
    expect(
      parseSeedReply(j({ answer: "change", changes: [{ action: "games", member: "p2", games: 4 }, { action: "payg", member: "p3", games: 0 }], confidence: 0.9 }), members),
    ).toEqual({ kind: "change", changes: [{ action: "games", userId: "u-craig", games: 4 }, { action: "payg", userId: "u-ben" }] });
    expect(parseSeedReply(j({ answer: "change", changes: [{ action: "add", member: "p9", games: 0 }], confidence: 0.9 }), members).kind).toBe("other");
    expect(parseSeedReply("not json", members).kind).toBe("other");
  });

  it("the draft with his changes: 4 only, PAYG, added, taken off", () => {
    const rows = [
      { userId: "u-davide", kind: "regular" as const, gamesCommitted: null, listName: "Davide" },
      { userId: "u-craig", kind: "regular" as const, gamesCommitted: null, listName: "Craig" },
      { userId: "u-ben", kind: "regular" as const, gamesCommitted: null, listName: "Ben" },
    ];
    const out = applySeedChanges(
      rows,
      [
        { action: "games", userId: "u-craig", games: 4 },
        { action: "payg", userId: "u-ben" },
        { action: "remove", userId: "u-davide" },
        { action: "add", userId: "u-steve" },
      ],
      (id) => (id === "u-steve" ? "Steve" : ""),
    );
    expect(out.map((r) => [r.userId, r.kind, r.gamesCommitted ?? null])).toEqual([
      ["u-craig", "regular", 4],
      ["u-ben", "payg", null],
      ["u-steve", "regular", null],
    ]);
  });
});

// ── A season break by WhatsApp ─────────────────────────────────────────
import { nextBreakMonths } from "../season-break-words";

describe("a season break by WhatsApp (season-break-words)", () => {
  const NOW = new Date("2026-10-29T12:00:00Z");
  it("months off are added, months back on are taken out, and past months drop away", () => {
    expect(nextBreakMonths([], ["2026-12"], [], NOW)).toEqual(["2026-12"]);
    expect(nextBreakMonths(["2026-12"], [], ["2026-12"], NOW)).toEqual([]);
    expect(nextBreakMonths(["2026-09", "2026-12"], ["2027-01"], [], NOW)).toEqual(["2026-12", "2027-01"]);
    expect(nextBreakMonths(["2026-12", "2027-01"], [], ["2027-01"], NOW)).toEqual(["2026-12"]);
    expect(nextBreakMonths([], ["2026-08"], [], NOW)).toEqual([]);
  });
});

// ── The collector's answer to the paid-claims list ──────────────────────
import { buildDigestReplyUserTurn, parseDigestReply } from "../month-digest-reply";

describe("the collector's answer to the paid-claims list (month-digest-reply)", () => {
  const j = (o: unknown) => JSON.stringify(o);
  it("all, some numbers, none, a month named; unsure or not an answer is nothing", () => {
    expect(parseDigestReply(j({ answer: "all", numbers: [], month: 0, confidence: 0.95 }))).toEqual({ kind: "all" });
    expect(parseDigestReply(j({ answer: "numbers", numbers: [1, 3, 3], month: 0, confidence: 0.9 }))).toEqual({ kind: "numbers", numbers: [1, 3] });
    expect(parseDigestReply(j({ answer: "none", numbers: [], month: 11, confidence: 0.9 }))).toEqual({ kind: "none", month: 11 });
    expect(parseDigestReply(j({ answer: "all", numbers: [], month: 0, confidence: 0.5 }))).toBeNull();
    expect(parseDigestReply(j({ answer: "numbers", numbers: [], month: 0, confidence: 0.9 }))).toBeNull();
    expect(parseDigestReply(j({ answer: "other", numbers: [], month: 0, confidence: 1 }))).toBeNull();
    expect(parseDigestReply("not json")).toBeNull();
  });
  it("the turn shows each list he was sent, then his message", () => {
    const turn = buildDigestReplyUserTurn([{ month: 11, monthName: "November", lines: [{ slot: 1, name: "Alex" }, { slot: 3, name: "Steff" }] }], "1 and 3 are in");
    expect(turn).toBe("THE LIST FOR NOVEMBER (month 11):\n  1. Alex\n  3. Steff\n\nHIS MESSAGE:\n1 and 3 are in");
  });
});
