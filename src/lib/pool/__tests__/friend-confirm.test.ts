/**
 * Review of #488, finding 6 (2026-11-01): a friend code from a number with
 * a profile is spent only once the booking has an answer. A booking that
 * FAILED keeps the waiting sign-up and remembers nothing, so his next code
 * message tries again; booked or a definitive no spends it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
  const tx = {
    sentNotification: { createMany: vi.fn(async () => ({ count: 1 })) },
    poolProfile: { deleteMany: vi.fn(async () => ({ count: 1 })), updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  return { tx, db: { ...tx, $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) } };
});
vi.mock("../../db", () => ({ db: dbMock.db }));
const book = vi.hoisted(() => ({ bookFriend: vi.fn() }));
vi.mock("../../friend-link/book", () => book);

import { confirmFriendWithProfile } from "../friend-confirm";

const base = {
  row: { id: "pending1", confirmCode: "K7QP2", friendLinkId: "fl1", referrerUserId: "shane" },
  userId: "ali",
  profile: { id: "p1", status: "active", pausedReason: null, pausedAt: null },
  phone: "447700900111",
  waMessageId: "wamid.1",
  now: new Date("2026-11-01T12:00:00Z"),
};

beforeEach(() => vi.clearAllMocks());

describe("confirmFriendWithProfile", () => {
  it("booked: the waiting sign-up goes and the code is remembered", async () => {
    book.bookFriend.mockResolvedValue({ booked: "in" });
    await confirmFriendWithProfile(base);
    expect(dbMock.tx.poolProfile.deleteMany).toHaveBeenCalledWith({ where: { id: "pending1", status: "pending-verify" } });
    expect(dbMock.tx.sentNotification.createMany).toHaveBeenCalledWith(expect.objectContaining({ data: [{ key: "friend-code-used:ali:K7QP2", kind: "friend-code-used" }] }));
  });
  it("a definitive no (the link used): spent the same way", async () => {
    book.bookFriend.mockResolvedValue({ booked: false, reason: "used" });
    await confirmFriendWithProfile(base);
    expect(dbMock.tx.poolProfile.deleteMany).toHaveBeenCalled();
  });
  it("the booking failed: nothing is spent, so his code still works", async () => {
    book.bookFriend.mockResolvedValue({ booked: false, reason: "failed" });
    await confirmFriendWithProfile(base);
    expect(dbMock.tx.poolProfile.deleteMany).not.toHaveBeenCalled();
    expect(dbMock.tx.sentNotification.createMany).not.toHaveBeenCalled();
  });
  it("paused for reports: not booked, told so, no reactivation", async () => {
    book.bookFriend.mockResolvedValue({ booked: false, reason: "blocked" });
    await confirmFriendWithProfile({ ...base, profile: { ...base.profile, status: "stopped", pausedReason: "reports", pausedAt: new Date() } });
    expect(dbMock.tx.poolProfile.updateMany).not.toHaveBeenCalled();
    expect(book.bookFriend).toHaveBeenCalledWith(expect.objectContaining({ blockedProfile: true, newToPool: false }));
  });
});
