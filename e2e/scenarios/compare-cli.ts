/**
 * npm run scenarios:compare -- <dirA> <dirB> [--names main,refactor] [--out report.md]
 *
 * Compares every `<club>.transcript.json` the two directories share and
 * prints, per club and per step, what each side sent and wrote where they
 * differ (compare.ts). Exit code 0 when every club is identical, 1 when
 * anything differs, 2 on a usage error.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compareTranscripts, renderComparison } from "./compare";
import type { ClubTranscript } from "./normalise";

function main(argv: string[]): number {
  const args = [...argv];
  const opt = (name: string): string | null => {
    const i = args.indexOf(name);
    if (i < 0) return null;
    const v = args[i + 1];
    args.splice(i, 2);
    return v ?? null;
  };
  const out = opt("--out");
  const namesArg = opt("--names");
  const [dirA, dirB] = args;
  if (!dirA || !dirB || !existsSync(dirA) || !existsSync(dirB)) {
    console.error("usage: npm run scenarios:compare -- <dirA> <dirB> [--names a,b] [--out report.md]");
    return 2;
  }
  const [na, nb] = (namesArg ?? `${path.basename(path.resolve(dirA))},${path.basename(path.resolve(dirB))}`).split(",");
  const list = (d: string) => readdirSync(d).filter((f) => f.endsWith(".transcript.json"));
  const a = new Set(list(dirA));
  const b = new Set(list(dirB));
  const shared = [...a].filter((f) => b.has(f)).sort();
  for (const f of [...a].filter((x) => !b.has(x))) console.log(`only in ${na}: ${f}`);
  for (const f of [...b].filter((x) => !a.has(x))) console.log(`only in ${nb}: ${f}`);
  const read = (d: string, f: string) => JSON.parse(readFileSync(path.join(d, f), "utf8")) as ClubTranscript;
  const comparisons = shared.map((f) => compareTranscripts(read(dirA, f), read(dirB, f)));
  const md = renderComparison(comparisons, { a: na, b: nb });
  if (out) writeFileSync(out, `${md}\n`);
  for (const c of comparisons)
    console.log(`${c.club}: ${c.identical ? "identical" : `${c.differingSteps.length} of ${c.stepsCompared} step(s) differ, final state ${c.final.onlyA.length + c.final.onlyB.length + c.final.changed.length} difference(s)`}`);
  if (!out) console.log(`\n${md}`);
  else console.log(`report: ${out}`);
  return comparisons.every((c) => c.identical) && a.size === b.size && shared.length === a.size ? 0 : 1;
}

process.exit(main(process.argv.slice(2)));
