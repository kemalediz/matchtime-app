/**
 * THE ONLY DATABASE READ BEHIND THE ROUTER GATE.
 *
 * Split out of `awaiting-answer.ts` on purpose. `router.ts` and
 * `gate.ts` are imported by `e2e/replay/router-recall-live.ts`, a plain
 * `tsx` script with no server and no database, and by the Playwright
 * worker — `gate.ts` already carries the note that its
 * `message-analyzer` import "has to stay type-only" for exactly this
 * reason. So the predicates live in the pure module and the three
 * queries live here, and nothing in the router's import graph pulls in
 * Prisma.
 *
 * READ-ONLY BY CONSTRUCTION: every statement in this file is a
 * `findMany`. The gate never writes.
 */
import { db } from "../db";
import { openQuestionAt, type AwaitingQuestion } from "./awaiting-answer";

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
