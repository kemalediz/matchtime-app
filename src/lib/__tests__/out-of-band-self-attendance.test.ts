/**
 * applyOutOfBandSelfAttendance — the shared write + ack + announce step.
 *
 * Extracted from /api/whatsapp/dm-reply (PR #18) so the 👍-on-the-invite
 * reaction lands on EXACTLY the same code path: same capacity rules, same
 * honest-ack golden rule, same group announcement. Two code paths that
 * "register a player" would drift, and the DM one is already live.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const attendanceFindUnique = vi.fn();
const botJobCreate = vi.fn();
const registerAttendance = vi.fn();
const cancelAttendance = vi.fn();
const announceOutOfBandAttendance = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    attendance: { findUnique: (...a: unknown[]) => attendanceFindUnique(...a) },
    botJob: { create: (...a: unknown[]) => botJobCreate(...a) },
  },
}));
vi.mock("@/lib/attendance", () => ({
  registerAttendance: (...a: unknown[]) => registerAttendance(...a),
  cancelAttendance: (...a: unknown[]) => cancelAttendance(...a),
}));
vi.mock("@/lib/out-of-band-announce", () => ({
  announceOutOfBandAttendance: (...a: unknown[]) => announceOutOfBandAttendance(...a),
}));

import { applyOutOfBandSelfAttendance } from "@/lib/out-of-band-self-attendance";

const BASE = {
  userId: "user-abid",
  matchId: "match-next",
  orgId: "org-1",
  matchName: "Tuesday 7-a-side",
  matchWhen: "Tue 1 Sept, 21:30",
  replyPhone: "447700900009",
  source: "reaction" as const,
};

const ackText = () =>
  (botJobCreate.mock.calls.at(-1)?.[0] as { data: { text: string; kind: string } }).data.text;

beforeEach(() => {
  vi.clearAllMocks();
  attendanceFindUnique.mockResolvedValue(null); // no prior row
  registerAttendance.mockResolvedValue({ status: "CONFIRMED" });
  cancelAttendance.mockResolvedValue({});
  botJobCreate.mockResolvedValue({});
  announceOutOfBandAttendance.mockResolvedValue({ announced: true });
});

describe("IN", () => {
  it("registers the player, DMs them a confirmation and tells the group", async () => {
    const res = await applyOutOfBandSelfAttendance({ ...BASE, decision: "in" });

    expect(res.status).toBe("CONFIRMED");
    expect(res.failed).toBe(false);
    // The player's OWN claim, so a bencher is promoted if a slot freed.
    expect(registerAttendance).toHaveBeenCalledWith("user-abid", "match-next", {
      promoteFromBench: true,
      // Named for the append-only log: their own claim, arriving by DM
      // rather than in the group. The channel is provenance, not a
      // different cause.
      event: {
        cause: "self-attendance",
        actorKind: "player",
        actorUserId: "user-abid",
        sourceRef: "dm:self-attendance",
      },
    });
    expect(botJobCreate).toHaveBeenCalledTimes(1);
    expect(ackText()).toContain("Tuesday 7-a-side");
    expect(announceOutOfBandAttendance).toHaveBeenCalledTimes(1);
    expect(announceOutOfBandAttendance).toHaveBeenCalledWith(
      expect.objectContaining({ before: null, after: "CONFIRMED", source: "reaction" }),
    );
  });

  it("respects squad capacity — a full squad goes to the BENCH, never a rollover", async () => {
    registerAttendance.mockResolvedValue({ status: "BENCH" });

    const res = await applyOutOfBandSelfAttendance({ ...BASE, decision: "in" });

    expect(res.status).toBe("BENCH");
    expect(ackText().toLowerCase()).toContain("bench");
    expect(announceOutOfBandAttendance).toHaveBeenCalledWith(
      expect.objectContaining({ after: "BENCH" }),
    );
  });

  it("is IDEMPOTENT: a repeat from an already-confirmed player announces nothing", async () => {
    attendanceFindUnique.mockResolvedValue({ status: "CONFIRMED" });

    const res = await applyOutOfBandSelfAttendance({ ...BASE, decision: "in" });

    expect(res.status).toBe("CONFIRMED");
    expect(res.announced).toBe(false);
    expect(announceOutOfBandAttendance).not.toHaveBeenCalled();
  });
});

describe("OUT", () => {
  it("drops a confirmed player and tells the group", async () => {
    attendanceFindUnique.mockResolvedValue({ status: "CONFIRMED" });

    const res = await applyOutOfBandSelfAttendance({ ...BASE, decision: "out" });

    expect(res.status).toBe("DROPPED");
    expect(cancelAttendance).toHaveBeenCalledWith("user-abid", "match-next", {
      cause: "self-attendance",
      actorKind: "player",
      actorUserId: "user-abid",
      sourceRef: "dm:self-attendance",
    });
    expect(announceOutOfBandAttendance).toHaveBeenCalledWith(
      expect.objectContaining({ before: "CONFIRMED", after: "DROPPED" }),
    );
  });

  it("does nothing when they were never down anyway", async () => {
    const res = await applyOutOfBandSelfAttendance({ ...BASE, decision: "out" });

    expect(res.status).toBeNull();
    expect(cancelAttendance).not.toHaveBeenCalled();
    expect(announceOutOfBandAttendance).not.toHaveBeenCalled();
    // Still answered — silence is what the DM gap was in the first place.
    expect(botJobCreate).toHaveBeenCalledTimes(1);
  });
});

describe("golden rule: never claim something we did not write", () => {
  it("sends an honest ack and announces NOTHING when the write throws", async () => {
    registerAttendance.mockRejectedValue(new Error("db down"));

    const res = await applyOutOfBandSelfAttendance({ ...BASE, decision: "in" });

    expect(res.failed).toBe(true);
    expect(res.status).toBeNull();
    expect(ackText().toLowerCase()).toContain("couldn't update");
    expect(announceOutOfBandAttendance).not.toHaveBeenCalled();
  });

  it("still registers and announces when there is no phone to reply to", async () => {
    const res = await applyOutOfBandSelfAttendance({
      ...BASE,
      decision: "in",
      replyPhone: null,
    });

    expect(res.status).toBe("CONFIRMED");
    expect(botJobCreate).not.toHaveBeenCalled();
    expect(announceOutOfBandAttendance).toHaveBeenCalledTimes(1);
  });

  it("a failed group announcement never fails the registration", async () => {
    announceOutOfBandAttendance.mockRejectedValue(new Error("announce boom"));

    const res = await applyOutOfBandSelfAttendance({ ...BASE, decision: "in" });

    expect(res.status).toBe("CONFIRMED");
    expect(res.failed).toBe(false);
  });
});
