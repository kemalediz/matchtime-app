/**
 * Pipeline #3 — the SHIPPED route with §10 step 6's attendance engine
 * turned ON, so it really writes.
 *
 * This is the difference from `DryRunPipeline` (#2) and it is the whole
 * point of step 6. #2 grades the DECISION: it reads the world, decides
 * what it would do, and projects that forward in memory. #3 grades the
 * WRITE: the same router, the same extractor, the same engine, and then
 * `registerAttendance` / `cancelAttendance` with their transactions,
 * their position ordering, their `AttendanceEvent`s, their bench-offer
 * bookkeeping, the recruit blast, and the batch-final squad-post
 * composition. `attendanceAfter` here is a database read, not a
 * proposal.
 *
 * That is what makes corpus case `PR33-recruit-ask-must-not-swallow-the-drop`
 * scoreable at all. It expects `DM'd N recent players`, and a dry run
 * performs no DM blast, so #2 scores it 0/3 by construction. #3 must
 * pass it, and `e2e/corpus/README.md`'s rule 5 applies: check the code
 * path before calling a failure a defect.
 *
 * ─────────────────────────────────────────────────────────────────────
 * HOW THE FLAG IS FLIPPED, AND WHY IT IS NOT AN ENV VAR
 * ─────────────────────────────────────────────────────────────────────
 * A LIVE sweep runs one dev server whose environment is fixed at boot,
 * and the stub-file seam is pinned empty on live runs on purpose. So an
 * A/B — the same real model, the same real world, the engine on for one
 * arm and off for the other, in ONE process — needs a per-REQUEST
 * signal. That is the `x-mt-attendance-engine` header, which
 * `src/lib/pipeline/gate.ts` reads only when `MT_TEST_MODE` is exactly
 * "1" and which can only ever choose between two shipped code paths.
 *
 * The baseline arm is the plain `CurrentAnalyzerPipeline`, which sends
 * no header at all and therefore gets the server's own flag — off.
 */
import { CurrentAnalyzerPipeline } from "./current-analyzer-pipeline";
import type { CorpusCase } from "./grade";
import type { CorpusMode } from "./pipeline";

export class AttendanceEnginePipeline extends CurrentAnalyzerPipeline {
  override readonly name = "attendance-engine";

  /** Every request this pipeline makes forces the engine ON. */
  protected override readonly attendanceEngine = true;

  /**
   * LIVE ONLY, deliberately.
   *
   * A stubbed run drives `analyzeBatch`'s seam, and the engine does not
   * call `analyzeBatch` — it calls the router and the extractor, which
   * have their own seams. Grading a "stubbed" run of this pipeline
   * would therefore be grading the analyzer's canned verdicts against
   * an engine that never saw them. The engine's deterministic coverage
   * lives in `src/lib/pipeline/__tests__` (unit) and
   * `e2e/sim/attendance-engine.spec.ts` (end-to-end, stubbed at the
   * router and extractor seams instead).
   */
  override supports(_c: CorpusCase, mode: CorpusMode): boolean {
    return mode === "live";
  }
}

export default AttendanceEnginePipeline;
