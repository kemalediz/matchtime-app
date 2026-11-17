/**
 * THE FILL CYCLE'S CLAIM, HELD FOR ONE BATCH (review of #616, 2026-11-17).
 *
 * A batch whose one reply carries the list (a message with several parts,
 * or a size switched before the batch's INs) holds `<matchId>:squad-locked`
 * so an IN that fills the squad does not ALSO queue "Squad complete". After
 * the batch the claim is kept only if the squad is full; and a batch that
 * throws half way must not leave it held, or the next full squad is never
 * announced.
 */
import { describe, expect, it } from "vitest";
import { squadLockHold, withExitTasks, type SquadLockStore } from "../squad-lock-hold";

function store(full: boolean | "throws") {
  const rows = new Set<string>();
  const s: SquadLockStore = {
    hold: async (key) => {
      rows.add(key);
    },
    release: async (key) => {
      rows.delete(key);
    },
    isFull: async () => {
      if (full === "throws") throw new Error("db down");
      return full;
    },
  };
  return { rows, s };
}

describe("squadLockHold", () => {
  it("held even when the claim was already there (a squad announced at the old size)", async () => {
    const { rows, s } = store(false);
    rows.add("m1:squad-locked");
    const lock = squadLockHold(s);
    expect(await lock.take("m1")).toBe(true);
    await lock.settle();
    expect(rows.has("m1:squad-locked")).toBe(false);
  });

  it("kept when the squad is full after the batch", async () => {
    const { rows, s } = store(true);
    const lock = squadLockHold(s);
    await lock.take("m1");
    await lock.settle();
    expect(rows.has("m1:squad-locked")).toBe(true);
  });

  it("released when the fullness cannot be read", async () => {
    const { rows, s } = store("throws");
    const lock = squadLockHold(s);
    await lock.take("m1");
    await lock.settle();
    expect(rows.has("m1:squad-locked")).toBe(false);
  });

  it("settled once, whoever calls it twice", async () => {
    let checks = 0;
    const { s } = store(false);
    const lock = squadLockHold({ ...s, isFull: async () => (checks++, false) });
    await lock.take("m1");
    await lock.settle();
    await lock.settle();
    expect(checks).toBe(1);
  });

  it("nothing taken: settling does nothing", async () => {
    const { rows, s } = store(false);
    rows.add("m1:squad-locked");
    await squadLockHold(s).settle();
    expect(rows.has("m1:squad-locked")).toBe(true);
  });
});

describe("withExitTasks: the claim is settled when the batch throws", () => {
  it("a task registered before a throw still runs, and the throw still reaches the caller", async () => {
    const { rows, s } = store(false);
    const lock = squadLockHold(s);
    await expect(
      withExitTasks(async (atExit) => {
        await lock.take("m1");
        atExit(lock.settle);
        throw new Error("half way");
      }),
    ).rejects.toThrow("half way");
    expect(rows.has("m1:squad-locked")).toBe(false);
  });

  it("a task that throws does not stop the others or change the result", async () => {
    const ran: string[] = [];
    const out = await withExitTasks(async (atExit) => {
      atExit(async () => {
        throw new Error("x");
      });
      atExit(async () => {
        ran.push("second");
      });
      return 7;
    });
    expect(out).toBe(7);
    expect(ran).toEqual(["second"]);
  });
});
