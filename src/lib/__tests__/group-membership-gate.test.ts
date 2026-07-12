/**
 * Unit tests for the app self-IN group-membership gate
 * (src/lib/group-membership-gate.ts).
 *
 * The gate closes a loophole: a player could mark THEMSELVES "in" from
 * the web app (matchtime.ai) on a match even if they were NOT part of
 * the org's WhatsApp group. `canSelfMarkIn` is the pure decision:
 *
 *   ALLOW when the caller's Membership for the match's org has:
 *     - leftAt == null (hasn't left / been removed), AND
 *     - lastSeenInGroupAt != null (bot confirmed them in the group's
 *       participant sync) OR role is OWNER/ADMIN (admins/owners manage
 *       the roster and are exempt from the group-sync requirement).
 *
 *   DENY otherwise — including a null membership (not a member at all).
 *
 * Only the APP self-IN path is gated. The WhatsApp bot path, guest-adds
 * from inside the group, and admin add-player all bypass this and stay
 * ungated (they call registerAttendance directly).
 *
 * Pure logic — no DB, no LLM.
 */
import { describe, it, expect } from "vitest";
import { canSelfMarkIn, type GateMembership } from "@/lib/group-membership-gate";

const seen = new Date("2026-07-01T00:00:00Z");

const m = (over: Partial<GateMembership>): GateMembership => ({
  leftAt: null,
  lastSeenInGroupAt: seen,
  role: "PLAYER",
  ...over,
});

describe("canSelfMarkIn", () => {
  it("ALLOWS a plain PLAYER seen in the group and not left", () => {
    expect(canSelfMarkIn(m({ role: "PLAYER", lastSeenInGroupAt: seen, leftAt: null }))).toBe(true);
  });

  it("DENIES a plain PLAYER never seen in the group (lastSeenInGroupAt null)", () => {
    expect(canSelfMarkIn(m({ role: "PLAYER", lastSeenInGroupAt: null }))).toBe(false);
  });

  it("ALLOWS an OWNER even if never seen in the group (admin exemption)", () => {
    expect(canSelfMarkIn(m({ role: "OWNER", lastSeenInGroupAt: null }))).toBe(true);
  });

  it("ALLOWS an ADMIN even if never seen in the group (admin exemption)", () => {
    expect(canSelfMarkIn(m({ role: "ADMIN", lastSeenInGroupAt: null }))).toBe(true);
  });

  it("DENIES a PLAYER who has LEFT the group even if previously seen", () => {
    expect(canSelfMarkIn(m({ role: "PLAYER", lastSeenInGroupAt: seen, leftAt: new Date() }))).toBe(
      false,
    );
  });

  it("DENIES an ADMIN who has LEFT the group (not in the group anymore)", () => {
    // Deliberate choice: leftAt is the strongest signal — a member who
    // left the WhatsApp group can't self-IN, and the admin exemption
    // only covers the lastSeenInGroupAt requirement, NOT a left row.
    expect(canSelfMarkIn(m({ role: "ADMIN", lastSeenInGroupAt: seen, leftAt: new Date() }))).toBe(
      false,
    );
  });

  it("DENIES an OWNER who has LEFT the group", () => {
    expect(canSelfMarkIn(m({ role: "OWNER", lastSeenInGroupAt: seen, leftAt: new Date() }))).toBe(
      false,
    );
  });

  it("DENIES when there is no membership at all (null)", () => {
    expect(canSelfMarkIn(null)).toBe(false);
  });
});
