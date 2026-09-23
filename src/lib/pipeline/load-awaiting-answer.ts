/**
 * THE ONLY DATABASE READ BEHIND THE ROUTER GATE.
 *
 * Split out of `awaiting-answer.ts` on purpose. `router.ts` and
 * `gate.ts` are imported by `e2e/replay/router-recall-live.ts`, a plain
 * `tsx` script with no server and no database, and by the Playwright
 * worker. `gate.ts` used to carry the same note about its type-only
 * `message-analyzer` import; §10 step 8 deleted that import along with
 * `AnalysisVerdict`, and kept the note, because THE CONSTRAINT OUTLIVED
 * THE IMPORT: any future Prisma-touching import from `gate.ts` or
 * `router.ts` has to be type-only for exactly this reason. So the
 * predicates live in the pure module and the three queries live here,
 * and nothing in the router's import graph pulls in Prisma.
 *
 * READ-ONLY BY CONSTRUCTION: every statement in this file is a
 * `findMany`. The gate never writes.
 */
import { db } from "../db";
import {
  GROUP_QUESTION_TTL_MS,
  STATS_CLARIFICATION_INTENT,
  STATS_CLARIFIED_INTENT,
  openQuestionAt,
  openStatsClarifications,
  type AwaitingQuestion,
  type StatsClarification,
} from "./awaiting-answer";

/** How far back to look for rows worth considering at all. Any question
 *  older than this is outside the TTL anyway; the bound is here so the
 *  three queries stay indexed and small. */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * READ-ONLY. Every question this org has open right now.
 *
 * Three cheap indexed reads, bounded to a day. `PendingBenchConfirmation`
 * is legacy — the 2026-05-19 bench redesign replaced it with
 * `BenchSlotOffer` and nothing writes it any more — but it is what
 * case 1 actually was, it costs one indexed query, and leaving it out
 * would mean the mechanism could not reproduce half its own evidence.
 */
export async function loadAwaitingQuestions(
  orgId: string,
  now: Date = new Date(),
): Promise<AwaitingQuestion[]> {
  const since = new Date(now.getTime() - LOOKBACK_MS);

  const [offers, pending, tentative] = await Promise.all([
    db.benchSlotOffer.findMany({
      where: { resolvedAt: null, createdAt: { gte: since }, match: { activity: { orgId } } },
      select: { id: true, createdAt: true, match: { select: { date: true } } },
    }),
    db.pendingBenchConfirmation.findMany({
      where: { resolvedAt: null, createdAt: { gte: since }, match: { activity: { orgId } } },
      select: { id: true, createdAt: true, expiresAt: true },
    }),
    db.tentativeAvailability.findMany({
      where: {
        resolvedAt: null,
        notifiedAt: { not: null, gte: since },
        match: { activity: { orgId } },
      },
      select: { id: true, notifiedAt: true, match: { select: { date: true } } },
    }),
  ]);

  return [
    ...offers.map((o) => ({
      id: o.id,
      orgId,
      kind: "bench-slot-offer" as const,
      askedAt: o.createdAt,
      closesAt: o.match.date,
    })),
    ...pending.map((p) => ({
      id: p.id,
      orgId,
      kind: "bench-confirmation" as const,
      askedAt: p.createdAt,
      closesAt: p.expiresAt,
    })),
    ...tentative.map((t) => ({
      id: t.id,
      orgId,
      kind: "tentative-followup" as const,
      askedAt: t.notifiedAt!,
      closesAt: t.match.date,
    })),
  ];
}

/**
 * What `gateBatch` actually wants: the one open question, or null.
 *
 * Kept here rather than at the call site so wiring the gate up is a
 * single expression, and so the "which question" tie-break lives in one
 * place.
 */
export async function loadOpenQuestion(
  orgId: string,
  now: Date = new Date(),
): Promise<AwaitingQuestion | null> {
  return openQuestionAt(await loadAwaitingQuestions(orgId, now), orgId, now);
}

/**
 * READ-ONLY. The stats clarifications this org has open right now: the
 * "who do you mean?" questions MatchTime put to individual posters in
 * the last hour and has not had answered. One indexed read of
 * `AnalyzedMessage` (`[orgId, createdAt]`), rows the analyze route
 * writes for every owned message anyway. See the essay at the foot of
 * `awaiting-answer.ts`.
 */
export async function loadOpenStatsClarifications(
  orgId: string,
  now: Date = new Date(),
): Promise<StatsClarification[]> {
  const rows = await db.analyzedMessage.findMany({
    where: {
      orgId,
      intent: { in: [STATS_CLARIFICATION_INTENT, STATS_CLARIFIED_INTENT] },
      createdAt: { gte: new Date(now.getTime() - GROUP_QUESTION_TTL_MS) },
    },
    select: { id: true, orgId: true, intent: true, authorUserId: true, authorName: true, body: true, createdAt: true },
  });
  return openStatsClarifications(rows, orgId, now);
}
