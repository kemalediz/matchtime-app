/**
 * Reporting — human-readable and machine-readable.
 *
 * PURE (string in, string out). The JSON twin is just the SweepResult
 * plus the reconstruction stats, written by the spec to `.e2e/replay/`.
 *
 * Two rules this file enforces, both learned from numbers that got
 * repeated in a funding document after nobody read the caveat:
 *
 *  · a PARTIAL run says so on its first line, with what it dropped;
 *  · an unadjudicated sweep renders UNDECIDED, never PASS.
 */
import type { Adjudication, CaseDiff, Criteria } from "./diff";
import { MISSED_WRITE_RATE_TARGET, SPURIOUS_WRITE_TARGET } from "./diff";
import type { SweepResult } from "./sweep";
import type { ReconstructionStats, ReplayCase } from "./types";

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const usd = (n: number) => `$${n.toFixed(4)}`;

function isSelfReplay(r: SweepResult): boolean {
  return r.pipelines.old === r.pipelines.new;
}

function criteriaBlock(c: Criteria, label: string): string[] {
  const lines: string[] = [];
  lines.push(`${label}`);
  lines.push(`  measured runs               ${c.runs}   (errors excluded: ${c.errors})`);
  lines.push(`  disagreements               ${c.disagreements}  (${c.runs ? pct(c.disagreements / c.runs) : "—"})`);
  lines.push(
    `  spurious writes (adjudicated) ${c.spuriousWriteRuns}  target ${SPURIOUS_WRITE_TARGET}` +
      `   · unadjudicated ${c.spuriousWriteUnadjudicated}`,
  );
  lines.push(
    `  missed writes  (adjudicated) ${c.missedWriteRuns} = ${pct(c.missedWriteRate)}  ` +
      `target ≤${pct(MISSED_WRITE_RATE_TARGET)}   · unadjudicated ${c.missedWriteUnadjudicated} ` +
      `(ceiling ${pct(c.missedWriteRateCeiling)})`,
  );
  lines.push(`  divergent writes            ${c.divergentWriteRuns}`);
  lines.push(`  speech-only differences     ${c.speechOnlyRuns}`);
  lines.push(
    `  human verdicts              new better ${c.newPipelineBetter} · both wrong ${c.bothWrong} · ` +
      `both right ${c.bothRight}`,
  );
  lines.push(
    `  → §10 step 3: ${
      c.passesStep3 === null
        ? "UNDECIDED — disagreements remain unadjudicated, and the incumbent is not ground truth"
        : c.passesStep3
          ? "PASSES on the adjudicated evidence"
          : "FAILS"
    }`,
  );
  return lines;
}

export function renderReport(
  r: SweepResult,
  stats: ReconstructionStats,
  adjudications: Adjudication[],
): string {
  const L: string[] = [];
  const self = isSelfReplay(r);

  L.push("");
  L.push("══ HISTORY REPLAY ═══════════════════════════════════════════════");
  L.push(
    self
      ? `SELF-REPLAY NOISE FLOOR — "${r.pipelines.old}" against itself`
      : `${r.pipelines.old}  →  ${r.pipelines.new}`,
  );
  L.push(
    `run ${r.runId} · mode ${r.mode} · ${r.runsPerCase} repeat(s) per batch · ` +
      `${r.startedAt} → ${r.finishedAt}` +
      (r.resumedUnits ? ` · ${r.resumedUnits} unit(s) resumed from the ledger` : ""),
  );

  if (r.plan.partial) {
    L.push("");
    L.push("⚠️  PARTIAL RUN — these numbers do NOT describe the whole history.");
    L.push(
      `    ${r.plan.selected.length} of ${r.plan.total} replayable batches were run; ` +
        `${r.plan.total - r.plan.selected.length} batches were NOT replayed.`,
    );
    L.push(
      `    selection: ${r.plan.strategy}, seed ${r.plan.seed}, cap ${r.plan.limit} — ` +
        `stratified by production's own intent label so a cap cannot fill itself with noise.`,
    );
    const strata = Object.entries(r.plan.strata)
      .sort((a, b) => b[1].available - a[1].available)
      .map(([k, v]) => `${k} ${v.selected}/${v.available}`)
      .join(" · ");
    L.push(`    strata: ${strata}`);
  }

  L.push("");
  L.push("replayability");
  L.push(
    `  ${stats.messagesReplayable} of ${stats.messagesInSource} production messages are replayable ` +
      `(${pct(stats.messagesReplayable / Math.max(1, stats.messagesInSource))}), ` +
      `in ${stats.batchesReplayable} of ${stats.batchesInSource} analyze batches`,
  );
  L.push(`  tiers: strict ${stats.byTier.strict} · wide ${stats.byTier.wide}`);
  L.push("  excluded, by reason (a world that cannot be proven is never guessed):");
  for (const [reason, n] of Object.entries(stats.byReason).sort(
    (a, b) => b[1].messages - a[1].messages,
  )) {
    L.push(`    ${reason.padEnd(26)} ${n.batches} batches / ${n.messages} messages`);
  }

  L.push("");
  L.push("intent mix (production's own labels — triage only, never ground truth)");
  const total = Object.values(stats.intentDistributionAll).reduce((a, b) => a + b, 0) || 1;
  for (const [intent, n] of Object.entries(stats.intentDistributionAll).sort((a, b) => b[1] - a[1])) {
    const replayed = stats.intentDistribution[intent] ?? 0;
    L.push(`  ${intent.padEnd(24)} ${String(n).padStart(5)}  ${pct(n / total).padStart(7)}   replayable ${replayed}`);
  }

  L.push("");
  if (self) {
    const floor = r.criteria.runs ? r.criteria.disagreements / r.criteria.runs : 0;
    L.push(
      `NOISE FLOOR: ${r.criteria.disagreements} of ${r.criteria.runs} identical-pipeline replays ` +
        `disagreed — ${pct(floor)}.`,
    );
    L.push(
      "  Every one of those is model non-determinism or a harness bug, not a pipeline difference. " +
        "No comparison below this number means anything.",
    );
    const writeFloor = r.criteria.runs
      ? (r.criteria.spuriousWriteUnadjudicated +
          r.criteria.spuriousWriteRuns +
          r.criteria.missedWriteUnadjudicated +
          r.criteria.missedWriteRuns +
          r.criteria.divergentWriteRuns) /
        r.criteria.runs
      : 0;
    L.push(`  of which WRITE-level: ${pct(writeFloor)} — the number that gates §10 step 3.`);
    L.push("");
  }

  L.push(...criteriaBlock(r.criteria, "criteria — all replayed batches"));
  if (r.byTier.wide > 0) {
    L.push("");
    L.push(...criteriaBlock(r.criteriaStrict, "criteria — strict-tier batches only"));
  }

  L.push("");
  L.push("cost and latency, measured (§8.2 for comparison: $0.0300–$0.0389 and 7.8–18.6 s per batch)");
  for (const side of [r.cost.old, r.cost.new]) {
    const perBatch = side.batches ? side.costUsd / side.batches : 0;
    const msPer = side.batches ? side.wallMs / side.batches : 0;
    L.push(
      `  ${side.name.padEnd(22)} ${side.batches} batches · ${usd(side.costUsd)} total · ` +
        `${usd(perBatch)}/batch · ${(msPer / 1000).toFixed(1)} s/batch`,
    );
    L.push(
      `  ${"".padEnd(22)} ${side.calls} model calls · in ${side.inputTokens} · out ${side.outputTokens} · ` +
        `cache read ${side.cacheReadTokens} · cache write ${side.cacheWriteTokens}`,
    );
  }
  const fullSweep = r.plan.total * (r.cost.old.batches ? r.cost.old.costUsd / r.cost.old.batches : 0);
  L.push(
    `  → one full sweep of all ${r.plan.total} replayable batches, both pipelines: ` +
      `${usd(fullSweep * 2)} at the measured rate`,
  );

  L.push("");
  L.push(`adjudications on file: ${adjudications.length}`);
  L.push(`ledger: ${r.ledgerFile}`);
  L.push("═════════════════════════════════════════════════════════════════");
  return L.join("\n");
}

/**
 * One card per disagreement, with everything a human needs to answer
 * "which one was RIGHT?" without opening the database — and a line to
 * paste back as an adjudication.
 */
export function renderTriage(diffs: CaseDiff[], cases: ReplayCase[]): string {
  const byKey = new Map(cases.map((c) => [c.key, c]));
  const bad = diffs.filter((d) => !d.agree);
  if (!bad.length) return "# Triage\n\nno disagreements.\n";

  const L: string[] = ["# Triage", ""];
  L.push(
    "Production's own intent label is shown as a hint. It is **not ground truth** — the " +
      "incumbent has shipped wrong verdicts to real groups. The question on every card is " +
      "which pipeline was RIGHT, not which one matched the old one.",
  );
  L.push("");
  L.push("Record a verdict per case as one JSONL line in `adjudications.jsonl`:");
  L.push('`{"key":"<key>","verdict":"old_right|new_right|both_wrong|both_right","note":"why"}`');
  L.push("");

  for (const d of bad.sort((a, b) => (a.primary ?? "").localeCompare(b.primary ?? ""))) {
    const c = byKey.get(d.key);
    L.push(`## ${d.primary} — \`${d.key}\``);
    if (c) {
      const w = c.meta;
      L.push(
        `${w.at} · ${w.hoursToKickoff.toFixed(1)}h to kickoff · ${w.squadBefore.confirmed} confirmed, ` +
          `${w.squadBefore.bench} bench, ${w.squadBefore.dropped} dropped of ${w.maxPlayers} · tier ${w.tier}`,
      );
      if (w.caveats.length) L.push(`> caveat: ${w.caveats.join("; ")}`);
      L.push("");
      L.push("messages:");
      for (const m of c.case.messages) {
        const who = typeof m.from === "string" ? m.from : (m.from.name ?? "(unknown)");
        L.push(`  - **${who}**: ${m.body}`);
      }
      L.push(
        `production's label (not ground truth): ` +
          w.prodOutcomes.map((o) => `${o.intent ?? "—"}/${o.action ?? "—"} via ${o.handledBy}`).join(", "),
      );
    }
    L.push("");
    L.push(`| | ${d.key} old | new |`);
    L.push("|---|---|---|");
    L.push(
      `| attendance writes | ${fmtDeltas(d.writesOld.attendance)} | ${fmtDeltas(d.writesNew.attendance)} |`,
    );
    L.push(
      `| new members | ${d.writesOld.newMembers.join(", ") || "—"} | ${d.writesNew.newMembers.join(", ") || "—"} |`,
    );
    L.push(`| spoke | ${d.speechOld.posts} post(s) | ${d.speechNew.posts} post(s) |`);
    L.push(
      `| names | ${d.speechOld.namesMentioned.join(", ") || "—"} | ${d.speechNew.namesMentioned.join(", ") || "—"} |`,
    );
    L.push(
      `| claims a move it did not make | ${fmtClaims(d.speechOld.claimsMismatch)} | ${fmtClaims(d.speechNew.claimsMismatch)} |`,
    );
    L.push(`| raw phone in text | ${d.speechOld.rawPhone} | ${d.speechNew.rawPhone} |`);
    L.push("");
    if (d.spokenOld.length) L.push(`old said: ${d.spokenOld.map((s) => JSON.stringify(s)).join(" ")}`);
    if (d.spokenNew.length) L.push(`new said: ${d.spokenNew.map((s) => JSON.stringify(s)).join(" ")}`);
    if (d.errors.old) L.push(`old ERRORED: ${d.errors.old}`);
    if (d.errors.new) L.push(`new ERRORED: ${d.errors.new}`);
    L.push("");
    L.push(`\`{"key":"${d.key}","verdict":"old_right","note":""}\``);
    L.push("");
  }
  return L.join("\n");
}

function fmtDeltas(rows: Array<{ name: string; from: string; to: string }>): string {
  return rows.map((r) => `${r.name} ${r.from}→${r.to}`).join("; ") || "—";
}

function fmtClaims(rows: Array<{ name: string; claimed: string; actual: string }>): string {
  return rows.map((r) => `${r.name} claimed ${r.claimed}, db says ${r.actual}`).join("; ") || "—";
}
