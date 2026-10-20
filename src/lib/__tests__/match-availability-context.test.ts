/**
 * The availability facts loader is TOTAL (review of #336): a failed read
 * of the player's status or chat context must never drop the reply. The
 * classifier still runs, told the time now and that nothing is known.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const dbMock = vi.hoisted(() => ({
  attendance: { findUnique: vi.fn() },
  tentativeAvailability: { findFirst: vi.fn() },
  sentNotification: { findMany: vi.fn() },
  botJob: { findMany: vi.fn() },
  match: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("../db", () => ({ db: dbMock }));

import { loadMatchAvailabilityFacts } from "../match-availability-context";

beforeEach(() => {
  vi.resetAllMocks();
  dbMock.attendance.findUnique.mockResolvedValue({ status: "CONFIRMED" });
  dbMock.tentativeAvailability.findFirst.mockResolvedValue(null);
  dbMock.sentNotification.findMany.mockResolvedValue([]);
  dbMock.botJob.findMany.mockResolvedValue([]);
  dbMock.match.findMany.mockResolvedValue([]);
});

describe("loadMatchAvailabilityFacts", () => {
  it("the happy path: status and the chat context", async () => {
    const f = await loadMatchAvailabilityFacts({ userId: "u", matchId: "m", phone: "447700900003", quoted: null });
    expect(f.currentStatus).toBe("in the squad");
    expect(f.replyContext?.recent).toEqual([]);
  });

  it("a failed status read degrades to not known; the reply is still classified", async () => {
    dbMock.attendance.findUnique.mockRejectedValue(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await loadMatchAvailabilityFacts({ userId: "u", matchId: "m", phone: "447700900003", quoted: null });
    expect(f).toMatchObject({ userId: "u", matchId: "m", currentStatus: null });
    expect(f.replyContext?.quoted).toBeNull();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("a failed chat-context read degrades to nothing known, status kept", async () => {
    dbMock.botJob.findMany.mockRejectedValue(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await loadMatchAvailabilityFacts({ userId: "u", matchId: "m", phone: "447700900003", quoted: null });
    expect(f.currentStatus).toBe("in the squad");
    expect(f.replyContext?.recent).toEqual([]);
    err.mockRestore();
  });
});
