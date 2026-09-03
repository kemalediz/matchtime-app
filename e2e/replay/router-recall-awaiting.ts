/**
 * THE OPEN-QUESTION CONTEXT, ON THE MEASUREMENT SIDE.
 *
 * PR #42 measured the router over all 1,695 production messages that
 * have a body and found exactly two it would have thrown away that were
 * a real attendance write — both a bare `👍` answering a slot MatchTime
 * had left open — and would not turn `ROUTER_GATE_ENABLED` on because of
 * them. `src/lib/pipeline/awaiting-answer.ts` is the fix; this module is
 * how the same 1,695 messages are re-measured against it.
 *
 * PURE. No model, no DB, no network. Unit-tested by
 * `router-recall.test.ts` under `npm run test:unit`, like the rest of
 * the recall maths.
 */
import {
  GROUP_QUESTION_TTL_MS,
  type AwaitingQuestion,
} from "../../src/lib/pipeline/awaiting-answer";
import {
  isBenignIntent,
  severityOf,
  wilson,
  type RecallReport,
  type RoutedRow,
} from "./router-recall";
import type { ReplaySource } from "./types";

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

/**
 * Every question MatchTime asked over the whole extract, in the router's
 * own `AwaitingQuestion` shape.
 *
 * The same shape `loadAwaitingQuestions` builds in production, and
 * deliberately so: the sweep has to measure the mechanism that ships,
 * not a harness-only approximation of it.
 */
export function awaitingQuestionsFrom(source: ReplaySource): AwaitingQuestion[] {
  const orgOf = new Map(source.matches.map((m) => [m.id, m.orgId]));
  const dateOf = new Map(source.matches.map((m) => [m.id, m.date]));
  const out: AwaitingQuestion[] = [];

  source.benchOffers.forEach((b, i) => {
    const orgId = orgOf.get(b.matchId);
    if (!orgId) return;
    out.push({
      id: `offer-${i}`,
      orgId,
      kind: "bench-slot-offer",
      askedAt: new Date(b.createdAt),
      closesAt: firstOf(b.resolvedAt, dateOf.get(b.matchId)),
    });
  });

  // Legacy since the 2026-05-19 bench redesign, and still the thing the
  // 2026-05-05 `👍` was answering. A sweep without it cannot reproduce
  // half of the evidence the gate is blocked on.
  (source.pendingBenchConfirmations ?? []).forEach((p, i) => {
    const orgId = orgOf.get(p.matchId);
    if (!orgId) return;
    out.push({
      id: `pending-${i}`,
      orgId,
      kind: "bench-confirmation",
      askedAt: new Date(p.createdAt),
      closesAt: firstOf(p.resolvedAt, p.expiresAt),
    });
  });

  (source.tentativeAvailabilities ?? []).forEach((t, i) => {
    const orgId = orgOf.get(t.matchId);
    if (!orgId || !t.notifiedAt) return;
    out.push({
      id: `tentative-${i}`,
      orgId,
      kind: "tentative-followup",
      askedAt: new Date(t.notifiedAt),
      closesAt: firstOf(t.resolvedAt, dateOf.get(t.matchId)),
    });
  });

  return out;
}

/** Whichever of "answered" and "the match started" came first. */
function firstOf(resolvedAt: string | null, hardStop: string | undefined): Date | null {
  const a = resolvedAt ? new Date(resolvedAt).getTime() : Infinity;
  const b = hardStop ? new Date(hardStop).getTime() : Infinity;
  const t = Math.min(a, b);
  return Number.isFinite(t) ? new Date(t) : null;
}

/**
 * The Pi buffers messages and flushes a WINDOW, so the instant a
 * production batch was routed is not a point this harness knows — it is
 * somewhere in the ten minutes before the `AnalyzedMessage` rows were
 * written. Case 1 is exactly why that matters: MatchTime's question
 * opened at 07:12:35 and closed at 07:42:36, and the batch's rows landed
 * at 07:45:08.
 *
 * So a replayed batch counts a question as open when the question's
 * window OVERLAPS the flush window, rather than when it covers one
 * chosen instant. That is knowingly the WIDE reading: it can only find
 * more open questions than production would, so the rescue reported here
 * is an upper bound and the saving reported here is a lower bound. Both
 * err against the change, which is the direction a measurement of a
 * safety mechanism should err in.
 */
export const PI_FLUSH_MS = 10 * 60 * 1000;

export function openQuestionForBatch(
  questions: AwaitingQuestion[],
  orgId: string,
  batchAt: Date,
  flushMs: number = PI_FLUSH_MS,
): AwaitingQuestion | null {
  const hi = batchAt.getTime();
  const lo = hi - flushMs;
  let best: AwaitingQuestion | null = null;
  for (const q of questions) {
    if (q.orgId !== orgId) continue;
    const from = q.askedAt.getTime();
    const to = Math.min(from + GROUP_QUESTION_TTL_MS, q.closesAt?.getTime() ?? Infinity);
    if (from > hi || to <= lo) continue;
    if (!best || from < best.askedAt.getTime()) best = q;
  }
  return best;
}

// ── What the context did to a run, before and after, from ONE sweep ───

export interface AwaitingEffect {
  /** `none` routes the context overrode. */
  forced: number;
  /** Of those, ones the incumbent did NOT call benign — the misses it
   *  rescued. This is the number the gate was blocked on. */
  rescuedMisses: RoutedRow[];
  /** Of those, benign ones. The cost: one analyzer call each. */
  forcedBenign: number;
  /** What this run WOULD have scored without the context. */
  missesBefore: number;
  missRateBefore: number;
  missRateBeforeCi95: [number, number];
  noneOnBenignBefore: number;
  savingRateBefore: number;
}

/**
 * Before and after from ONE paid sweep.
 *
 * The context only ever rewrites `none` and records what it replaced in
 * `overrodeRoute`, so the run WITHOUT it is recoverable exactly from the
 * run WITH it. No second paid sweep, and no half of the difference being
 * the model changing its mind — the same trick, for the same reason, as
 * `deriveFloorEffect`.
 */
export function summariseAwaiting(rows: RoutedRow[], report: RecallReport): AwaitingEffect {
  const forcedRows = rows.filter((r) => r.source === "awaiting" && r.overrodeRoute === "none");
  const rescuedMisses = forcedRows.filter((r) => !isBenignIntent(r.intent));
  const forcedBenign = forcedRows.length - rescuedMisses.length;
  const missesBefore = report.misses.length + rescuedMisses.length;
  const noneOnBenignBefore = report.noneOnBenign + forcedBenign;
  return {
    forced: forcedRows.length,
    rescuedMisses,
    forcedBenign,
    missesBefore,
    missRateBefore: report.nonBenign === 0 ? 0 : missesBefore / report.nonBenign,
    missRateBeforeCi95: wilson(missesBefore, report.nonBenign),
    noneOnBenignBefore,
    savingRateBefore: report.benign === 0 ? 0 : noneOnBenignBefore / report.benign,
  };
}

export function renderAwaitingEffect(a: AwaitingEffect, r: RecallReport): string {
  const L: string[] = [];
  L.push(`  THE OPEN-QUESTION CONTEXT — what it changed in THIS run, exactly:`);
  L.push(
    `    without it:  ${a.missesBefore} of ${r.nonBenign} non-noise routed \`none\` ` +
      `(${pct(a.missRateBefore)}, 95% CI ${pct(a.missRateBeforeCi95[0])} – ` +
      `${pct(a.missRateBeforeCi95[1])})   saving ${pct(a.savingRateBefore)}`,
  );
  L.push(
    `    with it:     ${r.misses.length} of ${r.nonBenign} (${pct(r.missRate)}, ` +
      `95% CI ${pct(r.missRateCi95[0])} – ${pct(r.missRateCi95[1])})   saving ${pct(r.savingRate)}`,
  );
  L.push(
    `    it overrode ${a.forced} \`none\` route(s): ${a.rescuedMisses.length} real miss(es) ` +
      `rescued, ${a.forcedBenign} benign dragged back (one analyzer call each, nothing worse).`,
  );
  for (const m of a.rescuedMisses) {
    L.push(
      `      RESCUED [${severityOf(m.intent)}] intent=${m.intent} handledBy=${m.handledBy} ` +
        `${m.createdAt} ${JSON.stringify(m.body.slice(0, 60))}`,
    );
  }
  if (a.rescuedMisses.length === 0) {
    L.push(`      it rescued NOTHING in this run — every miss was outside an open question.`);
  }
  return L.join("\n");
}
