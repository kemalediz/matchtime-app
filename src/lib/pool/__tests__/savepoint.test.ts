/**
 * One wave, one transaction, one savepoint per person (second review of
 * #400, item 3): a failure for one person rolls back only his step.
 */
import { describe, expect, it, vi } from "vitest";
import { eachUnderSavepoint } from "../savepoint";

describe("eachUnderSavepoint", () => {
  it("a failing step is rolled back to its savepoint; the others are kept", async () => {
    const sql: string[] = [];
    const tx = { $executeRawUnsafe: vi.fn(async (q: string) => sql.push(q)) };
    const done = await eachUnderSavepoint(tx, ["a", "b", "c"], async (x) => {
      if (x === "b") throw new Error("unique clash");
      return x;
    });
    expect(done).toEqual(["a", "c"]);
    expect(sql).toEqual([
      "SAVEPOINT pool_step_0",
      "RELEASE SAVEPOINT pool_step_0",
      "SAVEPOINT pool_step_1",
      "ROLLBACK TO SAVEPOINT pool_step_1",
      "SAVEPOINT pool_step_2",
      "RELEASE SAVEPOINT pool_step_2",
    ]);
  });
});
