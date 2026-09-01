/**
 * Wiring test for the `attendMatch` server action's group-membership
 * gate. Proves the pure `canSelfMarkIn` decision is actually enforced
 * on the app self-IN path: a non-group-member is blocked (with the
 * friendly, club-named error) and registerAttendance is NEVER called,
 * while a real group member sails through to registerAttendance.
 *
 * ALSO covers the OUT-OF-BAND group announcement (owner, 2026-08-31): a
 * player marking themselves in on the web app is invisible to the group,
 * so MatchTime posts one line there — but only when the state actually
 * changed, never for a repeat tap.
 *
 * auth / db / attendance / announce / next-cache are mocked — no live DB.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const authMock = vi.fn();
const matchFindUnique = vi.fn();
const membershipFindUnique = vi.fn();
const attendanceFindUnique = vi.fn();
const attendanceCount = vi.fn();
const membershipAggregate = vi.fn();
const analyzedMessageCount = vi.fn();
const registerAttendance = vi.fn();
const cancelAttendance = vi.fn();
const announce = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/db", () => ({
  db: {
    match: { findUnique: (...a: unknown[]) => matchFindUnique(...a) },
    membership: {
      findUnique: (...a: unknown[]) => membershipFindUnique(...a),
      aggregate: (...a: unknown[]) => membershipAggregate(...a),
    },
    attendance: {
      findUnique: (...a: unknown[]) => attendanceFindUnique(...a),
      count: (...a: unknown[]) => attendanceCount(...a),
    },
    analyzedMessage: { count: (...a: unknown[]) => analyzedMessageCount(...a) },
  },
}));
vi.mock("@/lib/out-of-band-announce", () => ({
  announceOutOfBandAttendance: (...a: unknown[]) => announce(...a),
}));
vi.mock("@/lib/attendance", () => ({
  registerAttendance: (...a: unknown[]) => registerAttendance(...a),
  cancelAttendance: (...a: unknown[]) => cancelAttendance(...a),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { attendMatch } from "@/app/actions/attendance";

const MATCH = {
  id: "match-1",
  activity: { orgId: "org-1", org: { name: "Sutton FC" } },
};

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "user-1" } });
  matchFindUnique.mockResolvedValue(MATCH);
  attendanceFindUnique.mockResolvedValue(null);
  attendanceCount.mockResolvedValue(0);
  analyzedMessageCount.mockResolvedValue(0);
  // Default: the participant sweep ran this morning, so the gate is on
  // its strict, undegraded path.
  membershipAggregate.mockResolvedValue({ _max: { lastSeenInGroupAt: new Date() } });
  registerAttendance.mockResolvedValue({
    status: "CONFIRMED",
    position: 1,
    slot: 1,
    confirmedCount: 1,
    maxPlayers: 14,
  });
  announce.mockResolvedValue({ announced: true });
});

describe("attendMatch — group-membership gate", () => {
  it("BLOCKS a non-group-member with the club-named error and does NOT register", async () => {
    // Plain player, never seen in the group sync → denied.
    membershipFindUnique.mockResolvedValue({
      leftAt: null,
      lastSeenInGroupAt: null,
      role: "PLAYER",
    });

    await expect(attendMatch("match-1")).rejects.toThrow(
      /You need to be in the Sutton FC WhatsApp group to mark yourself in/,
    );
    expect(registerAttendance).not.toHaveBeenCalled();
  });

  it("BLOCKS someone with no membership at all", async () => {
    membershipFindUnique.mockResolvedValue(null);
    await expect(attendMatch("match-1")).rejects.toThrow(/Sutton FC WhatsApp group/);
    expect(registerAttendance).not.toHaveBeenCalled();
  });

  it("ALLOWS a real group member and calls registerAttendance", async () => {
    membershipFindUnique.mockResolvedValue({
      leftAt: null,
      lastSeenInGroupAt: new Date(),
      role: "PLAYER",
    });

    await expect(attendMatch("match-1")).resolves.toBeUndefined();
    expect(registerAttendance).toHaveBeenCalledWith("user-1", "match-1", {
      event: {
        cause: "self-attendance",
        actorKind: "player",
        actorUserId: "user-1",
        sourceRef: "web:attendMatch",
      },
    });
  });

  it("ALLOWS an admin who was never seen in the group sync", async () => {
    membershipFindUnique.mockResolvedValue({
      leftAt: null,
      lastSeenInGroupAt: null,
      role: "ADMIN",
    });

    await attendMatch("match-1");
    expect(registerAttendance).toHaveBeenCalledWith("user-1", "match-1", {
      event: {
        cause: "self-attendance",
        actorKind: "player",
        actorUserId: "user-1",
        sourceRef: "web:attendMatch",
      },
    });
  });

  it("still requires authentication", async () => {
    authMock.mockResolvedValue(null);
    await expect(attendMatch("match-1")).rejects.toThrow(/Not authenticated/);
    expect(registerAttendance).not.toHaveBeenCalled();
  });
});

describe("attendMatch — out-of-band group announcement", () => {
  beforeEach(() => {
    membershipFindUnique.mockResolvedValue({
      leftAt: null,
      lastSeenInGroupAt: new Date(),
      role: "PLAYER",
    });
  });

  it("announces an app-driven IN, tagged as coming from the app", async () => {
    await attendMatch("match-1");
    expect(announce).toHaveBeenCalledWith({
      matchId: "match-1",
      userId: "user-1",
      before: null,
      after: "CONFIRMED",
      source: "app",
    });
  });

  it("passes the PRIOR status so a repeat tap is recognised as a no-op", async () => {
    // Already confirmed: registerAttendance is idempotent and returns the
    // same status, so before === after and the announcer drops it.
    attendanceFindUnique.mockResolvedValue({ status: "CONFIRMED" });
    await attendMatch("match-1");
    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({ before: "CONFIRMED", after: "CONFIRMED" }),
    );
  });

  it("reports a bench placement as BENCH, not as a confirmed slot", async () => {
    registerAttendance.mockResolvedValue({
      status: "BENCH",
      position: 15,
      slot: 1,
      confirmedCount: 14,
      maxPlayers: 14,
    });
    await attendMatch("match-1");
    expect(announce).toHaveBeenCalledWith(expect.objectContaining({ after: "BENCH" }));
  });

  it("a failing announcement never breaks the registration", async () => {
    announce.mockRejectedValue(new Error("bot job queue down"));
    await expect(attendMatch("match-1")).resolves.toBeUndefined();
    expect(registerAttendance).toHaveBeenCalled();
  });

  it("never announces when the gate blocked the registration", async () => {
    membershipFindUnique.mockResolvedValue({
      leftAt: null,
      lastSeenInGroupAt: null,
      role: "PLAYER",
    });
    await expect(attendMatch("match-1")).rejects.toThrow(/WhatsApp group/);
    expect(announce).not.toHaveBeenCalled();
  });
});

/**
 * ── DEGRADED PARTICIPANT SWEEP (2026-08-31) ─────────────────────────────
 *
 * `Membership.lastSeenInGroupAt` is written only by the bot's startup
 * participant sweep, and that sweep has been broken since 2026-07-07. When
 * it is stale, a null sighting means "we could not look", not "you are not
 * in the group", and nine real Sutton players were being blocked and told
 * a falsehood.
 *
 * These cases pin the WIRING: where the org's sweep freshness comes from,
 * which fallback evidence is queried, that the healthy path pays no extra
 * query, and that the honest message reaches the user.
 */
const STALE = new Date("2026-07-07T15:08:00Z"); // the real production value

describe("attendMatch — degraded participant sweep", () => {
  const neverSeenPlayer = { leftAt: null, lastSeenInGroupAt: null, role: "PLAYER" as const };

  it("derives sweep freshness from the org's newest lastSeenInGroupAt", async () => {
    membershipFindUnique.mockResolvedValue(neverSeenPlayer);
    membershipAggregate.mockResolvedValue({ _max: { lastSeenInGroupAt: STALE } });
    attendanceCount.mockResolvedValue(1);

    await attendMatch("match-1");

    expect(membershipAggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgId: "org-1" },
        _max: { lastSeenInGroupAt: true },
      }),
    );
  });

  it("ALLOWS a never-seen player who has already been in a squad for this club", async () => {
    membershipFindUnique.mockResolvedValue(neverSeenPlayer);
    membershipAggregate.mockResolvedValue({ _max: { lastSeenInGroupAt: STALE } });
    attendanceCount.mockResolvedValue(2);

    await expect(attendMatch("match-1")).resolves.toBeUndefined();
    expect(registerAttendance).toHaveBeenCalledWith("user-1", "match-1", {
      event: {
        cause: "self-attendance",
        actorKind: "player",
        actorUserId: "user-1",
        sourceRef: "web:attendMatch",
      },
    });
    // Evidence is scoped to THIS org's matches, not every club they play for.
    expect(attendanceCount).toHaveBeenCalledWith({
      where: { userId: "user-1", match: { activity: { orgId: "org-1" } } },
    });
  });

  it("ALLOWS a never-seen player who has posted in the club's WhatsApp group", async () => {
    membershipFindUnique.mockResolvedValue(neverSeenPlayer);
    membershipAggregate.mockResolvedValue({ _max: { lastSeenInGroupAt: STALE } });
    analyzedMessageCount.mockResolvedValue(4);

    await expect(attendMatch("match-1")).resolves.toBeUndefined();
    expect(analyzedMessageCount).toHaveBeenCalledWith({
      where: { orgId: "org-1", authorUserId: "user-1" },
    });
  });

  it("still DENIES a never-seen player with no evidence, and never registers", async () => {
    membershipFindUnique.mockResolvedValue(neverSeenPlayer);
    membershipAggregate.mockResolvedValue({ _max: { lastSeenInGroupAt: STALE } });

    await expect(attendMatch("match-1")).rejects.toThrow(/cannot confirm your place/i);
    expect(registerAttendance).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  });

  it("the degraded denial does NOT accuse the player of being outside the group", async () => {
    membershipFindUnique.mockResolvedValue(neverSeenPlayer);
    membershipAggregate.mockResolvedValue({ _max: { lastSeenInGroupAt: STALE } });

    const err = await attendMatch("match-1").catch((e: Error) => e);
    const msg = (err as Error).message;
    expect(msg).toContain("Sutton FC");
    expect(msg).not.toMatch(/You need to be in the/);
    expect(msg).toMatch(/\bIN\b/);
  });

  it("treats a club whose sweep has NEVER succeeded as degraded too", async () => {
    membershipFindUnique.mockResolvedValue(neverSeenPlayer);
    membershipAggregate.mockResolvedValue({ _max: { lastSeenInGroupAt: null } });
    attendanceCount.mockResolvedValue(1);

    await expect(attendMatch("match-1")).resolves.toBeUndefined();
  });

  it("DENIES a member who LEFT even when the sweep is stale, with the plain message", async () => {
    membershipFindUnique.mockResolvedValue({
      leftAt: new Date("2026-08-01T00:00:00Z"),
      lastSeenInGroupAt: null,
      role: "PLAYER",
    });
    membershipAggregate.mockResolvedValue({ _max: { lastSeenInGroupAt: STALE } });
    attendanceCount.mockResolvedValue(50);
    analyzedMessageCount.mockResolvedValue(50);

    await expect(attendMatch("match-1")).rejects.toThrow(
      /You need to be in the Sutton FC WhatsApp group/,
    );
    expect(registerAttendance).not.toHaveBeenCalled();
  });

  it("keeps the strict behaviour while the sweep is healthy, and asks for no evidence", async () => {
    membershipFindUnique.mockResolvedValue(neverSeenPlayer);
    attendanceCount.mockResolvedValue(99);
    analyzedMessageCount.mockResolvedValue(99);

    await expect(attendMatch("match-1")).rejects.toThrow(
      /You need to be in the Sutton FC WhatsApp group/,
    );
    expect(attendanceCount).not.toHaveBeenCalled();
    expect(analyzedMessageCount).not.toHaveBeenCalled();
  });

  it("costs the healthy, already-seen path no extra queries at all", async () => {
    membershipFindUnique.mockResolvedValue({
      leftAt: null,
      lastSeenInGroupAt: new Date(),
      role: "PLAYER",
    });

    await attendMatch("match-1");
    expect(membershipAggregate).not.toHaveBeenCalled();
    expect(attendanceCount).not.toHaveBeenCalled();
    expect(analyzedMessageCount).not.toHaveBeenCalled();
  });

  it("logs the degraded decision so a running-degraded gate is never silent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    membershipFindUnique.mockResolvedValue(neverSeenPlayer);
    membershipAggregate.mockResolvedValue({ _max: { lastSeenInGroupAt: STALE } });
    attendanceCount.mockResolvedValue(1);

    await attendMatch("match-1");

    const line = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(line).toMatch(/participant sync/i);
    expect(line).toContain("org-1");
    expect(line).toContain("degraded-plays-for-club");
    warn.mockRestore();
  });

  it("does not log anything on the healthy path", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    membershipFindUnique.mockResolvedValue({
      leftAt: null,
      lastSeenInGroupAt: new Date(),
      role: "PLAYER",
    });

    await attendMatch("match-1");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
