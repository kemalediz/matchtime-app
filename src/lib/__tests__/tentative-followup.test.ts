/**
 * Unit tests for the TENTATIVE AVAILABILITY FOLLOW-UP pure core.
 *
 * Feature: a player who signals uncertain availability ("maybe, will
 * confirm later", "in if my back holds up") is recorded tentative for the
 * active match; the bot DMs them ~24h before kickoff for a firm IN/OUT.
 *
 * Pure logic — no DB, no clock except an injected `now`. Covers:
 *   - the lead-time constant (24h) and the dueAt computation, including
 *     the "<24h away → fire soon, not in the past" clamp;
 *   - the send-time guard (skip if already CONFIRMED / DROPPED / BENCH /
 *     match full / completed / cancelled; send otherwise);
 *   - the due check (one fire: not when notified or resolved).
 */
import { describe, it, expect } from "vitest";
import {
  TENTATIVE_FOLLOWUP_LEAD_MS,
  TENTATIVE_FOLLOWUP_MIN_DELAY_MS,
  computeFollowupDueAt,
  isFollowupDue,
  evaluateFollowupGuard,
} from "@/lib/tentative-followup";

const HOUR = 60 * 60 * 1000;

describe("TENTATIVE_FOLLOWUP_LEAD_MS", () => {
  it("is 24 hours", () => {
    expect(TENTATIVE_FOLLOWUP_LEAD_MS).toBe(24 * HOUR);
  });
});

describe("computeFollowupDueAt", () => {
  it("fires LEAD before kickoff when kickoff is comfortably ahead", () => {
    const now = new Date("2026-06-20T10:00:00Z");
    const kickoff = new Date("2026-06-23T19:00:00Z"); // 3 days out
    const due = computeFollowupDueAt(kickoff, now);
    expect(due.getTime()).toBe(kickoff.getTime() - TENTATIVE_FOLLOWUP_LEAD_MS);
    // sanity: exactly 24h before kickoff
    expect(kickoff.getTime() - due.getTime()).toBe(24 * HOUR);
  });

  it("clamps to soon (now + MIN_DELAY) when kickoff is already inside the lead window", () => {
    const now = new Date("2026-06-23T09:00:00Z");
    const kickoff = new Date("2026-06-23T19:00:00Z"); // only 10h out (<24h)
    const due = computeFollowupDueAt(kickoff, now);
    // kickoff − 24h would be in the past → must clamp to now + MIN_DELAY
    expect(due.getTime()).toBe(now.getTime() + TENTATIVE_FOLLOWUP_MIN_DELAY_MS);
    expect(due.getTime()).toBeGreaterThan(now.getTime());
  });

  it("never returns an instant in the past", () => {
    const now = new Date("2026-06-23T18:59:00Z");
    const kickoff = new Date("2026-06-23T19:00:00Z"); // 1 min out
    const due = computeFollowupDueAt(kickoff, now);
    expect(due.getTime()).toBeGreaterThan(now.getTime());
  });

  it("at exactly the lead boundary, fires immediately-ish (no past)", () => {
    const now = new Date("2026-06-22T19:00:00Z");
    const kickoff = new Date("2026-06-23T19:00:00Z"); // exactly 24h out
    const due = computeFollowupDueAt(kickoff, now);
    // ideal == now; soonest == now + MIN_DELAY → soonest wins
    expect(due.getTime()).toBe(now.getTime() + TENTATIVE_FOLLOWUP_MIN_DELAY_MS);
  });
});

describe("isFollowupDue", () => {
  const now = new Date("2026-06-22T19:00:00Z");

  it("is due when dueAt has passed and not notified/resolved", () => {
    expect(
      isFollowupDue({ dueAt: new Date(now.getTime() - HOUR), notifiedAt: null, resolvedAt: null }, now),
    ).toBe(true);
  });

  it("is NOT due before dueAt", () => {
    expect(
      isFollowupDue({ dueAt: new Date(now.getTime() + HOUR), notifiedAt: null, resolvedAt: null }, now),
    ).toBe(false);
  });

  it("is NOT due once notified (single fire)", () => {
    expect(
      isFollowupDue({ dueAt: new Date(now.getTime() - HOUR), notifiedAt: now, resolvedAt: null }, now),
    ).toBe(false);
  });

  it("is NOT due once resolved", () => {
    expect(
      isFollowupDue({ dueAt: new Date(now.getTime() - HOUR), notifiedAt: null, resolvedAt: now }, now),
    ).toBe(false);
  });
});

describe("evaluateFollowupGuard", () => {
  const base = { matchStatus: "UPCOMING", attendanceStatus: null, confirmedCount: 6, maxPlayers: 14 } as const;

  it("sends when the player is still unresolved and the match is open with room", () => {
    expect(evaluateFollowupGuard(base)).toBe("send");
  });

  it("skips when the player already CONFIRMED", () => {
    expect(evaluateFollowupGuard({ ...base, attendanceStatus: "CONFIRMED" })).toBe("skip");
  });

  it("skips when the player already DROPPED", () => {
    expect(evaluateFollowupGuard({ ...base, attendanceStatus: "DROPPED" })).toBe("skip");
  });

  it("skips when the player is on the BENCH", () => {
    expect(evaluateFollowupGuard({ ...base, attendanceStatus: "BENCH" })).toBe("skip");
  });

  it("skips when the match is COMPLETED", () => {
    expect(evaluateFollowupGuard({ ...base, matchStatus: "COMPLETED" })).toBe("skip");
  });

  it("skips when the match is CANCELLED", () => {
    expect(evaluateFollowupGuard({ ...base, matchStatus: "CANCELLED" })).toBe("skip");
  });

  it("skips when the squad is already full", () => {
    expect(evaluateFollowupGuard({ ...base, confirmedCount: 14, maxPlayers: 14 })).toBe("skip");
  });

  it("sends when the squad is one short of full", () => {
    expect(evaluateFollowupGuard({ ...base, confirmedCount: 13, maxPlayers: 14 })).toBe("send");
  });
});
