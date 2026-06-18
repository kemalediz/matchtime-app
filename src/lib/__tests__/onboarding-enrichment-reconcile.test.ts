/**
 * Unit tests for the pure reconciliation helpers used by the onboarding
 * enrichment pass. No DB, no network — these are fully deterministic.
 *
 *   - buildParsedChatFromHistory: HistoryMessage[] → ParsedChat
 *   - reconcileProposals: analyser players × members → ProposedRosterEntry[]
 *   - detectUnresolvedMembers: members without a phone
 */
import { describe, it, expect } from "vitest";
import {
  buildParsedChatFromHistory,
  coerceHistoryMessages,
  reconcileProposals,
  detectUnresolvedMembers,
  type HistoryMessage,
} from "@/lib/onboarding-enrichment-reconcile";

describe("coerceHistoryMessages", () => {
  it("returns [] for non-array / nullish input", () => {
    expect(coerceHistoryMessages(null)).toEqual([]);
    expect(coerceHistoryMessages(undefined)).toEqual([]);
    expect(coerceHistoryMessages("nope")).toEqual([]);
    expect(coerceHistoryMessages({ author: "x", text: "y" })).toEqual([]);
  });

  it("keeps valid rows, preserves order, drops blank-author / blank-text / non-objects", () => {
    const out = coerceHistoryMessages([
      { author: "Coach", authorPhone: null, text: "Najib MOTM", timestamp: "t1" },
      { author: "   ", text: "blank author", timestamp: "t2" }, // dropped
      { author: "Talha", text: "   ", timestamp: "t3" }, // blank text → dropped
      null, // dropped
      42, // dropped
      { author: "Captain", text: "Squad: Najib GK", timestamp: 1700000000000 },
    ]);
    expect(out.map((m) => m.author)).toEqual(["Coach", "Captain"]);
    expect(out[0].text).toBe("Najib MOTM");
    expect(out[1].timestamp).toBe(1700000000000);
  });

  it("trims fields and normalises a present authorPhone, else null", () => {
    const out = coerceHistoryMessages([
      { author: "  Sam  ", authorPhone: " 447700900000 ", text: " GK ", timestamp: "t" },
      { author: "No Phone", authorPhone: "  ", text: "hi", timestamp: "t" },
    ]);
    expect(out[0]).toMatchObject({ author: "Sam", authorPhone: "447700900000", text: "GK" });
    expect(out[1].authorPhone).toBeNull();
  });

  it("defaults a missing/invalid timestamp to a number (now)", () => {
    const out = coerceHistoryMessages([{ author: "A", text: "b" }]);
    expect(typeof out[0].timestamp).toBe("number");
  });
});

describe("buildParsedChatFromHistory", () => {
  const history: HistoryMessage[] = [
    { author: "Kemal", text: "first", timestamp: "2026-04-22T21:30:00.000Z" },
    { author: "Najib", text: "second", timestamp: "2026-04-22T21:31:00.000Z" },
    { author: "Kemal", text: "third", timestamp: "2026-04-22T21:32:00.000Z" },
  ];

  it("preserves chronological order and ParsedMessage shape", () => {
    const chat = buildParsedChatFromHistory(history);
    expect(chat.recentMessages).toHaveLength(3);
    expect(chat.recentMessages.map((m) => m.body)).toEqual([
      "first",
      "second",
      "third",
    ]);
    const m = chat.recentMessages[0];
    expect(m.author).toBe("Kemal");
    expect(m.body).toBe("first");
    expect(m.system).toBe(false);
    expect(m.timestamp).toBeInstanceOf(Date);
    expect(m.timestamp.toISOString()).toBe("2026-04-22T21:30:00.000Z");
  });

  it("aggregates authors with counts, firstSeen and lastSeen", () => {
    const chat = buildParsedChatFromHistory(history);
    const kemal = chat.authors.find((a) => a.name === "Kemal");
    const najib = chat.authors.find((a) => a.name === "Najib");
    expect(kemal?.messageCount).toBe(2);
    expect(najib?.messageCount).toBe(1);
    expect(kemal?.firstSeen.toISOString()).toBe("2026-04-22T21:30:00.000Z");
    expect(kemal?.lastSeen.toISOString()).toBe("2026-04-22T21:32:00.000Z");
  });

  it("fills aggregate fields correctly", () => {
    const chat = buildParsedChatFromHistory(history);
    expect(chat.groupName).toBeNull();
    expect(chat.totalMessages).toBe(3);
    expect(chat.systemMessageCount).toBe(0);
    expect(chat.firstMessageAt?.toISOString()).toBe("2026-04-22T21:30:00.000Z");
    expect(chat.lastMessageAt?.toISOString()).toBe("2026-04-22T21:32:00.000Z");
  });

  it("skips blank-author and blank-text rows", () => {
    const dirty: HistoryMessage[] = [
      { author: "Kemal", text: "keep", timestamp: 1_700_000_000_000 },
      { author: "", text: "drop-author", timestamp: 1_700_000_001_000 },
      { author: "   ", text: "drop-ws-author", timestamp: 1_700_000_002_000 },
      { author: "Najib", text: "", timestamp: 1_700_000_003_000 },
      { author: "Najib", text: "   ", timestamp: 1_700_000_004_000 },
    ];
    const chat = buildParsedChatFromHistory(dirty);
    expect(chat.recentMessages).toHaveLength(1);
    expect(chat.recentMessages[0].body).toBe("keep");
    expect(chat.totalMessages).toBe(1);
    expect(chat.authors).toHaveLength(1);
  });

  it("accepts numeric and Date timestamps", () => {
    const when = new Date("2026-01-01T12:00:00.000Z");
    const chat = buildParsedChatFromHistory([
      { author: "A", text: "x", timestamp: when.getTime() },
      { author: "B", text: "y", timestamp: when },
    ]);
    expect(chat.recentMessages[0].timestamp.toISOString()).toBe(
      when.toISOString(),
    );
    expect(chat.recentMessages[1].timestamp.toISOString()).toBe(
      when.toISOString(),
    );
  });

  it("returns an empty-but-valid chat for empty input", () => {
    const chat = buildParsedChatFromHistory([]);
    expect(chat.recentMessages).toEqual([]);
    expect(chat.authors).toEqual([]);
    expect(chat.totalMessages).toBe(0);
    expect(chat.firstMessageAt).toBeNull();
    expect(chat.lastMessageAt).toBeNull();
  });
});

describe("reconcileProposals", () => {
  const members = [
    { id: "u1", name: "Kemal Ediz" },
    { id: "u2", name: "Najib" },
    { id: "u3", name: null },
  ];

  it("matches exact names", () => {
    const out = reconcileProposals(
      [{ name: "Najib", position: "GK", seedRating: 8, evidence: "saved us", confidence: 0.9 }],
      members,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      name: "Najib",
      matchedUserId: "u2",
      proposedPosition: "GK",
      proposedSeedRating: 8,
      evidence: "saved us",
      confidence: 0.9,
    });
  });

  it("matches case-insensitively and ignoring surrounding whitespace", () => {
    const out = reconcileProposals(
      [
        { name: "  najib  ", position: "GK", seedRating: 7, evidence: "e", confidence: 0.5 },
        { name: "KEMAL EDIZ", position: "FWD", seedRating: 6, evidence: "e2", confidence: 0.4 },
      ],
      members,
    );
    expect(out.find((p) => p.name === "  najib  ")?.matchedUserId).toBe("u2");
    expect(out.find((p) => p.name === "KEMAL EDIZ")?.matchedUserId).toBe("u1");
  });

  it("keeps unmatched analyser players with matchedUserId null", () => {
    const out = reconcileProposals(
      [{ name: "Stranger", position: "MID", seedRating: 5, evidence: "e", confidence: 0.2 }],
      members,
    );
    expect(out).toHaveLength(1);
    expect(out[0].matchedUserId).toBeNull();
    expect(out[0].proposedPosition).toBe("MID");
    expect(out[0].proposedSeedRating).toBe(5);
  });

  it("passes position and seedRating through, normalising null", () => {
    const out = reconcileProposals(
      [{ name: "Najib", position: null, seedRating: null, evidence: "none", confidence: 0 }],
      members,
    );
    expect(out[0].proposedPosition).toBeNull();
    expect(out[0].proposedSeedRating).toBeNull();
  });
});

describe("detectUnresolvedMembers", () => {
  it("returns only members without a phone, with userId and name", () => {
    const out = detectUnresolvedMembers([
      { id: "u1", name: "Kemal", phoneNumber: "+447111111111" },
      { id: "u2", name: "Najib", phoneNumber: null },
      { id: "u3", name: null, phoneNumber: null },
      { id: "u4", name: "Has Phone", phoneNumber: "+447222222222" },
    ]);
    expect(out).toEqual([
      { userId: "u2", name: "Najib" },
      { userId: "u3", name: null },
    ]);
  });

  it("returns empty when every member has a phone", () => {
    expect(
      detectUnresolvedMembers([
        { id: "u1", name: "A", phoneNumber: "+447111111111" },
      ]),
    ).toEqual([]);
  });
});
