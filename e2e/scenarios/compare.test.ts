import { describe, expect, it } from "vitest";
import { alignLines, compareTranscripts, renderComparison } from "./compare";
import type { ClubTranscript } from "./normalise";

function transcript(over: (t: ClubTranscript) => void = () => {}): ClubTranscript {
  const t: ClubTranscript = {
    version: 1,
    club: "vets",
    title: "Vets type",
    mode: "replay",
    steps: [
      { seq: -1, step: "before the first step", out: [], handled: [], db: [], errors: [] },
      {
        seq: 0,
        step: '2026-11-10 12:00 main @davide: "MNF November ..."',
        out: [{ at: "2026-11-10 12:01", to: "group main", kind: "out", text: "Got it, 13 on the month's list." }],
        handled: ['@davide in main: "MNF November" → engine / month_list'],
        db: ["<month 2026-11>: status: (new) running"],
        errors: [],
      },
      {
        seq: 1,
        step: '2026-11-10 18:00 main @nabz: "in"',
        out: [{ at: "2026-11-10 18:10", to: "group main", kind: "react", text: "✅", replyTo: "@nabz: in" }],
        handled: [],
        db: [],
        errors: [],
      },
    ],
    final: { "user @nabz": 'name "Nabz"', "club: muted": "no" },
  };
  over(t);
  return t;
}

describe("alignLines", () => {
  it("pairs equal lines and puts the changed ones side by side", () => {
    expect(alignLines(["a", "b", "c"], ["a", "x", "c", "d"])).toEqual([
      { a: "a", b: "a", same: true },
      { a: "b", b: "x", same: false },
      { a: "c", b: "c", same: true },
      { a: null, b: "d", same: false },
    ]);
  });
});

describe("compareTranscripts", () => {
  it("says two identical runs are identical", () => {
    const c = compareTranscripts(transcript(), transcript());
    expect(c.identical).toBe(true);
    expect(c.differingSteps).toEqual([]);
  });

  it("finds the step where the two sides sent or wrote something different", () => {
    const b = transcript((t) => {
      t.steps[1].out[0].text = "Got it, 13 regulars for November.";
      t.steps[2].db.push("<match 2026-11-16 20:30>: attendance @nabz: (new) CONFIRMED #1");
      t.final["user <user Smiler>"] = "name \"Smiler\"";
    });
    const c = compareTranscripts(transcript(), b);
    expect(c.identical).toBe(false);
    expect(c.differingSteps.map((s) => s.seq)).toEqual([0, 1]);
    expect(c.final.onlyB).toEqual(['user <user Smiler> = name "Smiler"']);
  });

  it("notices when the two sides did not play the same scenario", () => {
    const b = transcript((t) => {
      t.steps[2].step = '2026-11-10 18:00 main @nabz: "IN"';
    });
    expect(compareTranscripts(transcript(), b).scenarioMismatch).toEqual([1]);
  });
});

describe("renderComparison", () => {
  it("prints each differing step with both sides next to each other", () => {
    const b = transcript((t) => {
      t.steps[1].out[0].text = "Got it, 13 regulars for November.";
    });
    const md = renderComparison([compareTranscripts(transcript(), b)], { a: "main", b: "refactor" });
    expect(md).toContain("## vets: 1 step(s) differ");
    expect(md).toContain("| main | refactor |");
    expect(md).toContain("Got it, 13 on the month's list.");
    expect(md).toContain("Got it, 13 regulars for November.");
    expect(md).not.toContain('@nabz: \\"in\\"');
  });

  it("says so plainly when nothing differs", () => {
    expect(renderComparison([compareTranscripts(transcript(), transcript())], { a: "a", b: "b" })).toContain("## vets: identical");
  });
});
