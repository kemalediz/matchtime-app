/**
 * A ✅ on the player's own "Paid" DM (Kemal, 2026-10-16).
 *
 * The reaction goes out through the EXISTING retro-reaction queue
 * (`RetroReaction` → due-posts `update-reaction` → the Pi's
 * `reactAndReport`), the same path the players' group slot emojis use.
 * These tests pin the queueing rules and the backfill's target selection.
 */
import { describe, it, expect } from "vitest";
import {
  PAID_CLAIM_REACTION,
  queuePaidClaimReaction,
  selectPaidClaimReactionTargets,
  waMessageIdOfPaidClaimKey,
  type PaidClaimLedgerRow,
} from "../paid-claim-reaction";

function fakeClient(existing: Array<{ waMessageId: string; emoji: string }> = []) {
  const created: Array<{ orgId: string; waMessageId: string; emoji: string; reason?: string | null }> = [];
  const client = {
    retroReaction: {
      findFirst: async (args: { where: { waMessageId: string; emoji: string } }) =>
        [...existing, ...created].find(
          (r) => r.waMessageId === args.where.waMessageId && r.emoji === args.where.emoji,
        )
          ? { id: "r1" }
          : null,
      create: async (args: { data: { orgId: string; waMessageId: string; emoji: string; reason?: string | null } }) => {
        created.push(args.data);
        return { id: `r${created.length + 1}` };
      },
    },
  };
  return { client, created };
}

const DM_ID = "false_80913090220135@lid_3AD58E6E3587B37FC66F";

describe("queuePaidClaimReaction", () => {
  it("the emoji is ✅", () => {
    expect(PAID_CLAIM_REACTION).toBe("✅");
  });

  it("queues one ✅ retro-reaction on the player's DM, for the owed club", async () => {
    const { client, created } = fakeClient();
    const out = await queuePaidClaimReaction(client, { orgId: "org-fnf", waMessageId: DM_ID, reason: "paid claim" });
    expect(out).toBe("queued");
    expect(created).toEqual([{ orgId: "org-fnf", waMessageId: DM_ID, emoji: "✅", reason: "paid claim" }]);
  });

  it("never queues the same ✅ on the same message twice (a re-run of the backfill)", async () => {
    const { client, created } = fakeClient([{ waMessageId: DM_ID, emoji: "✅" }]);
    const out = await queuePaidClaimReaction(client, { orgId: "org-fnf", waMessageId: DM_ID });
    expect(out).toBe("already-queued");
    expect(created).toEqual([]);
  });

  it("a synthetic or empty id is not queued: WhatsApp never issued it, so there is nothing to react to", async () => {
    const { client, created } = fakeClient();
    expect(await queuePaidClaimReaction(client, { orgId: "o", waMessageId: "synthetic:abc" })).toBe("no-real-id");
    expect(await queuePaidClaimReaction(client, { orgId: "o", waMessageId: "" })).toBe("no-real-id");
    expect(created).toEqual([]);
  });
});

describe("the backfill's targets", () => {
  const claimAt = new Date("2026-10-16T20:46:23.669Z");
  const base: PaidClaimLedgerRow = {
    key: `paid-claim:${DM_ID}`,
    createdAt: claimAt,
    matchId: "m1",
    userId: "u1",
    paymentMethod: "direct",
    directPendingAt: new Date(claimAt.getTime() + 400),
    paidAt: null,
  };

  it("reads the DM's id back out of the replay-guard key", () => {
    expect(waMessageIdOfPaidClaimKey(`paid-claim:${DM_ID}`)).toBe(DM_ID);
    expect(waMessageIdOfPaidClaimKey("something-else")).toBeNull();
  });

  it("a claim that was RECORDED (pending set by it) is a target", () => {
    expect(selectPaidClaimReactionTargets([base])).toEqual([
      { waMessageId: DM_ID, matchId: "m1", userId: "u1", claimedAt: claimAt },
    ]);
  });

  it("a recorded claim the collector has since confirmed is still a target", () => {
    const confirmed = { ...base, directPendingAt: null, paidAt: new Date(claimAt.getTime() + 60_000) };
    expect(selectPaidClaimReactionTargets([confirmed])).toHaveLength(1);
  });

  it("not a target: nothing was written by it (paid for others, or blocked)", () => {
    expect(selectPaidClaimReactionTargets([{ ...base, paymentMethod: null, directPendingAt: null }])).toEqual([]);
    const pendingFromBefore = { ...base, directPendingAt: new Date(claimAt.getTime() - 3_600_000) };
    expect(selectPaidClaimReactionTargets([pendingFromBefore])).toEqual([]);
  });

  it("not a target: a synthetic id", () => {
    expect(selectPaidClaimReactionTargets([{ ...base, key: "paid-claim:synthetic:x" }])).toEqual([]);
  });
});
