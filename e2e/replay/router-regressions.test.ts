/**
 * The PURE half of the named-regression harness.
 *
 * It deliberately does not assert what the model says — that is
 * `router-regressions-live.ts`, and pretending a stub could answer it is
 * exactly the mistake `MEMORY.md`'s "dry-run prompts before shipping"
 * entry and §3.1's v1 failure both record. What is checkable here is
 * that the harness itself is honest: the cases name owners that exist,
 * the owner map agrees with the router's own parser, and the grader
 * fails on the one thing it is allowed to fail on.
 */
import { describe, it, expect } from "vitest";
import {
  OWNER_OF,
  ROUTER_REGRESSIONS,
  regressionsPass,
  renderRegressions,
  summariseRegressions,
  unparseableOwners,
  type RegressionOutcome,
} from "./router-regressions";
import { normaliseRoute } from "../../src/lib/pipeline/router";

describe("the regression case list", () => {
  it("covers the messages §3.1 names, and says which are also prompt examples", () => {
    const bodies = ROUTER_REGRESSIONS.map((c) => c.body);
    for (const named of [
      "Talha is coming please add him",
      "@Kemal Ediz my brother can play if needed",
      "Add these 2 boys pl",
      "very good lads, same quality and friendliness as ours, come on, one player please",
      "@Kemal Ediz please switch to 7 a side and include Amir as 14th player",
    ]) {
      expect(bodies, named).toContain(named);
    }
    // The value of the list is the half that is NOT already answered in
    // the prompt. If that half ever empties, the harness has become a
    // lookup table and stops measuring anything.
    const heldOut = ROUTER_REGRESSIONS.filter((c) => !c.inPrompt);
    expect(heldOut.length).toBeGreaterThanOrEqual(8);
  });

  it("names only owners that exist, over routes the parser accepts", () => {
    expect(unparseableOwners()).toEqual([]);
  });

  it("maps every route the router can emit to exactly one owner", () => {
    for (const route of Object.keys(OWNER_OF)) {
      expect(normaliseRoute(route), route).toBe(route);
    }
    // `unsure` reaches the attendance extractor, so abstaining satisfies
    // an `A` case. `gate.ts`'s ENGINE_ROUTES is what makes that true.
    expect(OWNER_OF.unsure).toBe("A");
  });

  it("gives every case a reason somebody can check", () => {
    for (const c of ROUTER_REGRESSIONS) {
      expect(c.why.length, c.body).toBeGreaterThan(20);
      expect(c.allow.length, c.body).toBeGreaterThan(0);
    }
  });
});

describe("the grader", () => {
  const attendanceCase = ROUTER_REGRESSIONS.find((c) => c.allow.join() === "A")!;
  const banterCase = ROUTER_REGRESSIONS.find((c) => c.allow.join() === "N")!;

  it("fails the run when an attendance message is called banter, in ANY run", () => {
    const outcomes: RegressionOutcome[] = [
      { case: attendanceCase, routes: ["self_att", "none", "self_att"] },
    ];
    const report = summariseRegressions(outcomes);
    expect(report.attendanceLost).toHaveLength(1);
    expect(report.attendanceLost[0].runs).toBe(1);
    expect(regressionsPass(report)).toBe(false);
    expect(renderRegressions(report)).toMatch(/FAIL/);
  });

  it("accepts any route that reaches the attendance owner", () => {
    const report = summariseRegressions([
      { case: attendanceCase, routes: ["self_att", "other_att", "offer", "unsure"] },
    ]);
    expect(report.attendanceLost).toEqual([]);
    expect(report.satisfied).toBe(4);
    expect(regressionsPass(report)).toBe(true);
  });

  it("reports a benign message that escaped `none` WITHOUT failing the run", () => {
    // A false positive here costs one extractor call. Failing on it
    // would put cost and a player's slot on the same footing, which is
    // the trade `gate.ts` refuses.
    const report = summariseRegressions([{ case: banterCase, routes: ["admin_ops", "none"] }]);
    expect(report.softMisses).toHaveLength(1);
    expect(regressionsPass(report)).toBe(true);
    expect(renderRegressions(report)).toMatch(/NOT failed on/);
  });

  it("counts case-runs, not cases", () => {
    const report = summariseRegressions([
      { case: attendanceCase, routes: ["self_att", "self_att"] },
      { case: banterCase, routes: ["none", "none"] },
    ]);
    expect(report.caseRuns).toBe(4);
    expect(report.satisfied).toBe(4);
    expect(report.repeats).toBe(2);
  });
});
