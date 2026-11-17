/**
 * KEEPING PEOPLE APART (OR TOGETHER) ON TEAMS THAT ALREADY EXIST
 * (2026-11-16, the Vets). "@Match Time keep Dan and Craig apart" changes
 * the teams as they stand with the fewest swaps, never a rebuild: one of
 * the two goes across and one player comes back, the one that keeps the
 * ratings closest. Pure: `planConstraintChange` in `team-constraints.ts`.
 */
import { describe, expect, it } from "vitest";
import { planConstraintChange, unmetConstraints, type SlotSide } from "../team-constraints";

type Slot = { userId: string; team: SlotSide; playing: boolean };
const slot = (userId: string, team: SlotSide, playing = true): Slot => ({ userId, team, playing });

// Red: Dan, Craig, Eli, Abe. Yellow: Finn, Gus, Hal, Bob.
const SHEET: Slot[] = [
  slot("Dan", "RED"),
  slot("Craig", "RED"),
  slot("Eli", "RED"),
  slot("Abe", "RED"),
  slot("Finn", "YELLOW"),
  slot("Gus", "YELLOW"),
  slot("Hal", "YELLOW"),
  slot("Bob", "YELLOW"),
];
const RATING: Record<string, number> = { Dan: 9, Craig: 8, Eli: 5, Abe: 3, Finn: 8.4, Gus: 6, Hal: 5.5, Bob: 5 };
const rating = (id: string) => RATING[id] ?? 6;

describe("planConstraintChange", () => {
  it("apart on one side: ONE swap, one of the two across and one player back, sides stay even", () => {
    const plan = planConstraintChange({ slots: SHEET, apart: [["Dan", "Craig"]], rating });
    expect(plan.swaps).toHaveLength(1);
    expect(plan.team.get("Dan")).not.toBe(plan.team.get("Craig"));
    const reds = [...plan.team.values()].filter((t) => t === "RED").length;
    expect(reds).toBe(4);
    expect(plan.unmet).toEqual({ together: [], apart: [] });
    // Everyone not in the swap stays where they were.
    const moved = new Set(plan.swaps.flat());
    for (const s of SHEET) if (!moved.has(s.userId)) expect(plan.team.get(s.userId)).toBe(s.team);
  });

  it("the swap picked keeps the ratings closest", () => {
    const plan = planConstraintChange({ slots: SHEET, apart: [["Dan", "Craig"]], rating });
    // Before: Red 25, Yellow 24.9. Craig (8) for Finn (8.4) leaves 25.4 v 24.5, the closest one swap can get
    // (Dan for Finn leaves 24.4 v 25.5).
    expect(plan.swaps[0].slice().sort()).toEqual(["Craig", "Finn"]);
  });

  it("already apart: nothing changes", () => {
    const plan = planConstraintChange({ slots: SHEET, apart: [["Dan", "Finn"]], rating });
    expect(plan.swaps).toEqual([]);
    expect(plan.unmet).toEqual({ together: [], apart: [] });
  });

  it("together, split across the sides: one swap brings them onto one side", () => {
    const plan = planConstraintChange({ slots: SHEET, together: [["Dan", "Finn"]], rating });
    expect(plan.swaps).toHaveLength(1);
    expect(plan.team.get("Dan")).toBe(plan.team.get("Finn"));
    expect(plan.unmet).toEqual({ together: [], apart: [] });
  });

  it("together and apart in one message", () => {
    const plan = planConstraintChange({ slots: SHEET, together: [["Abe", "Bob"]], apart: [["Dan", "Craig"]], rating });
    expect(plan.team.get("Abe")).toBe(plan.team.get("Bob"));
    expect(plan.team.get("Dan")).not.toBe(plan.team.get("Craig"));
    expect(plan.unmet).toEqual({ together: [], apart: [] });
    expect(plan.swaps.length).toBeLessThanOrEqual(2);
  });

  it("a clash (together AND apart about the same two): no change can meet both, and it says which", () => {
    const plan = planConstraintChange({ slots: SHEET, together: [["Dan", "Craig"]], apart: [["Dan", "Craig"]], rating });
    expect(plan.unmet.together.length + plan.unmet.apart.length).toBe(1);
    expect(plan.swaps).toEqual([]);
  });

  it("a player who is not on the teams cannot be kept apart: reported, nothing moved for it", () => {
    const plan = planConstraintChange({ slots: SHEET, apart: [["Dan", "Zed"]], rating });
    expect(plan.unmet.apart).toEqual([["Dan", "Zed"]]);
    expect(plan.swaps).toEqual([]);
  });

  it("a player the message placed or moved (fixed) is never moved: the other one goes (review of #619)", () => {
    // Craig (8) for Finn (8.4) would be the closest swap, but Craig is fixed.
    const plan = planConstraintChange({ slots: SHEET, apart: [["Dan", "Craig"]], fixed: ["Craig"], rating });
    expect(plan.team.get("Craig")).toBe("RED");
    expect(plan.team.get("Dan")).toBe("YELLOW");
    expect(plan.swaps.flat()).not.toContain("Craig");
  });

  it("both fixed on one side and asked apart: nothing moves, and the reason is the clash", () => {
    const plan = planConstraintChange({ slots: SHEET, apart: [["Dan", "Craig"]], fixed: ["Dan", "Craig"], rating });
    expect(plan.swaps).toEqual([]);
    expect(Object.values(plan.unmet.why ?? {})).toEqual([{ reason: "clash" }]);
  });

  it("possible but past the bounded search: the reason is 'no way in a few swaps', never a clash", () => {
    // Ten a side, a together group of ten split five and five: five swaps needed.
    const ids = Array.from({ length: 20 }, (_, i) => `p${i}`);
    const slots = ids.map((id, i) => slot(id, i < 10 ? "RED" : "YELLOW"));
    const group = [...ids.slice(0, 5), ...ids.slice(10, 15)];
    const plan = planConstraintChange({ slots, together: [group], rating: () => 5 });
    expect(plan.unmet.together).toHaveLength(1);
    expect(Object.values(plan.unmet.why ?? {})).toEqual([{ reason: "no-swaps" }]);
  });

  it("a slot holder who is no longer playing is never swapped in", () => {
    const sheet = SHEET.map((s) => (s.userId === "Finn" ? { ...s, playing: false } : s));
    const plan = planConstraintChange({ slots: sheet, apart: [["Dan", "Craig"]], rating });
    expect(plan.swaps.flat()).not.toContain("Finn");
    expect(plan.team.get("Dan")).not.toBe(plan.team.get("Craig"));
  });
});

describe("unmetConstraints", () => {
  const side = (m: Record<string, SlotSide>) => (id: string) => m[id];
  it("apart of two: met on different sides, unmet on one", () => {
    expect(unmetConstraints(side({ A: "RED", B: "YELLOW" }), { apart: [["A", "B"]] }).apart).toEqual([]);
    expect(unmetConstraints(side({ A: "RED", B: "RED" }), { apart: [["A", "B"]] }).apart).toEqual([["A", "B"]]);
  });
  it("apart of three: met when spread two and one", () => {
    expect(unmetConstraints(side({ A: "RED", B: "YELLOW", C: "RED" }), { apart: [["A", "B", "C"]] }).apart).toEqual([]);
    expect(unmetConstraints(side({ A: "RED", B: "RED", C: "RED" }), { apart: [["A", "B", "C"]] }).apart).toEqual([["A", "B", "C"]]);
  });
  it("anyone with no side breaks the group", () => {
    expect(unmetConstraints(side({ A: "RED" }), { together: [["A", "B"]] }).together).toEqual([["A", "B"]]);
  });
});
