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

/**
 * The match row the action reads, carrying its org's SWEEP CLOCK.
 *
 * `Organisation.lastParticipantSweepAt` is the sweep's own clock and has
 * exactly one writer (`importParticipants`). It is deliberately NOT
 * `MAX(Membership.lastSeenInGroupAt)` any more: since 2026-09-09 an
 * inbound group message also refreshes the SENDER's sighting, so that
 * MAX would be permanently fresh and would silently switch the degraded
 * mode off for everybody else. See the block comment below.
 */
function matchRow(sweepAt: Date | null) {
  return {
    id: "match-1",
    activity: {
      orgId: "org-1",
      org: { name: "Sutton FC", lastParticipantSweepAt: sweepAt },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "user-1" } });
  // Default: the participant sweep ran this morning, so the gate is on
  // its strict, undegraded path.
  matchFindUnique.mockResolvedValue(matchRow(new Date()));
  attendanceFindUnique.mockResolvedValue(null);
  attendanceCount.mockResolvedValue(0);
  analyzedMessageCount.mockResolvedValue(0);
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

    await expect(attendMatch("match-1")).resolves.toEqual({ status: "CONFIRMED", organiser: false });
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
    await expect(attendMatch("match-1")).resolves.toEqual({ status: "CONFIRMED", organiser: false });
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
 * ── DEGRADED PARTICIPANT SWEEP (2026-08-31, re-based 2026-09-09) ────────
 *
 * The sweep has been broken since 2026-07-07. When it is stale, a null
 * sighting means "we could not look", not "you are not in the group", and
 * nine real Sutton players were being blocked and told a falsehood.
 *
 * ── WHY THE FRESHNESS CLOCK MOVED OFF `Membership` (2026-09-09) ────────
 *
 * The degraded mode used to key off `MAX(Membership.lastSeenInGroupAt)`
 * across the org, which was sound while the sweep was that column's ONLY
 * writer. Adding inbound group messages as a second writer would have
 * broken it in the most dangerous way available: one chatty player's
 * "haha" refreshes his own sighting, the org's MAX goes fresh, and the
 * gate concludes the sweep is healthy. It is not. Degraded mode would
 * switch itself off for exactly the people it protects — the never-seen
 * member who does NOT post and is only vouched for by a squad row — and
 * they would go back to being told a falsehood, silently, with no banner
 * on the dashboard and no `sweep-stale` alert either.
 *
 * So the two facts are now two columns:
 *   - `Membership.lastSeenInGroupAt` — did we ever see THIS PERSON in the
 *     group. Sweep or their own message; both are proof of presence.
 *   - `Organisation.lastParticipantSweepAt` — when a full roster READ last
 *     succeeded. Only the sweep can write it, so only it can license the
 *     inference "never seen ⇒ not in the group".
 *
 * These cases pin the WIRING, and pin that split BOTH WAYS.
 */
const STALE = new Date("2026-07-07T15:08:00Z"); // the real production value

describe("attendMatch — degraded participant sweep", () => {
  const neverSeenPlayer = { leftAt: null, lastSeenInGroupAt: null, role: "PLAYER" as const };

  it("derives sweep freshness from Organisation.lastParticipantSweepAt", async () => {
    matchFindUnique.mockResolvedValue(matchRow(STALE));
    membershipFindUnique.mockResolvedValue(neverSeenPlayer);
    attendanceCount.mockResolvedValue(1);

    await attendMatch("match-1");

    // The clock is read off the org row the action already joins, so the
    // degraded path costs one query FEWER than it used to.
    expect(matchFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          activity: {
            select: {
              orgId: true,
              // benchPickMode rides along for the toast (2026-10-16).
              org: { select: { name: true, lastParticipantSweepAt: true, benchPickMode: true } },
            },
          },
        },
      }),
    );
    // And emphatically NOT off the members' own sightings.
    expect(membershipAggregate).not.toHaveBeenCalled();
  });

  it("a chatty team-mate's sighting does NOT switch degraded mode off for everyone else", async () => {
    // THE REGRESSION THIS WHOLE SPLIT EXISTS TO PREVENT.
    //
    // The world of 2026-09-09 after Signal 1 ships: the sweep is still
    // broken (org clock stuck on 07/07) but the group is chatty, so
    // plenty of Memberships now carry a sighting from TODAY. Under the
    // old `MAX(Membership.lastSeenInGroupAt)` rule the org would read as
    // healthy and this player — never swept, never posted, but put in a
    // squad by a mate — would be denied with the accusing message.
    matchFindUnique.mockResolvedValue(matchRow(STALE));
    membershipFindUnique.mockResolvedValue(neverSeenPlayer);
    attendanceCount.mockResolvedValue(1);

    await expect(attendMatch("match-1")).resolves.toEqual({ status: "CONFIRMED", organiser: false });
    expect(registerAttendance).toHaveBeenCalled();
  });

  it("a WORKING sweep still denies a never-seen player, chatty group or not", async () => {
    // The other direction. Message sightings must not be able to make a
    // stale org look fresh; they must not be able to make a FRESH org
    // look stale either. A healthy sweep that has never seen this person
    // is still the strict, pre-2026-08-31 answer.
    matchFindUnique.mockResolvedValue(matchRow(new Date()));
    membershipFindUnique.mockResolvedValue(neverSeenPlayer);
    attendanceCount.mockResolvedValue(99);
    analyzedMessageCount.mockResolvedValue(99);

    await expect(attendMatch("match-1")).rejects.toThrow(
      /You need to be in the Sutton FC WhatsApp group/,
    );
    expect(attendanceCount).not.toHaveBeenCalled();
    expect(analyzedMessageCount).not.toHaveBeenCalled();
  });

  it("ALLOWS a never-seen player who has already been in a squad for this club", async () => {
    matchFindUnique.mockResolvedValue(matchRow(STALE));
    membershipFindUnique.mockResolvedValue(neverSeenPlayer);
    attendanceCount.mockResolvedValue(2);

    await expect(attendMatch("match-1")).resolves.toEqual({ status: "CONFIRMED", organiser: false });
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
    matchFindUnique.mockResolvedValue(matchRow(STALE));
    analyzedMessageCount.mockResolvedValue(4);

    await expect(attendMatch("match-1")).resolves.toEqual({ status: "CONFIRMED", organiser: false });
    expect(analyzedMessageCount).toHaveBeenCalledWith({
      where: { orgId: "org-1", authorUserId: "user-1" },
    });
  });

  it("still DENIES a never-seen player with no evidence, and never registers", async () => {
    membershipFindUnique.mockResolvedValue(neverSeenPlayer);
    matchFindUnique.mockResolvedValue(matchRow(STALE));

    await expect(attendMatch("match-1")).rejects.toThrow(/cannot confirm your place/i);
    expect(registerAttendance).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  });

  it("the degraded denial does NOT accuse the player of being outside the group", async () => {
    membershipFindUnique.mockResolvedValue(neverSeenPlayer);
    matchFindUnique.mockResolvedValue(matchRow(STALE));

    const err = await attendMatch("match-1").catch((e: Error) => e);
    const msg = (err as Error).message;
    expect(msg).toContain("Sutton FC");
    expect(msg).not.toMatch(/You need to be in the/);
    expect(msg).toMatch(/\bIN\b/);
  });

  it("treats a club whose sweep has NEVER succeeded as degraded too", async () => {
    membershipFindUnique.mockResolvedValue(neverSeenPlayer);
    matchFindUnique.mockResolvedValue(matchRow(null));
    attendanceCount.mockResolvedValue(1);

    await expect(attendMatch("match-1")).resolves.toEqual({ status: "CONFIRMED", organiser: false });
  });

  it("DENIES a member who LEFT even when the sweep is stale, with the plain message", async () => {
    membershipFindUnique.mockResolvedValue({
      leftAt: new Date("2026-08-01T00:00:00Z"),
      lastSeenInGroupAt: null,
      role: "PLAYER",
    });
    matchFindUnique.mockResolvedValue(matchRow(STALE));
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
    matchFindUnique.mockResolvedValue(matchRow(STALE));
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

/**
 * ── RAIHAN (2026-09-09) ─────────────────────────────────────────────────
 *
 * The case that motivated Signal 1, end to end at the gate.
 *
 * Raihan was added to the Sutton FC WhatsApp group on Monday. His phone
 * is on file, so his Membership exists — but the sweep has been dead
 * since 07/07, so it carries no sighting, he had never been put in a
 * squad, and he had never been attributed a message. Every fallback the
 * degraded mode has came back zero and the app turned him away.
 *
 * The whole of Signal 1 is: he says something in the group, that
 * refreshes HIS sighting, and the ordinary `seen-in-group` path takes
 * over. Note the second test asks for NO evidence and consults NO
 * fallback — a sighting, whatever wrote it, ends the question.
 */
describe("attendMatch — Raihan: a sighting earned by posting", () => {
  it("BEFORE he posts: no sighting, no evidence, honest refusal", async () => {
    matchFindUnique.mockResolvedValue(matchRow(STALE));
    membershipFindUnique.mockResolvedValue({
      leftAt: null,
      lastSeenInGroupAt: null,
      role: "PLAYER",
    });
    attendanceCount.mockResolvedValue(0);
    analyzedMessageCount.mockResolvedValue(0);

    await expect(attendMatch("match-1")).rejects.toThrow(/cannot confirm your place/i);
    expect(registerAttendance).not.toHaveBeenCalled();
  });

  it("AFTER one group message: his sighting alone lets him mark himself in", async () => {
    // The sweep is STILL broken — this must not depend on it being fixed.
    matchFindUnique.mockResolvedValue(matchRow(STALE));
    membershipFindUnique.mockResolvedValue({
      leftAt: null,
      lastSeenInGroupAt: new Date("2026-09-09T18:40:00Z"), // written by his message
      role: "PLAYER",
    });
    attendanceCount.mockResolvedValue(0);
    analyzedMessageCount.mockResolvedValue(0);

    await expect(attendMatch("match-1")).resolves.toEqual({ status: "CONFIRMED", organiser: false });
    expect(registerAttendance).toHaveBeenCalled();
    // Not the degraded fallback — the plain `seen-in-group` allow.
    expect(attendanceCount).not.toHaveBeenCalled();
    expect(analyzedMessageCount).not.toHaveBeenCalled();
  });
});

/**
 * The action returns what the write did, so the button's toast never says
 * "You're in!" of a BENCH row (2026-10-16, the FNF "Brilliant, you're in!"
 * incident's bug class on the web path).
 */
describe("attendMatch: returns the status the write left", () => {
  beforeEach(() => {
    membershipFindUnique.mockResolvedValue({ leftAt: null, lastSeenInGroupAt: new Date(), role: "PLAYER" });
  });

  it("a BENCH in an organiser-pick club comes back as BENCH, organiser", async () => {
    matchFindUnique.mockResolvedValue({
      id: "match-1",
      activity: { orgId: "org-1", org: { name: "FNF", lastParticipantSweepAt: new Date(), benchPickMode: "organiser" } },
    });
    registerAttendance.mockResolvedValue({ status: "BENCH", position: 9, slot: 1, confirmedCount: 17, maxPlayers: 18 });
    await expect(attendMatch("match-1")).resolves.toEqual({ status: "BENCH", organiser: true });
  });

  it("a BENCH in a first-come club comes back as BENCH, not organiser", async () => {
    registerAttendance.mockResolvedValue({ status: "BENCH", position: 15, slot: 1, confirmedCount: 14, maxPlayers: 14 });
    await expect(attendMatch("match-1")).resolves.toEqual({ status: "BENCH", organiser: false });
  });
});
