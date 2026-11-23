/**
 * THE HQ TICK FOR A MESSAGE WITH SEVERAL PARTS OR ACTIONS (review of #629,
 * item 3). Its outcome is the parts' outcomes joined with "+": the tick goes
 * on only when some part was actually done, never on refusals or questions
 * alone.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { HQ_TICK, tickFor } from "../admin-group";

describe("tickFor", () => {
  it("one outcome: as before", () => {
    expect(tickFor("hq-format-switched")).toBe(HQ_TICK);
    expect(tickFor("hq-only-organisers")).toBeNull();
    expect(tickFor(null)).toBe(HQ_TICK);
  });

  it("joined: only refusals, questions and not-done lines get no tick", () => {
    expect(tickFor("hq-only-organisers+hq-only-organisers")).toBeNull();
    expect(tickFor("hq-game-move-which+hq-part-not-done")).toBeNull();
  });

  it("joined: a part done gets the tick", () => {
    expect(tickFor("hq-format-switched+hq-pool-asked")).toBe(HQ_TICK);
    expect(tickFor("hq-format-switched+hq-part-not-done")).toBe(HQ_TICK);
  });
});
