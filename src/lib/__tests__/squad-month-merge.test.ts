/**
 * Merging two player records must carry the monthly squad rows across
 * (monthly squad, slice 2). Both tables reference "User" ON DELETE
 * CASCADE, so a merge that did not re-point them first would silently
 * delete the dropped record's month, its payment state and its credits
 * when the dropped user row is removed.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../db", () => ({ db: {} }));

import { repointSquadMonthRows } from "../squad-month";

interface Row {
  id: string;
  monthId: string;
  userId: string;
  paidAt: Date | null;
  paidClaimedAt: Date | null;
}

function makeTx(rows: Row[]) {
  const creditUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
  return {
    rows,
    creditUpdateMany,
    tx: {
      squadMonthMember: {
        findMany: vi.fn(({ where }: { where: { userId: string } }) => Promise.resolve(rows.filter((r) => r.userId === where.userId))),
        findUnique: vi.fn(({ where }: { where: { monthId_userId: { monthId: string; userId: string } } }) =>
          Promise.resolve(rows.find((r) => r.monthId === where.monthId_userId.monthId && r.userId === where.monthId_userId.userId) ?? null),
        ),
        update: vi.fn(({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
          Object.assign(rows.find((r) => r.id === where.id)!, data);
          return Promise.resolve({});
        }),
        delete: vi.fn(({ where }: { where: { id: string } }) => {
          rows.splice(rows.findIndex((r) => r.id === where.id), 1);
          return Promise.resolve({});
        }),
      },
      squadCredit: { updateMany: creditUpdateMany },
    },
  };
}

const row = (over: Partial<Row> & { id: string; userId: string }): Row => ({ monthId: "m-oct", paidAt: null, paidClaimedAt: null, ...over });
const PAID = new Date("2026-10-02T10:00:00Z");

describe("repointSquadMonthRows", () => {
  it("a month only the dropped record is in moves to the keeper whole", async () => {
    const w = makeTx([row({ id: "a", userId: "drop", paidAt: PAID })]);
    await repointSquadMonthRows(w.tx as never, "keep", "drop");
    expect(w.rows).toEqual([row({ id: "a", userId: "keep", paidAt: PAID })]);
  });

  it("both in the same month: the keeper's row stays, the duplicate goes", async () => {
    const w = makeTx([row({ id: "k", userId: "keep", paidClaimedAt: PAID }), row({ id: "d", userId: "drop" })]);
    await repointSquadMonthRows(w.tx as never, "keep", "drop");
    expect(w.rows.map((r) => [r.id, r.userId])).toEqual([["k", "keep"]]);
  });

  it("both in the same month and only the dropped row has a payment: the payment is the one kept", async () => {
    const w = makeTx([row({ id: "k", userId: "keep" }), row({ id: "d", userId: "drop", paidAt: PAID })]);
    await repointSquadMonthRows(w.tx as never, "keep", "drop");
    expect(w.rows).toEqual([row({ id: "d", userId: "keep", paidAt: PAID })]);
  });

  it("a confirmed payment beats a claim, whichever record holds it", async () => {
    const w = makeTx([row({ id: "k", userId: "keep", paidClaimedAt: PAID }), row({ id: "d", userId: "drop", paidAt: PAID })]);
    await repointSquadMonthRows(w.tx as never, "keep", "drop");
    expect(w.rows.map((r) => r.id)).toEqual(["d"]);
    const w2 = makeTx([row({ id: "k", userId: "keep", paidAt: PAID }), row({ id: "d", userId: "drop", paidClaimedAt: PAID })]);
    await repointSquadMonthRows(w2.tx as never, "keep", "drop");
    expect(w2.rows.map((r) => r.id)).toEqual(["k"]);
  });

  it("every credit moves to the keeper: the ledger never loses a row", async () => {
    const w = makeTx([]);
    await repointSquadMonthRows(w.tx as never, "keep", "drop");
    expect(w.creditUpdateMany).toHaveBeenCalledWith({ where: { userId: "drop" }, data: { userId: "keep" } });
  });
});
