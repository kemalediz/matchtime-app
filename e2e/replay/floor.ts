/**
 * The noise floor — the number every other number is read against.
 *
 * PURE. Unit-tested by `floor.test.ts` under `npm run test:unit`.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT A FOOTNOTE
 * ─────────────────────────────────────────────────────────────────────
 * Replaying the current analyzer against ITSELF — same message, same
 * reconstructed world, same chat history — does not always produce the
 * same answer. Some of that is chattiness: one run posts the roster, the
 * other stays silent. Some of it is not. On the first sweep the same
 * pipeline produced DIFFERENT ATTENDANCE OUTCOMES on two runs of one
 * batch: a player in or out of a squad depending on luck.
 *
 * That reframes §10 step 3. "≤2% where it would miss a write the old one
 * correctly made" is meaningless as an ABSOLUTE if the incumbent cannot
 * reproduce its own writes at some rate above zero. A candidate scoring
 * 1% against a 2% incumbent floor is BETTER, not a regression. And if
 * the floor's interval straddles the 2% bar, the criterion cannot
 * discriminate at all — which is a finding, not a failure to measure.
 *
 * So the floor is reported PER CLASS, each with an interval, and the
 * criteria are stated relative to it.
 */
import type { CaseDiff, DisagreementClass } from "./diff";
import type { ReplayCase } from "./types";

/** Disagreement classes that mean "the database ended up different". */
export const WRITE_LEVEL_CLASSES: DisagreementClass[] = [
  "spurious_write",
  "missed_write",
  "divergent_write",
];

export interface ClassFloor {
  cls: DisagreementClass | "any" | "write-level";
  count: number;
  runs: number;
  rate: number;
  /** Wilson score interval. A point estimate off 80 runs is not a fact. */
  ci95: [number, number];
}

export interface FloorSummary {
  runs: number;
  errors: number;
  byClass: ClassFloor[];
  any: ClassFloor;
  /** spurious + missed + divergent, any write surface. */
  writeLevel: ClassFloor;
  /**
   * The dangerous half: a squad PLACE differing — an attendance row, a
   * provisioned member, a bench offer. This is the one §10 step 3 is
   * actually about, and the one that can put a player at a pitch with no
   * slot.
   */
  squadPlace: ClassFloor;
  /**
   * The other half: the same squad, allocated to teams differently. The
   * balancer has ties; a different valid split is not a lost place.
   * Reported so it can never inflate the number above.
   */
  teamsOnly: ClassFloor;
  /** Write-level disagreements whose batch contains a pasted numbered
   *  roster list — the shape that turned out to carry all of them. */
  pastedRosterCount: number;
  /** Where the write-level disagreements sit, by production's own intent
   *  label. Concentration is the tell: spread means background
   *  non-determinism, a cluster means a NAMED DEFECT. */
  writeClustersByIntent: Record<string, number>;
  /** Share of write-level disagreements in the single biggest cluster. */
  writeClusterConcentration: number;
  /** Keys of the write-level disagreements, for the triage cards. */
  writeLevelKeys: string[];
}

/**
 * Wilson score interval — correct at the edges, where a normal
 * approximation puts the lower bound below zero and implies 0/80 proves
 * 0%. It does not: 0/80 still reaches ~4.5%.
 */
export function wilson(k: number, n: number, z = 1.959963985): [number, number] {
  if (n <= 0) return [0, 1];
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

function classFloor(cls: ClassFloor["cls"], count: number, runs: number): ClassFloor {
  return { cls, count, runs, rate: runs ? count / runs : 0, ci95: wilson(count, runs) };
}

/**
 * Does this message paste a numbered squad list into the group?
 *
 * Not decoration. Every attendance-level write disagreement in the first
 * self-replay sweep came from a batch containing one of these: the same
 * pasted list registered a DIFFERENT subset of names on two runs of the
 * identical world. Detecting the shape makes the cluster show up in the
 * report instead of only to whoever reads the triage cards.
 */
export function looksLikePastedRoster(body: string): boolean {
  const numbered = body.match(/^\s*\d{1,2}[.)]\s*\S/gm);
  return (numbered?.length ?? 0) >= 4;
}

export function summariseFloor(diffs: CaseDiff[], cases: ReplayCase[]): FloorSummary {
  const byKey = new Map(cases.map((c) => [c.key, c]));
  const measured = diffs.filter((d) => d.primary !== "error");
  const runs = measured.length;

  const counts = new Map<DisagreementClass, number>();
  let anyCount = 0;
  let writeCount = 0;
  let squadPlaceCount = 0;
  let teamsOnlyCount = 0;
  let pastedRosterCount = 0;
  const clusters: Record<string, number> = {};
  const writeLevelKeys: string[] = [];

  for (const d of measured) {
    if (!d.agree) anyCount += 1;
    for (const c of d.classes) counts.set(c, (counts.get(c) ?? 0) + 1);
    if (d.classes.some((c) => WRITE_LEVEL_CLASSES.includes(c))) {
      writeCount += 1;
      writeLevelKeys.push(d.key);
      const place =
        d.differsOn.attendance || d.differsOn.members || d.differsOn.benchOffers || d.differsOn.score;
      if (place) squadPlaceCount += 1;
      else if (d.differsOn.teams) teamsOnlyCount += 1;
      const rc = byKey.get(d.key);
      if (rc && rc.case.messages.some((m) => looksLikePastedRoster(m.body))) pastedRosterCount += 1;
      const meta = rc?.meta;
      const intent =
        meta?.prodOutcomes.map((o) => o.intent ?? "(null)").find((i) => i !== "noise") ??
        meta?.prodOutcomes[0]?.intent ??
        "(unknown)";
      clusters[intent] = (clusters[intent] ?? 0) + 1;
    }
  }

  const biggest = Math.max(0, ...Object.values(clusters));

  return {
    runs,
    errors: diffs.length - runs,
    byClass: [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cls, n]) => classFloor(cls, n, runs)),
    any: classFloor("any", anyCount, runs),
    writeLevel: classFloor("write-level", writeCount, runs),
    squadPlace: classFloor("write-level", squadPlaceCount, runs),
    teamsOnly: classFloor("write-level", teamsOnlyCount, runs),
    pastedRosterCount,
    writeClustersByIntent: clusters,
    writeClusterConcentration: writeCount ? biggest / writeCount : 0,
    writeLevelKeys,
  };
}

/**
 * Where a candidate's rate sits against the incumbent's own floor.
 * "indistinguishable" is the honest answer far more often than either
 * side of it, and saying so beats reporting a difference that is inside
 * the interval.
 */
export function compareToFloor(
  candidateRate: number,
  floor: ClassFloor,
): "better" | "indistinguishable" | "worse" {
  if (candidateRate < floor.ci95[0]) return "better";
  if (candidateRate > floor.ci95[1]) return "worse";
  return "indistinguishable";
}

/**
 * Can a target like §10 step 3's ≤2% discriminate at all? Only if the
 * incumbent's own floor is credibly BELOW it — the whole interval under
 * the bar. Otherwise a candidate that hits the bar exactly cannot be
 * told apart from the pipeline we already ship.
 */
export function discriminates(floorCi: [number, number], target: number): boolean {
  return floorCi[1] <= target;
}

/**
 * Replays needed for a ±`halfWidth` interval on a rate near `p`.
 * Rounded up. Answers "would more runs tighten this?" with arithmetic
 * instead of a shrug.
 */
export function runsForHalfWidth(p: number, halfWidth: number, z = 1.959963985): number {
  if (halfWidth <= 0) return Infinity;
  return Math.ceil((z * z * p * (1 - p)) / (halfWidth * halfWidth));
}
