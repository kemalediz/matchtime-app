/**
 * `linkJoinerToPlaceholder`: the DB half of the joiner/placeholder link.
 * The rules are pinned in `placeholder-link-rules.test.ts`; this pins what
 * the function does with them: merge inside a transaction via
 * `mergePlayersCore` (joiner kept, placeholder dropped, alias saved in
 * this club only), re-check the safety rules INSIDE the transaction, and
 * never let a failed merge break the join (it becomes a suggestion).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const userFindUnique = vi.fn();
const aliasFindMany = vi.fn();
const membershipFindMany = vi.fn();
const txUserFindUnique = vi.fn();
const txMembershipFindMany = vi.fn();
const transaction = vi.fn();
const mergeCore = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
    userAlias: { findMany: (...a: unknown[]) => aliasFindMany(...a) },
    membership: { findMany: (...a: unknown[]) => membershipFindMany(...a) },
    $transaction: (...a: unknown[]) => transaction(...a),
  },
}));
vi.mock("@/lib/merge-players-core", () => ({
  mergePlayersCore: (...a: unknown[]) => mergeCore(...a),
}));

import { linkJoinerToPlaceholder } from "@/lib/placeholder-link";

const ORG = "org-sutton";
const JOINER = { id: "u-phone", name: "Hamzah", phoneNumber: "+447376548222" };
const ADDED = new Date("2026-09-29T07:57:00Z");

function ghostMembership(over: Record<string, unknown> = {}, userOver: Record<string, unknown> = {}) {
  return {
    userId: "u-ghost",
    leftAt: null,
    provisionallyAddedAt: ADDED,
    user: {
      id: "u-ghost",
      name: "Hamzah",
      email: "provisional+hamzah-x@matchtime.local",
      phoneNumber: null,
      createdAt: ADDED,
      _count: { memberships: 1 },
      ...userOver,
    },
    ...over,
  };
}

const TX = {
  user: { findUnique: (...a: unknown[]) => txUserFindUnique(...a) },
  membership: { findMany: (...a: unknown[]) => txMembershipFindMany(...a) },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  userFindUnique.mockResolvedValue(JOINER);
  aliasFindMany.mockResolvedValue([]);
  membershipFindMany.mockResolvedValue([ghostMembership()]);
  transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(TX));
  txUserFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === JOINER.id ? { phoneNumber: JOINER.phoneNumber } : { phoneNumber: null },
  );
  txMembershipFindMany.mockResolvedValue([{ orgId: ORG }]);
  mergeCore.mockResolvedValue(undefined);
});

describe("linkJoinerToPlaceholder", () => {
  it("THE INCIDENT: merges the placeholder into the joiner inside a transaction", async () => {
    const out = await linkJoinerToPlaceholder(ORG, JOINER.id);
    expect(out).toEqual({ kind: "linked", placeholderUserId: "u-ghost", placeholderName: "Hamzah", addedAt: ADDED });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(mergeCore).toHaveBeenCalledWith(TX, JOINER.id, "u-ghost", { saveAliasInOrgIds: [ORG] });
  });

  it("only looks at THIS club's phoneless, current members", async () => {
    await linkJoinerToPlaceholder(ORG, JOINER.id);
    const where = membershipFindMany.mock.calls[0][0].where;
    expect(where.orgId).toBe(ORG);
    expect(where.leftAt).toBeNull();
    expect(where.user).toEqual({ phoneNumber: null });
    expect(where.userId).toEqual({ not: JOINER.id });
  });

  it("a joiner without a phone links nothing and reads nothing else", async () => {
    userFindUnique.mockResolvedValue({ ...JOINER, phoneNumber: null });
    expect(await linkJoinerToPlaceholder(ORG, JOINER.id)).toEqual({ kind: "none" });
    expect(membershipFindMany).not.toHaveBeenCalled();
  });

  it("two candidates: a suggestion, no merge", async () => {
    membershipFindMany.mockResolvedValue([
      ghostMembership(),
      ghostMembership({ userId: "u-ghost2" }, { id: "u-ghost2" }),
    ]);
    const out = await linkJoinerToPlaceholder(ORG, JOINER.id);
    expect(out).toEqual({
      kind: "suggest",
      candidates: [
        { userId: "u-ghost", name: "Hamzah", addedAt: ADDED },
        { userId: "u-ghost2", name: "Hamzah", addedAt: ADDED },
      ],
    });
    expect(mergeCore).not.toHaveBeenCalled();
  });

  it("the pushname is a name too (the participant sweep passes it)", async () => {
    userFindUnique.mockResolvedValue({ ...JOINER, name: null });
    const out = await linkJoinerToPlaceholder(ORG, JOINER.id, { extraNames: ["Hamzah"] });
    expect(out.kind).toBe("linked");
  });

  it("CROSS-CLUB, re-checked inside the transaction: the placeholder joined another club meanwhile", async () => {
    txMembershipFindMany.mockResolvedValue([{ orgId: ORG }, { orgId: "org-other" }]);
    const out = await linkJoinerToPlaceholder(ORG, JOINER.id);
    expect(mergeCore).not.toHaveBeenCalled();
    expect(out.kind).toBe("suggest");
  });

  it("PHONE VS PHONE, re-checked inside the transaction: the placeholder got a phone meanwhile", async () => {
    txUserFindUnique.mockResolvedValue({ phoneNumber: "+447700900111" });
    const out = await linkJoinerToPlaceholder(ORG, JOINER.id);
    expect(mergeCore).not.toHaveBeenCalled();
    expect(out.kind).toBe("suggest");
  });

  it("a merge that throws never breaks the join: it becomes a suggestion", async () => {
    mergeCore.mockRejectedValue(new Error("P2028"));
    const out = await linkJoinerToPlaceholder(ORG, JOINER.id);
    expect(out).toEqual({ kind: "suggest", candidates: [{ userId: "u-ghost", name: "Hamzah", addedAt: ADDED }] });
  });

  it("a read that throws returns none", async () => {
    membershipFindMany.mockRejectedValue(new Error("down"));
    expect(await linkJoinerToPlaceholder(ORG, JOINER.id)).toEqual({ kind: "none" });
  });
});
