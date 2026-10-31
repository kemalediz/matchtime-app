/**
 * Free places (2026-10-16): the writes and the HQ proposal and YES, over
 * an in-memory database that applies the same WHERE the code sends.
 *
 * The money rule above all: a paid row is never relabelled and never
 * refunded; the write's own WHERE refuses it. And in HQ nothing is
 * written until an organiser says YES to MatchTime's question, which
 * names the players and the game (review of #301, items 2, 3, 5, 8).
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
  directPendingAt: Date | null;
  user: { name: string; phoneNumber: string | null };
}
interface MatchRow {
  id: string;
  date: Date;
  status: string;
  paymentLinksReleasedAt: Date | null;
}
interface Proposal {
  id: string;
  orgId: string;
  matchId: string;
  waMessageId: string;
  proposedByUserId: string;
  userIds: string[];
  undo: boolean;
  expiresAt: Date;
  resolvedAt: Date | null;
  outcome: string | null;
  resolvedByUserId: string | null;
  createdAt: Date;
}
let rows: Row[] = [];
let matches: MatchRow[] = [];
let proposals: Proposal[] = [];
let org: { paymentCollectionEnabled: boolean; paymentTrackingEnabled: boolean; paymentHolderId: string | null; language: string } = {
  paymentCollectionEnabled: true,
  paymentTrackingEnabled: false,
  paymentHolderId: "col",
  language: "en",
};
const botJobs: Array<{ kind: string; phone?: string; text: string }> = [];
const questions: Array<{ askRef: string; text: string }> = [];
const NAMES: Record<string, string> = { col: "Colin Collector" };

type W = Record<string, unknown>;
function fieldOk(v: unknown, cond: unknown): boolean {
  if (cond === null) return v === null;
  if (cond && typeof cond === "object" && !(cond instanceof Date)) {
    const c = cond as { in?: unknown[]; not?: unknown; gte?: Date; lte?: Date };
    if (c.in) return c.in.includes(v);
    if ("not" in c) return c.not === null ? v !== null : v !== c.not && v !== null;
    if (c.gte || c.lte) return (!c.gte || (v as Date) >= c.gte) && (!c.lte || (v as Date) <= c.lte);
  }
  return v === cond;
}
function matches_(r: object, where: W): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === "OR") return (cond as W[]).some((w) => matches_(r, w));
    if (k === "activity") return true;
    return fieldOk((r as W)[k], cond);
  });
}
let seq = 0;

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
    match: {
      findMany: async () => matches,
      findUnique: async ({ where }: { where: { id: string } }) => {
        const m = matches.find((x) => x.id === where.id);
        return m ? { ...m, activity: { orgId: "org", name: "Friday Night Football", org } } : null;
      },
    },
    organisation: { findUnique: async () => org },
    // The club's aliases (member-aliases.ts): none in these tests.
    userAlias: { findMany: async () => [] },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const r = rows.find((x) => x.userId === where.id);
        return r ? { name: r.user.name, phoneNumber: r.user.phoneNumber } : NAMES[where.id] ? { name: NAMES[where.id], phoneNumber: null } : null;
      },
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, name: rows.find((r) => r.userId === id)?.user.name ?? NAMES[id] ?? null })),
    },
    botJob: { create: async ({ data }: { data: { kind: string; phone?: string; text: string } }) => botJobs.push(data) },
    adminFeeProposal: {
      findUnique: async ({ where }: { where: { id?: string; waMessageId?: string } }) =>
        proposals.find((p) => (where.id ? p.id === where.id : p.waMessageId === where.waMessageId)) ?? null,
      findMany: async ({ where }: { where: W }) => proposals.filter((p) => matches_(p, where)),
      create: async ({ data }: { data: Partial<Proposal> }) => {
        const p = { id: `fp${++seq}`, resolvedAt: null, outcome: null, resolvedByUserId: null, undo: false, createdAt: new Date(), ...data } as Proposal;
        proposals.push(p);
        return p;
      },
      updateMany: async ({ where, data }: { where: W; data: Partial<Proposal> }) => {
        const hit = proposals.filter((p) => matches_(p, where));
        for (const p of hit) Object.assign(p, data);
        return { count: hit.length };
      },
    },
  },
}));
vi.mock("../admin-group-log", () => ({
  recordMatchTimeQuestion: async (a: { askRef: string; text: string }) => questions.push({ askRef: a.askRef, text: a.text }),
}));

import { answerFeeProposalYes, feeProposalsAwaiting, proposeFeeFreeInHq, unwaiveMatchFee, waiveMatchFee } from "../fee-waiver";

// Saturday 17 Oct 2026, 10:00 London. Friday's game was last night; the
// next is Tuesday (a club with two games a week).
const NOW = new Date("2026-10-17T09:00:00Z");
const FRI = new Date("2026-10-16T19:00:00Z");
const TUE = new Date("2026-10-20T19:00:00Z");

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
    directPendingAt: null,
    user: { name, phoneNumber: "+447700900001" },
    ...o,
  };
}
const rowOf = (matchId: string, userId: string) => rows.find((r) => r.matchId === matchId && r.userId === userId)!;
const dms = () => botJobs.filter((j) => j.kind === "dm");

beforeEach(() => {
  rows = [];
  proposals = [];
  botJobs.length = 0;
  questions.length = 0;
  matches = [
    { id: "fri", date: FRI, status: "COMPLETED", paymentLinksReleasedAt: new Date("2026-10-16T21:00:00Z") },
    { id: "tue", date: TUE, status: "UPCOMING", paymentLinksReleasedAt: null },
  ];
  org = { paymentCollectionEnabled: true, paymentTrackingEnabled: false, paymentHolderId: "col", language: "en" };
});

describe("waiveMatchFee", () => {
  it("waives an unpaid place and records who and why", async () => {
    rows = [att("tue", "u1", "Bilal Ahmed")];
    expect(await waiveMatchFee({ matchId: "tue", userId: "u1", byUserId: "org1", now: NOW })).toBe("waived");
    expect(rowOf("tue", "u1")).toMatchObject({ feeWaivedAt: NOW, feeWaivedReason: "organiser", feeWaivedByUserId: "org1" });
  });

  it("before the pay links went out: no message to the player (they never had a link)", async () => {
    rows = [att("tue", "u1", "Bilal Ahmed")];
    await waiveMatchFee({ matchId: "tue", userId: "u1", byUserId: "org1", now: NOW });
    expect(dms()).toHaveLength(0);
  });

  it("after the pay links went out: one short DM, EN (Kemal, decision a)", async () => {
    rows = [att("fri", "u1", "Bilal Ahmed")];
    await waiveMatchFee({ matchId: "fri", userId: "u1", byUserId: "org1", now: NOW });
    expect(dms()).toEqual([{ kind: "dm", orgId: "org", phone: "447700900001", text: "You're on a free place for Fri 16 Oct, no need to pay." }]);
    // A repeat writes nothing and sends nothing.
    expect(await waiveMatchFee({ matchId: "fri", userId: "u1", byUserId: "org1", now: NOW })).toBe("already-free");
    expect(dms()).toHaveLength(1);
  });

  it("inside the club's quiet hours the DM waits for them to end (2026-10-21); with them off it goes at once", async () => {
    rows = [att("fri", "u1", "Bilal Ahmed")];
    // Fri 16 Oct, 23:30 London (BST): held until Sat 09:00.
    await waiveMatchFee({ matchId: "fri", userId: "u1", byUserId: "org1", now: new Date("2026-10-16T22:30:00Z") });
    expect(dms()).toMatchObject([{ phone: "447700900001", sendAfter: new Date("2026-10-17T08:00:00Z") }]);

    botJobs.length = 0;
    rows = [att("fri", "u2", "Ali Kaya")];
    (org as Record<string, unknown>).quietHoursEnabled = false;
    await waiveMatchFee({ matchId: "fri", userId: "u2", byUserId: "org1", now: new Date("2026-10-16T22:30:00Z") });
    expect(dms()).toHaveLength(1);
    expect(dms()[0]).not.toHaveProperty("sendAfter");
  });

  it("the DM in Turkish for a Turkish club", async () => {
    org.language = "tr";
    rows = [att("fri", "u1", "Ali Kaya")];
    await waiveMatchFee({ matchId: "fri", userId: "u1", byUserId: "org1", now: NOW });
    expect(dms()[0].text).toBe("16 Ekim Cuma maçı için ücretsiz yerdesin, ödeme yapman gerekmiyor.");
  });

  it("never the money collector (item 8)", async () => {
    rows = [att("tue", "col", "Colin Collector")];
    expect(await waiveMatchFee({ matchId: "tue", userId: "col", byUserId: "org1", now: NOW })).toBe("collector");
    expect(rowOf("tue", "col").feeWaivedAt).toBeNull();
  });

  it("never touches a paid row (card, bank or confirmed direct): no waive, paidAt untouched", async () => {
    const paid = new Date("2026-10-16T22:00:00Z");
    rows = [att("fri", "u1", "Bilal Ahmed", { paidAt: paid, paymentMethod: "card" })];
    expect(await waiveMatchFee({ matchId: "fri", userId: "u1", byUserId: "org1", now: NOW })).toBe("already-paid");
    expect(rowOf("fri", "u1")).toMatchObject({ paidAt: paid, feeWaivedAt: null });
    expect(dms()).toHaveLength(0);
  });

  it("a monthly regular, a dropped player and a missing row are refused", async () => {
    rows = [att("tue", "m", "Monthly Mo", { paymentMethod: "monthly" }), att("tue", "d", "Dropped Dan", { status: "DROPPED" })];
    expect(await waiveMatchFee({ matchId: "tue", userId: "m", byUserId: "o", now: NOW })).toBe("monthly");
    expect(await waiveMatchFee({ matchId: "tue", userId: "d", byUserId: "o", now: NOW })).toBe("not-in-squad");
    expect(await waiveMatchFee({ matchId: "tue", userId: "x", byUserId: "o", now: NOW })).toBe("not-in-squad");
  });
});

describe("unwaiveMatchFee", () => {
  it("takes a free place back while unpaid, and is a no-op otherwise", async () => {
    rows = [att("tue", "u1", "Bilal Ahmed", { feeWaivedAt: NOW, feeWaivedReason: "organiser", feeWaivedByUserId: "o" })];
    expect(await unwaiveMatchFee({ matchId: "tue", userId: "u1" })).toBe(true);
    expect(rowOf("tue", "u1")).toMatchObject({ feeWaivedAt: null, feeWaivedReason: null, feeWaivedByUserId: null });
    expect(await unwaiveMatchFee({ matchId: "tue", userId: "u1" })).toBe(false);
  });
});

describe("HQ: MatchTime proposes, an organiser's YES applies (item 2)", () => {
  const base = { orgId: "org", lang: "en", senderUserId: "org1", messageId: "wa1", now: NOW, undo: false, dayPhrase: null };

  it("'Bilal washed the bibs, he's free this week': a question naming the game, NOTHING written yet", async () => {
    rows = [att("tue", "u1", "Bilal Ahmed"), att("fri", "u1", "Bilal Ahmed")];
    const r = await proposeFeeFreeInHq({ ...base, refs: ["Bilal"] });
    expect(r).toEqual({ outcome: "fee-free-asked", replyText: "Make Bilal Ahmed free for Tue 20 Oct? Say *@Match Time YES*." });
    expect(rowOf("tue", "u1").feeWaivedAt).toBeNull();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ matchId: "tue", userIds: ["u1"], undo: false, proposedByUserId: "org1", waMessageId: "wa1" });
    expect(questions).toEqual([{ askRef: `fee:${proposals[0].id}`, text: r.replyText }]);
  });

  it("a named day picks that game (item 3): 'last night' is Friday's", async () => {
    rows = [att("fri", "u1", "Bilal Ahmed")];
    const r = await proposeFeeFreeInHq({ ...base, refs: ["Bilal"], dayPhrase: "last night" });
    expect(r.replyText).toBe("Make Bilal Ahmed free for Fri 16 Oct? Say *@Match Time YES*.");
  });

  it("a named day with no game: says so, proposes nothing", async () => {
    rows = [att("tue", "u1", "Bilal Ahmed")];
    const r = await proposeFeeFreeInHq({ ...base, refs: ["Bilal"], dayPhrase: "Sunday" });
    expect(r).toEqual({ outcome: "hq-fee-free-none", replyText: `I can't find a game for "Sunday".` });
    expect(proposals).toHaveLength(0);
  });

  it("YES applies it, once; a second YES finds nothing", async () => {
    rows = [att("tue", "u1", "Bilal Ahmed")];
    await proposeFeeFreeInHq({ ...base, refs: ["Bilal"] });
    const yes = await answerFeeProposalYes({ orgId: "org", proposalId: proposals[0].id, userId: "org2", lang: "en", now: NOW });
    expect(yes).toEqual({ outcome: "fee-free", replyText: "Free place for Tue 20 Oct: Bilal Ahmed. No pay link and no reminders to pay." });
    expect(rowOf("tue", "u1")).toMatchObject({ feeWaivedReason: "organiser", feeWaivedByUserId: "org1" });
    expect(proposals[0]).toMatchObject({ outcome: "applied", resolvedByUserId: "org2" });
    expect(await answerFeeProposalYes({ orgId: "org", proposalId: proposals[0].id, userId: "org2", lang: "en", now: NOW })).toBeNull();
  });

  it("a YES after 30 minutes: too old, nothing written", async () => {
    rows = [att("tue", "u1", "Bilal Ahmed")];
    await proposeFeeFreeInHq({ ...base, refs: ["Bilal"] });
    const late = new Date(NOW.getTime() + 31 * 60 * 1000);
    const r = await answerFeeProposalYes({ orgId: "org", proposalId: proposals[0].id, userId: "org2", lang: "en", now: late });
    expect(r?.outcome).toBe("fee-free-expired");
    expect(rowOf("tue", "u1").feeWaivedAt).toBeNull();
  });

  it("a newer question supersedes the open one, so only one free place question waits", async () => {
    rows = [att("tue", "u1", "Bilal Ahmed"), att("tue", "u2", "Tom Third")];
    await proposeFeeFreeInHq({ ...base, refs: ["Bilal"] });
    await proposeFeeFreeInHq({ ...base, messageId: "wa2", refs: ["Tom"] });
    expect(proposals.map((p) => p.outcome)).toEqual(["superseded", null]);
    const waiting = await feeProposalsAwaiting("org", NOW, "en");
    expect(waiting.map((w) => [w.ref, w.names, w.day, w.undo])).toEqual([[`fee:${proposals[1].id}`, "Tom Third", "Tue 20 Oct", false]]);
  });

  it("a Pi retry of the same message asks the same question, no second proposal", async () => {
    rows = [att("tue", "u1", "Bilal Ahmed")];
    const a = await proposeFeeFreeInHq({ ...base, refs: ["Bilal"] });
    const b = await proposeFeeFreeInHq({ ...base, refs: ["Bilal"] });
    expect(b).toEqual(a);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].outcome).toBeNull();
  });

  it("'Bilal isn't free after all' (undo): asks, then YES takes the free place back", async () => {
    rows = [att("tue", "u1", "Bilal Ahmed", { feeWaivedAt: NOW, feeWaivedReason: "organiser" })];
    const r = await proposeFeeFreeInHq({ ...base, refs: ["Bilal"], undo: true });
    expect(r.replyText).toBe("Take the free place away from Bilal Ahmed for Tue 20 Oct? They'll be asked to pay. Say *@Match Time YES*.");
    expect(rowOf("tue", "u1").feeWaivedAt).toEqual(NOW);
    const yes = await answerFeeProposalYes({ orgId: "org", proposalId: proposals[0].id, userId: "org1", lang: "en", now: NOW });
    expect(yes?.replyText).toBe("No longer free for Tue 20 Oct: Bilal Ahmed. They'll get the usual reminders to pay.");
    expect(rowOf("tue", "u1").feeWaivedAt).toBeNull();
  });

  it("undo for someone who is not free: one line, nothing proposed", async () => {
    rows = [att("tue", "u1", "Bilal Ahmed")];
    const r = await proposeFeeFreeInHq({ ...base, refs: ["Bilal"], undo: true });
    expect(r).toEqual({ outcome: "hq-fee-free-none", replyText: "Bilal Ahmed isn't on a free place for Tue 20 Oct." });
    expect(proposals).toHaveLength(0);
  });

  it("a player who said he'd pay the collector directly: the question says so (item 5)", async () => {
    rows = [att("tue", "u1", "Bilal Ahmed", { paymentMethod: "direct", directPendingAt: NOW })];
    const r = await proposeFeeFreeInHq({ ...base, refs: ["Bilal"] });
    expect(r.replyText).toBe("Make Bilal Ahmed free for Tue 20 Oct? Bilal Ahmed said they'd pay Colin Collector directly. Say *@Match Time YES*.");
  });

  it("the collector is never offered a free place (item 8)", async () => {
    rows = [att("tue", "col", "Colin Collector"), att("tue", "u1", "Bilal Ahmed")];
    const r = await proposeFeeFreeInHq({ ...base, refs: ["Colin"] });
    expect(r).toEqual({ outcome: "hq-fee-free-none", replyText: "Colin Collector collects the money, so there's nothing to make free." });
  });

  it("already paid: left as paid, the collector pointed at a refund; others still asked about", async () => {
    rows = [att("fri", "u1", "Bilal Ahmed", { paidAt: new Date("2026-10-16T22:00:00Z") }), att("fri", "u2", "Tom Third")];
    const r = await proposeFeeFreeInHq({ ...base, refs: ["Bilal", "Tom"], dayPhrase: "Friday" });
    expect(r.replyText.split("\n")).toEqual([
      "Make Tom Third free for Fri 16 Oct? Say *@Match Time YES*.",
      "Bilal Ahmed has already paid for Fri 16 Oct, so I've left it as paid. The money collector can refund it if they should play free.",
    ]);
    expect(proposals[0].userIds).toEqual(["u2"]);
  });

  it("an unknown name and an ambiguous one get their own lines", async () => {
    rows = [att("tue", "u1", "Bilal Ahmed"), att("tue", "u2", "Sam Stone"), att("tue", "u3", "Sam Smith")];
    const r = await proposeFeeFreeInHq({ ...base, refs: ["Bilal", "Zed", "Sam"] });
    expect(r.replyText.split("\n")).toEqual([
      "Make Bilal Ahmed free for Tue 20 Oct? Say *@Match Time YES*.",
      "I can't find Zed in the squad for Tue 20 Oct.",
      "Which Sam: Sam Stone or Sam Smith?",
    ]);
  });

  it("Turkish: the question in Turkish", async () => {
    rows = [att("tue", "u1", "Ali Kaya"), att("tue", "u2", "Can Demir")];
    const r = await proposeFeeFreeInHq({ ...base, lang: "tr", refs: ["Ali", "Can"] });
    expect(r.replyText).toBe("20 Ekim Salı için Ali Kaya ve Can Demir ücretsiz olsun mu? Onaylamak için *@Match Time EVET* yazın.");
  });

  it("no names, no payments, no match: one line each, nothing proposed", async () => {
    expect((await proposeFeeFreeInHq({ ...base, refs: [] })).replyText).toBe("Who should play free? For example: Bilal is free this week.");
    org = { ...org, paymentCollectionEnabled: false, paymentTrackingEnabled: false };
    expect((await proposeFeeFreeInHq({ ...base, refs: ["Bilal"] })).outcome).toBe("hq-fee-free-none");
    org = { ...org, paymentTrackingEnabled: true };
    matches = [];
    expect(await proposeFeeFreeInHq({ ...base, refs: ["Bilal"] })).toEqual({
      outcome: "hq-fee-free-none",
      replyText: "There's no match to give a free place on right now.",
    });
    expect(proposals).toHaveLength(0);
  });
});
