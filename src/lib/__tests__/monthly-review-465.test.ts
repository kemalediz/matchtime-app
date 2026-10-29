/**
 * The adversarial review of #465 (2026-10-29), its proofs inverted into
 * tests of the fixed behaviour. Code gates on facts only, never on text.
 */
import { describe, expect, it } from "vitest";
import { parseMonthlyReading, type MonthlyReaderContext, type MonthlyReaderInput } from "@/lib/monthly-reader-prompt";
import { MAX_GUESTS_PER_PASTE, reconcileMonthPaste, type WeekMember, type WeekRow } from "@/lib/monthly-week-rules";
import { readMonthlyMessage } from "@/lib/monthly-reader";
import { answersOpenDigest, decideCollectorReply, DIGEST_ANSWER_WINDOW_MS } from "@/lib/month-payment-rules";
import type { PipelineModel } from "@/lib/pipeline/llm";

const ctx: MonthlyReaderContext = {
  orgId: "org1",
  members: [
    { ref: "p1", userId: "u-org", name: "Davide", aliases: [], organiser: true },
    { ref: "p2", userId: "u-joe", name: "Joe", aliases: [], organiser: false },
    { ref: "p3", userId: "u-ann", name: "Ann", aliases: [], organiser: false },
    { ref: "p4", userId: "u-club", name: "Clubby", aliases: [], organiser: false },
  ],
  months: [],
  week: null,
};
const input = (body: string, userId = "u-joe"): MonthlyReaderInput => ({
  body,
  sender: { userId, name: "Joe", organiser: false },
  history: [],
  reply: null,
  now: new Date("2026-10-29T12:00:00Z"),
});
const member = (userId: string, name: string, slot: number): WeekMember =>
  ({ userId, name, kind: "regular", slot, paid: "none", absent: false, paygDated: false, left: false }) as WeekMember;
const roster = ctx.members.map((m) => ({ userId: m.userId, name: m.name, aliases: [] }));
const members = [member("u-org", "Davide", 1), member("u-joe", "Joe", 2), member("u-ann", "Ann", 3)];
const rows: WeekRow[] = members.map((m, i) => ({ userId: m.userId, name: m.name, status: "CONFIRMED", position: i + 1 }));
const reconcile = (raw: unknown, over: { senderUserId?: string; senderIsAdmin?: boolean; maxPlayers?: number } = {}) => {
  const r = parseMonthlyReading(raw, input("list", over.senderUserId ?? "u-joe"), ctx);
  if (r.kind !== "list") throw new Error("not list");
  return reconcileMonthPaste({
    list: r.list,
    members,
    rows,
    maxPlayers: over.maxPlayers ?? 14,
    roster,
    matchMonth: 10,
    seeded: true,
    senderUserId: over.senderUserId ?? "u-joe",
    senderNames: ["Joe"],
    senderIsAdmin: over.senderIsAdmin ?? false,
  });
};
const stub = (text: string): PipelineModel & { calls: number } => {
  const m = {
    calls: 0,
    name: "stub",
    complete: async () => {
      m.calls++;
      return { text, stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 0 };
    },
  };
  return m as unknown as PipelineModel & { calls: number };
};

describe("review of #465", () => {
  it("1: a line with a member ref is never a guest: a club player not on the month is not added by somebody else", () => {
    const out = reconcile({ kind: "list", month: 10, listOf: "week", lines: [{ slot: 4, name: "Clubby", member: "p4", guest: true }] });
    expect(out.actions).toEqual([]);
    expect(out.notAdded).toEqual([{ name: "Clubby", reason: "not-in-month" }]);
    const r = parseMonthlyReading({ kind: "list", month: 10, lines: [{ slot: 4, name: "Clubby", member: "p4", guest: true }] }, input("x"), ctx);
    expect(r.kind === "list" && r.list.slots[0].facts?.guest).toBe(false);
  });

  it("2: a non-organiser's paste adds at most the open places, never more than the fixed cap; the rest are refused", () => {
    const lines = Array.from({ length: 40 }, (_, i) => ({ slot: i + 4, name: `Stranger ${i}`, member: "", guest: true }));
    const out = reconcile({ kind: "list", month: 10, listOf: "week", lines });
    const guests = out.actions.filter((a) => a.kind === "guest");
    expect(guests).toHaveLength(MAX_GUESTS_PER_PASTE);
    expect(out.guestsRefused).toHaveLength(40 - MAX_GUESTS_PER_PASTE);
    // With one open place, one.
    const tight = reconcile({ kind: "list", month: 10, listOf: "week", lines }, { maxPlayers: 4 });
    expect(tight.actions.filter((a) => a.kind === "guest")).toHaveLength(1);
    // An organiser: up to the squad size (its open places).
    const org = reconcile({ kind: "list", month: 10, listOf: "week", lines }, { senderUserId: "u-org", senderIsAdmin: true });
    expect(org.actions.filter((a) => a.kind === "guest")).toHaveLength(14 - 3);
  });

  it("refs: unknown or another club's refs are no member", () => {
    const r = parseMonthlyReading({ kind: "list", month: 10, lines: [{ slot: 1, name: "X", member: "p99" }, { slot: 2, name: "Y", member: "u-other-club" }] }, input("x"), ctx);
    expect(r.kind === "list" && r.list.slots.map((s) => s.facts?.memberId)).toEqual([null, null]);
  });

  it("failure modes: a throw, a malformed answer, a list with no lines: none", async () => {
    const boom = { name: "b", complete: async () => { throw new Error("cap"); } } as unknown as PipelineModel;
    expect((await readMonthlyMessage(input("hi"), ctx, { model: boom })).kind).toBe("none");
    expect((await readMonthlyMessage(input("hi"), ctx, { model: stub("not json {") })).kind).toBe("none");
    expect((await readMonthlyMessage(input("hi"), ctx, { model: stub('{"kind":"list","lines":[]}') })).kind).toBe("none");
  });

  it("6: no model call when the club has nothing the message could act on, or the sender is nobody of the club", async () => {
    const m = stub('{"kind":"none"}');
    expect((await readMonthlyMessage(input("lol nice goal"), { ...ctx, months: [], week: null, seedable: false }, { model: m })).kind).toBe("none");
    expect((await readMonthlyMessage({ ...input("1. Me"), sender: { userId: null, name: "x", organiser: false } }, { ...ctx, seedable: true }, { model: m })).kind).toBe("none");
    expect(m.calls).toBe(0);
  });

  it("collector numbers not on the list he was sent confirm nothing", () => {
    const now = new Date();
    const d = decideCollectorReply({ reply: { kind: "numbers", numbers: [7] }, claims: [{ userId: "a", name: "A", slot: 1, claimedAt: new Date(now.getTime() - 9e6), amountPence: 1 }] as never, digest: { at: new Date(now.getTime() - 3.6e6), userIds: ["a"] }, now });
    expect(d.kind).toBe("not-a-reply");
  });

  it("4: a message is read as the collector's answer only when it answers an open paid-claims list", () => {
    const now = new Date("2026-10-29T12:00:00Z");
    const digest = { text: "📋 2 say they have paid for November:\n1. A\n2. B", at: new Date(now.getTime() - 3.6e6) };
    const draft = "📋 I read the list you posted in the group for November: 11 players";
    // His "yes" answers the month's draft (MatchTime's newest DM to him): never the list.
    expect(answersOpenDigest({ answering: draft, digests: [digest], now })).toBe(false);
    expect(answersOpenDigest({ answering: null, digests: [digest], now })).toBe(false);
    // Answering the list itself, while it is open.
    expect(answersOpenDigest({ answering: digest.text, digests: [digest], now })).toBe(true);
    // A list past the window is not read again.
    expect(answersOpenDigest({ answering: digest.text, digests: [{ ...digest, at: new Date(now.getTime() - DIGEST_ANSWER_WINDOW_MS - 1) }], now })).toBe(false);
  });
});
