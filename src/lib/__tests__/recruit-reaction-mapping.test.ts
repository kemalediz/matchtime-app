/**
 * Mapping a 👍 back to the right player and the right match.
 *
 * The chain, all on existing tables (no migration):
 *
 *   reaction.waMessageId
 *     → SentNotification{kind:"dm", waMessageId}  (stamped by /ack)
 *     → key `botjob-<botJobId>`
 *     → SentNotification{key:`recruit-dm-job:<botJobId>`}  (written by the
 *       recruit blast, carries matchId + targetUser)
 *     → BotJob{id}  (orgId + the phone we actually DMed)
 *
 * Anything that breaks the chain resolves to null, and the caller ignores
 * the reaction rather than guessing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sentFindFirst = vi.fn();
const sentFindUnique = vi.fn();
const botJobFindUnique = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    sentNotification: {
      findFirst: (...a: unknown[]) => sentFindFirst(...a),
      findUnique: (...a: unknown[]) => sentFindUnique(...a),
    },
    botJob: { findUnique: (...a: unknown[]) => botJobFindUnique(...a) },
  },
}));

import { resolveRecruitDmReaction } from "@/lib/recruit-reaction";

const WA = "true_447700900009@c.us_3EB0ABC";

beforeEach(() => {
  vi.clearAllMocks();
  sentFindFirst.mockResolvedValue({ key: "botjob-job-1" });
  sentFindUnique.mockResolvedValue({ matchId: "match-next", targetUser: "user-abid" });
  botJobFindUnique.mockResolvedValue({ orgId: "org-1", phone: "447700900009", kind: "dm" });
});

describe("resolveRecruitDmReaction", () => {
  it("resolves the invite DM to its match, player, org and phone", async () => {
    const res = await resolveRecruitDmReaction(WA);
    expect(res).toEqual({
      matchId: "match-next",
      userId: "user-abid",
      orgId: "org-1",
      phone: "447700900009",
    });
    // Looked the reaction up by the id the ACK stamped, scoped to DM sends.
    expect(sentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ waMessageId: WA }) }),
    );
    // And joined via the link key, not by guessing from the phone.
    expect(sentFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: "recruit-dm-job:job-1" } }),
    );
  });

  it("is null when no dispatched message carries that id (the common case)", async () => {
    sentFindFirst.mockResolvedValue(null);
    expect(await resolveRecruitDmReaction(WA)).toBeNull();
    expect(sentFindUnique).not.toHaveBeenCalled();
  });

  it("is null when the message was not a BotJob dispatch", async () => {
    sentFindFirst.mockResolvedValue({ key: "match-1:tentative-followup:user-1" });
    expect(await resolveRecruitDmReaction(WA)).toBeNull();
  });

  it("is null when the BotJob was some OTHER DM (no recruit link row)", async () => {
    // e.g. a payment chase or a Q&A answer — a 👍 there means nothing.
    sentFindUnique.mockResolvedValue(null);
    expect(await resolveRecruitDmReaction(WA)).toBeNull();
  });

  it("is null when the link row lost its match or its player", async () => {
    sentFindUnique.mockResolvedValue({ matchId: null, targetUser: "user-abid" });
    expect(await resolveRecruitDmReaction(WA)).toBeNull();
    sentFindUnique.mockResolvedValue({ matchId: "match-next", targetUser: null });
    expect(await resolveRecruitDmReaction(WA)).toBeNull();
  });

  it("is null when the BotJob row has gone", async () => {
    botJobFindUnique.mockResolvedValue(null);
    expect(await resolveRecruitDmReaction(WA)).toBeNull();
  });

  it("never throws — a broken lookup must not 500 the reaction route", async () => {
    sentFindFirst.mockRejectedValue(new Error("db down"));
    await expect(resolveRecruitDmReaction(WA)).resolves.toBeNull();
  });
});
