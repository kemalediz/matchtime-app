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
import {
  compareToFloor,
  discriminates,
  runsForHalfWidth,
  summariseFloor,
  type ClassFloor,
  type FloorSummary,
} from "./floor";
import { EXCLUSION_TRACTABILITY } from "./reconstruct";
import type { SweepResult } from "./sweep";
import type { ExclusionReason, ReconstructionStats, ReplayCase } from "./types";

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

function ci(f: ClassFloor): string {
  return `${pct(f.rate).padStart(6)}  95% CI [${pct(f.ci95[0])}, ${pct(f.ci95[1])}]`;
}

/**
 * @param cases the replayed cases, so write-level noise can be clustered
 *   by production's own intent label.
 * @param priorFloor a floor measured in an EARLIER self-replay, so a
 *   candidate comparison is stated relative to it rather than as an
 *   absolute the incumbent itself could not meet.
 */
export function renderReport(
  r: SweepResult,
  stats: ReconstructionStats,
  adjudications: Adjudication[],
  cases: ReplayCase[] = [],
  priorFloor?: FloorSummary,
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
  let lost = 0;
  let fixable = 0;
  for (const [reason, n] of Object.entries(stats.byReason).sort(
    (a, b) => b[1].messages - a[1].messages,
  )) {
    const t = EXCLUSION_TRACTABILITY[reason as ExclusionReason];
    if (t?.tractability === "fixable") fixable += n.messages;
    else lost += n.messages;
    L.push(
      `    ${reason.padEnd(26)} ${String(n.batches).padStart(4)} batches / ` +
        `${String(n.messages).padStart(5)} messages   ${t?.tractability ?? "unclassified"}`,
    );
  }
  L.push(
    `  → of the ${stats.messagesExcluded} excluded messages, ${lost} are STRUCTURALLY LOST ` +
      `(state that was never recorded) and ${fixable} are FIXABLE going forward.`,
  );
  for (const [reason, n] of Object.entries(stats.byReason)) {
    const t = EXCLUSION_TRACTABILITY[reason as ExclusionReason];
    if (t?.tractability === "fixable") L.push(`    fix for ${reason} (${n.messages} msgs): ${t.note}`);
  }

  L.push("");
  L.push("intent mix (production's own labels — triage only, never ground truth)");
  const total = Object.values(stats.intentDistributionAll).reduce((a, b) => a + b, 0) || 1;
  for (const [intent, n] of Object.entries(stats.intentDistributionAll).sort((a, b) => b[1] - a[1])) {
    const replayed = stats.intentDistribution[intent] ?? 0;
    L.push(`  ${intent.padEnd(24)} ${String(n).padStart(5)}  ${pct(n / total).padStart(7)}   replayable ${replayed}`);
  }

  const floor = summariseFloor(r.diffs, cases);
  L.push("");
  if (self) {
    L.push(`NOISE FLOOR: ${floor.any.count} of ${floor.runs} identical-pipeline replays disagreed.`);
    L.push(
      "  Same pipeline, same message, same reconstructed world. Every one of these is model " +
        "non-determinism or a harness bug — never a pipeline difference.",
    );
    L.push("");
    L.push("  by class (they mean very different things)");
    L.push(`    ${"any disagreement".padEnd(20)} ${String(floor.any.count).padStart(3)}  ${ci(floor.any)}`);
    for (const c of floor.byClass) {
      L.push(`    ${String(c.cls).padEnd(20)} ${String(c.count).padStart(3)}  ${ci(c)}`);
    }
    L.push(
      `    ${"WRITE-LEVEL".padEnd(20)} ${String(floor.writeLevel.count).padStart(3)}  ` +
        `${ci(floor.writeLevel)}`,
    );
    L.push(
      `    ${"  of which SQUAD PLACE".padEnd(20)} ${String(floor.squadPlace.count).padStart(3)}  ` +
        `${ci(floor.squadPlace)}   <- the one that gates §10 step 3`,
    );
    L.push(
      `    ${"  of which TEAM SPLIT".padEnd(20)} ${String(floor.teamsOnly.count).padStart(3)}  ` +
        `${ci(floor.teamsOnly)}   (the balancer has ties; a different valid split is not a lost place)`,
    );
    L.push("");
    L.push(
      "  speech_only is chattiness — the bot posting the roster on one run and staying silent on " +
        "the other. divergent_write is a player being in or out of a squad depending on luck.",
    );
    L.push(
      "  ⚠️  in a SELF-replay the spurious/missed split is ORIENTATION ONLY: the two sides are the " +
        "same pipeline, so which one is called 'new' is just which ran second. Read the " +
        "WRITE-LEVEL line, not the split — and read the criteria block below the same way.",
    );

    if (floor.writeLevel.count > 0) {
      L.push("");
      L.push("  write-level noise, by production's intent label:");
      for (const [intent, n] of Object.entries(floor.writeClustersByIntent).sort(
        (a, b) => b[1] - a[1],
      )) {
        L.push(`    ${intent.padEnd(24)} ${n}`);
      }
      if (floor.pastedRosterCount > 0) {
        L.push(
          `    ${floor.pastedRosterCount} of ${floor.writeLevel.count} write-level disagreements ` +
            `come from a batch containing a PASTED NUMBERED ROSTER LIST — the same list registering ` +
            `a different subset of names on two runs of the identical world.`,
        );
      }
      const shapeShare = floor.writeLevel.count
        ? floor.pastedRosterCount / floor.writeLevel.count
        : 0;
      L.push(
        `    by intent: ${pct(floor.writeClusterConcentration)} in the biggest intent bucket. ` +
          `by SHAPE: ${pct(shapeShare)} paste a roster list.`,
      );
      L.push(
        `    → ${
          shapeShare >= 0.6 || floor.writeClusterConcentration >= 0.6
            ? "a CLUSTER, which is a named defect worth its own PR, not background noise. Note the " +
              "cluster is a message SHAPE, not an intent label — production's own labels scatter " +
              "these across noise/in/generate_teams_request and would have hidden it."
            : "spread out, which reads as background non-determinism"
        }`,
      );
      L.push(`    keys: ${floor.writeLevelKeys.join(", ")}`);
    }

    L.push("");
    L.push("  what this floor can and cannot settle");
    const bar = MISSED_WRITE_RATE_TARGET;
    L.push(
      `    §10 step 3's ≤${pct(bar)} write bar ${
        discriminates(floor.squadPlace.ci95, bar)
          ? "CAN discriminate: the incumbent's own squad-place floor sits entirely below it."
          : `CANNOT discriminate at this sample size: the incumbent's own squad-place floor ` +
            `reaches ${pct(floor.squadPlace.ci95[1])}, above the bar. A candidate scoring exactly ` +
            `${pct(bar)} could not be told apart from the pipeline we already ship.`
      }`,
    );
    const near = Math.max(floor.squadPlace.rate, 0.01);
    const want = runsForHalfWidth(near, 0.01);
    L.push(
      `    for a ±1.0pp interval on a rate near ${pct(near)} you need ~${want} replays ` +
        `(this run: ${floor.runs}).`,
    );
    const perPairNow = r.cost.old.batches
      ? (r.cost.old.costUsd + r.cost.new.costUsd) / r.cost.old.batches
      : 0;
    L.push(
      `    at the measured ${usd(perPairNow)} per batch pair that is ~${usd(want * perPairNow)}, ` +
        `reachable by raising MT_REPLAY_RUNS over the same ${r.plan.total} batches.`,
    );
    L.push("");
  }

  if (!self && priorFloor) {
    L.push("");
    L.push("candidate vs the incumbent's own floor (the criteria are RELATIVE, not absolute)");
    L.push(
      `  candidate squad-place divergence ${pct(floor.squadPlace.rate)} against an incumbent floor ` +
        `of ${pct(priorFloor.squadPlace.rate)} 95% CI [${pct(priorFloor.squadPlace.ci95[0])}, ` +
        `${pct(priorFloor.squadPlace.ci95[1])}] → ${compareToFloor(
          floor.squadPlace.rate,
          priorFloor.squadPlace,
        ).toUpperCase()}`,
    );
    L.push(
      "  A candidate BELOW the incumbent's floor is better, not a regression. Inside the interval " +
        "is indistinguishable, and saying so beats reporting a difference that is noise.",
    );
    L.push("");
  }

  if (self) {
    L.push("");
    L.push(
      "criteria block below: in a self-replay these are NOT candidate defects. They are the " +
        "incumbent disagreeing with itself, arbitrarily labelled by run order.",
    );
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
  const pairs = r.cost.old.batches;
  const perPair = pairs ? (r.cost.old.costUsd + r.cost.new.costUsd) / pairs : 0;
  L.push(
    `  → one full sweep of all ${r.plan.total} replayable batches, both pipelines: ` +
      `${usd(perPair * r.plan.total)} at the measured rate (${usd(perPair)} per batch pair)`,
  );
  if (self) {
    L.push(
      "  ⚠️  the split between the two columns is a PROMPT-CACHE artefact, not a difference: the " +
        "first pipeline pays the cache WRITE and the second reads it back at 0.1x. Only the sum " +
        "is meaningful in a self-replay.",
    );
  }

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
