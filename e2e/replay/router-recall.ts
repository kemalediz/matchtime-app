/**
 * ROUTER RECALL ON REAL TRAFFIC — the evidence §10 step 5 turns on.
 *
 * The saving is easy and boring: 69.3% of 1,723 production messages are
 * noise, so a router that says `none` to most of them stops paying the
 * 18,315-token prompt to look at them. **The number that decides whether
 * this ships is the other one: how many NON-NOISE messages the router
 * routes `none`.** Each of those is a message the gate would delete
 * before the analyzer ever saw it. One wrongly-routed `in` is a finding.
 *
 * PURE. No model, no DB, no network — `route-recall-live.ts` does the
 * calling and hands the answers here. Unit-tested by
 * `router-recall.test.ts` under `npm run test:unit`.
 *
 * ─────────────────────────────────────────────────────────────────────
 * PRODUCTION'S `intent` IS NOT GROUND TRUTH
 * ─────────────────────────────────────────────────────────────────────
 *
 * `types.ts` says it out loud about the same column: *"What the LIVE
 * analyzer did at the time. Triage signal ONLY — the incumbent is not
 * ground truth."* On 2026-08-30 the incumbent told a real customer group
 * that three named players would be benched when nobody would be. So
 * this module never reports "the router was wrong". It reports
 * DISAGREEMENTS, grouped by what the incumbent called them and sorted so
 * the dangerous ones come first, and a human writes the verdict.
 *
 * The severity ordering is not cosmetic. It is the order in which a
 * disagreement can hurt someone:
 *
 *   squad_place  in · out · conditional_in · conditional_out ·
 *                replacement_request · team_swap · bring_guests_vague
 *                — a player's slot. This is the one that matters.
 *   action       generate_teams_request · score · reminder_request ·
 *                recruit_* · show_teams_request · stats_* — the bot
 *                fails to do something it was asked to do.
 *   speech       question · rating_progress — the bot stays quiet where
 *                it would have answered. Annoying, not dangerous.
 *   benign       noise · unclear · non-c.us author — the saving, or a
 *                message the incumbent could not read either.
 */
import type { RawMessage } from "./types";

export type Severity = "squad_place" | "action" | "speech" | "benign";

/** Production `intent` → how much it costs to route that message
 *  `none`. Anything unrecognised is treated as `action`, not `benign`:
 *  an unknown label must never be silently downgraded to "safe". */
export const SEVERITY_BY_INTENT: Record<string, Severity> = {
  in: "squad_place",
  out: "squad_place",
  conditional_in: "squad_place",
  conditional_out: "squad_place",
  replacement_request: "squad_place",
  team_swap: "squad_place",
  bring_guests_vague: "squad_place",

  generate_teams_request: "action",
  show_teams_request: "action",
  score: "action",
  reminder_request: "action",
  recruit_recent: "action",
  recruit_denied: "action",
  stats_blast_denied: "action",

  question: "speech",
  rating_progress: "speech",

  noise: "benign",
  unclear: "benign",
  "non-c.us author": "benign",
};

export const SEVERITY_ORDER: Severity[] = ["squad_place", "action", "speech", "benign"];

export function severityOf(intent: string | null): Severity {
  if (!intent) return "benign";
  return SEVERITY_BY_INTENT[intent] ?? "action";
}

/** Intents the incumbent itself treated as "nothing to do here". A
 *  `none` route on one of these is the SAVING, not a miss. */
export function isBenignIntent(intent: string | null): boolean {
  return severityOf(intent) === "benign";
}

// ── Input ─────────────────────────────────────────────────────────────

export interface RoutedRow {
  waMessageId: string;
  groupRef: string;
  body: string;
  /** Production's own label. Triage signal only. */
  intent: string | null;
  /** Production's `handledBy`. `fast-path` messages never reached the
   *  analyzer even today, so a `none` route on one costs nothing. */
  handledBy: string;
  createdAt: string;
  /** What the router said. */
  route: string;
  /** `model` · `fallback` · `floor`. */
  source: string;
  /** When `source` is `floor`, the route the MODEL gave. A RESCUE is
   *  specifically `overrodeRoute === "none"` — the seatbelt firing.
   *  Counting `source === "floor"` instead counts every relabel and
   *  flatters the floor: the first full sweep reported 136 "rescues"
   *  against a true count of 0. */
  overrodeRoute?: string;
}

// ── Output ────────────────────────────────────────────────────────────

export interface Miss extends RoutedRow {
  severity: Severity;
}

export interface RecallReport {
  /** Every message the router was asked about. */
  total: number;
  /** Routed `none` — the batch the analyzer never sees. */
  none: number;
  /** Of those, ones the incumbent also called benign. The saving. */
  noneOnBenign: number;
  /** Of those, ones the incumbent called something else. THE DANGER. */
  misses: Miss[];
  missesBySeverity: Record<Severity, Miss[]>;
  missesByIntent: Record<string, number>;
  /** Non-`none` on a benign message: a false positive. Costs one
   *  analyzer call and nothing else. */
  falsePositives: number;
  /** Denominator for the rates below: benign messages. */
  benign: number;
  nonBenign: number;
  /** Of the benign messages, what fraction did the router skip. */
  savingRate: number;
  /** Of the NON-benign messages, what fraction did the router skip.
   *  The number to minimise. */
  missRate: number;
  /** Wilson 95% on `missRate`, because 0 of 500 is not 0%. */
  missRateCi95: [number, number];
  /** How many routes came from the deterministic floor rather than the
   *  model, and how many of those the model had called `none`. */
  floorRoutes: number;
  floorRescues: number;
}

/**
 * Wilson score interval. Copied deliberately rather than imported from
 * `floor.ts`: that module pulls in `diff.ts` and the whole `CaseDiff`
 * surface, and this one must stay loadable from a plain script.
 */
export function wilson(k: number, n: number, z = 1.959963985): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
}

export function summariseRecall(rows: RoutedRow[]): RecallReport {
  const misses: Miss[] = [];
  const missesBySeverity: Record<Severity, Miss[]> = {
    squad_place: [],
    action: [],
    speech: [],
    benign: [],
  };
  const missesByIntent: Record<string, number> = {};
  let none = 0;
  let noneOnBenign = 0;
  let falsePositives = 0;
  let benign = 0;
  let floorRoutes = 0;
  let floorRescues = 0;

  for (const r of rows) {
    const isBenign = isBenignIntent(r.intent);
    if (isBenign) benign += 1;
    if (r.source === "floor") {
      floorRoutes += 1;
      // A floor route is a RESCUE only when the message would OTHERWISE
      // have been skipped — i.e. the model said `none`. Every other
      // override is a relabel the gate cannot see, because the gate
      // discards the route and keeps only `none` / not-`none`.
      if (r.overrodeRoute === "none") floorRescues += 1;
    }
    if (r.route === "none") {
      none += 1;
      if (isBenign) {
        noneOnBenign += 1;
      } else {
        const m: Miss = { ...r, severity: severityOf(r.intent) };
        misses.push(m);
        missesBySeverity[m.severity].push(m);
        const key = r.intent ?? "(null)";
        missesByIntent[key] = (missesByIntent[key] ?? 0) + 1;
      }
    } else if (isBenign) {
      falsePositives += 1;
    }
  }

  const nonBenign = rows.length - benign;
  misses.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      a.createdAt.localeCompare(b.createdAt),
  );

  return {
    total: rows.length,
    none,
    noneOnBenign,
    misses,
    missesBySeverity,
    missesByIntent,
    falsePositives,
    benign,
    nonBenign,
    savingRate: benign === 0 ? 0 : noneOnBenign / benign,
    missRate: nonBenign === 0 ? 0 : misses.length / nonBenign,
    missRateCi95: wilson(misses.length, nonBenign),
    floorRoutes,
    floorRescues,
  };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

/** The human report. Leads with the danger, not the saving. */
export function renderRecall(
  r: RecallReport,
  opts: { label: string; costUsd: number; ms: number; calls: number; batches: number },
): string {
  const L: string[] = [];
  L.push(`ROUTER RECALL — ${opts.label}`);
  L.push(`  ${r.total} production messages, ${opts.batches} recovered batches, ${opts.calls} router call(s)`);
  L.push("");
  L.push(`  THE DANGER — non-noise messages routed \`none\`:  ${r.misses.length} of ${r.nonBenign}  (${pct(r.missRate)})`);
  L.push(`    95% CI ${pct(r.missRateCi95[0])} – ${pct(r.missRateCi95[1])}`);
  for (const sev of SEVERITY_ORDER) {
    const n = r.missesBySeverity[sev].length;
    if (sev === "benign" || n === 0) continue;
    L.push(`    ${sev.padEnd(12)} ${n}`);
  }
  if (r.misses.length === 0) L.push(`    none. Every non-noise message reached the analyzer.`);
  L.push("");
  L.push(`  THE SAVING — benign messages routed \`none\`:      ${r.noneOnBenign} of ${r.benign}  (${pct(r.savingRate)})`);
  L.push(`  false positives (benign, still analysed):        ${r.falsePositives}`);
  L.push(`  floor routes: ${r.floorRoutes}   of which rescues: ${r.floorRescues}`);
  L.push("");
  L.push(`  measured: $${opts.costUsd.toFixed(4)} across ${opts.calls} call(s), ${(opts.ms / 1000).toFixed(1)}s of model time`);

  if (r.misses.length > 0) {
    L.push("");
    L.push(`  EVERY non-noise message routed \`none\`, worst first:`);
    for (const m of r.misses) {
      L.push(
        `    [${m.severity}] intent=${m.intent} handledBy=${m.handledBy} route=${m.route} (${m.source})`,
      );
      L.push(`        ${m.createdAt}  ${m.groupRef}`);
      L.push(`        ${JSON.stringify(m.body.slice(0, 160))}`);
    }
    L.push("");
    L.push(
      `  Production's \`intent\` is the incumbent's opinion, not truth. Read each one` +
        ` and say which is right before quoting this number as a defect count.`,
    );
  }
  return L.join("\n");
}

/**
 * What the floor WOULD have rescued, computed on a floor-OFF run.
 *
 * Two paid sweeps, one per flag, answer the with/without question badly:
 * the model is non-deterministic, so half the difference between them is
 * the model changing its mind and the other half is the floor. The floor
 * is a pure function of the body, so the honest comparison is to hold
 * the router's answers FIXED and apply it — which isolates the floor
 * exactly, costs nothing, and is reproducible from a stored run.
 *
 * `forces` is injected rather than imported so this module stays pure
 * and free of `src/`.
 */
export interface DerivedFloor {
  /** `none`-routed messages the floor would force back to the analyzer. */
  rescued: Miss[];
  /** Of those, the ones that were REAL misses — the seatbelt working. */
  rescuedMisses: Miss[];
  /** Benign messages the floor would drag back in. The cost: one
   *  analyzer call each, and nothing worse. */
  rescuedBenign: number;
  /** The miss rate that remains after the floor has done its work. */
  missesAfter: number;
  missRateAfter: number;
  missRateAfterCi95: [number, number];
}

export function deriveFloorEffect(
  rows: RoutedRow[],
  report: RecallReport,
  forces: (body: string) => boolean,
): DerivedFloor {
  const rescued: Miss[] = [];
  let rescuedBenign = 0;
  for (const r of rows) {
    if (r.route !== "none" || !forces(r.body)) continue;
    if (isBenignIntent(r.intent)) rescuedBenign += 1;
    else rescued.push({ ...r, severity: severityOf(r.intent) });
  }
  const rescuedIds = new Set(rescued.map((m) => m.waMessageId));
  const missesAfter = report.misses.filter((m) => !rescuedIds.has(m.waMessageId)).length;
  return {
    rescued,
    rescuedMisses: rescued,
    rescuedBenign,
    missesAfter,
    missRateAfter: report.nonBenign === 0 ? 0 : missesAfter / report.nonBenign,
    missRateAfterCi95: wilson(missesAfter, report.nonBenign),
  };
}

export function renderFloorEffect(d: DerivedFloor, r: RecallReport): string {
  const L: string[] = [];
  L.push(`  DERIVED — what the floor would do to THIS run (the router's answers held fixed):`);
  L.push(
    `    misses rescued:      ${d.rescuedMisses.length} of ${r.misses.length}` +
      `   → ${d.missesAfter} of ${r.nonBenign} remain (${pct(d.missRateAfter)}, ` +
      `95% CI ${pct(d.missRateAfterCi95[0])} – ${pct(d.missRateAfterCi95[1])})`,
  );
  L.push(`    benign dragged back: ${d.rescuedBenign}   (one analyzer call each, nothing worse)`);
  for (const m of d.rescuedMisses) {
    L.push(`      [${m.severity}] intent=${m.intent} ${JSON.stringify(m.body.slice(0, 80))}`);
  }
  if (d.rescuedMisses.length === 0) {
    L.push(`      the floor rescues NONE of the misses in this run.`);
  }
  return L.join("\n");
}

/** Everything the live driver needs from a raw production row. */
export function toRoutedRow(
  m: RawMessage,
  groupRef: string,
  routed: { route: string; source: string; overrodeRoute?: string },
): RoutedRow {
  return {
    waMessageId: m.waMessageId,
    groupRef,
    body: m.body ?? "",
    intent: m.intent,
    handledBy: m.handledBy,
    createdAt: m.createdAt,
    route: routed.route,
    source: routed.source,
    ...(routed.overrodeRoute ? { overrodeRoute: routed.overrodeRoute } : {}),
  };
}
