/**
 * A SCHEDULED POST IN HQ THAT ASKS THE ORGANISERS SOMETHING (local player
 * pool L10): the short-squad notice's pool line. The scheduler emits it as
 * an instruction; once the due-posts route has CLAIMED it (it is really
 * going out) it is logged as MatchTime's question, so a YES next, or one
 * quoting it, is about it. A release (the Pi did not send it) takes it
 * back; the ack stamps its stanza id. Database mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  adminGroupMessage: { upsert: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn() },
  sentNotification: { findUnique: vi.fn() },
  botJob: { findUnique: vi.fn() },
}));
vi.mock("../db", () => ({ db: dbMock }));

import { forgetScheduledHqQuestion, recordScheduledHqQuestion, scheduledHqQuestionId } from "../admin-group-log";
import { stampHqLogStanza } from "../hq-log-stanza";

const NOW = new Date("2026-10-27T15:30:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.adminGroupMessage.upsert.mockResolvedValue({});
  dbMock.adminGroupMessage.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.adminGroupMessage.updateMany.mockResolvedValue({ count: 1 });
});

describe("recording it", () => {
  it("one row per instruction key, MatchTime's, with the ask ref: a re-claim never doubles it", async () => {
    await recordScheduledHqQuestion({ orgId: "o1", key: "m1:chase-pre-kickoff", askRef: "pool-ask:m1", text: "📋 6 of 7", now: NOW });
    expect(dbMock.adminGroupMessage.upsert).toHaveBeenCalledWith({
      where: { waMessageId: scheduledHqQuestionId("m1:chase-pre-kickoff") },
      create: { orgId: "o1", waMessageId: "mt:sched:m1:chase-pre-kickoff", fromMatchTime: true, text: "📋 6 of 7", askRef: "pool-ask:m1", createdAt: NOW },
      update: {},
    });
  });

  it("never throws", async () => {
    dbMock.adminGroupMessage.upsert.mockRejectedValue(new Error("down"));
    await expect(recordScheduledHqQuestion({ orgId: "o1", key: "k", askRef: "pool-ask:m1", text: "x", now: NOW })).resolves.toBeUndefined();
  });

  it("a release takes it back, only while unsent (no stanza yet)", async () => {
    await forgetScheduledHqQuestion("m1:chase-pre-kickoff");
    expect(dbMock.adminGroupMessage.deleteMany).toHaveBeenCalledWith({ where: { waMessageId: "mt:sched:m1:chase-pre-kickoff", waStanzaId: null } });
  });
});

describe("the ack", () => {
  it("stamps the stanza id on the scheduled post's row, by its key", async () => {
    expect(await stampHqLogStanza("m1:chase-pre-kickoff", "3EB0ABC")).toBe(1);
    expect(dbMock.adminGroupMessage.updateMany).toHaveBeenCalledWith({
      where: { waMessageId: "mt:sched:m1:chase-pre-kickoff", waStanzaId: null },
      data: { waStanzaId: "3EB0ABC" },
    });
  });
});
