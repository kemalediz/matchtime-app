/**
 * announceOutOfBandAttendance — the DB-touching half of the group
 * announcement, with Prisma and org-features mocked.
 *
 * Asserts the behaviour the owner asked for and the guards that keep it
 * from becoming a spam source:
 *   - a DM-driven IN posts ONE group BotJob whose count comes from the
 *     post-write DB read (never a stale value, never an LLM);
 *   - an app-driven IN does the same with its own source label;
 *   - a repeat IN (no state change) posts NOTHING;
 *   - the per-hour cap suppresses the post once too many have gone out;
 *   - an attendance-off org (MoM/ratings only) is never announced to.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const matchFindUnique = vi.fn();
const userFindUnique = vi.fn();
const attendanceCount = vi.fn();
const sentCount = vi.fn();
const sentCreate = vi.fn();
const botJobCreate = vi.fn();
const getOrgFeatures = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    match: { findUnique: (...a: unknown[]) => matchFindUnique(...a) },
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
    attendance: { count: (...a: unknown[]) => attendanceCount(...a) },
    sentNotification: {
      count: (...a: unknown[]) => sentCount(...a),
      create: (...a: unknown[]) => sentCreate(...a),
    },
    botJob: { create: (...a: unknown[]) => botJobCreate(...a) },
  },
}));
vi.mock("@/lib/org-features", () => ({
  getOrgFeatures: (...a: unknown[]) => getOrgFeatures(...a),
}));

import { announceOutOfBandAttendance } from "@/lib/out-of-band-announce";
import { MAX_OUT_OF_BAND_ANNOUNCEMENTS_PER_HOUR } from "@/lib/out-of-band-attendance";

const MATCH = "match-1";
const USER = "user-1";

function groupJobText(): string {
  const call = botJobCreate.mock.calls.at(-1)?.[0] as { data: { text: string; kind: string } };
  expect(call.data.kind).toBe("group");
  return call.data.text;
}

beforeEach(() => {
  vi.clearAllMocks();
  matchFindUnique.mockResolvedValue({
    id: MATCH,
    maxPlayers: 14,
    activity: { orgId: "org-1" },
  });
  userFindUnique.mockResolvedValue({ name: "Mauricio Silva" });
  attendanceCount.mockResolvedValue(11);
  sentCount.mockResolvedValue(0);
  sentCreate.mockResolvedValue({});
  botJobCreate.mockResolvedValue({});
  getOrgFeatures.mockResolvedValue({ attendance: true });
});

describe("announceOutOfBandAttendance", () => {
  it("posts one group line for a DM-driven IN, with the post-write DB count", async () => {
    const res = await announceOutOfBandAttendance({
      matchId: MATCH,
      userId: USER,
      before: null,
      after: "CONFIRMED",
      source: "dm",
    });

    expect(res.announced).toBe(true);
    expect(botJobCreate).toHaveBeenCalledTimes(1);
    expect(groupJobText()).toBe("✅ *Mauricio Silva* is IN (replied by DM). Squad *11/14*.");
    // The count came from the DB read of CONFIRMED rows, not from a
    // caller-supplied (possibly stale) number.
    expect(attendanceCount).toHaveBeenCalledWith({
      where: { matchId: MATCH, status: "CONFIRMED" },
    });
  });

  it("labels an app-driven IN as coming from the app", async () => {
    await announceOutOfBandAttendance({
      matchId: MATCH,
      userId: USER,
      before: null,
      after: "CONFIRMED",
      source: "app",
    });
    expect(groupJobText()).toBe("✅ *Mauricio Silva* is IN (from the app). Squad *11/14*.");
  });

  it("announces a DM-driven OUT with the count after the drop", async () => {
    attendanceCount.mockResolvedValue(10);
    await announceOutOfBandAttendance({
      matchId: MATCH,
      userId: USER,
      before: "CONFIRMED",
      after: "DROPPED",
      source: "dm",
    });
    expect(groupJobText()).toBe("❌ *Mauricio Silva* is OUT (replied by DM). Squad *10/14*.");
  });

  it("posts NOTHING for a repeat IN from an already-confirmed player", async () => {
    const res = await announceOutOfBandAttendance({
      matchId: MATCH,
      userId: USER,
      before: "CONFIRMED",
      after: "CONFIRMED",
      source: "dm",
    });

    expect(res.announced).toBe(false);
    expect(res.reason).toBe("no-state-change");
    expect(botJobCreate).not.toHaveBeenCalled();
    expect(sentCreate).not.toHaveBeenCalled();
  });

  it("suppresses the post once the per-hour cap is reached", async () => {
    sentCount.mockResolvedValue(MAX_OUT_OF_BAND_ANNOUNCEMENTS_PER_HOUR);

    const res = await announceOutOfBandAttendance({
      matchId: MATCH,
      userId: USER,
      before: null,
      after: "CONFIRMED",
      source: "dm",
    });

    expect(res.announced).toBe(false);
    expect(res.reason).toBe("rate-capped");
    expect(botJobCreate).not.toHaveBeenCalled();
  });

  it("never announces for an org that does not track attendance", async () => {
    getOrgFeatures.mockResolvedValue({ attendance: false });

    const res = await announceOutOfBandAttendance({
      matchId: MATCH,
      userId: USER,
      before: null,
      after: "CONFIRMED",
      source: "dm",
    });

    expect(res.announced).toBe(false);
    expect(res.reason).toBe("attendance-off");
    expect(botJobCreate).not.toHaveBeenCalled();
  });

  it("writes a ledger row so the cap can count it, before queueing the post", async () => {
    await announceOutOfBandAttendance({
      matchId: MATCH,
      userId: USER,
      before: null,
      after: "CONFIRMED",
      source: "dm",
    });
    const ledger = sentCreate.mock.calls[0][0] as {
      data: { key: string; kind: string; matchId: string; targetUser: string };
    };
    expect(ledger.data.kind).toBe("oob-attend");
    expect(ledger.data.key).toContain("org-org-1:oob-attend:");
    expect(ledger.data.matchId).toBe(MATCH);
    expect(ledger.data.targetUser).toBe(USER);
    // Ledger row is written BEFORE the BotJob so a crash can only ever
    // lose an announcement, never emit one twice.
    expect(sentCreate.mock.invocationCallOrder[0]).toBeLessThan(
      botJobCreate.mock.invocationCallOrder[0],
    );
  });
});
