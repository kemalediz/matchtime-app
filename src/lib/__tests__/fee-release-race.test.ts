/**
 * THE FEE RELEASE AND A REPLY THAT CROSSES IT (review of #470).
 *
 * Reading a reply now takes a model call (1 to 3 seconds), so a "yes" and
 * a "no, make it £10" sent a second apart can be read side by side. The
 * writes are compare-and-set on the match row:
 *
 *   - a yes releases only while the amount it read is STILL the one waiting
 *     (`feePendingConfirm: amount` in the claim), so a yes read at £8
 *     never releases after £10 was staged;
 *   - an amount is staged only while the links have not gone out, so no
 *     "reply ✅" prompt is sent for a match already released.
 *
 * The match row lives in memory here; `updateMany` applies the same where
 * clause the database does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
  id: string;
  feePendingConfirm: number | null;
  feePerPlayer: number | null;
  paymentLinksReleasedAt: Date | null;
}
let row: Row;
const released: string[] = [];

function matches(where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if ((row as unknown as Record<string, unknown>)[k] !== v) return false;
  }
  return true;
}

vi.mock("../db", () => ({
  db: {
    match: {
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
        if (!matches(where)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      // releaseMatchPayments reads the match: no squad, nothing queued.
      findUnique: async () => {
        released.push(row.id);
        return null;
      },
    },
  },
}));

import { claimAndReleaseFee, stageFee } from "../payment-flow";

beforeEach(() => {
  row = { id: "m1", feePendingConfirm: 8, feePerPlayer: null, paymentLinksReleasedAt: null };
  released.length = 0;
});

describe("a yes releases only the amount it read", () => {
  it("the amount still waiting: released", async () => {
    expect(await claimAndReleaseFee("u-col", "m1", 8)).toBe(0);
    expect(row.paymentLinksReleasedAt).not.toBeNull();
    expect(row.feePerPlayer).toBe(8);
    expect(released).toEqual(["m1"]);
  });

  it('"yes" read at £8, then "make it £10" staged before the yes lands: NOTHING released', async () => {
    // The second reply is staged while the yes is still being read.
    expect(await stageFee("u-col", "m1", 10)).toBe(true);
    expect(await claimAndReleaseFee("u-col", "m1", 8)).toBeNull();
    expect(row.paymentLinksReleasedAt).toBeNull();
    expect(row.feePendingConfirm).toBe(10);
    expect(released).toEqual([]);
  });

  it('"yes" read at £8, then "no" cleared it before the yes lands: NOTHING released', async () => {
    row.feePendingConfirm = null;
    expect(await claimAndReleaseFee("u-col", "m1", 8)).toBeNull();
    expect(row.paymentLinksReleasedAt).toBeNull();
  });

  it("two yeses at once: only the first releases", async () => {
    expect(await claimAndReleaseFee("u-col", "m1", 8)).toBe(0);
    expect(await claimAndReleaseFee("u-col", "m1", 8)).toBeNull();
    expect(released).toEqual(["m1"]);
  });
});

describe("an amount is staged only while the links have not gone out", () => {
  it("before the release: staged", async () => {
    expect(await stageFee("u-col", "m1", 10)).toBe(true);
    expect(row.feePendingConfirm).toBe(10);
  });

  it('"yes" released at £8, then "make it £10" lands: NOT staged, so no "reply ✅" prompt goes out', async () => {
    expect(await claimAndReleaseFee("u-col", "m1", 8)).toBe(0);
    expect(await stageFee("u-col", "m1", 10)).toBe(false);
    expect(row.feePendingConfirm).toBeNull();
    expect(row.feePerPlayer).toBe(8);
  });
});
