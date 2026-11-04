/**
 * COMPARE TWO RUNS OF THE CLUB SCENARIOS, step by step. Pure: no I/O.
 *
 * Each side is a directory of `<club>.transcript.json` files (normalise.ts).
 * For every club and every scenario step, what MatchTime SENT (group, admin
 * group, DMs, polls, reactions, tags), how it HANDLED each message, what it
 * WROTE (the database changes) and any ERRORS are lined up; a step where the
 * two sides differ is printed with both sides next to each other.
 */
import type { ClubTranscript, OutMessage, TranscriptStep } from "./normalise";

export interface AlignedLine {
  a: string | null;
  b: string | null;
  same: boolean;
}

/** Line alignment by longest common subsequence; unmatched runs are paired up side by side. */
export function alignLines(a: string[], b: string[]): AlignedLine[] {
  const n = a.length;
  const m = b.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: AlignedLine[] = [];
  let i = 0;
  let j = 0;
  let pa: string[] = [];
  let pb: string[] = [];
  const flush = () => {
    for (let k = 0; k < Math.max(pa.length, pb.length); k++) out.push({ a: pa[k] ?? null, b: pb[k] ?? null, same: false });
    pa = [];
    pb = [];
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      out.push({ a: a[i], b: b[j], same: true });
      i++;
      j++;
    } else if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) pa.push(a[i++]);
    else pb.push(b[j++]);
  }
  flush();
  return out;
}

function outLine(o: OutMessage): string {
  const extra = [
    o.instruction ? `via ${o.instruction}` : o.via ? `via ${o.via}` : "",
    o.mentions?.length ? `tags ${o.mentions.map((x) => `@${x}`).join(" ")}` : "",
    o.replyTo ? `re ${o.replyTo}` : "",
    o.image ? `image ${o.image}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  return `SENT ${o.at} ${o.to} ${o.kind}: ${o.text.replace(/\n/g, " ⏎ ")}${extra ? ` [${extra}]` : ""}`;
}

/** Everything a step did, one line each, in a fixed order. */
export function stepLines(s: TranscriptStep): string[] {
  return [
    ...s.handled.map((h) => `HANDLED ${h}`),
    ...s.out.map(outLine),
    ...s.db.map((d) => `DB ${d}`),
    ...s.errors.map((e) => `ERROR ${e}`),
  ];
}

export interface StepComparison {
  seq: number;
  step: string;
  lines: AlignedLine[];
}

export interface ClubComparison {
  club: string;
  title: string;
  identical: boolean;
  differingSteps: StepComparison[];
  /** Steps whose scenario line differs: the two sides did not play the same file. */
  scenarioMismatch: number[];
  final: { onlyA: string[]; onlyB: string[]; changed: Array<{ key: string; a: string; b: string }> };
  stepsCompared: number;
}

export function compareTranscripts(a: ClubTranscript, b: ClubTranscript): ClubComparison {
  const bySeq = (t: ClubTranscript) => new Map(t.steps.map((s) => [s.seq, s]));
  const A = bySeq(a);
  const B = bySeq(b);
  const seqs = [...new Set([...A.keys(), ...B.keys()])].sort((x, y) => x - y);
  const empty = (seq: number): TranscriptStep => ({ seq, step: "(absent)", out: [], handled: [], db: [], errors: [] });
  const differingSteps: StepComparison[] = [];
  const scenarioMismatch: number[] = [];
  for (const seq of seqs) {
    const sa = A.get(seq) ?? empty(seq);
    const sb = B.get(seq) ?? empty(seq);
    if (sa.step !== sb.step) scenarioMismatch.push(seq);
    const lines = alignLines(stepLines(sa), stepLines(sb));
    if (lines.some((l) => !l.same) || sa.step !== sb.step) differingSteps.push({ seq, step: sa.step === sb.step ? sa.step : `${sa.step}  ≠  ${sb.step}`, lines });
  }
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  const changed: Array<{ key: string; a: string; b: string }> = [];
  for (const k of [...new Set([...Object.keys(a.final), ...Object.keys(b.final)])].sort()) {
    if (!(k in b.final)) onlyA.push(`${k} = ${a.final[k]}`);
    else if (!(k in a.final)) onlyB.push(`${k} = ${b.final[k]}`);
    else if (a.final[k] !== b.final[k]) changed.push({ key: k, a: a.final[k], b: b.final[k] });
  }
  const finalSame = !onlyA.length && !onlyB.length && !changed.length;
  return {
    club: a.club,
    title: a.title,
    identical: differingSteps.length === 0 && finalSame,
    differingSteps,
    scenarioMismatch,
    final: { onlyA, onlyB, changed },
    stepsCompared: seqs.length,
  };
}

const cell = (s: string | null) => (s === null ? "" : s.replace(/\|/g, "\\|"));

export function renderComparison(clubs: ClubComparison[], names: { a: string; b: string }): string {
  const out: string[] = [`# Club scenarios: ${names.a} vs ${names.b}`, ""];
  out.push(`| club | steps | differing steps | final state differences |`, `|---|---|---|---|`);
  for (const c of clubs)
    out.push(`| ${c.club} | ${c.stepsCompared} | ${c.differingSteps.length} | ${c.final.onlyA.length + c.final.onlyB.length + c.final.changed.length} |`);
  out.push("");
  for (const c of clubs) {
    if (c.identical) {
      out.push(`## ${c.club}: identical`, "", `${c.title}: every step sent and wrote the same on both sides.`, "");
      continue;
    }
    out.push(`## ${c.club}: ${c.differingSteps.length} step(s) differ`, "", c.title, "");
    if (c.scenarioMismatch.length) out.push(`WARNING: the two sides played different scenario lines at step(s) ${c.scenarioMismatch.join(", ")}.`, "");
    for (const s of c.differingSteps) {
      out.push(`### step ${s.seq}: ${s.step}`, "", `| ${names.a} | ${names.b} |`, `|---|---|`);
      for (const l of s.lines) out.push(l.same ? `| ${cell(l.a)} | (same) |` : `| **${cell(l.a)}** | **${cell(l.b)}** |`);
      out.push("");
    }
    const f = c.final;
    if (f.onlyA.length || f.onlyB.length || f.changed.length) {
      out.push(`### final database state`, "", `| key | ${names.a} | ${names.b} |`, `|---|---|---|`);
      for (const x of f.onlyA) out.push(`| ${cell(x.split(" = ")[0])} | ${cell(x.split(" = ").slice(1).join(" = "))} | (absent) |`);
      for (const x of f.onlyB) out.push(`| ${cell(x.split(" = ")[0])} | (absent) | ${cell(x.split(" = ").slice(1).join(" = "))} |`);
      for (const x of f.changed) out.push(`| ${cell(x.key)} | ${cell(x.a)} | ${cell(x.b)} |`);
      out.push("");
    }
  }
  return out.join("\n");
}
