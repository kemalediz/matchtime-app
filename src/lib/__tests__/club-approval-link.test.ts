/**
 * Club approval, slice 6: the two writers a group add and a removal use.
 * Plan: MDs/self-join-and-approval-plan-2026-09-28.md, section 4.1.
 *
 *   draft   -> pending   MatchTime was added to a group and linked
 *   pending -> draft     MatchTime was removed while pending
 *
 * Both are compare-and-set on the status they leave, so neither can ever
 * move an APPROVED club (Sutton FC), whatever row or event names its group.
 *
 * db is mocked. No network, no model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  organisation: { updateMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import {
  DRAFT_CLUB_WHERE,
  PENDING_CLUB_WHERE,
  markClubPendingOnLink,
  returnPendingClubToDraft,
} from "../club-approval";

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.organisation.updateMany.mockResolvedValue({ count: 1 });
});

describe("the where fragments", () => {
  it("name one status each", () => {
    expect(DRAFT_CLUB_WHERE).toEqual({ approvalStatus: "draft" });
    expect(PENDING_CLUB_WHERE).toEqual({ approvalStatus: "pending" });
  });
});

describe("markClubPendingOnLink: draft -> pending", () => {
  it("moves only a DRAFT club, and never turns the bot on", async () => {
    expect(await markClubPendingOnLink("org-riverside")).toBe(true);
    expect(dbMock.organisation.updateMany).toHaveBeenCalledWith({
      where: { id: "org-riverside", approvalStatus: "draft" },
      data: { approvalStatus: "pending" },
    });
  });

  it("reports false when the club was not draft (approved Sutton FC included): nothing moved", async () => {
    dbMock.organisation.updateMany.mockResolvedValue({ count: 0 });
    expect(await markClubPendingOnLink("org-sutton")).toBe(false);
  });

  it("uses the transaction client it is handed", async () => {
    const tx = { organisation: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
    expect(await markClubPendingOnLink("org-riverside", tx as never)).toBe(true);
    expect(tx.organisation.updateMany).toHaveBeenCalledOnce();
    expect(dbMock.organisation.updateMany).not.toHaveBeenCalled();
  });
});

describe("returnPendingClubToDraft: pending -> draft", () => {
  it("moves only a PENDING club", async () => {
    expect(await returnPendingClubToDraft("org-riverside")).toBe(true);
    expect(dbMock.organisation.updateMany).toHaveBeenCalledWith({
      where: { id: "org-riverside", approvalStatus: "pending" },
      data: { approvalStatus: "draft" },
    });
  });

  it("an approved club is never touched", async () => {
    dbMock.organisation.updateMany.mockResolvedValue({ count: 0 });
    expect(await returnPendingClubToDraft("org-sutton")).toBe(false);
    const where = dbMock.organisation.updateMany.mock.calls[0][0].where;
    expect(where.approvalStatus).toBe("pending");
  });
});
