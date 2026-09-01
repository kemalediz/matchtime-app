/**
 * The resume ledger.
 *
 * A live sweep over 4.5 months of traffic is long and costs real money.
 * It must never restart from zero because of one timeout — the corpus
 * harness learned that when a single bad fixture killed a paid sweep 12
 * cases in.
 *
 * Append-only JSONL, one line per COMPLETED unit (one case × one
 * pipeline × one repeat). Restarting reads it back and skips those
 * units. A truncated final line — the shape a `kill -9` leaves — is
 * skipped, not fatal.
 *
 * The ledger lives under `.e2e/replay/<runId>/` (gitignored). `runId` is
 * derived from the sweep's SHAPE (pipelines, repeats, mode, the exact
 * set of case keys), so resuming can only ever join a sweep that is
 * genuinely the same one; change the shape and you get a fresh ledger
 * rather than a silent mix of two runs.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { CorpusObservation } from "../corpus/grade";

export interface LedgerEntry {
  /** `${caseKey}|${pipeline}|${run}` */
  unit: string;
  key: string;
  pipeline: string;
  run: number;
  ok: boolean;
  error?: string;
  observation?: CorpusObservation;
  /** Measured, not estimated — see meter.ts. */
  costUsd?: number;
  ms?: number;
  at: string;
}

export function unitId(key: string, pipeline: string, run: number): string {
  return `${key}|${pipeline}|${run}`;
}

export function runIdOf(shape: {
  pipelines: string[];
  runs: number;
  caseKeys: string[];
  mode: string;
}): string {
  const canonical = JSON.stringify({
    pipelines: shape.pipelines,
    runs: shape.runs,
    mode: shape.mode,
    cases: [...shape.caseKeys].sort(),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

export class Ledger {
  constructor(readonly file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
  }

  load(): Map<string, LedgerEntry> {
    const out = new Map<string, LedgerEntry>();
    if (!existsSync(this.file)) return out;
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as LedgerEntry;
        if (entry && typeof entry.unit === "string") out.set(entry.unit, entry);
      } catch {
        // A half-written final line is what a killed process leaves.
        // Losing one unit costs one replay; refusing to load costs the
        // whole sweep.
      }
    }
    return out;
  }

  append(entry: LedgerEntry): void {
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
  }
}
