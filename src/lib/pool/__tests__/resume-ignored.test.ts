/**
 * The seam between L2's manage page and L5a's ignored-offers pause
 * (decision L5a.7): resume and start-again stamp `lastActiveAt`, and the
 * 3-in-a-row count only reads offers since then, so "until they say they
 * want more" holds: one ignored offer after resuming never pauses him again.
 */
import { describe, expect, it } from "vitest";
import { pausesForIgnored, type OfferLedgerEntry } from "../caps";
import { manageTransition } from "../manage-rules";

const DAY = 24 * 3600_000;
const T0 = new Date("2026-11-02T12:00:00Z");
const ignored = (days: number): OfferLedgerEntry => ({ orgId: "c", at: new Date(T0.getTime() + days * DAY), outcome: "ignored", resolvedAt: null });

describe("resume after the 3-ignored pause", () => {
  const before = [ignored(0), ignored(4), ignored(9)];

  it("three ignored pause him", () => {
    expect(pausesForIgnored(before, null)).toBe(true);
  });

  for (const action of ["resume", "restart"] as const) {
    it(`${action} stamps lastActiveAt, and the next ignored offer counts from there`, () => {
      const now = new Date(T0.getTime() + 10 * DAY);
      const profile = action === "resume" ? { status: "paused" as const, pausedReason: "ignored" as const } : { status: "stopped" as const, pausedReason: null };
      const r = manageTransition({ action, profile, now, consent: true, evidence: "req-1" });
      expect(r.ok).toBe(true);
      const since = r.ok ? r.patch.lastActiveAt ?? null : null;
      expect(since).toEqual(now);
      const after = [...before, ignored(12)];
      expect(pausesForIgnored(after, since)).toBe(false);
      expect(pausesForIgnored([...after, ignored(16), ignored(20)], since)).toBe(true);
    });
  }
});
