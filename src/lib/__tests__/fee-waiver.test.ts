/**
 * Free places (2026-10-16): the writes and the HQ answer, over an
 * in-memory attendance table that applies the same WHERE the code sends.
 * The money rule above all: a paid row is never relabelled and never
 * refunded; the write's own WHERE refuses it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

interface Row {
  matchId: string;
  userId: string;
  status: string;
  paidAt: Date | null;
  feeWaivedAt: Date | null;
  feeWaivedReason: string | null;
  feeWaivedByUserId: string | null;
  paymentMethod: string | null;
  user: { name: string; phoneNumber: string | null };
}
let rows: Row[] = [];
let matches: Array<{ id: string; date: Date }> = [];
let org: { paymentCollectionEnabled: boolean; paymentTrackingEnabled: boolean } | null = null;

type W = Record<string, unknown>;
function fieldOk(v: unknown, cond: unknown): boolean {
  if (cond === null) return v === null;
  if (cond && typeof cond === "object" && !(cond instanceof Date)) {
    const c = cond as { in?: unknown[]; not?: unknown };
    if (c.in) return c.in.includes(v);
    if ("not" in c) return c.not === null ? v !== null : v !== c.not && v !== null;
  }
  return v === cond;
}
function matches_(r: Row, where: W): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === "OR") return (cond as W[]).some((w) => matches_(r, w));
    return fieldOk((r as unknown as W)[k], cond);
  });
}

vi.mock("../db", () => ({
  db: {
    attendance: {
      updateMany: async ({ where, data }: { where: W; data: Partial<Row> }) => {
        const hit = rows.filter((r) => matches_(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
      findUnique: async ({ where }: { where: { matchId_userId: { matchId: string; userId: string } } }) =>
        rows.find((r) => r.matchId === where.matchId_userId.matchId && r.userId === where.matchId_userId.userId) ?? null,
      findMany: async ({ where }: { where: W }) => rows.filter((r) => matches_(r, where)),
    },
    match: { findMany: async () => matches },
    organisation: { findUnique: async () => org },
  },
}));

import { answerFeeFreeInHq, unwaiveMatchFee, waiveMatchFee } from "../fee-waiver";

const NOW = new Date("2026-10-17T10:00:00Z"); // Saturday, the morning after
const FRI = new Date("2026-10-16T20:00:00Z");
const NEXT = new Date("2026-10-23T20:00:00Z");

function att(matchId: string, userId: string, name: string, o: Partial<Row> = {}): Row {
  return {
    matchId,
    userId,
    status: "CONFIRMED",
    paidAt: null,
    feeWaivedAt: null,
    feeWaivedReason: null,
    feeWaivedByUserId: null,
    paymentMethod: null,
    user: { name, phoneNumber: "+447700900001" },
    ...o,
  };
}
const rowOf = (matchId: string, userId: string) => rows.find((r) => r.matchId === matchId && r.userId === userId)!;

beforeEach(() => {
  rows = [];
  matches = [{ id: "fri", date: FRI }, { id: "next", date: NEXT }];
  org = { paymentCollectionEnabled: true, paymentTrackingEnabled: false };
});

describe("waiveMatchFee", () => {
  it("waives an unpaid place and records who and why", async () => {
    rows = [att("fri", "u1", "Bilal Ahmed")];
    expect(await waiveMatchFee({ matchId: "fri", userId: "u1", byUserId: "org1", now: NOW })).toBe("waived");
    expect(rowOf("fri", "u1")).toMatchObject({ feeWaivedAt: NOW, feeWaivedReason: "organiser", feeWaivedByUserId: "org1" });
  });

  it("is idempotent: the second call writes nothing and says already free", async () => {
    rows = [att("fri", "u1", "Bilal Ahmed")];
    await waiveMatchFee({ matchId: "fri", userId: "u1", byUserId: "org1", now: NOW });
    const later = new Date(NOW.getTime() + 60_000);
    expect(await waiveMatchFee({ matchId: "fri", userId: "u1", byUserId: "org2", now: later })).toBe("already-free");
    expect(rowOf("fri", "u1")).toMatchObject({ feeWaivedAt: NOW, feeWaivedByUserId: "org1" });
  });

  it("never touches a paid row (card, bank or confirmed direct): no waive, paidAt untouched", async () => {
    const paid = new Date("2026-10-16T22:00:00Z");
    rows = [att("fri", "u1", "Bilal Ahmed", { paidAt: paid, paymentMethod: "card" })];
    expect(await waiveMatchFee({ matchId: "fri", userId: "u1", byUserId: "org1", now: NOW })).toBe("already-paid");
    expect(rowOf("fri", "u1")).toMatchObject({ paidAt: paid, feeWaivedAt: null });
  });

  it("a monthly regular, a dropped player and a missing row are refused", async () => {
    rows = [att("fri", "m", "Monthly Mo", { paymentMethod: "monthly" }), att("fri", "d", "Dropped Dan", { status: "DROPPED" })];
    expect(await waiveMatchFee({ matchId: "fri", userId: "m", byUserId: "o", now: NOW })).toBe("monthly");
    expect(await waiveMatchFee({ matchId: "fri", userId: "d", byUserId: "o", now: NOW })).toBe("not-in-squad");
    expect(await waiveMatchFee({ matchId: "fri", userId: "x", byUserId: "o", now: NOW })).toBe("not-in-squad");
  });

  it("a player who chose to pay the collector directly can still be made free", async () => {
    rows = [att("fri", "u1", "Bilal Ahmed", { paymentMethod: "direct" })];
    expect(await waiveMatchFee({ matchId: "fri", userId: "u1", byUserId: "o", now: NOW })).toBe("waived");
  });
});

describe("unwaiveMatchFee", () => {
  it("takes a free place back while unpaid, and is a no-op otherwise", async () => {
    rows = [att("fri", "u1", "Bilal Ahmed", { feeWaivedAt: NOW, feeWaivedReason: "organiser", feeWaivedByUserId: "o" })];
    expect(await unwaiveMatchFee({ matchId: "fri", userId: "u1" })).toBe(true);
    expect(rowOf("fri", "u1")).toMatchObject({ feeWaivedAt: null, feeWaivedReason: null, feeWaivedByUserId: null });
    expect(await unwaiveMatchFee({ matchId: "fri", userId: "u1" })).toBe(false);
  });
});

describe("answerFeeFreeInHq", () => {
  const base = { orgId: "org", senderUserId: "org1", messageId: "wa1", now: NOW };

  it("'Bilal washed the bibs, he's free this week' the morning after: the game just played, named in the reply", async () => {
    rows = [att("fri", "u1", "Bilal Ahmed"), att("fri", "u2", "Tom Third"), att("next", "u1", "Bilal Ahmed")];
    const r = await answerFeeFreeInHq({ ...base, lang: "en", refs: ["Bilal"] });
    expect(r.outcome).toBe("fee-free");
    expect(r.replyText).toBe("Free place for Fri 16 Oct: Bilal Ahmed. No pay link and no reminders to pay.");
    expect(rowOf("fri", "u1").feeWaivedAt).toEqual(NOW);
    expect(rowOf("next", "u1").feeWaivedAt).toBeNull();
    expect(rowOf("fri", "u2").feeWaivedAt).toBeNull();
  });

  it("midweek: the next game, in Turkish", async () => {
    const wed = new Date("2026-10-21T10:00:00Z");
    rows = [att("next", "u1", "Ali Kaya"), att("next", "u2", "Can Demir")];
    const r = await answerFeeFreeInHq({ ...base, now: wed, lang: "tr", refs: ["Ali", "Can"] });
    expect(r.outcome).toBe("fee-free");
    expect(r.replyText).toContain("için ücretsiz yer: Ali Kaya ve Can Demir.");
  });

  it("a repeat (Pi retry) answers already free and changes nothing", async () => {
    rows = [att("fri", "u1", "Bilal Ahmed")];
    await answerFeeFreeInHq({ ...base, lang: "en", refs: ["Bilal"] });
    const r = await answerFeeFreeInHq({ ...base, lang: "en", refs: ["Bilal"] });
    expect(r.outcome).toBe("fee-free");
    expect(r.replyText).toBe("Already a free place for Fri 16 Oct: Bilal Ahmed.");
  });

  it("already paid: left as paid, the collector is pointed at a refund, nothing done", async () => {
    const paid = new Date("2026-10-16T22:00:00Z");
    rows = [att("fri", "u1", "Bilal Ahmed", { paidAt: paid })];
    const r = await answerFeeFreeInHq({ ...base, lang: "en", refs: ["Bilal"] });
    expect(r.outcome).toBe("hq-fee-free-none");
    expect(r.replyText).toContain("Bilal Ahmed has already paid for Fri 16 Oct, so I've left it as paid.");
    expect(rowOf("fri", "u1")).toMatchObject({ paidAt: paid, feeWaivedAt: null });
  });

  it("an unknown name and an ambiguous one get their own lines; the rest is still done", async () => {
    rows = [att("fri", "u1", "Bilal Ahmed"), att("fri", "u2", "Sam Stone"), att("fri", "u3", "Sam Smith")];
    const r = await answerFeeFreeInHq({ ...base, lang: "en", refs: ["Bilal", "Zed", "Sam"] });
    expect(r.outcome).toBe("fee-free");
    expect(r.replyText.split("\n")).toEqual([
      "Free place for Fri 16 Oct: Bilal Ahmed. No pay link and no reminders to pay.",
      "I can't find Zed in the squad for Fri 16 Oct.",
      "Which Sam: Sam Stone or Sam Smith?",
    ]);
  });

  it("no names, no payments, no match: one line each, nothing done", async () => {
    expect((await answerFeeFreeInHq({ ...base, lang: "en", refs: [] })).replyText).toBe(
      "Who should play free? For example: Bilal is free this week.",
    );
    org = { paymentCollectionEnabled: false, paymentTrackingEnabled: false };
    expect((await answerFeeFreeInHq({ ...base, lang: "en", refs: ["Bilal"] })).outcome).toBe("hq-fee-free-none");
    org = { paymentCollectionEnabled: false, paymentTrackingEnabled: true };
    matches = [];
    const r = await answerFeeFreeInHq({ ...base, lang: "en", refs: ["Bilal"] });
    expect(r).toEqual({ outcome: "hq-fee-free-none", replyText: "There's no match to give a free place on right now." });
  });
});
