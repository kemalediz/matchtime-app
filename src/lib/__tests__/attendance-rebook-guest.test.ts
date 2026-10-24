/**
 * Review of #404, 7: a guest put back on a game he gave up gets his guest
 * place booked again (in time or late, not settled yet), as a partner
 * volunteer's is. `registerAttendance` calls it when the row was absent or
 * DROPPED (source check below); a confirmed or bench row is never touched.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({ guestPlace: { updateMany: vi.fn(async () => ({ count: 1 })) } }));
vi.mock("../db", () => ({ db: dbMock }));

import { rebookGuestPlace } from "../attendance";

describe("rebookGuestPlace", () => {
  it("books again only a given-up place that is not settled", async () => {
    expect(await rebookGuestPlace("m1", "u1")).toBe(1);
    expect(dbMock.guestPlace.updateMany).toHaveBeenCalledWith({
      where: { matchId: "m1", userId: "u1", result: { in: ["withdrawn", "late-cancel"] }, settledAt: null },
      data: { result: "booked", resultAt: null, resultById: null },
    });
  });

  it("registerAttendance calls it only for a row that was absent or dropped", () => {
    const src = readFileSync(join(__dirname, "..", "attendance.ts"), "utf8");
    expect(src).toMatch(/if \(!existing \|\| existing\.status === "DROPPED"\) \{\s*try \{\s*await rebookGuestPlace\(matchId, userId\);/);
  });
});
