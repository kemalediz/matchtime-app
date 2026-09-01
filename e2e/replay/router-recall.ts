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
  /** `model` · `fallback` · `floor` — a floor route is the seatbelt
   *  firing, and is counted separately. */
  source: string;
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
      // A floor route is only a RESCUE if the message would otherwise
      // have been skipped. `routeBatch` reports `floor` as the source
      // exactly when the floor's answer differed from the model's, so
      // any floor route on a message the gate would have dropped counts.
      if (r.route !== "none") floorRescues += 1;
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

/** Everything the live driver needs from a raw production row. */
export function toRoutedRow(
  m: RawMessage,
  groupRef: string,
  routed: { route: string; source: string },
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
  };
}
