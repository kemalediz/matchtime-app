/**
 * The badges post's server-side bookkeeping, whichever kind carries it
 * (2026-10-14). A club whose organisers announce gets its badges post in
 * the admin group, or by DM to its admins, and those instructions carry
 * the ledger rows just as the players' group post does. The rows are
 * written in the claim, and never reach the Pi.
 */
import { describe, it, expect, vi } from "vitest";

const calls = vi.hoisted(() => ({ sent: [] as unknown[], ledger: [] as unknown[] }));
vi.mock("@/lib/db", () => ({
  db: {
    sentNotification: { create: (a: unknown) => (calls.sent.push(a), a) },
    badgeAnnouncement: { createMany: (a: unknown) => (calls.ledger.push(a), a) },
    $transaction: async (ops: unknown[]) => ops,
  },
}));

import { badgeLedgerOf, claimBadgePost, withoutServerBookkeeping } from "@/lib/badge-announcement-scheduler";
import type { DueInstruction } from "@/lib/bot-scheduler";

const LEDGER = [{ userId: "u0", badgeKey: "first-game" as const, matchId: "m1" }];

describe("withoutServerBookkeeping", () => {
  it("strips the ledger from a group post, an admin-group post and a DM", () => {
    const all: DueInstruction[] = [
      { kind: "group-message", key: "m1:badges", text: "x", badgeLedger: LEDGER, rosterShown: { fingerprint: "f" } },
      { kind: "admin-group-message", key: "m1:badges", groupId: "g", text: "x", badgeLedger: LEDGER },
      { kind: "dm", key: "m1:badges:a1", phone: "44", text: "x", badgeLedger: LEDGER },
    ];
    for (const i of all) {
      const out = withoutServerBookkeeping(i);
      expect("badgeLedger" in out).toBe(false);
      expect("rosterShown" in out).toBe(false);
      expect(badgeLedgerOf(i)).toEqual(LEDGER);
    }
  });

  it("leaves an instruction without bookkeeping as it was", () => {
    const i: DueInstruction = { kind: "dm", key: "k", phone: "44", text: "x" };
    expect(withoutServerBookkeeping(i)).toBe(i);
  });
});

describe("claimBadgePost", () => {
  it("records the DM's recipient on the claim, with the ledger rows", async () => {
    await claimBadgePost("org1", { key: "m1:badges:a1", kind: "dm", matchId: "m1", targetUser: "a1" }, LEDGER);
    expect(calls.sent.at(-1)).toEqual({ data: { key: "m1:badges:a1", kind: "dm", matchId: "m1", targetUser: "a1", text: null } });
    expect(calls.ledger.at(-1)).toEqual({
      data: [{ orgId: "org1", userId: "u0", badgeKey: "first-game", matchId: "m1" }],
      skipDuplicates: true,
    });
  });

  it("keeps the post's words on the claim, as every claim does (quoted-reply context, S0)", async () => {
    await claimBadgePost("org1", { key: "m1:badges", kind: "group-message", matchId: "m1", text: "🏅 First game: Ali" }, LEDGER);
    expect(calls.sent.at(-1)).toMatchObject({ data: { key: "m1:badges", text: "🏅 First game: Ali" } });
  });
});
