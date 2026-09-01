/**
 * The adapter boundary.
 *
 * A "pipeline" is anything that can take a corpus case — the world, the
 * chat history, the messages — and report what happened to the database
 * and what MatchTime said. Today there is exactly one implementation,
 * wrapping the current mega-prompt analyzer. Step 2 of the redesign adds
 * a second (router → extractors → engine in dry-run) and the SAME cases
 * judge both.
 *
 * That is the whole point, so keep this interface free of anything
 * specific to how today's analyzer works: no `AnalysisVerdict`, no
 * intents, no `reasoning`. A pipeline that never produces a verdict must
 * still be able to implement it.
 */
import type { APIRequestContext } from "@playwright/test";
import type { TestDb } from "../helpers/test-db";
import type { CorpusCase, CorpusObservation } from "./grade";

export type CorpusMode = "stub" | "live";

export interface PipelineContext {
  request: APIRequestContext;
  db: TestDb;
}

export interface CorpusPipeline {
  /** Shown in the scoreboard and the machine-readable report. */
  readonly name: string;
  /** Can this pipeline replay this case in this mode? A stubbed run
   *  needs the case to carry stub verdicts; a live run needs a key. */
  supports(c: CorpusCase, mode: CorpusMode): boolean;
  /** Replay the case against a FRESH world and report what happened. */
  run(ctx: PipelineContext, c: CorpusCase, mode: CorpusMode): Promise<CorpusObservation>;
}
