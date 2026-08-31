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
import {
  canSelfMarkIn,
  decideSelfMarkIn,
  isGroupSyncStale,
  groupSyncStaleDays,
  groupSyncAdminWarning,
  selfMarkInDenialMessage,
  GROUP_SYNC_FRESHNESS_DAYS,
  type GateMembership,
  type GroupPresenceEvidence,
  type SelfMarkInContext,
} from "@/lib/group-membership-gate";

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

/**
 * ── DEGRADED-SYNC BEHAVIOUR (2026-08-31) ────────────────────────────────
 *
 * `lastSeenInGroupAt` is written by exactly one thing: the bot's startup
 * participant sweep. That sweep has been failing since 2026-07-07 because
 * whatsapp-web.js's injected page code is out of step with WhatsApp Web.
 * While it is down the column is frozen, so "I have never seen you in the
 * group" stops meaning "you are not in the group" and starts meaning
 * "I have not been able to look".
 *
 * The gate itself is right. Treating a STALE signal as proof of absence is
 * what is wrong. These cases pin the degraded behaviour:
 *   - healthy sync   → exactly as before, no weakening
 *   - stale sync     → a null sighting alone is no longer enough to deny;
 *                      we fall back to positive evidence of group presence
 *   - no evidence    → still deny, but say something TRUE
 *   - leftAt         → deny in every combination, stale or not
 */
const HEALTHY_SYNC = { lastSyncAt: new Date("2026-08-30T09:00:00Z"), now: new Date("2026-08-31T09:00:00Z") };
const STALE_SYNC = { lastSyncAt: new Date("2026-07-07T15:08:00Z"), now: new Date("2026-08-31T09:00:00Z") };
const NO_EVIDENCE = { authoredGroupMessages: 0, clubAttendances: 0 };

const ctx = (
  sync: typeof HEALTHY_SYNC,
  evidence: Partial<GroupPresenceEvidence> = {},
): SelfMarkInContext => ({ sync, evidence: { ...NO_EVIDENCE, ...evidence } });

describe("isGroupSyncStale", () => {
  it("is FRESH when the last successful sweep is inside the freshness window", () => {
    expect(isGroupSyncStale(HEALTHY_SYNC)).toBe(false);
  });

  it("is FRESH right up to the freshness boundary", () => {
    const now = new Date("2026-08-31T09:00:00Z");
    const justInside = new Date(now.getTime() - (GROUP_SYNC_FRESHNESS_DAYS * 24 - 1) * 3600_000);
    expect(isGroupSyncStale({ lastSyncAt: justInside, now })).toBe(false);
  });

  it("is STALE once past the freshness window", () => {
    const now = new Date("2026-08-31T09:00:00Z");
    const justOutside = new Date(now.getTime() - (GROUP_SYNC_FRESHNESS_DAYS * 24 + 1) * 3600_000);
    expect(isGroupSyncStale({ lastSyncAt: justOutside, now })).toBe(true);
  });

  it("is STALE for the real production gap (last sweep 2026-07-07)", () => {
    expect(isGroupSyncStale(STALE_SYNC)).toBe(true);
  });

  it("treats a never-synced org as STALE, not as healthy", () => {
    // No sweep has EVER succeeded here, so a null sighting carries even
    // less information than an old one. Must not be read as "healthy".
    expect(isGroupSyncStale({ lastSyncAt: null, now: new Date() })).toBe(true);
  });

  it("reports how many whole days stale the sweep is (null when fresh)", () => {
    expect(groupSyncStaleDays(HEALTHY_SYNC)).toBeNull();
    expect(groupSyncStaleDays(STALE_SYNC)).toBe(54);
    expect(groupSyncStaleDays({ lastSyncAt: null, now: new Date() })).toBe(Infinity);
  });
});

describe("canSelfMarkIn — HEALTHY sync (unchanged protection)", () => {
  it("ALLOWS a PLAYER seen in the group", () => {
    expect(canSelfMarkIn(m({ role: "PLAYER", lastSeenInGroupAt: seen }), ctx(HEALTHY_SYNC))).toBe(
      true,
    );
  });

  it("DENIES a PLAYER never seen, even with plenty of club history", () => {
    // The signal is trustworthy, so a null sighting really does mean
    // "not in the group". Evidence must NOT rescue them here.
    expect(
      canSelfMarkIn(
        m({ role: "PLAYER", lastSeenInGroupAt: null }),
        ctx(HEALTHY_SYNC, { authoredGroupMessages: 40, clubAttendances: 20 }),
      ),
    ).toBe(false);
  });

  it("keeps the original message: they really are not in the group", () => {
    const d = decideSelfMarkIn(m({ role: "PLAYER", lastSeenInGroupAt: null }), ctx(HEALTHY_SYNC));
    expect(d.allowed).toBe(false);
    expect(d.degraded).toBe(false);
    expect(selfMarkInDenialMessage(d.reason, "Sutton FC")).toBe(
      "You need to be in the Sutton FC WhatsApp group to mark yourself in. Ask a member to add you in the group.",
    );
  });
});

describe("canSelfMarkIn — STALE sync (degrade safely)", () => {
  it("ALLOWS a never-seen PLAYER who has posted in the club's WhatsApp group", () => {
    // Only a participant can post in the monitored group, so an authored
    // message is direct proof of presence and needs no sweep.
    expect(
      canSelfMarkIn(
        m({ role: "PLAYER", lastSeenInGroupAt: null }),
        ctx(STALE_SYNC, { authoredGroupMessages: 1 }),
      ),
    ).toBe(true);
  });

  it("ALLOWS a never-seen PLAYER who has already been in a squad for this club", () => {
    // Every one of those Attendance rows was written by the bot reading
    // the group, by an admin, or by a member's guest-add. Someone in the
    // group put them down.
    expect(
      canSelfMarkIn(
        m({ role: "PLAYER", lastSeenInGroupAt: null }),
        ctx(STALE_SYNC, { clubAttendances: 1 }),
      ),
    ).toBe(true);
  });

  it("still ALLOWS a never-seen PLAYER who WAS seen before the sweep broke", () => {
    expect(canSelfMarkIn(m({ role: "PLAYER", lastSeenInGroupAt: seen }), ctx(STALE_SYNC))).toBe(
      true,
    );
  });

  it("DENIES a never-seen PLAYER with no evidence at all", () => {
    // Never allow everyone: no sighting, no message, no squad history.
    expect(
      canSelfMarkIn(m({ role: "PLAYER", lastSeenInGroupAt: null }), ctx(STALE_SYNC)),
    ).toBe(false);
  });

  it("flags the degraded denial so it can be logged and surfaced", () => {
    const d = decideSelfMarkIn(m({ role: "PLAYER", lastSeenInGroupAt: null }), ctx(STALE_SYNC));
    expect(d).toEqual({ allowed: false, reason: "degraded-no-evidence", degraded: true });
  });

  it("flags a degraded ALLOW as degraded too", () => {
    const d = decideSelfMarkIn(
      m({ role: "PLAYER", lastSeenInGroupAt: null }),
      ctx(STALE_SYNC, { clubAttendances: 3 }),
    );
    expect(d.allowed).toBe(true);
    expect(d.degraded).toBe(true);
  });

  it("does not mark a normal healthy-path allow as degraded", () => {
    expect(decideSelfMarkIn(m({ role: "PLAYER" }), ctx(HEALTHY_SYNC)).degraded).toBe(false);
  });
});

describe("selfMarkInDenialMessage — never assert a falsehood", () => {
  const msg = selfMarkInDenialMessage("degraded-no-evidence", "Sutton FC");

  it("does NOT tell the player they are absent from the group", () => {
    expect(msg).not.toMatch(/You need to be in the/i);
    expect(msg).not.toMatch(/not (a member|in) the/i);
  });

  it("names the club and points at the thing that always works: replying IN", () => {
    expect(msg).toContain("Sutton FC");
    expect(msg).toMatch(/\bIN\b/);
  });

  it("says WHY we cannot confirm, rather than blaming the player", () => {
    expect(msg).toMatch(/cannot confirm|can't confirm/i);
  });

  it("follows house style: no em dashes and no slashes", () => {
    expect(msg).not.toContain("—");
    expect(msg).not.toContain("–");
    expect(msg).not.toContain("/");
  });

  it("keeps the healthy-path wording byte-for-byte", () => {
    expect(selfMarkInDenialMessage("not-in-group", "Sutton FC")).toBe(
      "You need to be in the Sutton FC WhatsApp group to mark yourself in. Ask a member to add you in the group.",
    );
    expect(selfMarkInDenialMessage("no-membership", "Sutton FC")).toBe(
      selfMarkInDenialMessage("not-in-group", "Sutton FC"),
    );
    expect(selfMarkInDenialMessage("left-group", "Sutton FC")).toBe(
      selfMarkInDenialMessage("not-in-group", "Sutton FC"),
    );
  });
});

describe("canSelfMarkIn — leftAt always wins", () => {
  const combos: Array<[string, Parameters<typeof m>[0], SelfMarkInContext]> = [
    ["PLAYER, healthy, seen", { role: "PLAYER", lastSeenInGroupAt: seen }, ctx(HEALTHY_SYNC)],
    ["PLAYER, stale, seen", { role: "PLAYER", lastSeenInGroupAt: seen }, ctx(STALE_SYNC)],
    [
      "PLAYER, stale, loads of evidence",
      { role: "PLAYER", lastSeenInGroupAt: null },
      ctx(STALE_SYNC, { authoredGroupMessages: 99, clubAttendances: 99 }),
    ],
    ["ADMIN, healthy", { role: "ADMIN", lastSeenInGroupAt: null }, ctx(HEALTHY_SYNC)],
    ["ADMIN, stale", { role: "ADMIN", lastSeenInGroupAt: null }, ctx(STALE_SYNC)],
    ["OWNER, stale", { role: "OWNER", lastSeenInGroupAt: seen }, ctx(STALE_SYNC)],
  ];

  for (const [label, over, c] of combos) {
    it(`DENIES a member who LEFT the group (${label})`, () => {
      expect(canSelfMarkIn(m({ ...over, leftAt: new Date("2026-08-01T00:00:00Z") }), c)).toBe(false);
      expect(decideSelfMarkIn(m({ ...over, leftAt: new Date() }), c).reason).toBe("left-group");
    });
  }
});

describe("canSelfMarkIn — OWNER/ADMIN exemption survives", () => {
  it("ALLOWS an ADMIN never seen in the group, healthy sync", () => {
    expect(canSelfMarkIn(m({ role: "ADMIN", lastSeenInGroupAt: null }), ctx(HEALTHY_SYNC))).toBe(
      true,
    );
  });

  it("ALLOWS an OWNER never seen in the group, stale sync, zero evidence", () => {
    expect(canSelfMarkIn(m({ role: "OWNER", lastSeenInGroupAt: null }), ctx(STALE_SYNC))).toBe(true);
  });

  it("does not label the admin exemption as a degraded decision", () => {
    expect(
      decideSelfMarkIn(m({ role: "ADMIN", lastSeenInGroupAt: null }), ctx(STALE_SYNC)),
    ).toEqual({ allowed: true, reason: "admin", degraded: false });
  });
});

describe("canSelfMarkIn — no membership", () => {
  it("DENIES a null membership even when the sync is stale", () => {
    expect(canSelfMarkIn(null, ctx(STALE_SYNC, { clubAttendances: 10 }))).toBe(false);
    expect(decideSelfMarkIn(null, ctx(STALE_SYNC)).reason).toBe("no-membership");
  });
});

describe("canSelfMarkIn — omitted context stays strict", () => {
  it("assumes a HEALTHY sync when no context is supplied", () => {
    // Callers that have not been taught about staleness must not get the
    // relaxed path by accident.
    expect(canSelfMarkIn(m({ role: "PLAYER", lastSeenInGroupAt: null }))).toBe(false);
    expect(decideSelfMarkIn(m({ role: "PLAYER", lastSeenInGroupAt: null })).degraded).toBe(false);
  });
});

/**
 * Admin-facing warning. A gate running degraded must not be invisible: the
 * server logs it on every degraded decision, and the admin player list
 * carries a banner so an owner can see WHY a regular is being turned away
 * and act (reply IN in the group, or fix the bot).
 */
describe("groupSyncAdminWarning", () => {
  it("says nothing while the sweep is healthy", () => {
    expect(groupSyncAdminWarning(HEALTHY_SYNC)).toBeNull();
  });

  it("names the age of the outage and what it costs", () => {
    const w = groupSyncAdminWarning(STALE_SYNC);
    expect(w).not.toBeNull();
    expect(w).toContain("54 days");
    expect(w).toMatch(/mark themselves in|self/i);
  });

  it("has a distinct line for a club that has never synced", () => {
    const w = groupSyncAdminWarning({ lastSyncAt: null, now: new Date() });
    expect(w).not.toBeNull();
    expect(w).not.toContain("Infinity");
    expect(w).toMatch(/never/i);
  });

  it("follows house style: no em dashes and no slashes", () => {
    for (const w of [groupSyncAdminWarning(STALE_SYNC), groupSyncAdminWarning({ lastSyncAt: null, now: new Date() })]) {
      expect(w).not.toContain("—");
      expect(w).not.toContain("–");
      expect(w).not.toContain("/");
    }
  });
});
